import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { afterEach, beforeEach, describe, it } from 'node:test';
import { commands, componentHandlers } from '../src/discord/commands/index.js';
import { describeError, isDmClosed, UserError } from '../src/discord/errors.js';
import { registerInteractionRouter } from '../src/discord/router.js';
import { ImportError } from '../src/jobs/import.js';
import { JobError } from '../src/services/jobs.js';
import { silentLogger } from '../src/util/log.js';
import { makeHarness, USER_A, type Harness } from './helpers.js';
import { fakeDm, fakeInteraction, FakeUser, makeDiscordHarness, settle, type DiscordHarness } from './discord-helpers.js';

describe('command definitions', () => {
  const defs = commands.map((c) => c.data.toJSON());

  it('only exposes admin setup, help and the fuel lookup: pilots use the panel buttons for everything else', () => {
    assert.deepEqual(defs.map((d) => d.name).sort(), ['fuel', 'help', 'setup']);
  });

  it('obeys the Discord limits that the API would otherwise reject at registration', () => {
    const NAME = /^[\p{Ll}\p{Lm}\p{Lo}\p{N}_-]{1,32}$/u;
    const checkOptions = (path: string, options: any[] = []) => {
      assert.ok(options.length <= 25, `${path}: too many options`);
      let sawOptional = false;
      for (const o of options) {
        assert.match(o.name, NAME, `${path}.${o.name}: bad name`);
        assert.ok(o.description?.length >= 1 && o.description.length <= 100, `${path}.${o.name}: description length ${o.description?.length}`);
        if (o.type === 1 || o.type === 2) {
          checkOptions(`${path}.${o.name}`, o.options);
          continue;
        }
        if (!o.required) sawOptional = true;
        else assert.ok(!sawOptional, `${path}.${o.name}: required option after an optional one`);
        if (o.autocomplete) assert.ok([3, 4, 10].includes(o.type), `${path}.${o.name}: autocomplete on an unsupported type`);
      }
    };
    for (const d of defs) {
      assert.match(d.name, NAME);
      assert.ok(d.description.length >= 1 && d.description.length <= 100, `${d.name}: description length`);
      checkOptions(d.name, d.options as any[]);
    }
  });

  it('every autocomplete option has a handler on its command', () => {
    for (const c of commands) {
      const hasAuto = JSON.stringify(c.data.toJSON()).includes('"autocomplete":true');
      assert.equal(!!c.autocomplete, hasAuto, `${c.data.name}: autocomplete handler mismatch`);
    }
  });

  it('every component prefix used in custom IDs has a handler', () => {
    assert.deepEqual(componentHandlers.map((h) => h.prefix).sort(), ['dm', 'panel']);
  });
});

describe('describeError', () => {
  it('shows expected errors verbatim and hides unexpected ones', () => {
    assert.equal(describeError(new UserError('do the thing'), silentLogger), 'do the thing');
    assert.equal(describeError(new JobError('NOT_FOUND', 'gone'), silentLogger), 'gone');
    assert.ok(!describeError(new Error('secret stack detail'), silentLogger).includes('secret'));
  });

  it('lists an import\'s problems as bullets', () => {
    const text = describeError(new ImportError('Nothing was imported: 2 problems found.', ['row 2: bad', 'row 3: worse']), silentLogger);
    assert.equal(text, 'Nothing was imported: 2 problems found.\n• row 2: bad\n• row 3: worse');
  });

  it('recognises Discord\'s "DMs closed" error', () => {
    assert.equal(isDmClosed(Object.assign(new Error('x'), { code: 50007 })), true);
    assert.equal(isDmClosed(Object.assign(new Error('x'), { code: 10003 })), false);
    assert.equal(isDmClosed('nope'), false);
  });
});

