import { silentLogger, type Logger } from '../util/log.js';
import { intentOf, isRude, mentions, moodOf, pickLine, type Intent, type Mood } from './banter.js';
import type { ChatEvent } from './eventsub.js';
import { aircraftText, distanceText, etaText, flightText, landingText, type FlightSource } from './flightInfo.js';

/**
 * The part of the Twitch integration that decides what to say. It is given each chat message and answers with the text to send back, or
 * null for "say nothing", which is most of the time:
 *
 *  - `!flight`, `!distance`, `!landing`, `!aircraft`, `!eta` (and `!kevin` for the list) give the streamer's flight information;
 *  - a message that names the bot (or answers one of its messages) gets banter, or the same information if it asks about the flight in plain words;
 *  - everything else, other bots, the bot's own messages, and anything crude, is left alone.
 *
 * It is careful not to flood a chat: a command has a cooldown, a person has a cooldown, and the bot never sends more than a handful of
 * messages in half a minute (Twitch's own limit for an ordinary account is twenty).
 */

export interface Reply {
  text: string;
  /** The message being answered: the reply is shown as an answer to it. */
  replyTo: string;
}

export interface ChatBotOptions {
  botLogin: string;
  botUserId: string;
  botDisplayName?: string;
  /** Names that count as talking to the bot besides its own account name (the persona's). */
  personaNames?: readonly string[];
  source: FlightSource;
  /** `!` commands and plain questions about the flight. */
  commands: boolean;
  /** Replies to compliments, jokes and insults. */
  banter: boolean;
  now?: () => number;
  random?: () => number;
  logger?: Logger;
}

export const COMMAND_COOLDOWN_MS = 10_000;
export const USER_COMMAND_COOLDOWN_MS = 4_000;
export const BANTER_USER_COOLDOWN_MS = 20_000;
export const BANTER_ALL_COOLDOWN_MS = 5_000;
export const SEND_WINDOW_MS = 30_000;
export const SEND_WINDOW_MAX = 10;
export const SEND_MIN_GAP_MS = 1_500;
/** A message this long is not a question for the bot. */
const MAX_INPUT_CHARS = 400;

/** Other bots and services that talk in chat: never answered. */
const OTHER_BOTS = new Set(['nightbot', 'streamelements', 'streamlabs', 'moobot', 'fossabot', 'wizebot', 'soundalerts', 'pretzelrocks', 'commanderroot', 'botrix', 'sery_bot', 'lurxx']);

const COMMANDS: Readonly<Record<string, Intent | 'help'>> = {
  flight: 'flight',
  route: 'flight',
  distance: 'distance',
  landing: 'landing',
  landingrate: 'landing',
  aircraft: 'aircraft',
  plane: 'aircraft',
  eta: 'eta',
  kevin: 'help',
  commands: 'help',
};

export const HELP_TEXT = "Kevin from scheduling here. Ask me: !flight · !distance · !landing · !aircraft · !eta. Or just say hi. I'm very busy, honestly.";

/** Moods that are answered with banter even if the message also asks about the flight. */
const STRONG_MOODS = new Set<Mood>(['lazy', 'insult', 'fired', 'robot', 'thanks', 'love', 'compliment', 'howAre']);

export class ChatBot {
  private readonly now: () => number;
  private readonly random: () => number;
  private readonly log: Logger;
  private readonly names: string[];
  private readonly cooldowns = new Map<string, number>();
  private readonly recentLines = new Map<Mood, string[]>();
  private readonly sent: number[] = [];

  constructor(private readonly o: ChatBotOptions) {
    this.now = o.now ?? Date.now;
    this.random = o.random ?? Math.random;
    this.log = o.logger ?? silentLogger;
    this.names = [o.botLogin, o.botDisplayName ?? '', ...(o.personaNames ?? ['kevin'])].filter((n) => n.length > 0);
  }

