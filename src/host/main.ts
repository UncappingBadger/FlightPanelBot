import { randomBytes } from 'node:crypto';
import { mkdirSync } from 'node:fs';
import { createFileLogger } from './fileLogger.js';
import { appHome, hostPaths } from './paths.js';
import { forgetLegacySettings, loadSettings } from './settings.js';
import { writeStatus, type HostState } from './status.js';
import { Supervisor } from './supervisor.js';
import { UpdateChecker } from './updates.js';
import { startWebServer } from './web.js';

/**
 * Entry point of the packaged Windows app. The tray launcher runs this with the bundled Node. It keeps
 * the bot running for the host, serves the local setup page, and writes `status.json` so the tray
 * icon can show what is happening and open the setup page.
 */
async function main(): Promise<void> {
  const paths = hostPaths(appHome());
  mkdirSync(paths.home, { recursive: true });
  const version = process.env.FPB_VERSION ?? 'dev';

  const scrubbed = forgetLegacySettings(paths);
  const logger = createFileLogger({ file: paths.logFile, level: loadSettings(paths).logLevel });
  const log = logger.log;
  log.info(`Flight Panel Bot ${version} starting (data in ${paths.home})`);
  if (scrubbed) log.info('Removed a FsHub token left in the settings by an older version; it is not used any more.');

  const key = randomBytes(18).toString('base64url');
  let port: number | null = null;

  // The status file is what the tray icon reads: the bot's state, how to reach the setup page, and whether a newer version exists.
  const publish = (state: HostState) => {
    try {
      writeStatus(paths, { ...state, pid: process.pid, port, key: port === null ? null : key, update: updates.status() });
    } catch (e) {
      // The tray icon would go stale, but the bot itself must carry on.
      log.warn('Could not write the status file', e);
    }
  };

  // Once a day (and from the setup page's button) look on GitHub for a newer release and say so; nothing is downloaded.
  const updates = new UpdateChecker({
    version,
    statePath: paths.updateState,
    autoEnabled: () => loadSettings(paths).checkForUpdates,
    onChange: () => publish(supervisor.state()),
    logger: log,
  });

  const supervisor = new Supervisor({ paths, log, version, onState: publish });

  let quitting = false;
  const quit = (reason: string) => {
    if (quitting) return;
    quitting = true;
    log.info(`Shutting down (${reason})`);
    // Give the bot a few seconds to disconnect cleanly, then go regardless.
    const hardStop = setTimeout(() => process.exit(0), 8_000);
    hardStop.unref();
    updates.stop();
    void supervisor.stop().finally(() => process.exit(0));
  };

  const web = await startWebServer({ supervisor, updates, paths, log, version, key, port: Number(process.env.FPB_PORT) || 47811, tail: logger.tail, onQuit: () => quit('asked to quit') });
  port = web.port;
  log.info(`Setup page on port ${port}`);

  // If the tray launcher disappears (it crashed, or was killed), don't be left running unseen.
  const parent = Number(process.env.FPB_PARENT_PID) || 0;
  if (parent > 0) {
    setInterval(() => {
      try {
        process.kill(parent, 0);
      } catch {
        quit('the tray launcher is gone');
      }
    }, 5_000).unref();
  }

  process.on('SIGINT', () => quit('SIGINT'));
  process.on('SIGTERM', () => quit('SIGTERM'));
  process.on('unhandledRejection', (e) => log.error('Unhandled promise rejection', e));
  process.on('uncaughtException', (e) => {
    log.error('Unexpected error; stopping so the launcher can start me again', e);
    process.exit(1);
  });

  updates.start();
  await supervisor.start();
}

main().catch((e) => {
  console.error(e instanceof Error ? e.stack ?? e.message : e);
  process.exit(1);
});
