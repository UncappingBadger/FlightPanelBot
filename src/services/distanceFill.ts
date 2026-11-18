import type { AirportCoord, Panel } from '../db/store.js';
import type { FetchedJobs, SourceJob, SourceLeg } from '../jobs/types.js';
import { DEBUG_BUILD, dbg } from '../util/debugBuild.js';
import { silentLogger, type Logger } from '../util/log.js';
import { greatCircleNm, type AirportDirectory } from './airports.js';
import type { SheetWriteBack } from './writeback.js';

/**
 * The **Distance (NM)** of a flight in an airline's schedule sheet. The distance of a flight is known before it is flown, so it is worked
 * out when the bot reads the schedule: the great-circle distance between the airports of each leg (their positions come from the public
 * OurAirports list the bot already keeps for its flight-time estimates), added up for a flight of several legs, in whole nautical miles.
 *
 * Two things are done with it, for a sheet that has such a column:
 *
 * - `enrich`: a flight whose Distance cell is blank still has its distance, worked out from the airports the bot already knows, so the
 *   flight's card can show it at once. A distance the sheet gives is never replaced by this one.
 * - `run`: the blank cells are written into the sheet, in the background, where the panel's write-back is on. Only a cell with nothing in
 *   it is ever written (the sheet is read afresh when it is written, so a manager who typed a distance meanwhile is never overwritten).
 *   A flight whose airports are not in the list is left for the next read. Nothing here can fail a refresh: what goes wrong is logged.
 */
export interface DistanceFillDeps {
  /** Writes to the airline's sheet; null when the bot has no Google credentials. */
  writeback: Pick<SheetWriteBack, 'enabledFor' | 'fillDistances'> | null;
  /** Finds airports' positions, reading the public airport list when it has to (slow, so only used in the background). */
  airports: Pick<AirportDirectory, 'coords'>;
  /** The positions of the airports the bot already has, at once. Without it a flight's distance is not worked out for the card. */
  positions?: (codes: string[]) => Map<string, AirportCoord>;
  /** Runs something a while from now (a timer that does not keep the program alive). Tests supply their own. */
  later?: (run: () => void, ms: number) => void;
  /** The panel as it is now, so a later attempt does not write to a sheet that has since been changed or unlinked. */
  getPanel?: (id: number) => Panel | null;
  logger?: Logger;
}

/**
 * The airport list is never read twice within ten minutes, so a flight whose airports were not known when the schedule was read (another part
 * of the bot read the list a moment before, for an airport of its own) is tried again a little after that, rather than at the next hourly read.
 */
const RETRY_AFTER_MS = 11 * 60_000;
const MAX_RETRIES = 3;

const defaultLater = (run: () => void, ms: number): void => {
  const timer = setTimeout(run, ms);
  timer.unref?.();
};

/** An airport code as the position tables have it. */
const tidy = (code: string): string => code.trim().toUpperCase();

/** The distance of a flight, in whole nautical miles: its legs' great-circle distances added up. Null when an airport has no known position. */
export function routeDistanceNm(legs: SourceLeg[], coords: ReadonlyMap<string, AirportCoord>): number | null {
  let total = 0;
  for (const leg of legs) {
    const from = coords.get(tidy(leg.dep));
    const to = coords.get(tidy(leg.arr));
    if (!from || !to) return null;
    total += greatCircleNm(from, to);
  }
  return Math.round(total) > 0 ? Math.round(total) : null;
}

const airportsOf = (jobs: SourceJob[]): string[] => jobs.flatMap((j) => j.legs.flatMap((l) => [tidy(l.dep), tidy(l.arr)]));

export class DistanceFiller {
  /** Panels being filled right now: a slow read of the airport list must not be started twice. */
  private readonly running = new Set<number>();

  constructor(private readonly d: DistanceFillDeps) {}

  private get log(): Logger {
    return this.d.logger ?? silentLogger;
  }

