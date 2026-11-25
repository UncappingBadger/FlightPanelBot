import { plainText } from '../util/format.js';

/**
 * Landing safety and pay. An airline can link what its pilots are paid to how hard they land (`/setup safety-pay`), with limits it sets for each type
 * of aircraft it flies (set on the host's settings page, `src/services/airlineSettings.ts`). A landing falls in one of three bands, by how hard it was:
 *
 *  - Warning, from the aircraft's warning limit: a warning by private message, and no fine.
 *  - Tier 1, from its Tier 1 limit: the pilot is paid a share of the flight's profit (8% to start with) instead of 15%, to offset the aircraft damage and the lost
 *    customer satisfaction.
 *  - Tier 2, from its Tier 2 limit: the pilot is paid a smaller share (5% to start with).
 *
 * Every number here is the airline's to set: the three limits (for the airline, and for each aircraft type that is to differ), the two shares, and how much of the
 * $2,000 minimum pay a pilot loses after each pay cut. A new airline starts at limits of 400, 500 and 600 feet per minute; an airline that had safety pay on
 * before the limits could be set kept the 375, 400 and 600 it had (the Tier 1 and Tier 2 it has now were then called Tier 2 and Tier 3, and the warning Tier 1).
 *
 * FsHub records a landing's rate as a negative number (a descent). Here the rate is spoken of as feet per minute without its sign: 450 is -450.
 * Only a flight that landed after the airline turned this on is touched. Nothing here reads a sheet or sends a message: it is the rules.
 */

/** A rate beyond this is not believed as a touchdown (a bad reading from the sim or the tracker). No limit can be set above it. */
export const IMPLAUSIBLE_FPM = 2500;

/** What a new airline starts with, in feet per minute: a warning from 400, Tier 1 from 500, Tier 2 from 600. */
export const STARTING_LIMITS: SafetyLimits = { warn: 400, tier1: 500, tier2: 600 };
/** The share of a flight's profit a pilot is paid after a Tier 1 or Tier 2 landing that a new airline starts with, in per cent. */
export const STARTING_SHARE_TIER1 = 8;
export const STARTING_SHARE_TIER2 = 5;

/** How hard a landing has to be to fall in each band, in feet per minute without the sign: a landing at least that hard is in it (and in no harder one). */
export interface SafetyLimits {
  warn: number;
  tier1: number;
  tier2: number;
}

/** The band a landing falls in. */
export type SafetyTier = 'warning' | 'tier1' | 'tier2';
/** A band that cuts pay. */
export type FineTier = 'tier1' | 'tier2';

/** What a band is called to people. */
export const tierName = (tier: SafetyTier): string => (tier === 'tier2' ? 'Tier 2' : tier === 'tier1' ? 'Tier 1' : 'Warning');

/** Whether limits can be used: whole numbers of feet per minute from 1 to the most that is believed as a touchdown, each at least as hard as the one before. Null when they can; otherwise what is wrong. */
export function checkLimits(l: SafetyLimits): string | null {
  for (const [name, v] of [['warning', l.warn], ['Tier 1', l.tier1], ['Tier 2', l.tier2]] as const) {
    if (!Number.isInteger(v) || v < 1 || v > IMPLAUSIBLE_FPM) return `The ${name} limit has to be a whole number of feet per minute from 1 to ${IMPLAUSIBLE_FPM.toLocaleString('en-US')}.`;
  }
  if (l.warn > l.tier1) return `The warning limit (${l.warn}) can't be harder than the Tier 1 limit (${l.tier1}): a warning comes first, then Tier 1, then Tier 2.`;
  if (l.tier1 > l.tier2) return `The Tier 1 limit (${l.tier1}) can't be harder than the Tier 2 limit (${l.tier2}): a warning comes first, then Tier 1, then Tier 2.`;
  return null;
}

/** An aircraft type as it is kept: its ICAO code in upper case (A20N, B738), or null when there is none to speak of. */
export function normalizeAircraft(code: string | null | undefined): string | null {
  const t = (code ?? '').trim().toUpperCase();
  return /^[A-Z0-9]{2,8}$/.test(t) ? t : null;
}

/** What FsHub's landing rate for a flight comes to. */
export type Landing =
  /** FsHub gave no landing rate (or one that is not a descent). */
  | { kind: 'none' }
  /** A rate too hard to believe as a touchdown. */
  | { kind: 'unreliable'; fpm: number }
  /** A usable rate, and its band (null for a landing gentler than the warning limit). */
  | { kind: 'ok'; fpm: number; tier: SafetyTier | null };

