import type { FlownFlight, Panel, Store } from '../db/store.js';
import { plainText, routeText, truncate } from '../util/format.js';
import { silentLogger, type Logger } from '../util/log.js';
import { FIRE_KEVIN, REHIRE_KEVIN } from './dailyNote.js';
import { IMPLAUSIBLE_FPM, lossForTier, readLanding, safetyNotice, safetyPolicyOf, type SafetyPolicy } from './safetyPay.js';
import { appendPenaltyCsv, flightNumberOf, penaltyMessage, type ManagerLookup, type PenaltyReport } from './safetyReport.js';
import { appNow } from '../util/clock.js';

export { IMPLAUSIBLE_FPM };

/**
 * A light-hearted message to a pilot whose landing FsHub recorded as very hard, written in the voice of the airline's scheduler.
 * A normal landing, or a firm one, never gets anything. The message is one of the optional ones (see notices.ts): a pilot can switch it off
 * with `notifications`, or by replying `fire kevin` to it (and back on with `rehire kevin`), the same way as the scheduler's other notes.
 */

const HOUR = 3_600_000;
const DAY = 24 * HOUR;

/*
 * Where the lines are, as a descent rate in feet per minute (FsHub records it as a negative number):
 * - 600 fpm is 10 feet a second, the descent velocity airliners are certified to take at their design landing weight (14 CFR 25.473 and
 *   EASA CS-25.473), and what Boeing itself calls a hard landing. Anything gentler, "firm" included, is never remarked on.
 * - 800 fpm is a little above the 720 fpm (12 ft/s) the landing gear is tested to survive; the worst landing in the UK AAIB's A319 report
 *   (714 fpm) needed all three gear legs replaced.
 * - 1,000 fpm is where real airliners have been damaged (a 747-400 at 1,070, an A320 at about 1,200).
 * These are lines for a joke, not a verdict: a flight simulator's reading is noisier than an aeroplane's, and FsHub does not say how it measures.
 */
/** A landing at least this hard is remarked on. */
export const HARD_FPM = 600;
/** A landing at least this hard is called out in stronger words. */
export const VERY_HARD_FPM = 800;
/** The strongest words are kept for a landing at least this hard. */
export const SEVERE_FPM = 1000;

/** Only a landing this recent is remarked on, so reading a week of flights for the first time does not send a week of jokes. */
export const FRESH_FOR_MS = 3 * HOUR;
/** A safety notice is about pay, so it is still sent for a landing this old (a bot that was off for a while catches up), and no older. A penalty is reported to managers for as long. */
export const SAFETY_FRESH_FOR_MS = 3 * DAY;
/** A pilot gets at most one remark in this long, so a bad evening is not a string of messages. */
export const QUIET_AFTER_MS = 6 * HOUR;
/** A flight that was dealt with without a message going out is remembered this long (one that was told about is kept). */
const KEEP_MS = 30 * DAY;

export type Severity = 'hard' | 'very-hard' | 'severe';

/** How hard a landing was, from FsHub's rate (negative for a descent): null for a landing that was not hard, or a rate that cannot be right. */
export function severityOf(rate: number | null | undefined): Severity | null {
  if (rate === null || rate === undefined || !Number.isFinite(rate)) return null;
  const fpm = Math.abs(rate);
  if (rate > 0 || fpm < HARD_FPM || fpm > IMPLAUSIBLE_FPM) return null;
  if (fpm >= SEVERE_FPM) return 'severe';
  if (fpm >= VERY_HARD_FPM) return 'very-hard';
  return 'hard';
}

/**
 * The remarks. `{rate}` is the descent rate in feet per minute, `{route}` where it was flying, `{aircraft}` what it was in, and `{airline}`
 * the airline's name. Each is short, kind underneath, and clean: the landing is the butt of the joke, never the pilot.
 */
