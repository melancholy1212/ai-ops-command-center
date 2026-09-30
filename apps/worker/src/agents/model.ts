/**
 * One model call inside an agent execution, shared by the tool loop and structured calls: budget check first,
 * then the router, then the call is recorded (tokens, cost, latency, retries, request hash), including a call
 * that failed. Provider failures become typed task failures: outages are retryable, refusals of the request
 * are bugs.
 */
import { randomUUID } from 'node:crypto';
import type { LlmCallId, RouteClass } from '@aoc/contracts';
import { BudgetExhaustedError, makeFailure, TaskFailure, type BudgetDimension } from '@aoc/core';
import {
  LlmCallError,
  requestHash,
  type ConversationMessage,
  type LlmRequest,
  type LlmResponse,
  type LlmRouter,
  type ModelBinding,
  type ToolChoice,
  type ToolSpec,
} from '@aoc/llm';
import type { LoopRecorder } from './loop';

export interface ModelCaller {
  route: RouteClass;
  promptVersion: string;
  system: string;
  maxOutputTokens: number;
  router: LlmRouter;
  recorder: LoopRecorder;
  checkBudget: () => Promise<readonly BudgetDimension[]>;
  signal: AbortSignal;
}

export interface ModelCallResult {
  response: LlmResponse;
  binding: ModelBinding;
  callId: LlmCallId;
}

export function toTaskFailure(error: LlmCallError): TaskFailure {
  if (error.kind === 'rate_limited') return new TaskFailure('PROVIDER_RATE_LIMITED', error.message);
  if (error.kind === 'unavailable') return new TaskFailure('PROVIDER_UNAVAILABLE', error.message);
  if (error.kind === 'auth' || error.kind === 'billing')
    return new TaskFailure(
      'PROVIDER_ACCOUNT',
      `The model provider refused the account (${error.kind === 'auth' ? 'key or access' : 'credit or quota used up'}): ${error.message}`,
      { kind: error.kind },
    );
  return new TaskFailure('INTERNAL_ERROR', `Model call refused: ${error.message}`, { kind: error.kind });
}

export async function callModel(
  caller: ModelCaller,
  messages: readonly ConversationMessage[],
  tools: readonly ToolSpec[],
  toolChoice: ToolChoice,
  responseFormat?: LlmRequest['responseFormat'],
): Promise<ModelCallResult> {
  const { router, recorder, signal, route } = caller;
  if (signal.aborted) throw signal.reason;
  const exhausted = await caller.checkBudget();
  if (exhausted.length > 0) throw new BudgetExhaustedError(exhausted);
  const callId = randomUUID() as LlmCallId;
  const request: Omit<LlmRequest, 'binding'> = {
    system: caller.system,
    messages: [...messages],
    tools: [...tools],
    toolChoice,
    ...(responseFormat ? { responseFormat } : {}),
    maxOutputTokens: caller.maxOutputTokens,
    telemetry: {
      runId: recorder.claim.runId,
      taskId: recorder.claim.taskId,
      executionId: recorder.executionId as LlmRequest['telemetry']['executionId'],
      callId,
      route,
      promptVersion: caller.promptVersion,
    },
  };
  const startedAt = new Date();
  const clock = performance.now();
  try {
    const { response, binding, routingConfigVersion } = await router.generate(route, request, signal);
    await recorder.llmCall(
      {
        callId,
        binding,
        route,
        routingConfigVersion,
        promptVersion: caller.promptVersion,
        requestHash: requestHash({ ...request, binding }),
        startedAt,
        response,
        failure: null,
        latencyMs: response.latencyMs,
        retryCount: response.retryCount,
      },
      true,
    );
    return { response, binding, callId };
  } catch (error) {
    if (!(error instanceof LlmCallError) || error.kind === 'aborted') throw error;
    const binding = router.candidates(route)[0];
    const failure = toTaskFailure(error);
    if (binding) {
      await recorder.llmCall(
        {
          callId,
          binding,
          route,
          routingConfigVersion: router.routingConfigVersion,
          promptVersion: caller.promptVersion,
          requestHash: requestHash({ ...request, binding }),
          startedAt,
          response: null,
          failure: makeFailure(failure.code, failure.message, false),
          latencyMs: Math.round(performance.now() - clock),
          retryCount: error.retryCount,
        },
        false,
      );
    }
    throw failure;
  }
}
