import type { AeroAircraft, AeroconomyAccountClient, LogFlight } from '../aeroconomy/account.js';
import { AeroconomyError } from '../aeroconomy/http.js';
import type { AeroconomyClient } from '../aeroconomy/client.js';
import type { Panel, Store } from '../db/store.js';
import type { FsHubApi } from '../fshub/client.js';
import { downloadSheetCsv, sheetRefOf } from '../jobs/sheet.js';
import { silentLogger, type Logger } from '../util/log.js';
import { isUnsetPay, parseMoney, readSheetFlights, type SheetFlight, type SheetFlights } from './contributions.js';
import { callsignCode } from './flightEtas.js';
import { fshubFlightFacts, type FlightFacts } from './fshubDistances.js';
import { looselySame } from './payroll.js';
import { paidByDistance, pilotPay, type PayBasis } from './pilotPay.js';
import { fineFor, limitsFor, normalizeAircraft, readLanding, type FineTier, type SafetyFine, type SafetyPolicy } from './safetyPay.js';
import type { ProfitFill } from './writeback.js';
import { appNow } from '../util/clock.js';

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
/** The most FsHub lookups (one per flight whose pay needs its distance or its landing rate) one run makes: FsHub's request budget is shared with the rest of the bot. */
const MAX_DISTANCE_LOOKUPS = 25;
/** A run that looks for deductions to add to flights already filled in asks FsHub about this many flights at most; the next run goes on with the rest. */
const MAX_DEDUCTION_LOOKUPS = 50;

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

/** Why a flight was left unfilled when safety pay is on: FsHub gave no landing rate, or one too hard to believe as a touchdown (a bad reading from the sim or tracker). */
export type HeldReason = 'no-landing-rate' | 'landing-rate-not-believed';

/**
 * A flight left out of the fill, profit and pay together, because safety pay is on and its landing rate cannot be trusted. If in doubt the bot leaves the sheet
 * alone and tells the airline's managers, who can fill the cells in by hand.
 */
export interface HeldFlight {
  sourceKey: string;
  row: number;
  route: string;
  day: number;
  /** The airline's own callsign for the flight, which is its flight number. */
  callsign: string;
  /** The pilot the sheet names. */
  pilot: string;
  flightId: number | null;
  reason: HeldReason;
  /** The landing rate FsHub gave when it was too hard to believe (feet per minute, no sign). */
  fpm: number | null;
}

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
  /** Set when the pay was cut for a hard landing (safety pay): the tier, the landing rate in feet per minute, the share of the profit it pays and what it would have paid. */
  safety?: { tier: FineTier; fpm: number; share: number; normal: number; minimumLoss: number; byMinimum: boolean } | null;
}

/** What is in the sheet's Safety Deductions cell of the row: empty (it can be written), something already in it, or the sheet has no such column. */
export type DeductionCell = 'empty' | 'filled' | 'missing';

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
  /** Only where the airline asked for deductions to be written and this flight's pay is cut: what the Safety Deductions cell holds (`deduction` is the amount when it can be written). */
  deductionCell?: DeductionCell;
  /** The logbook's name for who flew it, when that is not the name in the sheet: whoever confirms the fill should check it. */
  logbookPilot?: string;
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
  /** Rows left alone because the only flight that fits was flown by another pilot the sheet names. */
  others?: number;
  /** Rows that would be filled but are held for a later run because safety pay is on and FsHub's landing rate for the flight could not be read yet. */
  waiting?: number;
  /** Rows that would be filled but are left alone because safety pay is on and the flight's landing rate cannot be trusted (managers are told). */
  held?: HeldFlight[];
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
 * several arrows) is never the same as one flight, so it is never paired. A flight the logbook gives to another pilot the sheet names
 * (`sheetPilots`) is that pilot's, even when it is the only one that fits: the row is left alone.
 */
