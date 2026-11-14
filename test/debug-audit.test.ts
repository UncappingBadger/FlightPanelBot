import assert from 'node:assert/strict';
import { afterEach, beforeEach, describe, it } from 'node:test';
import { createLogger } from '../src/util/log.js';
import { DEBUG_BUILD } from '../src/util/debugBuild.js';
import { makeHarness, sj, USER_A, USER_B, type Harness } from './helpers.js';

/** The debug build's reservation audit: it must see every change to a reservation, whichever code path made it. */
describe('debug build: reservation audit', () => {
  let h: Harness;
  let lines: string[];
  const pid = () => h.panel.id;

  beforeEach(async () => {
    h = await makeHarness();
    lines = [];
    h.store.enableAudit(createLogger('debug', (l) => void lines.push(l)));
  });
  afterEach(async () => {
    await h.close();
  });

  const reservationLines = () => lines.filter((l) => l.includes('RESERVATION'));

  it('is off in a normal build and test run', () => {
    assert.equal(DEBUG_BUILD, false);
  });

  it('logs a reservation being made and then given back, with who did it', () => {
    h.jobs.sync(pid(), [sj('a', 'EGLL-EGKK')]);
    const job = h.jobs.open(pid())[0]!.job;
    h.jobs.reserve(job.id, [1], USER_A);
    h.jobs.release(job.id, USER_A.discordId);
    const r = reservationLines();
    assert.equal(r.length, 2, r.join('\n'));
    assert.match(r[0]!, /RESERVATION INSERT: TST-001 leg 1 alice \(111111111111111111\)/);
    assert.match(r[0]!, /JobService\.reserve/);
    assert.match(r[1]!, /RESERVATION DELETE: TST-001 leg 1 alice/);
    assert.match(r[1]!, /JobService\.release/);
  });

  it('logs a reservation that goes because the flight left the sheet', () => {
    h.jobs.sync(pid(), [sj('a', 'EGLL-EGKK')]);
    h.jobs.reserve(h.jobs.open(pid())[0]!.job.id, [1], USER_B);
    lines.length = 0;
    h.jobs.sync(pid(), []);
    const r = reservationLines();
    assert.equal(r.length, 1, r.join('\n'));
    assert.match(r[0]!, /RESERVATION DELETE: TST-001 leg 1 bob \(222222222222222222\)/);
    assert.match(r[0]!, /JobService\.sync/, 'the call path names the sync that did it');
  });

  it('logs a reservation that goes by cascade when a leg is deleted because its route changed', () => {
    h.jobs.sync(pid(), [sj('a', 'EGLL-EGKK')]);
    h.jobs.reserve(h.jobs.open(pid())[0]!.job.id, [1], USER_A);
    lines.length = 0;
    h.jobs.sync(pid(), [sj('a', 'EGLL-EGPH')]); // same flight key, different arrival
    const r = reservationLines();
    assert.equal(r.length, 1, r.join('\n'));
    assert.match(r[0]!, /RESERVATION DELETE: TST-001 leg 1 alice/);
  });

  it('does not log a name changing in the sheet, because that touches no reservation', () => {
    h.jobs.sync(pid(), [sj('a', 'EGLL-EGKK')]);
    h.jobs.reserve(h.jobs.open(pid())[0]!.job.id, [1], USER_A);
    // The bot writes the pilot's name into the sheet, so the next read shows it there; then a manager clears it.
    h.jobs.sync(pid(), [sj('a', 'EGLL-EGKK', { legs: [{ dep: 'EGLL', arr: 'EGKK', heldBy: 'alice' }] })]);
    assert.equal(h.jobs.open(pid())[0]!.legs[0]!.sheetHolder, 'alice');
    lines.length = 0;
    h.jobs.sync(pid(), [sj('a', 'EGLL-EGKK')]); // the name was cleared in the sheet
    assert.deepEqual(reservationLines(), []);
    assert.equal(h.jobs.open(pid())[0]!.legs[0]!.holder?.discordId, USER_A.discordId, 'the Discord reservation is untouched');
  });

  it('says when a transaction was rolled back, so the lines above it are not believed', () => {
    assert.throws(() =>
      h.store.tx(() => {
        throw new Error('boom');
      }),
    );
    assert.ok(lines.some((l) => /ROLLBACK/.test(l) && /boom/.test(l)));
  });
});
