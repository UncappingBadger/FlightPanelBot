import type { JobView, Store } from '../db/store.js';
import { str } from '../jobs/import.js';

/** Are these two the same name? Capital letters and spaces at the ends don't count. */
export const sameName = (a: string, b: string): boolean => a.trim().toLowerCase() === b.trim().toLowerCase();

/** A name as a key: the same for names that are the same by `sameName`. */
export const nameKey = (name: string): string => name.trim().toLowerCase();

/** Who is asking: enough of a Discord account to know what they may be called in a sheet. */
export interface PilotPerson {
  id: string;
  username: string;
  globalName?: string | null;
}

/**
 * The names this person may be written as in an airline's sheet: the one they gave the bot (or, if they gave none, Discord's
 * names for them), and any name the bot has written into a sheet for them before.
 */
export function sheetNamesFor(store: Store, user: PilotPerson): string[] {
  const given = store.getPilotName(user.id);
  const all = [given, ...(given ? [] : [str(user.globalName ?? '', 40), str(user.username, 40)]), ...store.listSheetNamesByUser(user.id)];
  const out: string[] = [];
  for (const n of all) if (n && !out.some((o) => sameName(o, n))) out.push(n);
  return out;
}

/**
 * Is the flight named, in the airline's sheet, for one of these names, with nobody holding it in Discord? Every leg must be
 * named for one of them and none held: a flight that is half taken, or named for someone else on one leg, is not theirs to
 * take. Returns the names the sheet has on its legs, in leg order, or null if the flight does not qualify.
 */
export function namedForOneOf(view: JobView, names: string[]): string[] | null {
  if (names.length === 0 || view.legs.length === 0) return null;
  const sheet: string[] = [];
  for (const leg of view.legs) {
    if (leg.holder !== null || leg.sheetHolder === null || !names.some((n) => sameName(n, leg.sheetHolder as string))) return null;
    sheet.push(leg.sheetHolder);
  }
  return sheet;
}
