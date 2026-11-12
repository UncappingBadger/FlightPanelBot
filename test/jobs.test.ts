import assert from 'node:assert/strict';
import { afterEach, beforeEach, describe, it } from 'node:test';
import { defaultPrefix, JobError, normalizeCode } from '../src/services/jobs.js';
import { mergeNotices } from '../src/services/events.js';
import { HOUR, makeHarness, sj, T0, USER_A, USER_B, type Harness } from './helpers.js';

describe('normalizeCode', () => {
  it('accepts the code, the number, and sloppy variants', () => {
    for (const input of ['TST-007', 'tst-007', 'TST007', 'tst 7', ' TST-7 ', '7', '007', '0007']) {
      assert.equal(normalizeCode('TST', input), 'TST-007', input);
    }
    assert.equal(normalizeCode('TST', '123'), 'TST-123');
  });

  it("rejects another airline's prefix, junk and over-long numbers", () => {
    for (const input of ['DMO-007', 'TST-', '-7', 'seven', '', '   ', 'TST-1234567', 'TST-7x']) {
      assert.equal(normalizeCode('TST', input), null, input);
    }
  });

  it('works when the prefix contains digits or regex characters', () => {
    assert.equal(normalizeCode('A3', 'a3-12'), 'A3-012');
    assert.equal(normalizeCode('A3', 'A3'), null);
  });
});

describe('defaultPrefix', () => {
  it('prefers the airline abbreviation, then initials', () => {
    assert.equal(defaultPrefix({ name: 'British Airways', abbr: 'BAW' }), 'BAW');
    assert.equal(defaultPrefix({ name: 'British Airways', abbr: '27' }), '27');
    assert.equal(defaultPrefix({ name: 'Delta Virtual Airlines', abbr: null }), 'DVA');
    assert.equal(defaultPrefix({ name: 'Solo', abbr: null }), 'SOLO');
    assert.equal(defaultPrefix({ name: '###', abbr: '' }), 'JOB');
  });
});