export function pairRows(rows: SheetFlight[], flights: LogFlight[], sheetPilots: readonly string[] = rows.map((r) => r.pilot)): { pairs: Pair[]; unmatched: SheetFlight[]; ambiguous: SheetFlight[]; others: SheetFlight[] } {
  const picks = new Map<SheetFlight, LogFlight>();
  const unmatched: SheetFlight[] = [];
  const ambiguous: SheetFlight[] = [];
  const others: SheetFlight[] = [];
  for (const row of rows) {
    const candidates = flights.filter((f) => row.route === `${f.dep} → ${f.arr}` && f.landedAt >= row.day - EARLY_MS && f.landedAt <= row.day + LATE_MS);
    if (candidates.length === 0) {
      unmatched.push(row);
      continue;
    }
    const byPilot = candidates.filter((f) => f.pilotName !== null && norm(f.pilotName) === norm(row.pilot));
    const only = candidates.length === 1 ? candidates[0] : byPilot.length === 1 ? byPilot[0] : undefined;
    if (!only) ambiguous.push(row);
    else if (flownByAnother(row, only, sheetPilots)) others.push(row);
    else picks.set(row, only);
  }
  const claims = new Map<LogFlight, number>();
  for (const f of picks.values()) claims.set(f, (claims.get(f) ?? 0) + 1);
  const pairs: Pair[] = [];
  for (const [row, flight] of picks) {
    if ((claims.get(flight) ?? 0) > 1) ambiguous.push(row);
    else pairs.push({ row, flight });
  }
  return { pairs, unmatched, ambiguous, others };
}

/** Does the logbook give this flight to somebody else the sheet names? A name the sheet does not have may only be another spelling of the row's pilot. */
function flownByAnother(row: SheetFlight, flight: LogFlight, sheetPilots: readonly string[]): boolean {
  const flew = flight.pilotName;
  if (!flew || looselySame(flew, row.pilot)) return false;
  return sheetPilots.some((p) => !looselySame(p, row.pilot) && looselySame(p, flew));
}

/**
 * The distance a flight that lost money was flown, for its pay: FsHub's, and only when the logbook's own figure agrees with it. Otherwise the reason there is none.
 */
function distanceFor(flightId: number | null, logbookNm: number | null, distances: ReadonlyMap<number, number>): number | PayProblem {
  if (flightId === null) return 'no-flight-id';
  const fshub = distances.get(flightId);
  if (fshub === undefined) return 'no-distance';
  if (logbookNm !== null && Math.abs(logbookNm - fshub) > DISTANCE_AGREES_WITHIN_NM) return 'distance-differs';
  return fshub;
}

/**
 * The pilot's pay for a flight whose profit is going to be filled in as `value` (whole dollars). A flight that lost money is paid by the
 * distance flown, and that distance is FsHub's: `distances` holds what FsHub recorded for each flight it was asked about, and the logbook's
 * own figure has to agree with it. Without both, there is no pay to work out, and the plan says why instead of guessing.
 */
export function planPay(
  value: number,
  row: SheetFlight,
  flightId: number | null,
  logbookNm: number | null,
  distances: ReadonlyMap<number, number>,
  wroteBefore = false,
  fine: SafetyFine | null = null,
): PayPlan {
  const cell = payCellOf(row, wroteBefore);
  if (cell === 'zeroed') return { amount: null, basis: null, distanceNm: null, problem: null, cell };
  const none = (problem: PayProblem): PayPlan => ({ amount: null, basis: null, distanceNm: null, problem, cell });
  let nm: number | null = null;
  if (paidByDistance(value)) {
    const got = distanceFor(flightId, logbookNm, distances);
    if (typeof got === 'string') return none(got);
    nm = got;
  }
  const pay = pilotPay(value, nm, fine);
  if (!pay) return none('no-distance');
  // A pay of nothing (a safety fine on a flight that made no profit, where the airline dropped the minimum) is nothing to write.
  return {
    amount: pay.amount > 0 ? pay.amount : null,
    basis: pay.basis,
    distanceNm: nm,
    problem: null,
    cell,
    // Only set when safety pay had something to say, so a plan made with it off is exactly what it always was.
    ...(pay.safety && fine ? { safety: { tier: pay.safety.tier, fpm: fine.fpm, share: pay.safety.share, normal: pay.safety.normal, minimumLoss: pay.safety.minimumLoss, byMinimum: pay.safety.byMinimum } } : {}),
  };
}

