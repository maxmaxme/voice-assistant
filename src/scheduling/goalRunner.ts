import type { Agent } from '../agent/types.ts';
import { createLogger } from '../utils/logger.ts';

const log = createLogger('goalRunner');

export interface GoalRunner {
  /** Fire a previously-scheduled goal once. Should not throw under
   * normal-failure conditions; the scheduler treats a thrown error as
   * "advance and retry next tick" for cron, "mark error" for once. */
  fire(goal: string): Promise<void>;
}

export interface GoalRunnerOptions {
  /** The Agent to use for goal execution. Should be configured in goal mode
   * (no `ask` tool, fresh Session per fire). The runner does NOT manage the
   * agent's lifecycle — caller wires it. */
  agent: Agent;
}

function truncate(s: string, max = 80): string {
  const oneLine = s.replace(/\n/g, '\\n');
  if (oneLine.length <= max) {
    return oneLine;
  }
  return oneLine.slice(0, max - 1) + '…';
}

export function buildGoalRunner(opts: GoalRunnerOptions): GoalRunner {
  const { agent } = opts;
  return {
    async fire(goal: string): Promise<void> {
      try {
        const res = await agent.respond(goal);
        log.info(
          { goal, reply: res.text ?? '' },
          `goal "${truncate(goal)}" → ${truncate(res.text ?? '')}`,
        );
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        log.error({ goal, err }, `goal "${truncate(goal)}" failed: ${msg}`);
        throw err;
      }
    },
  };
}
