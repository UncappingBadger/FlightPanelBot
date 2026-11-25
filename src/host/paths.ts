import { homedir } from 'node:os';
import { join, resolve } from 'node:path';
import { TEST_BUILD } from '../util/clock.js';
import { DEBUG_BUILD } from '../util/debugBuild.js';

export const APP_NAME = 'FlightPanelBot';
/** The test build keeps everything in a folder of its own, so it never touches the real bot's settings, database or log (and can run beside it). */
export const HOME_FOLDER = TEST_BUILD ? `${APP_NAME}-TEST` : APP_NAME;
/** The port of the setup page: the test build uses the next one up, so both can be open at once. */
export const DEFAULT_PORT = TEST_BUILD ? 47812 : 47811;

/** Where the host app keeps everything: settings, the database, logs. One folder per Windows user. */
export function appHome(env: Record<string, string | undefined> = process.env): string {
  if (env.FPB_HOME) return resolve(env.FPB_HOME);
  if (env.APPDATA) return join(env.APPDATA, HOME_FOLDER);
  return join(homedir(), `.${HOME_FOLDER.toLowerCase()}`);
}

export interface HostPaths {
  home: string;
  settings: string;
  googleKey: string;
  /** The Twitch sign-in, when the host connected one (see src/twitch/tokens.ts), and the bot's latest Twitch status, for the setup page. */
  twitchTokens: string;
  twitchStatus: string;
  dataDir: string;
  database: string;
  logsDir: string;
  logFile: string;
  status: string;
  /** Remembers which new version the host has already been told about, so the pop-up appears once. */
  updateState: string;
}

export function hostPaths(home: string): HostPaths {
  return {
    home,
    settings: join(home, 'settings.json'),
    googleKey: join(home, 'google-key.json'),
    twitchTokens: join(home, 'twitch.json'),
    twitchStatus: join(home, 'twitch-status.json'),
    dataDir: join(home, 'data'),
    database: join(home, 'data', 'bot.sqlite'),
    logsDir: join(home, 'logs'),
    // The debug build keeps its own file, so what it writes is never mixed up with the normal build's log.
    logFile: join(home, 'logs', DEBUG_BUILD ? 'bot-debug.log' : 'bot.log'),
    status: join(home, 'status.json'),
    updateState: join(home, 'update-state.json'),
  };
}
