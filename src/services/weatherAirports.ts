import type { JobView } from '../db/store.js';
import { normalizeStation } from '../metar/client.js';

/**
 * What the weather board shows, worked out from the schedule: which flights are in the next 24 hours and which airports they need
 * a weather report for. Nothing here talks to the network or to Discord.
 */

/** The board covers the flights whose landing window falls within this long from now. */
export const WEATHER_WINDOW_MS = 24 * 3_600_000;

/** The airports shown at the top of a board that has not been given its own list. */
export const DEFAULT_WEATHER_AIRPORTS: readonly string[] = ['KBOS', 'KMIA', 'SKBO', 'EGLL'];

/** The most airports an admin can put at the top. */
export const MAX_TOP_AIRPORTS = 8;
/** The most flights listed on the board, and the most airports of those flights looked up (a board has to fit a few messages). */
export const MAX_BOARD_FLIGHTS = 60;
export const MAX_FLIGHT_AIRPORTS = 40;

export interface BoardFlight {
  /** The flight's ID as pilots see it on the panel. */
  code: string;
  legs: Array<{ dep: string; arr: string }>;
  /** When the flight's landing window opens and closes (epoch ms). */
  from: number;
  to: number;
}

/**
 * The open flights whose landing window overlaps the next 24 hours (one already open and still to be flown counts), soonest first.
 * A flight with no deadline at all has no time to place it, so it is left out; so is one whose window has passed.
 */
export function flightsInWindow(views: JobView[], now: number, windowMs: number = WEATHER_WINDOW_MS): BoardFlight[] {
  const end = now + windowMs;
  const out: BoardFlight[] = [];
  for (const v of views) {
    const job = v.job;
    if (job.status !== 'open' || job.completedAt !== null || job.deadline === null) continue;
    const from = job.availableFrom ?? job.deadline;
    if (job.deadline < now || from > end) continue;
    out.push({ code: job.code, legs: v.legs.map((l) => ({ dep: l.dep, arr: l.arr })), from, to: job.deadline });
  }
  return out.sort((a, b) => a.from - b.from || a.to - b.to || a.code.localeCompare(b.code));
}

/**
 * The airports these flights fly from and to, each once, in the order the flights come (their legs in route order), leaving out
 * `exclude` (the airports already shown at the top). `skipped` are codes that are not four characters, which VATSIM has no report for.
 */
export function flightAirports(flights: BoardFlight[], exclude: Iterable<string>): { codes: string[]; skipped: string[] } {
  const seen = new Set<string>(exclude);
  const codes: string[] = [];
  const skipped: string[] = [];
  const unusable = new Set<string>();
  for (const f of flights) {
    for (const leg of f.legs) {
      for (const raw of [leg.dep, leg.arr]) {
        const code = normalizeStation(raw);
        if (code === null) {
          if (!unusable.has(raw)) (unusable.add(raw), skipped.push(raw));
          continue;
        }
        if (seen.has(code)) continue;
        seen.add(code);
        codes.push(code);
      }
    }
  }
  return { codes, skipped };
}

/**
 * Airport codes typed by an admin (`KBOS KMIA, SKBO`): the four-letter ones, upper-cased and each once, and what could not be used.
 */
export function parseAirportList(text: string): { codes: string[]; refused: string[] } {
  const codes: string[] = [];
  const refused: string[] = [];
  for (const token of text.split(/[\s,;]+/).filter(Boolean)) {
    const code = normalizeStation(token);
    if (code === null) {
      const shown = token.replace(/`/g, "'").slice(0, 20);
      if (!refused.includes(shown)) refused.push(shown);
    } else if (!codes.includes(code)) codes.push(code);
  }
  return { codes, refused };
}
