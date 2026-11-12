import { createHash } from 'node:crypto';
import type { Store } from '../db/store.js';
import type { Logger } from '../util/log.js';
import { isMissingAccess } from './errors.js';

/** What happened when one server was given the bot's slash commands. */
export type CommandRegistration = 'registered' | 'unchanged' | 'failed' | 'no-access';

export interface RegistrationTarget {
  /** Replace a server's commands with `body`. */
  put(guildId: string, body: unknown[]): Promise<unknown>;
}

/** A short fingerprint of the command set, so a server is only updated when the commands really changed. */
export function commandsFingerprint(body: unknown[]): string {
  return createHash('sha1').update(JSON.stringify(body)).digest('hex').slice(0, 16);
}

const keyFor = (guildId: string) => `commands:${guildId}`;

/**
 * Give one server the bot's slash commands. Commands registered for a single server appear there
 * at once (global ones can take an hour), which is what a bot that serves just its host's own
 * server wants. Skipped when that server already has this exact set.
 */
export async function registerGuildCommands(
  target: RegistrationTarget,
  store: Store,
  guildId: string,
  body: unknown[],
  log: Logger,
): Promise<CommandRegistration> {
  const fingerprint = commandsFingerprint(body);
  if (store.getKv(keyFor(guildId)) === fingerprint) return 'unchanged';
  try {
    await target.put(guildId, body);
    store.setKv(keyFor(guildId), fingerprint);
    log.info(`Slash commands registered in server ${guildId}`);
    return 'registered';
  } catch (e) {
    if (isMissingAccess(e)) {
      // Discord says the bot wasn't added with the "applications.commands" permission.
      log.warn(`Could not register slash commands in server ${guildId}: the bot was added without command access. Add it again with the invite link.`);
      return 'no-access';
    }
    log.warn(`Could not register slash commands in server ${guildId}`, e);
    return 'failed';
  }
}

/** Forget what a server was given, so the next registration is sent in full. */
export function forgetGuildCommands(store: Store, guildId: string): void {
  store.deleteKv(keyFor(guildId));
}
