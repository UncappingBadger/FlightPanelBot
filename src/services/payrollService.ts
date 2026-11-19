import type { Panel, PayrollSettings, Store } from '../db/store.js';
import { ImportError } from '../jobs/import.js';
import { downloadSheetCsv, sheetRefOf, type SheetRef } from '../jobs/sheet.js';
import { silentLogger, type Logger } from '../util/log.js';
import { dayName, readSheetFlights, type SheetFlight, type SheetFlights } from './contributions.js';
import type { PaymentGateway } from './payGateway.js';
import { WriteBackError, type PaidTick, type PaidTickResult } from './writeback.js';
import type { FsHubApi } from '../fshub/client.js';
import { fshubDistances } from './fshubDistances.js';
import { buildPayLines, isAccount, isPayable, nameKey, readPilotInfo, rowStillAgrees, type BuildInput, type IdentityBook, type LedgerView, type PayDraft, type PayLine } from './payroll.js';

/**
 * Paying the pilots of one airline: making the list of what is due (reading the airline's sheet, and the tab that has the pilots' accounts),
 * and, once an admin has checked it, sending each payment through the `PaymentGateway`, with a ledger that sees to it that no payment is ever
 * made twice.
 */

const DAY = 86_400_000;
const HOUR = 3_600_000;
/** After a list could not be made (the sheet would not open), wait this long before trying again. */
const RETRY_AFTER_MS = 30 * 60_000;
/** A flight landed up to this long before its sheet day began, or this long after it (the same window the profit check uses). */
const EARLY_MS = 6 * HOUR;
const LATE_MS = 36 * HOUR;
/** The most FsHub lookups (one per flight that lost money) one list makes: FsHub's request budget is shared with the rest of the bot. */
const MAX_DISTANCE_LOOKUPS = 25;

/** Why a list could not be made or paid, in words an admin can act on. */
export class PayrollError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'PayrollError';
  }
}

/** What paying needs of the sheet writer: to know whether the panel's sheet may be written to, and to tick Pilot Paid boxes. */
export interface PaidTicker {
  enabledFor(panel: Pick<Panel, 'writeback' | 'sheetId'>): boolean;
  markPilotsPaid(panel: Panel, ticks: PaidTick[]): Promise<PaidTickResult>;
}

export interface PayrollDeps {
  store: Store;
  gateway: PaymentGateway;
  /** Ticks the Pilot Paid box of each flight that was paid. Without it (or where writing to the sheet is switched off) the boxes are left for a person to tick. */
  writeback?: PaidTicker | null;
  /** Reads FsHub, for the distance of a flight that lost money (its pay depends on that). Without it, such flights are flagged to be checked. */
  fshub?: Pick<FsHubApi, 'airlineFlights'> | null;
  fetchFn?: typeof fetch;
  now?: () => number;
  logger?: Logger;
}

/** What became of the Pilot Paid boxes of the flights that were paid. */
export interface TickOutcome {
  /** Sheet rows whose box was ticked just now, and rows whose box was already ticked. */
  done: number[];
  already: number[];
  /** Rows whose box was not ticked, and why, so a person can tick them. */
  left: Array<{ row: number; pilot: string; why: string }>;
}

const TICK_WHY: Record<PaidTickResult['skipped'][number]['reason'], string> = {
  gone: 'its row is no longer in the sheet',
  moved: 'its row is now another flight',
  changed: 'the pilot on the row changed',
  'not-completed': 'the row is no longer ticked as completed',
  filled: 'the Pilot Paid cell has something other than an empty box in it',
};

/** What happened to a list that was paid. */
export interface PayOutcome {
  /** False when there is no bank connection: nothing at all was tried. */
  connected: boolean;
  paid: PayLine[];
  /** The bank said no to these. Nothing was sent for them, and they come up on the next list. */
  failed: Array<{ line: PayLine; reason: string }>;
  /** Left unpaid because the sheet no longer agrees with the list. They come up again, as they now are, on the next list. */
  skipped: Array<{ line: PayLine; reason: 'gone' | 'changed' | 'not-completed' | 'already-paid' | 'already-sent' | 'no-account' }>;
  /** Sent, and then the bank gave no answer: nobody knows if the money moved, so it is not tried again until someone looks. */
  unconfirmed: PayLine[];
  /** Not tried, because an unconfirmed payment stopped the run. */
  held: PayLine[];
  /** The Pilot Paid boxes of the flights that were paid (and any paid earlier whose box was never ticked). */
  tick: TickOutcome;
}

export class Payroll {
  private readonly now: () => number;
  private readonly log: Logger;
  readonly gateway: PaymentGateway;

