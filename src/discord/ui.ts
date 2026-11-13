import {
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  EmbedBuilder,
  type APIEmbedField,
  type MessageActionRowComponentBuilder,
  type MessageMentionOptions,
} from 'discord.js';
import type { FlownFlight, Holder, JobView, LegView, Panel } from '../db/store.js';
import type { AutoCompleted } from '../services/autoComplete.js';
import { sameAircraft, type Confirmations } from '../services/flightMatch.js';
import { MAX_SEARCH_RESULTS, type SearchDay } from '../services/search.js';
import type { Reminder } from '../services/reminders.js';
import { airlineLabel, legList, legText, mention, plainText, routeText, truncate, ts } from '../util/format.js';

export const COLORS = {
  panel: 0x5865f2,
  success: 0x2ecc71,
  info: 0x3498db,
  error: 0xe74c3c,
  /** The stripe on a card for a flight that still needs a pilot, one that is taken, and a grey note among them. */
  open: 0xf5b50a,
  taken: 0x3b8bff,
  note: 0x6d6f78,
} as const;

/** True when running `npm run demo`: fictional jobs, not real data. Set before the bot loads. */
export const DEMO = process.env.AEROBOT_DEMO === '1';

export const FOOTER = DEMO
  ? '🧪 DEMO MODE · fictional airlines and flights'
  : 'Unofficial companion bot · not affiliated with FsHub or Aeroconomy';

/** Never ping anyone from a panel or DM; mentions here only name people. */
export const noPings = { parse: [] as never[] };

/**
 * Who has a leg, for the panel. A Discord reservation shows as a mention. A name from the airline's
 * own schedule shows as plain text, marked so nobody mistakes it for a Discord reservation.
 */
export function holderText(leg: LegView): string {
  const sheet = leg.sheetHolder ? plainText(truncate(leg.sheetHolder, 40)) : null;
  if (leg.holder) {
    const who = pilotText(leg.holder);
    return sheet && !isEcho(leg) ? `${who} · *schedule: ${sheet}*` : who;
  }
  return sheet ? `${sheet} *(in the schedule)*` : '*open*';
}

/**
 * A Discord reservation as a mention, with the FsHub pilot ID the person gave beside it (if they have),
 * and the name FsHub has for that ID when the bot knows it, so a manager can match the account to the
 * airline's roster even when the names differ. The name comes from outside, so it is shown as plain text.
 */
function pilotText(holder: Holder): string {
  if (holder.fshubId === null) return mention(holder.discordId);
  const name = holder.fshubName ? ` (${plainText(truncate(holder.fshubName, 40))})` : '';
  return `${mention(holder.discordId)} · FsHub #${holder.fshubId}${name}`;
}

/** True when the schedule's name for a leg is just the one the bot wrote there for the person who reserved it. */
function isEcho(leg: LegView): boolean {
  const written = leg.holder?.sheetName;
  return Boolean(written && leg.sheetHolder && written.trim().toLowerCase() === leg.sheetHolder.trim().toLowerCase());
}

/** One job as the block of text shown on the panel and in DMs. */
export function jobBlock(view: JobView, now: number): string {
  const { job, legs } = view;
  const route = routeText(legs);
  const head = [`**${job.code}**`, legs.length > 1 ? `${route} (${legs.length} legs)` : route];
  if (job.aircraft) head.push(`✈ ${job.aircraft}`);

  const meta: string[] = [];
  if (job.availableFrom !== null && job.availableFrom > now) meta.push(`🕐 from ${ts(job.availableFrom, 'f')}`);
  if (job.deadline !== null) meta.push(`⏰ complete by ${ts(job.deadline, 'f')} (${ts(job.deadline, 'R')})`);
  if (job.pay) meta.push(`💰 ${job.pay}`);

  const lines = [head.join(' · ')];
  if (meta.length) lines.push(meta.join(' · '));
  const about = [job.title, job.notes].filter(Boolean).join(' - ');
  if (about) lines.push(`*${truncate(about, 160)}*`);

  if (legs.length === 1) {
    lines.push(`↳ ${legs[0] ? holderText(legs[0]) : '*open*'}`);
  } else {
    for (const l of legs) lines.push(`↳ \`${l.legNo}\` ${legText(l)} — ${holderText(l)}`);
  }
  return lines.join('\n');
}

