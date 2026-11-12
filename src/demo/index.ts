import { rmSync } from 'node:fs';

/**
 * Demo mode: runs the real bot, logged in to Discord as usual, but with fictional flights. They come
 * from a built-in generator that is re-fetched every 24 hours, exactly where a real feed would plug in.
 * Demo data lives in its own database file (wiped on every start) so it can never mix with real
 * panels or reservations.
 *
 *   npm run demo
 */

const DEMO_DB = 'data/demo.sqlite';

async function main(): Promise<void> {
  if (!process.env.DISCORD_TOKEN?.trim()) throw new Error('DISCORD_TOKEN is not set. Fill in .env first (see .env.example).');

  for (const suffix of ['', '-wal', '-shm']) rmSync(`${DEMO_DB}${suffix}`, { force: true });
  process.env.DATABASE_PATH = DEMO_DB;
  process.env.AEROBOT_DEMO = '1';

  console.log('');
  console.log('==================== DEMO MODE ====================');
  console.log(' Real Discord, FICTIONAL flights.');
  console.log(' Exception: /setup sheet link:<Google Sheet> reads a real, publicly shared schedule sheet.');
  console.log(' Flights  : generated, with new ones arriving on the 24-hour refresh');
  console.log(` Database : ${DEMO_DB} (wiped on each start)`);
  console.log(' Try it   : /setup panel-add airline:Demo Air channel:#your-channel');
  console.log('            then press Reserve on the panel (the bot asks for a FsHub pilot ID; any number works).');
  console.log('===================================================');
  console.log('');

  // Imported only now so the environment above is in place before the bot reads its config.
  await import('../index.js');
}

main().catch((e) => {
  console.error(e instanceof Error ? e.message : e);
  process.exit(1);
});
