import { openDatabase } from '../src/db/db.js';
import { Store, type Panel } from '../src/db/store.js';
import { JobEvents, type JobEvent } from '../src/services/events.js';
import { JobService } from '../src/services/jobs.js';
import type { SourceJob } from '../src/jobs/types.js';

/* ------------------------------------------------------------------ job fixtures */

export const T0 = Date.UTC(2026, 10, 11, 12, 0, 0); // 2026-11-11 12:00Z
export const HOUR = 3_600_000;
export const AIRLINE = { name: 'Test Air', abbr: 'TST' };
export const GUILD = '900000000000000001';
export const CHANNEL = '700000000000000001';
export const USER_A = { discordId: '111111111111111111', username: 'alice' };
export const USER_B = { discordId: '222222222222222222', username: 'bob' };
export const USER_C = { discordId: '333333333333333333', username: 'carol' };

/** A source job from a chain like "EGLL-EGKK-EGCC" (two legs). */
export function sj(key: string, chain: string, over: Partial<SourceJob> = {}): SourceJob {
  const airports = chain.split('-');
  return {
    key,
    title: null,
    legs: airports.slice(0, -1).map((dep, i) => ({ dep, arr: airports[i + 1] as string })),
    aircraft: 'A320',
    availableFrom: null,
    deadline: T0 + 48 * HOUR,
    pay: null,
    notes: null,
    ...over,
  };
}

/** Everything wired together over an in-memory database and a controllable clock. */
export interface Harness {
  store: Store;
  events: JobEvents;
  emitted: JobEvent[];
  jobs: JobService;
  panel: Panel;
  clock: { now: number; advance(ms: number): void };
  close(): Promise<void>;
}

export async function makeHarness(): Promise<Harness> {
  const store = new Store(openDatabase(':memory:'));
  const events = new JobEvents();
  const emitted: JobEvent[] = [];
  events.subscribe((e) => void emitted.push(e));
  const clock = {
    now: T0,
    advance(ms: number) {
      this.now += ms;
    },
  };
  const now = () => clock.now;
  const jobs = new JobService(store, events, { now });
  const created = store.createPanel({ guildId: GUILD, name: AIRLINE.name, abbr: AIRLINE.abbr, prefix: 'TST', channelId: CHANNEL, now: T0 });
  // The tests of landing safety pay were written when every airline had the same limits (a warning from 375 feet per minute, 400 and 600): this panel keeps them. A new
  // panel starts at 400, 500 and 600 (see `STARTING_LIMITS`), as the tests of that say with a panel of their own.
  store.updatePanel(created.id, { safetyWarnFpm: 375, safetyTier1Fpm: 400, safetyTier2Fpm: 600 });
  const panel = store.getPanel(created.id) as Panel;
  return {
    store,
    events,
    emitted,
    jobs,
    panel,
    clock,
    close: async () => {
      store.close();
    },
  };
}