/** Who flew a completed flight: Discord reservations as mentions, names from the airline's schedule as plain text. */
function flownBy(view: JobView): string | null {
  const names: string[] = [];
  for (const l of view.legs) {
    const sheet = l.sheetHolder ? plainText(truncate(l.sheetHolder, 40)) : null;
    const text = l.holder ? (sheet && !isEcho(l) ? `${pilotText(l.holder)} (${sheet})` : pilotText(l.holder)) : sheet;
    if (text && !names.includes(text)) names.push(text);
  }
  return names.length > 0 ? names.join(', ') : null;
}

/**
 * What FsHub recorded for a landing, as the end of a line: the aircraft flown (and its name, when FsHub has one), when
 * it landed (shown in each reader's own timezone), how it went against its schedule, and a warning if the aircraft
 * isn't the one the schedule asked for. The names come from outside, so they are shown as plain text.
 */
export function flightFacts(flight: FlownFlight, required: string | null): string {
  const name = flight.aircraftName ? plainText(truncate(flight.aircraftName, 40)) : null;
  const type = flight.aircraftIcao ? `${flight.aircraftIcao}${name ? ` (${name})` : ''}` : (name ?? 'aircraft not recorded');
  const how = flight.scheduleStatus === 'ON-TIME' ? ' · on time' : flight.scheduleStatus === 'DELAYED' ? ' · delayed' : flight.scheduleStatus === 'LATE' ? ' · late' : '';
  const warn = required && sameAircraft(required, flight.aircraftIcao) === false ? ` · ⚠️ scheduled ${plainText(truncate(required, 12))}` : '';
  return `${type}, landed ${ts(flight.arrivedAt, 't')}${how}${warn}`;
}

/** The DM telling a pilot that flights of theirs were completed from FsHub without them pressing Complete. */
export function autoCompletedMessage(done: AutoCompleted[]): string {
  const lines = done.map((c) => {
    const legs = [...c.flights.entries()].sort((a, b) => a[0] - b[0]);
    const facts =
      c.view.legs.length === 1
        ? flightFacts(legs[0]![1], c.view.job.aircraft)
        : legs.map(([no, f]) => `leg ${no}: ${flightFacts(f, c.view.job.aircraft)}`).join('; ');
    return `✅ **${c.view.job.code}** (${routeText(c.view.legs)}): ${facts}${c.sheetTicked ? " · ticked in the airline's sheet" : ''}`;
  });
  const airline = plainText(truncate(done[0]?.panel.airlineName ?? 'the airline', 60));
  const many = done.length > 1;
  return [
    `FsHub shows you flew ${many ? `${done.length} flights` : 'a flight'} for **${airline}**, so I marked ${many ? 'them' : 'it'} completed:`,
    ...lines,
    'There is nothing for you to do. I check FsHub for your landings every hour.',
  ].join('\n');
}

/**
 * FsHub's own number for a flight, as a link to its public report. The number is FsHub's (it only exists once the flight
 * has landed), and the address is built from it alone on a fixed host, so nothing from outside is ever put in a link.
 */
export function fshubFlightLink(flightId: number, label = `#${flightId}`): string {
  return Number.isSafeInteger(flightId) && flightId > 0 ? `[${label}](https://fshub.io/flight/${flightId}/report)` : '';
}

/* ------------------------------------------------------------------ the panel's cards */

/**
 * The panel is a board of cards, one embed per flight with a coloured stripe down its left edge: amber for a flight that
 * still needs a pilot, blue for one whose every leg is taken, green for one that has been flown. A card is the route in
 * large type, labelled boxes beneath it, and who has it. Discord puts a gap between embeds, which is what keeps the flights
 * easy to tell apart.
 *
 * A message holds at most 10 embeds and 6000 characters across all of them, so cards are packed into messages up to
 * those limits (a little inside them), and a panel is never more than ten messages.
 */
const MAX_EMBEDS_PER_MESSAGE = 10;
const MESSAGE_BUDGET = 5400;
/** The cards of the flights that can be reserved fill at most this many messages; the completed flights get the rest. */
const MAX_OPEN_MESSAGES = 8;
const MAX_COMPLETED_MESSAGES = 2;

