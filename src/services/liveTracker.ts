import type { Panel, Store } from '../db/store.js';
import { isFlying, type AirlineFlight, type LiveFeed, type LivePilot } from '../fshub/liveFeed.js';
import { silentLogger, type Logger } from '../util/log.js';
import { trustedFshubId, type AutoCompleteResult, type AutoCompleteScope } from './autoComplete.js';
import { callsignCode } from './flightEtas.js';
import { appNow } from '../util/clock.js';

/** Where a pilot is, as far as FsHub's live feed says. */
export type LiveState = 'offline' | 'ground' | 'airborne';

export interface LiveStatus {
  state: LiveState;
  phase: string | null;
  /** The flight plan's airports, when the pilot filed one. */
  dep: string | null;
  arr: string | null;
  flightId: string | null;
  checkedAt: number;
}

/** A status older than this is not trusted (the feed could not be read, or the tracker has not run). */
export const LIVE_STALE_MS = 3 * 60_000;
/** The feed is asked at most this often. */
const POLL_MS = 45_000;
/** After a pilot lands, FsHub's record of the flight is looked for this often... */
const RETRY_MS = 60_000;
/** ...for this long, after which the hourly check is left to find it. */
const PENDING_MAX_MS = 12 * 60_000;
/** A landing check reads FsHub's flights unless they were read this recently. */
const FRESH_FLIGHTS_MS = 45_000;

/** A pilot as their airline's list of flights shows them: in the air when any flight of theirs is, otherwise on the ground at what they last flew. */
function pilotOf(pilotId: number, flights: AirlineFlight[]): LivePilot {
  const f = flights.find((x) => isFlying(x.phase, x.onGround)) ?? (flights[0] as AirlineFlight);
  return { pilotId, airborne: isFlying(f.phase, f.onGround), flight: { flightId: f.flightId, phase: f.phase, onGround: f.onGround, dep: f.dep, arr: f.arr } };
}

interface Pending {
  panelId: number;
  discordId: string;
  since: number;
  lastTry: number | null;
}

export interface LiveTrackerDeps {
  store: Store;
  /**
   * `airlineFlights`, when the feed has it, is read first: an airline's flights name their pilots, so most pilots' state comes from the one list
   * the landing estimates read too, instead of a request for each of them.
   */
  feed: Pick<LiveFeed, 'onlinePilotIds' | 'pilot'> & Partial<Pick<LiveFeed, 'airlineFlights'>>;
  /** Completes the flights FsHub shows these pilots flew; null when the bot has no FsHub token (it can still tell who is flying). */
  complete: ((panel: Panel, scope: AutoCompleteScope) => Promise<AutoCompleteResult>) | null;
  logger?: Logger;
  now?: () => number;
}

/**
 * Follows the pilots who hold flights, using FsHub's public live feed, for two things:
 *
 * - `statusOf` says whether a pilot is in the air now, so a late-departure warning is not sent to someone already flying it.
 * - When a pilot who was in the air is no longer (landed, or the flight ended), the flights they hold are checked against FsHub's own
 *   record straight away and again every minute for a while, instead of waiting for the hourly check. The feed is only a nudge to
 *   look: a flight is completed only when FsHub itself shows it flown, by the same strict rules as the Complete button.
 *
 * It keeps nothing on disk. After a restart it learns who is flying afresh, and anything it missed is found by the hourly check.
 */
export class LiveTracker {
  private readonly now: () => number;
  private readonly log: Logger;
  private readonly status = new Map<number, LiveStatus>();
  private readonly pending = new Map<string, Pending>();
  private lastPollAt: number | null = null;

  constructor(private readonly d: LiveTrackerDeps) {
    this.now = d.now ?? appNow;
    this.log = d.logger ?? silentLogger;
  }

  /** Where this pilot is, or null when it is not known (not followed, or the feed has not been readable lately). */
  statusOf(discordId: string): LiveStatus | null {
    const fshubId = trustedFshubId(this.d.store, discordId);
    if (fshubId === null) return null;
    const s = this.status.get(fshubId);
    return s && this.now() - s.checkedAt <= LIVE_STALE_MS ? s : null;
  }

  /** Landed pilots whose flights are still being looked for in FsHub (for tests). */
  get waiting(): number {
    return this.pending.size;
  }

  /** One pass: ask the feed if it is due, then look again for the flights of pilots who have landed. */
  async run(): Promise<void> {
    const now = this.now();
    if (this.lastPollAt === null || now - this.lastPollAt >= POLL_MS) {
      this.lastPollAt = now;
      await this.poll(now);
    }
    await this.checkLanded(now);
  }

  /** Every pilot who holds a leg of a flight not yet completed, on panels that follow flights live: FsHub ID to who and where. */
  private tracked(now: number): Map<number, Array<{ panel: Panel; discordId: string }>> {
    const out = new Map<number, Array<{ panel: Panel; discordId: string }>>();
    for (const panel of this.d.store.listAllPanels()) {
      if (!panel.liveTracking) continue;
      const seen = new Set<string>();
      const follow = (who: string | undefined): void => {
        if (!who || seen.has(who)) return;
        seen.add(who);
        const fshubId = trustedFshubId(this.d.store, who);
        if (fshubId === null) return;
        out.set(fshubId, [...(out.get(fshubId) ?? []), { panel, discordId: who }]);
      };
      for (const view of this.d.store.listAllHeldJobViews(panel.id, now - 2 * 86_400_000)) for (const leg of view.legs) follow(leg.holder?.discordId);
      // A backup pilot may fly the flight in place of the pilot who holds it, so they are followed too.
      for (const view of this.d.store.listBackedJobViews(panel.id, now - 2 * 86_400_000)) follow(view.backup?.discordId);
    }
    return out;
  }