describe('router', () => {
  let h: Harness;
  let d: DiscordHarness;
  beforeEach(async () => {
    h = await makeHarness();
    d = makeDiscordHarness(h);
  });
  afterEach(async () => {
    await settle(40);
    await h.close();
  });

  const makeRouter = () => {
    const client = new EventEmitter();
    registerInteractionRouter(client as never, d.ctx);
    return client;
  };

  it('answers /help for anyone', async () => {
    const client = makeRouter();
    const f = fakeInteraction({ admin: false });
    (f.i as any).commandName = 'help';
    client.emit('interactionCreate', f.i);
    await settle();
    assert.equal(f.calls.replies[0].flags, 64);
    assert.match(JSON.stringify(f.calls.replies[0].embeds[0].toJSON()), /Press \*\*Reserve\*\*/);
  });

  it('turns an expected error into an ephemeral reply when nothing was sent yet', async () => {
    const client = makeRouter();
    const f = fakeInteraction({ admin: false });
    (f.i as any).commandName = 'setup';
    client.emit('interactionCreate', f.i);
    await settle();
    assert.equal(f.calls.replies.length, 1);
    assert.match(f.calls.replies[0].content, /^⚠️ Only server admins/);
    assert.equal(f.calls.replies[0].flags, 64);
  });

  it('edits the deferred reply when the error happens after deferring', async () => {
    const client = makeRouter();
    const f = fakeInteraction({ admin: true, sub: 'panels' });
    (f.i as any).commandName = 'setup';
    client.emit('interactionCreate', f.i); // a normal reply, edited in after deferring
    await settle();
    assert.match(f.calls.edits.at(-1).content, /Test Air/);
    assert.doesNotMatch(f.calls.edits.at(-1).content, /^⚠️/);

    const g = fakeInteraction({ admin: true, sub: 'release', options: { code: 'TST-404' } });
    (g.i as any).commandName = 'setup';
    client.emit('interactionCreate', g.i); // deferred first, then the "can't find that flight" error
    await settle();
    assert.equal(g.calls.replies.length, 0, 'no second reply; the deferred one is edited');
    assert.match(g.calls.edits.at(-1).content, /^⚠️ I can't find an open flight/);
  });

  it('never leaks internals for unexpected errors', async () => {
    const client = makeRouter();
    const f = fakeInteraction({});
    (f.i as any).commandName = 'help';
    (f.i as any).reply = async () => {
      throw new Error('db password is hunter2');
    };
    client.emit('interactionCreate', f.i);
    await settle();
    assert.ok(!JSON.stringify(f.calls).includes('hunter2'));
  });

  it('answers autocomplete errors with an empty list rather than failing', async () => {
    const client = makeRouter();
    const f = fakeInteraction({ focused: { name: 'airline', value: '' } });
    (f.i as any).commandName = 'setup';
    (f.i as any).isChatInputCommand = () => false;
    (f.i as any).isAutocomplete = () => true;
    (f.i as any).options.getFocused = () => {
      throw new Error('boom');
    };
    client.emit('interactionCreate', f.i);
    await settle();
    assert.deepEqual(f.calls.responds[0], []);
  });

  it('routes direct messages to the Reserve conversation', async () => {
    const client = makeRouter();
    const stranger = new FakeUser('666666666666666666', 'stranger');
    client.emit('messageCreate', fakeDm(stranger, 'hello'));
    await settle();
    assert.match(stranger.lastText, /press \*\*Reserve\*\*/);
  });

  it('routes component interactions by their custom-id prefix', async () => {
    const client = makeRouter();
    const user = new FakeUser(USER_A.discordId, 'alice');
    const calls: any = { updates: [], replies: [] };
    const i: any = {
      customId: 'dm:all',
      user,
      guildId: null,
      isChatInputCommand: () => false,
      isAutocomplete: () => false,
      isButton: () => true,
      isStringSelectMenu: () => false,
      isModalSubmit: () => false,
      update: async (p: any) => calls.updates.push(p),
      reply: async (p: any) => calls.replies.push(p),
    };
    client.emit('interactionCreate', i);
    await settle();
    assert.match(calls.updates[0].content, /has closed/);
  });
});
