import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import type { ServerInfo } from '../bot.js';
import type { HostPaths } from './paths.js';
import type { GoogleKeyInfo } from './settings.js';
import type { UpdateStatus } from './updates.js';

/**
 * - `needs-setup`: a token is missing, so the bot is not running; the setup page is
 * - `starting`: connecting to Discord
 * - `online`: connected
 * - `retrying`: could not reach Discord; trying again by itself
 * - `error`: something needs fixing (the message says what); fix it on the setup page
 * - `stopped`: shut down
 */
export type Phase = 'needs-setup' | 'starting' | 'online' | 'retrying' | 'error' | 'stopped';

export interface HostState {
  phase: Phase;
  /** One plain sentence for the tray and the setup page. */
  message: string;
  botName: string | null;
  /** Adds the host's own bot to a server. Known as soon as a valid token is saved. */
  inviteUrl: string | null;
  servers: ServerInfo[];
  /** What is filled in. Never the secrets themselves. */
  configured: { discordToken: boolean; google: GoogleKeyInfo };
  version: string;
  updatedAt: number;
}

/** What the tray launcher reads from disk: the state, plus how to reach the setup page. */
export interface StatusFile extends HostState {
  pid: number;
  /** The local setup page's port and the secret that must accompany every request to it. */
  port: number | null;
  key: string | null;
  /** Whether a newer release of this app exists on GitHub. */
  update: UpdateStatus;
}

/** Write the status file whole (never half-written, since the launcher reads it every couple of seconds). */
export function writeStatus(paths: HostPaths, status: StatusFile): void {
  mkdirSync(dirname(paths.status), { recursive: true });
  const tmp = `${paths.status}.tmp`;
  writeFileSync(tmp, JSON.stringify(status), 'utf8');
  renameSync(tmp, paths.status);
}

export function readStatus(paths: HostPaths): StatusFile | null {
  try {
    return JSON.parse(readFileSync(paths.status, 'utf8')) as StatusFile;
  } catch {
    return null;
  }
}