/**
 * What is in the sheet's Pilot Pay cell of the row: no pay in it (blank, or $0) is free to be written over, unless this bot wrote a pay there before:
 * then it is back to nothing because somebody put it there, and that is theirs to decide.
 */
export function payCellOf(row: SheetFlight, wroteBefore = false): PayCell {
  return row.payRaw === null ? 'missing' : !isUnsetPay(row.payRaw) ? 'filled' : wroteBefore ? 'zeroed' : 'empty';
}

/** How an airline's safety pay stands while its blank profits are compared: its policy, and the landing rate FsHub gave for each flight it was asked about (null: it gave none). */
export interface SafetyContext {
  policy: SafetyPolicy | null;
  landing: ReadonlyMap<number, number | null>;
  /** The type of aircraft FsHub says flew each flight it was asked about (what the landing is judged by); a flight not in it is judged by the type of the aircraft whose logbook it is in. */
  aircraft?: ReadonlyMap<number, string | null>;
  /** The airline asked for what a hard landing takes off the pay to be written in the Safety Deductions column too. */
  deductions?: boolean;
}

/** The comparison, from the sheet's rows and the logbook's flights (all of them; only the airline's own callsign is used). */
export function compareProfits(
  rows: SheetFlight[],
  flights: LogFlight[],
  code: string,
  distances: ReadonlyMap<number, number> = new Map(),
  wrotePay: ReadonlySet<string> = new Set(),
  safety: SafetyContext = { policy: null, landing: new Map() },
): Omit<ProfitAnalysis, 'business' | 'aircraft' | 'leased' | 'leasedHidden' | 'leasedProblem' | 'readAt'> & { needFacts: number[] } {
  const usable = flights.filter((f) => isAirlineCallsign(f.callsign, code));
  const completed = rows.filter((r) => r.completed);
  const { pairs, unmatched, ambiguous, others } = pairRows(completed, usable, rows.map((r) => r.pilot));
  const fills: ProfitFillPlan[] = [];
  const different: ProfitDifference[] = [];
  const needFacts = new Set<number>();
  let agree = 0;
  const held: HeldFlight[] = [];
  let unreadable = 0;
  let waiting = 0;
  for (const { row, flight } of pairs) {
    if (row.profit === null) {
      // Only a cell with nothing in it is ever a candidate: one with a note in it (`TBD`) or a stray space is somebody's, and is left alone.
      if (row.profitRaw !== '') {
        unreadable++;
        continue;
      }
      // Up, not to the nearest (Aeroconomy has no cents): $54,203.58 is $54,204, and a loss of $8,093.66 is -$8,093. The + 0 turns a -0 into 0.
      const value = Math.ceil(flight.profit) + 0;
      const wrote = wrotePay.has(row.sourceKey);
      const cell = payCellOf(row, wrote);
      // FsHub is asked about a flight whose pay depends on it: its distance when it lost money, and its landing rate when safety pay applies to it.
      const safetyApplies = safety.policy !== null && flight.landedAt >= safety.policy.since;
      if (flight.flightId !== null && cell === 'empty' && (paidByDistance(value) || safetyApplies)) needFacts.add(flight.flightId);
      let fine: SafetyFine | null = null;
      if (safetyApplies && cell === 'empty') {
        // If in doubt the row is left alone, profit and pay together (a pay is only ever written beside a profit written in the same run), and the managers are told.
        const hold = (reason: HeldReason, fpm: number | null): void => {
          held.push({ sourceKey: row.sourceKey, row: row.row, route: row.route, day: row.day, callsign: flight.callsign ?? '', pilot: row.pilot, flightId: flight.flightId, reason, fpm });
        };
        if (flight.flightId === null) {
          hold('no-landing-rate', null); // the logbook names no FsHub flight, so there is no landing rate to find
          continue;
        }
        if (!safety.landing.has(flight.flightId)) {
          // FsHub has not been asked (or could not be) for this flight's landing rate, so its pay cannot be worked out: the flight, profit and all,
          // waits for a later run rather than being filled with a pay that might need cutting.
          waiting++;
          continue;
        }
        const type = safety.aircraft?.get(flight.flightId) ?? flight.aircraftType ?? null;
        const read = readLanding(safety.landing.get(flight.flightId), limitsFor(safety.policy!, type));
        if (read.kind === 'none') {
          hold('no-landing-rate', null);
          continue;
        }
        if (read.kind === 'unreliable') {
          hold('landing-rate-not-believed', read.fpm);
          continue;
        }
        fine = fineFor(read, flight.landedAt, safety.policy, type);
      }
      const payPlan = planPay(value, row, flight.flightId, flight.distanceNm, distances, wrote, fine);
      // What the hard landing took off: what the flight would have paid, less what it pays. Only written beside a pay this bot is writing too (the pay cell empty),
      // into a Safety Deductions cell with nothing in it.
      let deduction: number | null = null;
      let deductionCell: DeductionCell | undefined;
      if (safety.deductions && payPlan.safety && payPlan.cell === 'empty') {
        const taken = payPlan.safety.normal - (payPlan.amount ?? 0);
        if (taken > 0) {
          deductionCell = row.deductionRaw === undefined || row.deductionRaw === null ? 'missing' : isUnsetPay(row.deductionRaw) ? 'empty' : 'filled';
          if (deductionCell === 'empty') deduction = taken;
        }
      }
      fills.push({
        sourceKey: row.sourceKey,
        value,
        // The pay goes in only if it could be worked out and its cell is empty; the sheet is checked again when it is written.
        pay: payPlan.cell === 'empty' ? payPlan.amount : null,
        ...(deduction !== null ? { deduction } : {}),
        row: row.row,
        pilot: row.pilot,
        route: row.route,
        day: row.day,
        callsign: flight.callsign ?? '',
        exact: flight.profit,
        flightId: flight.flightId,
        logbookNm: flight.distanceNm,
        payPlan,
        ...(deductionCell ? { deductionCell } : {}),
        ...(flight.pilotName && row.pilot.trim() !== '' && !looselySame(flight.pilotName, row.pilot) ? { logbookPilot: flight.pilotName } : {}),
      });
    } else if (Math.abs(row.profit - flight.profit) <= SAME_WITHIN) agree++;
    else different.push({ row: row.row, route: row.route, day: row.day, callsign: flight.callsign ?? '', sheet: row.profit, aeroconomy: flight.profit });
  }
  fills.sort((a, b) => a.row - b.row);
  different.sort((a, b) => a.row - b.row);
  held.sort((a, b) => a.row - b.row);
  return { logbookFlights: flights.length, usableFlights: usable.length, sheetCompleted: completed.length, matched: pairs.length, agree, fills, different, unreadable, unmatched: unmatched.length, ambiguous: ambiguous.length, others: others.length, waiting, held, needFacts: [...needFacts] };
}