  /**
   * The flights of a schedule read from a sheet with a Distance column, each with its distance: the sheet's own, or else the one worked out
   * from the airports the bot already knows. Other sources (and a sheet with no such column) are returned as they are.
   */
  enrich(_panel: Panel, jobs: SourceJob[], fetched: FetchedJobs): SourceJob[] {
    if (fetched.blankDistances === undefined || !this.d.positions) return jobs;
    const lacking = jobs.filter((j) => j.distanceNm === null || j.distanceNm === undefined);
    if (lacking.length === 0) return jobs;
    const coords = this.d.positions(airportsOf(lacking));
    let worked = 0;
    const out = jobs.map((j) => {
      if (j.distanceNm !== null && j.distanceNm !== undefined) return j;
      const nm = routeDistanceNm(j.legs, coords);
      if (nm !== null) worked++;
      return nm === null ? j : { ...j, distanceNm: nm };
    });
    if (DEBUG_BUILD) dbg(this.log, `distances (for the cards): ${jobs.length - lacking.length} flight(s) have the sheet's own distance; of ${lacking.length} without one, ${worked} worked out from known airports and ${lacking.length - worked} still have none`);
    return out;
  }

  private tryAgainLater(panel: Panel, fetched: FetchedJobs, attempt: number): void {
    if (DEBUG_BUILD) dbg(this.log, `distances: some flights still lack an airport position; trying again in ${RETRY_AFTER_MS / 60_000} minutes (attempt ${attempt} of ${MAX_RETRIES} more)`);
    (this.d.later ?? defaultLater)(() => {
      const current = this.d.getPanel ? this.d.getPanel(panel.id) : panel;
      if (!current || current.sheetId !== panel.sheetId || current.sheetGid !== panel.sheetGid) return;
      void this.run(current, fetched, attempt);
    }, RETRY_AFTER_MS);
  }

  /** Work out and write the distances the schedule just read is missing. Returns how many cells were written; never throws. */
  async run(panel: Panel, fetched: FetchedJobs, attempt = 0): Promise<number> {
    const blank = fetched.blankDistances ?? [];
    if (DEBUG_BUILD) dbg(this.log, `distances: ${panel.airlineName}: the schedule has ${fetched.jobs.length} flight(s); ${fetched.blankDistances === undefined ? 'the sheet has no Distance column' : `${blank.length} have a blank Distance cell`}; sheet ${panel.sheetId ? 'linked' : 'not linked'}; write-back ${this.d.writeback?.enabledFor(panel) ? 'on' : 'off'}; attempt ${attempt}`);
    if (blank.length === 0 || !panel.sheetId || !this.d.writeback?.enabledFor(panel)) return 0;
    if (this.running.has(panel.id)) {
      if (DEBUG_BUILD) dbg(this.log, 'distances: another fill of this panel is still going, so this one stands aside');
      return 0;
    }
    this.running.add(panel.id);
    try {
      const wanted = new Set(blank);
      const jobs = fetched.jobs.filter((j) => wanted.has(j.key));
      const coords = await this.d.airports.coords(airportsOf(jobs));
      const plan: Array<{ sourceKey: string; nm: number }> = [];
      for (const job of jobs) {
        const nm = routeDistanceNm(job.legs, coords);
        if (nm !== null) plan.push({ sourceKey: job.key, nm });
      }
      if (DEBUG_BUILD) {
        const unknown = [...new Set(airportsOf(jobs).filter((c) => !coords.has(c)))];
        dbg(this.log, `distances: ${plan.length} of ${jobs.length} flight(s) can be worked out now${unknown.length > 0 ? `; no position yet for ${unknown.length} airport(s): ${unknown.slice(0, 30).join(' ')}${unknown.length > 30 ? ' ...' : ''}` : ''}`);
      }
      // Flights whose airports are still not known are tried again shortly, a few times (an airport that is not in the list at all gives up).
      if (plan.length < jobs.length && attempt < MAX_RETRIES) this.tryAgainLater(panel, fetched, attempt + 1);
      if (plan.length === 0) return 0;
      const written = (await this.d.writeback.fillDistances(panel, plan)).written;
      if (DEBUG_BUILD) dbg(this.log, `distances: ${written} cell(s) written of ${plan.length} planned`);
      return written;
    } catch (e) {
      this.log.warn(`Could not fill in the distances of ${panel.airlineName}: ${e instanceof Error ? e.message : String(e)}`);
      return 0;
    } finally {
      this.running.delete(panel.id);
    }
  }
}
