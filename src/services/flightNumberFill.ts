import type { Panel } from '../db/store.js';
import type { FetchedJobs } from '../jobs/types.js';
import { DEBUG_BUILD, dbg } from '../util/debugBuild.js';
import { silentLogger, type Logger } from '../util/log.js';
import type { AeroNumbers } from './aeroNumbers.js';
import type { SheetWriteBack } from './writeback.js';

/**
 * The **Flight Number** of every flight in an airline's schedule sheet. A flight's number is the airline's own (Aeroconomy publishes it with the
 * flight, and the bot already reads those numbers for `/setup flight-numbers`), so a sheet with a Flight Number column can have it filled in for
 * each row, past and future, once the bot has read them.
 *
 * It happens as the schedule is read, for a panel that has `/setup flight-numbers` switched on (it is linked to its airline's FsHub number) and
 * where the panel's write-back is on. Only a cell with nothing in it is ever written, and a row is only given a number when it is exactly one
 * published flight (the same two airports and landing window, and nobody else wanting it): nothing is guessed. The sheet is read afresh when it
 * is written, so a number a manager typed meanwhile is never replaced. Nothing here can fail a refresh: what goes wrong is logged.
 */
export interface FlightNumberFillDeps {
  /** Writes to the airline's sheet; null when the bot has no Google credentials. */
  writeback: Pick<SheetWriteBack, 'enabledFor' | 'fillFlightNumbers'> | null;
  /** The numbers read from Aeroconomy. */
  numbers: Pick<AeroNumbers, 'numbersFor'>;
  logger?: Logger;
}

export class FlightNumberFiller {
  /** Panels being filled right now: a second fill of the same sheet waits for the next read. */
  private readonly running = new Set<number>();

  constructor(private readonly d: FlightNumberFillDeps) {}

  private get log(): Logger {
    return this.d.logger ?? silentLogger;
  }

  /** Write the flight numbers the schedule just read is missing. Returns how many cells were written; never throws. */
  async run(panel: Panel, fetched: FetchedJobs): Promise<number> {
    const blank = fetched.blankFlightNumbers ?? [];
    if (DEBUG_BUILD) dbg(this.log, `flight numbers: ${panel.airlineName}: ${fetched.blankFlightNumbers === undefined ? 'the sheet has no Flight Number column' : `${blank.length} row(s) have a blank Flight Number cell`}; the panel ${panel.flightNumbers ? 'takes' : 'does not take'} Aeroconomy's numbers; write-back ${this.d.writeback?.enabledFor(panel) ? 'on' : 'off'}`);
    if (blank.length === 0 || !panel.sheetId || !panel.flightNumbers || panel.fshubAirlineId === null || !this.d.writeback?.enabledFor(panel)) return 0;
    // Nothing is asked of Google unless at least one of the empty cells has a number to go in it.
    if (!this.d.numbers.numbersFor(panel, blank).some((n) => n !== null)) return 0;
    if (this.running.has(panel.id)) return 0;
    this.running.add(panel.id);
    try {
      const written = (await this.d.writeback.fillFlightNumbers(panel, (rows) => this.d.numbers.numbersFor(panel, rows))).written;
      if (DEBUG_BUILD) dbg(this.log, `flight numbers: ${written} cell(s) written`);
      return written;
    } catch (e) {
      this.log.warn(`Could not fill in the flight numbers of ${panel.airlineName}: ${e instanceof Error ? e.message : String(e)}`);
      return 0;
    } finally {
      this.running.delete(panel.id);
    }
  }
}