/* ------------------------------------------------------------------ deductions for flights already filled in */

/** A Safety Deductions cell that can be written beside a pay that is already in the sheet. */
export interface DeductionFill {
  sourceKey: string;
  /** The row and the pilot's name it had when this was worked out: if either has changed by the time it is written, nothing is written. */
  row: number;
  pilot: string;
  route: string;
  /** Midnight (Zulu) of the sheet row's day. */
  day: number;
  callsign: string;
  /** The Pilot Pay the sheet has (whole dollars): it is exactly what the cut gives, which is why a deduction is worth writing. Checked again when it is written. */
  pay: number;
  /** What the flight would have paid without the cut. */
  normal: number;
  /** What the cut took off: `normal` less `pay`. */
  deduction: number;
  tier: FineTier;
  fpm: number;
}

/** What a look for missing deductions found. */
export interface DeductionAnalysis {
  /** The airline's backing business on Aeroconomy, and how many aircraft logbooks were read. */
  business: number;
  aircraft: number;
  leased: number;
  leasedHidden: number;
  leasedProblem: string | null;
  readAt: number;
  /** Completed flights of the sheet matched to a logbook flight. */
  matched: number;
  fills: DeductionFill[];
  /** Matched flights that already have something in Safety Deductions (left as it is). */
  already: number;
  /** Flights whose pay was not cut: landed before safety pay was turned on, a softer landing than Tier 2, or a cut that took nothing off. */
  uncut: number;
  /** Flights that landed hard enough to be cut but were paid in full in the sheet: nothing was taken off, so nothing is recorded. */
  paidInFull: number;
  /** Flights whose pay in the sheet is neither what the cut gives nor the usual pay (somebody changed it, or the airline's percentages have changed since): left alone. */
  differs: number;
  /** Flights whose pay is still empty, so there is no pay to record a deduction against yet. */
  unpaid: number;
  /** Flights FsHub gave no landing rate (or distance, for a flight that lost money) that could be used: nothing can be said about them. */
  noRate: number;
  /** Flights FsHub was not asked about yet (the run's limit, or FsHub was busy): a later run goes on with them. */
  waiting: number;
}

