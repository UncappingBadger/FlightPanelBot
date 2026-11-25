/**
 * A soak run: the bot's real services (scheduler, sheet reads and writes, panel redraws, the midnight list, FsHub completion) driven for a while on
 * the test build's fast clock, with a made-up airline whose sheet keeps changing, made-up pilots who reserve and fly its flights, and a pretend
 * Discord, Google and FsHub that answer after a believable delay. It watches how the bot does: how late its one thread is for everything else,
 * how long each step takes, how long a pilot waits, memory, the size of the database.
 *
 *   npx tsx test/soak/soak.ts [minutes] [scale]       default: 12 minutes at 288 times (a day is five minutes)
 *
 * Not a test (it is not in the suite): it runs for minutes and is meant to be read, not to pass or fail. Nothing leaves this computer.
 */
import { appendFileSync, mkdirSync, mkdtempSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Client } from 'discord.js';
import { openDatabase } from '../../src/db/db.js';
import { Store } from '../../src/db/store.js';
import { Notifier } from '../../src/discord/notifier.js';
import { PanelService } from '../../src/discord/panel.js';
import { LocalSheet, localSheetFetch } from '../../src/google/localSheet.js';
import type { SheetsPort } from '../../src/google/sheetsApi.js';
import { sourceSelector, type SheetRef } from '../../src/jobs/sheet.js';
import { AutoCompleter } from '../../src/services/autoComplete.js';
import { JobEvents } from '../../src/services/events.js';
import { FsHubSync } from '../../src/services/fshubSync.js';
import { HourlySlot } from '../../src/services/hourlySlot.js';
import { JobService } from '../../src/services/jobs.js';
import { SourceRefresher } from '../../src/services/refresh.js';
import { ReminderService } from '../../src/services/reminders.js';
import { Scheduler } from '../../src/services/scheduler.js';
import { SheetWriteBack, WriteBackError } from '../../src/services/writeback.js';
import { PerfMonitor, fileMb } from '../../src/testbuild/perfMonitor.js';
import { TEST_SHEET_ID, TestSheetFeeder } from '../../src/testbuild/testSheet.js';
import { scaledClock } from '../../src/util/clock.js';
import { createLogger } from '../../src/util/log.js';
import { FakeClient, FakeFsHub, FakeMessage, FakeUser } from '../discord-helpers.js';

const MINUTES = Number(process.argv[2] ?? 12);
const SCALE = Number(process.argv[3] ?? 288);
const AIRLINE_ID = 4242;
const GUILD = '900000000000000001';
const CHANNEL = '700000000000000001';
const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

/** How long the pretend outside world takes to answer (real milliseconds), a plausible figure for each kind of call. */
const LATENCY = { googleRead: 300, googleTitle: 150, googleWrite: 220, discordGet: 90, discordBatch: 140, discordEdit: 130, discordSend: 160, editSpacing: 200 };

