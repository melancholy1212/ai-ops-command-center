/**
 * The prospect-research workflow as data: how each task type runs, which agent handles it,
 * which tools each agent may call, and which model route it uses. The scheduler and the UI both
 * read these tables, so the workflow is understandable from source code and database rows alone.
 */
import type { AgentType, RouteClass } from './common';
import type { ClaimAttribute } from './claim';
import type { TaskExecutionKind, TaskType } from './task';
import type { ToolName } from './tools';

export type AgentMode = 'tool_loop' | 'structured_call';

/** Only open-ended research gets a tool loop. Everything else is one structured call inside a code step. */
export const AGENT_MODES = {
  planner: 'structured_call',
  research: 'tool_loop',
  company_intelligence: 'tool_loop',
  people_discovery: 'tool_loop',
  verifier: 'structured_call',
  analyst: 'structured_call',
  outreach_writer: 'structured_call',
} as const satisfies Record<AgentType, AgentMode>;

export const AGENT_ROUTES = {
  planner: 'planning',
  research: 'agent_loop',
  company_intelligence: 'agent_loop',
  people_discovery: 'agent_loop',
  verifier: 'judge',
  analyst: 'analysis',
  outreach_writer: 'writing',
} as const satisfies Record<AgentType, RouteClass>;

/** Enforced twice: the worker only offers these tools, and the MCP server checks the capability token. */
export const AGENT_TOOLS = {
  planner: [],
  research: ['web_search', 'fetch_page', 'search_knowledge', 'get_source'],
  company_intelligence: ['lookup_company', 'web_search', 'fetch_page', 'search_knowledge', 'get_source'],
  people_discovery: ['find_company_people', 'web_search', 'fetch_page', 'get_source'],
  verifier: [],
  analyst: [],
  outreach_writer: [],
} as const satisfies Record<AgentType, readonly ToolName[]>;

export interface TaskDefinition {
  readonly kind: TaskExecutionKind;
  readonly agent: AgentType | null;
  readonly maxAttempts: number;
  /** run_start: created when the run starts. expansion: created by code when another task succeeds. */
  readonly createdBy: 'run_start' | 'expansion';
  readonly parallelAcrossCompanies: boolean;
  readonly pausesForHuman: boolean;
  /** A permanent failure of this task fails the whole run. */
  readonly fatalOnFailure: boolean;
}

export const TASK_DEFINITIONS = {
  plan_run: {
    kind: 'structured_llm',
    agent: 'planner',
    maxAttempts: 3,
    createdBy: 'run_start',
    parallelAcrossCompanies: false,
    pausesForHuman: false,
    fatalOnFailure: true,
  },
  approve_plan: {
    kind: 'human_gate',
    agent: null,
    maxAttempts: 1,
    createdBy: 'run_start',
    parallelAcrossCompanies: false,
    pausesForHuman: true,
    fatalOnFailure: false,
  },
  discover_companies: {
    kind: 'agent_loop',
    agent: 'research',
    maxAttempts: 2,
    createdBy: 'run_start',
    parallelAcrossCompanies: false,
    pausesForHuman: false,
    fatalOnFailure: true,
  },
  profile_company: {
    kind: 'agent_loop',
    agent: 'company_intelligence',
    maxAttempts: 2,
    createdBy: 'expansion',
    parallelAcrossCompanies: true,
    pausesForHuman: false,
    fatalOnFailure: false,
  },
  find_people: {
    kind: 'agent_loop',
    agent: 'people_discovery',
    maxAttempts: 2,
    createdBy: 'expansion',
    parallelAcrossCompanies: true,
    pausesForHuman: false,
    fatalOnFailure: false,
  },
  verify_entity: {
    kind: 'structured_llm',
    agent: 'verifier',
    maxAttempts: 3,
    createdBy: 'expansion',
    parallelAcrossCompanies: true,
    pausesForHuman: false,
    fatalOnFailure: false,
  },
  gap_fill: {
    kind: 'agent_loop',
    agent: 'research',
    maxAttempts: 1,
    createdBy: 'expansion',
    parallelAcrossCompanies: true,
    pausesForHuman: false,
    fatalOnFailure: false,
  },
  rank_and_analyze: {
    kind: 'structured_llm',
    agent: 'analyst',
    maxAttempts: 2,
    createdBy: 'expansion',
    parallelAcrossCompanies: false,
    pausesForHuman: false,
    fatalOnFailure: true,
  },
  draft_outreach: {
    kind: 'structured_llm',
    agent: 'outreach_writer',
    maxAttempts: 2,
    createdBy: 'expansion',
    parallelAcrossCompanies: true,
    pausesForHuman: false,
    fatalOnFailure: false,
  },
  approve_outreach: {
    kind: 'human_gate',
    agent: null,
    maxAttempts: 1,
    createdBy: 'expansion',
    parallelAcrossCompanies: false,
    pausesForHuman: true,
    fatalOnFailure: false,
  },
  compile_report: {
    kind: 'code',
    agent: null,
    maxAttempts: 3,
    createdBy: 'expansion',
    parallelAcrossCompanies: false,
    pausesForHuman: false,
    fatalOnFailure: true,
  },
} as const satisfies Record<TaskType, TaskDefinition>;

export const WORKFLOW_LIMITS = {
  maxGapFillRounds: 1,
  maxPlanRevisions: 3,
  maxOutreachRedrafts: 1,
  /** Tasks of one run that may run at the same time (enforced by the claim query). */
  maxParallelTasksPerRun: 4,
} as const;

/** The run is complete when this task succeeds. */
export const FINAL_TASK_TYPE = 'compile_report' satisfies TaskType;

/** Planning tasks: while the plan task is active the run is planning; while the gate is active, awaiting approval. */
export const PLAN_TASK_TYPES = { plan: 'plan_run', gate: 'approve_plan' } as const satisfies Record<string, TaskType>;

/** Coverage policy: missing required attributes become research gaps and trigger gap_fill. */
export const REQUIRED_COMPANY_ATTRIBUTES = [
  'company.website',
  'company.hq_country',
  'company.funding_round',
  'company.sector',
] as const satisfies readonly ClaimAttribute[];

export const REQUIRED_PERSON_ATTRIBUTES = ['person.current_role'] as const satisfies readonly ClaimAttribute[];
