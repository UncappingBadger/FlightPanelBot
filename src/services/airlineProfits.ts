import type { AeroAircraft, AeroconomyAccountClient, LogFlight } from '../aeroconomy/account.js';
import { AeroconomyError } from '../aeroconomy/http.js';
import type { AeroconomyClient } from '../aeroconomy/client.js';
import type { Panel, Store } from '../db/store.js';
import type { FsHubApi } from '../fshub/client.js';
import { downloadSheetCsv, sheetRefOf } from '../jobs/sheet.js';
import { silentLogger, type Logger } from '../util/log.js';
import { isUnsetPay, readSheetFlights, type SheetFlight } from './contributions.js';
import { callsignCode } from './flightEtas.js';
import { fshubDistances } from './fshubDistances.js';
import { paidByDistance, pilotPay, type PayBasis } from './pilotPay.js';
import type { ProfitFill } from './writeback.js';

/**
 * Compares what Aeroconomy says each of an airline's flights made (the profit or loss in its aircraft's logbooks) with the *Profit Made*
 * the airline's managers entered in its schedule sheet, and works out which blank cells could be filled in.
 *
 * Reading is all this does. Writing a profit into the sheet is a separate step (`SheetWriteBack.fillProfits`), taken only when an admin
 * asks for it and confirms it. A cell that already has something in it is never a candidate: a difference is reported, not corrected. (A
 * Pilot Pay cell holding only $0 has no pay in it: a column formatted as money shows that for an empty cell.)
 */

const HOUR = 3_600_000;
/** A flight landed up to this long before its sheet day began, or this long after it... */
const EARLY_MS = 6 * HOUR;
const LATE_MS = 36 * HOUR;
/** The sheet is kept in whole dollars, so two profits within a dollar are the same one. */
const SAME_WITHIN = 1;
/** The pilots asked about when the airline's business has to be found from the aircraft they fly. */
const PILOTS_TO_TRY = 12;
/** When it is found from the airline's contract flights instead: the most contracts whose flights are read, and the most aircraft asked about. */
const CONTRACTS_TO_TRY = 12;
const AIRCRAFT_TO_TRY = 4;
/** FsHub and Aeroconomy give the same distance for a flight; if they differ by more than this many nautical miles, no pay is worked out from either. */
const DISTANCE_AGREES_WITHIN_NM = 1;
/** The most FsHub lookups (one per flight that lost money) one run makes: FsHub's request budget is shared with the rest of the bot. */
const MAX_DISTANCE_LOOKUPS = 25;

const businessKey = (airlineId: number) => `aero.business.${airlineId}`;
const norm = (s: string) => s.trim().toLowerCase();

/** Why a pilot's pay could not be worked out for a flight that lost money (its pay depends on the distance flown). */
export type PayProblem =
  /** The logbook entry names no FsHub flight, so there is no FsHub distance to confirm it with. */
  | 'no-flight-id'
  /** FsHub gave no distance for the flight (or could not be asked). */
  | 'no-distance'
  /** FsHub's distance and the logbook's are not the same. */
  | 'distance-differs';

/**
 * What is in the sheet's Pilot Pay cell of the row: no pay (empty, or the $0 a money-formatted column shows: it can be filled), a figure above
 * zero or any note or formula (left alone), no pay again after this bot wrote one (somebody set it back to $0 on purpose: left alone), or the
 * sheet has no such column.
 */
export type PayCell = 'empty' | 'filled' | 'zeroed' | 'missing';

/** The pilot's pay for a flight whose profit is going to be filled in, how it was worked out, and what the sheet's cell for it holds. */
export interface PayPlan {
  amount: number | null;
  basis: PayBasis | null;
  /** The distance FsHub recorded, when the pay was worked out from it. */
  distanceNm: number | null;
  problem: PayProblem | null;
  cell: PayCell;
}

/** One blank Profit Made cell that Aeroconomy's logbook can fill in, and the pilot's pay beside it. */
export interface ProfitFillPlan extends ProfitFill {
  route: string;
  /** Midnight (Zulu) of the sheet row's day. */
  day: number;
  callsign: string;
  /** The profit to the cent, as Aeroconomy has it (the cell gets it rounded up to a whole dollar). */
  exact: number;
  /** The FsHub flight the logbook entry is for, and the distance the logbook logged for it. */
  flightId: number | null;
  logbookNm: number | null;
  payPlan: PayPlan;
}

/** A Profit Made that is in the sheet and is not what Aeroconomy says. */
export interface ProfitDifference {
  row: number;
  route: string;
  day: number;
  callsign: string;
  sheet: number;
  aeroconomy: number;
}

