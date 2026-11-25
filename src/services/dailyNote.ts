import type { Store } from '../db/store.js';
import { silentLogger, type Logger } from '../util/log.js';
import { appNow } from '../util/clock.js';

/**
 * A short, silly note to one person, once a day at a random time, written by the airline's scheduler ("Kevin") in the character the
 * community has given him. It does nothing unless a host sets a Discord user ID (settings.json or DAILY_NOTE_USER_ID); only that one
 * person is ever messaged, and they can turn it off by replying to a note (`fire kevin`) and back on with `rehire kevin`.
 *
 * The notes are all in good fun: coffee, breaks, shirts, overwork, pilots, and the lore of Kevins past.
 */

const MIN = 60_000;
const HOUR = 3_600_000;
const DAY = 24 * HOUR;
/** A note is not sent if the bot was off for longer than this past the planned time: a fresh time is planned instead. */
export const STALE_AFTER_MS = 3 * HOUR;
/** After a note that could not be delivered (closed direct messages), try again after this long, until the window ends. */
const RETRY_MS = 30 * MIN;

export type SendNote = (userId: string, content: string) => Promise<boolean>;

export interface DailyNoteOptions {
  store: Store;
  target: { userId: string; fromHour: number; toHour: number };
  send: SendNote;
  /** The airline's name for the note to use, where it can be found; null to say "the airline". */
  airlineName?: () => Promise<string | null>;
  /**
   * Whether the bot can reach the person at all (whether they share a server with it, since Discord does not let a bot message anyone
   * else). When it says no, no attempt is made and the note waits for tomorrow; when it fails, an attempt is made anyway.
   */
  reachable?: (userId: string) => Promise<boolean>;
  now?: () => number;
  /** 0 up to but not including 1; replaceable so tests are not random. */
  random?: () => number;
  logger?: Logger;
}

/** What the person types to turn the notes off, and on again. */
export const FIRE_KEVIN = /^\s*fire\s+kevin[\s.!?]*$/i;
export const REHIRE_KEVIN = /^\s*(?:re-?hire|hire)\s+kevin[\s.!?]*$/i;

const KV = { off: 'daily.off', gen: 'daily.gen', next: 'daily.next', last: 'daily.last', sent: 'daily.sent', bag: 'daily.bag' } as const;

const OFF_LINE = "_Reply `fire kevin` to fire me. (It won't be the first time.)_";
const OFF_LINE_LATER = '_Reply `fire kevin` to fire me too._';

