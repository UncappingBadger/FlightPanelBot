import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { ImportError, MAX_IMPORT_BYTES, parseCsv, parseJobsFile, parseLegChain, parseUtc, sampleCsv } from '../src/jobs/import.js';

const ms = (y: number, mo: number, d: number, h = 0, mi = 0, s = 0) => Date.UTC(y, mo - 1, d, h, mi, s);

function rejects(fn: () => unknown): ImportError {
  try {
    fn();
  } catch (e) {
    assert.ok(e instanceof ImportError, `expected ImportError, got ${e}`);
    return e;
  }
  assert.fail('expected the import to be rejected');
}

describe('parseUtc', () => {
  it('reads UTC date-times in the common shapes', () => {
    assert.equal(parseUtc('2026-11-12 18:30'), ms(2026, 11, 12, 18, 30));
    assert.equal(parseUtc('2026-11-12T18:30:15Z'), ms(2026, 11, 12, 18, 30, 15));
    assert.equal(parseUtc('2026-11-12 18:30 UTC'), ms(2026, 11, 12, 18, 30));
    assert.equal(parseUtc('2026/11/12 08:05'), ms(2026, 11, 12, 8, 5));
  });

  it('honours an explicit offset', () => {
    assert.equal(parseUtc('2026-11-12T18:30:00+01:00'), ms(2026, 11, 12, 17, 30));
    assert.equal(parseUtc('2026-11-12 18:30 -0500'), ms(2026, 11, 12, 23, 30));
  });

  it('a bare date means the start of the day, or 23:59:59 for a deadline', () => {
    assert.equal(parseUtc('2026-11-12'), ms(2026, 11, 12, 0, 0, 0));
    assert.equal(parseUtc('2026-11-12', { endOfDay: true }), ms(2026, 11, 12, 23, 59, 59));
  });

  it('reads epoch seconds, milliseconds and Discord timestamps', () => {
    assert.equal(parseUtc('1790000000'), 1790000000_000);
    assert.equal(parseUtc('1790000000000'), 1790000000_000);
    assert.equal(parseUtc('<t:1790000000:F>'), 1790000000_000);
  });

  it('rejects nonsense and impossible dates', () => {
    for (const bad of ['', 'tomorrow', '12/11/2026', '2026-02-31', '2026-11-12 25:00', '2026-11-12 18:61', 'soon']) {
      assert.equal(parseUtc(bad), null, `"${bad}" should not parse`);
    }
  });
});

describe('parseLegChain', () => {
  it('turns a chain of airports into legs', () => {
    assert.deepEqual(parseLegChain('EGLL-EGKK-EGCC'), [
      { dep: 'EGLL', arr: 'EGKK' },
      { dep: 'EGKK', arr: 'EGCC' },
    ]);
  });

  it('accepts several separators and lower case', () => {
    for (const s of ['egll>egkk', 'EGLL → EGKK', 'EGLL EGKK', 'EGLL/EGKK', 'EGLL, EGKK']) {
      assert.deepEqual(parseLegChain(s), [{ dep: 'EGLL', arr: 'EGKK' }], s);
    }
  });

  it('reports what is wrong instead of guessing', () => {
    assert.match(String(parseLegChain('EGLL')), /at least two airports/);
    assert.match(String(parseLegChain('EGLL-LONDON')), /LONDON/);
    assert.match(String(parseLegChain(Array.from({ length: 14 }, (_, i) => `AB${i % 10}${i % 7}`).join('-'))), /more than 12 legs/);
  });

  it('allows a round trip back to the start', () => {
    assert.equal((parseLegChain('KJFK-KBOS-KJFK') as unknown[]).length, 2);
  });
});

describe('parseCsv', () => {
  it('handles quotes, commas inside quotes, doubled quotes, CRLF and a BOM', () => {
    const rows = parseCsv('﻿a,b,c\r\n1,"x, y","say ""hi"""\r\n\r\n2,,3\r\n');
    assert.deepEqual(rows, [
      ['a', 'b', 'c'],
      ['1', 'x, y', 'say "hi"'],
      ['2', '', '3'],
    ]);
  });

  it('keeps a quoted newline inside a field', () => {
    assert.deepEqual(parseCsv('a,b\n"line1\nline2",x\n')[1], ['line1\nline2', 'x']);
  });
});

