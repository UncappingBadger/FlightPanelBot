import {
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  EmbedBuilder,
  type MessageActionRowComponentBuilder,
  type MessageMentionOptions,
} from 'discord.js';
import type { Holder, JobView, LegView, Panel } from '../db/store.js';
import type { Reminder } from '../services/reminders.js';
import { airlineLabel, legList, legText, mention, plainText, routeText, truncate, ts } from '../util/format.js';

export const COLORS = {
  panel: 0x5865f2,
  success: 0x2ecc71,
  info: 0x3498db,
  error: 0xe74c3c,
} as const;

/** True when running `npm run demo`: fictional jobs, not real data. Set before the bot loads. */
export const DEMO = process.env.AEROBOT_DEMO === '1';

export const FOOTER = DEMO
  ? '🧪 DEMO MODE · fictional airlines and flights'
  : 'Unofficial companion bot · not affiliated with FsHub or Aeroconomy';

/** Never ping anyone from a panel or DM; mentions here only name people. */
export const noPings = { parse: [] as never[] };

/** Stay well inside Discord's 4096-character embed description limit. */
const PAGE_BUDGET = 3600;
/** A panel is at most this many messages; beyond that a "N more" line is shown. */
const MAX_PAGES = 10;

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
 * so a manager can match the account to the airline's roster even when the names differ.
 */
function pilotText(holder: Holder): string {
  return holder.fshubId !== null ? `${mention(holder.discordId)} · FsHub #${holder.fshubId}` : mention(holder.discordId);
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

/** At most this many completed flights are listed; the rest are summarised. */
export const MAX_COMPLETED_SHOWN = 15;

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

/** A completed flight as one short line. */
export function completedLine(view: JobView): string {
  const parts = [`✅ **${view.job.code}**`, routeText(view.legs)];
  if (view.job.aircraft) parts.push(`✈ ${view.job.aircraft}`);
  const who = flownBy(view);
  if (who) parts.push(`flown by ${who}`);
  return parts.join(' · ');
}

/** The "completed" section of the panel, or an empty string if nothing was completed recently. */
export function completedBlock(views: JobView[]): string {
  if (views.length === 0) return '';
  const shown = views.slice(0, MAX_COMPLETED_SHOWN);
  const more = views.length - shown.length;
  return ['**✅ Completed in the last 24 hours**', ...shown.map(completedLine), ...(more > 0 ? [`…and ${more} more.`] : [])].join('\n');
}

/**
 * The panel as embeds, one per message, filled up to a character budget. The first carries the
 * title and instructions. Returns at least one embed, even with no jobs. Flights completed in the
 * last day, if any, are listed after the open ones.
 */
export function renderPanel(panel: Panel, views: JobView[], now: number, completed: JobView[] = []): EmbedBuilder[] {
  const intro = [
    `Press **Reserve**, then reply to my DM with a flight ID (like \`${panel.prefix}-001\`). Flown it? Press **Complete**.`,
    `Updated ${ts(now, 'R')}.`,
    ...(panel.requiredRoleId ? [`Reserving is open to members with <@&${panel.requiredRoleId}>.`] : []),
  ].join('\n');

  const pages: string[] = [];
  let current = '';
  let shown = 0;
  for (const view of views) {
    const block = jobBlock(view, now);
    const sep = current ? '\n\n' : '';
    if (current && current.length + sep.length + block.length > PAGE_BUDGET) {
      pages.push(current);
      current = '';
      if (pages.length >= MAX_PAGES) break;
    }
    current += (current ? '\n\n' : '') + block;
    shown++;
  }
  const done = completedBlock(completed);
  if (done && pages.length < MAX_PAGES) {
    if (views.length === 0) current = 'No flights are listed right now.';
    if (current && current.length + 2 + done.length > PAGE_BUDGET) {
      pages.push(current);
      current = '';
    }
    if (pages.length < MAX_PAGES) current += (current ? '\n\n' : '') + done;
  }
  if (current && pages.length < MAX_PAGES) pages.push(current);
  const hidden = views.length - shown;
  if (hidden > 0 && pages.length > 0) pages[pages.length - 1] += `\n\n…and ${hidden} more flights not shown.`;

  const title = `✈️ ${airlineLabel({ name: panel.airlineName, abbr: panel.airlineAbbr })} · open flights`;
  if (pages.length === 0) {
    return [
      new EmbedBuilder()
        .setColor(COLORS.panel)
        .setTitle(title)
        .setDescription(`${intro}\n\nNo flights are listed right now.`)
        .setFooter({ text: FOOTER }),
    ];
  }
  return pages.map((text, i) => {
    const e = new EmbedBuilder().setColor(COLORS.panel).setDescription(i === 0 ? `${intro}\n\n${text}` : text);
    if (i === 0) e.setTitle(title);
    if (i === pages.length - 1) e.setFooter({ text: FOOTER });
    return e;
  });
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
    new ButtonBuilder().setCustomId(`panel:mine:${panelId}`).setLabel('My flights').setEmoji('📋').setStyle(ButtonStyle.Secondary),
    new ButtonBuilder().setCustomId(`panel:complete:${panelId}`).setLabel('Complete').setEmoji('✅').setStyle(ButtonStyle.Success),
  );
}
