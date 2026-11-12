export type TimestampStyle = 't' | 'T' | 'd' | 'D' | 'f' | 'F' | 'R';

/** Discord renders these in each viewer's own locale and timezone. */
export function ts(ms: number, style: TimestampStyle = 'f'): string {
  return `<t:${Math.floor(ms / 1000)}:${style}>`;
}

export function truncate(text: string, max: number): string {
  return text.length <= max ? text : `${text.slice(0, Math.max(0, max - 1))}…`;
}

export function mention(discordId: string): string {
  return `<@${discordId}>`;
}

/**
 * Text that came from outside (a name typed into a spreadsheet) made safe to show: Discord markdown
 * and mention syntax is neutralised so it can only ever look like plain text.
 */
export function plainText(text: string): string {
  return text.replace(/([\\*_~`|<>[\]()])/g, '\\$1').replace(/@/g, '@\u200b');
}

export function airlineLabel(a: { name: string; abbr: string | null }): string {
  return a.abbr ? `${a.name} (${a.abbr})` : a.name;
}

/** "EGLL → EGKK". */
export function legText(l: { dep: string; arr: string }): string {
  return `${l.dep} → ${l.arr}`;
}

/** "1", "1 and 3", "1, 2 and 4". */
export function legList(legNos: number[]): string {
  const sorted = [...legNos].sort((a, b) => a - b).map(String);
  if (sorted.length <= 1) return sorted.join('');
  return `${sorted.slice(0, -1).join(', ')} and ${sorted[sorted.length - 1]}`;
}

/** A whole route as one line: a chain when the legs connect, otherwise the legs separated by commas. */
export function routeText(legs: Array<{ dep: string; arr: string }>): string {
  if (legs.length === 0) return '';
  const connected = legs.every((l, i) => i === 0 || (legs[i - 1] as { arr: string }).arr === l.dep);
  if (connected) return [legs[0]!.dep, ...legs.map((l) => l.arr)].join(' → ');
  return legs.map(legText).join(', ');
}
