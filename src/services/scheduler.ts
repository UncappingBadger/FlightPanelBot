import { silentLogger, type Logger } from '../util/log.js';
import type { JobService } from './jobs.js';
import type { SourceRefresher } from './refresh.js';
import type { ReminderService } from './reminders.js';

export interface SchedulerOptions {
  /** How often the loop wakes up (ms). */
  tickMs?: number;
  logger?: Logger;
  /** Announces flights that still have no pilot a day before they start. */
  reminders?: Pick<ReminderService, 'run'>;
  /** Redraws the servers' AeroDAQ market boards when they are due. */
  markets?: { run(): Promise<void> };
  /** Deletes the "pilots needed" announcements from before today (the midnight tidy-up). */
  cleanup?: { run(): Promise<unknown> };
}

/**
 * One timer for all background work: closing jobs whose deadline has passed, the 24-hourly source
 * refresh, asking for pilots for unstaffed flights, the AeroDAQ market boards, and housekeeping.
 */
export class Scheduler {
  private timer: NodeJS.Timeout | null = null;
  private running = false;
  private readonly tickMs: number;
  private readonly log: Logger;
  private readonly reminders: SchedulerOptions['reminders'];
  private readonly markets: SchedulerOptions['markets'];
  private readonly cleanup: SchedulerOptions['cleanup'];

  constructor(
    private readonly jobs: JobService,
    private readonly refresher: SourceRefresher,
    opts: SchedulerOptions = {},
  ) {
    this.tickMs = opts.tickMs ?? 60_000;
    this.log = opts.logger ?? silentLogger;
    this.reminders = opts.reminders;
    this.markets = opts.markets;
    this.cleanup = opts.cleanup;
  }

  start(): void {
    if (this.timer) return;
    this.timer = setInterval(() => void this.tick(), this.tickMs);
    void this.tick();
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  /** One pass of background work. Overlapping passes are skipped rather than queued. */
  async tick(): Promise<void> {
    if (this.running) return;
    this.running = true;
    try {
      // Pull fresh jobs first, then close anything past its deadline.
      await this.refresher.refreshDue().catch((e) => this.log.error('Source refresh failed', e));
      this.jobs.expireDue();
      this.jobs.cleanup();
      // Then ask for pilots for anything that starts within a day and still has nobody.
      await this.reminders?.run().catch((e) => this.log.error('Pilot reminders failed', e));
      // Clear yesterday's "pilots needed" messages away (after today's are posted, so a failure there can't block either).
      await this.cleanup?.run().catch((e) => this.log.error('Announcement cleanup failed', e));
      // And keep any AeroDAQ market boards fresh.
      await this.markets?.run().catch((e) => this.log.error('Market boards failed', e));
    } catch (e) {
      this.log.error('Scheduler tick failed', e);
    } finally {
      this.running = false;
    }
  }
}