describe('JobService', () => {
  let h: Harness;
  beforeEach(async () => {
    h = await makeHarness();
  });
  afterEach(() => h.close());

  const pid = () => h.panel.id;
  const codes = () => h.jobs.open(pid()).map((v) => v.job.code);

  describe('sync', () => {
    it('adds jobs with sequential codes and their legs', () => {
      const r = h.jobs.sync(pid(), [sj('a', 'EGLL-EGKK'), sj('b', 'EGLL-EGCC-EGPH', { aircraft: 'B738' })]);
      assert.deepEqual([r.added, r.updated, r.removed], [2, 0, 0]);
      const views = h.jobs.open(pid());
      assert.deepEqual(views.map((v) => v.job.code), ['TST-001', 'TST-002']);
      assert.deepEqual(views[1]!.legs.map((l) => `${l.legNo}:${l.dep}>${l.arr}`), ['1:EGLL>EGCC', '2:EGCC>EGPH']);
      assert.equal(views[1]!.job.aircraft, 'B738');
    });

    it('keeps a job\'s code and reservations when the same key comes back', () => {
      h.jobs.sync(pid(), [sj('a', 'EGLL-EGKK')]);
      const job = h.jobs.open(pid())[0]!.job;
      h.jobs.reserve(job.id, [1], USER_A);
      const r = h.jobs.sync(pid(), [sj('a', 'EGLL-EGKK')]);
      assert.deepEqual([r.added, r.updated, r.removed], [0, 0, 0]);
      const again = h.jobs.open(pid())[0]!;
      assert.equal(again.job.code, 'TST-001');
      assert.equal(again.legs[0]!.holder?.discordId, USER_A.discordId);
    });

    it('does not reuse the codes of closed jobs', () => {
      h.jobs.sync(pid(), [sj('a', 'EGLL-EGKK')]);
      h.jobs.sync(pid(), []); // a closes
      h.jobs.sync(pid(), [sj('b', 'EGLL-EGCC')]);
      assert.deepEqual(codes(), ['TST-002']);
    });

    it('updates changed details in place and counts them', () => {
      h.jobs.sync(pid(), [sj('a', 'EGLL-EGKK', { aircraft: 'A320', deadline: T0 + 24 * HOUR })]);
      const r = h.jobs.sync(pid(), [sj('a', 'EGLL-EGKK', { aircraft: 'B738', deadline: T0 + 30 * HOUR, pay: '9,000', notes: 'now with pay' })]);
      assert.equal(r.updated, 1);
      const j = h.jobs.open(pid())[0]!.job;
      assert.deepEqual([j.aircraft, j.deadline, j.pay, j.notes], ['B738', T0 + 30 * HOUR, '9,000', 'now with pay']);
    });

    it('closes jobs the source no longer lists and reports who lost a reservation', () => {
      h.jobs.sync(pid(), [sj('a', 'EGLL-EGKK-EGCC'), sj('b', 'EGLL-EGKK')]);
      const a = h.jobs.open(pid())[0]!.job;
      h.jobs.reserve(a.id, [1, 2], USER_A);
      h.emitted.length = 0;

      const r = h.jobs.sync(pid(), [sj('b', 'EGLL-EGKK')]);
      assert.equal(r.removed, 1);
      assert.deepEqual(r.released, [{ panelId: pid(), discordId: USER_A.discordId, jobCode: 'TST-001', legNos: [1, 2], reason: 'removed' }]);
      assert.deepEqual(codes(), ['TST-002']);
      assert.deepEqual(h.emitted.map((e) => e.type), ['changed', 'released']);
    });

    it('a job that reappears is reopened with its original code', () => {
      h.jobs.sync(pid(), [sj('a', 'EGLL-EGKK')]);
      h.jobs.sync(pid(), []);
      assert.deepEqual(codes(), []);
      const r = h.jobs.sync(pid(), [sj('a', 'EGLL-EGKK')]);
      assert.equal(r.updated, 1);
      assert.deepEqual(codes(), ['TST-001']);
    });

    it('releases only the legs whose route changed, and tells the holder', () => {
      h.jobs.sync(pid(), [sj('a', 'EGLL-EGKK-EGCC')]);
      const job = h.jobs.open(pid())[0]!.job;
      h.jobs.reserve(job.id, [1], USER_A);
      h.jobs.reserve(job.id, [2], USER_B);

      const r = h.jobs.sync(pid(), [sj('a', 'EGLL-EGKK-EGPH')]); // leg 2 now ends elsewhere
      assert.deepEqual(r.released.map((n) => [n.discordId, n.legNos, n.reason]), [[USER_B.discordId, [2], 'changed']]);
      const legs = h.jobs.open(pid())[0]!.legs;
      assert.equal(legs[0]!.holder?.discordId, USER_A.discordId, 'unchanged leg keeps its holder');
      assert.equal(legs[1]!.holder, null);
      assert.equal(legs[1]!.arr, 'EGPH');
    });

    it('handles a job gaining and losing legs', () => {
      h.jobs.sync(pid(), [sj('a', 'EGLL-EGKK')]);
      h.jobs.sync(pid(), [sj('a', 'EGLL-EGKK-EGCC-EGPH')]);
      assert.equal(h.jobs.open(pid())[0]!.legs.length, 3);
      const job = h.jobs.open(pid())[0]!.job;
      h.jobs.reserve(job.id, [3], USER_A);
      const r = h.jobs.sync(pid(), [sj('a', 'EGLL-EGKK')]);
      assert.deepEqual(r.released.map((n) => n.legNos), [[3]]);
      assert.equal(h.jobs.open(pid())[0]!.legs.length, 1);
    });

    it('never lists a job that is already past its deadline, and does not spend a code on it', () => {
      h.jobs.sync(pid(), [sj('old', 'EGLL-EGKK', { deadline: T0 - HOUR }), sj('new', 'EGLL-EGCC')]);
      assert.deepEqual(codes(), ['TST-001']);
    });

    it('treats a job without a deadline as open until the source drops it', () => {
      h.jobs.sync(pid(), [sj('a', 'EGLL-EGKK', { deadline: null })]);
      h.clock.advance(1000 * HOUR);
      h.jobs.expireDue();
      assert.deepEqual(codes(), ['TST-001']);
    });

    it('is atomic: a failure part-way leaves everything as it was', () => {
      h.jobs.sync(pid(), [sj('a', 'EGLL-EGKK')]);
      assert.throws(() => h.jobs.sync(99999, [sj('x', 'EGLL-EGKK')]), JobError);
      assert.deepEqual(codes(), ['TST-001']);
    });
  });

  describe('expiry and cleanup', () => {
    it('closes jobs at their deadline and redraws the panel', () => {
      h.jobs.sync(pid(), [sj('soon', 'EGLL-EGKK', { deadline: T0 + 2 * HOUR }), sj('later', 'EGLL-EGCC', { deadline: T0 + 20 * HOUR })]);
      h.emitted.length = 0;
      h.clock.advance(3 * HOUR);
      assert.deepEqual(h.jobs.expireDue(), [pid()]);
      assert.deepEqual(codes(), ['TST-002']);
      assert.deepEqual(h.emitted, [{ type: 'changed', panelId: pid() }]);
      assert.deepEqual(h.jobs.expireDue(), [], 'nothing more to expire');
    });

    it('cannot reserve a job whose deadline passed even before the sweep ran', () => {
      h.jobs.sync(pid(), [sj('a', 'EGLL-EGKK', { deadline: T0 + HOUR })]);
      const id = h.jobs.open(pid())[0]!.job.id;
      h.clock.advance(2 * HOUR);
      assert.throws(() => h.jobs.reserve(id, [1], USER_A), (e: unknown) => e instanceof JobError && e.code === 'EXPIRED');
    });

    it('forgets long-finished jobs but keeps recent and open ones', () => {
      h.jobs.sync(pid(), [sj('a', 'EGLL-EGKK', { deadline: T0 + HOUR }), sj('b', 'EGLL-EGCC', { deadline: T0 + 1000 * HOUR })]);
      h.clock.advance(2 * HOUR);
      h.jobs.expireDue();
      h.jobs.cleanup();
      assert.equal(h.store.listJobs(pid()).length, 2, 'expired a moment ago, still remembered');
      h.clock.advance(8 * 24 * HOUR);
      h.jobs.cleanup();
      assert.deepEqual(h.store.listJobs(pid()).map((j) => j.code), ['TST-002']);
    });
  });

  describe('reserving', () => {
    let singleId: number;
    let multiId: number;
    beforeEach(() => {
      h.jobs.sync(pid(), [sj('s', 'EGLL-EGKK'), sj('m', 'EGLL-EGKK-EGCC-EGPH')]);
      [singleId, multiId] = h.jobs.open(pid()).map((v) => v.job.id) as [number, number];
    });

    it('reserves a free leg and shows the holder', () => {
      const r = h.jobs.reserve(singleId, [1], USER_A);
      assert.deepEqual([r.reserved, r.alreadyMine, r.taken], [[1], [], []]);
      assert.equal(h.jobs.view(singleId)!.legs[0]!.holder?.username, 'alice');
    });

    it('lets different pilots take different legs of one job', () => {
      h.jobs.reserve(multiId, [1], USER_A);
      h.jobs.reserve(multiId, [2, 3], USER_B);
      const legs = h.jobs.view(multiId)!.legs;
      assert.deepEqual(legs.map((l) => l.holder?.username ?? null), ['alice', 'bob', 'bob']);
    });

    it('never overwrites someone else: reports the taken leg and still takes the free ones', () => {
      h.jobs.reserve(multiId, [2], USER_B);
      const r = h.jobs.reserve(multiId, [1, 2, 3], USER_A);
      assert.deepEqual(r.reserved, [1, 3]);
      assert.deepEqual(r.taken.map((t) => [t.legNo, t.holder?.discordId]), [[2, USER_B.discordId]]);
      assert.equal(h.jobs.view(multiId)!.legs[1]!.holder?.username, 'bob');
    });

    it('reports legs you already hold without changing anything', () => {
      h.jobs.reserve(singleId, [1], USER_A);
      h.emitted.length = 0;
      const r = h.jobs.reserve(singleId, [1], USER_A);
      assert.deepEqual([r.reserved, r.alreadyMine], [[], [1]]);
      assert.equal(h.emitted.length, 0, 'no redraw when nothing changed');
    });

    it('ignores duplicate leg numbers and validates them', () => {
      assert.deepEqual(h.jobs.reserve(multiId, [2, 2, 2], USER_A).reserved, [2]);
      assert.throws(() => h.jobs.reserve(multiId, [9], USER_A), (e: unknown) => e instanceof JobError && /no leg 9/.test(e.message));
      assert.throws(() => h.jobs.reserve(multiId, [], USER_A), (e: unknown) => e instanceof JobError && e.code === 'BAD_INPUT');
    });

    it('cannot reserve a closed or unknown job', () => {
      h.jobs.sync(pid(), [sj('m', 'EGLL-EGKK-EGCC-EGPH')]); // closes "s"
      assert.throws(() => h.jobs.reserve(singleId, [1], USER_A), (e: unknown) => e instanceof JobError && e.code === 'NOT_FOUND');
      assert.throws(() => h.jobs.reserve(99999, [1], USER_A), JobError);
    });

    it('emits a redraw when something was reserved', () => {
      h.emitted.length = 0;
      h.jobs.reserve(singleId, [1], USER_A);
      assert.deepEqual(h.emitted, [{ type: 'changed', panelId: pid() }]);
    });
  });

  describe('releasing', () => {
    let id: number;
    beforeEach(() => {
      h.jobs.sync(pid(), [sj('m', 'EGLL-EGKK-EGCC-EGPH')]);
      id = h.jobs.open(pid())[0]!.job.id;
      h.jobs.reserve(id, [1, 2], USER_A);
      h.jobs.reserve(id, [3], USER_B);
    });

    it('frees only your own legs', () => {
      assert.deepEqual(h.jobs.release(id, USER_A.discordId, [1, 3]), [1], 'leg 3 belongs to bob');
      assert.deepEqual(h.jobs.view(id)!.legs.map((l) => l.holder?.username ?? null), [null, 'alice', 'bob']);
    });

    it('with no legs given, frees everything you hold on the job', () => {
      assert.deepEqual(h.jobs.release(id, USER_A.discordId), [1, 2]);
      assert.deepEqual(h.jobs.release(id, USER_A.discordId), [], 'nothing left');
    });

    it('lets the freed leg be taken by someone else', () => {
      h.jobs.release(id, USER_A.discordId, [1]);
      assert.deepEqual(h.jobs.reserve(id, [1], USER_B).reserved, [1]);
    });

    it('admin release frees one leg or all of a job and names the holders', () => {
      const panel = h.store.getPanel(pid())!;
      const one = h.jobs.adminRelease(panel, 'tst-1', 3);
      assert.deepEqual(one.map((n) => [n.discordId, n.legNos, n.reason]), [[USER_B.discordId, [3], 'admin']]);
      const rest = h.jobs.adminRelease(panel, 'TST-001');
      assert.deepEqual(rest.map((n) => [n.discordId, n.legNos]), [[USER_A.discordId, [1, 2]]]);
      assert.deepEqual(h.jobs.adminRelease(panel, 'TST-001'), []);
      assert.throws(() => h.jobs.adminRelease(panel, 'TST-099'), JobError);
    });
  });

  it('lists what one person holds across jobs, soonest deadline first', () => {
    h.jobs.sync(pid(), [sj('late', 'EGLL-EGKK', { deadline: T0 + 30 * HOUR }), sj('early', 'EGLL-EGCC-EGPH', { deadline: T0 + 5 * HOUR }), sj('none', 'EGKK-EGCC')]);
    const [late, early, none] = ['late', 'early', 'none'].map((k) => h.store.getJobBySourceKey(pid(), k)!.id) as [number, number, number];
    h.jobs.reserve(late, [1], USER_A);
    h.jobs.reserve(early, [2], USER_A);
    h.jobs.reserve(none, [1], USER_B);
    const mine = h.jobs.mine(pid(), USER_A.discordId);
    assert.deepEqual(mine.map((v) => v.job.sourceKey), ['early', 'late']);
    assert.deepEqual(mine[0]!.legs.map((l) => l.legNo), [2], 'only the legs they hold');
  });

  it('findByCode finds open jobs only, from loose input', () => {
    h.jobs.sync(pid(), [sj('a', 'EGLL-EGKK', { deadline: T0 + HOUR })]);
    assert.equal(h.jobs.findByCode(h.panel, 'tst 1')?.job.code, 'TST-001');
    assert.equal(h.jobs.findByCode(h.panel, 'TST-002'), null);
    h.clock.advance(2 * HOUR);
    h.jobs.expireDue();
    assert.equal(h.jobs.findByCode(h.panel, 'TST-001'), null);
  });
});

describe('mergeNotices', () => {
  it('combines legs for the same person, job and reason', () => {
    const base = { panelId: 1, discordId: 'u', jobCode: 'X-001', reason: 'removed' as const };
    const out = mergeNotices([{ ...base, legNos: [2] }, { ...base, legNos: [1] }, { ...base, discordId: 'v', legNos: [1] }, { ...base, reason: 'changed', legNos: [3] }]);
    assert.equal(out.length, 3);
    assert.deepEqual(out.find((n) => n.discordId === 'u' && n.reason === 'removed')!.legNos, [1, 2]);
  });
});