export interface ProfitAnalysis {
  /** The airline's backing business on Aeroconomy, and how many aircraft logbooks were read (owned and leased together). */
  business: number;
  aircraft: number;
  /** How many of those are aircraft the airline leases, how many leased ones' logbooks Aeroconomy would not show this account (left out), and why the list of leased aircraft could not be read, if it could not (only the owned ones are used then). */
  leased: number;
  leasedHidden: number;
  leasedProblem: string | null;
  /** Flights read from the logbooks, and how many of them were flown under the airline's own callsign (only those are used). */
  logbookFlights: number;
  usableFlights: number;
  /** Rows of the sheet ticked as completed, and how many were matched to one logbook flight. */
  sheetCompleted: number;
  matched: number;
  /** Of the matched: the sheet agrees, it is blank (and can be filled), or it differs. */
  agree: number;
  fills: ProfitFillPlan[];
  different: ProfitDifference[];
  /** Matched rows whose Profit Made has something in it that is not an amount (`TBD`, `#N/A`): left alone, like every cell that is not empty. */
  unreadable: number;
  /** Completed rows no logbook flight was found for, and rows more than one flight could be (left alone). */
  unmatched: number;
  ambiguous: number;
  readAt: number;
}

/** Whether a flight was flown under the airline's own callsign: its code and a number. */
export const isAirlineCallsign = (callsign: string | null, code: string): boolean => callsign !== null && code !== '' && callsign.startsWith(code) && /^\d/.test(callsign.slice(code.length));

interface Pair {
  row: SheetFlight;
  flight: LogFlight;
}

/**
 * Pair the completed rows of a sheet with the logbook flights they are. A row is a flight with the same two airports whose landing falls
 * in the row's day (a little before it, or up to a day and a half after it begins); if several flights could be it, the pilot's name
 * settles it, and if that does not, the row is left alone. A flight cannot belong to two rows. A row of several legs (its route has
 * several arrows) is never the same as one flight, so it is never paired.
 */
export function pairRows(rows: SheetFlight[], flights: LogFlight[]): { pairs: Pair[]; unmatched: SheetFlight[]; ambiguous: SheetFlight[] } {
  const picks = new Map<SheetFlight, LogFlight>();
  const unmatched: SheetFlight[] = [];
  const ambiguous: SheetFlight[] = [];
  for (const row of rows) {
    const candidates = flights.filter((f) => row.route === `${f.dep} → ${f.arr}` && f.landedAt >= row.day - EARLY_MS && f.landedAt <= row.day + LATE_MS);
    if (candidates.length === 0) {
      unmatched.push(row);
      continue;
    }
    const byPilot = candidates.filter((f) => f.pilotName !== null && norm(f.pilotName) === norm(row.pilot));
    const only = candidates.length === 1 ? candidates[0] : byPilot.length === 1 ? byPilot[0] : undefined;
    if (only) picks.set(row, only);
    else ambiguous.push(row);
  }
  const claims = new Map<LogFlight, number>();
  for (const f of picks.values()) claims.set(f, (claims.get(f) ?? 0) + 1);
  const pairs: Pair[] = [];
  for (const [row, flight] of picks) {
    if ((claims.get(flight) ?? 0) > 1) ambiguous.push(row);
    else pairs.push({ row, flight });
  }
  return { pairs, unmatched, ambiguous };
}

/**
 * The pilot's pay for a flight whose profit is going to be filled in as `value` (whole dollars). A flight that lost money is paid by the
 * distance flown, and that distance is FsHub's: `distances` holds what FsHub recorded for each flight it was asked about, and the logbook's
 * own figure has to agree with it. Without both, there is no pay to work out, and the plan says why instead of guessing.
 */
export function planPay(value: number, row: SheetFlight, flightId: number | null, logbookNm: number | null, distances: ReadonlyMap<number, number>, wroteBefore = false): PayPlan {
  // A cell with no pay in it (blank, or $0) is free to be written over, unless this bot wrote a pay there before: then it is back to nothing
  // because somebody put it there, and that is theirs to decide.
  const cell: PayCell = row.payRaw === null ? 'missing' : !isUnsetPay(row.payRaw) ? 'filled' : wroteBefore ? 'zeroed' : 'empty';
  if (cell === 'zeroed') return { amount: null, basis: null, distanceNm: null, problem: null, cell };
  const none = (problem: PayProblem): PayPlan => ({ amount: null, basis: null, distanceNm: null, problem, cell });
  let nm: number | null = null;
  if (paidByDistance(value)) {
    if (flightId === null) return none('no-flight-id');
    const fshub = distances.get(flightId);
    if (fshub === undefined) return none('no-distance');
    if (logbookNm !== null && Math.abs(logbookNm - fshub) > DISTANCE_AGREES_WITHIN_NM) return none('distance-differs');
    nm = fshub;
  }
  const pay = pilotPay(value, nm);
  return pay ? { amount: pay.amount, basis: pay.basis, distanceNm: nm, problem: null, cell } : none('no-distance');
}

