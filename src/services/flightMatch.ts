import type { FlownFlight, Job, JobView, LegView, Panel, Store } from '../db/store.js';

/**
 * Matching what a panel lists to what FsHub recorded. A scheduled flight (one leg of a job) is "confirmed"
 * when FsHub holds a flight between the same two airports that landed inside the job's window. FsHub's
 * flight records carry no job ID, so this is matching, never a lookup, and it is deliberately cautious:
 *
 * - If the person holding the leg gave the bot their FsHub pilot ID (typed, or from the airline's roster),
 *   only a flight by that pilot counts.
 * - If nobody with a known FsHub ID holds the leg (the schedule names a pilot in a sheet, say), a flight
 *   counts only when it is the single candidate: two pilots flying the same route in the same window is
 *   ambiguous, and nothing is claimed rather than something wrong. (This is for showing what FsHub saw;
 *   when a flight is completed because of it, `strict` requires the holder's FsHub ID.)
 * - A FsHub flight confirms at most one leg.
 *
 * The aircraft is not part of the match, because a pilot who flew a different type did still fly the
 * flight; it is reported next to the match instead (see `sameAircraft`).
 */

const HOUR = 3_600_000;

/** A flight landing a little outside the window (or a clock a little out) still counts. */
export const WINDOW_GRACE_MS = HOUR;
/** A job with no start or no end is treated as open for this long. */
const OPEN_ENDED_MS = 48 * HOUR;

/** When a flight may have landed to count as this job's (epoch ms, both ends included). */
export function landingWindow(job: Job, now: number): { from: number; to: number } {
  const anchor = job.completedAt ?? now;
  const start = job.availableFrom ?? (job.deadline !== null ? job.deadline - OPEN_ENDED_MS : anchor - OPEN_ENDED_MS);
  const end = job.deadline ?? Math.max(now, anchor);
  return { from: start - WINDOW_GRACE_MS, to: end + WINDOW_GRACE_MS };
}

/** Per job, per leg number: the FsHub flight that confirms it. */
export type Confirmations = Map<number, Map<number, FlownFlight>>;

/**
 * Confirm what can be confirmed among these jobs. Earlier jobs in the list claim a flight first, so put the ones
 * that matter most first (completed flights before open ones). Returns nothing for a panel that doesn't read
 * FsHub flights.
 */
export function confirmationsFor(
  store: Store,
  panel: Panel,
  views: JobView[],
  now: number,
  opts: {
    strict?: boolean;
    /**
     * For flights nobody holds in Discord but the sheet names for a pilot: job ID to the FsHub pilot ID of the person the
     * sheet's name is taken to be. A leg of such a flight counts only when that pilot's own flight confirms it.
     */
    namedPilots?: Map<number, number>;
  } = {},
): Confirmations {
  const out: Confirmations = new Map();
  if (!panel.fshubConfirm || panel.fshubAirlineId === null || views.length === 0) return out;
  if (store.countFshubFlights(panel.id) === 0) return out;

  const claimed = new Set<number>();
  for (const view of views) {
    const { from, to } = landingWindow(view.job, now);
    for (const leg of view.legs) {
      const candidates = store
        .listFshubFlights(panel.id, leg.dep.toUpperCase(), leg.arr.toUpperCase(), from, to)
        .filter((f) => !claimed.has(f.flightId));
      const flight = pick(candidates, leg, opts.strict === true, opts.namedPilots?.get(view.job.id) ?? null);
      if (!flight) continue;
      claimed.add(flight.flightId);
      const legs = out.get(view.job.id) ?? new Map<number, FlownFlight>();
      legs.set(leg.legNo, flight);
      out.set(view.job.id, legs);
    }
  }
  return out;
}

/**
 * The one flight among the candidates that this leg's pilot flew, or null if there isn't one clear answer. In strict
 * mode (used when a pilot's own claim is being acted on) a flight counts only if the leg's holder has a known FsHub ID
 * and it is theirs: a lone flight by somebody else is never taken as the holder's. A leg nobody holds in Discord
 * is matched to `named` (the pilot the sheet's name is taken to be) when there is one, and only to a flight by them.
 */
function pick(candidates: FlownFlight[], leg: LegView, strict: boolean, named: number | null): FlownFlight | null {
  if (candidates.length === 0) return null;
  const pilot = leg.holder?.fshubId ?? (leg.holder === null ? named : null);
  if (pilot !== null) return candidates.filter((f) => f.pilotId === pilot).at(-1) ?? null;
  if (strict) return null;
  return candidates.length === 1 ? (candidates[0] as FlownFlight) : null;
}

/**
 * Whether the aircraft flown is the one the schedule asked for: true or false when both are aircraft type codes
 * that can be compared, null when they can't (no requirement, a type given in words, or a code that is only an
 * abbreviation of the other, like a schedule's `A32` for an `A320`).
 */
export function sameAircraft(required: string | null, flown: string | null): boolean | null {
  if (!required || !flown) return null;
  const want = required.trim().toUpperCase();
  const got = flown.trim().toUpperCase();
  if (!/^[A-Z0-9]{3,4}$/.test(want) || !/^[A-Z0-9]{3,4}$/.test(got)) return null;
  if (want === got) return true;
  if (got.startsWith(want) || want.startsWith(got)) return null;
  return false;
}

/** A short signature of what is confirmed, so a panel is only redrawn when something about it changed. */
export function confirmationsSignature(c: Confirmations): string {
  const parts: string[] = [];
  for (const [jobId, legs] of [...c.entries()].sort((a, b) => a[0] - b[0])) {
    for (const [legNo, f] of [...legs.entries()].sort((a, b) => a[0] - b[0])) {
      parts.push(`${jobId}.${legNo}:${f.flightId}:${f.aircraftIcao ?? ''}:${f.scheduleStatus ?? ''}`);
    }
  }
  return parts.join('|');
}
