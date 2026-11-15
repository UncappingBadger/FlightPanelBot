import { ActionRowBuilder, ButtonBuilder, ButtonStyle, EmbedBuilder, type MessageActionRowComponentBuilder } from 'discord.js';
import type { JobView, Panel } from '../db/store.js';
import { airlineLabel, truncate } from '../util/format.js';
import { COLORS, FOOTER, isTaken, panelButtons, panelIntro } from './ui.js';

/**
 * The panel as a grid of buttons instead of a card for each flight, for servers that choose it (`/setup layout`). Each flight is one
 * button saying what it is at a glance (a coloured dot, the ID, the aircraft, the route and when it opens, and who has it once it is
 * taken); pressing it shows the flight's card privately. Messages can be folded to a single line and unfolded again.
 *
 * Discord allows 5 buttons in a row and 5 rows in a message. Two rows go to the panel's own buttons (Reserve and the rest, and the
 * fold buttons), which leaves 3 rows: 15 flights a message.
 */

/** Flights on each message of the grid. */
export const FLIGHTS_PER_MESSAGE = 15;
/** The most messages a grid panel is drawn in (Discord's limit on what one channel's panel should be reasonably); flights beyond are counted. */
export const MAX_GRID_MESSAGES = 10;
/** The most characters Discord allows in a button's label. */
export const LABEL_MAX = 80;

/** What a flight is, as the dot beside it says. A flight that is flown is green; taken, blue; not yet open, white; otherwise yellow. */
export type FlightState = 'open' | 'taken' | 'done' | 'soon';
export const DOT: Record<FlightState, string> = { open: '🟡', taken: '🔵', done: '🟢', soon: '⚪' };
const STATE_WORD: Record<FlightState, string> = { open: 'open', taken: 'taken', done: 'completed', soon: 'not open yet' };

export function flightState(view: JobView, now: number, completed: boolean): FlightState {
  if (completed) return 'done';
  if (isTaken(view)) return 'taken';
  if (view.job.availableFrom !== null && view.job.availableFrom > now) return 'soon';
  return 'open';
}

/** Day first (16/11/26, as in the UK and Europe) or month first (11/16/26, as in the US). */
export type DateOrder = 'dmy' | 'mdy';

const two = (n: number) => String(n).padStart(2, '0');

/**
 * A moment as a short date and a time: "16/11/26 06:00Z" or "11/16/26 06:00Z". A button's label is the same text for everyone who
 * reads it (plain text cannot use Discord's local-time stamps), so the order of day and month is the server's choice, and the time
 * is UTC (the zone the airline's landing windows are in), said with the Z. The private details card has the full date, in each
 * reader's own timezone.
 */
export function shortDateTime(ms: number, order: DateOrder): string {
  const d = new Date(ms);
  const day = two(d.getUTCDate());
  const month = two(d.getUTCMonth() + 1);
  const year = two(d.getUTCFullYear() % 100);
  return `${order === 'mdy' ? `${month}/${day}` : `${day}/${month}`}/${year} ${two(d.getUTCHours())}:${two(d.getUTCMinutes())}Z`;
}

/** The route in as few characters as will do: airports joined by a plane, a chain when the legs connect. */
function compactRoute(legs: Array<{ dep: string; arr: string }>): string {
  if (legs.length === 0) return '';
  const connected = legs.every((l, i) => i === 0 || (legs[i - 1] as { arr: string }).arr === l.dep);
  return connected ? [legs[0]!.dep, ...legs.map((l) => l.arr)].join('✈') : legs.map((l) => `${l.dep}✈${l.arr}`).join(', ');
}

const clean = (s: string): string => s.replace(/[\u0000-\u001f\u007f]+/g, ' ').replace(/\s+/g, ' ').trim();

/**
 * What the button says: aircraft, route, when the flight opens, and for a flight that is taken or flown, who has it. The flight's
 * ID is not on it (it is in the card that opens when the button is pressed). The pilot and then the aircraft are dropped, and the
 * route shortened, if it would not fit in 80 characters.
 */
