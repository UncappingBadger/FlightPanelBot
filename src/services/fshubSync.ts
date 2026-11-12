import { FsHubError, type FsHubApi } from '../fshub/client.js';
import type { FlownFlight, JobView, Panel, RosterLink, Store } from '../db/store.js';
import { silentLogger, type Logger } from '../util/log.js';
import { confirmationsFor, confirmationsSignature } from './flightMatch.js';

/** How often a linked airline's roster is read. Pilots rarely change, so once an hour is plenty. */
export const FSHUB_SYNC_MS = 60 * 60_000;
/** After a failure that may pass by itself (FsHub down, or busy), try again sooner than the next hour. */
const RETRY_MS = 10 * 60_000;

/** How often a linked airline's new flights are read. A flight shows on FsHub about 40 seconds after landing. */
export const FLIGHT_SYNC_MS = 5 * 60_000;
const HOUR = 3_600_000;
const DAY = 24 * HOUR;
/** Flights that landed longer ago than this are forgotten. */
export const FLIGHT_KEEP_MS = 7 * DAY;
/** The first read goes back this far. */
const FIRST_READ_BACK_MS = 7 * DAY;
/**
 * FsHub numbers a flight when it starts, but only lists it once it has landed, so a long flight can appear after
 * a shorter one that started later and has a higher number. Reading therefore always starts this far back from
 * the present rather than from the last flight seen.
 */
export const RESCAN_MS = 26 * HOUR;
const PAGE = 100;
/** One pass reads at most this many pages; if there is more it carries on at the next pass. */
const MAX_PAGES_PER_PASS = 10;
/** FsHub flight IDs run in the millions: the search for where to start brackets the answer from here, doubling. */
const SEARCH_FIRST_ID = 1_000_000;
const SEARCH_PRECISION = 2_000;
const MAX_SEARCH_STEPS = 40;

export interface RosterSyncResult {
  ok: boolean;
  /** Why it did not work, in words an admin can act on; null when it did. */
  note: string | null;
  /** Pilots on the roster. */
  rosterSize: number;
  /** Of those, how many have told FsHub their Discord account. */
  withDiscord: number;
  /** How many people's saved details were added or changed by this read. */
  changed: number;
}

export interface FlightSyncResult {
  ok: boolean;
  note: string | null;
  /** Flights newly kept by this read. */
  added: number;
  /** Flights kept altogether now. */
  kept: number;
}

/**
 * Reads each linked airline's FsHub roster and saves who is who: a pilot whose FsHub profile names their
 * Discord account is known to the bot without being asked for their pilot ID. An ID a pilot typed
 * themselves is never replaced. Panels showing someone whose details changed are redrawn.
 *
 * It also reads the airline's recent flights, so a completed flight on the panel can show the aircraft that was
 * flown and that FsHub saw it landed. Those are kept for a few days and matched by `flightMatch`.
 */
export class FsHubSync {
  /** What each panel last showed as confirmed, so it is only redrawn when that changes. */
  private readonly shown = new Map<number, string>();
  /** Flight reads in progress, by panel. */
  private readonly flightsRunning = new Map<number, Promise<FlightSyncResult>>();

  constructor(
    private readonly store: Store,
    private readonly api: Pick<FsHubApi, 'roster' | 'airlineFlights'>,
    private readonly panels: { schedule(panelId: number): void },
    private readonly opts: { logger?: Logger; now?: () => number; completed?: (panelId: number) => JobView[] } = {},
  ) {}

  private get now(): number {
    return (this.opts.now ?? Date.now)();
  }

  private get log(): Logger {
    return this.opts.logger ?? silentLogger;
  }

  /* ------------------------------------------------------------------ the roster */

