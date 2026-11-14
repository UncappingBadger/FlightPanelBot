/**
 * Typical cruising speeds by kind of aircraft, for working out roughly how long a flight takes from the distance when no
 * flight of that route has been seen. These are round numbers, the usual cruise of each kind (a narrowbody airliner's
 * Mach 0.78 or so is about 440 knots on average over a flight, a light piston's 120, and so on), not any one aircraft's
 * figures: the warning says it is an estimate and what it used.
 */

export interface SpeedClass {
  /** Average speed over the ground across the whole flight, in knots. */
  kt: number;
  /** Minutes added for the climb, the descent and the approach, which are slower than the cruise. */
  allowanceMin: number;
  /** How the aircraft is described in the warning: "a narrowbody airliner". */
  label: string;
}

const CLASSES = {
  widebody: { kt: 470, allowanceMin: 20, label: 'a widebody airliner' },
  narrowbody: { kt: 440, allowanceMin: 20, label: 'a narrowbody airliner' },
  regional: { kt: 420, allowanceMin: 18, label: 'a regional jet' },
  bizjet: { kt: 400, allowanceMin: 15, label: 'a business jet' },
  turboprop: { kt: 270, allowanceMin: 12, label: 'an airliner turboprop' },
  fastprop: { kt: 250, allowanceMin: 12, label: 'a fast turboprop' },
  utility: { kt: 170, allowanceMin: 10, label: 'a light turboprop' },
  piston: { kt: 120, allowanceMin: 8, label: 'a light piston aircraft' },
  helicopter: { kt: 120, allowanceMin: 6, label: 'a helicopter' },
} as const satisfies Record<string, SpeedClass>;

export type SpeedClassName = keyof typeof CLASSES;

const MEMBERS: Record<SpeedClassName, string> = {
  widebody: 'A306 A310 A332 A333 A337 A338 A339 A342 A343 A345 A346 A359 A35K A388 A124 A3ST B741 B742 B743 B744 B748 B762 B763 B764 B772 B77L B77W B778 B779 B788 B789 B78X MD11 DC10 IL96 C17',
  narrowbody:
    'A19N A20N A21N A318 A319 A320 A321 A220 BCS1 BCS3 B37M B38M B39M B3XM B712 B731 B732 B733 B734 B735 B736 B737 B738 B739 B752 B753 MD80 MD81 MD82 MD83 MD87 MD88 MD90 DC93 DC95 F100 T154 T204',
  regional:
    'B461 B462 B463 CRJ1 CRJ2 CRJ7 CRJ9 CRJX E135 E145 E170 E175 E190 E195 E75L E75S E290 E295 F28 F70 RJ1H RJ70 RJ85 SU95',
  bizjet:
    'BE40 C25A C25B C25C C25M C500 C501 C510 C525 C550 C560 C56X C680 C68A C700 C750 CL30 CL35 CL60 E50P E545 E550 E55P EA50 F2TH F900 FA50 FA7X FA8X GL5T GL7T GLEX GLF2 GLF3 GLF4 GLF5 GLF6 H25B H25C HDJT LJ25 LJ31 LJ35 LJ45 LJ60 LJ75 PC24 PRM1 SF50',
  turboprop:
    'A400 AT42 AT43 AT44 AT45 AT46 AT72 AT73 AT75 AT76 C130 C295 D228 D328 DH8A DH8B DH8C DH8D F27 F50 JS31 JS32 JS41 L188 SB20 SF34 SH33 SH36 E120 B190',
  fastprop: 'B350 BE10 BE20 BE30 BE99 BE9L BE9T C441 PC12 TBM7 TBM8 TBM9',
  utility: 'C208 C20T DHC3 DHC4 DHC5 DHC6 E110 PC6T GA8',
  piston:
    'B17 B29 BE33 BE35 BE36 BE55 BE58 C172 C182 C185 C206 C210 C310 C340 C414 C421 DA40 DA42 DA62 DC3 DC6 DC7 DHC2 M20P M20T P51 PA28 PA32 PA34 PA44 PA46 SR20 SR22',
  helicopter:
    'A109 A139 A169 AS50 AS55 AS65 AW19 B06 B105 B407 B412 B429 EC20 EC25 EC30 EC35 EC45 EC55 EC75 G2CA H125 H135 H145 H160 H175 H47 H500 MI8 R22 R44 R66 S61 S76 S92 UH1 UH60',
};

/** Types whose usual speed is far from their kind's. */
const OVERRIDES: Record<string, number> = {
  B17: 160,
  B29: 220,
  BE9L: 220,
  BE9T: 220,
  C130: 320,
  C310: 190,
  C441: 240,
  C17: 450,
  DC3: 150,
  DC6: 250,
  DC7: 270,
  DHC2: 100,
  DHC3: 110,
  DHC4: 150,
  DHC6: 150,
  E110: 220,
  P51: 300,
  PA28: 110,
  C172: 105,
  C182: 125,
  S92: 140,
  S76: 150,
  H160: 150,
  UH1: 100,
  R22: 95,
  R44: 105,
};

const KIND_OF = new Map<string, SpeedClassName>();
for (const [kind, list] of Object.entries(MEMBERS) as Array<[SpeedClassName, string]>) {
  for (const code of list.split(' ')) KIND_OF.set(code, kind);
}

/** The typical speed for this aircraft type code. `known` is false when the type is not one the bot has a speed for. */
export interface Speed extends SpeedClass {
  known: boolean;
  kind: SpeedClassName | null;
}

export function speedFor(aircraft: string | null | undefined): Speed {
  const code = (aircraft ?? '').trim().toUpperCase();
  const kind = KIND_OF.get(code);
  if (!kind) return { ...CLASSES.narrowbody, label: 'a typical airliner', known: false, kind: null };
  const base: SpeedClass = CLASSES[kind];
  return { ...base, kt: OVERRIDES[code] ?? base.kt, known: true, kind };
}

/** The kind of aircraft this type is, or null if it is not one the bot knows. */
export function speedKindOf(aircraft: string | null | undefined): SpeedClassName | null {
  return KIND_OF.get((aircraft ?? '').trim().toUpperCase()) ?? null;
}
