import { statSync } from 'node:fs';
import { monitorEventLoopDelay } from 'node:perf_hooks';
import { realMs } from '../util/clock.js';
import type { Logger } from '../util/log.js';

/** What was seen of one step of the bot's work since the last report. */
interface Stat {
  count: number;
  totalMs: number;
  maxMs: number;
}

/** How often the event loop is looked at, in milliseconds. */
const LOOP_RESOLUTION_MS = 10;

const dayOf = (ms: number): string => new Date(ms).toISOString().slice(0, 10);
const mb = (bytes: number): string => (bytes / 1024 / 1024).toFixed(1);
const fixed = (n: number): string => (n >= 100 ? n.toFixed(0) : n.toFixed(1));

/**
 * The test build's eyes: how long each scheduled step takes, how late the bot's only thread is for everything else (the "event loop"
 * delay: what a person feels as the bot being slow to answer), how much memory and disk it uses, and a line whenever a day of the
 * faster clock begins or a step reports having done something. Written to the log, in lines that start `[perf]`, `[fired]` and `[clock]`.
 */
export class PerfMonitor {
  private steps = new Map<string, Stat>();
  private readonly loop: ReturnType<typeof monitorEventLoopDelay> = monitorEventLoopDelay({ resolution: LOOP_RESOLUTION_MS });
  private timer: NodeJS.Timeout | null = null;
  private lastDay: string;
  private readonly startedAt = realMs();
  private reports = 0;
  /** The slowest a single step has been since the monitor started, and which. */
  private worst: { name: string; ms: number } = { name: '', ms: 0 };

  constructor(
    private readonly log: Logger,
    /** The bot's own (fast) clock. */
    private readonly now: () => number,
    private readonly opts: { everyMs?: number; /** More to say on each report (sizes, counts). */ extra?: () => string } = {},
  ) {
    this.lastDay = dayOf(now());
  }

  /** Record that a step took `ms`. */
  note(name: string, ms: number): void {
    const s = this.steps.get(name) ?? { count: 0, totalMs: 0, maxMs: 0 };
    s.count++;
    s.totalMs += ms;
    s.maxMs = Math.max(s.maxMs, ms);
    this.steps.set(name, s);
    if (ms > this.worst.ms) this.worst = { name, ms };
  }

  /**
   * The same service, timed: what the scheduler calls (`run`) is passed through and its time noted. A step that returns a number above
   * zero (it sent a list, tidied some messages, read some flights) is also said to have fired.
   */
  wrap<T extends { run(): unknown }>(name: string, service: T): T {
    const timed = {
      run: async () => {
        const t0 = realMs();
        try {
          const out = await service.run();
          if (typeof out === 'number' && out > 0) this.log.info(`[fired] ${name}: ${out} (clock ${new Date(this.now()).toISOString().slice(0, 16)}Z)`);
          return out;
        } finally {
          this.note(name, realMs() - t0);
        }
      },
    };
    return timed as unknown as T;
  }

  /** Time any async function under a name (the scheduler's whole pass, for one). */
  async time<R>(name: string, work: () => Promise<R>): Promise<R> {
    const t0 = realMs();
    try {
      return await work();
    } finally {
      this.note(name, realMs() - t0);
    }
  }

  start(): void {
    if (this.timer) return;
    this.loop.enable();
    const every = this.opts.everyMs ?? 60_000;
    let sinceReport = 0;
    this.timer = setInterval(() => {
      // A new day of the faster clock: the thing that happens at midnight is about to be seen.
      const day = dayOf(this.now());
      if (day !== this.lastDay) {
        this.lastDay = day;
        this.log.info(`[clock] a new day begins: ${day} (${((realMs() - this.startedAt) / 60_000).toFixed(1)} minutes since the bot started)`);
      }
      sinceReport += 1000;
      if (sinceReport >= every) {
        sinceReport = 0;
        for (const line of this.report()) this.log.info(line);
      }
    }, 1000);
    this.timer.unref?.();
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
    this.loop.disable();
  }

  /** The lines of a report (and the counts start again from nothing). */
  report(): string[] {
    this.reports++;
    const mem = process.memoryUsage();
    // The histogram's smallest figure is its own sampling interval (10 ms): what is left is how late the thread really was.
    const delay = (ns: number) => Math.max(0, ns / 1e6 - LOOP_RESOLUTION_MS);
    const lines: string[] = [];
    lines.push(
      `[perf] #${this.reports} clock ${new Date(this.now()).toISOString().slice(0, 16)}Z, ${((realMs() - this.startedAt) / 60_000).toFixed(1)} min running | thread delay p50 ${fixed(delay(this.loop.percentile(50)))} ms, p99 ${fixed(delay(this.loop.percentile(99)))} ms, worst ${fixed(delay(this.loop.max))} ms | heap ${mb(mem.heapUsed)} MB, memory ${mb(mem.rss)} MB${this.opts.extra ? ` | ${this.opts.extra()}` : ''}`,
    );
    const rows = [...this.steps.entries()].sort((a, b) => b[1].totalMs - a[1].totalMs);
    if (rows.length > 0) {
      lines.push(`[perf] steps since the last report: ${rows.map(([name, s]) => `${name} x${s.count} (avg ${fixed(s.totalMs / s.count)}, max ${fixed(s.maxMs)} ms)`).join('; ')}`);
    }
    if (this.worst.ms >= 100) lines.push(`[perf] slowest single step so far: ${this.worst.name} took ${fixed(this.worst.ms)} ms`);
    this.steps = new Map();
    this.loop.reset();
    return lines;
  }
}

/** The size of a file in MB as text, or `-` if it is not there. */
export function fileMb(path: string): string {
  try {
    return mb(statSync(path).size);
  } catch {
    return '-';
  }
}