/** The comparison, from the sheet's rows and the logbook's flights (all of them; only the airline's own callsign is used). */
export function compareProfits(rows: SheetFlight[], flights: LogFlight[], code: string, distances: ReadonlyMap<number, number> = new Map(), wrotePay: ReadonlySet<string> = new Set()): Omit<ProfitAnalysis, 'business' | 'aircraft' | 'leased' | 'leasedHidden' | 'leasedProblem' | 'readAt'> {
  const usable = flights.filter((f) => isAirlineCallsign(f.callsign, code));
  const completed = rows.filter((r) => r.completed);
  const { pairs, unmatched, ambiguous } = pairRows(completed, usable);
  const fills: ProfitFillPlan[] = [];
  const different: ProfitDifference[] = [];
  let agree = 0;
  let unreadable = 0;
  for (const { row, flight } of pairs) {
    if (row.profit === null) {
      // Only a cell with nothing in it is ever a candidate: one with a note in it (`TBD`) or a stray space is somebody's, and is left alone.
      if (row.profitRaw !== '') {
        unreadable++;
        continue;
      }
      // Up, not to the nearest (Aeroconomy has no cents): $54,203.58 is $54,204, and a loss of $8,093.66 is -$8,093. The + 0 turns a -0 into 0.
      const value = Math.ceil(flight.profit) + 0;
      const payPlan = planPay(value, row, flight.flightId, flight.distanceNm, distances, wrotePay.has(row.sourceKey));
      fills.push({
        sourceKey: row.sourceKey,
        value,
        // The pay goes in only if it could be worked out and its cell is empty; the sheet is checked again when it is written.
        pay: payPlan.cell === 'empty' ? payPlan.amount : null,
        row: row.row,
        pilot: row.pilot,
        route: row.route,
        day: row.day,
        callsign: flight.callsign ?? '',
        exact: flight.profit,
        flightId: flight.flightId,
        logbookNm: flight.distanceNm,
        payPlan,
      });
    } else if (Math.abs(row.profit - flight.profit) <= SAME_WITHIN) agree++;
    else different.push({ row: row.row, route: row.route, day: row.day, callsign: flight.callsign ?? '', sheet: row.profit, aeroconomy: flight.profit });
  }
  fills.sort((a, b) => a.row - b.row);
  different.sort((a, b) => a.row - b.row);
  return { logbookFlights: flights.length, usableFlights: usable.length, sheetCompleted: completed.length, matched: pairs.length, agree, fills, different, unreadable, unmatched: unmatched.length, ambiguous: ambiguous.length };
}

/** Why a panel cannot be checked, in words an admin can act on. */
export class ProfitError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ProfitError';
  }
}

export interface AirlineProfitsDeps {
  store: Store;
  /** Reads with the FsHub token (aircraft and logbooks). */
  account: Pick<AeroconomyAccountClient, 'aircraft' | 'ownedAircraft' | 'logbook'> & Partial<Pick<AeroconomyAccountClient, 'leasedAircraft'>>;
  /** Reads Aeroconomy's public pages: a pilot's aircraft, and (to find the business from the aircraft on its flights) the airline's contracts and their flights. */
  publicClient: Pick<AeroconomyClient, 'pilotAircraftOwner'> & Partial<Pick<AeroconomyClient, 'airlineContracts' | 'manifests'>>;
  /** Reads FsHub, for the distance of a flight that lost money (the pilot's pay for it depends on that). Without it, such pay is not worked out. */
  fshub?: Pick<FsHubApi, 'airlineFlights'>;
  fetchFn?: typeof fetch;
  logger?: Logger;
  now?: () => number;
}

export class AirlineProfits {
  private readonly now: () => number;
  private readonly log: Logger;

  constructor(private readonly d: AirlineProfitsDeps) {
    this.now = d.now ?? Date.now;
    this.log = d.logger ?? silentLogger;
  }