export const REMARKS: Record<Severity, readonly string[]> = {
  hard: [
    "FsHub says you touched down at {rate} fpm in {route}. That isn't a landing, that's a firm handshake with the runway. The runway is fine. It's seen worse. Mostly from us.",
    "I was holding my coffee when I read {rate} fpm. I'm not saying I'm holding a lot less coffee now. I'm saying the carpet knows.",
    "{rate} fpm, {route}. The passengers applauded, which is nice, although I think some of them were checking they still had teeth.",
    "A {rate} fpm touchdown. I'd call it a bold landing, but I've been told 'bold' is not a phrase insurers like to hear.",
    "Noted: {route}, {rate} fpm. I've filed it under 'arrived', which is the only box on my form that matters. Well done, Captain. Mostly.",
    "Congratulations on {rate} fpm. The runway wanted me to pass on that it has felt things today.",
    "I schedule the flights, I do not fly the flights, and after seeing {rate} fpm I'd like to keep it that way. Thank you for flying so I don't have to.",
    "You landed at {rate} fpm. Somewhere, a stapler on my desk jumped. I'm calling it a standing ovation.",
    "That {rate} fpm in the {aircraft} was a landing in the way a trampoline is a mattress. Safe, though. Probably.",
    "FsHub has your landing at {rate} fpm. I looked at it for a long time. Then I had a break. Then I looked at it again.",
    "{airline} is held together with spreadsheets, tape and spite, and your {rate} fpm just tested the tape. The tape held. The spite is wobbling.",
  ],
  'very-hard': [
    "{rate} fpm. FsHub didn't say 'landing', it said a number, and the number needed a minute. I've put the kettle on. Well, the coffee machine. It's broken, so I just stared at it.",
    "The last Kevin was fired over a {rate} fpm incident. It wasn't this one, but I wanted you to know that in this company, we remember.",
    "{rate} fpm into {route}. The {aircraft} would like a word, the runway would like an apology, and I would like to go and lie down.",
    "I'm wearing my shirt and I still don't feel dressed for {rate} fpm. The hold music on the passenger complaints line has started playing itself.",
    "That's {rate} fpm. The good news is you're on the ground. The bad news is you're on it a bit harder than we planned. The planning was mine, so I'll take the blame, and you take the landing.",
    "A {rate} fpm landing. In my line of work, that's what we call 'a lot of spreadsheets to apologise with'. Fly safe, Captain. Maybe slow down the last twenty feet.",
    "I've had a look at {rate} fpm in {route}. Everyone is fine. The coffee machine is not, but that was already like that.",
    "{rate} fpm. If this was a real airline, someone would be filling in a form. Because it's us, I'm filling in a biscuit order.",
  ],
  severe: [
    "{rate} fpm. FsHub has a number for it and I have a feeling for it. The feeling is 'sit down'. I'm sitting down. Please land softer, or at least with some warning.",
    "I've just read {rate} fpm in {route} and I'd like to formally declare it a controlled arrival with a very short final. The previous Kevin would've called it something else, and then been fired for it.",
    "{rate} fpm. The {aircraft} is fine, the runway is fine, I am not fine, and my shirt is somehow wrinkled. Thank you for the excitement.",
    "At {rate} fpm that wasn't a touchdown, it was an arrival with opinions. Everyone walked off. I'm proud. Please also be gentle with us next time.",
    "FsHub says {rate} fpm. I've checked three times. The first two were just so I could say 'I checked'. I'm told this one counts as a landing. It also counts as a story, and you'll be hearing it at the Christmas party.",
    "I'd like to report that {route} ended with the ground arriving very quickly and very certainly. {rate} fpm. Passengers: shaken. Pilot: legend. Scheduler: needs a break. (It's break number four.)",
  ],
};

/**
 * When an airline links pay to landing safety, a hard landing gets the airline's own safety notice first, and then the remark, which has to follow something
 * stern and a fine. So it says it is the unofficial message, before the joke, and sends the pilot off kindly after it.
 */
export const AFTER_NOTICE_INTROS: readonly string[] = [
  'The serious message you just had was written by someone in a tie. This one is written by someone holding a mug.',
  'Head office has had its say. I get the unofficial bit, which comes with sympathy and no spreadsheet.',
  "I'm only allowed to be funny once the stern note has gone out. The stern note has gone out.",
  "You've had the official letter. Here's the unofficial one: nobody is cross with you, they're just very good at maths.",
  'Right, the paperwork is done. Pencils down, and a deep breath.',
];
export const AFTER_NOTICE_CLOSERS: readonly string[] = [
  'Everyone has one of these in the logbook. Mine is in a drawer, under the stapler that jumped.',
  "Chin up, Captain. The runway has forgiven you. It's the accountants who need a biscuit.",
  "The next one will be a greaser. I believe in you, and I'm not even paid to.",
  'You still got everyone on the ground, which is the bit that counts. Fly safe.',
  'The fine is the airline\'s. The sympathy is mine, and it\'s free.',
  "Tomorrow is a new flight and a new runway. Mind the paint.",
];

