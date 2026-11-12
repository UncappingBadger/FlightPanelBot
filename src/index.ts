import { startBot } from './bot.js';
import { loadConfig } from './config.js';
import { createLogger } from './util/log.js';

/**
 * Command-line entry: run the bot with settings from the environment (a `.env` file). The packaged
 * Windows app starts the same bot through `src/host/` instead.
 */
async function main(): Promise<void> {
  const config = loadConfig();
  const log = createLogger(config.logLevel);
  const bot = await startBot(config, { log });

  let stopping = false;
  const shutdown = (signal: string) => {
    if (stopping) return;
    stopping = true;
    log.info(`${signal} received, shutting down`);
    void bot.stop().finally(() => process.exit(0));
  };
  process.on('SIGINT', () => shutdown('SIGINT'));
  process.on('SIGTERM', () => shutdown('SIGTERM'));
  process.on('unhandledRejection', (e) => log.error('Unhandled promise rejection', e));
}

main().catch((e) => {
  console.error(e instanceof Error ? e.message : e);
  process.exit(1);
});