const dir = mkdtempSync(join(tmpdir(), 'fpb-soak-'));
const logFile = join(dir, 'soak.log');
writeFileSync(logFile, '');
const now = scaledClock(SCALE, Date.now());
const stamp = () => `${new Date().toISOString().slice(11, 19)} [clock ${new Date(now()).toISOString().slice(5, 16)}Z]`;
const lines: string[] = [];
const log = createLogger('info', (line) => {
  const text = `${stamp()} ${line.slice(25)}`;
  lines.push(text);
  appendFileSync(logFile, `${text}\n`);
  // Every cell the bot writes is a line: they are counted, not shown.
  if (!/ (Local sheet: wrote|Wrote [A-Z]+\d+ in the airline's sheet)/.test(text)) console.log(text);
});

/* ------------------------------------------------------------------ the pretend outside world */

/** Google, as slow as Google is: each call to the local file takes a believable time. Counts every call. */
class SlowSheet implements SheetsPort {
  reads = 0;
  writes = 0;
  titles = 0;
  constructor(private readonly inner: LocalSheet) {}
  async tabTitle(ref: SheetRef) {
    this.titles++;
    await sleep(LATENCY.googleTitle);
    return this.inner.tabTitle(ref);
  }
  async readTab(ref: SheetRef, render?: 'FORMATTED_VALUE' | 'FORMULA') {
    this.reads++;
    await sleep(LATENCY.googleRead);
    return this.inner.readTab(ref, render);
  }
  async update(ref: SheetRef, title: string, cells: Parameters<LocalSheet['update']>[2]) {
    this.writes++;
    await sleep(LATENCY.googleWrite);
    return this.inner.update(ref, title, cells);
  }
  columnNumberFormats(...a: Parameters<LocalSheet['columnNumberFormats']>) {
    return this.inner.columnNumberFormats(...a);
  }
  setNumberFormat(...a: Parameters<LocalSheet['setNumberFormat']>) {
    return this.inner.setNumberFormat(...a);
  }
}

/** Discord's rate limit on edits: one at a time, a little apart, whoever asks. */
let nextEditAt = 0;
const editSlot = async () => {
  const wait = Math.max(0, nextEditAt - Date.now());
  nextEditAt = Math.max(Date.now(), nextEditAt) + LATENCY.editSpacing;
  if (wait > 0) await sleep(wait);
};
const discord = { gets: 0, batches: 0, edits: 0, sends: 0 };
const origEdit = FakeMessage.prototype.edit;
FakeMessage.prototype.edit = async function (this: FakeMessage, p: unknown) {
  discord.edits++;
  await editSlot();
  await sleep(LATENCY.discordEdit);
  return origEdit.call(this, p);
};
const slowChannel = (client: FakeClient, id: string) => {
  const ch = client.channel(id);
  const send = ch.send.bind(ch);
  ch.send = async (p: unknown) => {
    discord.sends++;
    await editSlot();
    await sleep(LATENCY.discordSend);
    return send(p);
  };
  const fetch = ch.messages.fetch;
  ch.messages.fetch = (async (arg: any) => {
    const batch = typeof arg === 'object' && arg !== null && 'limit' in arg;
    if (batch) discord.batches++;
    else discord.gets++;
    await sleep(batch ? LATENCY.discordBatch : LATENCY.discordGet);
    return fetch(arg);
  }) as typeof fetch;
  return ch;
};

/* ------------------------------------------------------------------ the bot's own parts, wired as bot.ts wires them */

const store = new Store(openDatabase(join(dir, 'soak.sqlite')));
const events = new JobEvents(log);
const jobs = new JobService(store, events, { now, logger: log });
const slot = HourlySlot.forInstall(store);
const client = new FakeClient();
const channel = slowChannel(client, CHANNEL);
const panels = new PanelService(store, jobs, log, now);
panels.attach(client as unknown as Client);
panels.fshubEnabled = true;
const notifier = new Notifier(client as unknown as Client, panels, log);
notifier.subscribe(events);
const sheets = join(dir, 'debug-sheets');
mkdirSync(sheets, { recursive: true });
const feeder = new TestSheetFeeder(sheets, now, { logger: log });
const noInternet = (async () => {
  throw new Error('the soak asked the internet');
}) as unknown as typeof fetch;
const slow = new SlowSheet(new LocalSheet(sheets, log));
const writeback = new SheetWriteBack(slow, 'the soak', { now, logger: log });
const refresher = new SourceRefresher(store, jobs, sourceSelector({ fetchFn: localSheetFetch(sheets, noInternet, log, feeder.make) }), log, now, undefined, slot);
const fshub = new FakeFsHub();
const fshubSync = new FsHubSync(store, fshub, panels, { logger: log, now, completed: (id) => jobs.completed(id), slot });
const reminders = new ReminderService(store, jobs, async (panel, due) => (await panels.remind(panel, due)) === 'sent', { now, logger: log });
const autoComplete = new AutoCompleter({
  store,
  jobs,
  sync: fshubSync,
  writeback,
  logger: log,
  now,
  slot,
  onCompleted: (discordId, done) => notifier.autoCompleted(discordId, done),
  onReplaced: (done) => notifier.backupTookOver(done),
});

const perf = new PerfMonitor(log, now, {
  extra: () => `database ${fileMb(join(dir, 'soak.sqlite'))} MB (+ ${fileMb(join(dir, 'soak.sqlite-wal'))} MB journal), ${store.listJobs(panel.id, 'open').length} open flight(s), sheet: ${slow.reads} reads/${slow.writes} writes/${slow.titles} titles, discord: ${discord.batches} batches/${discord.gets} gets/${discord.edits} edits/${discord.sends} sends`,
});
const scheduler = new Scheduler(jobs, refresher, {
  logger: log,
  tickMs: 2_000,
  reminders: perf.wrap('midnight list', reminders),
  panels,
  cleanup: perf.wrap('announcement cleanup', { run: () => panels.cleanReminders() }),
  fshub: perf.wrap('FsHub sync', fshubSync),
  autoComplete: perf.wrap('auto-complete', autoComplete),
});
{
  const tick = scheduler.tick.bind(scheduler);
  scheduler.tick = () => perf.time('whole pass', tick);
  const due = refresher.refreshDue.bind(refresher);
  refresher.refreshDue = () => perf.time('sheet reads', due);
  const redraw = panels.refresh.bind(panels);
  panels.refresh = (id, o) => perf.time('panel redraw', () => redraw(id, o));
}

/* ------------------------------------------------------------------ the airline and its pilots */

const panel = store.createPanel({ guildId: GUILD, name: 'Sample Airways', abbr: 'SKY', prefix: 'SKY', channelId: CHANNEL, now: now() });
store.updatePanel(panel.id, { sheetId: TEST_SHEET_ID, sheetGid: null, fshubAirlineId: AIRLINE_ID, fshubAirlineName: 'Sample Airways' });
const NAMES = ['Alex Morgan', 'Sam Rivera', 'Jordan Lee', 'Casey Kim', 'Taylor Brooks', 'Riley Chen', 'Morgan Ellis', 'Jamie Cole'];
const pilots = NAMES.map((name, i) => {
  const user = client.user(new FakeUser(`30000000000000000${i}`, name.split(' ')[0]!.toLowerCase()));
  store.setPilotId(user.id, 1001 + i, now());
  store.setPilotName(user.id, name, now());
  return { user, name, fshubId: 1001 + i };
});
fshub.rosters.set(
  AIRLINE_ID,
  pilots.map((p) => ({ id: p.fshubId, name: p.name, discordId: p.user.id }) as never),
);

/** What a pilot does when they press Reserve and send a flight ID: the same steps as the DM handler (see `reserveAndClaim` in src/discord/dm.ts). */
const waits: number[] = [];
const outcomes = { reserved: 0, conflicts: 0, released: 0, flown: 0 };
const flown = new Map<number, { pilot: (typeof pilots)[number]; dep: string; arr: string; start: number; end: number }>();
let nextFlightId = 4_900_000;
async function pilotActs(): Promise<void> {
  const pilot = pilots[Math.floor(Math.random() * pilots.length)]!;
  const t0 = performance.now();
  const open = jobs
    .open(panel.id)
    .filter((v) => v.legs.length === 1 && !/[05]$/.test(v.job.code) && !v.legs[0]!.holder && !v.legs[0]!.sheetHolder && (v.job.availableFrom ?? 0) < now() + 2 * 86_400_000 && (v.job.deadline ?? Infinity) > now() + 3_600_000);
  if (open.length === 0) return;
  const view = open[Math.floor(Math.random() * open.length)]!;
  try {
    const res = jobs.reserve(view.job.id, [1], { discordId: pilot.user.id, username: pilot.user.username });
    try {
      await writeback.claim(store.getPanel(panel.id)!, view.job.sourceKey, pilot.name);
    } catch (e) {
      if (!(e instanceof WriteBackError)) throw e;
      outcomes.conflicts++;
      jobs.release(view.job.id, pilot.user.id, res.reserved);
      return;
    }
    waits.push(performance.now() - t0);
    outcomes.reserved++;
    flown.set(view.job.id, { pilot, dep: view.legs[0]!.dep, arr: view.legs[0]!.arr, start: view.job.availableFrom ?? now(), end: view.job.deadline ?? now() + 6 * 3_600_000 });
  } catch (e) {
    log.warn(`[soak] a pilot could not reserve ${view.job.code}: ${e instanceof Error ? e.message : e}`);
  }
}
/** Some pilots give a flight back; others fly the ones they hold (FsHub then shows the flight, and the hourly check completes it). */
async function pilotsFly(): Promise<void> {
  for (const [jobId, f] of [...flown]) {
    if (jobs.view(jobId)?.job.completedAt) {
      flown.delete(jobId);
      continue;
    }
    if (now() > f.end) {
      flown.delete(jobId);
      continue;
    }
    if (Math.random() < 0.04) {
      jobs.release(jobId, f.pilot.user.id);
      try {
        await writeback.unclaim(store.getPanel(panel.id)!, jobs.view(jobId)!.job.sourceKey, f.pilot.name);
      } catch {
        /* the sheet had changed: nothing to take off */
      }
      flown.delete(jobId);
      outcomes.released++;
      continue;
    }
    if (now() >= f.start + 2 * 3_600_000 && Math.random() < 0.5) {
      const list = fshub.flights.get(AIRLINE_ID) ?? [];
      list.push({ id: nextFlightId++, pilotId: f.pilot.fshubId, pilotName: f.pilot.name, dep: f.dep, arr: f.arr, departedAt: f.start + 3_600_000, arrivedAt: f.start + 2 * 3_600_000, aircraftIcao: 'A320', aircraftName: 'Airbus A320', scheduleStatus: 'ON-TIME', landingRate: -180 } as never);
      fshub.flights.set(AIRLINE_ID, list);
      flown.delete(jobId);
      outcomes.flown++;
    }
  }
}

/* ------------------------------------------------------------------ run */

const percentile = (a: number[], p: number) => (a.length === 0 ? 0 : [...a].sort((x, y) => x - y)[Math.min(a.length - 1, Math.floor((p / 100) * a.length))]!);

log.info(`[soak] ${MINUTES} minutes at ${SCALE} times: a day is ${((24 * 60) / SCALE).toFixed(1)} minutes, an hour ${(3600 / SCALE).toFixed(1)} seconds. Files in ${dir}`);
// A first redraw and sheet read, as at start-up.
await refresher.refresh(store.getPanel(panel.id)!);
feeder.adopt({ id: TEST_SHEET_ID, gid: null });
await panels.refresh(panel.id);
scheduler.start();
perf.start();
const feedEvery = setInterval(() => feeder.feed(), Math.round(3_600_000 / SCALE));
const actEvery = setInterval(() => void pilotActs(), 8_000);
const flyEvery = setInterval(() => void pilotsFly(), 2_500);

const started = performance.now();
let lastSeen = 0;
while (performance.now() - started < MINUTES * 60_000) {
  await sleep(1_000);
  lastSeen = lines.length;
}
clearInterval(feedEvery);
clearInterval(actEvery);
clearInterval(flyEvery);
scheduler.stop();
await scheduler.idle();
perf.stop();
for (const l of perf.report()) log.info(l);

/* ------------------------------------------------------------------ the verdict */

const count = (re: RegExp) => lines.filter((l) => re.test(l)).length;
const dm = pilots.reduce((n, p) => n + p.user.dms.length, 0);
const out: string[] = [];
out.push('', '================ SOAK SUMMARY ================');
out.push(`ran ${((performance.now() - started) / 60_000).toFixed(1)} minutes = ${(((performance.now() - started) / 60_000) * SCALE / 1440).toFixed(2)} days of the bot's clock`);
out.push(`new days begun: ${count(/\[clock\] a new day begins/)}   midnight lists posted: ${count(/Listed \d+ flight\(s\) without a pilot/)}   sheet reads applied: ${count(/Refreshed Sample Airways/)}   feeder passes that changed something: ${count(/\[test\] sheet feed/)}`);
out.push(`pilots: ${outcomes.reserved} reservations (${outcomes.conflicts} refused by the sheet), ${outcomes.released} given back, ${outcomes.flown} flights shown flown by FsHub, ${count(/auto-complet|Completed .* from FsHub/i)} completion log lines, ${dm} DMs sent`);
out.push(`a pilot's wait from pressing Reserve to being told (sheet claim included): p50 ${percentile(waits, 50).toFixed(0)} ms, p90 ${percentile(waits, 90).toFixed(0)} ms, p99 ${percentile(waits, 99).toFixed(0)} ms, worst ${Math.max(0, ...waits).toFixed(0)} ms (n=${waits.length})`);
out.push(`google calls: ${slow.reads} reads, ${slow.writes} writes, ${slow.titles} tab-name asks.   discord calls: ${discord.batches} batch lookups, ${discord.gets} single lookups, ${discord.edits} edits, ${discord.sends} sends`);
out.push(`"Slow:" lines: ${count(/Slow:/)}   warnings/errors: ${count(/ (WARN|ERROR) /)}`);
for (const l of lines.filter((x) => /Slow:| (WARN|ERROR) /.test(x)).slice(0, 12)) out.push(`  ${l}`);
out.push(`log: ${logFile}`, '');
for (const l of out) console.log(l);
appendFileSync(logFile, `${out.join('\n')}\n`);
store.close();
void statSync;
void lastSeen;
if (process.env.SOAK_KEEP !== '1') setTimeout(() => rmSync(join(dir, 'debug-sheets'), { recursive: true, force: true }), 0).unref();
process.exit(0);