/** The heading and signature of a remark, as with the scheduler's other notes. */
const HEADING = '☕ **Kevin, Scheduler**';
const SIGNATURE = '— Kevin';
const OFF_LINE = "_Reply `fire kevin` to make me stop commenting on your landings, or DM me `notifications`. (It won't be the first time I've been fired.)_";

export interface RemarkSubject {
  rate: number;
  route: string;
  aircraft: string | null;
  airline: string | null;
  flightId: number;
  /** The airline's own safety notice has just gone out for this landing (safety pay is on), so the remark is gentler. */
  afterNotice?: boolean;
}

/** The remark for a landing: which words, chosen by the flight so the same flight always gets the same ones, and who it is from. */
export function composeRemark(s: RemarkSubject): string {
  const severity = severityOf(s.rate) ?? 'hard';
  const list = REMARKS[severity];
  const words = list[Math.abs(s.flightId) % list.length] as string;
  const text = words
    .split('{rate}').join(String(Math.abs(Math.round(s.rate))))
    .split('{route}').join(s.route)
    .split('{aircraft}').join(s.aircraft ? plainText(truncate(s.aircraft, 20)) : 'aircraft')
    .split('{airline}').join(s.airline ? plainText(truncate(s.airline, 60)) : 'the airline');
  if (s.afterNotice) {
    const id = Math.abs(s.flightId);
    const intro = AFTER_NOTICE_INTROS[id % AFTER_NOTICE_INTROS.length] as string;
    const closer = AFTER_NOTICE_CLOSERS[Math.floor(id / 7) % AFTER_NOTICE_CLOSERS.length] as string;
    return [HEADING, intro, text, closer, SIGNATURE, OFF_LINE].join('\n');
  }
  return [HEADING, text, SIGNATURE, OFF_LINE].join('\n');
}

/* ------------------------------------------------------------------ the switch: fire kevin / rehire kevin */

/**
 * `fire kevin` in a DM turns the remarks about this person's landings off; `rehire kevin` turns them on again. Returns what to say back,
 * or null when the text is neither. It is the same switch as `notifications` (the Hard-landing remarks one).
 */
export function switchRemarks(store: Store, discordId: string, text: string, now: number): string | null {
  const wasOn = store.wantsNotice(discordId, 'landing');
  if (FIRE_KEVIN.test(text)) {
    if (!wasOn) return "I'm already fired. Please see the previous Kevin for details.";
    store.setNotice(discordId, 'landing', false, now);
    return "Understood. I'll clear my desk, and I'll keep my opinions on your landings to myself. (Reply `rehire kevin` if you ever want them back. Everyone does, eventually.)";
  }
  if (REHIRE_KEVIN.test(text)) {
    if (wasOn) return "I'm already on the payroll, unfortunately. Your landings are still my business.";
    store.setNotice(discordId, 'landing', true, now);
    return 'New Kevin reporting for duty. Please ignore anything the last Kevin told you about your landings, although he was probably right.';
  }
  return null;
}

/* ------------------------------------------------------------------ the check */

/** Sends one person a private message. Returns true if it went out. */
export type SendRemark = (discordId: string, content: string) => Promise<boolean>;

/**
 * Looks at the flights FsHub has just shown and, for each very hard landing by a pilot the bot can name, sends the remark once.
 *
 * - Only a flight that landed recently counts, and only once (it is remembered, whether or not a message went out).
 * - The pilot must be a known Discord account: the airline's roster says so, or they typed the ID and no roster says it is someone else's.
 *   An ID shared by two accounts is nobody's, and nothing is sent.
 * - Someone who has switched the remarks off is not sent one; someone who got one lately is not sent another straight away.
 *
 * For an airline that has landing safety pay on (`/setup safety-pay`) the same look does more, and does it first: a landing that reaches a tier is
 * answered with the airline's safety notice to the pilot, and one that cuts pay (Tier 2 or 3) is also written to the CSV and reported to the managers.
 * The light-hearted remark, for the landings hard enough to get one, comes after the notice, in gentler words.
 */
