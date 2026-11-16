import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { decodeMetar, looksLikeMetar, placeInTime, relativeHumidity, type DecodedMetar } from '../src/services/metar.js';

const NOW = Date.UTC(2026, 10, 16, 14, 10); // 2026-11-16 14:10Z

/** Decode `body` as a report from EGLL on the 16th at 13:50Z (the groups after the time are what each test is about). */
const d = (body: string, head = 'EGLL 161350Z'): DecodedMetar => {
  const r = decodeMetar(`${head} ${body}`, { now: NOW });
  assert.ok(r, `decodes: ${body}`);
  return r;
};
const lines = (m: DecodedMetar, title: string): string => (m.sections.find((s) => s.title === title)?.lines ?? []).join('\n');
const all = (m: DecodedMetar): string => m.sections.flatMap((s) => s.lines).join('\n');

describe('how a METAR begins', () => {
  it('takes the airport, the day and time, and says them in words', () => {
    const m = d('26008KT 9999 NSC 08/01 Q1006');
    assert.equal(m.station, 'EGLL');
    assert.equal(m.kind, 'METAR');
    assert.equal(m.when, 'the 16th at 13:50 UTC');
    assert.equal(m.observedAt, Date.UTC(2026, 10, 16, 13, 50));
    assert.equal(m.nil, false);
  });

  it('accepts the METAR or SPECI word first, in any case, and tells a special report from a routine one', () => {
    assert.equal(decodeMetar('METAR EGLL 161350Z 26008KT', { now: NOW })?.kind, 'METAR');
    const s = decodeMetar('speci egll 161350z 26008kt', { now: NOW })!;
    assert.equal(s.kind, 'SPECI');
    assert.equal(s.station, 'EGLL');
    assert.match(lines(s, 'The report'), /special report/);
  });

  it('knows a corrected report whether COR comes before the airport or after the time, and Canadian CCA', () => {
    for (const text of ['METAR COR EGLL 161350Z 26008KT', 'EGLL 161350Z COR 26008KT', 'CYYZ 161350Z CCA 26008KT']) assert.equal(decodeMetar(text, { now: NOW })!.corrected, true, text);
    assert.equal(d('26008KT').corrected, false);
  });

  it('knows an automatic report', () => {
    const m = d('AUTO 26008KT 9999 NCD 08/01 Q1006');
    assert.equal(m.auto, true);
    assert.match(lines(m, 'The report'), /automatically/);
    assert.equal(d('26008KT').auto, false);
  });

  it('says a station sent nothing when the report is NIL, with or without the end mark', () => {
    for (const text of ['EDDF 161350Z NIL', 'METAR EDDF 161350Z NIL=']) {
      const m = decodeMetar(text, { now: NOW })!;
      assert.equal(m.nil, true, text);
      assert.match(m.summary, /EDDF sent no weather report for the 16th at 13:50 UTC/);
      assert.deepEqual(m.sections, []);
    }
  });

  it('takes the airport from the caller when the report starts at the time (as the JSON form of the service does)', () => {
    const m = decodeMetar('161350Z COR 26008KT 9999 NSC 08/01 Q1006', { now: NOW, station: 'egll' })!;
    assert.equal(m.station, 'EGLL');
    assert.equal(m.corrected, true);
    assert.equal(decodeMetar('161350Z 26008KT', { now: NOW })!.station, null);
  });

  it('is not a METAR without a day-and-time group', () => {
    for (const text of ['', 'hello there', 'EGLL', 'EGLL 26008KT 9999', 'TST-001', 'name Alex Smith', 'TAF EGLL 161100Z 1612/1718 26008KT']) assert.equal(decodeMetar(text, { now: NOW }), null, text);
  });

  it('tidies the report: one line, capitals, no end mark, no control characters', () => {
    const m = decodeMetar('egll  161350z\n26008kt\t9999=', { now: NOW })!;
    assert.equal(m.raw, 'EGLL 161350Z 26008KT 9999');
  });

  it('without the current time it does not guess the date', () => {
    const m = decodeMetar('EGLL 161350Z 26008KT')!;
    assert.equal(m.observedAt, null);
    assert.equal(m.when, 'the 16th at 13:50 UTC');
  });
});

describe('placing the day of the month in time', () => {
  const at = (y: number, mo: number, day: number, h = 0, mi = 0) => Date.UTC(y, mo - 1, day, h, mi);
  it('picks the date nearest to now', () => {
    assert.equal(placeInTime(16, 13, 50, at(2026, 11, 16, 14, 10)), at(2026, 11, 16, 13, 50));
    assert.equal(placeInTime(15, 23, 50, at(2026, 11, 16, 0, 5)), at(2026, 11, 15, 23, 50), 'yesterday evening');
  });
  it('crosses a month end either way', () => {
    assert.equal(placeInTime(30, 23, 50, at(2026, 11, 1, 0, 10)), at(2026, 10, 30, 23, 50), 'a report from last month');
    assert.equal(placeInTime(1, 0, 10, at(2026, 10, 31, 23, 55)), at(2026, 11, 1, 0, 10), 'a report stamped just into next month');
    assert.equal(placeInTime(31, 12, 0, at(2026, 11, 20, 6, 0)), at(2026, 10, 31, 12, 0), 'there is no 31 November, so it is the 31st of the month before (nearest that exists)');
  });
  it('is null for a day or time that cannot exist', () => {
    assert.equal(placeInTime(0, 1, 1, NOW), null);
    assert.equal(placeInTime(32, 1, 1, NOW), null);
    assert.equal(placeInTime(16, 24, 0, NOW), null);
    assert.equal(placeInTime(16, 12, 60, NOW), null);
  });
  it('says the day with the right ending', () => {
    for (const [day, word] of [[1, '1st'], [2, '2nd'], [3, '3rd'], [4, '4th'], [11, '11th'], [12, '12th'], [13, '13th'], [21, '21st'], [22, '22nd'], [23, '23rd'], [30, '30th'], [31, '31st']] as const) {
      assert.match(decodeMetar(`EGLL ${String(day).padStart(2, '0')}1200Z 00000KT`, { now: NOW })!.when, new RegExp(`^the ${word} at`), String(day));
    }
  });
});

describe('recognising a pasted METAR', () => {
  it('knows one that starts with an airport and a time, however it is written', () => {
    for (const text of ['EGLL 161350Z 26008KT', 'METAR EGLL 161350Z', 'speci kjfk 161351z 35011kt', 'METAR COR EGLL 161350Z', '  EGLL 161350Z=', 'CYYZ 161350Z CCA 26008KT']) assert.equal(looksLikeMetar(text), true, text);
  });
  it('is strict, so ordinary messages and flight IDs are never taken for one', () => {
    for (const text of ['TST-001', 'TST-001 161350Z', 'cancel', 'flights', 'name Alex Smith', 'fshub 1234', 'EGLL', 'TAF EGLL 161100Z 1612/1718', 'hello EGLL 161350Z 26008KT', '161350Z 26008KT']) assert.equal(looksLikeMetar(text), false, text);
  });
});