  /**
   * The flights of the tracked pilots in their airlines' own feeds: one request for each airline (which the landing estimates share, see
   * `LiveFeed.airlineFlights`), however many pilots there are. A pilot who is not in one (not a pilot of that airline, or the feed could not be read)
   * is simply not here, and is looked for the other way.
   */
  private async fromAirlines(tracked: Map<number, Array<{ panel: Panel }>>): Promise<Map<number, AirlineFlight[]>> {
    const out = new Map<number, AirlineFlight[]>();
    const read = this.d.feed.airlineFlights;
    if (typeof read !== 'function') return out;
    const codes = new Set<string>();
    for (const users of tracked.values()) for (const { panel } of users) if (callsignCode(panel)) codes.add(callsignCode(panel));
    for (const code of codes) {
      let flights: AirlineFlight[];
      try {
        flights = await read.call(this.d.feed, code);
      } catch (e) {
        this.log.debug(`Live feed (${code}): ${e instanceof Error ? e.message : e}`);
        continue;
      }
      for (const f of flights) if (f.pilotId !== null && tracked.has(f.pilotId)) out.set(f.pilotId, [...(out.get(f.pilotId) ?? []), f]);
    }
    return out;
  }

  private async poll(now: number): Promise<void> {
    const tracked = this.tracked(now);
    if (tracked.size === 0) {
      this.status.clear();
      return;
    }
    const listed = await this.fromAirlines(tracked);
    // Who is online, and each such pilot's flight, are only asked for the pilots no airline's list had.
    let online: Set<number> | null = null;
    if ([...tracked.keys()].some((id) => !listed.has(id))) {
      try {
        online = await this.d.feed.onlinePilotIds();
      } catch (e) {
        this.log.debug(`Live feed: ${e instanceof Error ? e.message : e}`);
        // What is not known about the rest goes stale by itself; the pilots the airlines' lists had are still looked at.
      }
    }
    for (const [fshubId, users] of tracked) {
      let live: LivePilot | null = null;
      const flights = listed.get(fshubId);
      if (flights) {
        live = pilotOf(fshubId, flights);
      } else if (online === null) {
        continue; // could not be asked
      } else if (online.has(fshubId)) {
        try {
          live = await this.d.feed.pilot(fshubId);
        } catch (e) {
          this.log.debug(`Live feed: ${e instanceof Error ? e.message : e}`);
          continue;
        }
      }
      const next: LiveStatus = {
        state: live === null ? 'offline' : live.airborne ? 'airborne' : 'ground',
        phase: live?.flight?.phase ?? null,
        dep: live?.flight?.dep ?? null,
        arr: live?.flight?.arr ?? null,
        flightId: live?.flight?.flightId ?? null,
        checkedAt: now,
      };
      const prev = this.status.get(fshubId);
      this.status.set(fshubId, next);
      if (prev?.state === 'airborne' && next.state !== 'airborne') this.landed(users, now);
    }
    // Pilots no longer holding anything are forgotten.
    for (const id of [...this.status.keys()]) if (!tracked.has(id)) this.status.delete(id);
  }

  private landed(users: Array<{ panel: Panel; discordId: string }>, now: number): void {
    for (const { panel, discordId } of users) {
      if (!this.d.complete || !panel.fshubAutoComplete || !panel.fshubConfirm || panel.fshubAirlineId === null) continue;
      this.pending.set(`${panel.id}:${discordId}`, { panelId: panel.id, discordId, since: now, lastTry: null });
      this.log.info(`A pilot on ${panel.airlineName} has landed; looking for their flight in FsHub`);
    }
  }

  /** For each pilot who has landed: have FsHub's record read and complete what it shows flown, until it does or the time is up. */
  private async checkLanded(now: number): Promise<void> {
    if (!this.d.complete) return;
    const byPanel = new Map<number, Array<[string, Pending]>>();
    for (const [key, p] of this.pending) {
      if (now - p.since > PENDING_MAX_MS) {
        this.pending.delete(key);
        continue;
      }
      if (p.lastTry !== null && now - p.lastTry < RETRY_MS) continue;
      byPanel.set(p.panelId, [...(byPanel.get(p.panelId) ?? []), [key, p]]);
    }
    for (const [panelId, list] of byPanel) {
      const panel = this.d.store.getPanel(panelId);
      if (!panel || !panel.liveTracking || !panel.fshubAutoComplete) {
        for (const [key] of list) this.pending.delete(key);
        continue;
      }
      for (const [, p] of list) p.lastTry = now;
      let result: AutoCompleteResult;
      try {
        result = await this.d.complete(panel, { only: new Set(list.map(([, p]) => p.discordId)), maxAgeMs: FRESH_FLIGHTS_MS });
      } catch (e) {
        this.log.warn(`Checking FsHub after a landing failed: ${e instanceof Error ? e.message : e}`);
        continue;
      }
      if (!result.ok) continue; // FsHub could not be read: try again next minute
      const done = new Set(result.completed.map((c) => c.discordId));
      for (const [key, p] of list) {
        if (done.has(p.discordId)) this.pending.delete(key);
      }
      // Nothing of theirs that could be completed (they held nothing that qualifies): stop looking.
      if (result.checked === 0) for (const [key] of list) this.pending.delete(key);
    }
  }
}