export class HardLandings {
  private readonly now: () => number;
  private readonly log: Logger;
  private readonly airlineName: (panel: Panel) => string;
  private readonly managers: ManagerLookup | null;
  private readonly nameOf: ((discordId: string) => Promise<string | null>) | null;
  private readonly csvFile: string | null;

  constructor(
    private readonly store: Store,
    private readonly send: SendRemark,
    opts: {
      now?: () => number;
      logger?: Logger;
      airlineName?: (panel: Panel) => string;
      /** Who a penalty is reported to (the airline's managers). Without it nobody is told. */
      managers?: ManagerLookup;
      /** The Discord name of an account, for the report. */
      nameOf?: (discordId: string) => Promise<string | null>;
      /** The CSV file penalties are added to. Without it none is kept. */
      csvFile?: string | null;
    } = {},
  ) {
    this.now = opts.now ?? appNow;
    this.log = opts.logger ?? silentLogger;
    this.airlineName = opts.airlineName ?? ((p) => p.airlineName);
    this.managers = opts.managers ?? null;
    this.nameOf = opts.nameOf ?? null;
    this.csvFile = opts.csvFile ?? null;
  }

  /** The one Discord account a FsHub pilot ID belongs to, or null if it is nobody's or more than one person's. */
  private ownerOf(fshubId: number): string | null {
    const accounts = this.store.discordAccountsForFshubId(fshubId);
    const roster = accounts.filter((a) => a.source === 'roster');
    const claimed = roster.length > 0 ? roster : accounts;
    return claimed.length === 1 ? (claimed[0] as { discordId: string }).discordId : null;
  }

  /**
   * What an airline with safety pay on does about one landing that reaches a tier (Tier 1, 2 or 3): the pilot is sent the safety notice, whatever their
   * `notifications` say (it is about their pay, so it is not one of the optional messages) and with no pause after an earlier one. A Tier 2 or Tier 3 landing,
   * which cuts the pay, is also written to the CSV and reported to the managers. Each step is done once per flight; a step that did not work (the CSV
   * was open in another program) is tried again the next time the flight is seen. Only a landing since safety pay was turned on, and recent enough, counts.
   * Returns how many private messages went out (to the pilot and the managers).
   */
  private async safety(panel: Panel, policy: SafetyPolicy, f: FlownFlight, now: number): Promise<number> {
    const read = readLanding(f.landingRate);
    if (read.kind !== 'ok' || read.tier === null) return 0;
    if (f.arrivedAt < policy.since || now - f.arrivedAt > SAFETY_FRESH_FOR_MS || f.arrivedAt > now + HOUR) return 0;
    const penalty = read.tier >= 2;
    const prior = this.store.getSafetyLanding(panel.id, f.flightId) ?? { told: null, logged: false, reported: false };
    const owner = this.ownerOf(f.pilotId);
    const wantsLog = penalty && this.csvFile !== null && !prior.logged;
    const wantsReport = penalty && this.managers !== null && !prior.reported;
    const wantsNotice = prior.told === null && owner !== null;
    if (!wantsNotice && !wantsLog && !wantsReport) return 0;

    let sent = 0;
    let told = prior.told;
    if (wantsNotice && owner !== null) {
      let ok = false;
      try {
        ok = await this.send(owner, safetyNotice({ tier: read.tier, fpm: read.fpm, route: routeText([{ dep: f.dep, arr: f.arr }]), airline: this.airlineName(panel), minimumLoss: lossForTier(policy, read.tier) }));
      } catch (e) {
        this.log.debug(`Could not send a safety notice to ${owner}`, e);
      }
      // A notice that could not be delivered (closed DMs) is not tried again; the pay is cut in the sheet all the same.
      told = ok ? 'sent' : 'closed';
      this.store.saveSafetyLanding(panel.id, f.flightId, { told }, now);
      if (ok) {
        sent++;
        this.log.info(`Sent a Tier ${read.tier} safety notice (flight ${f.flightId})`);
      }
    }
    if (!wantsLog && !wantsReport) return sent;

    // The report: who, which flight, where, when, how hard. The CSV first, so the message to the managers can say whether it was added.
    const report = await this.reportOf(panel, f, read.tier as 2 | 3, read.fpm, owner, now);
    let logged = prior.logged;
    if (wantsLog && this.csvFile !== null) {
      try {
        appendPenaltyCsv(this.csvFile, report);
        logged = true;
        this.store.saveSafetyLanding(panel.id, f.flightId, { logged: true }, now);
      } catch (e) {
        this.log.warn(`Could not add flight ${f.flightId} to the hard-landings CSV (is it open in another program?)`, e);
      }
    }
    if (wantsReport && this.managers !== null) {
      const text = penaltyMessage(report, owner === null ? null : told === 'sent', this.csvFile === null ? null : logged);
      let people: string[] = [];
      try {
        people = await this.managers(panel);
      } catch (e) {
        this.log.debug('Could not work out who to report a hard landing to', e);
      }
      for (const id of people) {
        try {
          if (await this.send(id, text)) sent++;
        } catch (e) {
          this.log.debug(`Could not send a hard-landing report to ${id}`, e);
        }
      }
      // Once per flight, whoever could be reached: a report that arrives late is no use, and the CSV has the row.
      this.store.saveSafetyLanding(panel.id, f.flightId, { reported: true }, now);
    }
    return sent;
  }

