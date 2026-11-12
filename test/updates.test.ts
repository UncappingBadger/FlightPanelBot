import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, it } from 'node:test';
import { isNewer, parseVersion, UPDATE_REPO, UpdateChecker, type UpdateStatus } from '../src/host/updates.js';

const REPO = 'someone/flight-panel-bot';
const release = (tag: string, url = `https://github.com/${REPO}/releases/tag/${tag}`) => ({ tag_name: tag, html_url: url, name: 'x', body: 'notes' });

let dir: string;
let statePath: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'fpb-upd-'));
  statePath = join(dir, 'update-state.json');
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

/** A GitHub that answers with whatever the test says, and remembers what it was asked. */
function fakeGitHub(reply: () => { status?: number; body?: unknown; raw?: string } | Error) {
  const requests: Array<{ url: string; headers: Record<string, string>; hasSignal: boolean }> = [];
  const fetchFn = (async (url: string | URL | Request, init?: RequestInit) => {
    requests.push({ url: String(url), headers: (init?.headers ?? {}) as Record<string, string>, hasSignal: init?.signal !== undefined });
    const r = reply();
    if (r instanceof Error) throw r;
    return new Response(r.raw ?? JSON.stringify(r.body ?? {}), { status: r.status ?? 200 });
  }) as unknown as typeof fetch;
  return { fetchFn, requests };
}

const make = (gh: ReturnType<typeof fakeGitHub>, o: Partial<ConstructorParameters<typeof UpdateChecker>[0]> = {}) =>
  new UpdateChecker({ version: '1.0.0', statePath, autoEnabled: () => true, repo: REPO, fetchFn: gh.fetchFn, ...o });

describe('version numbers', () => {
  it('reads v-prefixed, two-part and suffixed tags', () => {
    assert.deepEqual(parseVersion('v1.2.3'), [1, 2, 3]);
    assert.deepEqual(parseVersion('V0.10.0'), [0, 10, 0]);
    assert.deepEqual(parseVersion('1.2'), [1, 2, 0]);
    assert.deepEqual(parseVersion('1.2.3-beta.1'), [1, 2, 3]);
    assert.deepEqual(parseVersion('  v2.0.0 '), [2, 0, 0]);
  });

  it('refuses anything that is not a version, including a development build', () => {
    for (const bad of ['', 'dev', 'latest', 'v', 'one.two', '1', 'release-2026', '..1.2']) assert.equal(parseVersion(bad), null, bad);
  });

  it('compares number by number, so 0.10.0 is newer than 0.9.0 and nothing is newer than itself', () => {
    assert.equal(isNewer([0, 10, 0], [0, 9, 0]), true);
    assert.equal(isNewer([1, 0, 0], [0, 99, 99]), true);
    assert.equal(isNewer([1, 2, 4], [1, 2, 3]), true);
    assert.equal(isNewer([1, 2, 3], [1, 2, 3]), false);
    assert.equal(isNewer([1, 2, 2], [1, 2, 3]), false);
    assert.equal(isNewer([0, 9, 9], [1, 0, 0]), false);
  });
});