/** How many characters Discord counts in an embed, against the 6000 a message may hold. */
export function embedSize(e: EmbedBuilder): number {
  const j = e.toJSON();
  return (
    (j.title?.length ?? 0) +
    (j.description?.length ?? 0) +
    (j.footer?.text.length ?? 0) +
    (j.author?.name.length ?? 0) +
    (j.fields ?? []).reduce((n, f) => n + f.name.length + f.value.length, 0)
  );
}

/** The route in large type, with a plane between the airports. */
const routeHeading = (legs: Array<{ dep: string; arr: string }>): string => `## ${routeText(legs).replace(/ → /g, ' ✈ ')}`;

/** A small labelled box (three sit side by side). */
const box = (name: string, value: string): APIEmbedField => ({ name, value: value || '-', inline: true });

const SCHEDULE_WORD: Record<string, string> = { 'ON-TIME': 'on time', DELAYED: 'delayed', LATE: 'late' };

/** A flight that can be reserved (or already has been), as a card. */
export function openCard(view: JobView, now: number): EmbedBuilder {
  const { job, legs } = view;
  const taken = legs.length > 0 && legs.every((l) => l.holder !== null || l.sheetHolder !== null);
  const title = [job.code, legs.length > 1 ? `${legs.length} legs` : '', job.aircraft ? plainText(truncate(job.aircraft, 20)) : ''].filter(Boolean).join(' · ');
  const about = [job.title, job.notes].filter(Boolean).join(' - ');
  const e = new EmbedBuilder()
    .setColor(taken ? COLORS.taken : COLORS.open)
    .setTitle(title)
    .setDescription([routeHeading(legs), about ? `*${truncate(about, 160)}*` : ''].filter(Boolean).join('\n'));

  const fields: APIEmbedField[] = [];
  if (job.availableFrom !== null && job.availableFrom > now) fields.push(box('OPENS', ts(job.availableFrom, 'f')));
  if (job.deadline !== null) fields.push(box('COMPLETE BY', `${ts(job.deadline, 'f')}\n${ts(job.deadline, 'R')}`));
  if (job.pay) fields.push(box('PAY', plainText(truncate(job.pay, 40))));
  const who = legs.length === 1 ? holderText(legs[0] as LegView) : legs.map((l) => `\`${l.legNo}\` ${legText(l)} — ${holderText(l)}`).join('\n');
  fields.push({ name: legs.length > 1 ? 'PILOTS' : 'PILOT', value: truncate(who, 1000) || '*open*', inline: false });
  // A pilot who has put themselves down to fly it if the pilot who has it can't.
  if (view.backup) fields.push({ name: 'BACKUP', value: pilotText(view.backup), inline: false });
  return e.addFields(fields);
}

/**
 * What a pilot's search found, as the reply to the search form: a header saying what was searched for and how many flights
 * matched, then those flights as the same cards the panel uses (the first few; a long list asks to be narrowed). Only
 * flights the panel itself lists are ever passed in, so the days an admin chose limit the search too.
 */
export function searchEmbeds(panel: Panel, from: string[], to: string[], matches: JobView[], now: number, day?: SearchDay | null, aircraft: string[] = []): EmbedBuilder[] {
  const route = [from.length > 0 ? `from ${from.join(' or ')}` : '', to.length > 0 ? `to ${to.join(' or ')}` : ''].filter(Boolean).join(' ');
  const kind = aircraft.length > 0 ? `in ${aircraft.join(' or ')}` : '';
  const what = [route, day ? `on ${day.label}` : '', kind].filter(Boolean).join(' ');
  const who = [route, kind].filter(Boolean).join(' ');
  const days = `${panel.showDays} day${panel.showDays === 1 ? '' : 's'}`;
  const shown = matches.slice(0, MAX_SEARCH_RESULTS);
  // The flights that count: open at some point on the day asked about, or, with no day, open now or starting within the panel's days.
  const within = day ? `that can be flown on ${day.label} (Zulu time)` : `open now or starting within the next ${days}`;
  const description =
    matches.length === 0
      ? [
          day ? `Nothing ${who ? `${who} ` : ''}can be flown on ${day.label} (Zulu time). The panel lists flights open now or starting within the next ${days}.` : `Nothing ${what} is open now or starts within the next ${days}.`,
          route ? 'Check the airport codes: they are the four-letter ones on the panel (like EGLL), and two or three letters match every airport that starts with them (EG finds EGLL, EGKK and the rest).' : '',
          kind ? 'Aircraft types are the short codes on the cards (like A320 or B738), and a few characters match every type that starts with them (B73 finds B737, B738 and B739).' : '',
        ]
          .filter(Boolean)
          .join('\n')
      : [
          `${matches.length === 1 ? '1 flight matches' : `${matches.length} flights match`}, ${within}.`,
          matches.length > shown.length ? `Showing the first ${shown.length}. Search for something narrower to see the rest.` : '',
          'To take one, press **Reserve** on the panel and reply with its ID.',
        ]
          .filter(Boolean)
          .join('\n');
  const head = new EmbedBuilder().setColor(COLORS.panel).setTitle(`🔎 Flights ${what}`).setDescription(description);
  return [head, ...shown.map((v) => openCard(v, now))];
}

