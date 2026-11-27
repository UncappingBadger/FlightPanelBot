import { rmSync, writeFileSync } from 'node:fs';
import { basename, join } from 'node:path';
import type { HostPaths } from './paths.js';

/**
 * "Reset everything": put the app back to how it was before it was ever set up. What it keeps is deleted and cannot be brought back.
 */

/** Left behind by a reset for the tray launcher, which then switches "Start with Windows" off (only it can do that) and forgets the marker. */
export const RESET_MARKER = 'reset-done';

/**
 * Everything the app keeps in its folder, named one by one: the folder itself, and anything else somebody has put in it, is never
 * touched. `status.json` is not here: it says how the running app can be reached, and is written again all the time.
 */
export function resettable(paths: HostPaths): string[] {
  const withHalfWritten = (file: string) => [file, `${file}.tmp`];
  return [
    // The database and its journal, the copies kept before upgrades, the key that seals pilots' bank sign-ins, the hard landing lists.
    paths.dataDir,
    ...withHalfWritten(paths.settings),
    `${paths.settings}.unreadable`,
    ...withHalfWritten(paths.googleKey),
    ...withHalfWritten(paths.twitchTokens),
    ...withHalfWritten(paths.twitchStatus),
    ...withHalfWritten(paths.updateState),
    join(paths.home, '.startup-tip'), // the launcher's "you have been told about Start with Windows"
    paths.logsDir,
  ];
}

/**
 * Delete all of it. The bot must have been stopped first (see `Supervisor.shutdown`): an open database cannot be deleted on Windows.
 * Returns the names of what could not be deleted.
 */
export function deleteEverything(paths: HostPaths): string[] {
  const left: string[] = [];
  for (const target of resettable(paths)) {
    try {
      rmSync(target, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
    } catch {
      left.push(basename(target));
    }
  }
  return left;
}

export function markReset(paths: HostPaths): void {
  try {
    writeFileSync(join(paths.home, RESET_MARKER), 'reset\n', 'utf8');
  } catch {
    // Only "Start with Windows" hangs on this, and the tray menu can switch that off by hand.
  }
}