  constructor(private readonly d: PayrollDeps) {
    this.now = d.now ?? Date.now;
    this.log = d.logger ?? silentLogger;
    this.gateway = d.gateway;
  }

  /** Is this panel's daily list due (switched on, past its time today, and none made yet today)? */
  isDue(settings: PayrollSettings, now: number): boolean {
    if (!settings.enabled) return false;
    const today = Math.floor(now / DAY) * DAY;
    if (settings.lastRunDay !== null && settings.lastRunDay >= today) return false;
    if (now < today + settings.runAtMinute * 60_000) return false;
    const tried = Number(this.d.store.getKv(`payroll.try.${settings.panelId}`));
    return !(Number.isFinite(tried) && tried > 0 && now - tried < RETRY_AFTER_MS);
  }

  /** Note that a list could not be made just now, so it is not tried again for a while. */
  noteTried(panelId: number, now: number): void {
    this.d.store.setKv(`payroll.try.${panelId}`, String(now));
  }

  /** Note that today's list has been made (or there was nothing to make). */
  noteRan(panelId: number, now: number): void {
    this.d.store.savePayrollSettings(panelId, { lastRunDay: Math.floor(now / DAY) * DAY });
    this.d.store.deleteKv(`payroll.try.${panelId}`);
  }

  /* ------------------------------------------------------------------ the list */

  /** Read the sheets and make the list of what is due. Reads only. */
  async prepare(panel: Panel, settings: PayrollSettings): Promise<PayDraft> {
    const sourceAccount = settings.sourceAccount;
    if (!sourceAccount) throw new PayrollError('Say which account the pay comes out of first: `/payroll settings source-account:`.');
    if (!settings.infoSheetId || !settings.infoGid) throw new PayrollError('Say where the pilots\' accounts are first: `/payroll settings pilot-info:` takes the link of the Pilot Info tab.');
    const sheet = await this.schedule(panel);
    const infoCsv = await this.download({ id: settings.infoSheetId, gid: settings.infoGid }, 'the Pilot Info tab');
    const info = readPilotInfo(infoCsv);
    if (!info.ok) throw new PayrollError(`${info.reason}${info.headers.length > 0 ? ` The titles I can see are: ${info.headers.slice(0, 12).join(', ')}.` : ''}`);
    const input: BuildInput = {
      flights: sheet.flights,
      info: info.rows,
      startDay: settings.startDay,
      ledger: this.ledgerView(panel.id),
      identities: this.identities(panel.id),
      flightRef: (f) => this.d.store.getJobBySourceKey(panel.id, f.sourceKey)?.code ?? f.flightNumber,
    };
    let built = buildPayLines(input);
    // A flight that lost money is paid by the distance flown. The first pass names the ones whose distance is not known yet; FsHub is asked
    // about those, and the list is made again with what it said.
    const distances = await this.lossDistances(panel, sheet.flights, built.lines);
    if (distances.size > 0) built = buildPayLines({ ...input, distances });
    return { airline: panel.airlineName, made: this.now(), sourceAccount, lines: built.lines, waiting: built.waiting, unsettled: this.d.store.countUnsettledPayments(panel.id) };
  }

  /**
   * The distance FsHub recorded for each flight on the list that lost money and has none yet, by the flight's key in the sheet. The FsHub flight is
   * the one the pilot flew on that route that landed in the row's day (the bot keeps the airline's flights for a week); if there is not exactly
   * one such flight, or two rows would be the same flight, or FsHub gives no distance, the flight is left out and stays flagged: a distance is
   * never guessed. Never throws.
   */
  private async lossDistances(panel: Panel, flights: SheetFlight[], lines: PayLine[]): Promise<Map<string, number>> {
    const out = new Map<string, number>();
    const fshub = this.d.fshub;
    const airlineId = panel.fshubAirlineId;
    const needing = lines.filter((l) => l.flags.includes('no-distance'));
    if (!fshub || airlineId === null || needing.length === 0) return out;
    try {
      const byKey = new Map(flights.map((f) => [f.sourceKey, f]));
      const picks: Array<{ sourceKey: string; flightId: number }> = [];
      for (const line of needing) {
        const f = byKey.get(line.sourceKey);
        if (!f || f.route.split('→').length !== 2) continue; // several legs are not one FsHub flight
        const same = this.d.store
          .listFshubFlights(panel.id, line.dep, line.arr, f.day - EARLY_MS, f.day + LATE_MS)
          .filter((c) => (line.fshubId !== null ? c.pilotId === line.fshubId : c.pilotName !== null && nameKey(c.pilotName) === nameKey(f.pilot)));
        if (same.length === 1) picks.push({ sourceKey: line.sourceKey, flightId: (same[0] as { flightId: number }).flightId });
      }
      const claims = new Map<number, number>();
      for (const p of picks) claims.set(p.flightId, (claims.get(p.flightId) ?? 0) + 1);
      const sole = picks.filter((p) => claims.get(p.flightId) === 1);
      const found = await fshubDistances(fshub, airlineId, sole.map((p) => p.flightId), MAX_DISTANCE_LOOKUPS, this.log);
      for (const p of sole) {
        const nm = found.get(p.flightId);
        if (nm !== undefined) out.set(p.sourceKey, nm);
      }
    } catch (e) {
      this.log.warn('Looking up the distances of flights that lost money failed', e);
    }
    return out;
  }

