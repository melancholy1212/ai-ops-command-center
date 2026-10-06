/**
 * Route classes to model bindings (ADR-0007). The router takes the first binding whose provider is
 * configured, whose model is priced, and whose circuit breaker is closed. It falls back to the next binding
 * only on availability failures (rate limits, provider errors after in-call retries), never on a bad answer.
 *
 * Once a conversation contains an assistant turn, later calls stay on that provider kind: another provider
 * could not replay the turn exactly (thinking blocks and signatures are provider-specific).
 */
import type { LlmProviderKind, RouteClass } from '@aoc/contracts';
import { isPriced, ROUTES, ROUTING_CONFIG_VERSION } from './models';
import { MAX_RETRY_AFTER_MS } from './retry';

/** A provider's retry-after opens a breaker for at most a day. */
const MAX_BREAKER_MS = 24 * 60 * 60 * 1000;
import { LlmCallError, type LlmProvider, type LlmRequest, type LlmResponse, type ModelBinding } from './types';

export interface RoutedResponse {
  response: LlmResponse;
  binding: ModelBinding;
  routingConfigVersion: string;
}

export interface RouterOptions {
  providers: readonly LlmProvider[];
  routes?: Record<RouteClass, readonly ModelBinding[]>;
  routingConfigVersion?: string;
  /** Consecutive availability failures that open a binding's breaker, and how long it stays open. */
  breaker?: { failureThreshold: number; cooldownMs: number };
  now?: () => number;
}

interface BreakerState {
  failures: number;
  openUntil: number;
}

export class LlmRouter {
  private readonly providers: Map<string, LlmProvider>;
  private readonly routes: Record<RouteClass, readonly ModelBinding[]>;
  private readonly breakers = new Map<string, BreakerState>();
  readonly routingConfigVersion: string;
  private readonly threshold: number;
  private readonly cooldownMs: number;
  private readonly now: () => number;

  constructor(options: RouterOptions) {
    this.providers = new Map(options.providers.map((p) => [p.account, p]));
    this.routes = options.routes ?? ROUTES;
    this.routingConfigVersion = options.routingConfigVersion ?? ROUTING_CONFIG_VERSION;
    this.threshold = options.breaker?.failureThreshold ?? 3;
    this.cooldownMs = options.breaker?.cooldownMs ?? 30_000;
    this.now = options.now ?? Date.now;
  }

  /** Bindings that could serve the route right now, in order. Unpriced models are never routable. */
  candidates(route: RouteClass, pinnedKind: LlmProviderKind | null = null): ModelBinding[] {
    return this.routes[route].filter((b) => {
      const provider = this.providers.get(b.providerAccount);
      return (
        provider?.kind === b.providerKind && isPriced(b.model) && (pinnedKind === null || b.providerKind === pinnedKind)
      );
    });
  }

  async generate(
    route: RouteClass,
    request: Omit<LlmRequest, 'binding'>,
    signal: AbortSignal,
  ): Promise<RoutedResponse> {
    const pinned = [...request.messages].reverse().find((m) => m.role === 'assistant');
    const candidates = this.candidates(route, pinned?.role === 'assistant' ? pinned.providerKind : null);
    if (candidates.length === 0) {
      throw new LlmCallError('invalid_request', `No configured and priced model binding for route ${route}`);
    }
    const now = this.now();
    const closed = candidates.filter((b) => (this.breakers.get(key(b))?.openUntil ?? 0) <= now);
    // All breakers open: try the first candidate anyway rather than failing without a call.
    const order = closed.length > 0 ? closed : candidates.slice(0, 1);

    let lastError: LlmCallError | undefined;
    for (const binding of order) {
      const provider = this.providers.get(binding.providerAccount);
      if (!provider) continue;
      try {
        const response = await provider.generate({ ...request, binding }, signal);
        this.breakers.delete(key(binding));
        return { response, binding, routingConfigVersion: this.routingConfigVersion };
      } catch (error) {
        if (!(error instanceof LlmCallError) || !error.availability) throw error;
        this.recordFailure(binding, error);
        lastError = error;
      }
    }
    throw lastError ?? new LlmCallError('unavailable', `No binding could serve route ${route}`);
  }

  private recordFailure(binding: ModelBinding, error: LlmCallError) {
    const state = this.breakers.get(key(binding)) ?? { failures: 0, openUntil: 0 };
    // The provider said when to come back, and it is not soon (a daily quota): skip the binding until then.
    if (error.retryAfterMs !== null && error.retryAfterMs > MAX_RETRY_AFTER_MS) {
      state.openUntil = this.now() + Math.min(error.retryAfterMs, MAX_BREAKER_MS);
      state.failures = 0;
      this.breakers.set(key(binding), state);
      return;
    }
    state.failures += 1;
    if (state.failures >= this.threshold) {
      state.openUntil = this.now() + this.cooldownMs;
      state.failures = 0;
    }
    this.breakers.set(key(binding), state);
  }
}

const key = (b: ModelBinding) => `${b.providerAccount}:${b.model}`;
