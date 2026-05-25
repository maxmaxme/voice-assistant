import { pino } from 'pino';

const log = pino({ name: 'realtime-metrics' });

export class LatencyTracker {
  private marks: Map<string, number> = new Map();
  private order: string[] = [];
  private now: () => number;

  constructor(now: () => number = () => Date.now()) {
    this.now = now;
  }

  mark(name: string): void {
    if (this.marks.has(name)) {
      return;
    }
    this.marks.set(name, this.now());
    this.order.push(name);
  }

  report(): Record<string, number> {
    const out: Record<string, number> = {};
    for (let i = 1; i < this.order.length; i++) {
      const a = this.order[i - 1];
      const b = this.order[i];
      out[`${a}→${b}`] = this.marks.get(b)! - this.marks.get(a)!;
    }
    if (this.order.length >= 2) {
      const first = this.order[0];
      const last = this.order[this.order.length - 1];
      out[`${first}→${last}`] = this.marks.get(last)! - this.marks.get(first)!;
    }
    return out;
  }

  log(sessionId: string): void {
    log.info({ sessionId, latencies: this.report() }, 'session latency');
  }
}