  private async download(ref: SheetRef, what: string): Promise<string> {
    try {
      return await downloadSheetCsv(ref, this.d.fetchFn ?? fetch);
    } catch (e) {
      if (e instanceof ImportError) throw new PayrollError(`I couldn't read ${what}: ${e.message}`);
      throw e;
    }
  }

  private async schedule(panel: Panel): Promise<SheetFlights> {
    const ref = sheetRefOf(panel);
    if (!ref) throw new PayrollError("This panel doesn't read a Google Sheet, so there is no schedule to pay from.");
    const sheet = readSheetFlights(await this.download(ref, "the airline's schedule"));
    if (!sheet) throw new PayrollError("I couldn't read the schedule sheet (it needs Route, Date, Pilot and Flight Completed columns).");
    if (!sheet.hasPay) throw new PayrollError('The schedule sheet has no Pilot Pay column, so there is nothing to pay from.');
    return sheet;
  }

  private ledgerView(panelId: number): LedgerView {
    const store = this.d.store;
    return {
      isTaken: (key, pilot) => {
        const e = store.ledgerBySourceKey(panelId, key);
        return e !== null && e.status !== 'failed' && nameKey(e.pilot) === nameKey(pilot);
      },
      hasUniqueId: (id) => store.ledgerByUniqueId(panelId, id) !== null,
      failedIdFor: (key, pilot) => {
        const e = store.ledgerBySourceKey(panelId, key);
        return e !== null && e.status === 'failed' && nameKey(e.pilot) === nameKey(pilot) ? e.uniqueId : null;
      },
      lastAccount: (fshubId) => store.lastPaidAccount(panelId, fshubId),
    };
  }

  private identities(panelId: number): IdentityBook {
    const store = this.d.store;
    return {
      idsForName: (name) => store.fshubIdsForSheetName(name),
      namesForId: (id) => store.fshubNamesForId(panelId, id),
      knowsId: (id) => store.knowsFshubId(panelId, id),
    };
  }

  /** Is a unique ID already in the ledger (for the amend form: a used one cannot be typed in)? */
  uniqueIdTaken(panelId: number, uniqueId: string): boolean {
    return this.d.store.ledgerByUniqueId(panelId, uniqueId) !== null;
  }

  /* ------------------------------------------------------------------ paying */