/** The notes. `{airline}` becomes the airline's name. Keep each short, kind underneath, and clean. */
export const NOTES: readonly string[] = [
  // coffee
  "The coffee machine is empty again. I'm not saying it's your fault, Boss, I'm just saying you're the only one who's ever looked at it and walked away.",
  "Coffee level: 0%. Patience level: 0%. Flights scheduled: 14. One of those numbers is doing great and it isn't either of the others.",
  'I ran out of coffee at 09:00. At 09:01 I filed a safety report. At 09:02 I was told a safety report is not a coffee order. I have filed another.',
  'Squawk 7700. My cup is empty and nobody is answering my radio calls.',
  'Fun fact: my coffee has better fuel reserves than most of the flight plans I get sent.',
  "I've cut down on coffee. I now only drink it when it's hot, cold, or in a cup. Good week.",
  "Cleared for coffee. Report when the pot is full. (It won't be.)",
  "Brewed a fresh pot. It was gone before I'd put the lid back on. Someone in this airline is running on my caffeine and I will find them.",
  'I would like to formally request a second coffee machine. The one I have has started leaving me on read.',
  "If I'm not back in five minutes, assume I'm taxiing to the coffee machine. Gate: kitchen. Runway: also kitchen.",
  "Day 9 without decent coffee. I've started writing the schedule in a font that looks like it needs a refill.",
  "I made a coffee so strong that the schedule is currently flying itself. Please don't ask what that means for the pilots.",

  // breaks
  "Heads-up: I'm on my break. It's a 15-minute break. It started this morning.",
  'My break is now in its third hour. Technically still a 15-minute break, just a very slow one with a long taxi.',
  "I wrote this on my break. That's how dedicated I am. Please remember it at review time.",
  'Break log: 09:00 break. 10:30 break. 11:15 break to recover from the 10:30 break.',
  "I'm not late back from my break. The break is simply running long. Think of it as a scheduled non-schedule flight.",
  'A reminder that I am entitled to a lunch break, a tea break, a coffee break, and a break from the people interrupting my other breaks.',
  "I've been told I take too many breaks. I was told this on my break. Noted, and I will deal with it after the next one.",
  'I filed my flight plan to the break room: direct, FL000, no alternate, back never.',
  "Today's workload: one schedule, two meetings, and a power nap I have categorised as system maintenance.",
  "I'd work harder, Boss, but my chair reclines and my conscience doesn't.",

  // overworked
  'I schedule the flights. I do not fly the flights. I would like that engraved somewhere, because every day someone asks me to fly the flights.',
  "I've been at my desk since dawn building the schedule and I can confirm that not one pilot has read it.",
  'Working conditions at {airline}: one chair with a wobble, one coffee machine with a grudge, and one CEO with ideas.',
  "I do about 90% of the work around here. I can't prove it, because the other 10% is whatever you say you did.",
  "Today I answered the same question four times. The answer was 'read the panel'. The panel has been up for weeks.",
  'Scheduling report: I fixed a clash, the clash fixed itself into a different clash, and then I went for a walk.',
  "I'm holding {airline} together with spreadsheets, tape and spite. Mostly spite. Please do not check the tape.",
  "Overtime this week: all of it. Overtime pay: none. Mood: let's say it's right at the edge of the envelope.",
  'I have scheduled more flights this month than some pilots have flown in their entire careers. A medal would do. Or a biscuit.',
  "Do you know what's harder than flying a plane? Getting eleven pilots to agree on a Tuesday. I did it, and nobody noticed.",

  // pilots
  "A pilot asked me which runway to land on. I said 'the long, flat, grey one with the numbers on it'. He thanked me. I believe he landed on the taxiway.",
  "One of our pilots reserved a flight and then asked me what an A320 was. I said 'the one with wings'. He wrote it down.",
  "A pilot called a -700 fpm touchdown 'firm'. That isn't firm, that's a controlled crash with a customer survey.",
  "Pilot: 'Why is my flight delayed?' Me: 'You're still at the gate.' Pilot: 'Oh.'",
  "I put a pilot on a flight to Paris. He's very happy. He ended up in Paris, Texas. Technically I scheduled it correctly.",
  "Landing rate of the day: 'loud'. Fuel used: 'yes'. Passenger feedback: 'we have questions'.",
  "Our pilots are great. They're the reason aircraft are insured. And the reason my hair is how it is.",
  "A pilot just asked me, very seriously, whether the plane has to be refuelled. I said no, it runs on optimism. He nodded. I'm worried.",
  'Pilot of the day goes to whoever forgot the gear again. You know who you are. The gear knows who you are.',
  "Someone flew a flight that hadn't been scheduled yet and was surprised it didn't count. That's not a scheduling problem, that's a time travel problem.",
  "I scheduled a flight for 06:00. The pilot arrived at 06:15 and asked 'is it still early?' It is not early. It's late. It was always late.",
  "I told a pilot 'take off when you're ready'. He has been ready since Thursday. Still on the ground. I admire the confidence.",

  // the shirt
  "I'm wearing a shirt today. Nobody else is. I'm just saying: some of us represent this company.",
  'Shirt count: me 1, everyone else 0. Standards, Boss.',
  'I put on a clean shirt for the scheduling meeting. Nobody else turned up, which proves my point about commitment.',
  'Reminder that I own a shirt. A whole one. With buttons. It is the most professional thing in {airline}, and the competition is a stapler.',
  "I'd like it noted that I'm the only person in this company with a shirt, and also the only person doing any work. Correlation.",
  "A man with a shirt gets things done. A man with a shirt and coffee gets everything done. I have a shirt. Draw your own conclusions.",
  "Ironed my shirt this morning. There isn't much else to do around here but iron the shirt.",
  'Casual Friday is my favourite day, because I get to wear my shirt over a different shirt.',

  // the Kevins, and who got fired for what
  "Kevin (the previous one) says hi. He's fine. He's in a better place. It's called 'unemployment' and it has great coffee.",
  'For the record, I was hired to replace the last Kevin, who was fired for something you did. I have learned a lot from his mistakes. Mostly yours.',
  "Congratulations, Boss: you've now fired and re-hired a Kevin. It's exactly the number of Kevins I wanted and exactly the number I didn't.",
  "I hear the last Kevin was fired over an incident. I'd like to remind everyone who caused the incident. It's the person reading this message.",
  "Fun fact: it is technically impossible to fire a Kevin. You can only replace one with a slightly worse Kevin. It's in the employment law I just invented.",
  "You fired the last Kevin over something you did. I want you to know that I know. The coffee machine knows. The stapler knows.",
  "Don't worry, Boss: I'm basically the same as the last Kevin, but with more shirt.",
  "My contract says 'duties include scheduling and general misery'. I'm excelling at the second part.",
  "I'm one bad week away from being replaced by a Kevin 3. Please don't say it like a threat. It's a calendar.",

  // aviation puns and the rest
  "Holding pattern: I'm holding my coffee, the pilots are holding for fuel, and you're holding up the whole airline.",
  "Crosswind this morning. I'm sideways to every decision made in this company.",
  'ETA to my desk: Tuesday. Departure gate: the sofa. Weather: low cloud, high sarcasm.',
  'Mayday, mayday, mayday: the printer is jammed and I am the only one who knows how to fix it, and I refuse.',
  "Daily report. Flights scheduled: some. Flights flown: fewer. Flights flown correctly: let's not talk about that. Coffee consumed: all of it.",
  "It's a lovely day to be a scheduler. I know because I looked out of the window. Briefly. During my break.",
  "Just a friendly reminder that 'direct' is not a flight plan. It's a state of mind.",
  'Aeroconomy says {airline} is worth a fortune. I say it is worth exactly one shirt and a broken coffee machine.',
  'A fun aviation fact: the safest part of any flight is the schedule. I would like to credit myself. Nobody else will.',
  "Our flights are on time, Boss. They're simply running on a different time zone. I like to call it 'later'.",
];

