import assert from 'node:assert/strict';
import { afterEach, beforeEach, describe, it } from 'node:test';
import { aliasNote, ALIASES_AS_OF, compatibleWith, expandAircraftTypes, FSHUB_ALIASES, isAliasUse, isCompatible } from '../src/services/aircraftAliases.js';
import { sameAircraft } from '../src/services/flightMatch.js';
import type { FlownFlight } from '../src/db/store.js';
import { completedCard, flightFacts, searchEmbeds } from '../src/discord/ui.js';
import { makeHarness, sj, T0, USER_A, type Harness } from './helpers.js';
import { embedText } from './discord-helpers.js';

const flown = (aircraftIcao: string | null): FlownFlight => ({
  flightId: 1,
  pilotId: 1001,
  pilotName: 'alice',
  dep: 'EGLL',
  arr: 'EGKK',
  departedAt: T0,
  arrivedAt: T0 + 3_600_000,
  aircraftIcao,
  aircraftName: null,
  scheduleStatus: null,
});

describe("FsHub's aircraft aliases", () => {
  describe('the table', () => {
    it("is FsHub's list as read from its aircraft page, with a date", () => {
      assert.match(ALIASES_AS_OF, /^2026-\d\d-\d\d$/);
      assert.equal(Object.keys(FSHUB_ALIASES).length, 23);
      for (const [type, list] of Object.entries(FSHUB_ALIASES)) {
        assert.match(type, /^[A-Z0-9]{3,4}$/);
        assert.ok(list.length > 0 && list.every((a) => /^[A-Z0-9]{3,4}$/.test(a) && a !== type), type);
      }
    });

    it('is the same both ways: if A is an alias of B, B is an alias of A', () => {
      for (const [type, list] of Object.entries(FSHUB_ALIASES)) for (const a of list) assert.ok(FSHUB_ALIASES[a]?.includes(type), `${a} should list ${type}`);
    });
  });

  describe('what is compatible', () => {
    it('knows the examples FsHub gave: the A320 family, the A330s, the B738 and the B38M', () => {
      assert.deepEqual(compatibleWith('A320').sort(), ['A20N', 'A319', 'A21N', 'A321'].sort());
      assert.deepEqual(compatibleWith('a333').sort(), ['A332', 'A339']);
      assert.deepEqual(compatibleWith('B738'), ['B38M']);
      assert.deepEqual(compatibleWith('B38M'), ['B738']);
    });

    it('reads a list both ways, in case FsHub lists an alias on one aircraft only', () => {
      const lopsided = { AAAA: ['BBBB'], CCCC: ['AAAA'] };
      assert.deepEqual(compatibleWith('BBBB', lopsided), ['AAAA']);
      assert.deepEqual(compatibleWith('AAAA', lopsided).sort(), ['BBBB', 'CCCC']);
    });

    it('says nothing is compatible with an aircraft that has no aliases, or one nobody has heard of', () => {
      assert.deepEqual(compatibleWith('C172'), []);
      assert.deepEqual(compatibleWith('ZZZZ'), []);
    });

    it('treats a type as compatible with itself and with its aliases, in any case', () => {
      assert.equal(isCompatible('A320', 'a20n'), true);
      assert.equal(isCompatible('A320', 'A320'), true);
      assert.equal(isCompatible(' b738 ', 'B38M'), true);
      assert.equal(isCompatible('A320', 'B738'), false, 'not the same family');
      assert.equal(isCompatible('A332', 'A346'), false, 'A330 and A340 are separate groups');
      assert.equal(isCompatible('C172', 'C182'), false);
    });

    it('tells an alias from the aircraft itself', () => {
      assert.equal(isAliasUse('A320', 'A20N'), true);
      assert.equal(isAliasUse('A320', 'A320'), false);
      assert.equal(isAliasUse('A320', 'B738'), false);
    });

    it('is applied to what was flown against what was scheduled', () => {
      assert.equal(sameAircraft('A320', 'A20N'), true);
      assert.equal(sameAircraft('B38M', 'B738'), true);
      assert.equal(sameAircraft('A332', 'A339'), true);
      assert.equal(sameAircraft('A320', 'B738'), false, 'a real mismatch is still one');
      assert.equal(sameAircraft('A343', 'A359'), false);
      assert.equal(sameAircraft('A32', 'A320'), null, 'an abbreviation still cannot be compared');
    });
  });

  describe('a completed flight', () => {
    it('says it was flown as an alias, and does not warn', () => {
      const text = flightFacts(flown('A20N'), 'A320');
      assert.match(text, /^A20N, landed <t:\d+:t> · counts as A320$/);
      assert.doesNotMatch(text, /⚠️/);
    });

    it('still warns for a different aircraft that is not an alias, and says nothing extra when it was the aircraft asked for', () => {
      assert.match(flightFacts(flown('B738'), 'A320'), /⚠️ scheduled A320/);
      assert.doesNotMatch(flightFacts(flown('A320'), 'A320'), /counts as|⚠️/);
      assert.doesNotMatch(flightFacts(flown('A20N'), null), /counts as|⚠️/);
    });

    describe('on its card', () => {
      let h: Harness;
      beforeEach(async () => {
        h = await makeHarness();
      });
      afterEach(() => h.close());

      const cardFor = (required: string, flownType: string) => {
        h.jobs.sync(h.panel.id, [sj('a', 'EGLL-EGKK', { aircraft: required })]);
        const view = h.jobs.open(h.panel.id)[0]!;
        h.jobs.reserve(view.job.id, [1], USER_A);
        h.jobs.complete(view.job.id, USER_A.discordId);
        return embedText(completedCard(h.jobs.view(view.job.id)!, new Map([[1, flown(flownType)]])));
      };

      it('shows what an alias stood in for, with no warning', () => {
        const text = cardFor('A320', 'A20N');
        assert.match(text, /🔁 counts as A320 \(a FsHub alias\)/);
        assert.doesNotMatch(text, /⚠️/);
      });

      it('warns about a real mismatch, as before', () => {
        const text = cardFor('A320', 'B738');
        assert.match(text, /⚠️ scheduled A320/);
        assert.doesNotMatch(text, /🔁/);
      });
    });
  });

  describe('searching by aircraft type', () => {
    it('adds the aliases of what was typed, so a pilot with an A20N also finds the A320 jobs they can fly', () => {
      const r = expandAircraftTypes(['A20N']);
      assert.deepEqual(r.codes, ['A20N', 'A320', 'A319', 'A321', 'A21N']);
      assert.deepEqual(r.added, [{ type: 'A20N', also: ['A320', 'A319', 'A321', 'A21N'] }]);
    });

    it('works for a few characters that are the start of a type, adding what the types starting with them bring', () => {
      const r = expandAircraftTypes(['B73']);
      assert.deepEqual(r.codes, ['B73', 'B38M'], 'B738 starts with B73, and its alias is the B38M');
      const f = expandAircraftTypes(['A32']);
      assert.ok(f.codes.includes('A20N') && f.codes.includes('A21N') && f.codes.includes('A319'), 'A320 and A321 start with A32');
      assert.ok(!f.codes.includes('A320'), 'what A32 already covers is not added again');
    });

    it('handles several types, in any case, without adding the same one twice', () => {
      const r = expandAircraftTypes(['a320', 'A20N']);
      assert.equal(new Set(r.codes).size, r.codes.length);
      assert.deepEqual(r.codes.slice(0, 2), ['A320', 'A20N']);
    });

    it('adds nothing for a type with no aliases, or one nobody has heard of', () => {
      assert.deepEqual(expandAircraftTypes(['C172']), { codes: ['C172'], added: [] });
      assert.deepEqual(expandAircraftTypes(['ZZ']), { codes: ['ZZ'], added: [] });
      assert.deepEqual(expandAircraftTypes([]), { codes: [], added: [] });
    });

    it('tells the pilot what was added, in a line, or nothing when nothing was', () => {
      assert.equal(aliasNote([]), null);
      assert.equal(aliasNote(expandAircraftTypes(['B738']).added), '✈️ On FsHub B38M counts as the same aircraft as B738, so flights asking for it are included.');
      assert.equal(
        aliasNote(expandAircraftTypes(['A20N']).added),
        '✈️ On FsHub A320, A319, A321, A21N count as the same aircraft as A20N, so flights asking for those are included.',
      );
      assert.match(aliasNote(expandAircraftTypes(['B738', 'A333']).added)!, /B38M counts as the same aircraft as B738; A332, A339 count as the same aircraft as A333, so flights asking for those/);
    });

    it('puts that line in the reply, after the matches', () => {
      const note = aliasNote(expandAircraftTypes(['A20N']).added);
      const head = searchEmbeds({ showDays: 7 } as any, [], [], [], T0, null, ['A20N'], undefined, 0, note)[0]!.toJSON();
      assert.match(head.description!, /Nothing in A20N is open now/);
      assert.match(head.description!, /\n✈️ On FsHub A320, A319, A321, A21N count as the same aircraft as A20N/);
      const without = searchEmbeds({ showDays: 7 } as any, [], [], [], T0, null, ['A20N'])[0]!.toJSON();
      assert.doesNotMatch(without.description!, /FsHub/);
    });
  });
});