describe('wind', () => {
  it('gives the direction as a compass point and in degrees, and the speed in knots and km/h', () => {
    const m = d('26008KT');
    assert.match(lines(m, 'Wind'), /^From the west \(260°\), at 8 knots \(15 km\/h\)\. That is a moderate wind\.$/);
  });

  it('names the sixteen points around the compass', () => {
    const expect: Array<[string, string]> = [['000', 'north'], ['360', 'north'], ['020', 'north-north-east'], ['045', 'north-east'], ['070', 'east-north-east'], ['090', 'east'], ['135', 'south-east'], ['180', 'south'], ['225', 'south-west'], ['270', 'west'], ['315', 'north-west'], ['340', 'north-north-west']];
    for (const [deg, name] of expect) assert.match(lines(d(`${deg}10KT`), 'Wind'), new RegExp(`^From the ${name} \\(${deg}°\\)`), deg);
  });

  it('says calm for no wind', () => {
    assert.equal(lines(d('00000KT'), 'Wind'), 'Calm: no wind to speak of.');
    assert.match(d('00000KT 9999 NSC 10/05 Q1013').summary, /^Calm wind/);
  });

  it('says variable for VRB, and does not call a variable wind calm', () => {
    assert.match(lines(d('VRB03KT'), 'Wind'), /^Variable direction, at 3 knots \(6 km\/h\)\./);
    assert.match(lines(d('VRB00KT'), 'Wind'), /^Variable direction, at 0 knots/);
  });

  it('gives gusts', () => {
    assert.match(lines(d('31018G28KT'), 'Wind'), /^From the north-west \(310°\), at 18 knots \(33 km\/h\), gusting to 28 knots \(52 km\/h\)\. That is a strong wind\.$/);
  });

  it('gives the range a varying direction swings through', () => {
    assert.match(lines(d('26008KT 230V290'), 'Wind'), /The direction varied between 230° and 290°/);
  });

  it('reads metres per second and km/h, and says the knots beside them', () => {
    assert.match(lines(d('24005MPS'), 'Wind'), /^From the west-south-west \(240°\), at 5 m\/s \(10 knots\)\./);
    assert.match(lines(d('24018KMH'), 'Wind'), /at 18 km\/h \(10 knots\)/);
    assert.match(lines(d('24005G09MPS'), 'Wind'), /gusting to 9 m\/s \(17 knots\)/);
  });

  it('reads a speed of a hundred knots or more, written either way', () => {
    assert.match(lines(d('210103G130KT'), 'Wind'), /at 103 knots.*gusting to 130 knots/);
    assert.match(lines(d('210P99KT'), 'Wind'), /at 99 knots or more/);
  });

  it('says so when the wind, or part of it, was not reported', () => {
    assert.match(lines(d('/////KT'), 'Wind'), /^The wind was not reported/);
    assert.match(lines(d('///05KT'), 'Wind'), /^Direction not reported, at 5 knots/);
    assert.match(lines(d('270//KT'), 'Wind'), /^The wind speed was not reported/);
  });

  it('rates the strength in plain words', () => {
    for (const [kt, word] of [[3, 'light'], [6, 'light'], [7, 'moderate'], [16, 'moderate'], [17, 'strong'], [27, 'strong'], [28, 'very strong']] as const) {
      assert.match(lines(d(`270${String(kt).padStart(2, '0')}KT`), 'Wind'), new RegExp(`That is a ${word} wind`), `${kt} kt`);
    }
  });
});

describe('visibility', () => {
  it('reads metres, with kilometres and miles beside them, and says how good it is', () => {
    assert.equal(lines(d('26008KT 4000'), 'Visibility'), '4 km (2.5 miles), which is moderate.');
    assert.equal(lines(d('26008KT 1500'), 'Visibility'), '1.5 km (0.9 miles), which is poor.');
    assert.equal(lines(d('26008KT 0800'), 'Visibility'), '800 metres, which is poor.');
    assert.equal(lines(d('26008KT 0350'), 'Visibility'), '350 metres, which is very poor.');
  });

  it('says how good it is at each step: very good from 8 km, good from 5 km, moderate from 1.6 km, poor from 800 m', () => {
    const word = (metres: string) => /, which is ([a-z ]+)\.$/.exec(lines(d(`26008KT ${metres}`), 'Visibility'))?.[1];
    assert.equal(word('8000'), 'very good');
    assert.equal(word('7999'), 'good');
    assert.equal(word('5000'), 'good');
    assert.equal(word('4999'), 'moderate');
    assert.equal(word('1600'), 'moderate');
    assert.equal(word('1599'), 'poor');
    assert.equal(word('0800'), 'poor');
    assert.equal(word('0799'), 'very poor');
  });

  it('says 10 km or more for 9999 and under 50 metres for 0000', () => {
    assert.equal(lines(d('26008KT 9999'), 'Visibility'), '10 km or more (6 miles or more), which is very good.');
    assert.equal(lines(d('26008KT 0000'), 'Visibility'), 'Less than 50 metres, which is very poor.');
  });

  it('reads statute miles, whole, fractions and mixed, with the kilometres beside them', () => {
    assert.equal(lines(d('26008KT 10SM'), 'Visibility'), '10 statute miles (16.1 km), which is very good.');
    assert.equal(lines(d('26008KT 1/2SM'), 'Visibility'), '1/2 statute mile (0.8 km), which is poor.');
    assert.equal(lines(d('26008KT 1 1/2SM'), 'Visibility'), '1 1/2 statute miles (2.4 km), which is moderate.');
    assert.equal(lines(d('26008KT 2 1/2SM'), 'Visibility'), '2 1/2 statute miles (4 km), which is moderate.');
    assert.equal(lines(d('26008KT 1SM'), 'Visibility'), '1 statute mile (1.6 km), which is moderate.');
  });

  it('reads "less than" (M) and "more than" (P)', () => {
    assert.match(lines(d('26008KT M1/4SM'), 'Visibility'), /^Less than 1\/4 statute mile \(about 0\.4 km\)/);
    assert.match(lines(d('26008KT P6SM'), 'Visibility'), /^More than 6 statute miles \(about 9\.7 km\)/);
  });

  it('says CAVOK in words, and that it stands for the weather and cloud too', () => {
    const m = d('26008KT CAVOK 10/05 Q1013');
    assert.match(lines(m, 'Visibility'), /^CAVOK \("ceiling and visibility OK"\): visibility 10 km or more, no cloud below 5,000 ft/);
    assert.equal(lines(m, 'Weather'), 'No significant weather.');
    assert.match(lines(m, 'Clouds'), /No cloud below 5,000 ft/);
  });

  it('gives the lowest visibility in a direction when a second one follows the main one', () => {
    const m = d('26008KT 6000 1400SW');
    assert.equal(lines(m, 'Visibility').split('\n')[0], '6 km (3.7 miles), which is good.');
    assert.match(lines(m, 'Visibility'), /Lowest visibility 1\.4 km \(0\.9 miles\) towards the south-west/);
  });

  it('knows "no directional variation"', () => {
    assert.match(lines(d('AUTO 26008KT 9999NDV NCD 10/05 Q1013'), 'Visibility'), /^10 km or more/);
  });

  it('says so when it was not reported', () => {
    assert.equal(lines(d('AUTO 26008KT //// NCD 10/05 Q1013'), 'Visibility'), 'Visibility was not reported.');
  });
});

