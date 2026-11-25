import { AeroconomyError } from '../aeroconomy/http.js';
import type { Panel, Store } from '../db/store.js';
import { ProfitError, type AirlineProfits } from './airlineProfits.js';
import { normalizeAircraft, type SafetyLimits } from './safetyPay.js';

/** What the landing limits need from the bot: its database, Aeroconomy's account reader (none without a FsHub token) and the clock. */
export interface LimitsDeps {
  store: Store;
  profits: Pick<AirlineProfits, 'fleetTypes'> | null;
  now: () => number;
}

/** One type of aircraft the airline flies. */
export interface FleetEntry {
  code: string;
  /** How many of it the airline owns and how many it leases, as Aeroconomy lists them (0 and 0 for a type only seen in flights, or that has limits of its own already). */
  owned: number;
  leased: number;
  /** Whether a recent flight of the airline was flown in it. */
  flown: boolean;
}

/** What was read of the fleet, kept for a while so the next look does not ask Aeroconomy again. */
export interface FleetRead {
  at: number;
  entries: FleetEntry[];
  /** Why the fleet could not be read from Aeroconomy (the types seen in flights are still listed), or null. */
  problem: string | null;
  /** Aircraft Aeroconomy lists without saying what type they are. */
  untyped: number;
}

/** How long a read of the fleet is used again. */
export const FLEET_KEPT_MS = 60 * 60_000;
const fleetKey = (panelId: number): string => `safety-fleet:${panelId}`;

const byCode = (a: FleetEntry, b: FleetEntry): number => (a.code < b.code ? -1 : a.code > b.code ? 1 : 0);

/**
 * The aircraft types of the airline: the aircraft it owns and the ones it leases, from Aeroconomy (when it can be read), and any type its recent flights were flown in
 * or that already has limits of its own, so no landing is left without a type to be judged by. `again` reads Aeroconomy afresh; otherwise a read from the last hour is used.
 */
export async function readFleet(deps: LimitsDeps, panel: Panel, again: boolean, business?: number): Promise<FleetRead> {
  const { store, profits, now } = deps;
  if (!again) {
    try {
      const saved = JSON.parse(store.getKv(fleetKey(panel.id)) ?? 'null') as FleetRead | null;
      if (saved && Array.isArray(saved.entries) && now() - saved.at < FLEET_KEPT_MS && now() >= saved.at) return saved;
    } catch {
      /* read again below */
    }
  }
  const types = new Map<string, FleetEntry>();
  const add = (code: string): FleetEntry => {
    let e = types.get(code);
    if (!e) types.set(code, (e = { code, owned: 0, leased: 0, flown: false }));
    return e;
  };
  let problem: string | null = null;
  let untyped = 0;
  if (!profits) {
    problem = "I have no FsHub token, which is how I'm let see the airline's aircraft on Aeroconomy, so these are only the types its recent flights were flown in.";
  } else {
    try {
      const fleet = await profits.fleetTypes(panel, business);
      untyped = fleet.untyped;
      for (const [code, n] of fleet.types) {
        const e = add(code);
        e.owned = n.owned;
        e.leased = n.leased;
      }
      if (fleet.problem) problem = `I could read the aircraft the airline owns, but not the ones it leases (${fleet.problem}).`;
    } catch (e) {
      if (e instanceof ProfitError) problem = e.message;
      else if (e instanceof AeroconomyError) problem = `Aeroconomy would not list the airline's aircraft (${e.message}).`;
      else throw e;
    }
  }
  for (const code of store.listFlownAircraftTypes(panel.id)) {
    const c = normalizeAircraft(code);
    if (c !== null) add(c).flown = true;
  }
  for (const code of store.listSafetyLimits(panel.id).keys()) add(code);
  const read: FleetRead = { at: now(), entries: [...types.values()].sort(byCode), problem, untyped };
  store.setKv(fleetKey(panel.id), JSON.stringify(read));
  return read;
}

/** The airline's default limits: what an aircraft with none of its own is judged by. */
export const defaultLimits = (panel: Panel): SafetyLimits => ({ warn: panel.safetyWarnFpm, tier1: panel.safetyTier1Fpm, tier2: panel.safetyTier2Fpm });

/** The limits an aircraft type is judged by (its own, or the airline's default), and whether they are its own. */
export function limitsOf(store: Store, panel: Panel, code: string): { limits: SafetyLimits; own: boolean } {
  const own = store.listSafetyLimits(panel.id).get(code);
  return { limits: own ?? defaultLimits(panel), own: own !== undefined };
}

/** Parse a number of feet per minute as typed: `450`, `-450`, `450 fpm`. Null when it is not one. */
export function parseFpm(text: string): number | null {
  const m = /^\s*[-−–]?\s*(\d{1,5})\s*(?:fpm|ft\/min)?\s*$/i.exec(text);
  return m ? Number(m[1]) : null;
}
