import type { JobView } from '../db/store.js';

/**
 * Whether a flight can still be taken by somebody: at least one leg has no pilot, neither a Discord reservation nor a name in
 * the airline's own schedule.
 */
export const hasFreeLeg = (view: JobView): boolean => view.legs.some((l) => l.holder === null && l.sheetHolder === null);

/**
 * The flights worth showing to someone who chose to hide the ones that are no longer available to them: those with a free
 * leg, and any they are part of themselves (flying a leg, or standing by as the backup), which stay so they do not lose
 * track of them. A flight that is fully taken by others is the one that goes.
 */
export function availableFor(views: JobView[], discordId: string): JobView[] {
  return views.filter((v) => hasFreeLeg(v) || v.legs.some((l) => l.holder?.discordId === discordId) || v.backup?.discordId === discordId);
}