/**
 * Work out the deductions missing from flights already filled in: a completed flight that landed after safety pay was turned on, at Tier 2 or Tier 3, whose Safety
 * Deductions cell is empty and whose Pilot Pay is exactly what the cut gives (worked out afresh from the profit in the sheet and FsHub's landing rate and
 * distance), where the cut took something off. A pay that is not exactly that (paid in full, or changed by somebody) is left alone and counted: the deduction
 * would say something the pay does not. `distances` and `landing` are what FsHub said about each flight it was asked about; a flight it has not been asked
 * about is in `needFacts` and counted as waiting.
 */
export function compareDeductions(
  rows: SheetFlight[],
  flights: LogFlight[],
  code: string,
  distances: ReadonlyMap<number, number>,
  landing: ReadonlyMap<number, number | null>,
  policy: SafetyPolicy,
  aircraft: ReadonlyMap<number, string | null> = new Map(),
): Omit<DeductionAnalysis, 'business' | 'aircraft' | 'leased' | 'leasedHidden' | 'leasedProblem' | 'readAt'> & { needFacts: number[] } {
  const usable = flights.filter((f) => isAirlineCallsign(f.callsign, code));
  const { pairs } = pairRows(rows.filter((r) => r.completed), usable, rows.map((r) => r.pilot));
  const out = { matched: pairs.length, fills: [] as DeductionFill[], already: 0, uncut: 0, paidInFull: 0, differs: 0, unpaid: 0, noRate: 0, waiting: 0 };
  const needFacts: number[] = [];
  for (const { row, flight } of pairs) {
    // A flight with no profit in the sheet yet is the ordinary fill's business, and one whose deduction cell has something in it is somebody's.
    if (row.profit === null) continue;
    if (row.deductionRaw === undefined || row.deductionRaw === null) continue;
    if (!isUnsetPay(row.deductionRaw)) {
      out.already++;
      continue;
    }
    if (flight.landedAt < policy.since) {
      out.uncut++;
      continue;
    }
    if (flight.flightId === null) {
      out.noRate++;
      continue;
    }
    if (!landing.has(flight.flightId)) {
      if (!needFacts.includes(flight.flightId)) needFacts.push(flight.flightId);
      out.waiting++;
      continue;
    }
    const type = aircraft.get(flight.flightId) ?? flight.aircraftType ?? null;
    const read = readLanding(landing.get(flight.flightId), limitsFor(policy, type));
    if (read.kind !== 'ok') {
      out.noRate++;
      continue;
    }
    const fine = fineFor(read, flight.landedAt, policy, type);
    if (fine === null) {
      out.uncut++;
      continue;
    }
    let nm: number | null = null;
    if (paidByDistance(row.profit)) {
      const got = distanceFor(flight.flightId, flight.distanceNm, distances);
      if (typeof got === 'string') {
        out.noRate++;
        continue;
      }
      nm = got;
    }
    const cut = pilotPay(row.profit, nm, fine);
    const usual = pilotPay(row.profit, nm, null);
    if (!cut || !usual) {
      out.noRate++;
      continue;
    }
    const taken = usual.amount - cut.amount;
    const sheetPay = isUnsetPay(row.payRaw) ? 0 : parseMoney(row.payRaw);
    if (sheetPay === null) {
      out.differs++;
      continue;
    }
    if (sheetPay === cut.amount) {
      // A pay of nothing has an empty cell, which is what the cut gives where the airline takes all of the minimum.
      if (taken > 0) out.fills.push({ sourceKey: row.sourceKey, row: row.row, pilot: row.pilot, route: row.route, day: row.day, callsign: flight.callsign ?? '', pay: cut.amount, normal: usual.amount, deduction: taken, tier: fine.tier, fpm: fine.fpm });
      else out.uncut++;
    } else if (sheetPay === 0 && cut.amount > 0) out.unpaid++;
    else if (sheetPay === usual.amount) out.paidInFull++;
    else out.differs++;
  }
  out.fills.sort((a, b) => a.row - b.row);
  return { ...out, needFacts };
}