  /**
   * Read the airline's aircraft logbooks and its sheet, and compare. Reads only. `business` is the airline's Aeroconomy business number
   * when an admin gave it; otherwise it is remembered from an earlier time, or found from the aircraft some of the airline's pilots fly.
   */
  async analyse(panel: Panel, business?: number): Promise<ProfitAnalysis> {
    const ref = sheetRefOf(panel);
    if (!ref) throw new ProfitError("This panel doesn't read a Google Sheet, so there are no Profit Made cells to compare with.");
    if (panel.fshubAirlineId === null) throw new ProfitError("This panel isn't linked to its airline's FsHub roster (`/setup fshub`), so I don't know which airline's aircraft to look at.");
    const airlineId = panel.fshubAirlineId;

    const businessId = await this.businessOf(panel, airlineId, business);
    const owned = await this.d.account.ownedAircraft(businessId);
    // The aircraft the airline leases fly its flights too, and their logbooks have the profits. A list that cannot be read is no reason to stop: the
    // owned ones are still read, and the report says the leased ones are not in it.
    const { aircraft: leasedAll, problem: leasedProblem } = await this.leasedFleet(businessId);
    const ownedSerials = new Set(owned.map((a) => a.serial));
    const leased = leasedAll.filter((a, i) => !ownedSerials.has(a.serial) && leasedAll.findIndex((b) => b.serial === a.serial) === i);
    if (owned.length === 0 && leased.length === 0) throw new ProfitError("Aeroconomy lists no aircraft for that airline, so there are no logbooks to read.");
    if (business !== undefined) {
      await this.checkOwner(owned, leased, airlineId);
      this.d.store.setKv(businessKey(airlineId), String(business));
    }

    const flights: LogFlight[] = [];
    for (const a of owned) flights.push(...(await this.d.account.logbook(a.serial)));
    // A leased aircraft's logbook may not be this account's to see (it says so with a 403): that one is left out, and said so, rather than costing the rest.
    let leasedRead = 0;
    let leasedHidden = 0;
    for (const a of leased) {
      try {
        flights.push(...(await this.d.account.logbook(a.serial)));
        leasedRead++;
      } catch (e) {
        if (!(e instanceof AeroconomyError) || e.status !== 403) throw e;
        leasedHidden++;
        this.log.debug(`Aeroconomy would not show the logbook of leased aircraft ${a.serial}`);
      }
    }

    const csv = await downloadSheetCsv(ref, this.d.fetchFn ?? fetch);
    const sheet = readSheetFlights(csv);
    if (!sheet) throw new ProfitError("I couldn't read that sheet as a schedule (it needs Route, Date, Pilot and Flight Completed columns).");
    if (!sheet.hasProfit) throw new ProfitError("The sheet has no Profit Made column, so there is nothing to compare with or fill in.");

    const code = callsignCode(panel);
    // A flight that lost money pays the pilot by the distance, so FsHub is asked how far each one was flown. Only the ones whose Pilot Pay is
    // empty need it: a pay that will not be written is not worth a request.
    const wrotePay = this.d.store.payWrittenKeys(panel.id);
    const ids = compareProfits(sheet.flights, flights, code, new Map(), wrotePay)
      .fills.filter((f) => f.flightId !== null && paidByDistance(f.value) && f.payPlan.cell === 'empty')
      .map((f) => f.flightId as number);
    const distances = await this.fshubDistances(airlineId, ids);
    const result = compareProfits(sheet.flights, flights, code, distances, wrotePay);
    this.log.info(`Compared ${result.matched} flights of ${panel.airlineName} with Aeroconomy's logbooks: ${result.agree} agree, ${result.fills.length} blank, ${result.different.length} differ`);
    return { business: businessId, aircraft: owned.length + leasedRead, leased: leasedRead, leasedHidden, leasedProblem, readAt: this.now(), ...result };
  }

  /**
   * How far FsHub says each of these flights was flown, in nautical miles. A flight FsHub gave no distance for (or could not be asked
   * about) is simply absent from the answer. At most `MAX_DISTANCE_LOOKUPS` are asked, and asking stops if FsHub says it is busy.
   */
  private async fshubDistances(airlineId: number, flightIds: number[]): Promise<Map<number, number>> {
    const fshub = this.d.fshub;
    return fshub ? fshubDistances(fshub, airlineId, flightIds, MAX_DISTANCE_LOOKUPS, this.log) : new Map<number, number>();
  }

