/**
 * Reading several flight IDs out of one message, for someone who pastes `DMO-004, DMO-007 and DMO-011` (or one per line)
 * instead of sending them one at a time.
 *
 * An ID is letters, numbers and dashes, and pilots also type it with a space in it (`DMO 7`), so a space alone does not
 * say where one ID ends. What does: a comma, semicolon, new line, `&`, `+`, `/`, `|`, a bullet, the word "and", and the
 * Discord formatting characters a copied list can carry (`**`, backticks, `~`, quotes). The text is cut at those into
 * chunks, and each chunk into words; the caller then tries each word on its own and only joins two neighbours when the first
 * is not an ID by itself (so `DMO 7` is one flight and `7 8` is two).
 */

/** Most words looked at in one message. A flight list that long is not something to puzzle over; the rest is reported. */
export const MAX_ID_WORDS = 60;

/** The longest piece of a word that is shown back to the person, so a pasted wall of text can't fill a reply. */
export const MAX_SHOWN_ID = 20;

const SEPARATORS = /[,;|&+/\r\n\t*`~"•·–—]+/;

/** A word of the message, tidied: formatting around an ID is taken off (`(DMO-004).`), but a bare number keeps its dot, so `1.` (a list's numbering) is never read as flight 1. */
function tidy(word: string): string {
  if (!/[a-z]/i.test(word)) return word;
  return word.replace(/^[([{<]+/, '').replace(/[)\]}>.!?:]+$/, '');
}

/** The message as chunks of words, in the order they were written. Words with no letter or number in them (a lone `-`, an arrow) are left out. */
export function flightIdChunks(text: string): string[][] {
  return text
    .replace(/\s+and\s+/gi, ',')
    .split(SEPARATORS)
    .map((chunk) =>
      chunk
        .split(/\s+/)
        .map(tidy)
        .filter((w) => /[a-z0-9]/i.test(w)),
    )
    .filter((words) => words.length > 0);
}