describe('runway visual range', () => {
  it('reads a value, and says whether it is getting better or worse', () => {
    assert.match(lines(d('26008KT 0800 R24/1100U'), 'Visibility'), /On runway 24, a pilot could see lights and markings 1,100 m, getting better\./);
    assert.match(lines(d('26008KT 0800 R24/1100D'), 'Visibility'), /1,100 m, getting worse\./);
    assert.match(lines(d('26008KT 0800 R24/1100N'), 'Visibility'), /1,100 m, not changing much\./);
    assert.match(lines(d('26008KT 0800 R24/1100'), 'Visibility'), /1,100 m\.$/m);
  });

  it('reads a variable range, and "more than" and "less than"', () => {
    assert.match(lines(d('26008KT 0800 R04R/0950V1100'), 'Visibility'), /On runway 04R, .* varying between 950 m and 1,100 m\./);
    assert.match(lines(d('26008KT 0800 R27/P2000'), 'Visibility'), /more than 2,000 m/);
    assert.match(lines(d('26008KT 0800 R27/M0050'), 'Visibility'), /less than 50 m/);
  });

  it('reads feet (US and Canada), with metres beside them, and the Canadian trend letter after a slash', () => {
    assert.match(lines(d('26008KT 1/2SM R28L/2600FT'), 'Visibility'), /On runway 28L, .* 2,600 ft \(792 m\)\./);
    assert.match(lines(d('26008KT 1/2SM R01L/0600V1000FT'), 'Visibility'), /varying between 600 ft \(183 m\) and 1,000 ft \(305 m\)/);
    assert.match(lines(d('26008KT 1/2SM R27/P6000FT'), 'Visibility'), /more than 6,000 ft \(1,829 m\)/);
    assert.match(lines(d('26008KT 1/2SM R01L/M0600FT'), 'Visibility'), /less than 600 ft/);
    assert.match(lines(d('26008KT 1/4SM R09/4000FT/D'), 'Visibility'), /4,000 ft \(1,219 m\), getting worse/);
  });

  it('says so when a runway has none', () => {
    assert.match(lines(d('26008KT 0800 R24/////'), 'Visibility'), /Runway visual range for runway 24 was not available\./);
  });

  it('reads several runways', () => {
    const l = lines(d('26008KT 0800 R24L/0900 R24R/1000'), 'Visibility');
    assert.match(l, /runway 24L/);
    assert.match(l, /runway 24R/);
  });
});

describe('present weather', () => {
  const wx = (code: string): string => lines(d(`26008KT 4000 ${code} BKN010 08/07 Q1006`), 'Weather');

  it('says rain, drizzle, snow and the rest, with the strength', () => {
    assert.equal(wx('RA'), 'Moderate rain.');
    assert.equal(wx('-RA'), 'Light rain.');
    assert.equal(wx('+RA'), 'Heavy rain.');
    assert.equal(wx('-DZ'), 'Light drizzle.');
    assert.equal(wx('SN'), 'Moderate snow.');
    assert.equal(wx('SG'), 'Moderate snow grains.');
    assert.equal(wx('PL'), 'Moderate ice pellets.');
    assert.equal(wx('IC'), 'Moderate ice crystals.');
    assert.equal(wx('UP'), 'Moderate unidentified precipitation.');
  });

  it('says mist, fog, haze and the like without a strength', () => {
    assert.equal(wx('BR'), 'Mist.');
    assert.equal(wx('FG'), 'Fog.');
    assert.equal(wx('HZ'), 'Haze.');
    assert.equal(wx('FU'), 'Smoke.');
    assert.equal(wx('VA'), 'Volcanic ash.');
    assert.equal(wx('DU'), 'Widespread dust.');
    assert.equal(wx('SA'), 'Sand.');
    assert.equal(wx('SQ'), 'Squalls.');
    assert.equal(wx('PO'), 'Dust or sand whirls.');
    assert.equal(wx('SS'), 'Sandstorm.');
    assert.equal(wx('DS'), 'Duststorm.');
  });

  it('says hail and small hail', () => {
    assert.equal(wx('GR'), 'Moderate hail.');
    assert.equal(wx('GS'), 'Moderate small hail.');
  });

  it('puts a thunderstorm with its rain, and a shower as a shower', () => {
    assert.equal(wx('TS'), 'Thunderstorm.');
    assert.equal(wx('TSRA'), 'Thunderstorm with moderate rain.');
    assert.equal(wx('+TSRA'), 'Thunderstorm with heavy rain.');
    assert.equal(wx('-TSSN'), 'Thunderstorm with light snow.');
    assert.equal(wx('+SHRA'), 'Heavy rain showers.');
    assert.equal(wx('-SHSN'), 'Light snow showers.');
    assert.equal(wx('SHGR'), 'Moderate hail showers.');
    assert.equal(wx('SHRASN'), 'Moderate rain and snow showers.');
  });

  it('says freezing, blowing, drifting, shallow, patchy and partial', () => {
    assert.equal(wx('FZRA'), 'Moderate freezing rain.');
    assert.equal(wx('-FZDZ'), 'Light freezing drizzle.');
    assert.equal(wx('FZFG'), 'Freezing fog.');
    assert.equal(wx('BLSN'), 'Blowing snow.');
    assert.equal(wx('DRSN'), 'Low drifting snow.');
    assert.equal(wx('BLDU'), 'Blowing widespread dust.');
    assert.equal(wx('MIFG'), 'Shallow fog.');
    assert.equal(wx('BCFG'), 'Patches of fog.');
    assert.match(wx('PRFG'), /^Partial fog \(a bank covering part of the airfield\)\.$/);
  });

  it('says funnel cloud, and tornado or waterspout for +FC', () => {
    assert.equal(wx('FC'), 'Funnel cloud.');
    assert.equal(wx('+FC'), 'Tornado or waterspout.');
  });

  it('says in the vicinity for VC, which is close to the airfield but not at it', () => {
    assert.match(wx('VCSH'), /^Showers in the vicinity \(close to the airfield, not over it\)\.$/);
    assert.match(wx('VCTS'), /^Thunderstorm in the vicinity/);
    assert.match(wx('VCFG'), /^Fog in the vicinity/);
  });

  it('keeps several groups apart, and says NSW means nothing significant', () => {
    assert.equal(wx('-SN BR'), 'Light snow.\nMist.');
    assert.equal(wx('+SHRA BLSN'), 'Heavy rain showers.\nBlowing snow.');
    assert.equal(lines(d('26008KT 9999 NSW NSC 08/07 Q1006'), 'Weather'), 'No significant weather.');
  });

  it('says there is none when the report has none', () => {
    assert.equal(lines(d('26008KT 9999 NSC 08/07 Q1006'), 'Weather'), 'No significant weather.');
  });

  it('says what an automatic station could not tell (//)', () => {
    const m = d('AUTO 26008KT 9999 // NCD 16/12 Q1018');
    assert.match(lines(m, 'Weather'), /did not report present weather/);
    assert.match(m.summary, /weather not reported/);
  });

  it('adds recent weather (RE), which has ended or eased in the last hour', () => {
    assert.match(lines(d('26008KT 9999 NSC 08/07 Q1006 RETS'), 'Weather'), /Recently \(in the last hour\): thunderstorm\./);
    assert.match(lines(d('26008KT 9999 NSC 08/07 Q1006 RERA'), 'Weather'), /Recently \(in the last hour\): moderate rain\./);
    assert.equal(lines(d('26008KT 9999 NSC 08/07 Q1006 RE//'), 'Weather'), 'No significant weather.\nRecent weather was not reported.');
  });

  it('does not take other words for weather', () => {
    const m = d('26008KT 9999 FOOBAR NSC 08/07 Q1006');
    assert.deepEqual(m.unread, ['FOOBAR']);
  });
});

