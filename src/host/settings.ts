import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { z } from 'zod';
import type { Config } from '../config.js';
import { normalizeFsHubToken } from '../fshub/client.js';
import { parseServiceAccount } from '../google/serviceAccount.js';
import type { HostPaths } from './paths.js';

export type LogLevel = 'debug' | 'info' | 'warn' | 'error';

/** What a host fills in once. Everything else is decided by the app. */
export interface HostSettings {
  /** The token of the Discord bot the host created. */
  discordToken: string;
  /** Whether to look on GitHub once a day for a newer version of this app (and say so if there is one). */
  checkForUpdates: boolean;
  logLevel: LogLevel;
  /**
   * Optional: the host's FsHub personal access token. With it the bot checks the pilot IDs people type and
   * can read an airline's FsHub roster. Empty means the bot never contacts FsHub. (Older versions kept a
   * token under another name, `fshubToken`, which is deliberately not read: it was saved for a feature that
   * no longer exists, and a token should only ever be used for what its owner pasted it in for.)
   */
  fshubAccessToken: string;
}

const FileSchema = z.object({
  discordToken: z.string().default(''),
  checkForUpdates: z.boolean().default(true),
  logLevel: z.enum(['debug', 'info', 'warn', 'error']).default('info'),
  fshubAccessToken: z.string().default(''),
});

/** Tidy a pasted token: no spaces, quotes, or a leading "Bot ". */
export function normalizeToken(raw: string): string {
  return raw
    .trim()
    .replace(/^["'`]+|["'`]+$/g, '')
    .replace(/^bot\s+/i, '')
    .trim();
}

/**
 * A Discord bot token starts with the bot's own ID (base64), so the application ID, which the invite
 * link needs, can be read straight out of it. Null if the text isn't shaped like a bot token.
 */
export function clientIdFromToken(token: string): string | null {
  const parts = normalizeToken(token).split('.');
  if (parts.length !== 3 || parts.some((p) => p.length === 0)) return null;
  let id: string;
  try {
    id = Buffer.from(parts[0] as string, 'base64').toString('utf8');
  } catch {
    return null;
  }
  return /^\d{15,21}$/.test(id) ? id : null;
}

/** Why a pasted Discord token can't be right, or null if it looks fine (Discord has the final say). */
export function discordTokenProblem(token: string): string | null {
  const t = normalizeToken(token);
  if (!t) return 'Paste the bot token from the Discord Developer Portal (Bot tab, Reset Token).';
  if (/^\d{15,21}$/.test(t)) return "That is an ID, not a token. On the Bot tab, press Reset Token and copy the long text it shows.";
  if (clientIdFromToken(t) === null) return "That doesn't look like a Discord bot token. It is a long text with two dots in it. Copy it again from the Bot tab.";
  return null;
}

/** The settings file's text. A file saved by Notepad or PowerShell can start with a byte-order mark, which JSON does not allow. */
function readSettingsText(paths: HostPaths): string {
  return readFileSync(paths.settings, 'utf8').replace(/^﻿/, '');
}

export function loadSettings(paths: HostPaths): HostSettings {
  let parsed: z.infer<typeof FileSchema>;
  try {
    parsed = FileSchema.parse(JSON.parse(readSettingsText(paths)));
  } catch {
    parsed = FileSchema.parse({});
  }
  return {
    discordToken: normalizeToken(parsed.discordToken),
    checkForUpdates: parsed.checkForUpdates,
    logLevel: parsed.logLevel,
    fshubAccessToken: normalizeFsHubToken(parsed.fshubAccessToken),
  };
}

/**
 * Older versions kept a FsHub API token in settings.json (as `fshubToken`) for a feature that no longer
 * exists, and nothing reads it. Take it out of the file rather than leave a secret lying around. Does
 * nothing if the file never had one. (The current optional token is a different setting, `fshubAccessToken`.)
 */
export function forgetLegacySettings(paths: HostPaths): boolean {
  try {
    const raw: unknown = JSON.parse(readSettingsText(paths));
    if (!raw || typeof raw !== 'object' || !('fshubToken' in raw)) return false;
  } catch {
    return false;
  }
  saveSettings(paths, loadSettings(paths));
  return true;
}

function writeAtomic(path: string, text: string): void {
  mkdirSync(dirname(path), { recursive: true });
  const tmp = `${path}.tmp`;
  // The mode only matters off Windows; on Windows the folder is already private to the user.
  writeFileSync(tmp, text, { encoding: 'utf8', mode: 0o600 });
  renameSync(tmp, path);
}

export function saveSettings(paths: HostPaths, settings: HostSettings): void {
  writeAtomic(paths.settings, `${JSON.stringify(settings, null, 2)}\n`);
}

/** Human names of what still has to be filled in before the bot can start. */
export function missingSettings(s: HostSettings): string[] {
  const out: string[] = [];
  if (discordTokenProblem(s.discordToken) !== null) out.push('Discord bot token');
  return out;
}

/** The settings as the bot's own config object. Throws if the Discord token isn't usable. */
export function toConfig(paths: HostPaths, s: HostSettings): Config {
  const clientId = clientIdFromToken(s.discordToken);
  if (!clientId) throw new Error(discordTokenProblem(s.discordToken) ?? 'The Discord bot token is not usable.');
  return {
    discordToken: s.discordToken,
    discordClientId: clientId,
    discordGuildId: undefined,
    databasePath: paths.database,
    logLevel: s.logLevel,
    googleServiceAccountFile: existsSync(paths.googleKey) ? paths.googleKey : undefined,
    fshubToken: s.fshubAccessToken || undefined,
  };
}

/* ------------------------------------------------------------------ the optional Google key */

export interface GoogleKeyInfo {
  present: boolean;
  /** The service account's address, which the sheet's owner shares the sheet with. */
  email: string | null;
  /** Set when a key file is there but unusable. */
  problem: string | null;
}

export function googleKeyInfo(paths: HostPaths): GoogleKeyInfo {
  if (!existsSync(paths.googleKey)) return { present: false, email: null, problem: null };
  try {
    return { present: true, email: parseServiceAccount(readFileSync(paths.googleKey, 'utf8'), 'The saved Google key').email, problem: null };
  } catch (e) {
    return { present: true, email: null, problem: e instanceof Error ? e.message : 'The saved Google key is unusable.' };
  }
}

/** Check a pasted or uploaded key, and keep it. Throws a plain-English Error if it isn't a service account key. */
export function saveGoogleKey(paths: HostPaths, jsonText: string): GoogleKeyInfo {
  const account = parseServiceAccount(jsonText, 'That file');
  writeAtomic(paths.googleKey, JSON.stringify(JSON.parse(jsonText)));
  return { present: true, email: account.email, problem: null };
}

export function removeGoogleKey(paths: HostPaths): void {
  rmSync(paths.googleKey, { force: true });
}