/**
 * A flight that has been completed, as a card: who flew it, and, where FsHub has been seen to confirm it, the aircraft it
 * recorded, when it landed, how it went against its schedule, and FsHub's own number for the flight as a link.
 */
export function completedCard(view: JobView, confirmed?: Map<number, FlownFlight>): EmbedBuilder {
  const { job, legs } = view;
  const flights = confirmed ? [...confirmed.entries()].sort((a, b) => a[0] - b[0]).map(([, f]) => f) : [];
  const single = legs.length === 1 ? flights[0] : undefined;
  const type = single?.aircraftIcao ?? job.aircraft;
  const how = single?.scheduleStatus ? SCHEDULE_WORD[single.scheduleStatus] : '';
  const title = [job.code, legs.length > 1 ? `${legs.length} legs` : '', type ? plainText(truncate(type, 20)) : '', how].filter(Boolean).join(' · ');

  const lines = [routeHeading(legs)];
  if (single?.aircraftName) lines.push(`*${plainText(truncate(single.aircraftName, 40))}*`);
  if (single && job.aircraft && sameAircraft(job.aircraft, single.aircraftIcao) === false) lines.push(`⚠️ scheduled ${plainText(truncate(job.aircraft, 12))}`);
  const e = new EmbedBuilder().setColor(COLORS.success).setTitle(title).setDescription(lines.join('\n'));

  const fields: APIEmbedField[] = [];
  const who = flownBy(view);
  if (who) fields.push(box('FLOWN BY', truncate(who, 300)));
  if (single) fields.push(box('LANDED', ts(single.arrivedAt, 't')));
  if (flights.length > 0) {
    const links = flights.map((f) => fshubFlightLink(f.flightId, single ? `flight #${f.flightId}` : `#${f.flightId}`)).filter(Boolean);
    const text = single ? links.join('') : `${flights.length} of ${legs.length} legs\n${links.join(', ')}`;
    if (text) fields.push(box('FSHUB', text));
  }
  return e.addFields(fields);
}

/** A grey card for a line of explanation among the flights. */
const noteCard = (text: string): EmbedBuilder => new EmbedBuilder().setColor(COLORS.note).setDescription(text);

/** Cards packed into messages: each at most 10 embeds and MESSAGE_BUDGET characters. */
function pack(embeds: Array<{ e: EmbedBuilder; size: number }>): EmbedBuilder[][] {
  const messages: EmbedBuilder[][] = [];
  let current: EmbedBuilder[] = [];
  let size = 0;
  for (const { e, size: n } of embeds) {
    if (current.length > 0 && (current.length >= MAX_EMBEDS_PER_MESSAGE || size + n > MESSAGE_BUDGET)) {
      messages.push(current);
      current = [];
      size = 0;
    }
    current.push(e);
    size += n;
  }
  if (current.length > 0) messages.push(current);
  return messages;
}

/**
 * The header card, then as many flight cards as fit in `maxMessages` messages, then whatever `tail` says about the flights
 * that did not fit (`tail(0)` still says what is always said, such as how many are further off). If the cards do not all
 * fit, the last ones are dropped until the notes fit too.
 */