  /** What to say back to this message, if anything. */
  async respond(ev: ChatEvent): Promise<Reply | null> {
    if (ev.chatterId === this.o.botUserId || OTHER_BOTS.has(ev.chatterLogin)) return null;
    const text = ev.text.trim();
    if (text.length > MAX_INPUT_CHARS || isRude(text)) return null;

    const command = /^!([a-z]{2,20})\b/i.exec(text);
    if (command) {
      const what = COMMANDS[(command[1] as string).toLowerCase()];
      return what && this.o.commands ? this.answer(ev, what, `cmd:${what}`) : null;
    }

    const addressed = mentions(text, this.names) || ev.replyToUserId === this.o.botUserId || (ev.replyToLogin !== null && ev.replyToLogin === this.o.botLogin);
    if (!addressed) return null;

    const mood = moodOf(text);
    const intent = intentOf(text);
    if (this.o.commands && intent && !(mood && STRONG_MOODS.has(mood))) return this.answer(ev, intent, `cmd:${intent}`);
    if (!this.o.banter) return null;
    return this.banter(ev, mood ?? 'unsure');
  }

  /* ------------------------------------------------------------------ commands */

  private async answer(ev: ChatEvent, what: Intent | 'help', key: string): Promise<Reply | null> {
    const t = this.now();
    if (!this.ready(key, t, COMMAND_COOLDOWN_MS) || !this.ready(`user:${ev.chatterId}`, t, USER_COMMAND_COOLDOWN_MS) || !this.canSend(t)) return null;
    this.mark(key, t);
    this.mark(`user:${ev.chatterId}`, t);
    this.record(t); // the place in the pace is taken now, so messages that arrive while the data is being read cannot all slip through

    let text: string;
    if (what === 'help') text = HELP_TEXT;
    else {
      try {
        const live = await this.o.source.live();
        // The last landing is only asked for when the question is about the past (or when nobody is flying).
        const needsLast = what === 'landing' || !live || what === 'distance' || what === 'flight' || what === 'aircraft';
        const last = needsLast ? await this.o.source.lastFlight().catch((e: unknown) => (this.log.debug(`Twitch: no last flight: ${e instanceof Error ? e.message : String(e)}`), null)) : null;
        const now = this.now();
        text =
          what === 'flight' ? flightText(live, last, now)
          : what === 'distance' ? distanceText(live, last)
          : what === 'landing' ? landingText(live, last, now)
          : what === 'aircraft' ? aircraftText(live, last)
          : etaText(live, now);
      } catch (e) {
        this.log.debug(`Twitch: could not read the flight data: ${e instanceof Error ? e.message : String(e)}`);
        text = "📡 I can't reach the live flight data right now. Try me again in a minute.";
      }
    }
    return { text, replyTo: ev.messageId };
  }

  /* ------------------------------------------------------------------ banter */

  private banter(ev: ChatEvent, mood: Mood): Reply | null {
    const t = this.now();
    if (!this.ready(`banter:${ev.chatterId}`, t, BANTER_USER_COOLDOWN_MS) || !this.ready('banter', t, BANTER_ALL_COOLDOWN_MS) || !this.canSend(t)) return null;
    this.mark(`banter:${ev.chatterId}`, t);
    this.mark('banter', t);
    const recent = this.recentLines.get(mood) ?? [];
    this.recentLines.set(mood, recent);
    const user = ev.chatterName.replace(/[^\p{L}\p{N}_ -]/gu, '').trim().slice(0, 25) || 'friend';
    this.record(t);
    return { text: pickLine(mood, user, recent, this.random, this.o.commands), replyTo: ev.messageId };
  }

  /* ------------------------------------------------------------------ pacing */

  private ready(key: string, now: number, cooldownMs: number): boolean {
    const last = this.cooldowns.get(key);
    return last === undefined || now - last >= cooldownMs;
  }

  private mark(key: string, now: number): void {
    this.cooldowns.set(key, now);
    if (this.cooldowns.size > 2_000) for (const [k, at] of this.cooldowns) if (now - at > 120_000) this.cooldowns.delete(k);
  }

  /** Within the pace set for this bot: a few messages in half a minute, and not two at once. */
  private canSend(now: number): boolean {
    while (this.sent.length > 0 && now - (this.sent[0] as number) >= SEND_WINDOW_MS) this.sent.shift();
    if (this.sent.length >= SEND_WINDOW_MAX) return false;
    const last = this.sent[this.sent.length - 1];
    return last === undefined || now - last >= SEND_MIN_GAP_MS;
  }

  private record(now: number): void {
    this.sent.push(now);
  }
}
