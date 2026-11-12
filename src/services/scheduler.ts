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
  /** Redraws the panels whose list changed only because time passed (a flight came within the panel's period, a completed one aged out). */
  panels?: { run(): void };
  /** Reads the FsHub rosters and flights of linked airlines when they are due. Runs beside the main pass (see `startLane`). */
  fshub?: { run(): Promise<unknown> };
  /** Completes the flights FsHub shows flown, once an hour. Runs after the FsHub reads, in the same lane. */
  autoComplete?: { run(): Promise<unknown> };
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
  private readonly fshub: SchedulerOptions['fshub'];
  private readonly autoComplete: SchedulerOptions['autoComplete'];
  private readonly panels: SchedulerOptions['panels'];
  private laneRunning = false;
  private lane: Promise<void> = Promise.resolve();

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
    this.fshub = opts.fshub;
    this.autoComplete = opts.autoComplete;
    this.panels = opts.panels;
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

  /**
   * The FsHub work (rosters, flights, the hourly completion): it talks to a service that can be slow, and a hung request
   * takes up to a dozen seconds to give up, a first read of an airline's flights tens of requests. It has a lane of its
   * own so that never holds up the reminders, the midnight tidy-up or the market boards in the main pass, and an
   * overlapping lane is skipped just as an overlapping pass is.
   */
  private startLane(): Promise<void> {
    if (this.laneRunning || (!this.fshub && !this.autoComplete)) return this.lane;
    this.laneRunning = true;
    this.lane = (async () => {
      try {
        await this.fshub?.run().catch((e) => this.log.error('FsHub roster and flight sync failed', e));
        await this.autoComplete?.run().catch((e) => this.log.error('FsHub auto-complete failed', e));
      } finally {
        this.laneRunning = false;
      }
    })();
    return this.lane;
  }

  /** Resolves once the FsHub lane has finished what it is doing (for tests, and for a tidy shutdown). */
  idle(): Promise<void> {
    return this.lane;
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
      // A flight may have come within the panel's period, or a completed one aged out, with nothing else changing.
      try {
        this.panels?.run();
      } catch (e) {
        this.log.error('Panel time check failed', e);
      }
      // Then ask for pilots for anything that starts within a day and still has nobody.
      await this.reminders?.run().catch((e) => this.log.error('Pilot reminders failed', e));
      // Clear yesterday's "pilots needed" messages away (after today's are posted, so a failure there can't block either).
      await this.cleanup?.run().catch((e) => this.log.error('Announcement cleanup failed', e));
      // And keep any AeroDAQ market boards fresh.
      await this.markets?.run().catch((e) => this.log.error('Market boards failed', e));
      // FsHub's work goes on beside this pass, not inside it.
      void this.startLane();
    } catch (e) {
      this.log.error('Scheduler tick failed', e);
    } finally {
      this.running = false;
    }
  }
}
