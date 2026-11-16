import { NOTICE_KINDS, type NoticeKind } from '../db/store.js';

/**
 * The optional private messages: what each is called and what it is for. These are the only ones a person can switch off. What the
 * bot says about the things they reserved, released or stand by for (a flight of theirs released or removed, a backup spot that
 * ended, a manager changing their FsHub ID) is not optional, and neither is any answer to something they did themselves.
 */
export const NOTICE_INFO: Record<NoticeKind, { name: string; what: string }> = {
  completed: {
    name: 'Flights completed for you',
    what: "When FsHub shows you flew a flight, I mark it completed and tell you. (Switched off, I still mark it completed; I just don't message you.)",
  },
  takeoff: {
    name: 'Take-off warnings',
    what: "A heads-up shortly before the latest time you could take off and still land inside a flight's window, for flights you hold or are the backup for.",
  },
  landing: {
    name: 'Hard-landing remarks',
    what: 'When FsHub shows you landed very hard, a light-hearted message about it. A normal landing never gets one.',
  },
};

/** The line at the bottom of an optional message, so the person knows they can switch it off. */
export const NOTICE_HINT = "Don't want these? DM me `notifications` to switch them off.";

/** What people type to reach the settings: `notifications`, `notification`, `notify`, `notices`, with what they want after it. */
export const NOTICES_REQUEST = /^(?:notifications?|notify|notices?)(?:\s+([\s\S]*))?$/i;

/** What a message after `notifications` asks for: nothing (show the settings), a change, or something that can't be read. */
export type NoticeChange = { kind: 'show' } | { kind: 'set'; kinds: NoticeKind[]; on: boolean } | { kind: 'unclear' };

const ON = /\b(on|enable|enabled|yes|resume|unmute)\b/i;
const OFF = /\b(off|disable|disabled|no|stop|mute|silence|pause)\b/i;
const CATEGORY: Record<NoticeKind, RegExp> = {
  completed: /complet|\bdone\b|fshub/i,
  takeoff: /take[\s-]?off|depart|warn|\blate\b|heads/i,
  landing: /\bland(?:ing|ings|ed)?\b|touchdown|\bhard\b|thump|bounce|remark|joke|funny|banter|kevin/i,
};

/**
 * Read what a person wrote after `notifications`: `off`, `on`, `completed off`, `takeoff on`, `take-off warnings off`...
 * With no word for a kind of message, the change is to all of them. An "on" and an "off" together, or neither, can't be read.
 */
export function parseNoticeChange(argument: string): NoticeChange {
  const text = argument.trim();
  if (!text) return { kind: 'show' };
  // "take-off" has an "off" in it that is not the answer, so the kind's own words are taken out before looking for on or off.
  const answer = text.replace(/take[\s-]?off/gi, ' ');
  const on = ON.test(answer);
  const off = OFF.test(answer);
  if (on === off) return { kind: 'unclear' };
  const named = NOTICE_KINDS.filter((k) => CATEGORY[k].test(text));
  return { kind: 'set', kinds: named.length > 0 ? named : [...NOTICE_KINDS], on };
}
