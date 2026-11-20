import { ActionRowBuilder, ButtonBuilder, ButtonStyle, EmbedBuilder, ModalBuilder, TextInputBuilder, TextInputStyle, type MessageActionRowComponentBuilder } from 'discord.js';
import type { FlightCategory } from '../services/metar.js';
import { ts } from '../util/format.js';
import { COLORS } from './ui.js';

/** Said under every weather board and every search answer: these are simulation weather reports, read by a hobby bot. */
export const WEATHER_FOOTER = "Weather from VATSIM's METAR service · unofficial bot, not affiliated with VATSIM · for flight simulation only, not for real-world flying";

/** Discord allows 5 buttons in a row and 5 rows in a message. */
const BUTTONS_PER_ROW = 5;
/** Airports on each message of the grid of flights' airports (all five rows). */
export const AIRPORTS_PER_MESSAGE = 25;

/** What the dot on an airport's button says: the US-style flying-conditions rating of its report, or that there is none. */
export const DOT: Record<FlightCategory | 'none', string> = { VFR: '🟢', MVFR: '🔵', IFR: '🔴', LIFR: '🟣', none: '⚪' };

type Row = ActionRowBuilder<MessageActionRowComponentBuilder>;

/** The METAR lines as code blocks, so the abbreviations line up and nothing in them is read as formatting. Each block stays under 1500 characters. */
const FENCE = '```';
const BLOCK_LIMIT = 1500;
const safe = (s: string): string => s.replace(/`/g, "'").replace(/[\r\n]+/g, ' ');

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

/** One airport on the board: its code, and how its weather rates (null: VATSIM has no report for it, or none that can be read). */
export interface GridAirport {
  code: string;
  category: FlightCategory | null;
}

/** What `renderWeather` is given. */
export interface WeatherView {
  now: number;
  /** The airports the server chose to follow, in the order given. */
  monitored: GridAirport[];
  /** The airports of the flights in the next 24 hours (those already monitored are not repeated), in the order to show them. */
  ofFlights: GridAirport[];
  /** How many more airports the flights use than are shown. */
  moreAirports: number;
  /** Airport codes of the flights that are not four-letter codes, so no report can be asked for them. */
  skipped: string[];
  /** How often the board is redrawn, in minutes. */
  everyMinutes: number;
}

/** One message of the board. */
export interface WeatherMessage {
  embeds: EmbedBuilder[];
  components: Row[];
}

/** One airport's button: the rating's dot, and just the airport's code. Pressing it shows its METAR privately. */
function airportButton(a: GridAirport): ButtonBuilder {
  return new ButtonBuilder().setCustomId(`weather:metar:${a.code}`).setLabel(a.code).setEmoji(DOT[a.category ?? 'none']).setStyle(ButtonStyle.Secondary);
}

/** The airports as rows of five buttons. */
function airportRows(airports: GridAirport[]): Row[] {
  const rows: Row[] = [];
  for (let i = 0; i < airports.length; i += BUTTONS_PER_ROW) rows.push(new ActionRowBuilder<MessageActionRowComponentBuilder>().addComponents(...airports.slice(i, i + BUTTONS_PER_ROW).map(airportButton)));
  return rows;
}

/** The key the header carries: what each coloured dot means. */
export const keyLine = (): string => `**Key:** ${DOT.VFR} VFR · ${DOT.MVFR} MVFR · ${DOT.IFR} IFR · ${DOT.LIFR} LIFR (US-style flying conditions) · ${DOT.none} no report`;

/**
 * The board as messages, in order, laid out like the reserve panel's grid: a header with the key, then a grid of buttons, one for each airport, that says only its
 * code (with a dot for how its weather rates). The first message is the airports the server follows, with the Search button; the next ones are the airports of
 * the flights in the next 24 hours, 25 to a message. Pressing an airport shows its METAR privately. No report is written out in the channel.
 */
export function renderWeather(v: WeatherView): WeatherMessage[] {
  const header = new EmbedBuilder()
    .setColor(COLORS.info)
    .setTitle('🌦️ Weather · METARs from VATSIM')
    .setDescription(
      [
        'Press an airport to see its METAR, or **Search airport** for any other.',
        keyLine(),
        `Checked ${ts(v.now, 'R')} · redrawn every ${v.everyMinutes} minutes`,
        `**Airports followed** (${v.monitored.length})`,
      ].join('\n'),
    );
  const first: WeatherMessage = { embeds: [header], components: [...airportRows(v.monitored), weatherButtons()] };
  const messages: WeatherMessage[] = [first];

  const parts: GridAirport[][] = [];
  for (let i = 0; i < v.ofFlights.length; i += AIRPORTS_PER_MESSAGE) parts.push(v.ofFlights.slice(i, i + AIRPORTS_PER_MESSAGE));
  const total = v.ofFlights.length + v.moreAirports;
  parts.forEach((part, i) => {
    const lines = [i === 0 ? `**Airports of the flights in the next 24 hours** (${total})` : `**…continued** (${i * AIRPORTS_PER_MESSAGE + 1}–${i * AIRPORTS_PER_MESSAGE + part.length})`];
    if (i === parts.length - 1) {
      if (v.moreAirports > 0) lines.push(`…and ${v.moreAirports} more airport${v.moreAirports === 1 ? '' : 's'} not shown.`);
      if (v.skipped.length > 0) lines.push(`No report asked for ${v.skipped.slice(0, 8).map((c) => `\`${safe(c)}\``).join(', ')}${v.skipped.length > 8 ? ' …' : ''}: not four-letter airport codes.`);
    }
    messages.push({ embeds: [new EmbedBuilder().setColor(COLORS.panel).setDescription(lines.join('\n'))], components: airportRows(part) });
  });

  // The disclaimer is on the very last card.
  const lastEmbeds = messages[messages.length - 1]!.embeds;
  lastEmbeds[lastEmbeds.length - 1]!.setFooter({ text: WEATHER_FOOTER });
  return messages;
}

/** The Search button: the last row of the board's first message. */
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