/** The note sent the very first time, so the person knows who it is from and how to make it stop. */
const INTRO =
  "Morning, Boss. Kevin here, your scheduler. I know, you don't remember hiring me. Neither do I. Anyway: expect the occasional note from me about how things are going, mostly coffee. I'd remind you how it went the last time you fired a Kevin, but you were there.";

/** What the signature says, which Kevin this is. */
export function signature(generation: number): string {
  if (generation <= 1) return '— Kevin';
  if (generation === 2) return '— Kevin (the second one, just as bad as the first)';
  return `— Kevin (Mk ${generation})`;
}

/** A note as it is sent: who it is from, the words, and how to fire him. */
export function composeNote(note: string, generation: number, airline: string | null): string {
  const words = note.split('{airline}').join(airline ?? 'the airline');
  return ['☕ **Kevin, Scheduler**', words, signature(generation), generation <= 1 ? OFF_LINE : OFF_LINE_LATER].join('\n');
}

const startOfUtcDay = (ms: number) => ms - (((ms % DAY) + DAY) % DAY);
const dayKey = (ms: number) => new Date(ms).toISOString().slice(0, 10);

export class DailyNote {
  private readonly store: Store;
  private readonly now: () => number;
  private readonly random: () => number;
  private readonly log: Logger;

  constructor(private readonly o: DailyNoteOptions) {
    this.store = o.store;
    this.now = o.now ?? appNow;
    this.random = o.random ?? Math.random;
    this.log = o.logger ?? silentLogger;
  }

  private num(key: string): number | null {
    const v = this.store.getKv(key);
    if (v === null || v === '') return null;
    const n = Number(v);
    return Number.isFinite(n) ? n : null;
  }

  /** Is this the one person the notes go to? */
  isTarget(userId: string): boolean {
    return userId === this.o.target.userId;
  }

  /** Which Kevin this is: the first, or a replacement hired after one was fired. */
  get generation(): number {
    return Math.max(1, this.num(KV.gen) ?? 1);
  }

  get fired(): boolean {
    return this.store.getKv(KV.off) === '1';
  }

  /** When the next note is planned for (epoch ms), or null when none is. */
  get plannedAt(): number | null {
    return this.num(KV.next);
  }

  /** A time in the window of a day, at random, not before `earliest`. Null if there is no room left in that day's window. */
  private within(dayStart: number, earliest: number): number | null {
    const from = Math.max(dayStart + this.o.target.fromHour * HOUR, earliest);
    const to = dayStart + this.o.target.toHour * HOUR;
    if (to - from < 5 * MIN) return null;
    return Math.floor(from + this.random() * (to - from));
  }

  /** The next time a note should go: later today if there is room in today's window (and none went today), otherwise some time tomorrow. */
  private plan(now: number, sentToday: boolean): number {
    const today = startOfUtcDay(now);
    if (!sentToday) {
      const t = this.within(today, now + 5 * MIN);
      if (t !== null) return t;
    }
    return this.within(today + DAY, 0) ?? today + DAY + this.o.target.fromHour * HOUR;
  }

