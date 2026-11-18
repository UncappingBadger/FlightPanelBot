import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, it } from 'node:test';
import { TwitchApi, TwitchApiError } from '../src/twitch/helix.js';
import { CHAT_SCOPES, pollDeviceFlow, refreshTokens, revokeToken, startDeviceFlow, TwitchAuthError, validateToken } from '../src/twitch/oauth.js';
import { readTokens, removeTokens, TokenManager, writeTokens, type TwitchTokens } from '../src/twitch/tokens.js';
import { CLIENT, FakeTwitchHttp } from './twitch-fakes.js';

const SCOPES = [...CHAT_SCOPES];
let tw: FakeTwitchHttp;
let dir: string;
let file: string;
beforeEach(() => {
  tw = new FakeTwitchHttp();
  dir = mkdtempSync(join(tmpdir(), 'fpb-twitch-'));
  file = join(dir, 'twitch.json');
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

const tokens = (over: Partial<TwitchTokens> = {}): TwitchTokens => ({ clientId: CLIENT, accessToken: 'acc-1', refreshToken: 'ref-1', expiresAt: 10_000_000, userId: '555', login: 'kevinbot', scopes: SCOPES, ...over });

/* ------------------------------------------------------------------ the device sign-in */

describe('signing in to Twitch with a code (the device flow)', () => {
  it('asks Twitch for a code with the app\'s Client ID and the two chat scopes, and nothing else', async () => {
    const d = await startDeviceFlow(CLIENT, CHAT_SCOPES, tw.fetch);
    assert.deepEqual(d, { deviceCode: 'dev-code-1', userCode: 'ABCD-EFGH', verificationUri: 'https://www.twitch.tv/activate?public=true', expiresInSec: 1800, intervalSec: 5 });
    const sent = tw.seen[0]!;
    assert.equal(sent.url, 'https://id.twitch.tv/oauth2/device');
    assert.deepEqual(sent.body, { client_id: CLIENT, scopes: 'user:read:chat user:write:chat' });
    assert.equal(sent.headers['content-type'], 'application/x-www-form-urlencoded');
    assert.equal(sent.headers.authorization, undefined, 'no credential of any kind goes with it');
  });

  it('says what is wrong when Twitch will not give a code, and refuses a sign-in address that is not Twitch\'s', async () => {
    tw.deviceStatus = 400;
    await assert.rejects(startDeviceFlow(CLIENT, SCOPES, tw.fetch), (e: unknown) => e instanceof TwitchAuthError && e.kind === 'invalid' && /Client ID/.test(e.message));
    tw.deviceStatus = 503;
    await assert.rejects(startDeviceFlow(CLIENT, SCOPES, tw.fetch), (e: unknown) => e instanceof TwitchAuthError && e.kind === 'unavailable');
    tw.deviceStatus = 200;
    tw.deviceVerificationUri = 'https://evil.example/activate';
    await assert.rejects(startDeviceFlow(CLIENT, SCOPES, tw.fetch), (e: unknown) => e instanceof TwitchAuthError && e.kind === 'bad-response');
    tw.deviceVerificationUri = 'https://www.twitch.tv.evil.example/activate';
    await assert.rejects(startDeviceFlow(CLIENT, SCOPES, tw.fetch), (e: unknown) => e instanceof TwitchAuthError && e.kind === 'bad-response');
    tw.down = true;
    await assert.rejects(startDeviceFlow(CLIENT, SCOPES, tw.fetch), (e: unknown) => e instanceof TwitchAuthError && e.kind === 'unavailable');
  });

  it('is "not yet" until the person approves, then hands over the tokens', async () => {
    assert.equal(await pollDeviceFlow(CLIENT, SCOPES, 'dev-code-1', tw.fetch), null);
    assert.deepEqual(tw.seen[0]!.body, { client_id: CLIENT, scopes: 'user:read:chat user:write:chat', device_code: 'dev-code-1', grant_type: 'urn:ietf:params:oauth:grant-type:device_code' });
    tw.approved = { access: 'acc-1', refresh: 'ref-1', scope: SCOPES };
    assert.deepEqual(await pollDeviceFlow(CLIENT, SCOPES, 'dev-code-1', tw.fetch), { accessToken: 'acc-1', refreshToken: 'ref-1', expiresInSec: 14400, scopes: SCOPES });
  });

  it('tells a refusal, a code that ran out and a Twitch outage apart', async () => {
    tw.tokenError = { status: 400, message: 'access_denied' };
    await assert.rejects(pollDeviceFlow(CLIENT, SCOPES, 'd', tw.fetch), (e: unknown) => e instanceof TwitchAuthError && e.kind === 'denied');
    tw.tokenError = { status: 400, message: 'invalid device code' };
    await assert.rejects(pollDeviceFlow(CLIENT, SCOPES, 'd', tw.fetch), (e: unknown) => e instanceof TwitchAuthError && e.kind === 'expired');
    tw.tokenError = { status: 400, message: 'slow_down' };
    assert.equal(await pollDeviceFlow(CLIENT, SCOPES, 'd', tw.fetch), null, 'asked too fast is just "not yet"');
    tw.tokenError = { status: 502, message: 'bad gateway' };
    await assert.rejects(pollDeviceFlow(CLIENT, SCOPES, 'd', tw.fetch), (e: unknown) => e instanceof TwitchAuthError && e.kind === 'unavailable');
    tw.tokenError = { status: 400, message: 'something else' };
    await assert.rejects(pollDeviceFlow(CLIENT, SCOPES, 'd', tw.fetch), (e: unknown) => e instanceof TwitchAuthError && e.kind === 'invalid');
  });
});

describe('keeping the sign-in alive', () => {
  it('exchanges a refresh token for the next pair, and says when Twitch no longer accepts it', async () => {
    tw.refresh.set('ref-1', { access: 'acc-2', refresh: 'ref-2' });
    const set = await refreshTokens(CLIENT, 'ref-1', tw.fetch);
    assert.deepEqual({ a: set.accessToken, r: set.refreshToken }, { a: 'acc-2', r: 'ref-2' });
    assert.deepEqual(tw.seen[0]!.body, { client_id: CLIENT, grant_type: 'refresh_token', refresh_token: 'ref-1' });
    await assert.rejects(refreshTokens(CLIENT, 'ref-1', tw.fetch), (e: unknown) => e instanceof TwitchAuthError && e.kind === 'invalid', 'a refresh token works once');
    tw.tokenError = { status: 500, message: 'oops' };
    await assert.rejects(refreshTokens(CLIENT, 'x', tw.fetch), (e: unknown) => e instanceof TwitchAuthError && e.kind === 'unavailable');
    tw.tokenError = { status: 429, message: 'slow' };
    await assert.rejects(refreshTokens(CLIENT, 'x', tw.fetch), (e: unknown) => e instanceof TwitchAuthError && e.kind === 'unavailable');
  });

  it('checks a token with Twitch: whose it is and what it may do, or null when it is not accepted', async () => {
    tw.valid.set('acc-1', { login: 'KevinBot', userId: '555', scopes: SCOPES, expiresIn: 3000 });
    assert.deepEqual(await validateToken('acc-1', tw.fetch), { clientId: CLIENT, login: 'kevinbot', userId: '555', scopes: SCOPES, expiresInSec: 3000 });
    assert.equal(tw.seen[0]!.headers.authorization, 'OAuth acc-1');
    assert.equal(await validateToken('nope', tw.fetch), null);
    tw.down = true;
    await assert.rejects(validateToken('acc-1', tw.fetch), (e: unknown) => e instanceof TwitchAuthError && e.kind === 'unavailable');
  });

  it('takes the access back when asked, and never fails if Twitch cannot be reached', async () => {
    await revokeToken(CLIENT, 'acc-1', tw.fetch);
    assert.deepEqual(tw.revoked, ['acc-1']);
    tw.down = true;
    await revokeToken(CLIENT, 'acc-1', tw.fetch);
  });
});

/* ------------------------------------------------------------------ the saved sign-in */

describe('the saved Twitch sign-in', () => {
  it('is kept in a file of its own, read back whole, and refused if it is damaged or incomplete', () => {
    writeTokens(file, tokens());
    assert.deepEqual(readTokens(file), tokens());
    if (process.platform !== 'win32') assert.equal(statSync(file).mode & 0o777, 0o600, 'readable by its owner only');
    writeFileSync(file, '{"clientId":"x"}');
    assert.equal(readTokens(file), null);
    writeFileSync(file, 'not json');
    assert.equal(readTokens(file), null);
    writeFileSync(file, `﻿${JSON.stringify(tokens())}`);
    assert.deepEqual(readTokens(file), tokens(), 'a file saved with a byte-order mark still reads');
    removeTokens(file);
    assert.equal(existsSync(file), false);
    assert.equal(readTokens(file), null);
    removeTokens(file);
  });

  describe('the token manager', () => {
    let now: number;
    let lost: string[];
    let tm: TokenManager;
    const make = (t: TwitchTokens) => {
      writeTokens(file, t);
      tm = new TokenManager({ file, fetchFn: tw.fetch, now: () => now, onLost: (why) => lost.push(why) }, t);
    };
    beforeEach(() => {
      now = 1_000_000;
      lost = [];
    });

    it('uses the access token while it has time left, and never contacts Twitch for that', async () => {
      make(tokens({ expiresAt: now + 3_600_000 }));
      assert.equal(await tm.accessToken(), 'acc-1');
      assert.equal(tw.seen.length, 0);
    });

    it('refreshes before it runs out, and saves the new refresh token before anything uses the new access token', async () => {
      make(tokens({ expiresAt: now + 60_000 }));
      tw.refresh.set('ref-1', { access: 'acc-2', refresh: 'ref-2' });
      assert.equal(await tm.accessToken(), 'acc-2');
      const saved = readTokens(file)!;
      assert.deepEqual({ a: saved.accessToken, r: saved.refreshToken }, { a: 'acc-2', r: 'ref-2' });
      assert.equal(saved.expiresAt, now + 14_400_000);
      assert.equal(saved.login, 'kevinbot', 'who it is stays');
    });

    it('never has two refreshes going at once, because a refresh token works only once', async () => {
      make(tokens({ expiresAt: now }));
      tw.refresh.set('ref-1', { access: 'acc-2', refresh: 'ref-2' });
      const got = await Promise.all([tm.accessToken(), tm.accessToken(), tm.refreshNow()]);
      assert.deepEqual(got, ['acc-2', 'acc-2', 'acc-2']);
      assert.equal(tw.seen.filter((s) => s.url.endsWith('/oauth2/token')).length, 1);
    });

    it('is lost, once, when Twitch no longer accepts the refresh token, and then says so to everyone who asks', async () => {
      make(tokens({ expiresAt: now }));
      await assert.rejects(tm.accessToken(), (e: unknown) => e instanceof TwitchAuthError && e.kind === 'invalid');
      assert.equal(lost.length, 1);
      assert.equal(tm.hasLost, true);
      await assert.rejects(tm.accessToken(), TwitchAuthError);
      await assert.rejects(tm.refreshNow(), TwitchAuthError);
      assert.equal(lost.length, 1, 'said once');
    });

    it('does not lose the sign-in because Twitch could not be reached', async () => {
      make(tokens({ expiresAt: now }));
      tw.down = true;
      await assert.rejects(tm.accessToken(), (e: unknown) => e instanceof TwitchAuthError && e.kind === 'unavailable');
      assert.equal(lost.length, 0);
      tw.down = false;
      tw.refresh.set('ref-1', { access: 'acc-2', refresh: 'ref-2' });
      assert.equal(await tm.accessToken(), 'acc-2');
    });

    it('checks the token with Twitch and, if only the access token went stale, tries the refresh token before giving up', async () => {
      make(tokens({ expiresAt: now + 3_600_000 }));
      tw.valid.set('acc-1', { login: 'kevinbot', userId: '555', scopes: SCOPES, expiresIn: 3000 });
      assert.equal((await tm.validate())?.login, 'kevinbot');
      tw.valid.delete('acc-1');
      tw.refresh.set('ref-1', { access: 'acc-2', refresh: 'ref-2' });
      assert.equal((await tm.validate())?.login, 'kevinbot', 'the refreshed token is accepted');
      tw.valid.clear();
      tw.refresh.clear();
      await assert.rejects(tm.validate(), (e: unknown) => e instanceof TwitchAuthError && e.kind === 'invalid');
      assert.equal(lost.length, 1);
      await assert.rejects(tm.accessToken(), (e: unknown) => e instanceof TwitchAuthError && e.kind === 'invalid', 'a token known to be dead is not handed out, however much time it seemed to have');
    });
  });
});

/* ------------------------------------------------------------------ the API */

describe('the Twitch API calls', () => {
  let tm: TokenManager;
  let api: TwitchApi;
  beforeEach(() => {
    writeTokens(file, tokens({ expiresAt: Date.now() + 3_600_000 }));
    tw.valid.set('acc-1', { login: 'kevinbot', userId: '555', scopes: SCOPES, expiresIn: 3000 });
    tm = new TokenManager({ file, fetchFn: tw.fetch }, tokens({ expiresAt: Date.now() + 3_600_000 }));
    api = new TwitchApi({ tokens: tm, fetchFn: tw.fetch });
  });

  it('finds a channel by its name, and does not ask about something that cannot be a name', async () => {
    tw.users.testair = { id: '100', login: 'testair', display_name: 'TestAir' };
    assert.deepEqual(await api.userByLogin('#TestAir'), { id: '100', login: 'testair', displayName: 'TestAir' });
    assert.equal(await api.userByLogin('nobody_here'), null);
    const before = tw.seen.length;
    assert.equal(await api.userByLogin('a b; drop'), null);
    assert.equal(tw.seen.length, before, 'nothing was sent');
    const first = tw.seen[0]!;
    assert.equal(first.headers.authorization, 'Bearer acc-1');
    assert.equal(first.headers['client-id'], CLIENT);
  });

  it('sends a chat message as a reply, cut to what Twitch allows, and says what came of it', async () => {
    const r = await api.sendMessage('100', '555', 'x'.repeat(600), 'chat-9');
    assert.deepEqual(r, { sent: true, messageId: 'm1', dropCode: null });
    assert.deepEqual({ ...tw.chat[0]!, message: tw.chat[0]!.message.length }, { broadcaster_id: '100', sender_id: '555', message: 500, reply_parent_message_id: 'chat-9' });
    tw.sendResult = { sent: false, code: 'slow_mode' };
    assert.deepEqual(await api.sendMessage('100', '555', 'hi'), { sent: false, messageId: null, dropCode: 'slow_mode' });
    assert.equal('reply_parent_message_id' in tw.seen.at(-1)!.body!, false, 'a plain message has no reply field');
  });

  it('subscribes to a channel\'s chat over the WebSocket session', async () => {
    await api.subscribeChat('sess-1', '100', '555');
    assert.deepEqual(tw.subscriptions[0], { type: 'channel.chat.message', version: '1', condition: { broadcaster_user_id: '100', user_id: '555' }, transport: { method: 'websocket', session_id: 'sess-1' } });
  });

  it('answers a 401 with one refresh and one retry, and then gives up', async () => {
    tw.valid.delete('acc-1');
    tw.refresh.set('ref-1', { access: 'acc-2', refresh: 'ref-2' });
    tw.users.testair = { id: '100', login: 'testair', display_name: 'TestAir' };
    assert.equal((await api.userByLogin('testair'))?.id, '100');
    const bearers = tw.seen.filter((s) => s.url.includes('/helix/')).map((s) => s.headers.authorization);
    assert.deepEqual(bearers, ['Bearer acc-1', 'Bearer acc-2']);
    tw.valid.delete('acc-2');
    tw.refresh.set('ref-2', { access: 'acc-3', refresh: 'ref-3' });
    tw.rejectRefreshed = true;
    await assert.rejects(api.userByLogin('testair'), (e: unknown) => e instanceof TwitchApiError && e.kind === 'unauthorized');
  });

  it('names what went wrong: not allowed, slow down, trouble at Twitch, a bad request', async () => {
    tw.sendStatus = 403;
    await assert.rejects(api.sendMessage('100', '555', 'hi'), (e: unknown) => e instanceof TwitchApiError && e.kind === 'forbidden');
    tw.sendStatus = 429;
    await assert.rejects(api.sendMessage('100', '555', 'hi'), (e: unknown) => e instanceof TwitchApiError && e.kind === 'rate-limited' && (e.retryAfterMs ?? 0) >= 15_000 && (e.retryAfterMs ?? 0) <= 21_000, 'how long Twitch said to wait, from its own header');
    tw.sendStatus = 500;
    await assert.rejects(api.sendMessage('100', '555', 'hi'), (e: unknown) => e instanceof TwitchApiError && e.kind === 'unavailable');
    tw.sendStatus = 422;
    await assert.rejects(api.sendMessage('100', '555', 'hi'), (e: unknown) => e instanceof TwitchApiError && e.kind === 'bad-request');
    tw.down = true;
    await assert.rejects(api.sendMessage('100', '555', 'hi'), (e: unknown) => e instanceof TwitchApiError && e.kind === 'unavailable');
  });
});
