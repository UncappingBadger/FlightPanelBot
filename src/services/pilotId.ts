/**
 * A FsHub pilot ID is only ever typed in by the pilot and shown next to their name, so a manager can
 * match a Discord account to the airline's roster. The bot never asks FsHub whether it is right.
 */

/**
 * Accepts a numeric FsHub pilot ID or a profile link such as https://fshub.io/pilot/1234/overview.
 * Returns null if neither is recognisable (or the number is zero).
 */
export function parsePilotId(input: string): number | null {
  const text = input.trim();
  let id: number | null = null;
  if (/^#?\d{1,9}$/.test(text)) id = Number(text.replace('#', ''));
  else {
    const m = /fshub\.io\/pilot\/(\d{1,9})(?:[/?#]|$)/i.exec(text);
    if (m) id = Number(m[1]);
  }
  return id !== null && id > 0 ? id : null;
}
