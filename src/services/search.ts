import type { JobView } from '../db/store.js';

/** The most flights a search shows (as cards in one reply); more than this and the pilot is asked to narrow it down. */
export const MAX_SEARCH_RESULTS = 8;
const MAX_CODES = 6;
/** Words people put between airports, which are not airports. */
const FILLER = new Set(['AND', 'OR', 'TO', 'OF', 'FROM', 'THE']);

/** What was typed into one search box: the airport codes in it, and anything that wasn't one. */
export interface AirportCodes {
  codes: string[];
  ignored: string[];
}

/**
 * Airport codes as people type them into a search box: one or several, separated by spaces, commas or slashes, in any
 * case. A code is two to four letters or numbers; two or three letters are the start of a code, so `EG` finds every
 * airport that starts with EG.
 */
export function parseAirportCodes(text: string | null | undefined): AirportCodes {
  const codes: string[] = [];
  const ignored: string[] = [];
  for (const token of (text ?? '').toUpperCase().split(/[\s,;/&]+/)) {
    if (!token || FILLER.has(token)) continue;
    if (/^[A-Z0-9]{2,4}$/.test(token)) {
      if (!codes.includes(token) && codes.length < MAX_CODES) codes.push(token);
    } else ignored.push(token.slice(0, 12));
  }
  return { codes, ignored };
}

/* ------------------------------------------------------------------ aircraft types */

/** What was typed into the aircraft box: the types in it, and anything that wasn't one. */
export interface AircraftTypes {
  codes: string[];
  ignored: string[];
}

/** Words people put between types, which are not types. */
const TYPE_FILLER = new Set(['AND', 'OR', 'OF', 'THE', 'A', 'AN']);

/**
 * Aircraft types as people type them: one or several, separated by spaces, commas or slashes, in any case. A type is two to
 * five letters or numbers (`A320`, `B738`, `B38M`); a few characters are the start of a type, so `B73` finds every B73x.
 */
export function parseAircraftTypes(text: string | null | undefined): AircraftTypes {
  const codes: string[] = [];
  const ignored: string[] = [];
  for (const token of (text ?? '').toUpperCase().split(/[\s,;/&+]+/)) {
    if (!token || TYPE_FILLER.has(token)) continue;
    if (/^[A-Z0-9]{2,5}$/.test(token)) {
      if (!codes.includes(token) && codes.length < MAX_CODES) codes.push(token);
    } else ignored.push(token.slice(0, 12));
  }
  return { codes, ignored };
}

/**
 * Is the flight's aircraft one of these types? A flight's aircraft is usually a type code (`A320`); where the schedule gives
 * a few (`A320/A321`) or a name with the type in it (`Airbus A320`), any of those words counts. A type that starts with one of
 * the codes matches, so `A32` finds A320 and A321. With no types asked for, every flight matches; a flight with no aircraft
 * named matches none.
 */
export function matchesAircraft(aircraft: string | null | undefined, types: string[]): boolean {
  if (types.length === 0) return true;
  if (!aircraft) return false;
  return aircraft
    .toUpperCase()
    .split(/[\s,;/&+]+/)
    .filter(Boolean)
    .some((word) => types.some((t) => word.startsWith(t)));
}

/* ------------------------------------------------------------------ dates */

const DAY_MS = 24 * 3_600_000;
const MONTHS = ['jan', 'feb', 'mar', 'apr', 'may', 'jun', 'jul', 'aug', 'sep', 'oct', 'nov', 'dec'];
const WEEKDAYS = ['sun', 'mon', 'tue', 'wed', 'thu', 'fri', 'sat'];
const MONTH_NAMES = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
const WEEKDAY_NAMES = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];

/** One calendar day, in Zulu (UTC): from its first instant up to, but not including, the next midnight. */
export interface SearchDay {
  start: number;
  end: number;
  /** For showing to people: `Sat 14 Nov`. */
  label: string;
}

/** `Sat 14 Nov` for the Zulu day starting at `start`. */
export const dayLabel = (start: number): string => {
  const d = new Date(start);
  return `${WEEKDAY_NAMES[d.getUTCDay()]} ${d.getUTCDate()} ${MONTH_NAMES[d.getUTCMonth()]}`;
};

/** The Zulu day that holds this moment. */
export const dayOf = (at: number): SearchDay => {
  const start = Math.floor(at / DAY_MS) * DAY_MS;
  return { start, end: start + DAY_MS, label: dayLabel(start) };
};

/** A real calendar day (31 Feb is not one), or null. */
function calendarDay(year: number, month: number, day: number): number | null {
  const at = Date.UTC(year, month, day);
  const d = new Date(at);
  return d.getUTCFullYear() === year && d.getUTCMonth() === month && d.getUTCDate() === day ? at : null;
}

