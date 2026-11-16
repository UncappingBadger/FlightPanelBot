/**
 * Turns a METAR (an airport's routine weather report, written in a compact code) into plain language.
 *
 * Nothing here talks to the network or to Discord: it is text in, text out.
 *
 * The groups of a METAR come in the same order worldwide (ICAO Annex 3 / WMO FM 15), but countries and even single stations
 * differ in their units and extras: the United States and Canada give visibility in statute miles and pressure in inches of
 * mercury (A2992), most of the world gives metres and hectopascals (Q1013), Russia and China give wind in metres per second, and
 * the remarks (after RMK) are national. So units are read from each group's own suffix, never guessed from the country, and
 * anything not understood is handed back as it was written instead of being thrown away.
 */

export type FlightCategory = 'VFR' | 'MVFR' | 'IFR' | 'LIFR';

export interface MetarSection {
  title: string;
  lines: string[];
}

export interface DecodedMetar {
  /** The report as given, tidied to one line. */
  raw: string;
  /** The airport's code, if the report (or the caller) gave one. */
  station: string | null;
  kind: 'METAR' | 'SPECI';
  /** "NIL": the station sent no report. */
  nil: boolean;
  /** Made by machine, with nobody watching the weather. */
  auto: boolean;
  corrected: boolean;
  /** When it was observed (epoch ms), if `now` was known to place the day of the month. */
  observedAt: number | null;
  /** "the 16th at 13:50 UTC". */
  when: string;
  /** A sentence or two a beginner can read first. */
  summary: string;
  /** The US-style rating (VFR, MVFR, IFR, LIFR), when the report gives enough to work it out. */
  category: FlightCategory | null;
  /** True for the US, its territories and Canada, where those ratings are in everyday use. */
  usStyleRating: boolean;
  sections: MetarSection[];
  /** Parts of the main report (and the forecast part) that were not understood, as written. */
  unread: string[];
  /** Remarks (after RMK) that were not understood, as written. Remarks are national and free-form, so some always are. */
  remarksUnread: string[];
}

/* ------------------------------------------------------------------ small helpers */

const KT_KMH = 1.852;
const FT_M = 0.3048;
const SM_M = 1609.344;
const INHG_HPA = 33.8639;

/** 12345.6 -> "12,346". */
const whole = (n: number): string => String(Math.round(n)).replace(/\B(?=(\d{3})+(?!\d))/g, ',');
/** At most `d` decimals, no trailing zeros: 2.50 -> "2.5". */
const dec = (n: number, d = 1): string => {
  const p = 10 ** d;
  return String(Math.round(n * p) / p);
};
const plural = (n: number, one: string, many = `${one}s`): string => (n === 1 ? one : many);
const cap = (s: string): string => (s ? s.charAt(0).toUpperCase() + s.slice(1) : s);
const lower = (s: string): string => (s ? s.charAt(0).toLowerCase() + s.slice(1) : s);

const COMPASS = ['north', 'north-north-east', 'north-east', 'east-north-east', 'east', 'east-south-east', 'south-east', 'south-south-east', 'south', 'south-south-west', 'south-west', 'west-south-west', 'west', 'west-north-west', 'north-west', 'north-north-west'];
const compass = (deg: number): string => COMPASS[Math.round((((deg % 360) + 360) % 360) / 22.5) % 16] as string;
const COMPASS8: Record<string, string> = { N: 'north', NE: 'north-east', E: 'east', SE: 'south-east', S: 'south', SW: 'south-west', W: 'west', NW: 'north-west' };