/** Why a panel cannot be checked, in words an admin can act on. */
export class ProfitError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ProfitError';
  }
}

/** What reading an airline's logbooks and sheet gives. */
interface Gathered {
  airlineId: number;
  businessId: number;
  /** How many aircraft logbooks were read (owned and leased), how many of those are leased, how many leased ones Aeroconomy would not show, and why the leased list could not be read. */
  aircraft: number;
  leased: number;
  leasedHidden: number;
  leasedProblem: string | null;
  flights: LogFlight[];
  sheet: SheetFlights;
  /** The airline's callsign code. */
  code: string;
}

export interface AirlineProfitsDeps {
  store: Store;
  /** Reads with the FsHub token (aircraft and logbooks). */
  account: Pick<AeroconomyAccountClient, 'aircraft' | 'ownedAircraft' | 'logbook'> & Partial<Pick<AeroconomyAccountClient, 'leasedAircraft'>>;
  /** Reads Aeroconomy's public pages: a pilot's aircraft, and (to find the business from the aircraft on its flights) the airline's contracts and their flights. */
  publicClient: Pick<AeroconomyClient, 'pilotAircraftOwner'> & Partial<Pick<AeroconomyClient, 'airlineContracts' | 'manifests'>>;
  /** Reads FsHub, for the distance of a flight that lost money (the pilot's pay for it depends on that). Without it, such pay is not worked out. */
  fshub?: Pick<FsHubApi, 'airlineFlights'>;
  /** Told about the flights a run left unfilled because their landing rate cannot be trusted (safety pay), so the airline's managers can be told. Its result is not waited for. */
  onHeld?: (panel: Panel, held: HeldFlight[]) => unknown;
  fetchFn?: typeof fetch;
  logger?: Logger;
  now?: () => number;
}

/** The aircraft types of an airline's fleet, as Aeroconomy lists its aircraft: how many of each it owns, and how many it leases. */
export interface FleetTypes {
  businessId: number;
  /** Each type's ICAO code (upper case) with the number of aircraft of it the airline owns and the number it leases. */
  types: Map<string, { owned: number; leased: number }>;
  /** Aircraft whose type Aeroconomy did not say (they are in no type above). */
  untyped: number;
  /** Why the list of leased aircraft could not be read (the owned ones were), or null. */
  problem: string | null;
}

export class AirlineProfits {
  private readonly now: () => number;
  private readonly log: Logger;

  constructor(private readonly d: AirlineProfitsDeps) {
    this.now = d.now ?? appNow;
    this.log = d.logger ?? silentLogger;
  }