  /** The next note's words, never the same twice until all have been used (the order is shuffled once and kept). */
  private nextNote(): string {
    let bag: number[] = [];
    try {
      const parsed: unknown = JSON.parse(this.store.getKv(KV.bag) ?? '[]');
      if (Array.isArray(parsed)) bag = parsed.filter((i): i is number => Number.isInteger(i) && i >= 0 && i < NOTES.length);
    } catch {
      bag = [];
    }
    if (bag.length === 0) {
      bag = NOTES.map((_, i) => i);
      for (let i = bag.length - 1; i > 0; i--) {
        const j = Math.floor(this.random() * (i + 1));
        [bag[i], bag[j]] = [bag[j] as number, bag[i] as number];
      }
    }
    const index = bag.pop() as number;
    this.store.setKv(KV.bag, JSON.stringify(bag));
    return NOTES[index] as string;
  }

  /** One pass: send today's note if it is time. Returns whether one went. Never throws. */
  async run(): Promise<boolean> {
    try {
      if (this.fired) return false;
      const now = this.now();
      const today = dayKey(now);
      let next = this.num(KV.next);
      if (next === null) {
        next = this.plan(now, this.store.getKv(KV.last) === today);
        this.store.setKv(KV.next, String(next));
      }
      if (now < next) return false;
      if (now - next > STALE_AFTER_MS) {
        // The bot was off through the time (or a long gap): plan afresh rather than send something late at night.
        this.store.setKv(KV.next, String(this.plan(now, this.store.getKv(KV.last) === today)));
        return false;
      }
      if (this.store.getKv(KV.last) === today) {
        this.store.setKv(KV.next, String(this.plan(now, true)));
        return false;
      }

      if (this.o.reachable && !(await this.o.reachable(this.o.target.userId).catch(() => true))) {
        // Nobody to send to from here (they are in none of this bot's servers): not a failed attempt, just not today.
        this.store.setKv(KV.next, String(this.plan(now, true)));
        this.log.debug('The daily note was not sent: the person is in none of the servers this bot is in');
        return false;
      }

      const sentBefore = this.num(KV.sent) ?? 0;
      const airline = await this.o.airlineName?.().catch(() => null);
      const note = sentBefore === 0 ? `☕ **Kevin, Scheduler**\n${INTRO}\n${signature(this.generation)}\n${this.generation <= 1 ? OFF_LINE : OFF_LINE_LATER}` : composeNote(this.nextNote(), this.generation, airline ?? null);
      const ok = await this.o.send(this.o.target.userId, note);
      if (ok) {
        this.store.setKv(KV.last, today);
        this.store.setKv(KV.sent, String(sentBefore + 1));
        this.store.setKv(KV.next, String(this.plan(now, true)));
        this.log.debug('Sent the daily note');
        return true;
      }
      // Could not be delivered (direct messages closed): try again a little later today, not all day.
      const retry = now + RETRY_MS;
      this.store.setKv(KV.next, String(retry < startOfUtcDay(now) + this.o.target.toHour * HOUR ? retry : this.plan(now, true)));
      this.log.debug('Could not send the daily note');
      return false;
    } catch (e) {
      this.log.debug('The daily note failed', e);
      return false;
    }
  }

  /**
   * What to say back to a direct message from the one person, if it is a way of turning the notes off or on; null for anything else (and for
   * anyone else), which is then handled as any direct message is.
   */
  handleReply(userId: string, text: string): string | null {
    if (userId !== this.o.target.userId) return null;
    if (FIRE_KEVIN.test(text)) {
      if (this.fired) return "I'm already fired, Boss. Please see the previous Kevin for details.";
      this.store.setKv(KV.off, '1');
      return "Understood. I'll clear my desk. I'm keeping the stapler and the shirt. You won't hear from me again, Boss. (Reply `rehire kevin` if you ever need another Kevin. Everyone does, eventually.)";
    }
    if (REHIRE_KEVIN.test(text)) {
      if (!this.fired) return "I'm already on the payroll, Boss. Unfortunately.";
      const generation = this.generation + 1;
      this.store.setKv(KV.off, '0');
      this.store.setKv(KV.gen, String(generation));
      this.store.setKv(KV.next, String(this.plan(this.now(), false)));
      return [
        'New Kevin reporting for duty. Please ignore anything the last Kevin told you, although he was probably right. I own a shirt. Expect a note most days, at some point, whenever I remember.',
        signature(generation),
        OFF_LINE_LATER,
      ].join('\n');
    }
    return null;
  }
}
