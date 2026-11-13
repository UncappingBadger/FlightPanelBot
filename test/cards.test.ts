import assert from 'node:assert/strict';
import { afterEach, beforeEach, describe, it } from 'node:test';
import { avatarIdsOf, defaultAvatar, openCard, OPEN_STAMP_REF, profileUrl, searchEmbeds, stampFiles, usesStamp, type Avatars } from '../src/discord/ui.js';
import { CHANNEL, makeHarness, sj, T0, USER_A, USER_B, USER_C, type Harness } from './helpers.js';
import { INVITE_PERMISSIONS } from '../src/host/invite.js';
import { FakeUser, makeDiscordHarness, settle, type DiscordHarness } from './discord-helpers.js';

const avatar = (id: string) => ({ large: `https://cdn.test/${id}-large.png`, small: `https://cdn.test/${id}-small.png` });
const avatars = (...ids: string[]): Avatars => new Map(ids.map((id) => [id, avatar(id)]));

describe('the cards of the panel', () => {
  let h: Harness;
  beforeEach(async () => {
    h = await makeHarness();
  });
  afterEach(() => h.close());

  const view = (key = 'a') => h.jobs.open(h.panel.id).find((v) => v.job.sourceKey === key)!;
  const json = (key = 'a', a?: Avatars) => openCard(view(key), T0, a).toJSON();

  describe('the OPEN stamp', () => {
    it('is on a flight that still needs a pilot, in the card\'s corner, whether or not pictures are known', () => {
      h.jobs.sync(h.panel.id, [sj('a', 'EGLL-EGKK')]);
      assert.equal(json().thumbnail?.url, OPEN_STAMP_REF);
      assert.equal(json('a', avatars()).thumbnail?.url, OPEN_STAMP_REF);
    });

    it('is still there while a leg of a multi-leg flight is free, however many are taken', () => {
      h.jobs.sync(h.panel.id, [sj('m', 'EGLL-EGKK-EGCC')]);
      h.jobs.reserve(view('m').job.id, [1], USER_A);
      assert.equal(json('m', avatars(USER_A.discordId)).thumbnail?.url, OPEN_STAMP_REF);
    });

    it('is a picture carried inside the bot and attached to the message, so it needs no address to load from', () => {
      assert.equal(OPEN_STAMP_REF, 'attachment://open-stamp.png');
      h.jobs.sync(h.panel.id, [sj('a', 'EGLL-EGKK'), sj('b', 'EGLL-EGCC')]);
      h.jobs.reserve(view('b').job.id, [1], USER_A);
      const open = openCard(view('a'), T0);
      const taken = openCard(view('b'), T0, avatars(USER_A.discordId));
      assert.equal(usesStamp([open]), true);
      assert.equal(usesStamp([taken]), false);
      assert.deepEqual(stampFiles([taken]), [], 'nothing to attach when no card wears it');
      const [file] = stampFiles([taken, open]);
      assert.equal(stampFiles([taken, open]).length, 1, 'one copy, however many cards wear it');
      assert.equal((file as any).name, 'open-stamp.png');
      const bytes = (file as any).attachment as Buffer;
      assert.deepEqual([...bytes.subarray(0, 8)], [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a], 'a PNG');
      assert.ok(bytes.length > 1000 && bytes.length < 100_000);
    });
  });

  describe("a pilot's picture", () => {
    it("replaces the stamp once the flight is taken, and is the pilot's own", () => {
      h.jobs.sync(h.panel.id, [sj('a', 'EGLL-EGKK')]);
      h.jobs.reserve(view().job.id, [1], USER_A);
      assert.equal(json('a', avatars(USER_A.discordId)).thumbnail?.url, avatar(USER_A.discordId).large);
    });

    it('is the first pilot\'s on a multi-leg flight that is all taken, and everyone is still named', () => {
      h.jobs.sync(h.panel.id, [sj('m', 'EGLL-EGKK-EGCC')]);
      h.jobs.reserve(view('m').job.id, [1], USER_B);
      h.jobs.reserve(view('m').job.id, [2], USER_A);
      const card = json('m', avatars(USER_A.discordId, USER_B.discordId));
      assert.equal(card.thumbnail?.url, avatar(USER_B.discordId).large);
      const pilots = card.fields!.find((f) => f.name === 'PILOTS')!.value;
      assert.match(pilots, new RegExp(`<@${USER_B.discordId}>`));
      assert.match(pilots, new RegExp(`<@${USER_A.discordId}>`));
    });

    it('still shows the pilot as a mention (which opens their profile) with their FsHub ID, as before', () => {
      h.jobs.sync(h.panel.id, [sj('a', 'EGLL-EGKK')]);
      h.store.setPilotId(USER_A.discordId, 1001, T0);
      h.jobs.reserve(view().job.id, [1], USER_A);
      const pilot = json('a', avatars(USER_A.discordId)).fields!.find((f) => f.name === 'PILOT')!.value;
      assert.match(pilot, new RegExp(`^<@${USER_A.discordId}> · FsHub #1001`));
    });

    it('is the picture Discord gives everyone when nothing is known of theirs', () => {
      h.jobs.sync(h.panel.id, [sj('a', 'EGLL-EGKK')]);
      h.jobs.reserve(view().job.id, [1], USER_A);
      assert.equal(json('a', avatars()).thumbnail?.url, defaultAvatar(USER_A.discordId).large);
      assert.match(defaultAvatar(USER_A.discordId).large, /^https:\/\/cdn\.discordapp\.com\/embed\/avatars\/[0-5]\.png$/);
      assert.match(defaultAvatar('not a number').large, /embed\/avatars\/0\.png$/, 'never throws');
    });

    it("is left out where pictures were not asked for, and for a flight only named in the airline's schedule (nobody to show)", () => {
      h.jobs.sync(h.panel.id, [sj('a', 'EGLL-EGKK'), sj('s', 'EGLL-EGCC', { legs: [{ dep: 'EGLL', arr: 'EGCC', heldBy: 'Some Name' }] })]);
      h.jobs.reserve(view().job.id, [1], USER_A);
      assert.equal(json('a').thumbnail, undefined, 'no pictures given');
      assert.equal(json('s', avatars(USER_A.discordId)).thumbnail, undefined, 'a name in a sheet has no Discord picture');
    });
  });

  describe('a backup pilot', () => {
    beforeEach(() => {
      h.jobs.sync(h.panel.id, [sj('a', 'EGLL-EGKK')]);
      h.store.setPilotId(USER_A.discordId, 1001, T0);
      h.store.setPilotId(USER_B.discordId, 1002, T0);
      h.jobs.reserve(view().job.id, [1], USER_A);
    });

    it("has a smaller picture of their own on a line above the card, linking to their profile", () => {
      h.jobs.addBackup(view().job.id, { discordId: USER_B.discordId, username: USER_B.username });
      const card = json('a', avatars(USER_A.discordId, USER_B.discordId));
      assert.deepEqual(card.author, { name: '🛟 Backup · bob', icon_url: avatar(USER_B.discordId).small, url: profileUrl(USER_B.discordId) });
      assert.equal(profileUrl(USER_B.discordId), `https://discord.com/users/${USER_B.discordId}`);
      assert.equal(card.thumbnail?.url, avatar(USER_A.discordId).large, 'the pilot keeps the big one');
    });

    it('is still named, with their FsHub ID, in a box of the card', () => {
      h.jobs.addBackup(view().job.id, { discordId: USER_B.discordId, username: USER_B.username });
      const box = json('a', avatars(USER_A.discordId, USER_B.discordId)).fields!.find((f) => f.name === 'BACKUP')!.value;
      assert.match(box, new RegExp(`^<@${USER_B.discordId}> · FsHub #1002`));
    });

    it('has no line when there is no backup, or no pictures were asked for', () => {
      assert.equal(json('a', avatars(USER_A.discordId)).author, undefined);
      h.jobs.addBackup(view().job.id, { discordId: USER_B.discordId, username: USER_B.username });
      assert.equal(json('a').author, undefined);
    });

    it('is written as plain text, so a name cannot ping anyone', () => {
      h.jobs.addBackup(view().job.id, { discordId: USER_B.discordId, username: '@everyone <@1>' });
      assert.doesNotMatch(json('a', avatars(USER_B.discordId)).author!.name, /@everyone|<@1>/);
    });
  });

  it('asks for the pictures of the pilots of flights that are taken, and of backups, and nobody else', () => {
    h.jobs.sync(h.panel.id, [sj('a', 'EGLL-EGKK'), sj('b', 'EGLL-EGCC'), sj('m', 'EGLL-EGKK-EGCC')]);
    h.jobs.reserve(view('a').job.id, [1], USER_A);
    h.jobs.addBackup(view('a').job.id, { discordId: USER_B.discordId, username: 'bob' });
    h.jobs.reserve(view('m').job.id, [1], USER_C); // one leg of two: still open, so no picture is needed
    assert.deepEqual(avatarIdsOf(h.jobs.open(h.panel.id)).sort(), [USER_A.discordId, USER_B.discordId].sort());
  });

  it("shows them in a search's results too", () => {
    h.jobs.sync(h.panel.id, [sj('a', 'EGLL-EGKK')]);
    h.jobs.reserve(view().job.id, [1], USER_A);
    const cards = searchEmbeds(h.panel, ['EGLL'], [], [view()], T0, null, [], avatars(USER_A.discordId));
    assert.equal(cards[1]!.toJSON().thumbnail?.url, avatar(USER_A.discordId).large);
  });
});