describe('looking for a newer release', () => {
  it('reads only GitHub\'s public "latest release" for this project, naming the app but nothing about the user', async () => {
    const gh = fakeGitHub(() => ({ body: release('v1.1.0') }));
    await make(gh, { version: '1.0.0' }).check();
    assert.equal(gh.requests.length, 1);
    assert.equal(gh.requests[0]!.url, `https://api.github.com/repos/${REPO}/releases/latest`);
    assert.equal(gh.requests[0]!.headers['user-agent'], 'FlightPanelBot/1.0.0');
    assert.deepEqual(Object.keys(gh.requests[0]!.headers).sort(), ['accept', 'user-agent', 'x-github-api-version']);
    assert.equal(gh.requests[0]!.hasSignal, true, 'it will not wait forever');
  });

  it('defaults to this project\'s own repository', () => {
    assert.match(UPDATE_REPO, /^[\w-]+\/[\w.-]+$/);
  });

  it('reports a newer release with the tag and its page', async () => {
    const s = await make(fakeGitHub(() => ({ body: release('v1.1.0') }))).check();
    assert.deepEqual(
      [s.supported, s.ok, s.available, s.latest, s.url, s.current],
      [true, true, true, 'v1.1.0', `https://github.com/${REPO}/releases/tag/v1.1.0`, '1.0.0'],
    );
  });

  it('says nothing is available when this is the latest, or newer than the latest', async () => {
    for (const tag of ['v1.0.0', '1.0.0', 'v0.9.0']) {
      const s = await make(fakeGitHub(() => ({ body: release(tag) }))).check();
      assert.deepEqual([s.ok, s.available, s.url], [true, false, null], tag);
    }
  });

  it('is not an error when no release has been published yet (GitHub answers 404)', async () => {
    const s = await make(fakeGitHub(() => ({ status: 404, body: { message: 'Not Found' } }))).check();
    assert.deepEqual([s.ok, s.available, s.latest], [true, false, null]);
  });

  it('records a check that could not complete, and carries on: no network, rate limit, server trouble, rubbish', async () => {
    const cases: Array<() => { status?: number; body?: unknown; raw?: string } | Error> = [
      () => new TypeError('fetch failed'),
      () => ({ status: 403, body: { message: 'API rate limit exceeded' } }),
      () => ({ status: 429 }),
      () => ({ status: 500 }),
      () => ({ raw: 'not json at all' }),
      () => ({ body: {} }),
      () => ({ body: { tag_name: 5 } }),
      () => ({ raw: 'x'.repeat(2_100_000) }),
    ];
    for (const reply of cases) {
      const s = await make(fakeGitHub(reply)).check();
      assert.deepEqual([s.ok, s.available, s.latest, s.url], [false, false, null, null]);
    }
  });

  it('a failed check does not forget an update it already knew about', async () => {
    let fail = false;
    const gh = fakeGitHub(() => (fail ? new TypeError('offline') : { body: release('v1.1.0') }));
    const checker = make(gh);
    await checker.check();
    fail = true;
    const s = await checker.check();
    assert.deepEqual([s.ok, s.available, s.latest], [false, true, 'v1.1.0']);
  });

  it('refuses a tag that is not plainly a version, so odd text is never shown or opened', async () => {
    for (const tag of ['v1.1.0 <script>alert(1)</script>', 'v1.1.0\nINJECT', 'javascript:alert(1)', 'v1.1.0' + 'x'.repeat(50), 'nightly']) {
      const s = await make(fakeGitHub(() => ({ body: release(tag) }))).check();
      assert.deepEqual([s.ok, s.available, s.latest], [false, false, null], tag);
    }
  });

  it('only ever offers a link inside this project\'s own repository, whatever GitHub\'s answer says', async () => {
    const fallback = `https://github.com/${REPO}/releases/latest`;
    for (const url of [
      'https://evil.example/download.exe',
      'http://github.com/' + REPO + '/releases/tag/v1.1.0',
      'https://github.com.evil.example/' + REPO + '/releases',
      'https://github.com/someone/other-repo/releases/tag/v1.1.0',
      'file:///C:/Windows/System32/calc.exe',
      'https://github.com/' + REPO + '/' + 'x'.repeat(400),
    ]) {
      const s = await make(fakeGitHub(() => ({ body: release('v1.1.0', url) }))).check();
      assert.equal(s.url, fallback, url.slice(0, 60));
    }
    const noUrl = await make(fakeGitHub(() => ({ body: { tag_name: 'v1.1.0' } }))).check();
    assert.equal(noUrl.url, fallback);
  });

  it('does not look at all in a development run, which has no version to compare', async () => {
    const gh = fakeGitHub(() => ({ body: release('v9.0.0') }));
    const checker = make(gh, { version: 'dev' });
    const s = await checker.check();
    checker.start();
    checker.stop();
    assert.deepEqual([s.supported, s.available, s.ok], [false, false, null]);
    assert.equal(gh.requests.length, 0);
  });

  it('overlapping checks share one request', async () => {
    const gh = fakeGitHub(() => ({ body: release('v1.1.0') }));
    const checker = make(gh);
    const [a, b, c] = await Promise.all([checker.check(), checker.check(), checker.check()]);
    assert.equal(gh.requests.length, 1);
    assert.deepEqual([a.available, b.available, c.available], [true, true, true]);
    await checker.check();
    assert.equal(gh.requests.length, 2, 'a later check asks again');
  });

  it('tells its listener after every check, and survives a listener that throws', async () => {
    const seen: UpdateStatus[] = [];
    const checker = make(fakeGitHub(() => ({ body: release('v1.1.0') })), { onChange: (s) => seen.push(s) });
    await checker.check();
    assert.equal(seen.length, 1);
    assert.equal(seen[0]!.available, true);
    const throwing = make(fakeGitHub(() => ({ body: release('v1.1.0') })), {
      onChange: () => {
        throw new Error('listener bug');
      },
    });
    assert.equal((await throwing.check()).available, true);
  });

  it('records when it last looked', async () => {
    const checker = make(fakeGitHub(() => ({ body: release('v1.0.0') })), { now: () => 12345 });
    assert.equal(checker.status().checkedAt, null);
    assert.equal((await checker.check()).checkedAt, 12345);
  });
});

