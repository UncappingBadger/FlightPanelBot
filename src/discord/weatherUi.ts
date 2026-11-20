import { ActionRowBuilder, ButtonBuilder, ButtonStyle, ModalBuilder, TextInputBuilder, TextInputStyle, type MessageActionRowComponentBuilder } from 'discord.js';
import type { BoardFlight } from '../services/weatherAirports.js';
import { routeText, ts } from '../util/format.js';

/** Said under every weather board and every search answer: these are simulation weather reports, read by a hobby bot. */
export const WEATHER_FOOTER = "Weather from VATSIM's METAR service · unofficial bot, not affiliated with VATSIM · for flight simulation only, not for real-world flying";

/** Discord allows 2000 characters in a message; a little is kept back. */
const MESSAGE_LIMIT = 1900;
/** A board never spans more messages than this. */
export const MAX_BOARD_MESSAGES = 8;
/** A block of METARs is kept under this many characters, so it always fits a message. */
const BLOCK_LIMIT = 1500;
const FENCE = '```';

/** What goes inside a code block: nothing in it can end the block or start a line of its own. */
const safe = (s: string): string => s.replace(/`/g, "'").replace(/[\r\n]+/g, ' ');

/** The METAR lines as code blocks, each under `BLOCK_LIMIT` characters, so the abbreviations line up and nothing in them is read as formatting. */
export function metarBlocks(lines: string[]): string[] {
  const blocks: string[] = [];
  let current: string[] = [];
  let size = 0;
  const flush = () => {
    if (current.length > 0) blocks.push([FENCE, ...current, FENCE].join('\n'));
    current = [];
    size = 0;
  };
  for (const raw of lines) {
    const line = safe(raw);
    if (current.length > 0 && size + line.length + 1 > BLOCK_LIMIT) flush();
    current.push(line);
    size += line.length + 1;
  }
  flush();
  return blocks;
}

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
const two = (n: number): string => String(n).padStart(2, '0');
const dayText = (ms: number): string => `${new Date(ms).getUTCDate()} ${MONTHS[new Date(ms).getUTCMonth()]}`;
const clock = (ms: number): string => `${two(new Date(ms).getUTCHours())}${two(new Date(ms).getUTCMinutes())}`;

/** A landing window in Zulu, as the schedule sheet writes it: `20 Nov 1400-1800Z`, or across midnight `20 Nov 2200Z to 21 Nov 0200Z`. */
export function windowText(from: number, to: number): string {
  if (from === to) return `${dayText(to)} by ${clock(to)}Z`;
  if (dayText(from) === dayText(to)) return `${dayText(from)} ${clock(from)}-${clock(to)}Z`;
  return `${dayText(from)} ${clock(from)}Z to ${dayText(to)} ${clock(to)}Z`;
}

function flightLine(f: BoardFlight): string {
  return `\`${f.code}\` ${routeText(f.legs)} · ${windowText(f.from, f.to)}`;
}

/** What `renderWeather` is given: everything already looked up, as lines of text. */
export interface WeatherView {
  now: number;
  /** The METARs of the airports at the top, one line each. */
  top: string[];
  /** The flights shown, and how many more there were. */
  flights: BoardFlight[];
  moreFlights: number;
  /** The METARs of those flights' airports (not the ones at the top), one line each, and how many more airports there were. */
  flightAirports: string[];
  moreAirports: number;
  /** Airport codes of the flights that are not four-letter codes, so no report can be asked for them. */
  skipped: string[];
  /** How often the board is redrawn, in minutes. */
  everyMinutes: number;
}

/**
 * The board as messages (each a piece of text): the airports at the top with their METARs as written, then the flights of the next 24
 * hours, then the METARs of the airports those flights use. Only the abbreviations are shown, not what they mean (the plain-language
 * version is what `metar EGLL` in a DM gives). It never needs more than `MAX_BOARD_MESSAGES` messages.
 */
export function renderWeather(v: WeatherView): string[] {
  const pieces: string[] = [];
  pieces.push(`🌦️ **Weather** · METARs from VATSIM · checked ${ts(v.now, 'R')}\nRedrawn every ${v.everyMinutes} minutes. Press **Search airport** to look up any airport.`);

  const top = metarBlocks(v.top);
  top.forEach((b, i) => pieces.push(i === 0 ? `**Airports**\n${b}` : b));

  if (v.flights.length === 0) {
    pieces.push('**Flights in the next 24 hours**\nNone in the schedule.');
  } else {
    v.flights.forEach((f, i) => pieces.push(i === 0 ? `**Flights in the next 24 hours** (${v.flights.length + v.moreFlights})\n${flightLine(f)}` : flightLine(f)));
    if (v.moreFlights > 0) pieces.push(`…and ${v.moreFlights} more flight${v.moreFlights === 1 ? '' : 's'}.`);
  }

  const theirs = metarBlocks(v.flightAirports);
  theirs.forEach((b, i) => pieces.push(i === 0 ? `**Airports of those flights**\n${b}` : b));
  if (v.moreAirports > 0) pieces.push(`…and ${v.moreAirports} more airport${v.moreAirports === 1 ? '' : 's'} not shown.`);
  if (v.skipped.length > 0) pieces.push(`No report asked for ${v.skipped.slice(0, 8).map((c) => `\`${safe(c)}\``).join(', ')}${v.skipped.length > 8 ? ' …' : ''}: not four-letter airport codes.`);
  pieces.push(`*${WEATHER_FOOTER}*`);

  const messages: string[] = [];
  let current = '';
  for (const piece of pieces) {
    if (current === '') current = piece;
    else if (current.length + 1 + piece.length <= MESSAGE_LIMIT) current += `\n${piece}`;
    else {
      messages.push(current);
      current = piece;
    }
  }
  if (current !== '') messages.push(current);
  if (messages.length > MAX_BOARD_MESSAGES) {
    const kept = messages.slice(0, MAX_BOARD_MESSAGES);
    kept[MAX_BOARD_MESSAGES - 1] += '\n…and more that did not fit.';
    return kept;
  }
  return messages;
}

/** The Search button under the last message of a board. */
export function weatherButtons(): ActionRowBuilder<MessageActionRowComponentBuilder> {
  return new ActionRowBuilder<MessageActionRowComponentBuilder>().addComponents(
    new ButtonBuilder().setCustomId('weather:search').setLabel('Search airport').setEmoji('🔎').setStyle(ButtonStyle.Secondary),
  );
}

/** The form the Search button opens: one box for an airport's ICAO code (or several). */
export function searchModal(): ModalBuilder {
  return new ModalBuilder()
    .setCustomId('weather:searchgo')
    .setTitle("Find an airport's weather")
    .addComponents(
      new ActionRowBuilder<TextInputBuilder>().addComponents(
        new TextInputBuilder()
          .setCustomId('codes')
          .setLabel('Airport code (four-letter ICAO)')
          .setPlaceholder('KJFK, or several: KJFK EGLL LFPG')
          .setStyle(TextInputStyle.Short)
          .setRequired(true)
          .setMaxLength(60),
      ),
    );
}