/** The band of a landing from FsHub's rate (negative for a descent), by the limits of the aircraft that flew it. */
export function readLanding(rate: number | null | undefined, limits: SafetyLimits): Landing {
  if (rate === null || rate === undefined || !Number.isFinite(rate) || rate >= 0) return { kind: 'none' };
  const fpm = Math.round(Math.abs(rate));
  if (fpm > IMPLAUSIBLE_FPM) return { kind: 'unreliable', fpm };
  const tier: SafetyTier | null = fpm >= limits.tier2 ? 'tier2' : fpm >= limits.tier1 ? 'tier1' : fpm >= limits.warn ? 'warning' : null;
  return { kind: 'ok', fpm, tier };
}

/** How an airline has set safety pay up. */
export interface SafetyPolicy {
  /** From when it applies: a flight that landed before this is paid as it always was. */
  since: number;
  /** The percentage (0 to 100) of the $2,000 minimum pay a pilot loses after a Tier 1 landing, and after a Tier 2 landing: 0 keeps the whole minimum. */
  lossTier1: number;
  lossTier2: number;
  /** The percentage (0 to 100) of a flight's profit a pilot is paid after a Tier 1 landing, and after a Tier 2 landing. */
  shareTier1: number;
  shareTier2: number;
  /** The airline's limits for an aircraft that has none of its own. */
  defaults: SafetyLimits;
  /** The limits of the aircraft types that have their own, by ICAO code (upper case). */
  byAircraft: ReadonlyMap<string, SafetyLimits>;
}

/** The limits that judge a landing in this aircraft (its own, else the airline's default). */
export function limitsFor(policy: Pick<SafetyPolicy, 'defaults' | 'byAircraft'>, aircraft: string | null | undefined): SafetyLimits {
  const type = normalizeAircraft(aircraft);
  return (type !== null ? policy.byAircraft.get(type) : undefined) ?? policy.defaults;
}

/** The percentage of the minimum pay lost after a landing in this band (a warning costs nothing). */
export const lossForTier = (policy: Pick<SafetyPolicy, 'lossTier1' | 'lossTier2'>, tier: SafetyTier): number => (tier === 'tier2' ? policy.lossTier2 : tier === 'tier1' ? policy.lossTier1 : 0);

/** The share of the profit a pilot is paid after a landing in this band, in per cent. */
export const shareForTier = (policy: Pick<SafetyPolicy, 'shareTier1' | 'shareTier2'>, tier: FineTier): number => (tier === 'tier2' ? policy.shareTier2 : policy.shareTier1);

/** The settings of a panel that safety pay is made of. */
export interface SafetyPanelSettings {
  safetyPaySince: number | null;
  safetyLossTier1: number;
  safetyLossTier2: number;
  safetyShareTier1: number;
  safetyShareTier2: number;
  safetyWarnFpm: number;
  safetyTier1Fpm: number;
  safetyTier2Fpm: number;
}

/** The policy of a panel (with the limits its aircraft types have of their own), or null when safety pay is off for it. */
export const safetyPolicyOf = (panel: SafetyPanelSettings, byAircraft: ReadonlyMap<string, SafetyLimits> = new Map()): SafetyPolicy | null =>
  panel.safetyPaySince === null
    ? null
    : {
        since: panel.safetyPaySince,
        lossTier1: panel.safetyLossTier1,
        lossTier2: panel.safetyLossTier2,
        shareTier1: panel.safetyShareTier1,
        shareTier2: panel.safetyShareTier2,
        defaults: { warn: panel.safetyWarnFpm, tier1: panel.safetyTier1Fpm, tier2: panel.safetyTier2Fpm },
        byAircraft,
      };

/** A landing whose pay is cut, and how. */
export interface SafetyFine {
  tier: FineTier;
  fpm: number;
  /** The percentage of the $2,000 minimum pay the pilot loses. */
  minimumLoss: number;
  /** The percentage of the flight's profit the pilot is paid instead of the usual 15%. */
  share: number;
  /** The limit of the band, as the aircraft's limits had it. */
  limit: number;
  /** The aircraft's type, when it is known. */
  aircraft: string | null;
}