/** Of this day and month in the years around now, the one closest to today: `2 Jan` typed on 30 Dec means next month, `12 Nov` typed on the 14th means two days ago. */
function nearestYear(month: number, day: number, today: number): number | null {
  const year = new Date(today).getUTCFullYear();
  const candidates = [year - 1, year, year + 1].map((y) => calendarDay(y, month, day)).filter((c): c is number => c !== null);
  if (candidates.length === 0) return null;
  return candidates.reduce((best, c) => (Math.abs(c - today) < Math.abs(best - today) ? c : best));
}

const monthIndex = (word: string): number => (word.length >= 3 ? MONTHS.indexOf(word.slice(0, 3)) : -1);
const fullYear = (y: string): number => (y.length === 2 ? 2000 + Number(y) : Number(y));

/**
 * A date as a pilot types it into the search form, read as a Zulu (UTC) day, which is how flight times are read everywhere
 * here. Understands `today`, `tomorrow`, a weekday (`sat`, `saturday`, the next one, today if it is that day), `2026-11-14`,
 * `14/11` and `14/11/2026` (day first), and `14 Nov`, `14th November`, `Nov 14`, `14 Nov 2026`. Without a year, the year
 * that puts the date nearest to today. Null when it isn't a date.
 */
export function parseSearchDate(text: string | null | undefined, now: number): SearchDay | null {
  const raw = (text ?? '').trim().toLowerCase().replace(/\s+/g, ' ');
  if (!raw) return null;
  const today = dayOf(now).start;
  const make = (start: number | null): SearchDay | null => (start === null ? null : { start, end: start + DAY_MS, label: dayLabel(start) });

  if (raw === 'today') return make(today);
  if (raw === 'tomorrow') return make(today + DAY_MS);

  // Only real weekday names and their usual short forms: "month" or "saturn" are not weekdays.
  const weekday = /^(?:next |this |on )?(sun(?:day)?|mon(?:day)?|tue(?:s|sday)?|wed(?:nesday)?|thu(?:r|rs|rsday)?|fri(?:day)?|sat(?:urday)?)$/.exec(raw);
  if (weekday) {
    const want = WEEKDAYS.indexOf(weekday[1]!.slice(0, 3));
    const ahead = (want - new Date(today).getUTCDay() + 7) % 7;
    return make(today + ahead * DAY_MS);
  }

  const iso = /^(\d{4})[-/.](\d{1,2})[-/.](\d{1,2})$/.exec(raw);
  if (iso) return make(calendarDay(Number(iso[1]), Number(iso[2]) - 1, Number(iso[3])));

  const numeric = /^(\d{1,2})[-/.](\d{1,2})(?:[-/.](\d{4}|\d{2}))?$/.exec(raw);
  if (numeric) {
    const day = Number(numeric[1]);
    const month = Number(numeric[2]) - 1;
    return make(numeric[3] ? calendarDay(fullYear(numeric[3]), month, day) : nearestYear(month, day, today));
  }

  const named = /^(?:(\d{1,2})(?:st|nd|rd|th)?[ -]([a-z]{3,9})|([a-z]{3,9})[ -](\d{1,2})(?:st|nd|rd|th)?)(?:,? (\d{4}))?$/.exec(raw);
  if (named) {
    const day = Number(named[1] ?? named[4]);
    const month = monthIndex((named[2] ?? named[3])!);
    if (month < 0) return null;
    return make(named[5] ? calendarDay(Number(named[5]), month, day) : nearestYear(month, day, today));
  }
  return null;
}

/** Can the flight be flown at some point on this day: open before the day ends, and not already closed when it starts? */
export const flyableOn = (job: { availableFrom: number | null; deadline: number | null }, day: SearchDay): boolean =>
  (job.availableFrom === null || job.availableFrom < day.end) && (job.deadline === null || job.deadline > day.start);

const startsWithAny = (airport: string, codes: string[]): boolean => codes.some((c) => airport.toUpperCase().startsWith(c));

/**
 * Does the flight go from one of `from` to one of `to`? With only one of the two given, does it leave from, or arrive at,
 * one of them. A flight with several legs counts when it leaves from the first and later arrives at the second, so
 * `from LFPG to EDDF` finds `LFPG → EHAM → EDDF`.
 */
export function matchesSearch(view: JobView, from: string[], to: string[]): boolean {
  if (from.length === 0 && to.length === 0) return false;
  const first = from.length === 0 ? 0 : view.legs.findIndex((l) => startsWithAny(l.dep, from));
  if (first < 0) return false;
  return to.length === 0 || view.legs.slice(first).some((l) => startsWithAny(l.arr, to));
}
