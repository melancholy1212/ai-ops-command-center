import type { HandlerRegistry } from './scheduler';

/**
 * Task handlers by type. The scheduler claims only the types listed here. Phase 3 registers the
 * planner, agent loops and structured calls; Phase 4 the report and outreach steps.
 */
export const handlers: HandlerRegistry = {};