describe('cloud', () => {
  it('reads the amount, and the height in feet and metres', () => {
    assert.equal(lines(d('26008KT 9999 FEW028'), 'Clouds'), 'A few clouds (1 to 2 eighths of the sky) at 2,800 ft (853 m).');
    assert.equal(lines(d('26008KT 9999 SCT015'), 'Clouds'), 'Scattered cloud (3 to 4 eighths) at 1,500 ft (457 m).');
  });

  it('says broken and overcast are the ceiling, and only for the lowest of them', () => {
    const l = lines(d('26008KT 9999 SCT008 BKN012 OVC030'), 'Clouds').split('\n');
    assert.equal(l[0], 'Scattered cloud (3 to 4 eighths) at 800 ft (244 m).', 'scattered cloud is not a ceiling');
    assert.equal(l[1], 'Broken cloud (5 to 7 eighths) at 1,200 ft (366 m). This is the ceiling.');
    assert.equal(l[2], 'Overcast (the whole sky covered) at 3,000 ft (914 m).');
  });

  it('names thunderstorm cloud and towering cumulus', () => {
    assert.match(lines(d('26008KT 9999 BKN040CB'), 'Clouds'), /^Broken cloud \(5 to 7 eighths\) at 4,000 ft \(1,219 m\): thunderstorm cloud \(cumulonimbus\)\. This is the ceiling\.$/);
    assert.match(lines(d('26008KT 9999 SCT025TCU'), 'Clouds'), /towering cumulus/);
  });

  it('says an automatic station could not tell the type', () => {
    assert.match(lines(d('AUTO 26008KT 9999 // FEW004/// 10/09 Q1013'), 'Clouds'), /^A few clouds .* at 400 ft .* \(the type of cloud could not be detected\)\.$/);
  });

  it('says vertical visibility when the sky is hidden, and counts it as the ceiling', () => {
    assert.match(lines(d('26008KT 0200 FG VV002'), 'Clouds'), /The sky is hidden \(fog or similar\)\. You can see straight up 200 ft \(61 m\): this counts as the ceiling\./);
    assert.match(lines(d('26008KT 0200 FG VV///'), 'Clouds'), /vertical visibility could not be measured/);
  });

  it('tells the ways of saying "no cloud" apart', () => {
    assert.match(lines(d('26008KT 9999 SKC'), 'Clouds'), /^Sky clear: no cloud\.$/);
    assert.match(lines(d('26008KT 10SM CLR'), 'Clouds'), /^Clear: no cloud was seen below the height .*\(12,000 ft at US stations\)\.$/);
    assert.match(lines(d('26008KT 9999 NSC'), 'Clouds'), /^No significant cloud: none below 5,000 ft and no thunderstorm cloud\.$/);
    assert.match(lines(d('AUTO 26008KT 9999 NCD'), 'Clouds'), /^No cloud detected \(automatic station\)\.$/);
  });

  it('says so when cloud was not reported', () => {
    assert.match(lines(d('AUTO 26008KT 9999 //////'), 'Clouds'), /Cloud was not reported/);
    assert.match(lines(d('26008KT 9999 BKN///'), 'Clouds'), /^Broken cloud \(5 to 7 eighths\) at a height that was not reported\.$/);
  });
});

