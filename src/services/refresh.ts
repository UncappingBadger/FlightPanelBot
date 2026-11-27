import type { Panel, Store } from '../db/store.js';
import { normalizeFetched, type FetchedJobs, type JobSource, type SourceJob } from '../jobs/types.js';
import { DEBUG_BUILD, callerPath, dbg } from '../util/debugBuild.js';
import { silentLogger, type Logger } from '../util/log.js';
import { HourlySlot } from './hourlySlot.js';
import { JobError, type JobService, type SyncResult } from './jobs.js';
import { TEST_BUILD, appNow } from '../util/clock.js';

/** How often an automatic source (the demo) is re-read. */
export const REFRESH_INTERVAL_MS = 24 * 60 * 60 * 1000;
/** A linked Google Sheet changes all day (sign-ups, ticked boxes), so it is re-read more often. */
export const SHEET_REFRESH_INTERVAL_MS = 60 * 60 * 1000;
const RETRY_AFTER_FAILURE_MS = 60 * 60 * 1000;
/** A read with no flights (and nothing unreadable) is believed only when fewer flights than this are still to come on the panel. */
const EMPTY_READ_BELIEVED_BELOW = 3;
/** How many airlines' schedules are read at the same time when several are due together. */
const REFRESH_CONCURRENCY = 3;
/**
 * The diagnostic build only: a linked Google Sheet is read this often instead of once in each hourly slot, so a test (the Distance fill, for
 * one) can be watched without waiting an hour. Every other build, and every test, reads it by the slot as before. The scheduler ticks once a
 * minute, so a read comes within a minute after this.
 */
export const DEBUG_SHEET_INTERVAL_MS = 2 * 60_000;

export function refreshIntervalFor(panel: Pick<Panel, 'sheetId'>): number {
  return panel.sheetId ? SHEET_REFRESH_INTERVAL_MS : REFRESH_INTERVAL_MS;
}

/** What a refresh did, plus anything the source wants an admin to know (rows it could not read). */
export type RefreshOutcome = SyncResult & { warnings: string[] };

/**
 * Pulls a panel's jobs from its source: every hour for a linked Google Sheet, every 24 hours for any
 * other automatic source. A panel with no automatic source (jobs come from admin file imports) is
 * simply skipped.
 */
export class SourceRefresher {
  private readonly lastAttempt = new Map<number, number>();

  constructor(
    private readonly store: Store,
    private readonly jobs: JobService,
    private readonly sourceFor: (panel: Panel) => JobSource | null,
    private readonly log: Logger = silentLogger,
    private readonly now: () => number = appNow,
    /** Adds what the source does not say to the flights it listed (the airline's flight numbers, from Aeroconomy). */
    private readonly enrich: ((panel: Panel, jobs: SourceJob[], fetched: FetchedJobs) => SourceJob[]) | null = null,
    /** The moment each hour at which the hourly checks happen together: a linked sheet is read once in each slot. */
    private readonly slot: HourlySlot = new HourlySlot(0),
    /**
     * Told what a read of the schedule found, once it has been applied, to do something with it in the background (the distances the
     * sheet is missing). It is never waited for, and nothing it does wrong can fail the refresh.
     */
    private readonly afterRead: ((panel: Panel, fetched: FetchedJobs) => Promise<unknown> | void) | null = null,
  ) {}

  hasSource(panel: Panel): boolean {
    return this.sourceFor(panel) !== null;
  }

