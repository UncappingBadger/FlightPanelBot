/**
 * What a pilot is paid for a flight, by the rule the airline's CEO gave:
 *
 *  - A flight that made a profit pays the pilot 15% of the profit, rounded UP to the next whole dollar (Aeroconomy has no cents), and never
 *    less than $2,000. For example 15% of $54,204 is $8,130.60, which pays $8,131, and 15% of $54,203 is $8,130.45, which also pays $8,131.
 *  - A flight that lost money still pays the pilot: a base of $2,000 (which covers the first 1,000 nautical miles flown) and $1,000 more for
 *    every further 500 nautical miles, a started 500 counting as a whole one ("1,001 nm pays $3,000; 1,502 nm pays $4,000").
 *
 * The distance is the one FsHub recorded for the flight, and the profit is the figure that goes in the sheet (whole dollars). Nothing
 * here touches a sheet: it only works the amount out.
 */

/** The share of a profit that is the pilot's, in per cent. */
export const PAY_SHARE_PERCENT = 15;
/** The least a pilot is paid for a flight. For a flight that lost money it is the base, which covers the first `BASE_COVERS_NM` nautical miles. */
export const PAY_MINIMUM = 2000;
export const BASE_COVERS_NM = 1000;
/** A flight that lost money: this much more for every further stretch of this many nautical miles, a started stretch counting as a whole one. */
export const PAY_PER_STRETCH = 1000;
export const STRETCH_NM = 500;

/** How the pay was worked out: a share of the profit, the minimum (the share was less), or the rule for a flight that lost money. */
export type PayBasis = 'share' | 'minimum' | 'distance';

export interface PilotPay {
  amount: number;
  basis: PayBasis;
}

/** Whether the pay of a flight with this profit depends on how far it was flown (it does when the flight lost money). */
export const paidByDistance = (profit: number): boolean => profit < 0;

/**
 * The pay for a flight that made `profit` dollars (negative for a loss) and was flown `distanceNm` nautical miles. A flight that lost
 * money needs its distance: without one (`null`, or anything that is not a distance) there is no pay to work out, and this says so with null.
 */
export function pilotPay(profit: number, distanceNm: number | null): PilotPay | null {
  if (!Number.isFinite(profit)) return null;
  if (paidByDistance(profit)) {
    if (distanceNm === null || !Number.isFinite(distanceNm) || distanceNm < 0) return null;
    const stretches = Math.ceil(Math.max(0, distanceNm - BASE_COVERS_NM) / STRETCH_NM);
    return { amount: PAY_MINIMUM + PAY_PER_STRETCH * stretches, basis: 'distance' };
  }
  // Up, not to the nearest: $8,130.45 is $8,131. A profit in whole dollars times 15 is a whole number, so a share that comes out even stays as it is.
  const share = Math.ceil((profit * PAY_SHARE_PERCENT) / 100);
  return share >= PAY_MINIMUM ? { amount: share, basis: 'share' } : { amount: PAY_MINIMUM, basis: 'minimum' };
}