describe('temperature, humidity and pressure', () => {
  it('reads temperature and dew point in Celsius, with Fahrenheit beside them', () => {
    const l = lines(d('26008KT 9999 NSC 15/08 Q1013'), 'Temperature');
    assert.match(l, /Temperature 15°C \(59°F\)\./);
    assert.match(l, /Dew point 8°C \(46°F\)\./);
  });

  it('reads M as minus', () => {
    const l = lines(d('26008KT 9999 NSC M05/M07 Q1013'), 'Temperature');
    assert.match(l, /Temperature -5°C \(23°F\)\./);
    assert.match(l, /Dew point -7°C \(19°F\)\./);
    assert.match(lines(d('26008KT 9999 NSC 00/M01 Q1013'), 'Temperature'), /Temperature 0°C \(32°F\)\.\nDew point -1°C/);
  });

  it('copes with a missing dew point or temperature', () => {
    assert.equal(lines(d('26008KT 10SM CLR 02/ A3000'), 'Temperature'), 'Temperature 2°C (36°F).');
    assert.equal(lines(d('26008KT 9999 NSC 10/// Q1013'), 'Temperature'), 'Temperature 10°C (50°F).');
    assert.equal(lines(d('26008KT 9999 NSC ///03 Q1013'), 'Temperature'), 'Dew point 3°C (37°F).');
    assert.equal(lines(d('26008KT 9999 NSC ///// Q1013'), 'Temperature'), 'Temperature was not reported.');
  });

  it('gives the humidity, and says so when the air could produce fog', () => {
    assert.match(lines(d('26008KT 9999 NSC 08/01 Q1013'), 'Temperature'), /Humidity about 61%\.$/);
    assert.match(lines(d('26008KT 9999 NSC 12/11 Q1013'), 'Temperature'), /very close, so fog or low cloud can form easily/);
    assert.match(lines(d('26008KT 9999 NSC 10/08 Q1013'), 'Temperature'), /very close, so fog or low cloud can form easily/, 'two degrees apart still counts');
    assert.doesNotMatch(lines(d('26008KT 9999 NSC 11/08 Q1013'), 'Temperature'), /fog/, 'three degrees apart does not');
    assert.doesNotMatch(lines(d('26008KT 9999 NSC 20/05 Q1013'), 'Temperature'), /fog/);
  });

  it('uses the exact figures from a US remarks group when there is one', () => {
    const l = lines(d('26008KT 10SM FEW028 08/01 A3039 RMK SLP291 T00830011'), 'Temperature');
    assert.match(l, /Temperature 8\.3°C \(47°F\)\./);
    assert.match(l, /Dew point 1\.1°C \(34°F\)\./);
    const neg = lines(d('26008KT 10SM FEW028 02/M01 A3052 RMK T00221011'), 'Temperature');
    assert.match(neg, /Temperature 2\.2°C/);
    assert.match(neg, /Dew point -1\.1°C/);
  });

  it('warns about ice at or below freezing when there is cloud or weather', () => {
    assert.match(lines(d('26008KT 4000 -SN BKN010 M01/M03 Q1013'), 'Temperature'), /At or below freezing: watch for ice\./);
    assert.doesNotMatch(lines(d('26008KT 9999 NSC M01/M03 Q1013'), 'Temperature'), /ice/);
  });

  it('computes humidity as the Magnus formula does', () => {
    assert.equal(Math.round(relativeHumidity(20, 20)), 100);
    assert.equal(Math.round(relativeHumidity(8, 1)), 61);
    assert.equal(Math.round(relativeHumidity(25, 19)), 69);
    assert.ok(relativeHumidity(10, 12) <= 100, 'never over 100');
  });

  it('reads Q as hectopascals and says the inches beside it', () => {
    assert.match(lines(d('26008KT 9999 NSC 08/01 Q1013'), 'Pressure'), /^1013 hPa \(29\.91 inHg\)\. This is the QNH/);
    assert.match(lines(d('26008KT 9999 NSC 08/01 Q0998'), 'Pressure'), /^998 hPa \(29\.47 inHg\)\./);
  });

  it('reads A as inches of mercury and says the hectopascals beside it', () => {
    assert.match(lines(d('26008KT 10SM FEW028 08/01 A2992'), 'Pressure'), /^29\.92 inHg \(1,013 hPa\)\. This is the altimeter setting/);
    assert.match(lines(d('26008KT 10SM FEW028 08/01 A3039'), 'Pressure'), /^30\.39 inHg \(1,029 hPa\)\./);
  });

  it('says so when the pressure was not reported', () => {
    assert.equal(lines(d('AUTO 26008KT 9999 NCD 08/01 Q////'), 'Pressure'), 'The pressure was not reported.');
  });

  it('knows a station that gives both Q and A, and a second one in the remarks', () => {
    const m = d('26008KT 9999 NSC 08/01 Q1025 A3027 RMK A3000');
    assert.match(lines(m, 'Pressure'), /^1025 hPa \(30\.27 inHg\)\. This is the QNH/);
    assert.match(lines(m, 'Pressure'), /\nThe same station also gave 30\.27 inHg \(1,025 hPa\)\.$/);
    assert.match(lines(m, 'Remarks'), /A second pressure reading: 30 inHg \(1,016 hPa\)/);
    assert.deepEqual(m.unread, []);
  });
});

describe('other groups', () => {
  it('reads wind shear on a runway, on all runways, and in the Canadian wording', () => {
    assert.match(lines(d('26008KT 9999 NSC 08/01 Q1013 WS R24L'), 'Other details'), /Wind shear \(a sudden change of wind\) was reported on runway 24L\./);
    assert.match(lines(d('26008KT 9999 NSC 08/01 Q1013 WS ALL RWY'), 'Other details'), /reported on all runways\./);
    assert.match(lines(d('26008KT 9999 NSC 08/01 A3000 WS RWY 09'), 'Other details'), /reported on runway 09\./);
  });

  it('reads the sea at a coastal station', () => {
    assert.match(lines(d('26008KT 9999 NSC 08/01 Q1013 W19/S4'), 'Other details'), /^Sea: water 19°C \(66°F\), sea state 4, moderate\.$/);
    assert.match(lines(d('26008KT 9999 NSC 08/01 Q1013 W12/H75'), 'Other details'), /^Sea: water 12°C \(54°F\), waves 7\.5 m high\.$/);
  });

  it('reads a runway state group: what covers it, how much, how deep, and the braking', () => {
    assert.equal(lines(d('26008KT 9999 NSC M02/M04 Q1013 R10R/290193'), 'Other details'), 'Condition of runway 10R: wet or with water patches, covering 51% to 100%, 1 mm deep, braking medium.');
    assert.equal(lines(d('26008KT 9999 NSC M02/M04 Q1013 R88/490250'), 'Other details'), 'Condition of all runways: dry snow, covering 51% to 100%, 2 mm deep, braking friction 0.5.');
  });

  it('reads the unusual values: unreliable braking, a closed runway, and deep deposits', () => {
    assert.match(lines(d('26008KT 9999 NSC M02/M04 Q1013 R24/49//99'), 'Other details'), /^Condition of runway 24: dry snow, covering 51% to 100%, braking figures unreliable\.$/);
    assert.match(lines(d('26008KT 9999 NSC M02/M04 Q1013 R24/4/9999'), 'Other details'), /dry snow, runway not usable, braking figures unreliable/);
    assert.match(lines(d('26008KT 9999 NSC M02/M04 Q1013 R24/499295'), 'Other details'), /10 cm deep, braking good/);
    assert.match(lines(d('26008KT 9999 NSC M02/M04 Q1013 R24/499595'), 'Other details'), /25 cm deep/);
    assert.match(lines(d('26008KT 9999 NSC M02/M04 Q1013 R24/499895'), 'Other details'), /40 cm deep or more/);
    assert.match(lines(d('26008KT 9999 NSC M02/M04 Q1013 R24/490000'), 'Other details'), /under 1 mm deep, braking friction 0\.$/);
    assert.match(lines(d('26008KT 9999 NSC M02/M04 Q1013 R24///////'), 'Other details'), /deposit not reported/);
  });

  it('says "the same runways as the last report" for 99, and reads the older 8-digit form after the pressure', () => {
    assert.match(lines(d('26008KT 9999 NSC M02/M04 Q1013 R99/290193'), 'Other details'), /^Condition of the same runways as the last report: /);
    assert.match(lines(d('26008KT 9999 NSC M02/M04 Q1013 10290193'), 'Other details'), /^Condition of runway 10: wet or with water patches/);
    assert.match(lines(d('26008KT 9999 NSC M02/M04 Q1013 74290193'), 'Other details'), /^Condition of runway 24R: /, 'in the 8-digit form 74 is 24 right');
  });

  it('says a runway has been cleared (CLRD), with its braking, and that the airport is closed by snow (SNOCLO)', () => {
    assert.equal(lines(d('26008KT 9999 NSC M02/M04 Q1013 R24L/CLRD62'), 'Other details'), 'Runway 24L has been cleared of its contamination, braking friction 0.62.');
    assert.equal(lines(d('26008KT 9999 NSC M02/M04 Q1013 R24L/CLRD//'), 'Other details'), 'Runway 24L has been cleared of its contamination.');
    assert.equal(lines(d('26008KT 9999 NSC M02/M04 Q1013 SNOCLO'), 'Other details'), 'The airport is closed because of snow (SNOCLO).');
  });

  it('reads military colour states, with what each needs, and BLACK', () => {
    assert.match(lines(d('26008KT 9999 NSC 08/01 Q1013 BLU'), 'Other details'), /^BLU \(military colour state\): visibility at least 8 km and cloud base at least 2,500 ft\.$/);
    assert.match(lines(d('26008KT 9999 NSC 08/01 Q1013 YLO1'), 'Other details'), /^YLO1 .*2\.5 km.*500 ft/);
    assert.match(lines(d('26008KT 9999 NSC 08/01 Q1013 RED'), 'Other details'), /under 800 m or cloud base under 200 ft/);
    assert.match(lines(d('26008KT 9999 NSC 08/01 Q1013 BLACKWHT'), 'Other details'), /^BLACK: the runway is unusable for a reason other than weather\. WHT/);
  });
});

