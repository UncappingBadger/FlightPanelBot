import { DiscordAPIError } from 'discord.js';
import { ImportError } from '../jobs/import.js';
import { JobError } from '../services/jobs.js';
import type { Logger } from '../util/log.js';

/** An expected problem with a message that is safe and useful to show to the user as-is. */
export class UserError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'UserError';
  }
}

/** The numeric Discord API error code (e.g. 10008), if `e` is one. */
export function discordErrorCode(e: unknown): number | null {
  if (e instanceof DiscordAPIError && typeof e.code === 'number') return e.code;
  if (typeof e === 'object' && e !== null && typeof (e as { code?: unknown }).code === 'number') return (e as { code: number }).code;
  return null;
}

/** Discord error 50007: the user has DMs from this server turned off. */
export function isDmClosed(e: unknown): boolean {
  return discordErrorCode(e) === 50007;
}

/** Discord error 10008: that message no longer exists (someone deleted it). */
export function isUnknownMessage(e: unknown): boolean {
  return discordErrorCode(e) === 10008;
}

/** Discord errors 50001 / 50013: the bot can't see or write in that channel. */
export function isMissingAccess(e: unknown): boolean {
  const code = discordErrorCode(e);
  return code === 50001 || code === 50013;
}

/** Turn any thrown value into the text the user should see. Unexpected errors are logged, not shown. */
export function describeError(e: unknown, log: Logger): string {
  if (e instanceof UserError || e instanceof JobError) return e.message;
  if (e instanceof ImportError) return [e.message, ...e.problems.map((p) => `• ${p}`)].join('\n');
  log.error('Unhandled error while handling an interaction', e);
  return 'Something went wrong on my side. Please try again, and let the bot owner know if it keeps happening.';
}
