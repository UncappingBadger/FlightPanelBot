import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, it } from 'node:test';
import { dailyHours, loadConfig } from '../src/config.js';
import { hostPaths } from '../src/host/paths.js';
import { loadSettings, saveSettings, toConfig } from '../src/host/settings.js';
import { composeNote, DailyNote, FIRE_KEVIN, NOTES, REHIRE_KEVIN, signature, STALE_AFTER_MS } from '../src/services/dailyNote.js';
import { Scheduler } from '../src/services/scheduler.js';
import { handleDmMessage } from '../src/discord/dm.js';
import { HOUR, T0, makeHarness, type Harness } from './helpers.js';
import { FakeUser, fakeDm, makeDiscordHarness, settle } from './discord-helpers.js';

/* Everything below is made up. */

const MIN = 60_000;
const DAY = 24 * HOUR;
const TARGET = '123456789012345678';
const BOT_ID = '1234567890123456789';
const TOKEN = `${Buffer.from(BOT_ID).toString('base64')}.Gabc12.${'x'.repeat(27)}`;
/** 2026-11-11 00:00Z */
const DAY0 = T0 - 12 * HOUR;

/* ------------------------------------------------------------------ the notes themselves */

describe('the notes', () => {
  it('are plenty, all different, and not too long to send', () => {
    assert.ok(NOTES.length >= 60, `${NOTES.length} notes`);
    assert.equal(new Set(NOTES).size, NOTES.length, 'no note is there twice');
    for (const n of NOTES) {
      assert.ok(n.length >= 25 && n.length <= 400, `${n.length}: ${n.slice(0, 40)}`);
      assert.match(n, /[.!?)'"]$/, `ends like a sentence: ${n.slice(-30)}`);
      assert.ok(composeNote(n, 1, 'Test Air').length < 1800);
    }
  });

  it('keep clear of real names, and of anything rude', () => {
    const all = NOTES.join('\n').toLowerCase();
    for (const word of ['wolf', 'wlf', 'fshub', 'error404', 'damn', 'shit', 'fuck', 'bastard', 'hell ', 'crap', 'idiot', 'stupid']) {
      assert.ok(!all.includes(word), `contains ${word}`);
    }
    assert.ok(!/\b[A-Z]{2,3}-\d{3}\b/.test(NOTES.join('\n')), 'no flight IDs of any airline');
  });

  it('are sent with who they are from, how to fire him, and nothing left over from the template', () => {
    for (const n of NOTES) {
      const text = composeNote(n, 1, 'Test Air');
      assert.match(text, /^☕ \*\*Kevin, Scheduler\*\*\n/);
      assert.ok(text.includes('`fire kevin`'), 'the way to turn them off is in every one');
      assert.ok(!text.includes('{airline}'));
      assert.ok(text.includes('— Kevin'));
    }
  });

  it('use the airline\'s name where a note has a place for it, and "the airline" when it is not known', () => {
    const withName = NOTES.find((n) => n.includes('{airline}'))!;
    assert.ok(composeNote(withName, 1, 'Test Air').includes('Test Air'));
    const without = composeNote(withName, 1, null);
    assert.ok(without.includes('the airline') && !without.includes('Test Air'));
  });

  it('sign each Kevin: the first, the second, and then Mk 3, Mk 4', () => {
    assert.equal(signature(1), '— Kevin');
    assert.match(signature(2), /the second one/);
    assert.equal(signature(3), '— Kevin (Mk 3)');
    assert.equal(signature(12), '— Kevin (Mk 12)');
    assert.match(composeNote(NOTES[0]!, 1, null), /\(It won't be the first time\.\)/);
    assert.match(composeNote(NOTES[0]!, 2, null), /fire me too/);
  });

  it('are fired and rehired by what the person types, however they type it', () => {
    for (const t of ['fire kevin', 'Fire Kevin', '  FIRE   KEVIN.  ', 'fire kevin!', 'fire kevin\n']) assert.match(t, FIRE_KEVIN, t);
    for (const t of ['rehire kevin', 'Re-hire Kevin', 'hire kevin', 'REHIRE KEVIN!!']) assert.match(t, REHIRE_KEVIN, t);
    for (const t of ['fire', 'fire kevin now please', 'kevin', 'please fire kevin', 'fire the kevin', 'rehire', 'flights', 'name Sam']) {
      assert.doesNotMatch(t, FIRE_KEVIN, t);
      assert.doesNotMatch(t, REHIRE_KEVIN, t);
    }
  });
});

/* ------------------------------------------------------------------ when one is sent */

describe('the once-a-day note', () => {
  let h: Harness;
  let sent: Array<{ to: string; content: string }>;
  let deliver: boolean;
  let rnd: number;
  let airline: string | null;
  let n: DailyNote;
  const build = (over: Partial<ConstructorParameters<typeof DailyNote>[0]> = {}) =>
    new DailyNote({
      store: h.store,
      target: { userId: TARGET, fromHour: 14, toHour: 23 },
      send: async (to, content) => (sent.push({ to, content }), deliver),
      airlineName: async () => airline,
      now: () => h.clock.now,
      random: () => rnd,
      ...over,
    });
  const at = (day: number, hour: number, minute = 0) => DAY0 + day * DAY + hour * HOUR + minute * MIN;

  beforeEach(async () => {
    h = await makeHarness();
    sent = [];
    deliver = true;
    rnd = 0.5;
    airline = 'Test Air';
    n = build();
  });
  afterEach(() => h.close());

  describe('when', () => {
    it('plans a time inside the window the first time it looks, and sends nothing then', async () => {
      h.clock.now = at(0, 9); // 09:00Z, the window is 14:00 to 23:00
      assert.equal(await n.run(), false);
      assert.deepEqual(sent, []);
      assert.equal(n.plannedAt, at(0, 18, 30), 'half way through the window, with the random number at a half');
      rnd = 0;
      const early = build();
      h.store.setKv('daily.next', '');
      await early.run();
      assert.equal(early.plannedAt, at(0, 14), 'at the start with 0');
      rnd = 0.999999;
      h.store.setKv('daily.next', '');
      await build().run();
      assert.ok(n.plannedAt! <= at(0, 23) && n.plannedAt! > at(0, 22, 59), 'and at the end with almost 1');
    });

    it('plans later today when it is already part way through the window, and tomorrow when too little of it is left', async () => {
      h.clock.now = at(0, 16);
      await n.run();
      assert.equal(n.plannedAt, Math.floor(at(0, 16, 5) + 0.5 * (at(0, 23) - at(0, 16, 5))), 'after the next five minutes, before the end');
      h.store.setKv('daily.next', '');
      h.clock.now = at(0, 22, 58);
      await n.run();
      assert.equal(n.plannedAt, at(1, 18, 30), 'tomorrow');
      h.store.setKv('daily.next', '');
      h.clock.now = at(0, 23, 30);
      await n.run();
      assert.equal(n.plannedAt, at(1, 18, 30), 'tomorrow, once the window has closed');
    });

    it('sends at the planned time and not before', async () => {
      h.clock.now = at(0, 9);
      await n.run();
      h.clock.now = at(0, 18, 29);
      assert.equal(await n.run(), false);
      h.clock.now = at(0, 18, 30);
      assert.equal(await n.run(), true);
      assert.equal(sent.length, 1);
      assert.equal(sent[0]!.to, TARGET);
    });

    it('sends the introduction first, then one of the notes each day, never two in a day', async () => {
      h.clock.now = at(0, 9);
      await n.run();
      h.clock.now = at(0, 19);
      await n.run();
      assert.match(sent[0]!.content, /Kevin here, your scheduler/);
      assert.ok(sent[0]!.content.includes('`fire kevin`'));
      assert.equal(await n.run(), false);
      h.clock.now = at(0, 22);
      assert.equal(await n.run(), false);
      assert.equal(sent.length, 1, 'once a day');
      assert.ok(n.plannedAt! > at(1, 14) - 1 && n.plannedAt! < at(1, 23) + 1, 'the next one is tomorrow, in the window');
      h.clock.now = at(1, 19);
      assert.equal(await n.run(), true);
      assert.doesNotMatch(sent[1]!.content, /Kevin here, your scheduler/);
      assert.ok(NOTES.some((x) => sent[1]!.content.includes(x.split('{airline}').join('Test Air'))));
    });

    it('moves the time about from day to day', async () => {
      h.clock.now = at(0, 9);
      await n.run();
      const times: number[] = [];
      for (const r of [0.1, 0.9, 0.4, 0.7]) {
        rnd = r;
        h.clock.now = n.plannedAt!;
        await n.run();
        times.push(n.plannedAt! - startOfDay(n.plannedAt!));
      }
      assert.equal(new Set(times).size, 4, times.join(','));
      assert.ok(times.every((t) => t >= 14 * HOUR && t <= 23 * HOUR));
    });

    it('does not send late after being off: it plans a fresh time instead', async () => {
      h.clock.now = at(0, 9);
      await n.run();
      const planned = n.plannedAt!;
      h.clock.now = planned + STALE_AFTER_MS + MIN; // the bot was off through it
      assert.equal(await n.run(), false);
      assert.deepEqual(sent, []);
      assert.notEqual(n.plannedAt, planned);
      assert.ok(n.plannedAt! > h.clock.now, 'a time still to come');
    });

    it('still sends if the bot was only a little late', async () => {
      h.clock.now = at(0, 9);
      await n.run();
      h.clock.now = n.plannedAt! + STALE_AFTER_MS - MIN;
      assert.equal(await n.run(), true);
    });

    it('keeps its plan through a restart, and does not send again the same day', async () => {
      h.clock.now = at(0, 9);
      await n.run();
      h.clock.now = n.plannedAt!;
      await n.run();
      const again = build();
      h.clock.now += 5 * MIN;
      assert.equal(await again.run(), false);
      assert.equal(sent.length, 1);
    });

    it('does not send when a note has already gone today, even if a time was planned that is now due', async () => {
      h.clock.now = at(0, 9);
      await n.run();
      h.clock.now = n.plannedAt!;
      await n.run();
      assert.equal(sent.length, 1);
      h.store.setKv('daily.next', String(h.clock.now - MIN)); // a plan for a time just gone, in the same day
      assert.equal(await n.run(), false);
      assert.equal(sent.length, 1);
      assert.ok(n.plannedAt! >= at(1, 14), 'and the next is for tomorrow');
    });

    it('remembers a note went today, so losing the plan does not make it plan another for today', async () => {
      h.clock.now = at(0, 9);
      await n.run();
      h.clock.now = n.plannedAt!;
      await n.run();
      h.store.setKv('daily.next', '');
      h.clock.advance(MIN);
      await n.run();
      assert.ok(n.plannedAt! >= at(1, 14), 'tomorrow, not later today');
    });

    it('does not plan today when a note has already gone today (a restart before the plan was saved)', async () => {
      h.store.setKv('daily.last', new Date(at(0, 15)).toISOString().slice(0, 10));
      h.store.setKv('daily.sent', '3');
      h.clock.now = at(0, 16);
      await n.run();
      assert.ok(n.plannedAt! >= at(1, 14) && n.plannedAt! <= at(1, 23));
    });

    it('follows the hours it was given', async () => {
      const night = build({ target: { userId: TARGET, fromHour: 6, toHour: 8 } });
      h.clock.now = at(0, 1);
      rnd = 0;
      await night.run();
      assert.equal(night.plannedAt, at(0, 6));
      rnd = 1 - 1e-9;
      h.store.setKv('daily.next', '');
      await night.run();
      assert.ok(night.plannedAt! >= at(0, 7, 59));
    });
  });

  describe('when it cannot be delivered', () => {
    it('is tried again half an hour later, and counts as sent only once it goes', async () => {
      h.clock.now = at(0, 9);
      await n.run();
      h.clock.now = n.plannedAt!;
      deliver = false;
      assert.equal(await n.run(), false);
      assert.equal(sent.length, 1);
      assert.equal(n.plannedAt, h.clock.now + 30 * MIN);
      h.clock.advance(29 * MIN);
      await n.run();
      assert.equal(sent.length, 1, 'not hammered');
      h.clock.advance(2 * MIN);
      deliver = true;
      assert.equal(await n.run(), true);
      assert.equal(sent.length, 2);
      assert.equal(h.store.getKv('daily.sent'), '1');
    });

    it('is given up for the day when the window has closed, and tried again tomorrow', async () => {
      h.clock.now = at(0, 9);
      await n.run();
      h.clock.now = at(0, 22, 50);
      h.store.setKv('daily.next', String(at(0, 22, 40)));
      deliver = false;
      await n.run();
      assert.ok(n.plannedAt! >= at(1, 14), 'tomorrow');
    });

    it('never throws, whatever goes wrong', async () => {
      h.clock.now = at(0, 9);
      await n.run();
      h.clock.now = n.plannedAt!;
      const broken = build({ send: async () => Promise.reject(new Error('boom')) });
      assert.equal(await broken.run(), false);
      const noName = build({ airlineName: async () => Promise.reject(new Error('no')) });
      h.store.setKv('daily.sent', '2');
      h.clock.now = n.plannedAt!;
      await assert.doesNotReject(noName.run());
    });
  });

  describe('which note', () => {
    it('is never the same twice until every one has been used, and then goes round again', async () => {
      h.store.setKv('daily.sent', '1');
      const seen: string[] = [];
      for (let day = 0; day < NOTES.length * 2 + 3; day++) {
        h.clock.now = at(day, 9);
        h.store.setKv('daily.next', '');
        await n.run();
        h.clock.now = n.plannedAt!;
        await n.run();
        seen.push(sent.at(-1)!.content);
      }
      const first = new Set(seen.slice(0, NOTES.length));
      assert.equal(first.size, NOTES.length, 'every note once before any repeats');
      assert.equal(new Set(seen.slice(NOTES.length, NOTES.length * 2)).size, NOTES.length, 'and again');
    });

    it('is shuffled, and the order is kept through a restart', async () => {
      h.store.setKv('daily.sent', '1');
      rnd = 0.3;
      const shuffled = build();
      h.clock.now = at(0, 9);
      await shuffled.run();
      const bag = JSON.parse(h.store.getKv('daily.bag') ?? 'null');
      assert.equal(bag, null, 'nothing is drawn until a note goes');
      h.clock.now = shuffled.plannedAt!;
      await shuffled.run();
      const left = JSON.parse(h.store.getKv('daily.bag')!) as number[];
      assert.equal(left.length, NOTES.length - 1);
      assert.notDeepEqual(left, [...left].sort((a, b) => a - b), 'not in the order they are written');
      const resumed = build();
      h.clock.now = at(1, 9);
      await resumed.run();
      h.clock.now = resumed.plannedAt!;
      await resumed.run();
      assert.equal(JSON.parse(h.store.getKv('daily.bag')!).length, NOTES.length - 2);
    });

    it('copes with a damaged list', async () => {
      h.store.setKv('daily.sent', '1');
      h.store.setKv('daily.bag', '{nonsense');
      h.clock.now = at(0, 9);
      await n.run();
      h.clock.now = n.plannedAt!;
      assert.equal(await n.run(), true);
      h.store.setKv('daily.bag', JSON.stringify([5, 'x', -1, 9999, 7, 1.5, null]));
      for (let day = 1; day <= 4; day++) {
        h.clock.now = at(day, 9);
        h.store.setKv('daily.next', '');
        await n.run();
        h.clock.now = n.plannedAt!;
        assert.equal(await n.run(), true, `day ${day}`);
        assert.doesNotMatch(sent.at(-1)!.content, /undefined/);
      }
    });

    it('names the airline when it is found, and says "the airline" when it is not', async () => {
      h.store.setKv('daily.sent', '1');
      const only = NOTES.findIndex((x) => x.includes('{airline}'));
      h.store.setKv('daily.bag', JSON.stringify([only]));
      h.clock.now = at(0, 9);
      await n.run();
      h.clock.now = n.plannedAt!;
      await n.run();
      assert.ok(sent.at(-1)!.content.includes('Test Air'));
      airline = null;
      h.store.setKv('daily.bag', JSON.stringify([only]));
      h.clock.now = at(1, 9);
      await n.run();
      h.clock.now = n.plannedAt!;
      await n.run();
      assert.ok(sent.at(-1)!.content.includes('the airline'));
    });
  });

  describe('turning it off and on', () => {
    it('stops when the person fires Kevin, says so, and sends nothing more', async () => {
      h.clock.now = at(0, 9);
      await n.run();
      const reply = n.handleReply(TARGET, 'fire kevin')!;
      assert.match(reply, /clear my desk/);
      assert.ok(reply.includes('`rehire kevin`'));
      assert.equal(n.fired, true);
      h.clock.now = n.plannedAt!; // the very time it was planned for
      assert.equal(await n.run(), false);
      h.clock.now = at(5, 20);
      assert.equal(await n.run(), false);
      assert.deepEqual(sent, []);
    });

    it('says he is already fired when fired again, and already hired when hired twice', () => {
      n.handleReply(TARGET, 'fire kevin');
      assert.match(n.handleReply(TARGET, 'Fire Kevin')!, /already fired/);
      n.handleReply(TARGET, 'rehire kevin');
      assert.match(n.handleReply(TARGET, 'rehire kevin')!, /already on the payroll/);
    });

    it('brings back a new Kevin when asked: the next one, signed so, planned for another day', async () => {
      assert.equal(n.generation, 1);
      n.handleReply(TARGET, 'fire kevin');
      h.clock.now = at(0, 9);
      const reply = n.handleReply(TARGET, 'rehire kevin')!;
      assert.match(reply, /New Kevin reporting for duty/);
      assert.ok(reply.includes('— Kevin (the second one'));
      assert.ok(reply.includes('`fire kevin`'));
      assert.equal(n.generation, 2);
      assert.equal(n.fired, false);
      assert.ok(n.plannedAt! > h.clock.now);
      h.store.setKv('daily.sent', '1');
      h.clock.now = n.plannedAt!;
      await n.run();
      assert.ok(sent.at(-1)!.content.includes('— Kevin (the second one'));
      n.handleReply(TARGET, 'fire kevin');
      n.handleReply(TARGET, 'hire kevin');
      assert.equal(n.generation, 3);
      assert.match(signature(n.generation), /Mk 3/);
    });

    it('answers only the person it writes to, and only to those words', () => {
      assert.equal(n.handleReply('999999999999999999', 'fire kevin'), null);
      assert.equal(n.fired, false);
      assert.equal(n.handleReply(TARGET, 'fire'), null);
      assert.equal(n.handleReply(TARGET, 'flights'), null);
      assert.equal(n.fired, false);
    });

    it('keeps it off through a restart', async () => {
      n.handleReply(TARGET, 'fire kevin');
      const again = build();
      assert.equal(again.fired, true);
      h.clock.now = at(0, 20);
      assert.equal(await again.run(), false);
    });
  });
});

const startOfDay = (ms: number) => ms - (((ms % DAY) + DAY) % DAY);

/* ------------------------------------------------------------------ in the bot */

describe('replying to Kevin in a direct message', () => {
  let h: Harness;
  let d: DiscordHarness;
  let ceo: FakeUser;
  let other: FakeUser;
  let note: DailyNote;
  type DiscordHarness = ReturnType<typeof makeDiscordHarness>;

  beforeEach(async () => {
    h = await makeHarness();
    d = makeDiscordHarness(h);
    ceo = d.client.user(new FakeUser(TARGET, 'ceo'));
    other = d.client.user(new FakeUser('222222222222222222', 'pilot'));
    note = new DailyNote({ store: h.store, target: { userId: TARGET, fromHour: 14, toHour: 23 }, send: async () => true, now: () => h.clock.now });
    (d.ctx as { dailyNote?: DailyNote }).dailyNote = note;
  });
  afterEach(async () => {
    await settle(40);
    await h.close();
  });

  it('fires him, answers in a direct message, and brings him back', async () => {
    await handleDmMessage(d.ctx, fakeDm(ceo, 'fire kevin'));
    assert.equal(note.fired, true);
    assert.match(String(ceo.dms.at(-1).content), /clear my desk/);
    await handleDmMessage(d.ctx, fakeDm(ceo, 'rehire kevin'));
    assert.equal(note.fired, false);
    assert.match(String(ceo.dms.at(-1).content), /New Kevin reporting for duty/);
  });

  it('is not something anyone else can do, and is just another message to the bot from them', async () => {
    await handleDmMessage(d.ctx, fakeDm(other, 'fire kevin'));
    assert.equal(note.fired, false);
    assert.ok(!other.dms.some((m) => /clear my desk/.test(String(m.content))));
  });

  it('leaves the person\'s other messages to the bot alone', async () => {
    await handleDmMessage(d.ctx, fakeDm(ceo, 'flights'));
    assert.ok(ceo.dms.length >= 1);
    assert.doesNotMatch(String(ceo.dms.at(-1).content), /Kevin/);
  });

  it('does nothing at all where it is not set up', async () => {
    (d.ctx as { dailyNote?: DailyNote | null }).dailyNote = null;
    await handleDmMessage(d.ctx, fakeDm(ceo, 'fire kevin'));
    assert.ok(!ceo.dms.some((m) => /clear my desk/.test(String(m.content))));
  });
});

/* ------------------------------------------------------------------ the scheduler */

describe('the scheduler and the note', () => {
  let h: Harness;
  beforeEach(async () => {
    h = await makeHarness();
  });
  afterEach(() => h.close());

  it('runs it in the lane, last, and by itself', async () => {
    const d = makeDiscordHarness(h);
    const calls: string[] = [];
    const s = new Scheduler(h.jobs, d.refresher, {
      departures: { run: async () => void calls.push('departures') },
      daily: { run: async () => void calls.push('daily') },
    });
    await s.tick();
    await s.idle();
    assert.deepEqual(calls, ['departures', 'daily']);
    const alone: string[] = [];
    const s2 = new Scheduler(h.jobs, d.refresher, { daily: { run: async () => void alone.push('daily') } });
    await s2.tick();
    await s2.idle();
    assert.deepEqual(alone, ['daily']);
    await settle(40);
  });

  it('keeps going when it fails', async () => {
    const d = makeDiscordHarness(h);
    const s = new Scheduler(h.jobs, d.refresher, { daily: { run: async () => Promise.reject(new Error('boom')) } });
    await assert.doesNotReject(s.tick());
    await assert.doesNotReject(s.idle());
    await settle(40);
  });
});

/* ------------------------------------------------------------------ settings and config */

describe('who gets it is set by the host, and nobody is by default', () => {
  let dir: string;
  let paths: ReturnType<typeof hostPaths>;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'fpb-note-'));
    paths = hostPaths(dir);
  });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  it('is nobody when the settings do not say, and the settings file does not carry it', () => {
    assert.equal(loadSettings(paths).dailyNote, undefined);
    saveSettings(paths, { discordToken: TOKEN, checkForUpdates: true, logLevel: 'info', fshubAccessToken: '' });
    const text = readFileSync(paths.settings, 'utf8');
    assert.doesNotMatch(text, /dailyNote/i);
    assert.equal(toConfig(paths, loadSettings(paths)).dailyNote, undefined);
  });

  it('is the person named in the settings file, kept when the file is saved again', () => {
    writeFileSync(paths.settings, JSON.stringify({ discordToken: TOKEN, dailyNoteUserId: ` ${TARGET} ` }));
    const s = loadSettings(paths);
    assert.deepEqual(s.dailyNote, { userId: TARGET, fromHour: 14, toHour: 23 });
    saveSettings(paths, s);
    assert.equal(JSON.parse(readFileSync(paths.settings, 'utf8')).dailyNoteUserId, TARGET);
    assert.deepEqual(loadSettings(paths).dailyNote, { userId: TARGET, fromHour: 14, toHour: 23 });
    assert.deepEqual(toConfig(paths, s).dailyNote, { userId: TARGET, fromHour: 14, toHour: 23 });
  });

  it('takes the hours given, if they make a window, and ignores a person who is not a Discord ID', () => {
    writeFileSync(paths.settings, JSON.stringify({ discordToken: TOKEN, dailyNoteUserId: TARGET, dailyNoteFromHour: 8, dailyNoteToHour: 12 }));
    assert.deepEqual(toConfig(paths, loadSettings(paths)).dailyNote, { userId: TARGET, fromHour: 8, toHour: 12 });
    writeFileSync(paths.settings, JSON.stringify({ discordToken: TOKEN, dailyNoteUserId: TARGET, dailyNoteFromHour: 20, dailyNoteToHour: 10 }));
    assert.deepEqual(toConfig(paths, loadSettings(paths)).dailyNote, { userId: TARGET, fromHour: 14, toHour: 23 }, 'backwards is not a window');
    for (const bad of ['kevin', '123', 'someone#1234', '<@123456789012345678>', '']) {
      writeFileSync(paths.settings, JSON.stringify({ discordToken: TOKEN, dailyNoteUserId: bad }));
      assert.equal(loadSettings(paths).dailyNote, undefined, bad);
    }
    assert.ok(existsSync(paths.settings));
  });

  it('can also be set in the environment, for a host that runs from a .env file', () => {
    const base = { DISCORD_TOKEN: TOKEN, DISCORD_CLIENT_ID: BOT_ID };
    assert.equal(loadConfig(base).dailyNote, undefined);
    assert.deepEqual(loadConfig({ ...base, DAILY_NOTE_USER_ID: TARGET }).dailyNote, { userId: TARGET, fromHour: 14, toHour: 23 });
    assert.deepEqual(loadConfig({ ...base, DAILY_NOTE_USER_ID: TARGET, DAILY_NOTE_FROM_HOUR: '9', DAILY_NOTE_TO_HOUR: '17' }).dailyNote, { userId: TARGET, fromHour: 9, toHour: 17 });
    assert.throws(() => loadConfig({ ...base, DAILY_NOTE_USER_ID: 'kevin' }), /Discord user ID/);
    assert.deepEqual(dailyHours(10, 10), { fromHour: 14, toHour: 23 });
    assert.deepEqual(dailyHours(undefined, 12), { fromHour: 14, toHour: 23 });
  });
});