function layout(head: EmbedBuilder, cards: EmbedBuilder[], tail: (notShown: number) => EmbedBuilder[], maxMessages: number): EmbedBuilder[][] {
  const sized = (e: EmbedBuilder) => ({ e, size: embedSize(e) });
  const headSized = sized(head);
  const cardsSized = cards.map(sized);
  for (let keep = cards.length; keep >= 0; keep--) {
    const messages = pack([headSized, ...cardsSized.slice(0, keep), ...tail(cards.length - keep).map(sized)]);
    if (messages.length <= maxMessages) return messages;
  }
  return [[head]];
}

/** The panel's messages: the flights that can be reserved, then, as a panel of their own, the flights completed lately. Each message is a list of embeds. */
export interface PanelParts {
  open: EmbedBuilder[][];
  completed: EmbedBuilder[][];
}

/**
 * The panel as embeds grouped into messages. The open flights come first, with the instructions on the first card (these
 * messages carry the buttons). Below them is a panel of its own for the flights completed in the last day, so they never
 * crowd the flights that still need a pilot; it is always there, with a line saying so when nothing has been completed.
 * `autoCompletes` says whether flights FsHub shows flown are completed automatically (the instructions then say so).
 * `later` is how many flights were left out because they start beyond the panel's period (`panel.showDays`); a note after the
 * open flights says so. The disclaimer is on the very last card.
 */
export function renderPanelParts(panel: Panel, views: JobView[], now: number, completed: JobView[] = [], confirmations?: Confirmations, autoCompletes = false, later = 0): PanelParts {
  // The example ID is a real one from the panel when there is one (it may be a flight number from the schedule).
  const example = views[0]?.job.code ?? `${panel.prefix}-001`;
  const intro = [
    autoCompletes
      ? `Press **Reserve**, then reply to my DM with a flight ID (like \`${example}\`). Flown it? I complete flights that FsHub shows you flew every hour; press **Complete** to do it now.`
      : `Press **Reserve**, then reply to my DM with a flight ID (like \`${example}\`). Flown it? Press **Complete**.`,
    `Updated ${ts(now, 'R')}.`,
    ...(panel.requiredRoleId ? [`Reserving is open to members with <@&${panel.requiredRoleId}>.`] : []),
  ].join('\n');
  const label = airlineLabel({ name: panel.airlineName, abbr: panel.airlineAbbr });

  const days = `${panel.showDays} day${panel.showDays === 1 ? '' : 's'}`;
  const laterNote =
    later > 0 ? [noteCard(`🗓️ ${later} more flight${later === 1 ? ' starts' : 's start'} more than ${days} from now, and will be listed here once ${later === 1 ? 'it is' : 'they are'} within ${days}.`)] : [];
  const openHead = new EmbedBuilder()
    .setColor(COLORS.panel)
    .setTitle(`✈️ ${label} · open flights`)
    .setDescription(views.length === 0 ? `${intro}\n\nNo flights are listed right now.` : intro);
  const open = layout(
    openHead,
    views.map((v) => openCard(v, now)),
    (notShown) => [...laterNote, ...(notShown > 0 ? [noteCard(`…and ${notShown} more flight${notShown === 1 ? '' : 's'} not shown.`)] : [])],
    MAX_OPEN_MESSAGES,
  );

  const doneHead = new EmbedBuilder()
    .setColor(COLORS.success)
    .setTitle(`✅ ${label} · completed flights`)
    .setDescription(completed.length === 0 ? 'Nothing has been completed in the last 24 hours.' : 'Completed in the last 24 hours.');
  const done = layout(
    doneHead,
    completed.map((v) => completedCard(v, confirmations?.get(v.job.id))),
    (notShown) => (notShown > 0 ? [noteCard(`…and ${notShown} more.`)] : []),
    MAX_COMPLETED_MESSAGES,
  );
  (done[done.length - 1] as EmbedBuilder[])[(done[done.length - 1] as EmbedBuilder[]).length - 1]!.setFooter({ text: FOOTER });
  return { open, completed: done };
}

/** Every embed of the panel in the order it is posted. */
export function renderPanel(panel: Panel, views: JobView[], now: number, completed: JobView[] = [], confirmations?: Confirmations, autoCompletes = false, later = 0): EmbedBuilder[] {
  const parts = renderPanelParts(panel, views, now, completed, confirmations, autoCompletes, later);
  return [...parts.open.flat(), ...parts.completed.flat()];
}

