/**
 * FsHub's aircraft aliases. An Aeroconomy job asks for one aircraft type, but FsHub lets a pilot fly it in a compatible type
 * instead: the A330-300 and the A330-900, an A20N for an A320 job, a B738 for a B38M job. (Aeroconomy's own figures for the
 * aircraft stay authoritative; an alias only lets someone with a similar model, or the same aircraft from another add-on
 * maker, fly the job.) The bot does not check aircraft when it completes a flight, but it compares them to say whether a
 * pilot flew something other than what was scheduled, and it matches them when a pilot searches by aircraft type: aliases
 * count as the same aircraft in both.
 *
 * Source: the "Compatible aliases" lists on FsHub's aircraft page (https://fshub.io/aircraft-list, which needs a FsHub
 * sign-in to see), and the explanation at https://community.fshub.io/threads/636. FsHub adds aliases over time (this list was
 * short when the feature began), so this is a snapshot: refresh it with `scripts/import-aircraft-aliases.mjs`.
 */
export const ALIASES_AS_OF = '2026-11-14';

/** Each aircraft FsHub lists aliases for, and the types it counts as compatible with it. */
export const FSHUB_ALIASES: Readonly<Record<string, readonly string[]>> = {
  A20N: ['A320', 'A319', 'A321', 'A21N'],
  A21N: ['A321', 'A320', 'A319', 'A20N'],
  A319: ['A20N', 'A21N', 'A320', 'A321'],
  A320: ['A20N', 'A21N', 'A319', 'A321'],
  A321: ['A21N', 'A20N', 'A320', 'A319'],
  A332: ['A333', 'A339'],
  A333: ['A332', 'A339'],
  A339: ['A333', 'A332'],
  A343: ['A346'],
  A346: ['A343'],
  A359: ['A35K'],
  A35K: ['A359'],
  B350: ['BE9L', 'BE20'],
  B38M: ['B738'],
  B462: ['RJ85'],
  B463: ['RJ1H'],
  B58T: ['BE58'],
  B738: ['B38M'],
  BE20: ['BE9L', 'B350'],
  BE58: ['B58T'],
  BE9L: ['BE20', 'B350'],
  RJ1H: ['B463'],
  RJ85: ['B462'],
};

/** Every code that appears in the table, as the aircraft it lists aliases for or as one of the aliases. */
const KNOWN = [...new Set(Object.entries(FSHUB_ALIASES).flatMap(([type, list]) => [type, ...list]))].sort();

const norm = (type: string): string => type.trim().toUpperCase();

/**
 * The types FsHub counts as the same aircraft as `type`, not including itself. The relation is read both ways: if FsHub lists B in
 * A's aliases, A counts as compatible with B even if B's own list somehow leaves A out.
 */
export function compatibleWith(type: string, table: Readonly<Record<string, readonly string[]>> = FSHUB_ALIASES): string[] {
  const t = norm(type);
  const out = new Set<string>(table[t] ?? []);
  for (const [other, list] of Object.entries(table)) if (list.includes(t)) out.add(other);
  out.delete(t);
  return [...out];
}

/** Whether FsHub counts these two types as the same aircraft (they are the same type, or an alias of one another). */
export function isCompatible(a: string, b: string): boolean {
  const x = norm(a);
  const y = norm(b);
  return x === y || compatibleWith(x).includes(y);
}

/** Whether `flown` is a different type from `required` that FsHub counts as the same aircraft (an alias, not the type itself). */
export function isAliasUse(required: string, flown: string): boolean {
  return norm(required) !== norm(flown) && isCompatible(required, flown);
}

/** What searching for some aircraft types also looks for, because FsHub counts it as the same aircraft. */
export interface ExpandedTypes {
  /** The types typed, then the compatible ones added to them: what to match flights against. */
  codes: string[];
  /** For each typed type that brought something in: what it added (so the pilot can be told). */
  added: Array<{ type: string; also: string[] }>;
}

/**
 * Add the aliases to the types a pilot searched for, so a pilot with an A20N also finds the A320 jobs they can fly. A typed type
 * may be just the start of one (`A32`, `B73`), and then every aircraft FsHub knows that starts with it brings its aliases.
 */
export function expandAircraftTypes(typed: string[]): ExpandedTypes {
  const types = typed.map(norm);
  const codes = [...types];
  const added: ExpandedTypes['added'] = [];
  for (const t of types) {
    const also: string[] = [];
    for (const known of KNOWN) {
      if (!known.startsWith(t)) continue;
      for (const c of compatibleWith(known)) {
        // Already asked for, or already covered by something that was (a typed start of it)?
        if (codes.some((have) => c.startsWith(have)) || also.includes(c)) continue;
        also.push(c);
      }
    }
    for (const c of also) codes.push(c);
    if (also.length > 0) added.push({ type: t, also });
  }
  return { codes, added };
}

/** A line telling a pilot which aliases were added to their search, or null when none were. */
export function aliasNote(added: ExpandedTypes['added']): string | null {
  if (added.length === 0) return null;
  const parts = added.map(({ type, also }) => `${also.join(', ')} ${also.length === 1 ? 'counts' : 'count'} as the same aircraft as ${type}`);
  return `✈️ On FsHub ${parts.join('; ')}, so flights asking for ${added.length === 1 && added[0]!.also.length === 1 ? 'it' : 'those'} are included.`;
}