describe('what to expect (the trend)', () => {
  it('says nothing is expected to change (NOSIG)', () => {
    assert.equal(lines(d('26008KT 9999 NSC 08/01 Q1013 NOSIG'), 'Next two hours'), 'No significant change is expected in the next 2 hours.');
  });

  it('reads a gradual change with its times', () => {
    assert.equal(lines(d('26008KT 9999 NSC 08/01 Q1013 BECMG FM1100 25035G50KT 6000 NSW NSC'), 'Next two hours'), 'Gradually changing from 11:00 UTC: From the west-south-west (250°), at 35 knots (65 km/h), gusting to 50 knots (93 km/h). Visibility 6 km (3.7 miles). No significant weather. No significant cloud.');
  });

  it('reads a temporary change, until a time', () => {
    assert.equal(lines(d('26008KT 9999 NSC 08/01 Q1013 TEMPO TL0430 TSRA'), 'Next two hours'), 'Temporarily until 04:30 UTC: Thunderstorm with moderate rain.');
    assert.match(lines(d('26008KT 9999 NSC 08/01 Q1013 TEMPO FM1200 TL1400 4000 RA BKN010'), 'Next two hours'), /^Temporarily from 12:00 UTC until 14:00 UTC: Visibility 4 km \(2\.5 miles\)\. Moderate rain\. Broken cloud .* at 1,000 ft/);
    assert.match(lines(d('26008KT 9999 NSC 08/01 Q1013 BECMG AT1300 CAVOK'), 'Next two hours'), /^Gradually changing at 13:00 UTC: CAVOK/);
  });

  it('reads more than one change', () => {
    const l = lines(d('26008KT 9999 NSC 08/01 Q1013 BECMG 3000 TEMPO 1500 FG'), 'Next two hours').split('\n');
    assert.equal(l.length, 2);
    assert.match(l[0] as string, /^Gradually changing: Visibility 3 km/);
    assert.match(l[1] as string, /^Temporarily: Visibility 1\.5 km .*Fog\./);
  });

  it('keeps what it cannot read in brackets and reports it', () => {
    const m = d('26008KT 9999 NSC 08/01 Q1013 TEMPO WIBBLE');
    assert.match(lines(m, 'Next two hours'), /\(WIBBLE\)/);
    assert.ok(m.unread.includes('WIBBLE'));
  });

  it('has no section when there is no forecast', () => {
    assert.equal(lines(d('26008KT 9999 NSC 08/01 Q1013'), 'Next two hours'), '');
  });
});