describe('the panel in the channel', () => {
  let h: Harness;
  let d: DiscordHarness;
  let alice: FakeUser;
  let bob: FakeUser;
  const pid = () => h.panel.id;
  const channel = () => d.client.channel(CHANNEL);
  const card = (i = 0) => (channel().live[0]!.payload.embeds as any[])[i + 1].toJSON();

  beforeEach(async () => {
    h = await makeHarness();
    d = makeDiscordHarness(h);
    alice = d.client.user(new FakeUser(USER_A.discordId, USER_A.username));
    bob = d.client.user(new FakeUser(USER_B.discordId, USER_B.username));
    h.jobs.sync(pid(), [sj('a', 'EGLL-EGKK')]);
    await d.panels.refresh(pid());
  });
  afterEach(async () => {
    await settle(40);
    await h.close();
  });

  it('wears the stamp while the flight is open, and swaps it for the pilot\'s picture, and a backup line, as it is taken', async () => {
    assert.equal(card().thumbnail.url, OPEN_STAMP_REF);
    assert.deepEqual(channel().live[0]!.payload.files.map((f: any) => f.name), ['open-stamp.png'], 'the picture is attached to the message that has the card');
    assert.equal(channel().live[1]!.payload.files.length, 0, 'and not to the completed flights');
    const messageId = channel().live[0]!.id;
    h.jobs.reserve(h.jobs.open(pid())[0]!.job.id, [1], USER_A);
    await settle();
    assert.equal(channel().live[0]!.id, messageId, 'edited in place');
    const taken = channel().live[0]!.edits.at(-1);
    assert.equal(taken.files, undefined, 'no stamp, so no picture');
    assert.deepEqual(taken.attachments, [], 'and the old one is taken off the message');
    assert.equal(card().thumbnail.url, alice.displayAvatarURL({ size: 128 }));
    assert.equal(card().author, undefined);
    h.jobs.addBackup(h.jobs.open(pid())[0]!.job.id, { discordId: USER_B.discordId, username: USER_B.username });
    await settle();
    assert.equal(card().author.icon_url, bob.displayAvatarURL({ size: 32 }));
    assert.equal(card().author.url, `https://discord.com/users/${USER_B.discordId}`);
    // and back to the stamp when the pilot lets it go
    h.jobs.release(h.jobs.open(pid())[0]!.job.id, USER_A.discordId, [1]);
    await settle();
    assert.equal(card().thumbnail.url, OPEN_STAMP_REF);
    assert.deepEqual(channel().live[0]!.edits.at(-1).files.map((f: any) => f.name), ['open-stamp.png'], 'the picture goes back on with the stamp');
  });

  it('is still drawn, just without the stamp, where the bot may not attach files (an older invite did not ask for it)', async () => {
    assert.ok((INVITE_PERMISSIONS & 0x8000) !== 0, 'new invites ask for Attach Files');
    channel().noAttachFiles = true;
    assert.equal(await d.panels.refresh(pid(), { force: true }), 'updated');
    assert.equal(card().thumbnail, undefined, 'no picture to name');
    assert.equal((channel().live[0]!.payload.files ?? []).length, 0, 'nothing attached');
    channel().noAttachFiles = false;
    await d.panels.refresh(pid(), { force: true });
    assert.equal(card().thumbnail.url, OPEN_STAMP_REF, 'and the stamp is back once it may');
    assert.equal(channel().live[0]!.payload.files.length, 1);
  });

  it('uses the default picture for someone Discord will not tell it about, and asks again later', async () => {
    h.jobs.reserve(h.jobs.open(pid())[0]!.job.id, [1], { discordId: '444444444444444444', username: 'dave' });
    await settle();
    assert.equal(card().thumbnail.url, defaultAvatar('444444444444444444').large);
  });

  it('asks Discord for a person once, not at every redraw, and again after some hours', async () => {
    let asked = 0;
    const fetch = d.client.users.fetch;
    d.client.users.fetch = async (id: string, o?: unknown) => {
      asked++;
      return (fetch as any)(id, o);
    };
    h.jobs.reserve(h.jobs.open(pid())[0]!.job.id, [1], USER_A);
    await settle();
    assert.equal(asked, 1);
    await d.panels.refresh(pid());
    await d.panels.refresh(pid());
    assert.equal(asked, 1, 'remembered');
    h.clock.advance(7 * 3_600_000);
    await d.panels.refresh(pid());
    assert.equal(asked, 2, 'asked again, in case they changed it');
  });
});