  /**
   * The types of aircraft in the airline's fleet, from Aeroconomy: the aircraft the airline owns and the ones it leases (a leased aircraft flies its flights too, so its
   * type is the airline's as well). It reads the lists of aircraft only, never a logbook, so an aircraft whose logbook is hidden from the bot still counts. A list of
   * leased aircraft that cannot be read is no reason to stop: the owned ones are still given, and `problem` says what went wrong.
   */
  async fleetTypes(panel: Panel, business?: number): Promise<FleetTypes> {
    if (panel.fshubAirlineId === null) throw new ProfitError("This panel isn't linked to its airline's FsHub roster (`/setup fshub`), so I don't know which airline's aircraft to look at.");
    const airlineId = panel.fshubAirlineId;
    const businessId = await this.businessOf(panel, airlineId, business);
    const owned = await this.d.account.ownedAircraft(businessId);
    const { aircraft: leasedAll, problem } = await this.leasedFleet(businessId);
    const ownedSerials = new Set(owned.map((a) => a.serial));
    const leased = leasedAll.filter((a, i) => !ownedSerials.has(a.serial) && leasedAll.findIndex((b) => b.serial === a.serial) === i);
    // A business number an admin typed has to be the airline's own before it is trusted (and remembered, as `/setup profit` does).
    if (business !== undefined) {
      await this.checkOwner(owned, leased, airlineId);
      this.d.store.setKv(businessKey(airlineId), String(business));
    }
    const types = new Map<string, { owned: number; leased: number }>();
    let untyped = 0;
    const count = (list: AeroAircraft[], which: 'owned' | 'leased'): void => {
      for (const a of list) {
        const code = normalizeAircraft(a.type);
        if (code === null) {
          untyped++;
          continue;
        }
        const entry = types.get(code) ?? { owned: 0, leased: 0 };
        entry[which]++;
        types.set(code, entry);
      }
    };
    count(owned, 'owned');
    count(leased, 'leased');
    return { businessId, types, untyped, problem };
  }