describe('parseJobsFile (CSV)', () => {
  const csv = (rows: string[]) => ['id,legs,aircraft,from,deadline,pay,notes', ...rows].join('\n');

  it('reads a normal file', () => {
    const jobs = parseJobsFile(csv(['A-1,EGLL-EGKK-EGCC,A320,2026-11-12 08:00,2026-11-14 23:59,"12,500",Two legs']), 'jobs.csv');
    assert.equal(jobs.length, 1);
    const j = jobs[0]!;
    assert.equal(j.key, 'A-1');
    assert.equal(j.legs.length, 2);
    assert.equal(j.aircraft, 'A320');
    assert.equal(j.availableFrom, ms(2026, 11, 12, 8, 0));
    assert.equal(j.deadline, ms(2026, 11, 14, 23, 59));
    assert.equal(j.pay, '12,500');
    assert.equal(j.notes, 'Two legs');
  });

  it('understands alternative column names, in any order and case', () => {
    const jobs = parseJobsFile('Route,Airframe,Complete By,Reference\nEGLL-EGKK,B738,2026-11-20,X9\n', 'x.csv');
    assert.deepEqual([jobs[0]!.key, jobs[0]!.aircraft, jobs[0]!.deadline], ['X9', 'B738', ms(2026, 11, 20, 23, 59, 59)]);
  });

  it('only needs a legs column', () => {
    const j = parseJobsFile('legs\nEGLL-EGKK\n', 'x.csv')[0]!;
    assert.deepEqual([j.aircraft, j.deadline, j.availableFrom], [null, null, null]);
  });

  it('gives a job without an id a stable key, so re-importing keeps its bot ID', () => {
    const a = parseJobsFile('legs,aircraft,deadline\nEGLL-EGKK,A320,2026-11-20 10:00\n', 'x.csv')[0]!;
    const b = parseJobsFile('legs,aircraft,deadline\nEGLL-EGKK,A320,2026-11-20 10:00\n', 'x.csv')[0]!;
    const c = parseJobsFile('legs,aircraft,deadline\nEGLL-EGKK,A320,2026-11-21 10:00\n', 'x.csv')[0]!;
    assert.equal(a.key, b.key);
    assert.notEqual(a.key, c.key);
    assert.match(a.key, /^h-[0-9a-f]{12}$/);
  });

  it('rejects the whole file, listing row numbers, if any row is bad', () => {
    const e = rejects(() =>
      parseJobsFile(csv(['A-1,EGLL-EGKK,A320,,2026-11-14', 'A-2,EGLL,A320,,2026-11-14', 'A-3,EGLL-EGKK,A320,,not a date', 'A-4,EGLL-EGKK,A320,2026-11-20,2026-11-19']), 'jobs.csv'),
    );
    assert.match(e.message, /Nothing was imported: 3 problems/);
    assert.ok(e.problems.some((p) => /^row 3: .*two airports/.test(p)));
    assert.ok(e.problems.some((p) => /^row 4: deadline .*not a date/.test(p)));
    assert.ok(e.problems.some((p) => /^row 5: .*not after the start/.test(p)));
  });

  it('rejects duplicate ids', () => {
    const e = rejects(() => parseJobsFile(csv(['A-1,EGLL-EGKK,A320,,', 'A-1,EGKK-EGCC,A320,,']), 'jobs.csv'));
    assert.ok(e.problems.some((p) => /share the id "A-1"/.test(p)));
  });

  it('needs a legs column and at least one job', () => {
    assert.match(rejects(() => parseJobsFile('id,aircraft\nA-1,A320\n', 'x.csv')).message, /legs/);
    assert.match(rejects(() => parseJobsFile('legs\n', 'x.csv')).message, /no jobs/);
    assert.match(rejects(() => parseJobsFile('   \n', 'x.csv')).message, /empty/);
  });

  it('caps long problem lists and oversize files', () => {
    const many = Array.from({ length: 30 }, () => 'bad,A320,,').join('\n');
    const e = rejects(() => parseJobsFile(`legs,aircraft,from,deadline\n${many}\n`, 'x.csv'));
    assert.equal(e.problems.length, 11);
    assert.match(e.problems.at(-1)!, /and 20 more/);
    assert.match(rejects(() => parseJobsFile('x'.repeat(MAX_IMPORT_BYTES + 1), 'x.csv')).message, /larger than/);
  });

  it('strips control characters and caps field lengths', () => {
    const j = parseJobsFile(`legs,notes,aircraft\nEGLL-EGKK,"a\u0000b ${'x'.repeat(500)}",${'Z'.repeat(100)}\n`, 'x.csv')[0]!;
    assert.ok(j.notes!.length <= 200 && !/[\u0000-\u001f]/.test(j.notes!));
    assert.equal(j.aircraft!.length, 40);
  });
});

describe('parseJobsFile (JSON)', () => {
  it('reads a list, with legs as a chain, as airports or as pairs', () => {
    const jobs = parseJobsFile(
      JSON.stringify([
        { id: 'a', legs: 'EGLL-EGKK', aircraft: 'A320', deadline: '2026-11-14 12:00' },
        { id: 'b', legs: ['EGLL', 'EGKK', 'EGCC'], airframe: 'B738' },
        { id: 'c', legs: [['EGLL', 'EGKK'], { from: 'EGPH', to: 'EGSS' }], deadline: 1790000000 },
      ]),
      'jobs.json',
    );
    assert.deepEqual(jobs.map((j) => j.legs.length), [1, 2, 2]);
    assert.equal(jobs[1]!.aircraft, 'B738');
    assert.equal(jobs[2]!.legs[1]!.dep, 'EGPH');
    assert.equal(jobs[2]!.deadline, 1790000000_000);
  });

  it('accepts {"jobs": [...]} and detects JSON by content even with a .txt name', () => {
    assert.equal(parseJobsFile('{"jobs":[{"legs":"EGLL-EGKK"}]}', 'flights.txt').length, 1);
  });

  it('reports bad JSON and bad entries clearly', () => {
    assert.match(rejects(() => parseJobsFile('[{"legs":', 'x.json')).message, /valid JSON/);
    assert.match(rejects(() => parseJobsFile('{"nope":1}', 'x.json')).message, /list of jobs/);
    const e = rejects(() => parseJobsFile('[{"legs":"EGLL-EGKK"}, 5, {"id":"z"}]', 'x.json'));
    assert.ok(e.problems.some((p) => /job 2: expected an object/.test(p)));
    assert.ok(e.problems.some((p) => /job 3: .*legs/.test(p)));
  });
});

describe('sampleCsv', () => {
  it('is itself a valid import, with future dates relative to now', () => {
    const now = Date.UTC(2026, 10, 11, 12);
    const jobs = parseJobsFile(sampleCsv(now), 'sample.csv');
    assert.equal(jobs.length, 3);
    assert.ok(jobs.every((j) => j.deadline! > now));
    assert.deepEqual(jobs.map((j) => j.legs.length), [1, 2, 3]);
  });
});
