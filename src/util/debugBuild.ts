import type { Logger } from './log.js';

/**
 * Set by `npm run build:host -- --debug` (esbuild replaces `__FPB_DEBUG__` with `true`). It is never set in a normal
 * build, a dev run or a test, where every `if (DEBUG_BUILD)` below is simply false. The debug build is a diagnostic
 * build for chasing a problem on someone else's machine: it keeps its own log file (`bot-debug.log`) and writes
 * far more detail into it. It is not part of the release cycle.
 */
declare const __FPB_DEBUG__: boolean | undefined;
export const DEBUG_BUILD: boolean = typeof __FPB_DEBUG__ !== 'undefined' && __FPB_DEBUG__ === true;

/** The call path that led here, trimmed to the bot's own functions, so a log line can say WHO did something. */
export function callerPath(skip = 2, max = 7): string {
  const lines = (new Error().stack ?? '').split('\n').slice(1 + skip);
  const names: string[] = [];
  for (const l of lines) {
    const m = /at (?:async )?([A-Za-z0-9_$.<>\[\] ]+?) \(/.exec(l.trim());
    const name = m?.[1];
    if (!name || name === '<anonymous>' || name.startsWith('node:') || /^(Object\.<anonymous>|process\.|new Promise|Array\.)/.test(name)) continue;
    if (names[names.length - 1] !== name) names.push(name);
    if (names.length >= max) break;
  }
  return names.join(' < ') || '(no stack)';
}

/** Log a line that exists only in the debug build. Always `info`, so it is written whatever the log level. */
export function dbg(log: Logger | undefined, message: string): void {
  if (DEBUG_BUILD && log) log.info(`[dbg] ${message}`);
}