/**
 * The fine for a landing in this aircraft, or null (a gentler landing, a warning, no usable reading, or a landing from before safety pay was turned on).
 * `landing` was read with this aircraft's limits (see `readLanding` and `limitsFor`).
 */
export function fineFor(landing: Landing, landedAt: number, policy: SafetyPolicy | null, aircraft: string | null = null): SafetyFine | null {
  if (!policy || landedAt < policy.since || landing.kind !== 'ok' || landing.tier === null || landing.tier === 'warning') return null;
  const limits = limitsFor(policy, aircraft);
  return { tier: landing.tier, fpm: landing.fpm, minimumLoss: lossForTier(policy, landing.tier), share: shareForTier(policy, landing.tier), limit: landing.tier === 'tier2' ? limits.tier2 : limits.tier1, aircraft: normalizeAircraft(aircraft) };
}

/* ------------------------------------------------------------------ the message to the pilot */

const HEADING: Record<SafetyTier, string> = {
  warning: '⚠️ **Safety Warning**',
  tier1: '🚨 **Tier 1 Safety Violation**',
  tier2: '🛑 **Tier 2 Critical Safety Violation**',
};

export interface SafetyNoticeSubject {
  tier: SafetyTier;
  fpm: number;
  /** `EGLL → EGKK`. */
  route: string;
  airline: string | null;
  /** The percentage of the $2,000 minimum pay the airline takes off after a Tier 1 or Tier 2 landing. */
  minimumLoss: number;
  /** The percentage of the flight's profit the pilot is paid after this landing (for a Tier 1 or Tier 2 one). */
  share: number;
  /** The limits that judged this landing: the aircraft's own, or the airline's default. */
  limits: SafetyLimits;
  /** The aircraft's type, when it is known. */
  aircraft: string | null;
}

/** The words of the message about a landing in this band, with the aircraft's limits in them. */
function noticeText(s: SafetyNoticeSubject): string {
  const { limits } = s;
  if (s.tier === 'warning') {
    return `This landing resulted in an ACCEPTABLE LEVEL of additional stress placed on the aircraft due to a HARD LANDING. There are no safety fines for landing between -${limits.warn} and -${Math.max(limits.warn, limits.tier1 - 1)}fpm, however landing rates of -${limits.tier1}fpm and harder will incur safety fines to offset aircraft damage costs and poor customer service ratings.`;
  }
  if (s.tier === 'tier1') {
    return `This landing resulted in EXCESSIVE STRESS placed on the aircraft due to a HARD LANDING between -${limits.tier1} and -${Math.max(limits.tier1, limits.tier2 - 1)}fpm. Due to this safety violation, you will receive only ${s.share}% of this flight's profits as a safety fine to offset costs of increased aircraft damage and the cost of decreased customer satisfaction caused by this flight.`;
  }
  return `This landing resulted in DANGEROUS AND EXTREME STRESS being placed on the aircraft due to an EXTREMELY HARD LANDING of -${limits.tier2}fpm and harder. Due to this safety violation, you will receive only ${s.share}% of this flight's profits as a safety fine imposed to offset the increased damage and the cost of decreased customer satisfaction caused by this landing.`;
}

/** The private message a pilot is sent about a hard landing, in the words the airline's CEO wrote, with the flight, the rate and the limits of the aircraft it is about. */
export function safetyNotice(s: SafetyNoticeSubject): string {
  const where = [`${plainText(s.route)}`, `landing rate **-${s.fpm} fpm**`, ...(s.aircraft ? [plainText(s.aircraft)] : []), ...(s.airline ? [plainText(s.airline)] : [])].join(' · ');
  const lines = [HEADING[s.tier], where, '', noticeText(s)];
  lines.push(`*${s.aircraft ? `The limits for the ${plainText(s.aircraft)}` : "The airline's limits"}: warning from -${s.limits.warn} fpm, Tier 1 from -${s.limits.tier1}, Tier 2 from -${s.limits.tier2}.*`);
  if (s.tier !== 'warning') {
    lines.push(
      s.minimumLoss <= 0
        ? "The airline's $2,000 minimum pay still applies to this flight."
        : s.minimumLoss >= 100
          ? "The airline's safety rule takes all of the $2,000 minimum pay: this flight pays only the share above, and a flight that lost money pays nothing."
          : `The airline's safety rule takes ${s.minimumLoss}% off the $2,000 minimum pay, and off the distance pay of a flight that lost money.`,
    );
  }
  return lines.join('\n');
}
