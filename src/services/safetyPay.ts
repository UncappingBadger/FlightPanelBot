import { plainText } from '../util/format.js';

/**
 * Landing safety and pay. An airline can link what its pilots are paid to how hard they land (`/setup safety-pay`). The rules are the CEO's:
 *
 *  - Tier 1, a landing of 375 to 399 feet per minute: a warning by private message, and no fine.
 *  - Tier 2, 400 to 599: the pilot is paid 8% of the flight's profit (instead of 15%), to offset the aircraft damage and the lost customer satisfaction.
 *  - Tier 3, 600 or harder: the pilot is paid 5% of the flight's profit.
 *
 * FsHub records a landing's rate as a negative number (a descent). Here the rate is spoken of as feet per minute without its sign: 450 is -450.
 * Only a flight that landed after the airline turned this on is touched. Nothing here reads a sheet or sends a message: it is the rules.
 */

/** A rate beyond this is not believed as a touchdown (a bad reading from the sim or the tracker). */
export const IMPLAUSIBLE_FPM = 2500;

/** Where the tiers start, in feet per minute. */
export const TIER1_FPM = 375;
export const TIER2_FPM = 400;
export const TIER3_FPM = 600;
/** The share of a flight's profit a pilot is paid after a Tier 2 or Tier 3 landing, in per cent. */
export const TIER2_SHARE_PERCENT = 8;
export const TIER3_SHARE_PERCENT = 5;

export type SafetyTier = 1 | 2 | 3;
/** A tier that cuts pay. */
export type FineTier = 2 | 3;

/** What FsHub's landing rate for a flight comes to. */
export type Landing =
  /** FsHub gave no landing rate (or one that is not a descent). */
  | { kind: 'none' }
  /** A rate too hard to believe as a touchdown. */
  | { kind: 'unreliable'; fpm: number }
  /** A usable rate, and its tier (null for a landing gentler than Tier 1). */
  | { kind: 'ok'; fpm: number; tier: SafetyTier | null };

/** The tier of a landing from FsHub's rate (negative for a descent). */
export function readLanding(rate: number | null | undefined): Landing {
  if (rate === null || rate === undefined || !Number.isFinite(rate) || rate >= 0) return { kind: 'none' };
  const fpm = Math.round(Math.abs(rate));
  if (fpm > IMPLAUSIBLE_FPM) return { kind: 'unreliable', fpm };
  const tier: SafetyTier | null = fpm >= TIER3_FPM ? 3 : fpm >= TIER2_FPM ? 2 : fpm >= TIER1_FPM ? 1 : null;
  return { kind: 'ok', fpm, tier };
}

/** The share of the profit a pilot is paid after a landing of this tier, in per cent. */
export const fineShare = (tier: FineTier): number => (tier === 3 ? TIER3_SHARE_PERCENT : TIER2_SHARE_PERCENT);

/** How an airline has set safety pay up. */
export interface SafetyPolicy {
  /** From when it applies: a flight that landed before this is paid as it always was. */
  since: number;
  /** The percentage (0 to 100) of the $2,000 minimum pay a pilot loses after a Tier 2 landing, and after a Tier 3 landing: 0 keeps the whole minimum. */
  lossTier2: number;
  lossTier3: number;
}

/** The percentage of the minimum pay lost after a landing of this tier (a Tier 1 warning costs nothing). */
export const lossForTier = (policy: Pick<SafetyPolicy, 'lossTier2' | 'lossTier3'>, tier: SafetyTier): number => (tier === 3 ? policy.lossTier3 : tier === 2 ? policy.lossTier2 : 0);

/** The policy of a panel, or null when safety pay is off for it. */
export const safetyPolicyOf = (panel: { safetyPaySince: number | null; safetyLossTier2: number; safetyLossTier3: number }): SafetyPolicy | null =>
  panel.safetyPaySince === null ? null : { since: panel.safetyPaySince, lossTier2: panel.safetyLossTier2, lossTier3: panel.safetyLossTier3 };

/** A landing whose pay is cut, and how. */
export interface SafetyFine {
  tier: FineTier;
  fpm: number;
  /** The percentage of the $2,000 minimum pay the pilot loses. */
  minimumLoss: number;
}

/** The fine for a landing, or null (a gentler landing, a Tier 1 warning, no usable reading, or a landing from before safety pay was turned on). */
export function fineFor(landing: Landing, landedAt: number, policy: SafetyPolicy | null): SafetyFine | null {
  if (!policy || landedAt < policy.since || landing.kind !== 'ok' || landing.tier === null || landing.tier === 1) return null;
  return { tier: landing.tier, fpm: landing.fpm, minimumLoss: lossForTier(policy, landing.tier) };
}

/* ------------------------------------------------------------------ the message to the pilot */

const TEXT: Record<SafetyTier, string> = {
  1: 'This landing resulted in an ACCEPTABLE LEVEL of additional stress placed on the aircraft due to a HARD LANDING. There are no safety fines for landing between -375 and -399, however landing rates above -400fpm will incur safety fines to offset aircraft damage costs and poor customer service ratings.',
  2: `This landing resulted in EXCESSIVE STRESS placed on the aircraft due to a HARD LANDING between -400 and -599fpm. Due to this safety violation, you will receive only ${TIER2_SHARE_PERCENT}% of this flight's profits as a safety fine to offset costs of increased aircraft damage and the cost of decreased customer satisfaction caused by this flight.`,
  3: `This landing resulted in DANGEROUS AND EXTREME STRESS being placed on the aircraft due to an EXTREMELY HARD LANDING above -600fpm. Due to this safety violation, you will receive only ${TIER3_SHARE_PERCENT}% of this flight's profits as a safety fine imposed to offset the increased damage and the cost of decreased customer satisfaction caused by this landing.`,
};

const HEADING: Record<SafetyTier, string> = {
  1: '⚠️ **Tier 1 Safety Warning**',
  2: '🚨 **Tier 2 Safety Violation**',
  3: '🛑 **Tier 3 Critical Safety Violation**',
};

export interface SafetyNoticeSubject {
  tier: SafetyTier;
  fpm: number;
  /** `EGLL → EGKK`. */
  route: string;
  airline: string | null;
  /** The percentage of the $2,000 minimum pay the airline takes off after a Tier 2 or Tier 3 landing. */
  minimumLoss: number;
}

/** The private message a pilot is sent about a hard landing, in the words the airline's CEO wrote, with the flight and the rate it is about. */
export function safetyNotice(s: SafetyNoticeSubject): string {
  const lines = [HEADING[s.tier], `${plainText(s.route)} · landing rate **-${s.fpm} fpm**${s.airline ? ` · ${plainText(s.airline)}` : ''}`, '', TEXT[s.tier]];
  if (s.tier !== 1) {
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
