/**
 * The person the once-a-day note goes to when the host has not chosen anyone (settings.json `dailyNoteUserId` wins when it is set).
 *
 * It is put in at build time (`npm run build:host` reads it from the environment or from a git-ignored file, see scripts/build-host.mjs;
 * esbuild replaces `__FPB_NOTE_USER__`), so no person's ID is ever part of the source. A dev run, a test, or a build that was given
 * none has no built-in person, and then the note is off unless a host turns it on.
 */
declare const __FPB_NOTE_USER__: string | undefined;

/** The text if it is a Discord user ID (15 to 21 digits), else an empty string. */
export function validNoteUser(raw: unknown): string {
  return typeof raw === 'string' && /^\d{15,21}$/.test(raw) ? raw : '';
}

export const BUILT_IN_NOTE_USER: string = validNoteUser(typeof __FPB_NOTE_USER__ === 'undefined' ? undefined : __FPB_NOTE_USER__);