describe('telling the host once per release', () => {
  const found = () => make(fakeGitHub(() => ({ body: release('v1.1.0') })));

  it('announces a release the first time it is found, and says so in the state file for the tray', async () => {
    const s = await found().check();
    assert.deepEqual([s.available, s.announce], [true, true]);
    assert.deepEqual(JSON.parse(readFileSync(statePath, 'utf8')), { announced: 'v1.1.0' });
  });

  it('keeps announcing for the rest of that run, so the tray cannot miss it', async () => {
    const checker = found();
    await checker.check();
    assert.equal((await checker.check()).announce, true);
    assert.equal(checker.status().announce, true);
  });

  it('does not pop up again on a later run for the same release, though the update stays available', async () => {
    await found().check();
    const later = await found().check();
    assert.deepEqual([later.available, later.announce], [true, false]);
  });

  it('announces again for a newer release', async () => {
    await found().check();
    const newer = await make(fakeGitHub(() => ({ body: release('v1.2.0') }))).check();
    assert.deepEqual([newer.latest, newer.announce], ['v1.2.0', true]);
    assert.deepEqual(JSON.parse(readFileSync(statePath, 'utf8')), { announced: 'v1.2.0' });
  });

  it('announces nothing when there is no update, and writes no file', async () => {
    const s = await make(fakeGitHub(() => ({ body: release('v1.0.0') }))).check();
    assert.equal(s.announce, false);
    assert.equal(existsSync(statePath), false);
  });

  it('copes with a damaged state file, and an unwritable place to keep it', async () => {
    writeFileSync(statePath, '{ broken');
    assert.equal((await found().check()).announce, true);
    const blocked = make(fakeGitHub(() => ({ body: release('v1.1.0') })), { statePath: join(statePath, 'nested', 'x.json') });
    writeFileSync(statePath, 'a file where a folder is needed');
    assert.equal((await blocked.check()).announce, true, 'still tells them, even if it cannot remember that it did');
  });
});

describe('the daily check', () => {
  const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));

  it('runs by itself after start-up and then on its interval, and stops when told', async () => {
    const gh = fakeGitHub(() => ({ body: release('v1.0.0') }));
    const checker = make(gh, { firstCheckDelayMs: 5, intervalMs: 30 });
    checker.start();
    checker.start(); // starting twice does not double it up
    await wait(18);
    assert.equal(gh.requests.length, 1, 'the first one');
    await wait(60);
    const afterInterval = gh.requests.length;
    assert.ok(afterInterval >= 2 && afterInterval <= 4, `repeated on its interval (${afterInterval})`);
    checker.stop();
    await wait(60);
    assert.equal(gh.requests.length, afterInterval, 'and nothing after stop');
  });

  it('does not look while the host has it switched off, and starts again the moment they switch it on', async () => {
    let on = false;
    const gh = fakeGitHub(() => ({ body: release('v1.0.0') }));
    const checker = make(gh, { firstCheckDelayMs: 5, intervalMs: 20, autoEnabled: () => on });
    checker.start();
    await wait(50);
    assert.equal(gh.requests.length, 0);
    assert.equal(checker.status().auto, false);
    on = true;
    await wait(50);
    assert.ok(gh.requests.length >= 1);
    checker.stop();
  });

  it('never keeps the app alive on its own', () => {
    const checker = make(fakeGitHub(() => ({ body: release('v1.0.0') })));
    checker.start();
    checker.stop();
    // If a timer were left running the test process would not exit; reaching here without hanging is the check.
    assert.ok(true);
  });
});