  /**
   * Pay a checked list. Nothing is sent if there is no bank connection. Otherwise the sheet is read again first, and a payment whose flight no
   * longer agrees with the list (the row is gone, the box was ticked, the pilot or the amount changed) is left out; then each payment is
   * written in the ledger before it is sent and settled after, one at a time. A payment whose answer never came stops the run.
   */
  async pay(panel: Panel, settings: PayrollSettings, lines: PayLine[]): Promise<PayOutcome> {
    const outcome: PayOutcome = { connected: this.gateway.connected, paid: [], failed: [], skipped: [], unconfirmed: [], held: [], tick: { done: [], already: [], left: [] } };
    if (!this.gateway.connected) return outcome;
    const source = settings.sourceAccount;
    if (!source || !isAccount(source)) throw new PayrollError('Say which account the pay comes out of first: `/payroll settings source-account:`.');
    const ready = lines.filter(isPayable);
    if (ready.length === 0) return outcome;

    const sheet = await this.schedule(panel); // if this fails, nothing has been sent
    const byKey = new Map<string, SheetFlight>(sheet.flights.map((f) => [f.sourceKey, f]));
    const toSend: PayLine[] = [];
    for (const line of ready) {
      const f = byKey.get(line.sourceKey);
      const skip = (reason: PayOutcome['skipped'][number]['reason']) => void outcome.skipped.push({ line, reason });
      if (!f) skip('gone');
      else if (!f.completed) skip('not-completed');
      else if (f.pilotPaid === true) skip('already-paid');
      else if (nameKey(f.pilot) !== nameKey(line.pilot)) skip('changed');
      else if (!line.amended && !rowStillAgrees(line, f)) skip('changed');
      else if (!line.account) skip('no-account');
      else toSend.push(line);
    }

    for (let i = 0; i < toSend.length; i++) {
      const line = toSend[i] as PayLine;
      const at = this.now();
      if (!this.d.store.ledgerBegin(panel.id, { uniqueId: line.uniqueId, sourceKey: line.sourceKey, pilot: line.pilot, fshubId: line.fshubId, account: line.account as string, cents: line.cents }, at)) {
        outcome.skipped.push({ line, reason: 'already-sent' });
        continue;
      }
      try {
        const result = await this.gateway.pay({
          sourceAccount: source,
          recipientAccount: line.account as string,
          uniqueId: line.uniqueId,
          cents: line.cents,
          description: `${panel.airlineName} pilot pay, ${line.dep} to ${line.arr}, ${dayName(line.day)}`,
        });
        if (result.ok) {
          this.d.store.ledgerFinish(panel.id, line.uniqueId, 'paid', result.reference, this.now());
          outcome.paid.push(line);
        } else {
          this.d.store.ledgerFinish(panel.id, line.uniqueId, 'failed', result.reason.slice(0, 300), this.now());
          outcome.failed.push({ line, reason: result.reason });
        }
      } catch (e) {
        // The answer never came, so nobody knows whether the money moved. It stays marked as being sent, and nothing more is sent behind it.
        this.log.error(`Payment ${line.uniqueId}: no answer from the bank, so it is left unsettled`, e);
        outcome.unconfirmed.push(line);
        outcome.held.push(...(toSend.slice(i + 1) as PayLine[]));
        break;
      }
    }
    // The box is ticked for what was paid just now, and for any flight paid earlier whose box is still empty (a tick that could not be done then).
    const paidNow = new Set(outcome.paid.map((l) => l.sourceKey));
    const ticks: PaidTick[] = outcome.paid.map((l) => ({ sourceKey: l.sourceKey, row: l.row, pilot: l.pilot }));
    for (const f of sheet.flights) {
      if (!f.completed || f.pilotPaid !== false || paidNow.has(f.sourceKey)) continue;
      const earlier = this.d.store.ledgerBySourceKey(panel.id, f.sourceKey);
      if (earlier !== null && earlier.status === 'paid' && nameKey(earlier.pilot) === nameKey(f.pilot)) ticks.push({ sourceKey: f.sourceKey, row: f.row, pilot: f.pilot });
    }
    outcome.tick = await this.tickPaid(panel, ticks);
    this.log.info(`Paid ${outcome.paid.length} pilot payment(s) for ${panel.airlineName}: ${outcome.failed.length} refused, ${outcome.skipped.length} left out, ${outcome.unconfirmed.length} unconfirmed`);
    return outcome;
  }

  /**
   * Tick the Pilot Paid box of each of these flights. The payments are already made and written in the ledger, which is what keeps them from
   * being made again, so a box that cannot be ticked (writing to the sheet is off, Google refuses, the row changed) is only reported, with the
   * row, for a person to tick. This never throws.
   */
  private async tickPaid(panel: Panel, ticks: PaidTick[]): Promise<TickOutcome> {
    const out: TickOutcome = { done: [], already: [], left: [] };
    if (ticks.length === 0) return out;
    const rowOf = new Map(ticks.map((t) => [t.sourceKey, t]));
    const leaveAll = (why: string) => void out.left.push(...ticks.map((t) => ({ row: t.row, pilot: t.pilot, why })));
    const writer = this.d.writeback;
    if (!writer || !writer.enabledFor(panel)) {
      leaveAll("writing to the sheet isn't switched on for this panel");
      return out;
    }
    try {
      const got = await writer.markPilotsPaid(panel, ticks);
      for (const t of got.ticked) out.done.push((rowOf.get(t.sourceKey) as PaidTick).row);
      for (const key of got.already) out.already.push((rowOf.get(key) as PaidTick).row);
      for (const s of got.skipped) {
        const t = rowOf.get(s.sourceKey) as PaidTick;
        out.left.push({ row: t.row, pilot: t.pilot, why: TICK_WHY[s.reason] });
      }
    } catch (e) {
      if (!(e instanceof WriteBackError)) this.log.warn('Ticking the Pilot Paid boxes failed', e);
      leaveAll(e instanceof WriteBackError ? e.message : 'something went wrong, it is in my log');
    }
    return out;
  }
}