/* ------------------------------------------------------------------ "pilots needed" announcements */

/** Who an announcement pings: the text to put in the message, and the mentions Discord should actually honour. */
export interface ReminderTarget {
  text: string;
  allowed: MessageMentionOptions;
}

/** Null when the panel has reminders turned off. */
export function reminderTarget(panel: Panel): ReminderTarget | null {
  if (panel.reminderMode === 'off') return null;
  const roleId = panel.reminderMode === 'role' ? panel.reminderRoleId : panel.requiredRoleId;
  if (roleId) return { text: `<@&${roleId}>`, allowed: { roles: [roleId] } };
  return { text: '@here', allowed: { parse: ['everyone'] } };
}

/** At most this many flights are listed in one announcement; the rest are on the panel. */
export const MAX_REMINDER_FLIGHTS = 12;

function reminderLine(r: Reminder, now: number): string {
  const { view, openLegs, startsAt } = r;
  const { job, legs } = view;
  const head = [`**${job.code}**`, legs.length > 1 ? `${routeText(legs)} (${legs.length} legs)` : routeText(legs)];
  if (job.aircraft) head.push(`✈ ${job.aircraft}`);
  const when =
    startsAt > now
      ? `🕐 starts ${ts(startsAt, 'f')} (${ts(startsAt, 'R')})`
      : job.deadline !== null
        ? `⏰ complete by ${ts(job.deadline, 'f')} (${ts(job.deadline, 'R')})`
        : '';
  const partial = legs.length > 1 && openLegs.length < legs.length ? `${openLegs.length === 1 ? 'leg' : 'legs'} ${legList(openLegs)} still open` : '';
  return [head.join(' · '), [when, partial].filter(Boolean).join(' · ')].filter(Boolean).join('\n');
}

/** The channel message asking pilots to take flights that have nobody on them. Null if reminders are off. */
export function renderReminder(panel: Panel, due: Reminder[], now: number) {
  const target = reminderTarget(panel);
  if (!target || due.length === 0) return null;
  const shown = due.slice(0, MAX_REMINDER_FLIGHTS);
  const hidden = due.length - shown.length;
  const many = due.length > 1;
  const description = [
    shown.map((r) => reminderLine(r, now)).join('\n\n'),
    ...(hidden > 0 ? [`…and ${hidden} more without a pilot, listed on the panel.`] : []),
    `Can you take ${many ? 'one' : 'it'}? Press **Reserve** below and reply to my DM with the flight ID.`,
  ].join('\n\n');
  return {
    content: `${target.text} ✈️ ${due.length} flight${many ? 's' : ''} ${many ? 'have' : 'has'} no pilot yet and ${many ? 'start' : 'starts'} within 24 hours.`,
    embeds: [
      new EmbedBuilder()
        .setColor(COLORS.error)
        .setTitle(`🛫 Pilots needed · ${airlineLabel({ name: panel.airlineName, abbr: panel.airlineAbbr })}`)
        .setDescription(description)
        .setFooter({ text: FOOTER }),
    ],
    components: [panelButtons(panel.id)],
    allowedMentions: target.allowed,
  };
}

/** The Reserve / My flights buttons that sit under every message of the panel. */
export function panelButtons(panelId: number): ActionRowBuilder<MessageActionRowComponentBuilder> {
  return new ActionRowBuilder<MessageActionRowComponentBuilder>().addComponents(
    new ButtonBuilder().setCustomId(`panel:reserve:${panelId}`).setLabel('Reserve').setEmoji('🛫').setStyle(ButtonStyle.Primary),
    new ButtonBuilder().setCustomId(`panel:search:${panelId}`).setLabel('Search').setEmoji('🔎').setStyle(ButtonStyle.Secondary),
    new ButtonBuilder().setCustomId(`panel:backup:${panelId}`).setLabel('Backup pilot').setEmoji('🛟').setStyle(ButtonStyle.Secondary),
    new ButtonBuilder().setCustomId(`panel:mine:${panelId}`).setLabel('My flights').setEmoji('📋').setStyle(ButtonStyle.Secondary),
    new ButtonBuilder().setCustomId(`panel:complete:${panelId}`).setLabel('Complete').setEmoji('✅').setStyle(ButtonStyle.Success),
  );
}
