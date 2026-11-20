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
  /**
   * Redraws the servers' weather boards when they are due (every ten minutes). It asks VATSIM for a report for each airport, which can be slow,
   * so it goes on beside the main pass, not inside it, and an overlapping run is skipped.
   */
  weather?: { run(): Promise<void> };
  /** Looks at the bank accounts pilots chose to be told about (`/banking`), when due (every five minutes). Beside the main pass, like the weather boards. */
  banking?: { run(): Promise<void> };
  /** Looks at the flights people asked to be told about (`/monitor`) in FsHub's live feed. Runs in the same lane, after the expected landing times. */
  monitors?: { run(): Promise<unknown> };
  /** Deletes the "pilots needed" announcements from before today (the midnight tidy-up). */
  cleanup?: { run(): Promise<unknown> };
  /** Redraws the panels whose list changed only because time passed (a flight came within the panel's period, a completed one aged out). */
  panels?: { run(): void };
  /** Reads the FsHub rosters and flights of linked airlines when they are due. Runs beside the main pass (see `startLane`). */
  fshub?: { run(): Promise<unknown> };
  /** Completes the flights FsHub shows flown, once an hour. Runs after the FsHub reads, in the same lane. */
  autoComplete?: { run(): Promise<unknown> };
  /** Follows pilots' flights live and completes a flight soon after it lands. Runs in the same lane, after the FsHub reads and before the warnings. */
  live?: { run(): Promise<unknown> };
  /** Reads when the airline's flights in the air are expected to land, for the panel and `/eta`. Runs in the same lane, after live tracking. */
  etas?: { run(): Promise<unknown> };
  /** Starts reading Aeroconomy's flight numbers when they are due. The read goes on in the background, so this returns at once. */
  numbers?: { run(): Promise<unknown> };
  /** Sends the once-a-day note, when one is set up. Runs in the same lane, last. */
  daily?: { run(): Promise<unknown> };
  /** Makes the day's list of pilot payments for an admin to check, at the time they chose. Nothing is paid by it. Runs in the same lane, last. */
  payroll?: { run(): Promise<unknown> };
  /** Warns pilots (and their backups) shortly before the latest take-off that still makes a flight's window. Runs in the same lane, after the FsHub reads. */
  departures?: { run(): Promise<unknown> };
  /** Puts backup pilots that are not in the airline's sheet yet there (once an hour). Runs in the same lane, after the reads and completions. */
  backups?: { run(): Promise<unknown> };
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
  private readonly weather: SchedulerOptions['weather'];
  private weatherRun: Promise<unknown> = Promise.resolve();
  private readonly banking: SchedulerOptions['banking'];
  private bankingRun: Promise<unknown> = Promise.resolve();
  private readonly monitors: SchedulerOptions['monitors'];
  private readonly cleanup: SchedulerOptions['cleanup'];
  private readonly fshub: SchedulerOptions['fshub'];
  private readonly autoComplete: SchedulerOptions['autoComplete'];
  private readonly departures: SchedulerOptions['departures'];
  private readonly live: SchedulerOptions['live'];
  private readonly etas: SchedulerOptions['etas'];
  private readonly numbers: SchedulerOptions['numbers'];
  private readonly daily: SchedulerOptions['daily'];
  private readonly payroll: SchedulerOptions['payroll'];
  private readonly backups: SchedulerOptions['backups'];
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
    this.weather = opts.weather;
    this.banking = opts.banking;
    this.monitors = opts.monitors;
    this.cleanup = opts.cleanup;
    this.fshub = opts.fshub;
    this.autoComplete = opts.autoComplete;
    this.departures = opts.departures;
    this.live = opts.live;
    this.etas = opts.etas;
    this.numbers = opts.numbers;
    this.daily = opts.daily;
    this.payroll = opts.payroll;
    this.backups = opts.backups;
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
   * The FsHub work (rosters, flights, the hourly completion) and the departure warnings: they talk to a service that can be slow, and a hung request
   * takes up to a dozen seconds to give up, a first read of an airline's flights tens of requests. It has a lane of its
   * own so that never holds up the reminders, the midnight tidy-up or the market boards in the main pass, and an
   * overlapping lane is skipped just as an overlapping pass is.
   */
  private startLane(): Promise<void> {
    if (this.laneRunning || (!this.fshub && !this.autoComplete && !this.live && !this.etas && !this.monitors && !this.numbers && !this.departures && !this.daily && !this.payroll && !this.backups)) return this.lane;
    this.laneRunning = true;
    this.lane = (async () => {
      try {
        await this.fshub?.run().catch((e) => this.log.error('FsHub roster and flight sync failed', e));
        await this.autoComplete?.run().catch((e) => this.log.error('FsHub auto-complete failed', e));
        // Who is flying, and a look for the flights of pilots who have just landed (after the reads, so they are current).
        await this.live?.run().catch((e) => this.log.error('Live tracking failed', e));
        // When the flights in the air are expected to land (one request for each airline).
        await this.etas?.run().catch((e) => this.log.error('Reading expected landing times failed', e));
        // Flights people asked to be told about, from the same live feed (one request for each airline).
        await this.monitors?.run().catch((e) => this.log.error('Watching flights failed', e));
        // Aeroconomy's flight numbers, when due. This only starts the (slow) read in the background.
        await this.numbers?.run().catch((e) => this.log.error('Reading Aeroconomy flight numbers failed', e));
        // After the FsHub reads, so a leg FsHub has just shown flown is not warned about; and here, not in the main pass, because the
        // first look at an airport can mean a large download.
        await this.departures?.run().catch((e) => this.log.error('Departure warnings failed', e));
        // Backup pilots put down before they were written in the sheet, or while it could not be reached.
        await this.backups?.run().catch((e) => this.log.error('Checking the backup pilots against the sheet failed', e));
        await this.daily?.run().catch((e) => this.log.error('The daily note failed', e));
        await this.payroll?.run().catch((e) => this.log.error('The daily pay list failed', e));
      } finally {
        this.laneRunning = false;
      }
    })();
    return this.lane;
  }

  /** Resolves once the FsHub lane, and the weather boards' redraw, have finished what they are doing (for tests, and for a tidy shutdown). */
  async idle(): Promise<void> {
    await Promise.all([this.lane, this.weatherRun, this.bankingRun]);
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
      // Clear the "pilots needed" list of a day that is nearly over away (23:59 UTC), first, so it is gone before the next one is posted...
      await this.cleanup?.run().catch((e) => this.log.error('Announcement cleanup failed', e));
      // ...then, at midnight UTC, list the day's flights that still have nobody (a failure in one cannot block the other).
      await this.reminders?.run().catch((e) => this.log.error('Pilot reminders failed', e));
      // And keep any AeroDAQ market boards fresh.
      await this.markets?.run().catch((e) => this.log.error('Market boards failed', e));
      // The weather boards, beside this pass for the same reason as FsHub's work: they ask VATSIM once for each airport.
      if (this.weather) this.weatherRun = this.weather.run().catch((e) => this.log.error('Weather boards failed', e));
      // Pilots' bank accounts, the same way: each is a request to Aeroconomy, which is asked slowly.
      if (this.banking) this.bankingRun = this.banking.run().catch((e) => this.log.error('Payment messages failed', e));
      // FsHub's work goes on beside this pass, not inside it.
      void this.startLane();
    } catch (e) {
      this.log.error('Scheduler tick failed', e);
    } finally {
      this.running = false;
    }
  }
}
