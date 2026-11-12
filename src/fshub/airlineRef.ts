/** How an admin says which FsHub airline they mean. */
export type AirlineRef = { kind: 'id'; id: number } | { kind: 'name'; text: string };

/**
 * Reads what an admin typed for `/setup fshub link:`: the airline's number, a link to its FsHub page
 * (fshub.io/airline/…), or its short name or full name. Null if it is none of those.
 */
export function parseAirlineRef(input: string): AirlineRef | null {
  const text = input.trim().replace(/^["'`]+|["'`]+$/g, '').trim();
  if (!text) return null;
  if (/^#?\d{1,9}$/.test(text)) {
    const id = Number(text.replace('#', ''));
    return id > 0 ? { kind: 'id', id } : null;
  }
  const link = /fshub\.io\/airline\/([^/?#\s]+)/i.exec(text);
  if (link) {
    let segment = link[1] as string;
    try {
      segment = decodeURIComponent(segment);
    } catch {
      /* keep it as it came */
    }
    return parseAirlineRef(segment.replace(/\//g, ''));
  }
  // Anything with a scheme or a dot-and-slash is meant as a link to somewhere other than FsHub.
  if (/^[a-z][a-z0-9+.-]*:\/\//i.test(text) || /\.\w{2,}\//.test(text)) return null;
  if (text.length < 2 || text.length > 60 || /[\u0000-\u001f\u007f]/.test(text)) return null;
  return { kind: 'name', text };
}

/** Find the airline an admin named among the ones they belong to: by short name first, then by full name (ignoring capitals). */
export function matchAirline<T extends { name: string; abbr: string | null }>(airlines: T[], text: string): T | null {
  const q = text.trim().toLowerCase();
  return airlines.find((a) => a.abbr?.toLowerCase() === q) ?? airlines.find((a) => a.name.toLowerCase() === q) ?? null;
}
