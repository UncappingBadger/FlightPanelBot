import type { Panel, Store } from '../db/store.js';
import { normalizeFetched, type JobSource } from '../jobs/types.js';
import { silentLogger, type Logger } from '../util/log.js';
import { JobError, type JobService, type SyncResult } from './jobs.js';

/** How often an automatic source (the demo) is re-read. */
export const REFRESH_INTERVAL_MS = 24 * 60 * 60 * 1000;
/** A linked Google Sheet changes all day (sign-ups, ticked boxes), so it is re-read more often. */
export const SHEET_REFRESH_INTERVAL_MS = 60 * 60 * 1000;
const RETRY_AFTER_FAILURE_MS = 60 * 60 * 1000;

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
    private readonly now: () => number = Date.now,
  ) {}

  hasSource(panel: Panel): boolean {
    return this.sourceFor(panel) !== null;
  }

  /** Fetch and apply now. Throws if the panel has no source or the source fails (old jobs are left as they were). */
  async refresh(panel: Panel): Promise<RefreshOutcome> {
    const source = this.sourceFor(panel);
    if (!source) throw new JobError('BAD_INPUT', "This panel's flights come from file imports, so there's nothing to fetch. Use `/setup import`.");
    const now = this.now();
    this.lastAttempt.set(panel.id, now);
    try {
      const { jobs, warnings } = normalizeFetched(await source.fetch({ name: panel.airlineName, abbr: panel.airlineAbbr }, now));
      const result = this.jobs.sync(panel.id, jobs);
      this.store.updatePanel(panel.id, {
        lastRefreshAt: now,
        lastRefreshError: null,
        lastRefreshNote: warnings.length > 0 ? warnings.join('; ').slice(0, 400) : null,
      });
      this.log.info(`Refreshed ${panel.airlineName} from ${source.kind}: +${result.added} ~${result.updated} -${result.removed}${warnings.length > 0 ? ` (${warnings.length} warning${warnings.length === 1 ? '' : 's'})` : ''}`);
      return { ...result, warnings };
    } catch (e) {
      this.store.updatePanel(panel.id, { lastRefreshError: e instanceof Error ? e.message.slice(0, 200) : 'refresh failed' });
      throw e;
    }
  }

  /** Refresh every panel whose last refresh is older than its interval (a failed one is retried hourly). */
  async refreshDue(): Promise<number> {
    const now = this.now();
    let done = 0;
    for (const panel of this.store.listAllPanels()) {
      if (!this.sourceFor(panel)) continue;
      const due = panel.lastRefreshAt === null || now - panel.lastRefreshAt >= refreshIntervalFor(panel);
      const last = this.lastAttempt.get(panel.id);
      const cooling = last !== undefined && now - last < RETRY_AFTER_FAILURE_MS;
      if (!due || cooling) continue;
      try {
        await this.refresh(panel);
        done++;
      } catch (e) {
        this.log.warn(`Refresh failed for ${panel.airlineName}; keeping the existing flights`, e);
      }
    }
    return done;
  }
}