  /**
   * The airline's backing business: given, remembered, or found from an aircraft that is out right now, either attached to one of the
   * airline's contract flights or flown by one of its recent pilots. Once found it is remembered, so this is only ever asked once.
   */
  private async businessOf(panel: Panel, airlineId: number, given: number | undefined): Promise<number> {
    if (given !== undefined) return given;
    const saved = Number(this.d.store.getKv(businessKey(airlineId)));
    if (Number.isSafeInteger(saved) && saved > 0) return saved;
    const fromFlights = await this.businessFromFlights(airlineId);
    if (fromFlights !== null) {
      this.d.store.setKv(businessKey(airlineId), String(fromFlights));
      return fromFlights;
    }
    for (const pilotId of this.d.store.recentFshubPilotIds(panel.id, PILOTS_TO_TRY)) {
      const owner = await this.d.publicClient.pilotAircraftOwner(pilotId);
      if (owner && owner.airlineId === airlineId) {
        this.d.store.setKv(businessKey(airlineId), String(owner.businessId));
        return owner.businessId;
      }
    }
    throw new ProfitError(
      "I couldn't find the airline's aircraft on Aeroconomy: none of its contract flights or recent pilots has one of its aircraft out right now. Try again later, or give its Aeroconomy business number with `business:` (the number in the web address of the airline's business page on Aeroconomy, aeroconomy.com/businesses/…). I remember it after that.",
    );
  }

  /**
   * The business behind an airline's aircraft, from its contracts' flights: a flight that has been taken has the serial of the aircraft
   * attached to it, so such an aircraft is asked who owns it. Public pages, and one aircraft read (with the FsHub token) per aircraft tried.
   * Contracts with flights under way come first, and only a few contracts and aircraft are tried. Null when nothing here shows it, or when
   * Aeroconomy cannot be read just now: the caller goes on to the pilots, and a failure here is not something an admin can act on.
   */
  private async businessFromFlights(airlineId: number): Promise<number | null> {
    const client = this.d.publicClient;
    if (!client.airlineContracts || !client.manifests) return null;
    const asked = new Set<number>();
    try {
      const contracts = [...(await client.airlineContracts(airlineId))]
        .sort((a, b) => Number(b.status === 'active') - Number(a.status === 'active') || (b.total ?? 0) - (a.total ?? 0) || b.id - a.id)
        .slice(0, CONTRACTS_TO_TRY);
      for (const contract of contracts) {
        for (const flight of await client.manifests(contract.id)) {
          const serial = flight.aircraftSerial;
          if (serial === undefined || asked.has(serial)) continue;
          if (asked.size >= AIRCRAFT_TO_TRY) return null;
          asked.add(serial);
          try {
            const aircraft = await this.d.account.aircraft(serial);
            if (aircraft?.ownerType === 'airline' && aircraft.ownerAirlineId === airlineId && aircraft.businessId !== null) return aircraft.businessId;
          } catch (e) {
            this.log.debug(`Aeroconomy would not show aircraft ${serial}: ${e instanceof Error ? e.message : String(e)}`);
          }
        }
      }
    } catch (e) {
      this.log.debug(`Could not look through the airline's contract flights for its aircraft: ${e instanceof Error ? e.message : String(e)}`);
    }
    return null;
  }

  /** The aircraft the business leases, or why they could not be listed (and none then). Only a refusal or a failure of Aeroconomy is taken as that; anything else is a bug and is thrown. */
  private async leasedFleet(businessId: number): Promise<{ aircraft: AeroAircraft[]; problem: string | null }> {
    const read = this.d.account.leasedAircraft;
    if (!read) return { aircraft: [], problem: null };
    try {
      return { aircraft: await read.call(this.d.account, businessId), problem: null };
    } catch (e) {
      if (!(e instanceof AeroconomyError)) throw e;
      this.log.debug(`Could not list the leased aircraft of business ${businessId}: ${e.message}`);
      return { aircraft: [], problem: e.message };
    }
  }

  /**
   * A business number an admin typed has to be the airline's own. Its first owned aircraft must say so; a business that owns none can only be
   * told by the aircraft it leases, one of which has to name the airline as the one whose pilots fly it. Nothing is read until it is.
   */
  private async checkOwner(owned: AeroAircraft[], leased: AeroAircraft[], airlineId: number): Promise<void> {
    const first = owned[0];
    if (first) {
      const aircraft = first.ownerAirlineId !== null ? first : await this.d.account.aircraft(first.serial);
      if (aircraft?.ownerType !== 'airline' || aircraft.ownerAirlineId !== airlineId) throw new ProfitError("That business isn't this airline's: its aircraft belong to someone else, so I haven't read anything.");
      return;
    }
    if (!leased.some((a) => a.pilotAirlineId === airlineId)) {
      throw new ProfitError("I can't tell that business is this airline's: it owns no aircraft, and none of the aircraft it leases says this airline's pilots fly it, so I haven't read anything.");
    }
  }
}
