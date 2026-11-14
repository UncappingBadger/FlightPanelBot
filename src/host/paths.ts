import { homedir } from 'node:os';
import { join, resolve } from 'node:path';
import { DEBUG_BUILD } from '../util/debugBuild.js';

export const APP_NAME = 'FlightPanelBot';

/** Where the host app keeps everything: settings, the database, logs. One folder per Windows user. */
export function appHome(env: Record<string, string | undefined> = process.env): string {
  if (env.FPB_HOME) return resolve(env.FPB_HOME);
  if (env.APPDATA) return join(env.APPDATA, APP_NAME);
  return join(homedir(), `.${APP_NAME.toLowerCase()}`);
}

export interface HostPaths {
  home: string;
  settings: string;
  googleKey: string;
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
    dataDir: join(home, 'data'),
    database: join(home, 'data', 'bot.sqlite'),
    logsDir: join(home, 'logs'),
    // The debug build keeps its own file, so what it writes is never mixed up with the normal build's log.
    logFile: join(home, 'logs', DEBUG_BUILD ? 'bot-debug.log' : 'bot.log'),
    status: join(home, 'status.json'),
    updateState: join(home, 'update-state.json'),
  };
}