  /** Fetch and apply now. Throws if the panel has no source or the source fails (old jobs are left as they were). */
  async refresh(panel: Panel): Promise<RefreshOutcome> {
    const source = this.sourceFor(panel);
    if (!source) throw new JobError('BAD_INPUT', "This panel's flights come from file imports, so there's nothing to fetch. Load flights with the **Import flights** tab of the bot's settings page.");
    const now = this.now();
    this.lastAttempt.set(panel.id, now);
    if (DEBUG_BUILD) dbg(this.log, `refresh START ${panel.airlineName} (panel ${panel.id}), source ${source.kind}, last refresh ${panel.lastRefreshAt === null ? 'never' : new Date(panel.lastRefreshAt).toISOString()}, asked by ${callerPath(1, 5)}`);
    try {
      const fetched = normalizeFetched(await source.fetch({ name: panel.airlineName, abbr: panel.airlineAbbr }, now));
      if (fetched.jobs.length === 0) this.refuseEmptyRead(panel, fetched, now);
      const jobs = this.enrich ? this.enrich(panel, fetched.jobs, fetched) : fetched.jobs;
      if (DEBUG_BUILD) dbg(this.log, `refresh: the source returned ${jobs.length} flight(s) and ${fetched.warnings.length} warning(s)${fetched.warnings.length > 0 ? `: ${fetched.warnings.join(' | ')}` : ''}`);
      const result = this.jobs.sync(panel.id, jobs, fetched.unreadable);
      const clashes = [...new Set(result.numberClashes ?? [])];
      const held = result.held ?? [];
      const warnings = [
        // First, so that it is not cut off the end of a long list: somebody's flight depends on the row being put right.
        ...(held.length > 0 ? [`a row of the sheet that can't be read may be ${held.join(', ')}, so ${held.length === 1 ? 'that flight is' : 'those flights are'} left as ${held.length === 1 ? 'it was' : 'they were'}, with the pilot, until the row is put right`] : []),
        ...fetched.warnings,
        ...(clashes.length > 0
          ? [`the flight number${clashes.length === 1 ? '' : 's'} ${clashes.join(', ')} ${clashes.length === 1 ? 'is' : 'are'} already the ID of another flight on this panel (an earlier one, until it is cleared out), so ${clashes.length === 1 ? 'that flight keeps' : 'those flights keep'} their other ID for now`]
          : []),
      ];
      this.store.updatePanel(panel.id, {
        lastRefreshAt: now,
        lastRefreshError: null,
        lastRefreshNote: warnings.length > 0 ? warnings.join('; ').slice(0, 400) : null,
      });
      // The warnings themselves go in the log too: they say which rows' flight numbers or dates the sheet needs putting right.
      this.log.info(`Refreshed ${panel.airlineName} from ${source.kind}: +${result.added} ~${result.updated} -${result.removed}${warnings.length > 0 ? ` (${warnings.length} warning${warnings.length === 1 ? '' : 's'}: ${warnings.join('; ').slice(0, 600)})` : ''}`);
      if (this.afterRead) {
        const after = this.afterRead;
        void Promise.resolve()
          .then(() => after(panel, fetched))
          .catch((e) => this.log.warn(`Something done after reading ${panel.airlineName}'s schedule failed: ${e instanceof Error ? e.message : String(e)}`));
      }
      return { ...result, warnings };
    } catch (e) {
      if (DEBUG_BUILD) dbg(this.log, `refresh FAILED for ${panel.airlineName} (panel ${panel.id}): ${e instanceof Error ? e.message : e}`);
      this.store.updatePanel(panel.id, { lastRefreshError: e instanceof Error ? e.message.slice(0, 200) : 'refresh failed' });
      throw e;
    }
  }

  /**
   * A schedule that suddenly reads as holding no flights at all is more likely broken (a date format changed, a sheet emptied while it is
   * being pasted into) than really empty, and applying it would take every flight off the panel and release every reservation. It is not
   * applied while rows could not be read, or while several flights are still to come.
   */
  private refuseEmptyRead(panel: Panel, fetched: FetchedJobs, now: number): void {
    const coming = this.store.listOpenJobViews(panel.id).filter((v) => v.job.deadline === null || v.job.deadline > now).length;
    if (coming === 0 || (fetched.warnings.length === 0 && coming < EMPTY_READ_BELIEVED_BELOW)) return;
    const why = fetched.warnings.length > 0 ? ` (${fetched.warnings.slice(0, 2).join('; ')})` : '';
    throw new JobError('BAD_INPUT', `The sheet was read but no flights were found in it${why}, so the ${coming} flight${coming === 1 ? '' : 's'} on the panel and ${coming === 1 ? 'its' : 'their'} reservations are left as they were.`);
  }

  /**
   * Refresh every panel that is due. A linked sheet is read once in each hourly slot (see `HourlySlot`: all the hourly checks happen
   * together), and one that failed is tried again in the next slot; any other automatic source is read every 24 hours.
   */
  async refreshDue(): Promise<number> {
    const now = this.now();
    let done = 0;
    const dueNow: Panel[] = [];
    for (const panel of this.store.listAllPanels()) {
      if (!this.sourceFor(panel)) continue;
      const hourly = panel.sheetId !== null;
      const quick = DEBUG_BUILD && !TEST_BUILD && hourly; // the test build's faster clock already makes an hour twelve seconds
      const due = panel.lastRefreshAt === null || (quick ? now - panel.lastRefreshAt >= DEBUG_SHEET_INTERVAL_MS : hourly ? this.slot.due(panel.lastRefreshAt, now) : now - panel.lastRefreshAt >= REFRESH_INTERVAL_MS);
      const last = this.lastAttempt.get(panel.id);
      const cooling = last !== undefined && (quick ? now - last < DEBUG_SHEET_INTERVAL_MS : hourly ? last >= this.slot.start(now) : now - last < RETRY_AFTER_FAILURE_MS);
      if (!due || cooling) continue;
      dueNow.push(panel);
    }
    // All the airlines' schedules are due in the same minute (the hourly slot). Each is a download from Google that can take several seconds, and
    // one that hangs holds up its timeout (twenty seconds); a few at a time, so one slow sheet does not make every other airline's wait for it. Only the
    // download overlaps: applying a schedule is one quick step that cannot be interrupted, so two never interleave.
    const queue = [...dueNow];
    const worker = async () => {
      for (let panel = queue.shift(); panel !== undefined; panel = queue.shift()) {
        try {
          await this.refresh(panel);
          done++;
        } catch (e) {
          this.log.warn(`Refresh failed for ${panel.airlineName}; keeping the existing flights`, e);
        }
      }
    };
    await Promise.all(Array.from({ length: Math.min(REFRESH_CONCURRENCY, queue.length) }, worker));
    return done;
  }
}