  /** What both a profit check and a look for missing deductions start from: the airline's logbooks, and its sheet read as a schedule. */
  private async gather(panel: Panel, business: number | undefined): Promise<Gathered> {
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
    const tagged = (a: AeroAircraft, list: LogFlight[]): LogFlight[] => list.map((f) => ({ ...f, aircraftType: a.type }));
    for (const a of owned) flights.push(...tagged(a, await this.d.account.logbook(a.serial)));
    // A leased aircraft's logbook may not be this account's to see (it says so with a 403): that one is left out, and said so, rather than costing the rest.
    let leasedRead = 0;
    let leasedHidden = 0;
    for (const a of leased) {
      try {
        flights.push(...tagged(a, await this.d.account.logbook(a.serial)));
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

    const code = callsignCode(panel);
    return { airlineId, businessId, aircraft: owned.length + leasedRead, leased: leasedRead, leasedHidden, leasedProblem, flights, sheet, code };
  }

  /**
   * Read the airline's aircraft logbooks and its sheet, and compare. Reads only. `business` is the airline's Aeroconomy business number
   * when an admin gave it; otherwise it is remembered from an earlier time, or found from the aircraft some of the airline's pilots fly.
   */
  async analyse(panel: Panel, business?: number): Promise<ProfitAnalysis> {
    const { airlineId, businessId, aircraft, leased, leasedHidden, leasedProblem, flights, sheet, code } = await this.gather(panel, business);
    if (!sheet.hasProfit) throw new ProfitError("The sheet has no Profit Made column, so there is nothing to compare with or fill in.");
    // A flight that lost money pays the pilot by the distance, and with safety pay on a hard landing cuts the pay, so FsHub is asked about each
    // such flight: how far it was flown and how hard it landed. Only the ones whose Pilot Pay is empty need it: a pay that will not be written is
    // not worth a request.
    const wrotePay = this.d.store.payWrittenKeys(panel.id);
    const policy = this.d.store.safetyPolicy(panel);
    if (policy && !this.d.fshub) throw new ProfitError("Safety pay is on for this airline, and it needs FsHub's landing rate for each flight, but the bot has no FsHub token, so the pay cannot be worked out.");
    const first = compareProfits(sheet.flights, flights, code, new Map(), wrotePay, { policy, landing: new Map(), aircraft: new Map(), deductions: panel.safetyDeductions });
    const facts = await this.fshubFacts(airlineId, first.needFacts);
    const distances = new Map<number, number>();
    const landing = new Map<number, number | null>();
    const flownTypes = new Map<number, string | null>();
    for (const [id, f] of facts) {
      if (f.distanceNm !== null) distances.set(id, f.distanceNm);
      landing.set(id, f.landingRate);
      flownTypes.set(id, f.aircraftIcao ?? null);
    }
    const { needFacts: _needed, ...result } = compareProfits(sheet.flights, flights, code, distances, wrotePay, { policy, landing, aircraft: flownTypes, deductions: panel.safetyDeductions });
    this.log.info(`Compared ${result.matched} flights of ${panel.airlineName} with Aeroconomy's logbooks: ${result.agree} agree, ${result.fills.length} blank, ${result.different.length} differ`);
    const held = result.held ?? [];
    if (held.length > 0 && this.d.onHeld) {
      try {
        void Promise.resolve(this.d.onHeld(panel, held)).catch((e) => this.log.debug('Telling managers about held flights failed', e));
      } catch (e) {
        this.log.debug('Telling managers about held flights failed', e);
      }
    }
    return { business: businessId, aircraft, leased, leasedHidden, leasedProblem, readAt: this.now(), ...result };
  }

  /**
   * Look for the Safety Deductions missing from flights this airline's sheet already has filled in (see `compareDeductions`). Reads only. It needs the airline to
   * have switched deductions on and safety pay to be on, the sheet to have a Pilot Pay and a Safety Deductions column, and the bot to have FsHub's token.
   * At most `MAX_DEDUCTION_LOOKUPS` flights are asked about in a run; the others are counted as waiting, and a later run goes on with them.
   */
  async analyseDeductions(panel: Panel, business?: number): Promise<DeductionAnalysis> {
    const policy = this.d.store.safetyPolicy(panel);
    if (!policy) throw new ProfitError("Landing safety pay is off for this airline, so no pay has been cut for a hard landing and there are no deductions to write. (`/setup safety-pay mode:on` turns it on.)");
    if (!panel.safetyDeductions) throw new ProfitError("Deductions aren't switched on for this airline. `/setup safety-pay deductions:on` switches them on, and then this can add them for flights already filled in.");
    if (!this.d.fshub) throw new ProfitError("Working out what a hard landing took off needs FsHub's landing rate for each flight, but the bot has no FsHub token.");
    const { airlineId, businessId, aircraft, leased, leasedHidden, leasedProblem, flights, sheet, code } = await this.gather(panel, business);
    if (!sheet.hasPay) throw new ProfitError("The sheet has no Pilot Pay column, so there is no pay to record a deduction against.");
    if (!sheet.hasDeduction) throw new ProfitError("The sheet has no Safety Deductions column. Add one (headed **Safety Deductions**) and run this again; I never add columns.");
    const first = compareDeductions(sheet.flights, flights, code, new Map(), new Map(), policy);
    const facts = await this.fshubFacts(airlineId, first.needFacts, MAX_DEDUCTION_LOOKUPS);
    const distances = new Map<number, number>();
    const landing = new Map<number, number | null>();
    const flownTypes = new Map<number, string | null>();
    for (const [id, f] of facts) {
      if (f.distanceNm !== null) distances.set(id, f.distanceNm);
      landing.set(id, f.landingRate);
      flownTypes.set(id, f.aircraftIcao ?? null);
    }
    const { needFacts: _needed, ...result } = compareDeductions(sheet.flights, flights, code, distances, landing, policy, flownTypes);
    this.log.info(`Looked for missing safety deductions of ${panel.airlineName}: ${result.fills.length} to write, ${result.waiting} waiting for FsHub, ${result.differs} with a pay that is not what the cut gives`);
    return { business: businessId, aircraft, leased, leasedHidden, leasedProblem, readAt: this.now(), ...result };
  }

  /**
   * How far FsHub says each of these flights was flown, in nautical miles. A flight FsHub gave no distance for (or could not be asked
   * about) is simply absent from the answer. At most `MAX_DISTANCE_LOOKUPS` are asked, and asking stops if FsHub says it is busy.
   */
  private async fshubFacts(airlineId: number, flightIds: number[], max = MAX_DISTANCE_LOOKUPS): Promise<Map<number, FlightFacts>> {
    const fshub = this.d.fshub;
    return fshub ? fshubFlightFacts(fshub, airlineId, flightIds, max, this.log) : new Map<number, FlightFacts>();
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