describe('remarks (after RMK)', () => {
  const rmk = (text: string): DecodedMetar => d(`26008KT 10SM FEW028 08/01 A3039 RMK ${text}`);
  const remarks = (text: string): string => lines(rmk(text), 'Remarks');

  it('reads the kind of automatic station, and the maintenance flag', () => {
    assert.match(remarks('AO1'), /without a sensor that tells rain from snow \(AO1\)/);
    assert.match(remarks('AO2'), /can tell rain from snow \(AO2\)/);
    assert.match(remarks('AO2A'), /a person checking/);
    assert.match(remarks('AO2 $'), /needs maintenance/);
  });

  it('reads sea-level pressure with the leading 10 or 9 put back', () => {
    assert.match(remarks('SLP982'), /^Sea-level pressure 998\.2 hPa\.$/);
    assert.match(remarks('SLP045'), /^Sea-level pressure 1004\.5 hPa\.$/);
    assert.match(remarks('SLP265'), /^Sea-level pressure 1026\.5 hPa\.$/);
    assert.match(remarks('SLP134'), /^Sea-level pressure 1013\.4 hPa\.$/);
    assert.match(remarks('SLPNO'), /^Sea-level pressure was not available\./);
  });

  it('reads rain and snow amounts', () => {
    assert.match(remarks('P0009'), /^0\.09 in \(2\.3 mm\) of rain in the last hour\.$/);
    assert.match(remarks('P0000'), /^Under 0\.01 in \(a trace\) of rain in the last hour\.$/);
    assert.match(remarks('60217'), /^2\.17 in of precipitation in the last 3 or 6 hours\.$/);
    assert.match(remarks('70125'), /^1\.25 in of precipitation in the last 24 hours\.$/);
    assert.match(remarks('4/021'), /^Snow on the ground: 21 in deep\.$/);
  });

  it('reads highest and lowest temperatures, with the sign digit', () => {
    assert.match(remarks('10112'), /^Highest temperature in the last 6 hours: 11\.2°C/);
    assert.match(remarks('11021'), /^Highest temperature in the last 6 hours: -2\.1°C/);
    assert.match(remarks('21015'), /^Lowest temperature in the last 6 hours: -1\.5°C/);
    assert.match(remarks('401001015'), /^Highest and lowest temperature in the last 24 hours: 10°C \(50°F\) and -1\.5°C/);
  });

  it('reads the pressure change over three hours', () => {
    assert.match(remarks('52032'), /^Pressure over the last 3 hours: rising steadily, by 3\.2 hPa \(higher than 3 hours ago\)\.$/);
    assert.match(remarks('58015'), /falling, then steady|steady or rising, then falling/);
    assert.match(remarks('54000'), /steady, by 0 hPa\.$/);
    assert.match(remarks('57012'), /falling steadily, by 1\.2 hPa \(lower than 3 hours ago\)/);
  });

  it('reads the peak wind and a wind shift', () => {
    assert.match(remarks('PK WND 28045/1432'), /^Peak wind in the last hour: from 280° at 45 knots, at 14:32\.$/);
    assert.match(remarks('PK WND 28045/15'), /at 15 minutes past the hour\.$/);
    assert.match(remarks('WSHFT 30'), /^The wind shifted at 30 minutes past the hour\.$/);
    assert.match(remarks('WSHFT 1430 FROPA'), /^The wind shifted at 14:30, with a weather front passing\.$/);
  });

  it('reads the tower and surface visibility, with fractions', () => {
    assert.match(remarks('TWR VIS 1 1/2'), /^Visibility from the control tower: 1 1\/2 miles\.$/);
    assert.match(remarks('SFC VIS 1'), /^Visibility from the ground: 1 mile\.$/);
  });

  it('reads lightning with how often, what kind and where', () => {
    assert.match(remarks('OCNL LTGICCCCG OHD'), /^Occasional lightning \(within the cloud, cloud to cloud, cloud to ground\), overhead\.$/);
    assert.match(remarks('LTG DSNT W'), /^Some lightning, in the distance west\.$/);
    assert.match(remarks('FRQ LTGCG VC'), /^Frequent lightning \(cloud to ground\), in the vicinity\.$/);
  });

  it('reads where a thunderstorm or storm cloud is, and where it is heading', () => {
    assert.match(remarks('TS SE MOV NE'), /^Thunderstorm south-east, moving north-east\.$/);
    assert.match(remarks('CB DSNT S'), /^Thunderstorm cloud \(cumulonimbus\) in the distance south\.$/);
    assert.match(remarks('TCU W'), /^Towering cumulus west\.$/);
  });

  it('reads virga, and sensors that are out', () => {
    assert.match(remarks('VIRGA'), /^Virga: rain that evaporates before it reaches the ground\.$/);
    assert.match(remarks('RVRNO'), /^The runway visual range sensor is not working\.$/);
    assert.match(remarks('PWINO'), /present-weather sensor is not working/);
    assert.match(remarks('VISNO'), /visibility sensor is not working/);
    assert.match(remarks('CHINO'), /cloud-height sensor is not working/);
  });

  it('reads the Russian pressure at the airfield (QFE), for the airfield or one runway', () => {
    assert.match(remarks('QFE769/1025'), /^Pressure at the airfield \(QFE\): 769 mmHg \(1025 hPa\)\.$/);
    assert.match(remarks('R26L/QFE749/0998'), /^Pressure at the airfield \(QFE\) for runway 26L: 749 mmHg \(998 hPa\)\.$/);
    assert.match(remarks('QFE766'), /^Pressure at the airfield \(QFE\): 766 mmHg\.$/);
  });

  it('reads the Australian rainfall group', () => {
    assert.match(remarks('RF00.6/003.4'), /^Rain: 0\.6 mm in the last 10 minutes and 3\.4 mm since 09:00 local time\.$/);
  });

  it('reads the Canadian cloud-by-type group in eighths', () => {
    assert.match(remarks('SF5NS3'), /^Cloud by type \(eighths of the sky\): stratus fractus 5\/8, nimbostratus 3\/8\.$/);
    assert.match(remarks('CI1'), /cirrus 1\/8/);
  });

  it('reads colour states in the remarks, and a forecast of one', () => {
    assert.match(remarks('GRN TEMPO YLO1'), /^GRN \(military colour state\): visibility at least 3\.7 km and cloud base at least 700 ft\.\nColour state forecast, temporarily: YLO1 \(military colour state\): visibility at least 2\.5 km/);
  });

  it('hands back remarks it does not know, as written, instead of dropping them', () => {
    const m = rmk('AO2 CIG 005V010 FOO/BAR SLP291');
    assert.deepEqual(m.remarksUnread, ['CIG', '005V010', 'FOO/BAR']);
    assert.match(lines(m, 'Remarks'), /Sea-level pressure 1029\.1 hPa/);
  });

  it('makes a token safe before it can be shown', () => {
    const m = d('26008KT 9999 NSC 08/01 Q1013 RMK @everyone `x` <@123456789012345678>');
    for (const u of m.remarksUnread) assert.doesNotMatch(u, /[`@<>]/);
  });
});

describe('the US-style flying rating', () => {
  const cat = (vis: string, cloud: string) => d(`26008KT ${vis} ${cloud} 10/05 A3000`, 'KJFK 161350Z').category;

  it('is VFR with a ceiling above 3,000 ft and visibility above 5 miles', () => {
    assert.equal(cat('6SM', 'BKN032'), 'VFR');
    assert.equal(cat('10SM', 'FEW020'), 'VFR');
    assert.equal(cat('10SM', 'SKC'), 'VFR');
  });

  it('is MVFR from a ceiling of 3,000 ft or visibility of 5 miles, down to 1,000 ft or 3 miles', () => {
    assert.equal(cat('10SM', 'BKN030'), 'MVFR');
    assert.equal(cat('5SM', 'FEW030'), 'MVFR');
    assert.equal(cat('10SM', 'OVC010'), 'MVFR');
    assert.equal(cat('3SM', 'FEW030'), 'MVFR');
  });

  it('is IFR from a ceiling of 999 ft or visibility under 3 miles, down to 500 ft or 1 mile', () => {
    assert.equal(cat('10SM', 'BKN009'), 'IFR');
    assert.equal(cat('10SM', 'OVC005'), 'IFR');
    assert.equal(cat('2 3/4SM', 'FEW030'), 'IFR');
    assert.equal(cat('1SM', 'FEW030'), 'IFR');
  });

  it('is LIFR under 500 ft or under a mile', () => {
    assert.equal(cat('10SM', 'OVC004'), 'LIFR');
    assert.equal(cat('3/4SM', 'FEW030'), 'LIFR');
    assert.equal(cat('M1/4SM', 'FEW030'), 'LIFR');
  });

  it('goes by the worse of the two, and counts only broken and overcast cloud as a ceiling', () => {
    assert.equal(cat('2SM', 'BKN032'), 'IFR');
    assert.equal(cat('10SM', 'SCT005'), 'VFR', 'scattered cloud is not a ceiling');
    assert.equal(cat('10SM', 'FEW005 BKN020'), 'MVFR');
  });

  it('counts vertical visibility as the ceiling', () => {
    assert.equal(cat('1/4SM', 'VV002'), 'LIFR');
    assert.equal(d('26008KT 0400 FG VV004 08/07 Q1013').category, 'LIFR');
  });

  it('works from metres too (3 miles is 4,828 m, 5 miles 8,047 m, 1 mile 1,609 m), and CAVOK is VFR', () => {
    const m = (vis: string) => d(`26008KT ${vis} BKN040 08/01 Q1013`).category;
    assert.equal(m('9999'), 'VFR');
    assert.equal(m('8000'), 'MVFR', '8000 m is 4.97 miles');
    assert.equal(m('4900'), 'MVFR', '4900 m is 3.04 miles');
    assert.equal(m('4800'), 'IFR', '4800 m is 2.98 miles');
    assert.equal(m('1700'), 'IFR', '1700 m is 1.06 miles');
    assert.equal(m('1500'), 'LIFR', '1500 m is 0.93 of a mile');
    assert.equal(d('26008KT CAVOK 08/01 Q1013').category, 'VFR');
  });

  it('gives no rating without anything to rate', () => {
    assert.equal(d('26008KT 08/01 Q1013').category, null);
  });

  it('says where the names are in everyday use', () => {
    assert.equal(d('26008KT 10SM FEW020', 'KJFK 161350Z').usStyleRating, true);
    assert.equal(d('26008KT 10SM FEW020', 'CYYZ 161350Z').usStyleRating, true);
    assert.equal(d('26008KT 9999 FEW020', 'EGLL 161350Z').usStyleRating, false);
    assert.equal(d('26008KT 9999 FEW020', 'RJTT 161350Z').usStyleRating, false);
  });
});

describe('the summary', () => {
  it('is a sentence a beginner can read first', () => {
    assert.equal(d('26008KT 9999 NSC 08/01 Q1006 NOSIG').summary, 'Moderate wind from the west at 8 knots, very good visibility, no significant weather, no significant cloud, 8°C. Flying conditions by the US-style rating: VFR.');
    assert.equal(
      d('31018G28KT 1 1/2SM -RA BR BKN008 OVC015 09/08 A2992', 'KORD 161451Z').summary,
      'Strong wind from the north-west at 18 knots, gusting 28, moderate visibility, light rain and mist, cloud ceiling 800 ft, 9°C. Flying conditions by the US-style rating: IFR.',
    );
  });

  it('says CAVOK and calm', () => {
    assert.match(d('00000KT CAVOK 10/05 Q1013').summary, /^Calm wind, visibility 10 km or more, no significant weather, no significant cloud, 10°C\./);
  });

  it('puts metres per second in knots', () => {
    assert.match(d('24005MPS CAVOK 04/M02 Q1020').summary, /^Moderate wind from the west-south-west at 10 knots/);
  });
});

describe('whole reports as they are sent around the world', () => {
  const sections = (m: DecodedMetar): string[] => m.sections.map((s) => s.title);

  it('a London report (metres, Q, NOSIG)', () => {
    const m = decodeMetar('EGLL 161350Z COR 26008KT 230V290 9999 NSC 08/01 Q1006 NOSIG', { now: NOW })!;
    assert.deepEqual(m.unread, []);
    assert.deepEqual(m.remarksUnread, []);
    assert.deepEqual(sections(m), ['The report', 'Wind', 'Visibility', 'Weather', 'Clouds', 'Temperature', 'Pressure', 'Next two hours']);
  });

  it('a New York report (statute miles, A, US remarks)', () => {
    const m = decodeMetar('KJFK 161351Z 35011KT 10SM FEW028 08/01 A3039 RMK SLP291 T00830011', { now: NOW })!;
    assert.deepEqual(m.unread, []);
    assert.deepEqual(m.remarksUnread, []);
    assert.match(lines(m, 'Visibility'), /10 statute miles/);
    assert.match(lines(m, 'Pressure'), /30\.39 inHg/);
  });

  it('a Moscow report (metres per second, runway state, QFE)', () => {
    const m = decodeMetar('UUEE 161430Z 24005MPS 9999 -SHRA BKN020CB 05/02 Q1010 R24L/290050 NOSIG RMK QFE749/0998', { now: NOW })!;
    assert.deepEqual(m.unread, []);
    assert.deepEqual(m.remarksUnread, []);
    assert.match(lines(m, 'Wind'), /5 m\/s \(10 knots\)/);
    assert.match(lines(m, 'Other details'), /Condition of runway 24L/);
  });

  it('a Sydney automatic report (// for what the sensors could not tell)', () => {
    const m = decodeMetar('YSSY 161400Z AUTO 26007KT 9999 // NCD 16/12 Q1018', { now: NOW })!;
    assert.deepEqual(m.unread, []);
    assert.equal(m.auto, true);
  });

  it('a Mexican report (US units with extra remarks)', () => {
    const m = decodeMetar('MMMX 161355Z 04008KT 8SM FEW050 SCT100 22/05 A3041 RMK 8/002 ISOL SC HZY', { now: NOW })!;
    assert.match(lines(m, 'Visibility'), /8 statute miles/);
    assert.ok(m.remarksUnread.length > 0, 'what it does not know is handed back');
    assert.ok(m.remarksUnread.includes('ISOL'));
  });

  it('a report with the US pieces and metres both (a US forces base overseas)', () => {
    const m = decodeMetar('ETAR 161355Z 24010KT 9999 FEW040 12/06 A2995 RMK AO2 SLP140 T01220061', { now: NOW })!;
    assert.match(lines(m, 'Visibility'), /10 km or more/);
    assert.match(lines(m, 'Pressure'), /29\.95 inHg/);
    assert.match(lines(m, 'Remarks'), /Sea-level pressure 1014 hPa/);
  });

  it('a Canadian report (statute miles, CCA, cloud by type)', () => {
    const m = decodeMetar('CYQX 161400Z CCA 27015G25KT 15SM -SN SCT015 BKN025 M02/M04 A2990 RMK SC3SC2 SLP120', { now: NOW })!;
    assert.equal(m.corrected, true);
    assert.match(lines(m, 'Visibility'), /15 statute miles/);
    assert.match(lines(m, 'Remarks'), /stratocumulus 3\/8, stratocumulus 2\/8/);
  });

  it('a report in several lines and with the end mark', () => {
    const m = decodeMetar('METAR EGLL 161350Z\n26008KT 9999\nNSC 08/01 Q1006=', { now: NOW })!;
    assert.equal(m.raw, 'METAR EGLL 161350Z 26008KT 9999 NSC 08/01 Q1006');
    assert.equal(m.station, 'EGLL');
  });

  it('hands back what it does not understand in the main report instead of failing', () => {
    const m = decodeMetar('EGLL 161350Z 26008KT 9999 WIBBLE NSC 08/01 Q1006 XYZZY', { now: NOW })!;
    assert.deepEqual(m.unread, ['WIBBLE', 'XYZZY']);
    assert.match(lines(m, 'Wind'), /^From the west/);
  });

  it('copes with a report that is only a wind and a time', () => {
    const m = decodeMetar('EGLL 161350Z 26008KT', { now: NOW })!;
    assert.deepEqual(m.sections.map((s) => s.title), ['The report', 'Wind', 'Weather']);
    assert.equal(m.category, null);
  });

  it('never fails on odd input, whatever it is', () => {
    for (const text of ['EGLL 161350Z ' + 'X'.repeat(5000), 'EGLL 161350Z ' + '9999 '.repeat(300), 'EGLL 161350Z RMK ' + 'A '.repeat(400), 'EGLL 161350Z \u0000\u0007 //// //// ////', 'EGLL 161350Z BECMG BECMG TEMPO TEMPO NOSIG RMK RMK']) {
      assert.doesNotThrow(() => decodeMetar(text, { now: NOW }), text.slice(0, 40));
    }
  });
});
