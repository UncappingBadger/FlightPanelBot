import type { AirportCoord, Panel } from '../db/store.js';
import type { FetchedJobs, SourceJob, SourceLeg } from '../jobs/types.js';
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
  logger?: Logger;
}

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
    return jobs.map((j) => {
      if (j.distanceNm !== null && j.distanceNm !== undefined) return j;
      const nm = routeDistanceNm(j.legs, coords);
      return nm === null ? j : { ...j, distanceNm: nm };
    });
  }

  /** Work out and write the distances the schedule just read is missing. Returns how many cells were written; never throws. */
  async run(panel: Panel, fetched: FetchedJobs): Promise<number> {
    const blank = fetched.blankDistances ?? [];
    if (blank.length === 0 || !panel.sheetId || !this.d.writeback?.enabledFor(panel)) return 0;
    if (this.running.has(panel.id)) return 0;
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
      if (plan.length === 0) return 0;
      return (await this.d.writeback.fillDistances(panel, plan)).written;
    } catch (e) {
      this.log.warn(`Could not fill in the distances of ${panel.airlineName}: ${e instanceof Error ? e.message : String(e)}`);
      return 0;
    } finally {
      this.running.delete(panel.id);
    }
  }
}