export function buttonLabel(view: JobView, state: FlightState, order: DateOrder = 'dmy'): string {
  const { job, legs } = view;
  const aircraft = job.aircraft ? truncate(clean(job.aircraft), 12) : '';
  const opens = job.availableFrom !== null ? shortDateTime(job.availableFrom, order) : '';
  const holder = state === 'open' || state === 'soon' ? null : (view.legs.find((l) => l.holder)?.holder?.username ?? view.legs.find((l) => l.sheetHolder)?.sheetHolder ?? null);
  const pilot = holder ? truncate(clean(holder), 14) : '';
  let route = compactRoute(legs);
  const build = (parts: { aircraft: boolean; pilot: boolean }) => [parts.aircraft ? aircraft : '', route, opens, parts.pilot ? pilot : ''].filter(Boolean).join(' · ');

  let label = build({ aircraft: true, pilot: true });
  if (label.length > LABEL_MAX) label = build({ aircraft: true, pilot: false });
  if (label.length > LABEL_MAX) label = build({ aircraft: false, pilot: false });
  if (label.length > LABEL_MAX) {
    // A long chain of airports: keep the first and the last, and say how many legs.
    const first = legs[0]?.dep ?? '';
    const last = legs[legs.length - 1]?.arr ?? '';
    route = `${first}✈…✈${last} (${legs.length} legs)`;
    label = build({ aircraft: false, pilot: false });
  }
  return truncate(label, LABEL_MAX);
}

/** One flight in the grid. */
export interface GridFlight {
  view: JobView;
  state: FlightState;
}

/** One message of the grid panel. */
export interface GridMessage {
  embeds: EmbedBuilder[];
  components: Array<ActionRowBuilder<MessageActionRowComponentBuilder>>;
}

const FOLD_EMOJI = { collapse: '🔼', expand: '🔽' } as const;

/** "Flights 16–20 · 🟡 3 open · 🔵 2 taken", for a message that is folded and as the heading of one that is not. `first` is how many flights come before it. */
export function summaryLine(part: GridFlight[], first = 0): string {
  const counts = new Map<FlightState, number>();
  for (const f of part) counts.set(f.state, (counts.get(f.state) ?? 0) + 1);
  const range = part.length === 1 ? `**Flight ${first + 1}**` : `**Flights ${first + 1}–${first + part.length}**`;
  const kinds = (['open', 'taken', 'soon', 'done'] as const).filter((s) => (counts.get(s) ?? 0) > 0).map((s) => `${DOT[s]} ${counts.get(s)} ${STATE_WORD[s]}`);
  return [range, ...kinds].join(' · ');
}

const summaryEmbed = (part: GridFlight[], first: number) => new EmbedBuilder().setColor(COLORS.note).setDescription(summaryLine(part, first));

/** The row of flight buttons: up to five. */
function flightRow(panelId: number, flights: GridFlight[], order: DateOrder): ActionRowBuilder<MessageActionRowComponentBuilder> {
  return new ActionRowBuilder<MessageActionRowComponentBuilder>().addComponents(
    ...flights.map((f) => new ButtonBuilder().setCustomId(`panel:flight:${panelId}:${f.view.job.id}`).setLabel(buttonLabel(f.view, f.state, order)).setEmoji(DOT[f.state]).setStyle(ButtonStyle.Secondary)),
  );
}

/** The key the header carries: what each coloured dot means. */
export function keyLine(hasCompleted: boolean): string {
  return `**Key:** ${DOT.open} open · ${DOT.taken} taken · ${hasCompleted ? `${DOT.done} completed in the last 24 hours · ` : ''}${DOT.soon} not open yet`;
}

/**
 * The grid panel's messages, in order. `folded` is which messages (by position, from 0) are folded to one line. The first message
 * carries the header (how to use the panel, the key, when it was updated), and every message carries the panel's buttons and its own
 * fold button, so nobody has to scroll to reserve or to fold.
 */
