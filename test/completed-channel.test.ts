import assert from 'node:assert/strict';
import { afterEach, beforeEach, describe, it } from 'node:test';
import { commands } from '../src/discord/commands/index.js';
import { UserError } from '../src/discord/errors.js';
import { CHANNEL, makeHarness, sj, USER_A, USER_B, type Harness } from './helpers.js';
import { fakeInteraction, makeDiscordHarness, messageText, settle, type DiscordHarness, type FakeInteractionOptions } from './discord-helpers.js';

const setup = commands.find((c) => c.data.name === 'setup')!;
const DONE = '800000000000000009';
const ELSEWHERE = '800000000000000010';

const guildFake = (hasPerms = true) => ({
  channels: { fetch: async (id: string) => ({ id, permissionsFor: () => ({ has: () => hasPerms }) }) },
  members: { me: {}, fetchMe: async () => ({}) },
});

describe('completed flights in a channel of their own', () => {
  let h: Harness;
  let d: DiscordHarness;
  const pid = () => h.panel.id;
  const main = () => d.client.channel(CHANNEL);
  const done = () => d.client.channel(DONE);

  beforeEach(async () => {
    h = await makeHarness();
    d = makeDiscordHarness(h);
    h.jobs.sync(pid(), [sj('a', 'EGLL-EGKK'), sj('b', 'EGLL-EGCC')]);
    await d.panels.refresh(pid());
  });
  afterEach(async () => {
    await settle(40);
    await h.close();
  });

  const run = async (o: FakeInteractionOptions = {}) => {
    const f = fakeInteraction({ sub: 'completed', admin: true, guild: guildFake(), ...o });
    await setup.execute(d.ctx, f.i);
    await settle();
    return String(f.calls.edits.at(-1)?.content ?? '');
  };
  const complete = (key: string, user = USER_A) => {
    const view = h.jobs.open(pid()).find((v) => v.job.sourceKey === key)!;
    h.jobs.reserve(view.job.id, [1], user);
    h.jobs.complete(view.job.id, user.discordId);
    return view.job.code;
  };
  const buttonIds = (m: { payload: any }) => m.payload.components.map((r: any) => r.toJSON()).flatMap((r: any) => r.components.map((c: any) => c.custom_id));

  it('shows them on the panel, below the open flights, until an admin says otherwise', async () => {
    assert.equal(main().live.length, 2);
    assert.match(messageText(main().live[1]!), /completed flights/);
    assert.equal(h.store.getPanel(pid())!.completedChannelId, null);
    assert.match(await run(), /shown on the panel itself/);
  });

  it('moves the board to the channel: the panel keeps the open flights and the buttons, the other channel gets the completed ones', async () => {
    const code = complete('a');
    await d.panels.refresh(pid());
    const text = await run({ options: { channel: { id: DONE } } });
    assert.match(text, new RegExp(`now posted in <#${DONE}>`));

    assert.equal(main().live.length, 1, 'only the open flights are left in the panel channel');
    assert.match(messageText(main().live[0]!), /open flights/);
    assert.doesNotMatch(messageText(main().live[0]!), /completed flights\n/);
    assert.ok(buttonIds(main().live[0]!).includes(`panel:reserve:${pid()}`));

    assert.equal(done().live.length, 1);
    assert.match(messageText(done().live[0]!), /completed flights/);
    assert.match(messageText(done().live[0]!), new RegExp(code));
    assert.deepEqual(buttonIds(done().live[0]!), [], 'the completed board is for reading');

    const panel = h.store.getPanel(pid())!;
    assert.equal(panel.completedChannelId, DONE);
    assert.deepEqual(panel.messageIds, main().live.map((m) => m.id));
    assert.deepEqual(panel.completedMessageIds, done().live.map((m) => m.id));
  });

  it("says on the panel where the completed flights are, and ends both boards with the disclaimer", async () => {
    await run({ options: { channel: { id: DONE } } });
    assert.match(messageText(main().live[0]!), new RegExp(`Completed flights are in <#${DONE}>`));
    const footer = (m: { payload: any }) => m.payload.embeds.at(-1).toJSON().footer?.text;
    assert.match(footer(main().live.at(-1)!), /Unofficial companion bot/);
    assert.match(footer(done().live.at(-1)!), /Unofficial companion bot/);
  });

  it('keeps each board in step afterwards: a flight completed later shows up in the completed channel, and the panel is edited in place', async () => {
    await run({ options: { channel: { id: DONE } } });
    const before = main().live.map((m) => m.id);
    const code = complete('b', USER_B);
    await settle();
    assert.deepEqual(main().live.map((m) => m.id), before, 'edited, not reposted');
    assert.match(messageText(done().live[0]!), new RegExp(code));
    assert.doesNotMatch(messageText(main().live[0]!), /FLOWN BY/, 'nothing flown is on the panel any more');
  });

  it('moves them to another channel by deleting the old ones, and puts the board in the new one', async () => {
    await run({ options: { channel: { id: DONE } } });
    const first = [...done().live];
    assert.equal(first.length, 1);
    await run({ options: { channel: { id: ELSEWHERE } } });
    assert.equal(done().live.length, 0);
    assert.equal(d.client.channel(ELSEWHERE).live.length, 1);
    assert.deepEqual(h.store.getPanel(pid())!.completedMessageIds, d.client.channel(ELSEWHERE).live.map((m) => m.id));
    assert.equal(h.store.getPanel(pid())!.completedChannelId, ELSEWHERE);
  });

  it('puts them back on the panel with mode:panel, and takes the other channel\'s messages away', async () => {
    await run({ options: { channel: { id: DONE } } });
    assert.equal(main().live.length, 1);
    const text = await run({ options: { mode: 'panel' } });
    assert.match(text, /back on the panel/);
    assert.equal(done().live.length, 0);
    assert.equal(main().live.length, 2);
    assert.match(messageText(main().live[1]!), /completed flights/);
    const panel = h.store.getPanel(pid())!;
    assert.deepEqual([panel.completedChannelId, panel.completedMessageIds], [null, []]);
    assert.deepEqual(panel.messageIds, main().live.map((m) => m.id));
    assert.match(await run({ options: { mode: 'panel' } }), /already shown on the panel itself/);
  });

  it('reports the current setting when given nothing', async () => {
    await run({ options: { channel: { id: DONE } } });
    assert.match(await run(), new RegExp(`posted in <#${DONE}>`));
  });

  it("refuses the panel's own channel (pointing to mode:panel), a channel and mode together, and a channel the bot cannot write to", async () => {
    await assert.rejects(run({ options: { channel: { id: CHANNEL } } }), (e: unknown) => e instanceof UserError && /mode:panel/.test(e.message));
    await assert.rejects(run({ options: { channel: { id: DONE }, mode: 'panel' } }), /not both/);
    await assert.rejects(run({ guild: guildFake(false), options: { channel: { id: DONE } } }), /missing permissions/);
    assert.equal(h.store.getPanel(pid())!.completedChannelId, null);
    assert.equal(main().live.length, 2, 'nothing was changed');
  });

  it('still draws the panel when the completed channel has gone, and the next draw carries on', async () => {
    await run({ options: { channel: { id: DONE } } });
    d.client.channels_.delete(DONE);
    d.client.autoCreate = false;
    complete('a');
    const result = await d.panels.refresh(pid());
    assert.equal(result, 'updated');
    assert.equal(main().live.length, 1);
  });

  it('removes the completed channel\'s messages with the panel', async () => {
    await run({ options: { channel: { id: DONE } } });
    const f = fakeInteraction({ sub: 'panel-remove', admin: true, options: { airline: 'TST' } });
    await setup.execute(d.ctx, f.i);
    assert.equal(done().live.length, 0);
    assert.equal(main().live.length, 0);
    assert.equal(h.store.getPanel(pid()), null);
  });

  it("is listed in /setup panels", async () => {
    const list = async () => {
      const f = fakeInteraction({ sub: 'panels', admin: true });
      await setup.execute(d.ctx, f.i);
      return String(f.calls.edits.at(-1)?.content ?? '');
    };
    assert.match(await list(), /completed flights: on the panel/);
    await run({ options: { channel: { id: DONE } } });
    assert.match(await list(), new RegExp(`completed flights: in <#${DONE}>`));
  });

  it('moves with the panel: giving it another channel redraws both boards where they belong', async () => {
    await run({ options: { channel: { id: DONE } } });
    const f = fakeInteraction({ sub: 'panel-add', admin: true, guild: guildFake(), options: { airline: 'Test Air', channel: { id: ELSEWHERE } } });
    await setup.execute(d.ctx, f.i);
    await settle();
    assert.equal(main().live.length, 0);
    assert.equal(d.client.channel(ELSEWHERE).live.length, 1, 'the open flights');
    assert.equal(done().live.length, 1, 'the completed board is back in its channel, freshly drawn');
    assert.equal(h.store.getPanel(pid())!.completedChannelId, DONE);
  });
});