  /** The facts of a penalty landing, for the managers and the CSV. */
  private async reportOf(panel: Panel, f: FlownFlight, tier: 2 | 3, fpm: number, owner: string | null, now: number): Promise<PenaltyReport> {
    let discordName: string | null = null;
    if (owner !== null && this.nameOf) {
      try {
        discordName = (await this.nameOf(owner))?.trim() || null;
      } catch {
        discordName = null;
      }
    }
    const fsName = f.pilotName?.trim() || null;
    const pilotName = discordName ?? fsName ?? `FsHub pilot ${f.pilotId}`;
    return {
      airline: this.airlineName(panel),
      tier,
      rate: -fpm,
      landedAt: f.arrivedAt,
      pilotName,
      fshubId: f.pilotId,
      // FsHub's name for the pilot, only when it is not the name already given.
      fshubUsername: fsName !== null && fsName.toLowerCase() !== pilotName.toLowerCase() ? fsName : null,
      flightNumber: flightNumberOf(this.store, panel, f, now),
      dep: f.dep,
      arr: f.arr,
      flightId: f.flightId,
    };
  }

  /** Deal with these flights, which have just been read for this panel. Never throws. Returns how many messages went out. */
  async check(panel: Panel, flights: FlownFlight[]): Promise<number> {
    let sent = 0;
    try {
      const now = this.now();
      this.store.pruneLandingRemarks(now - KEEP_MS);
      this.store.pruneSafety(now - KEEP_MS);
      const policy = safetyPolicyOf(panel);
      for (const f of flights) {
        // An airline with safety pay on sends its own notice (and reports a penalty) before anything light-hearted.
        let afterNotice = false;
        if (policy) {
          sent += await this.safety(panel, policy, f, now);
          const read = readLanding(f.landingRate);
          afterNotice = read.kind === 'ok' && read.tier !== null && f.arrivedAt >= policy.since;
        }
        const severity = severityOf(f.landingRate);
        if (severity === null || f.landingRate === null || f.landingRate === undefined) continue;
        if (now - f.arrivedAt > FRESH_FOR_MS || f.arrivedAt > now + HOUR) continue;
        if (this.store.hasLandingRemark(f.flightId)) continue;
        const owner = this.ownerOf(f.pilotId);
        if (owner === null) continue;

        const last = this.store.lastLandingRemarkAt(owner);
        const wanted = this.store.wantsNotice(owner, 'landing');
        const tooSoon = last !== null && now - last < QUIET_AFTER_MS;
        let told = false;
        if (wanted && !tooSoon) {
          const content = composeRemark({
            rate: f.landingRate,
            route: routeText([{ dep: f.dep, arr: f.arr }]),
            aircraft: f.aircraftIcao,
            airline: this.airlineName(panel),
            flightId: f.flightId,
            afterNotice,
          });
          try {
            told = await this.send(owner, content);
          } catch (e) {
            this.log.debug(`Could not send a landing remark to ${owner}`, e);
          }
          // A message that could not be delivered (closed DMs) is not tried again: a joke that arrives late is not a joke.
        }
        this.store.recordLandingRemark(f.flightId, owner, Math.round(f.landingRate), told, now);
        if (told) {
          sent++;
          this.log.info(`Sent a remark about a ${severity} landing (flight ${f.flightId})`);
        }
      }
    } catch (e) {
      this.log.debug('Checking landings failed', e);
    }
    return sent;
  }
}