export function renderGridPanel(
  panel: Panel,
  flights: GridFlight[],
  now: number,
  opts: { autoCompletes: boolean; later: number; folded: ReadonlySet<number>; dates?: DateOrder },
): { messages: GridMessage[]; parts: number } {
  const label = airlineLabel({ name: panel.airlineName, abbr: panel.airlineAbbr });
  const hasCompleted = panel.completedChannelId === null;

  const intro = panelIntro(panel, flights.map((f) => f.view), now, opts.autoCompletes);
  const updated = intro.findIndex((l) => l.startsWith('Updated'));
  intro[0] = `${intro[0] ?? ''} Press a flight to see its details and ID; the date on a button is when it opens (UTC).`;
  intro.splice(updated < 0 ? intro.length : updated, 0, keyLine(hasCompleted));
  if (panel.completedChannelId) intro.push(`Completed flights are in <#${panel.completedChannelId}>.`);
  const header = new EmbedBuilder()
    .setColor(COLORS.panel)
    .setTitle(`✈️ ${label} · open flights`)
    .setDescription(flights.length === 0 ? `${intro.join('\n')}\n\nNo flights are listed right now.` : intro.join('\n'));

  const capacity = FLIGHTS_PER_MESSAGE * MAX_GRID_MESSAGES;
  const shown = flights.slice(0, capacity);
  const notShown = flights.length - shown.length;
  const parts: GridFlight[][] = [];
  for (let i = 0; i < shown.length; i += FLIGHTS_PER_MESSAGE) parts.push(shown.slice(i, i + FLIGHTS_PER_MESSAGE));

  const notes: EmbedBuilder[] = [];
  const days = `${panel.showDays} day${panel.showDays === 1 ? '' : 's'}`;
  if (opts.later > 0) notes.push(new EmbedBuilder().setColor(COLORS.note).setDescription(`🗓️ ${opts.later} more flight${opts.later === 1 ? ' starts' : 's start'} more than ${days} from now, and will be listed here once ${opts.later === 1 ? 'it is' : 'they are'} within ${days}.`));
  if (notShown > 0) notes.push(new EmbedBuilder().setColor(COLORS.note).setDescription(`…and ${notShown} more flight${notShown === 1 ? '' : 's'} not shown.`));

  const messages: GridMessage[] = [];
  const total = Math.max(parts.length, 1);
  for (let i = 0; i < total; i++) {
    const part = parts[i] ?? [];
    const first = i === 0;
    const folded = part.length > 0 && opts.folded.has(i);
    const embeds: EmbedBuilder[] = [];
    if (first) embeds.push(header);
    if (part.length > 0 && (!first || folded)) embeds.push(summaryEmbed(part, i * FLIGHTS_PER_MESSAGE));

    const rows: Array<ActionRowBuilder<MessageActionRowComponentBuilder>> = [];
    if (first || !folded) rows.push(panelButtons(panel.id));
    const extras: ButtonBuilder[] = [];
    if (first) extras.push(new ButtonBuilder().setCustomId(`panel:list:${panel.id}`).setLabel('List view').setEmoji('📃').setStyle(ButtonStyle.Secondary));
    if (part.length > 0) {
      extras.push(
        new ButtonBuilder()
          .setCustomId(`panel:fold:${panel.id}:${i}`)
          .setLabel(folded ? 'Expand' : 'Collapse')
          .setEmoji(folded ? FOLD_EMOJI.expand : FOLD_EMOJI.collapse)
          .setStyle(ButtonStyle.Secondary),
      );
    }
    if (first && parts.length > 0) {
      extras.push(
        new ButtonBuilder().setCustomId(`panel:foldall:${panel.id}`).setLabel('Collapse all').setEmoji(FOLD_EMOJI.collapse).setStyle(ButtonStyle.Secondary),
        new ButtonBuilder().setCustomId(`panel:unfoldall:${panel.id}`).setLabel('Expand all').setEmoji(FOLD_EMOJI.expand).setStyle(ButtonStyle.Secondary),
      );
    }
    if (extras.length > 0) rows.push(new ActionRowBuilder<MessageActionRowComponentBuilder>().addComponents(...extras));
    if (!folded) for (let r = 0; r < part.length; r += 5) rows.push(flightRow(panel.id, part.slice(r, r + 5), opts.dates ?? 'dmy'));

    if (i === total - 1) embeds.push(...notes);
    messages.push({ embeds, components: rows });
  }

  // The disclaimer is on the very last card.
  const lastEmbeds = messages[messages.length - 1]!.embeds;
  lastEmbeds[lastEmbeds.length - 1]!.setFooter({ text: FOOTER });
  return { messages, parts: parts.length };
}