  /** Read one panel's airline roster now. Never throws: the outcome is in the result, and noted on the panel. */
  async syncPanel(panel: Panel): Promise<RosterSyncResult> {
    const airlineId = panel.fshubAirlineId;
    if (airlineId === null) return { ok: false, note: 'This panel is not linked to a FsHub airline.', rosterSize: 0, withDiscord: 0, changed: 0 };
    const now = this.now;
    try {
      const roster = await this.api.roster(airlineId);
      const links: RosterLink[] = roster.flatMap((p) => (p.discordId ? [{ discordId: p.discordId, fshubId: p.id, name: p.name }] : []));
      const changed = this.store.applyRosterLinks(links, now);

      // Anyone who holds a flight and whose name or ID just changed is shown differently on the panel.
      const redraw = new Set<number>();
      for (const discordId of changed) for (const panelId of this.store.listPanelIdsHeldBy(discordId)) redraw.add(panelId);
      for (const panelId of redraw) this.panels.schedule(panelId);

      this.store.updatePanel(panel.id, { fshubSyncedAt: now, fshubNote: null });
      this.log.debug(`FsHub roster for panel ${panel.id}: ${roster.length} pilots, ${links.length} with a Discord account, ${changed.length} changed`);
      return { ok: true, note: null, rosterSize: roster.length, withDiscord: links.length, changed: changed.length };
    } catch (e) {
      const known = e instanceof FsHubError;
      const note = known ? e.message : 'I could not read the FsHub roster (the reason is in my log).';
      if (!known) this.log.error(`FsHub roster for panel ${panel.id} failed`, e);
      else this.log.warn(`FsHub roster for panel ${panel.id}: ${e.message}`);
      const transient = known && (e.kind === 'unavailable' || e.kind === 'rate-limited');
      this.store.updatePanel(panel.id, { fshubSyncedAt: transient ? now - (FSHUB_SYNC_MS - RETRY_MS) : now, fshubNote: note });
      return { ok: false, note, rosterSize: 0, withDiscord: 0, changed: 0 };
    }
  }

  /* ------------------------------------------------------------------ the airline's flights */

  /**
   * Read the airline's new flights now (and, the first time, the last week's). Never throws: the outcome is in the
   * result, and noted on the panel. Reads at most a few pages; if there are more it says so by leaving the panel
   * due for the next pass.
   */
  syncFlights(panel: Panel): Promise<FlightSyncResult> {
    // Two reads of one panel never run at once (the scheduler and a pilot pressing Complete can coincide): the second waits for the first.
    const running = this.flightsRunning.get(panel.id);
    if (running) return running;
    const read = this.readFlights(panel).finally(() => this.flightsRunning.delete(panel.id));
    this.flightsRunning.set(panel.id, read);
    return read;
  }

  /**
   * Make sure the panel's flights are no more than `maxAgeMs` old, reading them now if they are older (or the last
   * read failed). Returns the read's result, or null if what is kept was fresh enough already. Used when a pilot
   * presses Complete, so a flight that landed a minute ago is there without waiting for the next scheduled read.
   */
  refreshFlights(panel: Panel, maxAgeMs: number): Promise<FlightSyncResult | null> {
    const current = this.store.getPanel(panel.id) ?? panel;
    const running = this.flightsRunning.get(current.id);
    if (running) return running;
    const age = current.fshubFlightsAt === null ? Infinity : this.now - current.fshubFlightsAt;
    if (current.fshubFlightsNote === null && age < maxAgeMs) return Promise.resolve(null);
    return this.syncFlights(current);
  }