/** Tokens come from outside, so before one is shown it is made harmless (no backticks or mentions) and short. */
const shown = (token: string): string => token.replace(/[`@<>*_~|\\]/g, '').slice(0, 24);

/* ------------------------------------------------------------------ wind */

interface Wind {
  /** Degrees true, 'VRB' for variable, null when the sensor gave nothing. */
  dir: number | 'VRB' | null;
  /** In the report's own unit; null when missing. `over` is true for "P99KT": that many or more. */
  speed: number | null;
  gust: number | null;
  unit: 'KT' | 'MPS' | 'KMH';
  over: boolean;
}

const WIND_RE = /^(VRB|\d{3}|\/\/\/)(P?\d{2,3}|\/\/)(?:G(P?\d{2,3}))?(KT|MPS|KMH)$/;

function parseWind(token: string): Wind | null {
  const m = WIND_RE.exec(token);
  if (!m) return null;
  const num = (s: string | undefined): number | null => (s === undefined || s === '//' ? null : Number(s.replace('P', '')));
  const dir = m[1] === 'VRB' ? 'VRB' : m[1] === '///' ? null : Number(m[1]);
  return { dir, speed: num(m[2]), gust: num(m[3]), unit: m[4] as Wind['unit'], over: m[2]?.startsWith('P') === true };
}

const toKnots = (v: number, unit: Wind['unit']): number => (unit === 'KT' ? v : unit === 'MPS' ? v * 1.943844 : v * 0.539957);

/** A speed the way the report gave it, with the other usual units beside it. */
function speedText(v: number, unit: Wind['unit'], over = false): string {
  const more = over ? ' or more' : '';
  if (unit === 'KT') return `${v} ${plural(v, 'knot')}${more} (${whole(v * KT_KMH)} km/h)`;
  if (unit === 'MPS') return `${v} m/s${more} (${whole(toKnots(v, unit))} knots)`;
  return `${v} km/h${more} (${whole(toKnots(v, unit))} knots)`;
}

function windStrength(kt: number): string {
  if (kt < 1) return 'calm';
  if (kt <= 6) return 'light';
  if (kt <= 16) return 'moderate';
  if (kt <= 27) return 'strong';
  return 'very strong';
}

function describeWind(w: Wind, withStrength = true): string {
  if (w.speed === null) return w.dir === null ? 'The wind was not reported (the sensor gave nothing).' : 'The wind speed was not reported.';
  if (w.speed === 0 && w.dir !== 'VRB') return 'Calm: no wind to speak of.';
  const strength = windStrength(toKnots(w.speed, w.unit));
  const from = w.dir === 'VRB' ? 'Variable direction' : w.dir === null ? 'Direction not reported' : `From the ${compass(w.dir)} (${String(w.dir).padStart(3, '0')}°)`;
  const gust = w.gust !== null ? `, gusting to ${speedText(w.gust, w.unit, w.over)}` : '';
  return `${from}, at ${speedText(w.speed, w.unit, w.over)}${gust}.${withStrength ? ` That is a ${strength} wind.` : ''}`;
}

/* ------------------------------------------------------------------ visibility */

interface Visibility {
  /** Metres, the best single number for comparisons; null when missing. */
  metres: number | null;
  /** "less than" / "more than" / exactly. */
  bound: 'exact' | 'below' | 'above';
  /** Set when given in statute miles, so it is said in them. */
  miles: number | null;
  /** The compass direction of a directional visibility, if one. */
  dir: string | null;
}

function visWord(m: number): string {
  if (m >= 8000) return 'very good';
  if (m >= 5000) return 'good';
  if (m >= 1600) return 'moderate';
  if (m >= 800) return 'poor';
  return 'very poor';
}

/** A visibility in words. With `withWord`, it ends with how good that is ("very good", "poor"). */
function describeVisibility(v: Visibility, withWord = true): string {
  if (v.metres === null) return 'Visibility was not reported.';
  const where = v.dir ? ` towards the ${COMPASS8[v.dir] ?? v.dir}` : '';
  const word = withWord ? `, which is ${visWord(v.metres)}` : '';
  if (v.miles !== null) {
    const qual = v.bound === 'below' ? 'Less than ' : v.bound === 'above' ? 'More than ' : '';
    const km = (v.miles * SM_M) / 1000;
    return `${qual}${fractionText(v.miles)} statute ${plural(v.miles <= 1 ? 1 : 2, 'mile')}${where} (${v.bound === 'exact' ? '' : 'about '}${dec(km)} km)${word}.`;
  }
  if (v.metres >= 9999) return `10 km or more (6 miles or more)${where}${withWord ? ', which is very good' : ''}.`;
  if (v.metres === 0) return `Less than 50 metres${where}${withWord ? ', which is very poor' : ''}.`;
  if (v.metres < 1000) return `${whole(v.metres)} metres${where}${word}.`;
  return `${dec(v.metres / 1000)} km (${dec(v.metres / SM_M)} miles)${where}${word}.`;
}

/** 1.5 -> "1 1/2", 0.25 -> "1/4", 3 -> "3". */
function fractionText(miles: number): string {
  const w = Math.floor(miles + 1e-9);
  const frac = miles - w;
  const frs: Array<[number, string]> = [[0.125, '1/8'], [0.25, '1/4'], [0.375, '3/8'], [0.5, '1/2'], [0.625, '5/8'], [0.75, '3/4'], [0.875, '7/8']];
  const f = frs.find(([v]) => Math.abs(frac - v) < 0.01)?.[1];
  if (!f) return dec(miles, 2);
  return w > 0 ? `${w} ${f}` : f;
}

/**
 * A visibility starting at `tokens[i]`, and how many tokens it used (a US "1 1/2SM" is two), or null.
 */
function parseVisibility(tokens: string[], i: number): { vis: Visibility; used: number } | null {
  const t = tokens[i] as string;
  if (t === '////') return { vis: { metres: null, bound: 'exact', miles: null, dir: null }, used: 1 };
  let m = /^(\d{4})(N|NE|E|SE|S|SW|W|NW)?$/.exec(t);
  if (m) return { vis: { metres: Number(m[1]), bound: 'exact', miles: null, dir: m[2] ?? null }, used: 1 };
  m = /^(\d{4})NDV$/.exec(t);
  if (m) return { vis: { metres: Number(m[1]), bound: 'exact', miles: null, dir: null }, used: 1 };
  // Statute miles: "10SM", "1/2SM", "M1/4SM", "P6SM", and "1 1/2SM" in two tokens.
  m = /^([MP])?(\d{1,2})SM$/.exec(t);
  if (m) return milesVis(Number(m[2]), m[1]);
  m = /^([MP])?(\d{1,2})\/(\d{1,2})SM$/.exec(t);
  if (m) return milesVis(Number(m[2]) / Number(m[3]), m[1]);
  const next = tokens[i + 1];
  if (/^\d{1,2}$/.test(t) && next) {
    const f = /^(\d{1,2})\/(\d{1,2})SM$/.exec(next);
    if (f) return { ...milesVis(Number(t) + Number(f[1]) / Number(f[2]), undefined), used: 2 };
  }
  return null;
}

function milesVis(miles: number, flag: string | undefined): { vis: Visibility; used: number } {
  return { vis: { metres: miles * SM_M, bound: flag === 'M' ? 'below' : flag === 'P' ? 'above' : 'exact', miles, dir: null }, used: 1 };
}

/* ------------------------------------------------------------------ runway visual range */

const RVR_RE = /^R(\d{2}[LCR]?)\/([MP])?(\d{4})(?:V([MP])?(\d{4}))?(FT)?(?:\/?([UDN]))?$/;

function runwayText(rwy: string): string {
  return `runway ${rwy}`;
}

function describeRvr(token: string): string | null {
  if (/^R\d{2}[LCR]?\/{5}$/.test(token)) return `Runway visual range for ${runwayText(token.slice(1, token.indexOf('/')))} was not available.`;
  const m = RVR_RE.exec(token);
  if (!m) return null;
  const feet = m[6] === 'FT';
  const unit = (n: number): string => (feet ? `${whole(n)} ft (${whole(n * FT_M)} m)` : `${whole(n)} m`);
  const one = (prefix: string | undefined, n: number): string => `${prefix === 'P' ? 'more than ' : prefix === 'M' ? 'less than ' : ''}${unit(n)}`;
  const value = m[5] ? `varying between ${one(m[2], Number(m[3]))} and ${one(m[4], Number(m[5]))}` : one(m[2], Number(m[3]));
  const trend = m[7] === 'U' ? ', getting better' : m[7] === 'D' ? ', getting worse' : m[7] === 'N' ? ', not changing much' : '';
  return `On ${runwayText(m[1] as string)}, a pilot could see lights and markings ${value}${trend}.`;
}

/* ------------------------------------------------------------------ present weather */

const PHENOMENA: Record<string, string> = {
  DZ: 'drizzle',
  RA: 'rain',
  SN: 'snow',
  SG: 'snow grains',
  IC: 'ice crystals',
  PL: 'ice pellets',
  GR: 'hail',
  GS: 'small hail',
  UP: 'unidentified precipitation',
  BR: 'mist',
  FG: 'fog',
  FU: 'smoke',
  VA: 'volcanic ash',
  DU: 'widespread dust',
  SA: 'sand',
  HZ: 'haze',
  PY: 'spray',
  PO: 'dust or sand whirls',
  SQ: 'squalls',
  FC: 'funnel cloud',
  SS: 'sandstorm',
  DS: 'duststorm',
};
const PRECIPITATION = new Set(['DZ', 'RA', 'SN', 'SG', 'IC', 'PL', 'GR', 'GS', 'UP']);
const WEATHER_RE = /^(\+|-|VC)?(MI|BC|PR|DR|BL|SH|TS|FZ)?((?:DZ|RA|SN|SG|IC|PL|GR|GS|UP|BR|FG|FU|VA|DU|SA|HZ|PY|PO|SQ|FC|SS|DS)+)?$/;

/** A present-weather group ("+SHRA", "-SN", "VCTS", "BCFG") in words, or null if it isn't one. */
function describeWeather(token: string): string | null {
  if (token === 'NSW') return 'No significant weather.';
  if (token === '//') return 'Present weather was not reported (the sensor gave nothing).';
  const m = WEATHER_RE.exec(token);
  if (!m || !token) return null;
  const [, prefix, descriptor, rest] = m;
  if (!rest && descriptor !== 'TS' && descriptor !== 'SH') return null;
  const codes = (rest?.match(/../g) ?? []) as string[];
  const heavy = prefix === '+';
  const light = prefix === '-';
  const nearby = prefix === 'VC';
  // FC with a + is a tornado or waterspout, not just a funnel cloud.
  const names = codes.map((c) => (c === 'FC' && heavy ? 'tornado or waterspout' : PHENOMENA[c] as string));
  const precip = codes.some((c) => PRECIPITATION.has(c));
  const strength = heavy && !(codes.length === 1 && codes[0] === 'FC') ? 'heavy ' : light ? 'light ' : precip && !['BL', 'DR', 'MI', 'BC', 'PR'].includes(descriptor ?? '') ? 'moderate ' : '';
  const list = names.join(' and ');
  let phrase: string;
  switch (descriptor) {
    case 'TS':
      phrase = names.length > 0 ? `thunderstorm with ${strength}${list}` : 'thunderstorm';
      break;
    case 'SH':
      phrase = names.length > 0 ? `${strength}${list} showers` : `${strength}showers`;
      break;
    case 'FZ':
      phrase = `${strength}freezing ${list}`;
      break;
    case 'BL':
      phrase = `${strength}blowing ${list}`;
      break;
    case 'DR':
      phrase = `${strength}low drifting ${list}`;
      break;
    case 'MI':
      phrase = `${strength}shallow ${list}`;
      break;
    case 'BC':
      phrase = `${strength}patches of ${list}`;
      break;
    case 'PR':
      phrase = `${strength}partial ${list} (a bank covering part of the airfield)`;
      break;
    default:
      phrase = `${strength}${list}`;
  }
  return cap(nearby ? `${phrase} in the vicinity (close to the airfield, not over it).` : `${phrase}.`);
}

/* ------------------------------------------------------------------ cloud */

interface Layer {
  amount: 'FEW' | 'SCT' | 'BKN' | 'OVC' | null;
  /** Height above the airfield in feet; null when missing. */
  ft: number | null;
  kind: 'CB' | 'TCU' | 'unknown' | null;
}

const CLOUD_RE = /^(FEW|SCT|BKN|OVC|\/\/\/)(\d{3}|\/\/\/)(CB|TCU|\/\/\/)?$/;
const AMOUNT_WORDS: Record<string, string> = { FEW: 'A few clouds (1 to 2 eighths of the sky)', SCT: 'Scattered cloud (3 to 4 eighths)', BKN: 'Broken cloud (5 to 7 eighths)', OVC: 'Overcast (the whole sky covered)' };

function parseLayer(token: string): Layer | null {
  const m = CLOUD_RE.exec(token);
  if (!m) return null;
  return {
    amount: m[1] === '///' ? null : (m[1] as Layer['amount']),
    ft: m[2] === '///' ? null : Number(m[2]) * 100,
    kind: m[3] === 'CB' ? 'CB' : m[3] === 'TCU' ? 'TCU' : m[3] === '///' ? 'unknown' : null,
  };
}

function describeLayer(l: Layer, isCeiling = false): string {
  const base = l.ft === null ? ' at a height that was not reported' : ` at ${whole(l.ft)} ft (${whole(l.ft * FT_M)} m)`;
  const kind = l.kind === 'CB' ? ': thunderstorm cloud (cumulonimbus)' : l.kind === 'TCU' ? ': towering cumulus, building into a shower or storm cloud' : l.kind === 'unknown' ? ' (the type of cloud could not be detected)' : '';
  const amount = l.amount === null ? 'Cloud (amount not reported)' : (AMOUNT_WORDS[l.amount] as string);
  return `${amount}${base}${kind}.${isCeiling ? ' This is the ceiling.' : ''}`;
}

/* ------------------------------------------------------------------ temperature and pressure */

function tempValue(s: string): number | null {
  if (s === '//' || s === '') return null;
  return s.startsWith('M') ? -Number(s.slice(1)) : Number(s);
}
const celsius = (c: number): string => `${dec(c)}°C (${dec((c * 9) / 5 + 32, 0)}°F)`;

/** Relative humidity in percent from temperature and dew point (Celsius), by the Magnus formula. */
export function relativeHumidity(t: number, td: number): number {
  const a = 17.625;
  const b = 243.04;
  return Math.min(100, (100 * Math.exp((a * td) / (b + td))) / Math.exp((a * t) / (b + t)));
}

function describePressure(unit: string, value: string): string {
  if (value === '////') return 'The pressure was not reported.';
  const n = Number(value);
  if (unit === 'Q') return `${n} hPa (${dec((n / INHG_HPA), 2)} inHg). This is the QNH: set it on your altimeter to read height above sea level.`;
  const inhg = n / 100;
  return `${dec(inhg, 2)} inHg (${whole(inhg * INHG_HPA)} hPa). This is the altimeter setting: set it on your altimeter to read height above sea level.`;
}

/* ------------------------------------------------------------------ the small tables */

const RWY_DEPOSIT = ['clear and dry', 'damp', 'wet or with water patches', 'covered by rime or frost (under 1 mm)', 'dry snow', 'wet snow', 'slush', 'ice', 'compacted or rolled snow', 'frozen ruts or ridges'];
const RWY_EXTENT: Record<string, string> = { '1': '10% or less of the runway', '2': '11% to 25%', '5': '26% to 50%', '9': '51% to 100%' };
const SEA_STATE = ['calm (glassy)', 'calm (rippled)', 'smooth (wavelets)', 'slight', 'moderate', 'rough', 'very rough', 'high', 'very high', 'phenomenal'];
const COLOUR: Record<string, string> = {
  BLU: 'visibility at least 8 km and cloud base at least 2,500 ft',
  WHT: 'visibility at least 5 km and cloud base at least 1,500 ft',
  GRN: 'visibility at least 3.7 km and cloud base at least 700 ft',
  YLO1: 'visibility at least 2.5 km and cloud base at least 500 ft',
  YLO2: 'visibility at least 1.6 km and cloud base at least 300 ft',
  YLO: 'visibility at least 1.6 km and cloud base at least 300 ft',
  AMB: 'visibility at least 800 m and cloud base at least 200 ft',
  RED: 'visibility under 800 m or cloud base under 200 ft',
};

function describeColour(token: string): string | null {
  const m = /^(BLACK)?(BLU|WHT|GRN|YLO1|YLO2|YLO|AMB|RED)?$/.exec(token);
  if (!m || (!m[1] && !m[2])) return null;
  const black = m[1] ? 'BLACK: the runway is unusable for a reason other than weather' : '';
  const col = m[2] ? `${m[2]} (military colour state): ${COLOUR[m[2]]}` : '';
  return `${[black, col].filter(Boolean).join('. ')}.`;
}

/** What a two-character braking-action code means: 00 to 90 is a friction coefficient, 91 to 95 a word, 99 unreliable. */
function frictionText(grip: string): string {
  const g = Number(grip);
  if (g <= 90) return `braking friction ${dec(g / 100, 2)}`;
  if (g === 91) return 'braking poor';
  if (g === 92) return 'braking medium to poor';
  if (g === 93) return 'braking medium';
  if (g === 94) return 'braking medium to good';
  if (g === 95) return 'braking good';
  if (g === 99) return 'braking figures unreliable';
  return `braking code ${grip}`;
}

/** A runway state group such as "R10R/290050" or "R88/290196" (old 8-digit form "88290196"). */
function describeRunwayState(rest: string, rwy: string | null): string | null {
  const m = /^([0-9/])([0-9/])(\d{2}|\/\/)(\d{2}|\/\/)$/.exec(rest);
  if (!m) return null;
  const [, dep, ext, depth, grip] = m as unknown as [string, string, string, string, string, string];
  const parts: string[] = [];
  parts.push(dep === '/' ? 'deposit not reported' : (RWY_DEPOSIT[Number(dep)] ?? `deposit code ${dep}`));
  if (ext !== '/') parts.push(`covering ${RWY_EXTENT[ext] ?? `extent code ${ext}`}`);
  if (depth !== '//') {
    const d = Number(depth);
    parts.push(d === 0 ? 'under 1 mm deep' : d <= 90 ? `${d} mm deep` : d === 99 ? 'runway not usable' : d >= 92 && d <= 98 ? `${[10, 15, 20, 25, 30, 35, 40][d - 92]} cm deep${d === 98 ? ' or more' : ''}` : `depth code ${depth}`);
  }
  if (grip !== '//') parts.push(frictionText(grip));
  const where = rwy === null ? 'a runway' : rwy === '88' ? 'all runways' : rwy === '99' ? 'the same runways as the last report' : runwayText(rwy.replace(/^(\d{2})$/, (_, n: string) => (Number(n) > 50 ? `${String(Number(n) - 50).padStart(2, '0')}R` : n)));
  return `Condition of ${where}: ${parts.join(', ')}.`;
}

/* ------------------------------------------------------------------ flight category */

function categoryOf(visMetres: number | null, ceilingFt: number | null): FlightCategory | null {
  if (visMetres === null && ceilingFt === null) return null;
  const sm = visMetres === null ? Infinity : visMetres / SM_M;
  const ceil = ceilingFt ?? Infinity;
  if (ceil < 500 || sm < 1) return 'LIFR';
  if (ceil < 1000 || sm < 3) return 'IFR';
  if (ceil <= 3000 || sm <= 5) return 'MVFR';
  return 'VFR';
}

export const CATEGORY_WORDS: Record<FlightCategory, string> = {
  VFR: 'VFR: good for flying by sight (ceiling above 3,000 ft and visibility over 5 miles)',
  MVFR: 'MVFR: marginal for flying by sight (ceiling 1,000 to 3,000 ft or visibility 3 to 5 miles)',
  IFR: 'IFR: instruments needed (ceiling 500 to 999 ft or visibility 1 to under 3 miles)',
  LIFR: 'LIFR: low instrument conditions (ceiling under 500 ft or visibility under 1 mile)',
};

/* ------------------------------------------------------------------ remarks (national, free-form) */

const CLOUD_TYPES: Record<string, string> = { CU: 'cumulus', CB: 'cumulonimbus', TCU: 'towering cumulus', SC: 'stratocumulus', ST: 'stratus', SF: 'stratus fractus', CF: 'cumulus fractus', AS: 'altostratus', AC: 'altocumulus', CS: 'cirrostratus', CC: 'cirrocumulus', CI: 'cirrus', NS: 'nimbostratus' };
const TENDENCY = ['rising, then falling', 'rising, then steady', 'rising steadily', 'falling or steady, then rising', 'steady', 'falling, then rising', 'falling, then steady', 'falling steadily', 'steady or rising, then falling'];
const SENSOR: Record<string, string> = {
  RVRNO: 'The runway visual range sensor is not working.',
  PWINO: 'The present-weather sensor is not working.',
  PNO: 'The rain gauge is not working.',
  FZRANO: 'The freezing-rain sensor is not working.',
  TSNO: 'The lightning sensor is not working.',
  VISNO: 'The visibility sensor is not working or the reading is missing.',
  CHINO: 'The cloud-height sensor is not working or the reading is missing.',
  SLPNO: 'Sea-level pressure was not available.',
};
const DIRECTIONS = new Set(['N', 'NE', 'E', 'SE', 'S', 'SW', 'W', 'NW', 'OHD', 'VC', 'DSNT', 'ALQDS', 'AND']);
const dirWord = (d: string): string => (d === 'OHD' ? 'overhead' : d === 'VC' ? 'in the vicinity' : d === 'DSNT' ? 'in the distance' : d === 'ALQDS' ? 'all around' : d === 'AND' ? 'and' : (COMPASS8[d] ?? d));

const signed = (s: string, digits: string): number => (s === '1' ? -1 : 1) * (Number(digits) / 10);

/** The remarks, as plain sentences; what is not known comes back in `unread`. */
function decodeRemarks(tokens: string[]): { lines: string[]; unread: string[] } {
  const lines: string[] = [];
  const unread: string[] = [];
  for (let i = 0; i < tokens.length; i++) {
    const t = tokens[i] as string;
    let m: RegExpExecArray | null;
    const colour = describeColour(t);
    if (t === 'AO1') lines.push('Automatic station without a sensor that tells rain from snow (AO1).');
    else if (t === 'AO2') lines.push('Automatic station that can tell rain from snow (AO2).');
    else if (t === 'AO2A') lines.push('Automatic station with a person checking the observation (AO2A).');
    else if (t === '$') lines.push('The station needs maintenance, so some readings may be missing or wrong.');
    else if ((m = /^SLP(\d{3})$/.exec(t))) {
      const n = Number(m[1]);
      lines.push(`Sea-level pressure ${dec(n < 500 ? 1000 + n / 10 : 900 + n / 10)} hPa.`);
    } else if (/^T([01])(\d{3})([01])(\d{3})$/.test(t)) {
      // the exact temperature and dew point: shown under Temperature, so not repeated here
    } else if ((m = /^P(\d{4})$/.exec(t))) {
      lines.push(Number(m[1]) === 0 ? 'Under 0.01 in (a trace) of rain in the last hour.' : `${dec(Number(m[1]) / 100, 2)} in (${dec((Number(m[1]) / 100) * 25.4)} mm) of rain in the last hour.`);
    } else if ((m = /^6(\d{4})$/.exec(t))) {
      lines.push(`${dec(Number(m[1]) / 100, 2)} in of precipitation in the last 3 or 6 hours.`);
    } else if ((m = /^7(\d{4})$/.exec(t))) {
      lines.push(`${dec(Number(m[1]) / 100, 2)} in of precipitation in the last 24 hours.`);
    } else if ((m = /^1([01])(\d{3})$/.exec(t))) {
      lines.push(`Highest temperature in the last 6 hours: ${celsius(signed(m[1] as string, m[2] as string))}.`);
    } else if ((m = /^2([01])(\d{3})$/.exec(t))) {
      lines.push(`Lowest temperature in the last 6 hours: ${celsius(signed(m[1] as string, m[2] as string))}.`);
    } else if ((m = /^4([01])(\d{3})([01])(\d{3})$/.exec(t))) {
      lines.push(`Highest and lowest temperature in the last 24 hours: ${celsius(signed(m[1] as string, m[2] as string))} and ${celsius(signed(m[3] as string, m[4] as string))}.`);
    } else if ((m = /^4\/(\d{3})$/.exec(t))) {
      lines.push(`Snow on the ground: ${Number(m[1])} in deep.`);
    } else if ((m = /^5([0-8])(\d{3})$/.exec(t))) {
      const a = Number(m[1]);
      const hpa = Number(m[2]) / 10;
      lines.push(`Pressure over the last 3 hours: ${TENDENCY[a]}, by ${dec(hpa)} hPa${a === 4 ? '' : a < 4 ? ' (higher than 3 hours ago)' : ' (lower than 3 hours ago)'}.`);
    } else if ((m = /^98(\d{3})$/.exec(t))) {
      lines.push(`${Number(m[1])} minutes of sunshine yesterday.`);
    } else if (SENSOR[t]) lines.push(SENSOR[t] as string);
    else if (t === 'PK' && tokens[i + 1] === 'WND' && (m = /^(\d{3})(\d{2,3})\/(\d{2,4})$/.exec(tokens[i + 2] ?? ''))) {
      lines.push(`Peak wind in the last hour: from ${m[1]}° at ${Number(m[2])} knots, at ${m[3]!.length === 4 ? `${m[3]!.slice(0, 2)}:${m[3]!.slice(2)}` : `${m[3]} minutes past the hour`}.`);
      i += 2;
    } else if (t === 'WSHFT' && /^\d{2,4}$/.test(tokens[i + 1] ?? '')) {
      const at = tokens[i + 1] as string;
      const front = tokens[i + 2] === 'FROPA';
      lines.push(`The wind shifted at ${at.length === 4 ? `${at.slice(0, 2)}:${at.slice(2)}` : `${at} minutes past the hour`}${front ? ', with a weather front passing' : ''}.`);
      i += front ? 2 : 1;
    } else if ((t === 'TWR' || t === 'SFC') && tokens[i + 1] === 'VIS') {
      const parts: string[] = [];
      let j = i + 2;
      while (j < tokens.length && /^\d+(\/\d+)?$/.test(tokens[j] as string)) parts.push(tokens[j++] as string);
      if (parts.length > 0) {
        lines.push(`Visibility from the ${t === 'TWR' ? 'control tower' : 'ground'}: ${parts.join(' ')} ${parts.join(' ') === '1' ? 'mile' : 'miles'}.`);
        i = j - 1;
      } else unread.push(shown(t));
    } else if (t === 'VIRGA') lines.push('Virga: rain that evaporates before it reaches the ground.');
    else if (t === 'NOSPECI') lines.push('No special reports are issued from this station between the routine ones.');
    else if (t === 'FIRST' || t === 'LAST') lines.push(`This is the ${t.toLowerCase()} report from the station for now.`);
    else if ((m = /^(?:(OCNL|FRQ|CONS)\s*)?LTG((?:CG|IC|CC|CA)*)$/.exec(t)) || (/^(OCNL|FRQ|CONS)$/.test(t) && /^LTG/.test(tokens[i + 1] ?? ''))) {
      const freqTok = /^(OCNL|FRQ|CONS)$/.test(t) ? t : (m?.[1] ?? '');
      const typeTok = /^(OCNL|FRQ|CONS)$/.test(t) ? (tokens[++i] as string) : t;
      const mm = /^LTG((?:CG|IC|CC|CA)*)$/.exec(typeTok);
      const kinds = ((mm?.[1] ?? '').match(/../g) ?? []).map((k) => ({ CG: 'cloud to ground', IC: 'within the cloud', CC: 'cloud to cloud', CA: 'cloud to air' })[k] as string);
      const where: string[] = [];
      while (DIRECTIONS.has(tokens[i + 1] ?? '')) {
        where.push(dirWord(tokens[++i] as string));
      }
      const freq = freqTok === 'OCNL' ? 'Occasional' : freqTok === 'FRQ' ? 'Frequent' : freqTok === 'CONS' ? 'Continuous' : 'Some';
      lines.push(`${freq} lightning${kinds.length ? ` (${kinds.join(', ')})` : ''}${where.length ? `, ${where.join(' ')}` : ''}.`);
    } else if ((t === 'TS' || t === 'CB' || t === 'TCU' || t === 'ACC') && DIRECTIONS.has(tokens[i + 1] ?? '')) {
      // "TS SE MOV NE", "CB DSNT S", "TCU W": where the storm cloud is, and where it is heading.
      const what = t === 'TS' ? 'Thunderstorm' : t === 'CB' ? 'Thunderstorm cloud (cumulonimbus)' : t === 'TCU' ? 'Towering cumulus' : 'Altocumulus castellanus (a sign of unstable air)';
      const where: string[] = [];
      while (DIRECTIONS.has(tokens[i + 1] ?? '')) where.push(dirWord(tokens[++i] as string));
      let heading = '';
      if (tokens[i + 1] === 'MOV' && DIRECTIONS.has(tokens[i + 2] ?? '')) {
        heading = `, moving ${dirWord(tokens[i + 2] as string)}`;
        i += 2;
      }
      lines.push(`${what} ${where.join(' ')}${heading}.`);
    } else if ((m = /^(?:R(\d{2}[LCR]?)\/)?QFE(\d{3,4})(?:\/(\d{3,4}))?$/.exec(t))) {
      const at = m[1] ? ` for runway ${m[1]}` : '';
      lines.push(`Pressure at the airfield (QFE)${at}: ${m[2]} mmHg${m[3] ? ` (${Number(m[3])} hPa)` : ''}.`);
    } else if ((m = /^RF(\d{2}\.\d)\/(\d{3}\.\d)$/.exec(t))) {
      lines.push(`Rain: ${Number(m[1])} mm in the last 10 minutes and ${Number(m[2])} mm since 09:00 local time.`);
    } else if (/^(?:(?:SF|ST|SC|NS|CU|CB|TCU|AC|AS|CC|CS|CI|CF)\d)+$/.test(t)) {
      const parts = (t.match(/(SF|ST|SC|NS|CU|CB|TCU|AC|AS|CC|CS|CI|CF)(\d)/g) ?? []).map((g) => {
        const mm = /^([A-Z]+)(\d)$/.exec(g) as RegExpExecArray;
        return `${CLOUD_TYPES[mm[1] as string]} ${mm[2]}/8`;
      });
      lines.push(`Cloud by type (eighths of the sky): ${parts.join(', ')}.`);
    } else if ((m = /^([QA])(\d{4})$/.exec(t))) {
      lines.push(`A second pressure reading: ${describePressure(m[1] as string, m[2] as string).replace(/ This is the.*$/, '')}`);
    } else if (colour) lines.push(colour);
    else if ((t === 'TEMPO' || t === 'BECMG') && describeColour(tokens[i + 1] ?? '')) {
      lines.push(`Colour state forecast, ${t === 'TEMPO' ? 'temporarily' : 'gradually becoming'}: ${describeColour(tokens[++i] as string) as string}`);
    }
    else unread.push(shown(t));
  }
  return { lines, unread };
}

/* ------------------------------------------------------------------ trend */

/** The words for one change group's content tokens (wind, visibility, weather, cloud). */
function describeChange(tokens: string[]): string[] {
  const out: string[] = [];
  for (let i = 0; i < tokens.length; i++) {
    const t = tokens[i] as string;
    const w = parseWind(t);
    if (w) {
      out.push(describeWind(w, false));
      continue;
    }
    if (t === 'CAVOK') {
      out.push('CAVOK: visibility 10 km or more, no significant cloud and no significant weather.');
      continue;
    }
    const v = parseVisibility(tokens, i);
    if (v) {
      out.push(`Visibility ${lower(describeVisibility(v.vis, false))}`);
      i += v.used - 1;
      continue;
    }
    const wx = describeWeather(t);
    if (wx) {
      out.push(wx);
      continue;
    }
    if (t === 'NSC') {
      out.push('No significant cloud.');
      continue;
    }
    const layer = parseLayer(t);
    if (layer) {
      out.push(describeLayer(layer));
      continue;
    }
    const vv = /^VV(\d{3})$/.exec(t);
    if (vv) {
      out.push(`Sky obscured, vertical visibility ${whole(Number(vv[1]) * 100)} ft.`);
      continue;
    }
    out.push(`(${shown(t)})`);
  }
  return out;
}

function hhmm(s: string): string {
  return `${s.slice(0, 2)}:${s.slice(2)} UTC`;
}

/** The forecast part ("NOSIG", "BECMG FM1100 ...", "TEMPO TL0430 ...") as plain sentences. */
function describeTrend(tokens: string[]): string[] {
  const lines: string[] = [];
  let i = 0;
  while (i < tokens.length) {
    const t = tokens[i] as string;
    if (t === 'NOSIG') {
      lines.push('No significant change is expected in the next 2 hours.');
      i++;
      continue;
    }
    if (t === 'BECMG' || t === 'TEMPO') {
      i++;
      const when: string[] = [];
      while (i < tokens.length && /^(FM|TL|AT)\d{4}$/.test(tokens[i] as string)) {
        const q = tokens[i++] as string;
        when.push(`${q.startsWith('FM') ? 'from' : q.startsWith('TL') ? 'until' : 'at'} ${hhmm(q.slice(2))}`);
      }
      const content: string[] = [];
      while (i < tokens.length && tokens[i] !== 'BECMG' && tokens[i] !== 'TEMPO' && tokens[i] !== 'NOSIG') content.push(tokens[i++] as string);
      const head = t === 'BECMG' ? 'Gradually changing' : 'Temporarily';
      lines.push(`${head}${when.length ? ` ${when.join(' ')}` : ''}: ${describeChange(content).join(' ') || 'no details given.'}`);
      continue;
    }
    lines.push(`(${shown(t)})`);
    i++;
  }
  return lines;
}

/* ------------------------------------------------------------------ the whole report */

const TIME_RE = /^(\d{2})(\d{2})(\d{2})Z$/;
const ordinal = (n: number): string => {
  const s = ['th', 'st', 'nd', 'rd'];
  const v = n % 100;
  return `${n}${s[(v - 20) % 10] ?? s[v] ?? s[0]}`;
};

/** The moment (epoch ms) of day-of-month `day` at hh:mm UTC that is nearest to `now`: a METAR gives no month or year. */
export function placeInTime(day: number, hour: number, minute: number, now: number): number | null {
  if (day < 1 || day > 31 || hour > 23 || minute > 59) return null;
  const base = new Date(now);
  let best: number | null = null;
  for (const monthOffset of [-1, 0, 1]) {
    const probe = new Date(Date.UTC(base.getUTCFullYear(), base.getUTCMonth() + monthOffset, 1));
    const candidate = Date.UTC(probe.getUTCFullYear(), probe.getUTCMonth(), day, hour, minute);
    if (new Date(candidate).getUTCDate() !== day) continue; // that month has no such day
    if (best === null || Math.abs(candidate - now) < Math.abs(best - now)) best = candidate;
  }
  return best;
}

/**
 * Does this text start like a METAR (an optional "METAR"/"SPECI", a four-character airport, and a day-and-time group such as
 * `161350Z`)? Used to tell a pasted report from other text, so it is deliberately strict.
 */
export function looksLikeMetar(text: string): boolean {
  return /^\s*(?:(?:METAR|SPECI)\s+)?(?:(?:COR|CCA|CCB)\s+)?[A-Z][A-Z0-9]{3}\s+\d{6}Z(?:\s|=|$)/i.test(text);
}

/** `text` upper-cased and cleaned to one line, without the end mark. */
function tidy(text: string): string {
  return text
    .replace(/[\u0000-\u001f\u007f]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .replace(/\s*=+$/, '')
    .toUpperCase();
}

export interface DecodeOptions {
  /** The current time, to say which day and month the report is from. */
  now?: number;
  /** The airport, when the report does not start with it. */
  station?: string;
}

/**
 * Decode a METAR. Null if the text has no day-and-time group, which is how every report begins after its airport.
 */
export function decodeMetar(input: string, opts: DecodeOptions = {}): DecodedMetar | null {
  const raw = tidy(input);
  if (!raw) return null;
  const tokens = raw.split(' ');
  let i = 0;

  let kind: DecodedMetar['kind'] = 'METAR';
  if (tokens[i] === 'METAR' || tokens[i] === 'SPECI') kind = tokens[i++] === 'SPECI' ? 'SPECI' : 'METAR';
  let corrected = false;
  if (/^(COR|CCA|CCB|CCC)$/.test(tokens[i] ?? '')) {
    corrected = true;
    i++;
  }
  let station: string | null = opts.station?.toUpperCase() ?? null;
  if (/^[A-Z][A-Z0-9]{3}$/.test(tokens[i] ?? '') && !TIME_RE.test(tokens[i] as string)) station = tokens[i++] as string;
  const timeMatch = TIME_RE.exec(tokens[i] ?? '');
  if (!timeMatch) return null;
  i++;
  const day = Number(timeMatch[1]);
  const hour = Number(timeMatch[2]);
  const minute = Number(timeMatch[3]);
  const clock = `${timeMatch[2]}:${timeMatch[3]} UTC`;
  const observedAt = opts.now === undefined ? null : placeInTime(day, hour, minute, opts.now);
  const when = `the ${ordinal(day)} at ${clock}`;

  let auto = false;
  for (;;) {
    const t = tokens[i];
    if (t === 'AUTO') auto = true;
    else if (/^(COR|CCA|CCB|CCC)$/.test(t ?? '')) corrected = true;
    else break;
    i++;
  }

  const base: Omit<DecodedMetar, 'summary' | 'sections' | 'category' | 'unread' | 'remarksUnread' | 'nil'> = { raw, station, kind, auto, corrected, observedAt, when, usStyleRating: /^(K|C|PA|PH|PG|PW|PM|TJ|TI)/.test(station ?? '') };

  if (tokens[i] === 'NIL') {
    return {
      ...base,
      nil: true,
      summary: `${station ?? 'This station'} sent no weather report for ${when} (NIL). The station may be closed or its equipment may be out of order.`,
      category: null,
      sections: [],
      unread: [],
      remarksUnread: [],
    };
  }

  /* the main body, up to the trend or the remarks */
  let wind: Wind | null = null;
  let windVar: string | null = null;
  let vis: Visibility | null = null;
  const minVis: string[] = [];
  let cavok = false;
  const rvr: string[] = [];
  const weather: string[] = [];
  let weatherMissing = false;
  const recent: string[] = [];
  let recentMissing = false;
  const layers: Layer[] = [];
  const skyNotes: string[] = [];
  let vv: number | 'unknown' | null = null;
  let temp: number | null = null;
  let dew: number | null = null;
  let tempText: string | null = null;
  let pressure: string | null = null;
  const morePressure: string[] = [];
  const other: string[] = [];
  const runway: string[] = [];
  const colours: string[] = [];
  const unread: string[] = [];
  let sawPressure = false;

  const isBodyEnd = (t: string) => t === 'RMK' || t === 'NOSIG' || t === 'BECMG' || t === 'TEMPO';

  while (i < tokens.length && !isBodyEnd(tokens[i] as string)) {
    const t = tokens[i] as string;
    let m: RegExpExecArray | null;

    const w = parseWind(t);
    if (w && wind === null) {
      wind = w;
      i++;
      continue;
    }
    if ((m = /^(\d{3})V(\d{3})$/.exec(t)) && wind) {
      windVar = `The direction varied between ${m[1]}° and ${m[2]}° (clockwise).`;
      i++;
      continue;
    }
    if (t === 'CAVOK') {
      cavok = true;
      i++;
      continue;
    }
    // Visibility comes before the weather and cloud groups; a second one is a minimum in a direction ("1400SW").
    const v: ReturnType<typeof parseVisibility> = vis === null || /^\d{4}(N|NE|E|SE|S|SW|W|NW)$/.test(t) ? parseVisibility(tokens, i) : null;
    if (v && layers.length === 0 && weather.length === 0 && !sawPressure) {
      if (vis === null) vis = v.vis;
      else minVis.push(`Lowest visibility ${lower(describeVisibility(v.vis, false))}`);
      i += v.used;
      continue;
    }
    const rv = describeRvr(t);
    if (rv) {
      rvr.push(rv);
      i++;
      continue;
    }
    if (t === 'SNOCLO') {
      runway.push('The airport is closed because of snow (SNOCLO).');
      i++;
      continue;
    }
    if ((m = /^R(\d{2}[LCR]?)\/(CLRD(?:\d{2}|\/\/))$/.exec(t))) {
      runway.push(`${cap(runwayText(m[1] as string))} has been cleared of its contamination${m[2]!.length === 6 && !m[2]!.endsWith('//') ? `, ${frictionText(m[2]!.slice(4))}` : ''}.`);
      i++;
      continue;
    }
    if ((m = /^R(\d{2}[LCR]?|88|99)\/([0-9/]{6})$/.exec(t))) {
      const s = describeRunwayState(m[2] as string, m[1] as string);
      if (s) {
        runway.push(s);
        i++;
        continue;
      }
    }
    if (sawPressure && /^\d{8}$/.test(t)) {
      const s = describeRunwayState(t.slice(2), t.slice(0, 2));
      if (s) {
        runway.push(s);
        i++;
        continue;
      }
    }
    if ((m = /^RE((?:\+|-)?(?:MI|BC|PR|DR|BL|SH|TS|FZ)?(?:(?:DZ|RA|SN|SG|IC|PL|GR|GS|UP|BR|FG|FU|VA|DU|SA|HZ|PY|PO|SQ|FC|SS|DS)+)?|\/\/)$/.exec(t)) && t !== 'RE') {
      if (m[1] === '//') recentMissing = true;
      else recent.push((describeWeather((m[1] as string).replace(/^[+-]/, '')) ?? shown(t)).replace(/\.$/, ''));
      i++;
      continue;
    }
    if (t === 'WS') {
      const a = tokens[i + 1];
      const b = tokens[i + 2];
      if (a === 'ALL' && b === 'RWY') {
        other.push('Wind shear (a sudden change of wind) was reported on all runways.');
        i += 3;
        continue;
      }
      if (a === 'RWY' && b && /^\d{2}[LCR]?$/.test(b)) {
        other.push(`Wind shear (a sudden change of wind) was reported on ${runwayText(b)}.`);
        i += 3;
        continue;
      }
      if (a && /^R\d{2}[LCR]?$/.test(a)) {
        other.push(`Wind shear (a sudden change of wind) was reported on ${runwayText(a.slice(1))}.`);
        i += 2;
        continue;
      }
    }
    if ((m = /^W(M?\d{2}|\/\/)\/(?:S(\d|\/)|H(\d{1,3}|\/\/\/))$/.exec(t))) {
      const water = tempValue(m[1] as string);
      const state = m[2] !== undefined && m[2] !== '/' ? `sea state ${m[2]}, ${SEA_STATE[Number(m[2])]}` : m[3] !== undefined && m[3] !== '///' ? `waves ${dec(Number(m[3]) / 10)} m high` : 'sea state not reported';
      other.push(`Sea: ${water === null ? 'temperature not reported' : `water ${celsius(water)}`}, ${state}.`);
      i++;
      continue;
    }
    const wx = describeWeather(t);
    if (wx && !/^(SKC|CLR|NSC|NCD)$/.test(t) && !(t === '//' && layers.length > 0)) {
      if (t === 'NSW') {
        i++;
        continue;
      }
      if (t === '//') weatherMissing = true;
      else weather.push(wx);
      i++;
      continue;
    }
    if (t === 'SKC') {
      skyNotes.push('Sky clear: no cloud.');
      i++;
      continue;
    }
    if (t === 'CLR') {
      skyNotes.push('Clear: no cloud was seen below the height the automatic sensor can see (12,000 ft at US stations).');
      i++;
      continue;
    }
    if (t === 'NSC') {
      skyNotes.push('No significant cloud: none below 5,000 ft and no thunderstorm cloud.');
      i++;
      continue;
    }
    if (t === 'NCD') {
      skyNotes.push('No cloud detected (automatic station).');
      i++;
      continue;
    }
    if ((m = /^VV(\d{3}|\/\/\/)$/.exec(t))) {
      vv = m[1] === '///' ? 'unknown' : Number(m[1]) * 100;
      i++;
      continue;
    }
    if (t === '//////' || t === '///') {
      skyNotes.push('Cloud was not reported (the sensor gave nothing).');
      i++;
      continue;
    }
    const layer = parseLayer(t);
    if (layer) {
      layers.push(layer);
      i++;
      continue;
    }
    if ((m = /^(M?\d{2}|\/\/)\/(M?\d{2}|\/\/)?$/.exec(t)) && temp === null && dew === null && tempText === null) {
      temp = tempValue(m[1] as string);
      dew = tempValue((m[2] as string | undefined) ?? '');
      tempText = t;
      i++;
      continue;
    }
    if ((m = /^([QA])(\d{4}|\/{4})$/.exec(t))) {
      if (pressure === null) pressure = describePressure(m[1] as string, m[2] as string);
      else morePressure.push(`The same station also gave ${describePressure(m[1] as string, m[2] as string).replace(/ This is the .*$/, '')}`);
      sawPressure = true;
      i++;
      continue;
    }
    const colour = describeColour(t);
    if (colour) {
      colours.push(colour);
      i++;
      continue;
    }
    unread.push(shown(t));
    i++;
  }

  /* the forecast part, and the remarks */
  const trendTokens: string[] = [];
  while (i < tokens.length && tokens[i] !== 'RMK') trendTokens.push(tokens[i++] as string);
  const remarkTokens = tokens[i] === 'RMK' ? tokens.slice(i + 1) : [];
  const remarks = decodeRemarks(remarkTokens);

  /* the exact temperature in the remarks, if any, beats the whole degrees */
  const exact = remarkTokens.map((t) => /^T([01])(\d{3})([01])(\d{3})$/.exec(t)).find(Boolean) ?? null;
  if (exact) {
    temp = signed(exact[1] as string, exact[2] as string);
    dew = signed(exact[3] as string, exact[4] as string);
  }

  /* put it together */
  const sections: MetarSection[] = [];
  const head: string[] = [`Observed ${when}.`];
  if (kind === 'SPECI') head.push('A special report, issued because the weather changed (not the routine hourly one).');
  if (auto) head.push('Made automatically, with nobody watching the weather.');
  if (corrected) head.push('A corrected report.');
  sections.push({ title: 'The report', lines: head });

  if (wind) sections.push({ title: 'Wind', lines: [describeWind(wind), ...(windVar ? [windVar] : [])] });

  const visLines: string[] = [];
  if (cavok) visLines.push('CAVOK ("ceiling and visibility OK"): visibility 10 km or more, no cloud below 5,000 ft, no thunderstorm cloud and no significant weather.');
  else if (vis) visLines.push(describeVisibility(vis));
  visLines.push(...minVis, ...rvr);
  if (visLines.length > 0) sections.push({ title: 'Visibility', lines: visLines });

  const wxLines = [...weather];
  if (wxLines.length === 0 && weatherMissing) wxLines.push('The automatic station did not report present weather (its weather sensor gave nothing), so rain or fog could still be there.');
  else if (wxLines.length === 0 && !cavok) wxLines.push('No significant weather.');
  if (cavok) wxLines.push('No significant weather.');
  wxLines.push(...recent.map((r) => `Recently (in the last hour): ${r.charAt(0).toLowerCase()}${r.slice(1)}.`));
  if (recentMissing) wxLines.push('Recent weather was not reported.');
  sections.push({ title: 'Weather', lines: wxLines });

  const skyLines: string[] = [];
  if (cavok) skyLines.push('No cloud below 5,000 ft and no thunderstorm cloud (CAVOK).');
  const lowestCeiling = layers.reduce<Layer | null>((low, l) => ((l.amount === 'BKN' || l.amount === 'OVC') && l.ft !== null && (low === null || l.ft < (low.ft as number)) ? l : low), null);
  skyLines.push(...skyNotes, ...layers.map((l) => describeLayer(l, l === lowestCeiling && !(typeof vv === 'number' && vv < (l.ft as number)))));
  if (vv !== null) skyLines.push(vv === 'unknown' ? 'The sky is hidden (fog or similar) and the vertical visibility could not be measured.' : `The sky is hidden (fog or similar). You can see straight up ${whole(vv)} ft (${whole(vv * FT_M)} m): this counts as the ceiling.`);
  if (skyLines.length > 0) sections.push({ title: 'Clouds', lines: skyLines });

  const tempLines: string[] = [];
  if (tempText !== null) {
    if (temp !== null) tempLines.push(`Temperature ${celsius(temp)}.`);
    if (dew !== null) tempLines.push(`Dew point ${celsius(dew)}.`);
    if (temp !== null && dew !== null) {
      const rh = relativeHumidity(temp, dew);
      tempLines.push(`Humidity about ${Math.round(rh)}%.${temp - dew <= 2 && temp - dew >= 0 ? ' The temperature and dew point are very close, so fog or low cloud can form easily.' : ''}`);
    }
    if (temp === null && dew === null) tempLines.push('Temperature was not reported.');
    if (temp !== null && temp <= 0 && (weather.length > 0 || layers.length > 0)) tempLines.push('At or below freezing: watch for ice.');
  }
  if (tempLines.length > 0) sections.push({ title: 'Temperature', lines: tempLines });
  if (pressure) sections.push({ title: 'Pressure', lines: [pressure, ...morePressure] });

  const extra = [...other, ...runway, ...colours];
  if (extra.length > 0) sections.push({ title: 'Other details', lines: extra });

  const trendLines = describeTrend(trendTokens);
  if (trendLines.length > 0) sections.push({ title: 'Next two hours', lines: trendLines });
  if (remarks.lines.length > 0) sections.push({ title: 'Remarks', lines: remarks.lines });

  /* the rating and the one-paragraph summary */
  const ceilings = [...layers.filter((l) => (l.amount === 'BKN' || l.amount === 'OVC') && l.ft !== null).map((l) => l.ft as number), ...(typeof vv === 'number' ? [vv] : [])];
  const ceiling = ceilings.length > 0 ? Math.min(...ceilings) : null;
  const visMetres = cavok ? 10000 : (vis?.metres ?? null);
  const hasSky = cavok || layers.length > 0 || skyNotes.length > 0 || vv !== null;
  const category = categoryOf(visMetres, hasSky ? ceiling : null);

  const bits: string[] = [];
  if (wind && wind.speed !== null) {
    const kt = toKnots(wind.speed, wind.unit);
    bits.push(kt < 1 ? 'calm wind' : `${windStrength(kt)} wind${wind.dir === 'VRB' ? '' : typeof wind.dir === 'number' ? ` from the ${compass(wind.dir)}` : ''} at ${whole(kt)} ${plural(Math.round(kt), 'knot')}${wind.gust !== null ? `, gusting ${whole(toKnots(wind.gust, wind.unit))}` : ''}`);
  }
  if (cavok) bits.push('visibility 10 km or more');
  else if (vis && vis.metres !== null) bits.push(`${visWord(vis.metres)} visibility`);
  const wxShort = weather.map((w) => w.replace(/\.$/, '').toLowerCase());
  bits.push(wxShort.length > 0 ? wxShort.join(' and ') : weatherMissing ? 'weather not reported' : 'no significant weather');
  if (ceiling !== null) bits.push(`cloud ceiling ${whole(ceiling)} ft`);
  else if (cavok || skyNotes.length > 0 || layers.length > 0) bits.push(layers.length > 0 ? `lowest cloud ${whole(Math.min(...layers.map((l) => l.ft ?? Infinity)))} ft` : 'no significant cloud');
  if (temp !== null) bits.push(`${dec(temp)}°C`);
  const rating = category ? ` Flying conditions by the US-style rating: ${category}.` : '';
  const summary = `${cap(bits.join(', '))}.${rating}`;

  return { ...base, nil: false, summary, category, sections, unread: [...unread, ...trendUnread(trendLines)], remarksUnread: remarks.unread };
}

/** Pieces of the forecast part that were left in brackets because they were not understood. */
function trendUnread(lines: string[]): string[] {
  return lines.flatMap((l) => l.match(/\([A-Z0-9/+-]{1,24}\)/g) ?? []).map((s) => s.slice(1, -1));
}