  private async readFlights(panel: Panel): Promise<FlightSyncResult> {
    const airlineId = panel.fshubAirlineId;
    if (airlineId === null) return { ok: false, note: 'This panel is not linked to a FsHub airline.', added: 0, kept: 0 };
    if (!panel.fshubConfirm) return { ok: false, note: 'Reading flights is switched off for this panel.', added: 0, kept: this.store.countFshubFlights(panel.id) };
    const now = this.now;
    try {
      let cursor = panel.fshubFlightCursor;
      // Where to resume next time: never behind where this read starts, and never past anything that could still turn up.
      let resume = cursor;
      if (cursor === 0) {
        cursor = await this.findStart(airlineId, now - FIRST_READ_BACK_MS);
        resume = cursor;
      }
      const safeBefore = now - RESCAN_MS;
      const keepFrom = now - FLIGHT_KEEP_MS;
      let added = 0;
      let more = false;
      for (let pass = 0; pass < MAX_PAGES_PER_PASS; pass++) {
        const page = await this.api.airlineFlights(airlineId, cursor, PAGE);
        if (page.count === 0 || page.lastId === null) break;
        const rows: FlownFlight[] = page.flights
          .filter((f) => f.arrivedAt >= keepFrom && f.arrivedAt <= now + HOUR)
          .map((f) => ({
            flightId: f.id,
            pilotId: f.pilotId,
            pilotName: f.pilotName,
            dep: f.dep,
            arr: f.arr,
            departedAt: f.departedAt,
            arrivedAt: f.arrivedAt,
            aircraftIcao: f.aircraftIcao,
            aircraftName: f.aircraftName,
            scheduleStatus: f.scheduleStatus,
          }));
        added += this.store.upsertFshubFlights(panel.id, rows);

        // A page that is wholly old can never gain a flight, so reading can resume after it; on a recent page, after the old part.
        if (page.lastAt !== null && page.lastAt <= safeBefore) resume = Math.max(resume, page.lastId);
        else for (const f of page.flights) if ((f.departedAt ?? f.arrivedAt) <= safeBefore) resume = Math.max(resume, f.id);

        if (page.lastId <= cursor) break; // not moving on: stop rather than loop
        cursor = page.lastId;
        if (page.count < PAGE) break;
        if (pass === MAX_PAGES_PER_PASS - 1) more = true;
      }
      this.store.pruneFshubFlights(panel.id, keepFrom);
      this.store.updatePanel(panel.id, { fshubFlightCursor: resume, fshubFlightsAt: more ? now - FLIGHT_SYNC_MS : now, fshubFlightsNote: null });
      const kept = this.store.countFshubFlights(panel.id);
      this.log.debug(`FsHub flights for panel ${panel.id}: ${added} new, ${kept} kept${more ? ', more to read' : ''}`);
      this.redrawIfChanged(panel.id);
      return { ok: true, note: null, added, kept };
    } catch (e) {
      const known = e instanceof FsHubError;
      const note = known ? e.message : 'I could not read the FsHub flights (the reason is in my log).';
      if (!known) this.log.error(`FsHub flights for panel ${panel.id} failed`, e);
      else this.log.warn(`FsHub flights for panel ${panel.id}: ${e.message}`);
      this.store.updatePanel(panel.id, { fshubFlightsAt: now, fshubFlightsNote: note });
      return { ok: false, note, added: 0, kept: this.store.countFshubFlights(panel.id) };
    }
  }

  /**
   * Where to start reading so that the first flight returned landed just before `cutoff`. FsHub lists an airline's
   * flights oldest first, and `cursor` means "flights numbered above this", which grow with time, so the place to
   * start can be found by searching rather than by reading years of flights. Returns 0 (read from the beginning)
   * when even the airline's first flight is recent.
   */
  private async findStart(airlineId: number, cutoff: number): Promise<number> {
    let steps = 0;
    const isOld = async (cursor: number): Promise<boolean | null> => {
      if (++steps > MAX_SEARCH_STEPS) throw new FsHubError('unavailable', "I couldn't find where the airline's recent flights start.");
      const page = await this.api.airlineFlights(airlineId, cursor, 1);
      if (page.count === 0) return null; // nothing after this number
      return page.firstAt !== null && page.firstAt < cutoff;
    };

    if ((await isOld(0)) !== true) return 0;
    // Bracket the answer by doubling, then halve the bracket until it is narrow.
    let lo = 0;
    let hi = SEARCH_FIRST_ID;
    while ((await isOld(hi)) === true) {
      lo = hi;
      hi *= 2;
    }
    while (hi - lo > SEARCH_PRECISION) {
      const mid = Math.floor((lo + hi) / 2);
      if ((await isOld(mid)) === true) lo = mid;
      else hi = mid;
    }
    return lo;
  }

  /** Redraw the panel if what it would show as confirmed is not what it last showed. */
  private redrawIfChanged(panelId: number): void {
    if (!this.opts.completed) return;
    const panel = this.store.getPanel(panelId);
    if (!panel) return;
    const signature = confirmationsSignature(confirmationsFor(this.store, panel, this.opts.completed(panelId), this.now));
    if (signature === (this.shown.get(panelId) ?? '')) return;
    this.shown.set(panelId, signature);
    this.panels.schedule(panelId);
  }

  /* ------------------------------------------------------------------ the scheduler's pass */

  /** Read every linked panel's roster and flights that are due. Called by the scheduler. */
  async run(): Promise<void> {
    for (const listed of this.store.listFshubPanels()) {
      let panel: Panel = listed;
      const now = this.now;
      if (panel.fshubSyncedAt === null || now - panel.fshubSyncedAt >= FSHUB_SYNC_MS) {
        const roster = await this.syncPanel(panel);
        // A token that can't see the roster can't see the flights either: no point asking again this pass.
        if (!roster.ok) continue;
        panel = this.store.getPanel(panel.id) ?? panel;
      }
      if (panel.fshubConfirm && (panel.fshubFlightsAt === null || this.now - panel.fshubFlightsAt >= FLIGHT_SYNC_MS)) {
        await this.syncFlights(panel);
      }
    }
  }
}
