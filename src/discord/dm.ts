import {
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  MessageFlags,
  ModalBuilder,
  StringSelectMenuBuilder,
  TextInputBuilder,
  TextInputStyle,
  type ButtonInteraction,
  type Message,
  type MessageActionRowComponentBuilder,
  type ModalSubmitInteraction,
  type StringSelectMenuInteraction,
} from 'discord.js';
import type { DmSession, FlownFlight, Holder, JobView, Panel, SessionPurpose } from '../db/store.js';
import { str } from '../jobs/import.js';
import { confirmationsFor, landingWindow } from '../services/flightMatch.js';
import { andList, beyondDaysManyText, beyondDaysText, JobError, MAX_IDS_AT_ONCE, type FoundIds, type ReserveResult } from '../services/jobs.js';
import { switchRemarks } from '../services/hardLanding.js';
import { looksLikeMetar } from '../services/metar.js';
import { parsePilotId } from '../services/pilotId.js';
import { sheetNamesFor } from '../services/pilotNames.js';
import { aliasNote, expandAircraftTypes } from '../services/aircraftAliases.js';
import { availableFor } from '../services/availability.js';
import { dayOf, MAX_SEARCH_RESULTS, parseAircraftTypes, parseAirportCodes, parseSearchDate, type SearchDay } from '../services/search.js';
import { WriteBackError } from '../services/writeback.js';
import { legList, legText, mention, plainText, routeText, truncate, ts } from '../util/format.js';
import type { BotContext, ComponentHandler, ComponentInteraction } from './context.js';
import { CONTRIBUTIONS_REQUEST, showContributions } from './contributions.js';
import { isDmClosed, UserError } from './errors.js';
import { memberHasRole } from './guard.js';
import { handleGridAction } from './gridHandlers.js';
import { MAX_FOLLOWERS } from './panel.js';
import { avatarIdsOf, flightFacts, noPings, jobBlock, searchEmbeds, stampFiles } from './ui.js';
import { NOTICES_REQUEST, showNotices } from './notices.js';
import { METAR_REQUEST, showMetar } from './weather.js';

/** How long a Reserve conversation stays open. */
export const SESSION_TTL_MS = 10 * 60_000;
/** Wrong flight IDs allowed before the conversation is closed. */
export const MAX_ATTEMPTS = 5;

const CANCEL_WORDS = new Set(['cancel', 'stop', 'quit', 'exit', 'nevermind', 'never mind']);
const HINT_COOLDOWN_MS = 5 * 60_000;
const lastHint = new Map<string, number>();

type Row = ActionRowBuilder<MessageActionRowComponentBuilder>;
const button = (id: string, label: string, style: ButtonStyle) => new ButtonBuilder().setCustomId(id).setLabel(label).setStyle(style);
const row = (...b: ButtonBuilder[]): Row => new ActionRowBuilder<MessageActionRowComponentBuilder>().addComponents(b);

/* ------------------------------------------------------------------ wording */

const legsPhrase = (nos: number[], view: JobView) =>
  `${nos.length === 1 ? 'leg' : 'legs'} ${nos.map((n) => `${n} (${legText(view.legs.find((l) => l.legNo === n) ?? { dep: '?', arr: '?' })})`).join(nos.length === 2 ? ' and ' : ', ')}`;

/** Who a leg belongs to, for "already taken by …": a Discord reservation, or a name in the airline's own schedule. */
function takenBy(t: { holder: Holder | null; sheetHolder: string | null }): string {
  if (t.holder) return mention(t.holder.discordId);
  return `**${plainText(truncate(t.sheetHolder ?? 'someone', 40))}** (named in the airline's schedule)`;
}

/** What happened to one flight when someone tried to reserve it, a line for each thing that happened. */
function outcomeLines(res: ReserveResult): string[] {
  const view = res.job;
  const code = view.job.code;
  const single = view.legs.length === 1;
  const lines: string[] = [];

  if (res.reserved.length > 0) {
    lines.push(single ? `✅ **${code}** (${legText(view.legs[0]!)}) is reserved for you.` : `✅ **${code}**: you've got ${legsPhrase(res.reserved, view)}.`);
  }
  if (res.alreadyMine.length > 0) {
    lines.push(single ? `ℹ️ You already had **${code}**.` : `ℹ️ You already held ${legsPhrase(res.alreadyMine, view)} of **${code}**.`);
  }
  for (const t of res.taken) {
    lines.push(`⚠️ ${single ? `**${code}** is` : `Leg ${t.legNo} (${legText(view.legs.find((l) => l.legNo === t.legNo) ?? { dep: '?', arr: '?' })}) is`} already taken by ${takenBy(t)}.`);
  }
  return lines;
}

/** The closing line of a reservation's outcome: the panel has been updated, or nothing was reserved (said nothing when the person already had what they asked for). */
const outcomeFooter = (reservedAny: boolean, alreadyMineAny: boolean): string | null =>
  reservedAny ? 'The panel has been updated with your name.' : alreadyMineAny ? null : 'Nothing was reserved.';

/** What happened when someone tried to reserve, in plain words. */
export function outcomeText(res: ReserveResult): string {
  const footer = outcomeFooter(res.reserved.length > 0, res.alreadyMine.length > 0);
  return [...outcomeLines(res), ...(footer ? [footer] : [])].join('\n');
}

/** An ID to give as an example: that of a flight that is really on the panel (it may be a flight number from the schedule), else the automatic form. */
const exampleId = (ctx: BotContext, panel: Panel): string => ctx.jobs.listed(panel)[0]?.job.code ?? `${panel.prefix}-001`;

/** A second example, so the line about sending several IDs at once can show what that looks like; null when the panel lists only one flight. */
const exampleTwoIds = (ctx: BotContext, panel: Panel): string | null => {
  const [a, b] = ctx.jobs.listed(panel);
  return a && b ? `${a.job.code}, ${b.job.code}` : null;
};

const askCodeText = (ctx: BotContext, panel: Panel) => {
  const two = exampleTwoIds(ctx, panel);
  return [
    `**Reserve a flight for ${panel.airlineName}.**`,
    `Reply with the flight ID shown on the panel, for example \`${exampleId(ctx, panel)}\`.${two ? ` To reserve several at once, send their IDs in one message, like \`${two}\`.` : ''}`,
    'Say `cancel` to stop. This conversation closes in 10 minutes.',
  ].join('\n');
};

/** An ID to give as an example when standing by: a flight this person could really be the backup for, else any on the panel. */
const exampleBackupId = (ctx: BotContext, panel: Panel, discordId: string): string => ctx.jobs.backupCandidates(panel, discordId)[0]?.job.code ?? exampleId(ctx, panel);

/** The question the Backup pilot button asks, the same way Reserve asks for the flight it wants. */
const askBackupCodeText = (ctx: BotContext, panel: Panel, discordId: string) =>
  [
    `**Stand by as backup for ${panel.airlineName}.**`,
    `Reply with the ID of the flight you'd fly if the pilot who has it can't, for example \`${exampleBackupId(ctx, panel, discordId)}\`. It has to be a flight that is already taken, and not one you're flying yourself.`,
    'Say `cancel` to stop. This conversation closes in 10 minutes.',
  ].join('\n');

/** The button that starts a conversation, as it is named when telling someone to press it again. */
const startButton = (purpose: SessionPurpose): string => (purpose === 'backup' ? '**Backup pilot**' : '**Reserve**');

/**
 * Asked once, the first time someone reserves a flight (and again only if they never answered).
 * `checked` is whether the bot can look the ID up on FsHub, which changes what it promises.
 */
const askPilotIdText = (panel: Panel, checked: boolean, purpose: SessionPurpose = 'reserve') =>
  [
    `**${purpose === 'backup' ? 'Stand by as backup' : 'Reserve a flight'} for ${panel.airlineName}.** First, what is your FsHub pilot ID?`,
    "Your managers use it to match you to the airline's roster. It is the number in your FsHub profile address: for fshub.io/pilot/**1234**/overview it is `1234`. Reply with the number, or paste the link to your profile.",
    checked
      ? "I'll check it with FsHub, tell you whose profile it is, and show the number next to your name on the flights you take. You can change it any time by sending me `fshub <your ID>`."
      : "I'll remember it and show it next to your name on the flights you take. I don't check it with FsHub, so make sure it's right. You can change it any time by sending me `fshub <your ID>`.",
    'Say `cancel` to stop. This conversation closes in 10 minutes.',
  ].join('\n');

/* ------------------------------------------------------------------ the airline's sheet */

type Person = { id: string; username: string; globalName?: string | null };

const sameName = (a: string, b: string) => a.trim().toLowerCase() === b.trim().toLowerCase();

/** What a pilot is called in the airline's sheet: what they have told me, otherwise what Discord calls them. */
function pilotNameFor(ctx: BotContext, user: Person): string {
  return ctx.store.getPilotName(user.id) ?? str(user.globalName ?? user.username, 40) ?? user.username;
}

/** Is this panel's sheet written to? The bot needs Google credentials, an admin must not have switched it off, and a sheet row is one leg. */
function writesToSheet(ctx: BotContext, panel: Panel, legCount: number): boolean {
  return Boolean(ctx.writeback?.enabledFor(panel)) && legCount === 1;
}

/**
 * Reserve legs for someone and, where the panel keeps its schedule in a Google Sheet the bot can
 * write to, put their name against the flight there. If the sheet already names someone else (or
 * shows the flight finished), the reservation is undone and the person is told. If the sheet can't
 * be reached the reservation stands, and the person is told it isn't in the sheet yet.
 */
async function reserveFor(ctx: BotContext, user: Person, jobId: number, legNos: number[]): Promise<string> {
  const { res, sheet } = await reserveAndClaim(ctx, user, jobId, legNos);
  const code = res.job.job.code;
  switch (sheet.kind) {
    case 'none':
      return outcomeText(res);
    case 'undone':
      return `⚠️ ${sheet.message} So I haven't reserved **${code}** for you.`;
    case 'unreachable':
      return `${outcomeText(res)}\n⚠️ I couldn't update the airline's sheet (${sheet.message}), so it doesn't show your name yet. Please ask a manager to add you to **${code}** there.`;
    case 'written':
      return `${outcomeText(res)}\n📝 I've put **${plainText(sheet.name)}** against it in the airline's sheet. Not how you appear there? Reply \`name <your name>\` and I'll use that from now on.`;
  }
}

/** What happened in the airline's sheet when a reservation was made. */
type SheetResult =
  | { kind: 'none' } // the sheet is not involved (no write-back, several legs), or nothing was reserved
  | { kind: 'written'; name: string } // the person's name is against the flight there
  | { kind: 'undone'; message: string } // the sheet already names someone else, or shows the flight finished: the reservation was undone
  | { kind: 'unreachable'; message: string }; // the sheet could not be written to: the reservation stands

/** Reserve the legs, and put the pilot's name in the airline's sheet where that is kept (see `reserveFor`). */
async function reserveAndClaim(ctx: BotContext, user: Person, jobId: number, legNos: number[]): Promise<{ res: ReserveResult; sheet: SheetResult }> {
  const res = ctx.jobs.reserve(jobId, legNos, { discordId: user.id, username: user.username });
  const panel = ctx.store.getPanel(res.job.job.panelId);
  if (res.reserved.length === 0 || !panel || !writesToSheet(ctx, panel, res.job.legs.length)) return { res, sheet: { kind: 'none' } };

  const job = res.job.job;
  const name = pilotNameFor(ctx, user);
  try {
    await ctx.writeback!.claim(panel, job.sourceKey, name);
  } catch (e) {
    if (!(e instanceof WriteBackError)) throw e;
    if (e.code === 'CONFLICT' || e.code === 'CLOSED') {
      // Someone got there first in the sheet. The sheet is the airline's record, so it wins.
      if (e.code === 'CONFLICT' && e.existing) ctx.store.setLegSheetHolder(job.id, 1, truncate(e.existing, 40));
      ctx.jobs.release(job.id, user.id, res.reserved);
      return { res, sheet: { kind: 'undone', message: e.message } };
    }
    ctx.log.warn(`Could not write ${job.code} to the sheet: ${e.message}`);
    return { res, sheet: { kind: 'unreachable', message: e.message } };
  }
  for (const legNo of res.reserved) ctx.store.setReservationSheetName(job.id, legNo, name);
  return { res, sheet: { kind: 'written', name } };
}

/** After legs are given back: take the name the bot wrote off the sheet. Best effort; the sheet is the airline's, so failures are only noted. */
async function clearFromSheet(ctx: BotContext, panelId: number, sourceKey: string, name: string): Promise<'cleared' | 'left' | 'failed'> {
  const panel = ctx.store.getPanel(panelId);
  if (!panel || !ctx.writeback?.enabledFor(panel)) return 'left';
  try {
    return (await ctx.writeback.unclaim(panel, sourceKey, name)) ? 'cleared' : 'left';
  } catch (e) {
    ctx.log.warn(`Could not take ${name} off the sheet: ${e instanceof Error ? e.message : e}`);
    return 'failed';
  }
}

/** Save a FsHub pilot ID (and the name FsHub has for it, if that was looked up), and redraw the panels that show it. */
export function rememberPilotId(ctx: BotContext, discordId: string, fshubId: number, name: string | null = null): void {
  ctx.store.setPilotId(discordId, fshubId, ctx.now(), name);
  for (const panelId of ctx.store.listPanelIdsHeldBy(discordId)) ctx.panels.schedule(panelId);
}

/**
 * What FsHub says about an ID someone typed.
 * - `found`: a pilot with that ID exists; `name` is theirs
 * - `missing`: FsHub has no such pilot, so it was most likely mistyped
 * - `unchecked`: FsHub could not be asked (no token saved, offline, busy). The ID is taken as typed, as it always was.
 */
export type PilotCheck = { status: 'found'; name: string } | { status: 'missing' } | { status: 'unchecked' };

export async function checkPilotId(ctx: BotContext, id: number): Promise<PilotCheck> {
  if (!ctx.fshub) return { status: 'unchecked' };
  try {
    const pilot = await ctx.fshub.pilot(id);
    return pilot ? { status: 'found', name: pilot.name } : { status: 'missing' };
  } catch (e) {
    // A FsHub hiccup must never stop someone reserving a flight.
    ctx.log.warn(`Could not check FsHub pilot ${id}: ${e instanceof Error ? e.message : e}`);
    return { status: 'unchecked' };
  }
}

const noSuchPilotText = (id: number) =>
  `FsHub has no pilot with the ID **${id}**, so it may have a typo. The number is in your profile address: fshub.io/pilot/**1234**/overview.`;

/** "**1234** (Name on FsHub)" or just "**1234**". */
export const pilotLabel = (id: number, name: string | null) => (name ? `**${id}** (${plainText(truncate(name, 40))} on FsHub)` : `**${id}**`);

/** `fshub <ID or link>` in a DM: the pilot's FsHub pilot ID, shown beside their name on the flights they hold. */
async function setPilotIdFromDm(ctx: BotContext, user: Person & { send: Message['author']['send'] }, raw: string): Promise<void> {
  const id = parsePilotId(raw);
  if (id === null) {
    const current = ctx.store.getPilotId(user.id);
    await say(
      user,
      `Tell me your FsHub pilot ID like this: \`fshub 1234\`. It is the number in your profile address, fshub.io/pilot/**1234**/overview.${current !== null ? ` I currently have **${current}** for you.` : ''}`,
    );
    return;
  }
  const check = await checkPilotId(ctx, id);
  if (check.status === 'missing') {
    await say(user, `${noSuchPilotText(id)} I haven't changed anything.`);
    return;
  }
  const name = check.status === 'found' ? check.name : null;
  rememberPilotId(ctx, user.id, id, name);
  await say(user, `Okay, your FsHub pilot ID is ${pilotLabel(id, name)}. It shows next to your name on your flights.${name ? ' Not you? Send `fshub <your ID>` with the right one.' : ''}`);
}

/** `name <something>` in a DM: what the pilot is called in airline sheets from now on. Names already written there are changed too. */
async function renamePilot(ctx: BotContext, user: Person & { send: Message['author']['send'] }, raw: string): Promise<void> {
  const name = str(raw, 40);
  if (!name) {
    await say(user, 'Tell me the name like this: `name Alex Smith`.');
    return;
  }
  ctx.store.setPilotName(user.id, name, ctx.now());
  let moved = 0;
  let failed = 0;
  for (const r of ctx.store.listSheetReservationsByUser(user.id)) {
    const panel = ctx.store.getPanel(r.panelId);
    if (sameName(r.sheetName, name) || !panel || !ctx.writeback?.enabledFor(panel)) continue;
    try {
      if (await ctx.writeback.rename(panel, r.sourceKey, r.sheetName, name)) {
        ctx.store.setReservationSheetName(r.jobId, r.legNo, name);
        moved++;
      }
    } catch (e) {
      failed++;
      ctx.log.warn(`Could not rename ${r.sheetName} in the sheet: ${e instanceof Error ? e.message : e}`);
    }
  }
  // The same for the flights they stand by as backup for, where their name is in the Backup Pilot cell.
  for (const b of ctx.store.listSheetBackupsByUser(user.id)) {
    const panel = ctx.store.getPanel(b.panelId);
    if (sameName(b.sheetName, name) || !panel || !ctx.writeback?.enabledFor(panel)) continue;
    try {
      if (await ctx.writeback.renameBackup(panel, b.sourceKey, b.sheetName, name)) {
        ctx.store.setBackupSheetName(b.jobId, user.id, name);
        moved++;
      }
    } catch (e) {
      failed++;
      ctx.log.warn(`Could not rename ${b.sheetName} as a backup in the sheet: ${e instanceof Error ? e.message : e}`);
    }
  }
  await say(
    user,
    [
      `Okay, I'll call you **${plainText(name)}** in airline sheets from now on.`,
      moved > 0 ? `I've changed it on ${moved} flight${moved === 1 ? '' : 's'} you already had in the sheet.` : '',
      failed > 0 ? `⚠️ I couldn't change it on ${failed} flight${failed === 1 ? '' : 's'}; please ask a manager.` : '',
    ]
      .filter(Boolean)
      .join('\n'),
  );
}

/* ------------------------------------------------------------------ starting (panel buttons) */

/** The Reserve button: open a DM conversation asking for the flight ID. */
async function startReservation(ctx: BotContext, interaction: ButtonInteraction, panelId: number): Promise<void> {
  await interaction.deferReply({ flags: MessageFlags.Ephemeral });
  const panel = panelFor(ctx, interaction, panelId);
  if (panel.requiredRoleId && !memberHasRole(interaction, panel.requiredRoleId)) {
    throw new UserError(`Reserving flights for **${panel.airlineName}** is limited to members with the <@&${panel.requiredRoleId}> role.`);
  }
  if (ctx.jobs.listed(panel).length === 0) throw new UserError('There are no open flights to reserve right now.');

  const user = interaction.user;
  // If the airline's sheet will carry this person's name, start from their server nickname (they can change it with `name …`).
  if (ctx.writeback?.enabledFor(panel) && !ctx.store.getPilotName(user.id)) {
    const member = interaction.member;
    const nickname = member && 'displayName' in member ? member.displayName : null;
    ctx.store.setPilotName(user.id, str(nickname ?? user.globalName ?? user.username, 40) ?? user.username, ctx.now());
  }
  // Someone who hasn't told me their FsHub pilot ID is asked for it first; after that it's straight to the flight.
  const needsPilotId = ctx.store.getPilotId(user.id) === null;
  ctx.store.upsertSession({ discordId: user.id, panelId, step: needsPilotId ? 'await_pilot' : 'await_code', expiresAt: ctx.now() + SESSION_TTL_MS });
  try {
    const dm = await user.send({ content: needsPilotId ? askPilotIdText(panel, ctx.fshub !== null) : askCodeText(ctx, panel), allowedMentions: noPings });
    await interaction.editReply({
      content: `📬 I've sent you a DM. Reply there with ${needsPilotId ? 'your FsHub pilot ID, then the ID of the flight you want' : 'the ID of the flight you want'}.\nhttps://discord.com/channels/@me/${dm.channelId}`,
    });
  } catch (e) {
    ctx.store.deleteSession(user.id);
    if (isDmClosed(e)) {
      throw new UserError("I couldn't send you a DM. Allow direct messages from server members (Server name → Privacy Settings), then press **Reserve** again.");
    }
    throw e;
  }
}

/**
 * When a flight opens and when it must be completed by, each with the day of the week and in the reader's own timezone
 * (Discord does that for these timestamps: the `F` style reads "Friday, 13 November 2026 12:00"). The opening time reads
 * "opens" while it is still ahead and "opened" once it has passed.
 */
function whenText(job: { availableFrom: number | null; deadline: number | null }, now: number): string {
  const parts: string[] = [];
  if (job.availableFrom !== null) parts.push(`🕐 ${job.availableFrom > now ? 'opens' : 'opened'} ${ts(job.availableFrom, 'F')} (${ts(job.availableFrom, 'R')})`);
  if (job.deadline !== null) parts.push(`⏰ complete by ${ts(job.deadline, 'F')} (${ts(job.deadline, 'R')})`);
  return parts.join(' · ');
}

/**
 * What a pilot holds on one panel, as the message the My flights button and the `flights` DM both show: each flight with
 * its deadline (and what FsHub shows of it), the flights they are down as backup for, and a menu to give any back. Null
 * when they hold nothing there. (The text is kept inside what one message can carry.)
 */
function myFlightsMessage(ctx: BotContext, panel: Panel, userId: string): { content: string; components: Row[] } | null {
  const views = ctx.jobs.mine(panel.id, userId);
  const backups = ctx.jobs.myBackups(panel.id, userId);
  if (views.length === 0 && backups.length === 0) return null;
  const options = [
    ...views.flatMap((v) =>
      v.legs.map((l) => ({
        label: truncate(`${v.job.code} · ${v.legs.length > 1 ? `leg ${l.legNo} ` : ''}${legText(l)}`, 100),
        value: `${v.job.id}:${l.legNo}`,
      })),
    ),
    ...backups.map((v) => ({ label: truncate(`${v.job.code} · stand down as backup (${routeText(v.legs)})`, 100), value: `b:${v.job.id}` })),
  ];
  const seen = fshubSeen(ctx, panel, views);
  const lines = views.map((v) => {
    const mine = v.legs.map((l) => `${v.legs.length > 1 ? `leg ${l.legNo}: ` : ''}${legText(l)}`).join(', ');
    // Discord shows these in each person's own timezone. (Dropdown captions can't, which is why the time lives here.)
    const when = whenText(v.job, ctx.now());
    const base = `**${v.job.code}** · ${mine}${when ? ` · ${when}` : ''}`;
    const flown = seen.get(v.job.id);
    return flown ? `${base}\n${flown.map((f) => `↳ ${f}`).join('\n')}` : base;
  });
  const backupLines = backups.map(
    (v) => `**${v.job.code}** · ${routeText(v.legs)}${whenText(v.job, ctx.now()) ? ` · ${whenText(v.job, ctx.now())}` : ''}\n↳ 🛟 You're the backup, if the pilot who has it can't fly it.`,
  );
  const all = [...lines, ...backupLines];
  const kept: string[] = [];
  let size = 0;
  for (const line of all) {
    if (size + line.length + 1 > 1400) break;
    kept.push(line);
    size += line.length + 1;
  }
  const more = all.length - kept.length;
  const menu = new StringSelectMenuBuilder()
    .setCustomId(`panel:release:${panel.id}`)
    .setPlaceholder(backups.length > 0 ? 'Release a flight or stand down…' : 'Release a flight…')
    .setMinValues(1)
    .setMaxValues(Math.min(options.length, 25))
    .addOptions(options.slice(0, 25));
  return {
    content: `**Your flights**\n${kept.join('\n')}${more > 0 ? `\n…and ${more} more.` : ''}\n\n${seen.size > 0 ? 'FsHub shows you have flown some of these: press **Complete** under the panel to mark them done. ' : ''}Pick any you can no longer fly to give them back.`,
    components: [new ActionRowBuilder<MessageActionRowComponentBuilder>().addComponents(menu)],
  };
}

/** The My flights button: list what the person holds, with a menu to release some. */
async function showMine(ctx: BotContext, interaction: ButtonInteraction, panelId: number): Promise<void> {
  await interaction.deferReply({ flags: MessageFlags.Ephemeral });
  const panel = panelFor(ctx, interaction, panelId);

  const mine = myFlightsMessage(ctx, panel, interaction.user.id);
  if (!mine) {
    await interaction.editReply({ content: "You haven't reserved anything on this panel yet. Press **Reserve** to pick a flight." });
    return;
  }
  await interaction.editReply({ content: `${mine.content}${pilotIdNote(ctx, interaction.user.id)}`, components: mine.components, allowedMentions: noPings });
}

/** At most this many panels' lists are sent in answer to one `flights` DM. */
const MAX_PANELS_LISTED = 5;

/**
 * `flights` in a DM: every flight the person has reserved (or is backup for) on any panel of this bot, one message for each
 * panel, each with the menu to give flights back. They are shown the same as under the panel's My flights button.
 */
async function listMyFlights(ctx: BotContext, user: Message['author']): Promise<void> {
  const ids = new Set([...ctx.store.listPanelIdsHeldBy(user.id), ...ctx.store.listPanelIdsBackedBy(user.id)]);
  const lists = [...ids]
    .map((id) => ctx.store.getPanel(id))
    .filter((p): p is Panel => p !== null)
    .sort((a, b) => a.airlineName.localeCompare(b.airlineName))
    .map((panel) => ({ panel, mine: myFlightsMessage(ctx, panel, user.id) }))
    .filter((x): x is { panel: Panel; mine: { content: string; components: Row[] } } => x.mine !== null);
  if (lists.length === 0) {
    await say(user, "You haven't reserved any flights right now. Press **Reserve** on a flight panel in your server to pick one. (Flights you've already completed aren't listed.)");
    return;
  }
  const shown = lists.slice(0, MAX_PANELS_LISTED);
  for (const [i, { panel, mine }] of shown.entries()) {
    const last = i === shown.length - 1;
    await user.send({
      content: `**${plainText(truncate(panel.airlineName, 60))}**\n${mine.content}${last ? pilotIdNote(ctx, user.id) : ''}${last && lists.length > shown.length ? `\n…and flights on ${lists.length - shown.length} more panel${lists.length - shown.length === 1 ? '' : 's'}.` : ''}`,
      components: mine.components,
      allowedMentions: noPings,
    });
  }
}

/** What people type to ask for their flights: `flights`, `my flights`, `list`, `show my flights`, `my reservations`... */
const LIST_REQUEST = /^(?:(?:show|list|get|send)\s+(?:me\s+)?)?(?:my\s+)?(?:flights?|reservations?|bookings?)(?:\s+list)?\s*[?!.]*$|^(?:list|mine|my\s+list)\s*[?!.]*$/i;

/* ------------------------------------------------------------------ search */

/** The Search button: a small form asking where from, where to, on which day and in which aircraft. Each is optional, but one is needed. */
async function startSearch(ctx: BotContext, interaction: ButtonInteraction, panelId: number): Promise<void> {
  const panel = panelFor(ctx, interaction, panelId);
  const input = (id: string, label: string, placeholder: string) =>
    new ActionRowBuilder<TextInputBuilder>().addComponents(
      new TextInputBuilder().setCustomId(id).setLabel(label).setPlaceholder(placeholder).setStyle(TextInputStyle.Short).setRequired(false).setMaxLength(40),
    );
  const modal = new ModalBuilder()
    .setCustomId(`panel:searchgo:${panelId}`)
    .setTitle('Find a flight')
    .addComponents(
      input('from', 'Flying from (airport code)', 'EGLL, or EG for every airport starting EG'),
      input('to', 'Flying to (airport code)', 'LFMN, or several: LFMN LFPG'),
      input('date', 'On this date (Zulu / UTC)', `tomorrow, sat, 14 Nov, or ${new Date(ctx.now()).toISOString().slice(0, 10)}`),
      input('aircraft', 'Aircraft type (code)', 'A320, or B73 for every B73x. Several: A320 B738'),
    );
  await interaction.showModal(modal);
}

/** The search form was sent: find the flights (only ones the panel lists) and answer privately with them. */
async function runSearch(ctx: BotContext, interaction: ModalSubmitInteraction, panelId: number): Promise<void> {
  await interaction.deferReply({ flags: MessageFlags.Ephemeral });
  const panel = panelFor(ctx, interaction, panelId);
  const from = parseAirportCodes(interaction.fields.getTextInputValue('from'));
  const to = parseAirportCodes(interaction.fields.getTextInputValue('to'));
  const skipped = [...from.ignored, ...to.ignored];
  const types = parseAircraftTypes(interaction.fields.getTextInputValue('aircraft'));

  // The date, if one was typed, is a Zulu day, and has to be one the panel itself shows: today up to the last of its days.
  const dateText = interaction.fields.getTextInputValue('date').trim();
  let day: SearchDay | null = null;
  if (dateText) {
    day = parseSearchDate(dateText, ctx.now());
    if (!day) {
      // Shown inside a code span, so only a backtick of theirs could break out of it.
      throw new UserError(`I couldn't read \`${truncate(dateText, 30).replace(/`/g, "'")}\` as a date. Try \`tomorrow\`, a weekday like \`sat\`, \`14 Nov\`, \`14/11\` or \`${new Date(ctx.now()).toISOString().slice(0, 10)}\`. Dates are Zulu (UTC), like the flight times.`);
    }
    const last = ctx.jobs.lastSearchDay(panel);
    if (day.end <= ctx.now()) {
      throw new UserError(`**${day.label}** has already passed. Search from today (**${dayOf(ctx.now()).label}**) onwards.`);
    }
    if (day.start > last.start) {
      throw new UserError(
        `**${panel.airlineName}** shows flights up to ${panel.showDays} day${panel.showDays === 1 ? '' : 's'} ahead, so I can only search up to **${last.label}**. **${day.label}** is further than that. Try again nearer the day.`,
      );
    }
  }

  if (from.codes.length === 0 && to.codes.length === 0 && !day && types.codes.length === 0) {
    const quote = (list: string[]) => list.map((c) => `\`${c}\``).join(', ');
    throw new UserError(
      skipped.length > 0
        ? `I couldn't use ${quote(skipped)} as an airport code. Airport codes are two to four letters or numbers, like \`EGLL\`.`
        : types.ignored.length > 0
          ? `I couldn't use ${quote(types.ignored)} as an aircraft type. Aircraft types are the short codes on the cards, like \`A320\` or \`B738\`.`
          : 'Type where you want to fly from, where you want to fly to, a date, an aircraft type, or any of them together.',
    );
  }
  // A pilot with an A20N can fly an A320 job on FsHub, so the types typed are widened by FsHub's aliases (and the pilot is told).
  const widened = expandAircraftTypes(types.codes);
  const found = ctx.jobs.search(panel, from.codes, to.codes, day, widened.codes);
  // Someone who turned on /hideunavailable doesn't see the flights that are already taken (the ones they are part of stay).
  const matches = ctx.store.getHideUnavailable(interaction.user.id) ? availableFor(found, interaction.user.id) : found;
  const quoted = (list: string[]) => list.map((c) => `\`${c}\``).join(', ');
  const embeds = searchEmbeds(panel, from.codes, to.codes, matches, ctx.now(), day, types.codes, await ctx.panels.avatarsFor(avatarIdsOf(matches.slice(0, MAX_SEARCH_RESULTS))), found.length - matches.length, aliasNote(widened.added));
  await interaction.editReply({
    content: [skipped.length > 0 ? `I skipped ${quoted(skipped)}: not airport codes.` : '', types.ignored.length > 0 ? `I skipped ${quoted(types.ignored)}: not aircraft types.` : ''].filter(Boolean).join('\n'),
    embeds,
    files: stampFiles(embeds),
    allowedMentions: noPings,
  });
}

/* ------------------------------------------------------------------ backup pilot */

/** Why this person can't stand by for flights of this panel at all, or null if they can. */
function backupBlocked(panel: Panel, interaction: ButtonInteraction): string | null {
  if (panel.requiredRoleId && !memberHasRole(interaction, panel.requiredRoleId)) {
    return `Standing by for flights of **${panel.airlineName}** is limited to members with the <@&${panel.requiredRoleId}> role.`;
  }
  return null;
}

/**
 * The Backup pilot button: open a DM conversation asking for the ID of the flight to stand by for, the same way Reserve asks
 * for the flight to fly (and, the first time, for the FsHub pilot ID before it).
 */
async function startBackup(ctx: BotContext, interaction: ButtonInteraction, panelId: number): Promise<void> {
  await interaction.deferReply({ flags: MessageFlags.Ephemeral });
  const panel = panelFor(ctx, interaction, panelId);
  const blocked = backupBlocked(panel, interaction);
  if (blocked) throw new UserError(blocked);

  const user = interaction.user;
  if (ctx.jobs.backupCandidates(panel, user.id).length === 0) {
    await interaction.editReply({
      content:
        "There's no flight for you to be backup for right now. A flight can have a backup once all of it is taken, each flight has just one, and you can't back up a flight you're flying. If a flight still has a free leg, press **Reserve** for it instead.",
    });
    return;
  }

  const needsPilotId = ctx.store.getPilotId(user.id) === null;
  ctx.store.upsertSession({ discordId: user.id, panelId, purpose: 'backup', step: needsPilotId ? 'await_pilot' : 'await_code', expiresAt: ctx.now() + SESSION_TTL_MS });
  try {
    const dm = await user.send({ content: needsPilotId ? askPilotIdText(panel, ctx.fshub !== null, 'backup') : askBackupCodeText(ctx, panel, user.id), allowedMentions: noPings });
    await interaction.editReply({
      content: `📬 I've sent you a DM. Reply there with ${needsPilotId ? 'your FsHub pilot ID, then the ID of the flight you want to stand by for' : 'the ID of the flight you want to stand by for'}.\nhttps://discord.com/channels/@me/${dm.channelId}`,
    });
  } catch (e) {
    ctx.store.deleteSession(user.id);
    if (isDmClosed(e)) {
      throw new UserError("I couldn't send you a DM. Allow direct messages from server members (Server name → Privacy Settings), then press **Backup pilot** again.");
    }
    throw e;
  }
}

/**
 * The flight ID was sent in a backup conversation: put the pilot down for it. If they can't be its backup (it still has a free
 * leg, it already has a backup, it is theirs) say why and let them try another ID; the conversation stays open.
 */
async function backUpFlight(ctx: BotContext, user: Message['author'], session: DmSession, view: JobView): Promise<void> {
  // Something wrong with the flight they named: say so and let them try another ID (a few times).
  const reject = async (problem: string): Promise<void> => {
    const attempts = session.attempts + 1;
    if (attempts >= MAX_ATTEMPTS) {
      ctx.store.deleteSession(user.id);
      await say(user, `${problem}\nThat's a few flights I couldn't use, so I've closed this. Press **Backup pilot** on the panel to start again.`);
      return;
    }
    ctx.store.upsertSession({ ...session, attempts, expiresAt: ctx.now() + SESSION_TTL_MS });
    await say(user, `${problem}\nSend a different flight ID, or say \`cancel\`.`);
  };
  const problem = ctx.jobs.backupProblem(view, user.id);
  if (problem) return reject(problem);
  const done = ctx.jobs.addBackup(view.job.id, { discordId: user.id, username: user.username });
  const sheet = await backupToSheet(ctx, user, done);
  if (sheet.kind === 'undone') return reject(`⚠️ ${sheet.message} So I haven't put you down as backup for **${done.job.code}**.`);
  ctx.store.deleteSession(user.id);
  const note =
    sheet.kind === 'written'
      ? `\n📝 I've put **${plainText(sheet.name)}** as the backup in the airline's sheet. Not how you appear there? Reply \`name <your name>\` and I'll use that from now on.`
      : sheet.kind === 'unreachable'
        ? `\n⚠️ I couldn't update the airline's sheet (${sheet.message}), so it doesn't show you as the backup yet. Please ask a manager to add you to the *Backup Pilot* cell for **${done.job.code}** there.`
        : '';
  await say(
    user,
    `🛟 You're down as backup for **${done.job.code}** (${routeText(done.legs)}). The panel shows your name. If the pilot gives it back I'll tell you, and you can stand down any time from **My flights**.${note}`,
  );
}

/**
 * Put a new backup pilot's name in the flight's *Backup Pilot* cell, where the panel's sheet is written to (and has that column, and the flight is
 * a single leg, like a reservation). If the sheet already names someone else as backup, or shows the flight finished, the backup is undone and the
 * person told, as a reservation is. If the sheet can't be reached the backup stands, and they are told it isn't in the sheet yet.
 */
async function backupToSheet(ctx: BotContext, user: Person, view: JobView): Promise<SheetResult> {
  const panel = ctx.store.getPanel(view.job.panelId);
  if (!panel || !writesToSheet(ctx, panel, view.legs.length)) return { kind: 'none' };
  const name = pilotNameFor(ctx, user);
  try {
    if (!(await ctx.writeback!.claimBackup(panel, view.job.sourceKey, name))) return { kind: 'none' }; // the sheet has no Backup Pilot column
  } catch (e) {
    if (!(e instanceof WriteBackError)) throw e;
    if (e.code === 'CONFLICT' || e.code === 'CLOSED') {
      ctx.jobs.removeBackup(view.job.id, user.id);
      return { kind: 'undone', message: e.message };
    }
    ctx.log.warn(`Could not write the backup for ${view.job.code} to the sheet: ${e.message}`);
    return { kind: 'unreachable', message: e.message };
  }
  ctx.store.setBackupSheetName(view.job.id, user.id, name);
  return { kind: 'written', name };
}

/**
 * For flights someone holds, what FsHub shows them to have flown: per job, one line for each leg FsHub confirmed
 * (the aircraft, when it landed). Empty where the panel does not read FsHub flights, or FsHub has shown nothing.
 */
function fshubSeen(ctx: BotContext, panel: Panel, views: JobView[]): Map<number, string[]> {
  const out = new Map<number, string[]>();
  const confirmed = confirmationsFor(ctx.store, panel, views, ctx.now());
  for (const v of views) {
    const legs = confirmed.get(v.job.id);
    if (!legs) continue;
    const lines = [...legs.entries()]
      .sort((a, b) => a[0] - b[0])
      .map(([legNo, f]) => `🛬 FsHub shows ${v.legs.length > 1 ? `leg ${legNo}` : 'this'} flown: ${flightFacts(f, v.job.aircraft)}`);
    if (lines.length > 0) out.set(v.job.id, lines);
  }
  return out;
}

/** A line saying which FsHub pilot ID is shown beside someone's name, and how to change it. */
function pilotIdNote(ctx: BotContext, discordId: string): string {
  const link = ctx.store.getPilotLink(discordId);
  if (!link) return '';
  const from = link.source === 'roster' ? " (I took it from your airline's FsHub roster)" : '';
  return `\nYour FsHub pilot ID is shown as ${pilotLabel(link.fshubId, link.name)}${from}. Wrong? DM me \`fshub <your ID>\`.`;
}

/** A flight a pilot gave back that is open again, and the legs they gave back. */
export interface OpenAgain {
  view: JobView;
  legs: number[];
}

/**
 * Of the flights a pilot has just given back, the ones that are open again with nobody standing by for them: not the ones that had a backup
 * (the backup is told, and takes it if they can), not ones that have finished or passed their deadline, and not ones the panel does not
 * list yet (nobody can book those). Soonest first.
 */
function openAgain(ctx: BotContext, panelId: number, givenBack: Map<number, number[]>, hadBackup: Set<number>): OpenAgain[] {
  const panel = ctx.store.getPanel(panelId);
  if (!panel) return [];
  const out: OpenAgain[] = [];
  for (const [jobId, legs] of givenBack) {
    if (hadBackup.has(jobId)) continue;
    const view = ctx.jobs.view(jobId);
    if (!view || view.job.status !== 'open' || view.job.completedAt !== null) continue;
    if (view.job.deadline !== null && view.job.deadline <= ctx.now()) continue;
    if (!ctx.jobs.isListed(panel, view)) continue;
    out.push({ view, legs: [...new Set(legs)].sort((a, b) => a - b) });
  }
  return out.sort((a, b) => (a.view.job.availableFrom ?? a.view.job.deadline ?? 0) - (b.view.job.availableFrom ?? b.view.job.deadline ?? 0) || a.view.job.id - b.view.job.id);
}

/**
 * What a pilot is told after giving a flight back that nobody is standing by for: it is open again, and if anyone they know is free to
 * fly it they should say so. Null when there is nothing to say.
 */
export function openAgainText(items: OpenAgain[]): string | null {
  if (items.length === 0) return null;
  const line = (i: OpenAgain) => {
    const { view, legs } = i;
    const partial = view.legs.length > 1 ? ` ${legs.length === 1 ? 'leg' : 'legs'} ${legList(legs)}` : '';
    return `**${view.job.code}**${partial} (${routeText(view.legs.filter((l) => legs.includes(l.legNo)))})`;
  };
  const many = items.length > 1;
  const flights = many ? `:\n${items.map((i) => `• ${line(i)}`).join('\n')}\n` : ` ${line(items[0] as OpenAgain)}, `;
  return [
    `You've given back${flights}${many ? 'Nobody is down as backup, so they are' : 'and nobody is down as its backup, so it is'} open again.`,
    `If anyone you know is free to fly ${many ? 'them' : 'it'}, let them know: they can press **Reserve** on the panel and reply with the flight ID.`,
  ].join(many ? '\n' : ' ');
}

async function releaseSelected(ctx: BotContext, interaction: StringSelectMenuInteraction, panelId: number): Promise<void> {
  await interaction.deferUpdate();
  const freed: string[] = [];
  const stoodDown: string[] = [];
  const written: Array<{ sourceKey: string; name: string }> = [];
  // Which flights had a backup before anything was given back (giving a flight back ends its backup's spot), and which legs went from each.
  const hadBackup = new Set<number>();
  const seen = new Set<number>();
  const givenBack = new Map<number, number[]>();
  for (const value of interaction.values) {
    if (value.startsWith('b:')) {
      const backupJob = ctx.store.getJob(Number(value.slice(2)));
      if (backupJob && backupJob.panelId === panelId && ctx.jobs.removeBackup(backupJob.id, interaction.user.id)) stoodDown.push(backupJob.code);
      continue;
    }
    const [jobId, legNo] = value.split(':').map(Number);
    if (!Number.isInteger(jobId) || !Number.isInteger(legNo)) continue;
    const job = ctx.store.getJob(jobId as number);
    if (!job || job.panelId !== panelId) continue;
    const name = ctx.store.getHolder(job.id, legNo as number)?.sheetName ?? null;
    if (!seen.has(job.id)) {
      seen.add(job.id);
      if (ctx.jobs.view(job.id)?.backup) hadBackup.add(job.id);
    }
    const done = ctx.jobs.release(job.id, interaction.user.id, [legNo as number]);
    if (done.length > 0) {
      givenBack.set(job.id, [...(givenBack.get(job.id) ?? []), ...done]);
      freed.push(`${job.code} leg ${legNo}`);
      if (name) written.push({ sourceKey: job.sourceKey, name });
    }
  }
  // Where the bot had put their name in the airline's sheet, take it off again.
  const outcomes = await Promise.all(written.map((w) => clearFromSheet(ctx, panelId, w.sourceKey, w.name)));
  const note =
    outcomes.includes('failed')
      ? "\n⚠️ I couldn't take your name off the airline's sheet; please ask a manager."
      : outcomes.includes('cleared')
        ? "\nI've taken your name off the airline's sheet too."
        : '';
  // A flight given back with nobody standing by for it is open again, and nobody will say so: the pilot who gave it back is asked to tell people.
  const spread = openAgainText(openAgain(ctx, panelId, givenBack, hadBackup));
  let spreadNote = '';
  if (spread) {
    try {
      await interaction.user.send({ content: spread, allowedMentions: noPings });
    } catch (e) {
      if (!isDmClosed(e)) ctx.log.warn(`Could not tell ${interaction.user.id} that a flight they gave back is open`, e);
      spreadNote = `\n${spread}`; // their DMs are closed, so it is said here instead
    }
  }
  const said = [
    freed.length > 0 ? `Released: ${freed.join(', ')}. The panel is updated and those legs are free again.${note}${spreadNote}` : '',
    stoodDown.length > 0 ? `You're no longer the backup for ${stoodDown.join(', ')}.` : '',
  ].filter(Boolean);
  await interaction.editReply({
    content: said.length > 0 ? said.join('\n') : 'Nothing to release (they may already have been given back).',
    components: [],
  });
}

/* ------------------------------------------------------------------ completing flights */

/** At most this many flights are confirmed at once (the confirm button has to carry their IDs). */
const MAX_COMPLETE_AT_ONCE = 10;

/** Why a pilot can't complete flights on this panel at all, or null if they can. */
function completionBlocked(ctx: BotContext, panel: Panel): string | null {
  if (panel.sheetId && !ctx.writeback?.enabledFor(panel)) {
    return `**${panel.airlineName}** keeps its flights in a Google Sheet, and I can't write to it, so I can't mark flights completed from here. Tick *Flight Completed* in the sheet, or ask an admin to set up write-back (\`/setup writeback\`).`;
  }
  return null;
}

/**
 * Does Complete work from FsHub's record of what was flown on this panel? It does when the bot has a FsHub token, the panel
 * is linked to its airline's FsHub, and reading the airline's flights has not been switched off. Otherwise Complete
 * is the pilot picking what they flew (and the bot writing it to the airline's sheet, where it can).
 */
export function completesFromFsHub(ctx: BotContext, panel: Panel): boolean {
  return ctx.fshub !== null && ctx.fshubSync !== null && panel.fshubAirlineId !== null && panel.fshubConfirm;
}

/** A flight record at least this fresh is used as it is; an older one is refreshed when a pilot presses Complete. */
const FRESH_FLIGHTS_MS = 30_000;

/**
 * Complete, on a panel that works from FsHub: look at what FsHub recorded for this pilot's flights and complete the ones it
 * shows flown. No picking and no confirming: FsHub's record of the landing is the evidence. A flight FsHub has not
 * (yet) shown is left as it was, and the pilot is told why and what to do.
 *
 * A pilot's flights are the ones they reserved here and the ones the airline's sheet names for them without a reservation
 * (somebody typed their name into the sheet, as pilots often do). A name in a sheet is only someone's word, so those are
 * completed only when FsHub shows this pilot's own ID flying the route inside the flight's window.
 */
async function completeFromFsHub(ctx: BotContext, interaction: ButtonInteraction, panel: Panel): Promise<void> {
  const user = interaction.user;
  const reply = (content: string) => interaction.editReply({ content, allowedMentions: noPings });

  const names = sheetNamesFor(ctx.store, user);
  const reserved = ctx.jobs.completable(panel.id, user.id);
  const named = ctx.jobs.namedFor(panel.id, names);
  const namedIds = new Set(named.map((v) => v.job.id));
  const held = [...reserved, ...named];
  if (held.length === 0) {
    await reply(
      "You don't have a flight to complete. Reserve one first; once you've flown it, press **Complete** and I'll check FsHub for your landing.\nIf your name is already against a flight in the airline's sheet, send me `name <your name as the sheet has it>` here, then press **Complete** again.",
    );
    return;
  }
  const started = held.filter((v) => v.job.availableFrom === null || v.job.availableFrom <= ctx.now());
  if (started.length === 0) {
    await reply(`${held.length === 1 ? 'The flight you hold hasn\'t' : 'The flights you hold haven\'t'} started yet, and FsHub can only show a flight once it has landed. Press **Complete** again after you have flown ${held.length === 1 ? 'it' : 'them'}.`);
    return;
  }

  // FsHub's flights are matched to people by FsHub pilot ID, so the bot has to know whose flights are theirs.
  const link = ctx.store.getPilotLink(user.id);
  if (!link) {
    await reply("I don't know your FsHub pilot ID yet, so I can't tell which FsHub flights are yours. DM me `fshub <your ID>` (the number in your FsHub profile address, fshub.io/pilot/**1234**/overview), then press **Complete** again.");
    return;
  }
  // An ID somebody typed is only their word. If the airline's own FsHub roster says that pilot is another Discord account, it isn't theirs to claim flights for.
  if (link.source === 'typed' && ctx.store.rosterOwnerOf(link.fshubId, user.id) !== null) {
    await reply(`The airline's FsHub roster lists FsHub pilot **${link.fshubId}** as a different Discord account, so I can't complete flights for that ID from here. If it is yours, ask a manager to correct the roster; if you gave me the wrong number, DM me \`fshub <your ID>\` with the right one.`);
    return;
  }

  // A flight that landed a minute ago must be there, so bring the flights up to date unless they are already fresh.
  const refreshed = await ctx.fshubSync!.refreshFlights(panel, FRESH_FLIGHTS_MS);
  if (refreshed && !refreshed.ok) {
    await reply(`I couldn't read FsHub just now: ${refreshed.note} Nothing was changed. Try pressing **Complete** again in a few minutes.`);
    return;
  }

  const now = ctx.now();
  const current = ctx.store.getPanel(panel.id) ?? panel;
  // A flight only the sheet names for them is theirs to complete if FsHub shows their own landing, so it is matched to their FsHub ID.
  const namedPilots = new Map(started.filter((v) => namedIds.has(v.job.id)).map((v) => [v.job.id, link.fshubId] as const));
  const confirmed = confirmationsFor(ctx.store, current, started, now, { strict: true, namedPilots });
  const lines: string[] = [];
  let doneCount = 0;
  let sheetNotWritten = false;
  for (const view of started) {
    const code = view.job.code;
    const route = routeText(view.legs);
    const legs = confirmed.get(view.job.id);
    const seenLegs = legs?.size ?? 0;
    if (!legs || seenLegs < view.legs.length) {
      const { from, to } = landingWindow(view.job, now);
      lines.push(
        seenLegs > 0
          ? `⏳ **${code}**: FsHub has shown ${seenLegs} of its ${view.legs.length} legs so far. It must land every leg between ${ts(from, 'f')} and ${ts(to, 'f')}.`
          : `⏳ I can't see **${code}** (${route}) on FsHub. It has to have landed between ${ts(from, 'f')} and ${ts(to, 'f')}. A flight shows up about a minute after landing, so if you have just landed, try again shortly.`,
      );
      continue;
    }

    // Where the airline's sheet follows what pilots do, tick the flight there too, as completing by hand does. A flight the
    // sheet names for them is ticked under the name the sheet has, which is what makes it theirs there.
    const sheetName = namedIds.has(view.job.id) ? (view.legs[0]?.sheetHolder ?? null) : null;
    const inSheet = writesToSheet(ctx, current, view.legs.length);
    if (inSheet) {
      try {
        await ctx.writeback!.complete(current, view.job.sourceKey, sheetName ?? pilotNameFor(ctx, user));
      } catch (e) {
        if (!(e instanceof WriteBackError)) throw e;
        ctx.log.warn(`Could not complete ${code} in the sheet: ${e.message}`);
        lines.push(`⚠️ **${code}** isn't completed: ${e.message}`);
        continue;
      }
    } else if (current.sheetId) {
      sheetNotWritten = true;
    }
    try {
      if (sheetName !== null) ctx.jobs.completeNamed(view.job.id, { discordId: user.id, username: user.username }, names, 'fshub');
      else ctx.jobs.complete(view.job.id, user.id, 'fshub');
    } catch (e) {
      if (!(e instanceof JobError)) throw e;
      lines.push(`⚠️ **${code}**: ${e.message}`);
      continue;
    }
    doneCount++;
    const facts = view.legs.map((l) => {
      const f = legs.get(l.legNo) as FlownFlight;
      return `${view.legs.length > 1 ? `leg ${l.legNo}: ` : ''}${flightFacts(f, view.job.aircraft)}`;
    });
    lines.push(`✅ **${code}** (${route}) is completed from FsHub: ${facts.join('; ')}${inSheet ? " and ticked in the airline's sheet" : ''}. Nice flying!`);
    if (sheetName !== null) lines.push(`ℹ️ The airline's sheet had **${plainText(truncate(sheetName, 40))}** against **${code}**, a name I know you by, and FsHub shows you flew it, so I counted it as yours.`);
  }
  const waiting = held.length - started.length;
  if (waiting > 0) lines.push(`${waiting} other flight${waiting === 1 ? '' : 's'} you hold ${waiting === 1 ? "hasn't" : "haven't"} started yet.`);
  if (doneCount > 0 && sheetNotWritten) lines.push("ℹ️ I can't write to the airline's sheet, so it still shows those as not done there. The panel is up to date.");
  await reply(lines.join('\n'));
}

/** The Complete button: on a panel linked to FsHub, complete what FsHub shows flown; otherwise pick which flights you have flown. */
async function startCompletion(ctx: BotContext, interaction: ButtonInteraction, panelId: number): Promise<void> {
  await interaction.deferReply({ flags: MessageFlags.Ephemeral });
  const panel = panelFor(ctx, interaction, panelId);
  if (completesFromFsHub(ctx, panel)) {
    await completeFromFsHub(ctx, interaction, panel);
    return;
  }
  const blocked = completionBlocked(ctx, panel);
  if (blocked) throw new UserError(blocked);

  // A row in the sheet is a single leg, so only single-leg flights can be ticked there.
  const flights = ctx.jobs.completable(panel.id, interaction.user.id).filter((v) => !panel.sheetId || v.legs.length === 1);
  if (flights.length === 0) {
    await interaction.editReply({ content: "You don't have a flight to complete. Reserve one first; once you've flown it, press **Complete**. (Flights shared between pilots are completed in the airline's own records.)" });
    return;
  }
  const menu = new StringSelectMenuBuilder()
    .setCustomId(`panel:completepick:${panel.id}`)
    .setPlaceholder('Which flights have you flown?')
    .setMinValues(1)
    .setMaxValues(Math.min(flights.length, MAX_COMPLETE_AT_ONCE))
    .addOptions(flights.slice(0, 25).map((v) => ({ label: truncate(`${v.job.code} · ${routeText(v.legs)}`, 100), value: String(v.job.id) })));
  await interaction.editReply({
    content: `**Which flights have you flown?** Pick them, then confirm.${panel.sheetId ? " I'll tick them off in the airline's sheet." : ''}`,
    components: [new ActionRowBuilder<MessageActionRowComponentBuilder>().addComponents(menu)],
    allowedMentions: noPings,
  });
}

/** The flights were picked: ask for a final yes before touching the sheet. */
async function confirmCompletion(ctx: BotContext, interaction: StringSelectMenuInteraction, panelId: number): Promise<void> {
  const panel = panelFor(ctx, interaction, panelId);
  // A picker left over from before the panel was linked to FsHub must not complete flights FsHub hasn't confirmed.
  if (completesFromFsHub(ctx, panel)) {
    await interaction.update({ content: 'Completing flights now works from FsHub. Press **Complete** under the panel again and I\'ll check FsHub for your landing.', components: [], allowedMentions: noPings });
    return;
  }
  const ids = [...new Set(interaction.values.map(Number).filter((n) => Number.isInteger(n)))].slice(0, MAX_COMPLETE_AT_ONCE);
  const mine = ctx.jobs.completable(panel.id, interaction.user.id).filter((v) => ids.includes(v.job.id));
  if (mine.length === 0) {
    await interaction.update({ content: "Those flights aren't yours to complete any more.", components: [], allowedMentions: noPings });
    return;
  }
  await interaction.update({
    content: `Mark ${mine.map((v) => `**${v.job.code}**`).join(', ')} as completed?${panel.sheetId ? " This ticks *Flight Completed* in the airline's sheet." : ''} Only an admin or the sheet's owner can undo it.`,
    components: [
      row(
        button(`panel:completeyes:${panel.id}:${mine.map((v) => v.job.id).join(',')}`, 'Yes, I flew them', ButtonStyle.Success),
        button(`panel:completeno:${panel.id}`, 'Cancel', ButtonStyle.Secondary),
      ),
    ],
    allowedMentions: noPings,
  });
}

/** Confirmed: write each flight to the sheet (where there is one), then mark it completed here. */
async function finishCompletion(ctx: BotContext, interaction: ButtonInteraction, panelId: number, rawIds: string): Promise<void> {
  await interaction.deferUpdate(); // Google can be slow; Discord only waits three seconds for an answer
  const panel = panelFor(ctx, interaction, panelId);
  if (completesFromFsHub(ctx, panel)) {
    await interaction.editReply({ content: 'Completing flights now works from FsHub. Press **Complete** under the panel again and I\'ll check FsHub for your landing.', components: [], allowedMentions: noPings });
    return;
  }
  const blocked = completionBlocked(ctx, panel);
  if (blocked) throw new UserError(blocked);

  const ids = [...new Set(rawIds.split(',').map(Number).filter((n) => Number.isInteger(n)))].slice(0, MAX_COMPLETE_AT_ONCE);
  const user = interaction.user;
  const available = ctx.jobs.completable(panel.id, user.id);
  const lines: string[] = [];
  for (const id of ids) {
    const view = available.find((v) => v.job.id === id);
    if (!view) {
      lines.push('⚠️ One of those flights is no longer yours to complete.');
      continue;
    }
    const code = view.job.code;
    const inSheet = Boolean(panel.sheetId);
    if (inSheet) {
      if (view.legs.length !== 1) {
        lines.push(`⚠️ **${code}** has several legs, so it has to be ticked in the airline's sheet.`);
        continue;
      }
      try {
        await ctx.writeback!.complete(panel, view.job.sourceKey, pilotNameFor(ctx, user));
      } catch (e) {
        if (!(e instanceof WriteBackError)) throw e;
        ctx.log.warn(`Could not complete ${code} in the sheet: ${e.message}`);
        lines.push(`⚠️ **${code}** isn't completed: ${e.message}`);
        continue;
      }
    }
    try {
      ctx.jobs.complete(id, user.id);
    } catch (e) {
      if (!(e instanceof JobError)) throw e;
      lines.push(`⚠️ **${code}**: ${e.message}`);
      continue;
    }
    lines.push(`✅ **${code}** is completed${inSheet ? " and ticked in the airline's sheet" : ''}. Nice flying!`);
  }
  await interaction.editReply({ content: lines.join('\n'), components: [], allowedMentions: noPings });
}

/* ------------------------------------------------------------------ the DM conversation */

async function say(user: { send(o: { content: string; components?: Row[]; allowedMentions: typeof noPings }): Promise<unknown> }, content: string, components: Row[] = []): Promise<void> {
  await user.send({ content, components, allowedMentions: noPings });
}

/**
 * A message sent to the bot in a DM. Only meaningful while the person has an open Reserve
 * conversation (they pressed the button); anything else gets a short pointer, at most once in a while.
 */
export async function handleDmMessage(ctx: BotContext, message: Message): Promise<void> {
  if (message.author.bot || message.guildId) return;
  // The same words that turn the scheduler's daily note off and on also turn the remarks about hard landings off and on, but only for someone
  // the scheduler has spoken to (the person who gets the daily note, or anyone sent a remark). For everyone else they are just another message.
  const knowsKevin = ctx.dailyNote?.isTarget(message.author.id) === true || ctx.store.wasRemarkedOn(message.author.id);
  const remarkReply = knowsKevin ? switchRemarks(ctx.store, message.author.id, message.content, ctx.now()) : null;
  // The one person who gets a daily note can turn it off and on by replying to it.
  const noteReply = ctx.dailyNote?.handleReply(message.author.id, message.content);
  if (noteReply ?? remarkReply) {
    await say(message.author, (noteReply ?? remarkReply) as string).catch(() => undefined);
    return;
  }
  try {
    await handleDm(ctx, message);
  } catch (e) {
    // A reply typed in a DM has no error screen, so an expected failure (say, the flight closed a
    // moment ago) must be said right here, or the person would just see silence.
    if (e instanceof JobError || e instanceof UserError) {
      const purpose = ctx.store.getSession(message.author.id, ctx.now())?.purpose ?? 'reserve';
      ctx.store.deleteSession(message.author.id);
      await say(message.author, `${e.message}\nPress ${startButton(purpose)} on the panel to try another flight.`).catch(() => undefined);
      return;
    }
    throw e;
  }
}

async function handleDm(ctx: BotContext, message: Message): Promise<void> {
  const user = message.author;
  const now = ctx.now();
  const text = message.content.trim();

  // `name Alex Smith`: what to call this person in airline sheets. Works whether or not a conversation is open.
  const rename = /^name(?:\s+(.*))?$/is.exec(text);
  if (rename) {
    await renamePilot(ctx, user, rename[1] ?? '');
    return;
  }

  // `flights`: the pilot's own flights, on every panel. Also works whether or not a conversation is open (it leaves one alone).
  if (LIST_REQUEST.test(text)) {
    await listMyFlights(ctx, user);
    return;
  }

  // `my contributions`: what the pilot's completed flights made for the airline, from its sheet. Also leaves an open conversation alone.
  if (CONTRIBUTIONS_REQUEST.test(text)) {
    await showContributions(ctx, message, (reply) => say(user, reply));
    return;
  }

  // `metar EGLL`: the current weather report for an airport, fetched from VATSIM and put in plain language; or a METAR pasted after
  // it (or on its own), which is translated. Also leaves an open conversation alone.
  const metarRequest = METAR_REQUEST.exec(text);
  if (metarRequest) {
    await showMetar(ctx, message, metarRequest[1] ?? '');
    return;
  }
  if (looksLikeMetar(text)) {
    await showMetar(ctx, message, text);
    return;
  }

  // `notifications`: which of the optional private messages this person gets, and switching them on or off. Also leaves an open conversation alone.
  const noticesRequest = NOTICES_REQUEST.exec(text);
  if (noticesRequest) {
    await showNotices(ctx, message, noticesRequest[1] ?? '');
    return;
  }

  // `fshub 1234`: the pilot's FsHub pilot ID. Also works whether or not a conversation is open.
  const fshub = /^fshub(?:\s+(.*))?$/is.exec(text);
  if (fshub) {
    await setPilotIdFromDm(ctx, user, fshub[1] ?? '');
    return;
  }

  const session = ctx.store.getSession(user.id, now);

  if (!session) {
    const last = lastHint.get(user.id);
    if (last === undefined || now - last >= HINT_COOLDOWN_MS) {
      lastHint.set(user.id, now);
      // Forget people whose cooldown is over, so the map can't grow for ever with everyone who has ever messaged the bot.
      if (lastHint.size > 5000) for (const [k, t] of lastHint) if (now - t >= HINT_COOLDOWN_MS) lastHint.delete(k);
      await say(user, 'To reserve a flight, press **Reserve** on a flight panel in your server (or **Backup pilot** to stand by for one that is taken). I\'ll ask for the flight ID here. Send me `flights` any time to see the flights you have, `my contributions` to see what your completed flights made for the airline, `metar EGLL` (any airport code) for a weather report in plain language, or `notifications` to choose which messages I send you.');
    }
    return;
  }

  if (CANCEL_WORDS.has(text.toLowerCase())) {
    ctx.store.deleteSession(user.id);
    await say(user, `Okay, cancelled. Press ${startButton(session.purpose)} on the panel whenever you want to start again.`);
    return;
  }

  const panel = ctx.store.getPanel(session.panelId);
  if (!panel) {
    ctx.store.deleteSession(user.id);
    await say(user, 'That panel is no longer active.');
    return;
  }

  if (session.step === 'await_pilot') {
    const id = parsePilotId(text);
    if (id === null) {
      const attempts = session.attempts + 1;
      if (attempts >= MAX_ATTEMPTS) {
        ctx.store.deleteSession(user.id);
        await say(user, `I still can't read a FsHub pilot ID in that, so I've closed this. Press ${startButton(session.purpose)} on the panel to start again.`);
        return;
      }
      ctx.store.upsertSession({ ...session, attempts, expiresAt: now + SESSION_TTL_MS });
      await say(user, 'I need your FsHub pilot ID: just the number, like `1234`, or the link to your profile (fshub.io/pilot/**1234**/overview). Try again, or say `cancel`.');
      return;
    }
    const check = await checkPilotId(ctx, id);
    if (check.status === 'missing') {
      const attempts = session.attempts + 1;
      if (attempts >= MAX_ATTEMPTS) {
        ctx.store.deleteSession(user.id);
        await say(user, `FsHub doesn't know any of those pilot IDs, so I've closed this. Check your profile address and press ${startButton(session.purpose)} on the panel to start again.`);
        return;
      }
      ctx.store.upsertSession({ ...session, attempts, expiresAt: now + SESSION_TTL_MS });
      await say(user, `${noSuchPilotText(id)} Try again, or say \`cancel\`.`);
      return;
    }
    const name = check.status === 'found' ? check.name : null;
    rememberPilotId(ctx, user.id, id, name);
    ctx.store.upsertSession({ ...session, step: 'await_code', attempts: 0, expiresAt: now + SESSION_TTL_MS });
    await say(
      user,
      `Thanks, I've saved your FsHub pilot ID as ${pilotLabel(id, name)}.${name ? ' If that isn\'t you, send `fshub <your ID>` with the right one.' : ''}\n\n${session.purpose === 'backup' ? askBackupCodeText(ctx, panel, user.id) : askCodeText(ctx, panel)}`,
    );
    return;
  }

  if (session.step !== 'await_code') {
    await say(user, 'Please use the buttons on my last message to carry on, or say `cancel`.');
    return;
  }

  let view: JobView | null;
  if (session.purpose === 'backup') {
    view = ctx.jobs.findByCode(panel, text);
  } else {
    // Reserving: the message can name several flights (`TST-001, TST-004 and TST-009`). One flight, or none that can be
    // made out, goes the way it always has; two or more are reserved together.
    const found = ctx.jobs.findSeveral(panel, text);
    const flights = found.items.flatMap((i) => (i.kind === 'flight' ? [i.view] : []));
    const unknown = found.items.length - flights.length;
    if (found.skipped.length === 0 && ((flights.length === 0 && unknown <= 1) || (flights.length === 1 && unknown === 0))) {
      view = flights[0] ?? null;
    } else {
      await reserveSeveral(ctx, user, session, panel, found);
      return;
    }
  }
  if (!view) {
    const attempts = session.attempts + 1;
    if (attempts >= MAX_ATTEMPTS) {
      ctx.store.deleteSession(user.id);
      await say(user, `That's a few IDs I couldn't find, so I've closed this. Press ${startButton(session.purpose)} on the panel to start again.`);
      return;
    }
    ctx.store.upsertSession({ ...session, jobId: null, attempts, expiresAt: now + SESSION_TTL_MS });
    await say(user, `I can't find an open flight with the ID \`${truncate(text, 40)}\`. IDs look like \`${session.purpose === 'backup' ? exampleBackupId(ctx, panel, user.id) : exampleId(ctx, panel)}\` and are listed on the panel. Try again, or say \`cancel\`.`);
    return;
  }

  if (session.purpose === 'backup') {
    await backUpFlight(ctx, user, session, view); // says the same about a flight beyond the panel's days (see backupProblem)
    return;
  }
  // A flight that starts beyond the panel's days is not open for booking yet: say so, with the number of days, and let them pick another.
  if (!ctx.jobs.isListed(panel, view)) {
    const problem = beyondDaysText(panel.showDays, view.job.code, 'book');
    const attempts = session.attempts + 1;
    if (attempts >= MAX_ATTEMPTS) {
      ctx.store.deleteSession(user.id);
      await say(user, `${problem}\nThat's a few flights I couldn't use, so I've closed this. Press ${startButton(session.purpose)} on the panel to start again.`);
      return;
    }
    ctx.store.upsertSession({ ...session, jobId: null, attempts, expiresAt: now + SESSION_TTL_MS });
    await say(user, `${problem}\nSend a different flight ID, or say \`cancel\`.`);
    return;
  }
  await proceedWithJob(ctx, user, session, view);
}

/** Found the flight: take it straight away if it has one leg, otherwise ask which legs. `note` is said first (what was wrong with other IDs sent with it). */
async function proceedWithJob(
  ctx: BotContext,
  user: Message['author'],
  session: DmSession,
  view: JobView,
  note = '',
): Promise<void> {
  if (view.legs.length === 1) {
    ctx.store.deleteSession(user.id);
    await say(user, await reserveFor(ctx, user, view.job.id, [1]));
    return;
  }
  ctx.store.upsertSession({ ...session, step: 'await_mode', jobId: view.job.id, pendingLegs: [], attempts: 0, expiresAt: ctx.now() + SESSION_TTL_MS });
  await say(
    user,
    `${note ? `${note}\n\n` : ''}${jobBlock(view, ctx.now())}\n\n**${view.job.code}** has ${view.legs.length} legs. Are you flying all of them, or just some?`,
    [row(button('dm:all', 'All legs', ButtonStyle.Success), button('dm:some', 'Some legs', ButtonStyle.Primary), button('dm:cancel', 'Cancel', ButtonStyle.Secondary))],
  );
}

/** IDs the person typed, as they are shown back: `A`, `B`, `C`. */
const typedList = (typed: string[]): string => typed.map((t) => `\`${t}\``).join(', ');

/**
 * Two or more flight IDs came in one message. A flight with one leg is reserved straight away, one after another, each just as
 * if it had been sent on its own (the airline's sheet included), and the answer says how each went. A flight with several legs
 * has to be asked about (all of it, or some?), so it is left for the person to send by itself, and the conversation stays open
 * for that. IDs that are not open flights, and flights too far ahead to book, are said once at the end. If nothing at all could
 * be used, that is one wrong try, like any other.
 */
async function reserveSeveral(ctx: BotContext, user: Message['author'], session: DmSession, panel: Panel, found: FoundIds): Promise<void> {
  const flights = found.items.flatMap((i) => (i.kind === 'flight' ? [i.view] : []));
  const unknown = found.items.flatMap((i) => (i.kind === 'unknown' ? [i.typed] : []));
  const beyond = flights.filter((v) => !ctx.jobs.isListed(panel, v));
  const listed = flights.filter((v) => ctx.jobs.isListed(panel, v));
  const singles = listed.filter((v) => v.legs.length === 1);
  const multis = listed.filter((v) => v.legs.length > 1);

  // What can't be used, said once each: IDs that are not open flights, flights too far ahead to book, and what was too much for one message.
  const unusable: string[] = [];
  if (unknown.length > 0) unusable.push(`❓ I can't find ${unknown.length === 1 ? 'an open flight with the ID' : 'open flights with the IDs'} ${typedList(unknown)}.`);
  if (beyond.length > 0) unusable.push(beyondDaysManyText(panel.showDays, beyond.map((v) => v.job.code)));
  if (found.skipped.length > 0) {
    const shown = found.skipped.slice(0, 5);
    const more = found.skipped.length - shown.length;
    const why = flights.length >= MAX_IDS_AT_ONCE ? `I take up to ${MAX_IDS_AT_ONCE} flights at a time` : "That's a lot for one message";
    unusable.push(`${why}, so I haven't looked at ${typedList(shown)}${more > 0 ? ` and ${more} more` : ''}. Send ${found.skipped.length === 1 ? 'it' : 'them'} again.`);
  }

  if (listed.length === 0) {
    const attempts = session.attempts + 1;
    if (attempts >= MAX_ATTEMPTS) {
      ctx.store.deleteSession(user.id);
      await say(user, `${unusable.join('\n')}\nThat's a few IDs I couldn't use, so I've closed this. Press ${startButton(session.purpose)} on the panel to start again.`);
      return;
    }
    ctx.store.upsertSession({ ...session, jobId: null, attempts, expiresAt: ctx.now() + SESSION_TTL_MS });
    const tail = unknown.length > 0 && beyond.length === 0 ? `IDs look like \`${exampleId(ctx, panel)}\` and are listed on the panel. Try again, or say \`cancel\`.` : 'Send different flight IDs, or say `cancel`.';
    await say(user, `${unusable.join('\n')}\n${tail}`);
    return;
  }

  // Only one flight can be acted on and it has several legs: ask about its legs the usual way, with what was wrong with the rest above the question.
  if (singles.length === 0 && multis.length === 1 && found.skipped.length === 0) {
    await proceedWithJob(ctx, user, session, multis[0]!, unusable.join('\n'));
    return;
  }

  // Finished with first, so a message that arrives while the airline's sheet is being written to is not read as part of this conversation.
  ctx.store.deleteSession(user.id);
  const lines: string[] = [];
  let reservedAny = false;
  let alreadyMineAny = false;
  let sheetName = '';
  const written: string[] = [];
  const unreachable = new Map<string, string[]>();
  for (const view of singles) {
    const code = view.job.code;
    try {
      const { res, sheet } = await reserveAndClaim(ctx, user, view.job.id, [1]);
      if (sheet.kind === 'undone') {
        lines.push(`⚠️ ${sheet.message} So I haven't reserved **${code}** for you.`);
        continue;
      }
      lines.push(...outcomeLines(res));
      reservedAny ||= res.reserved.length > 0;
      alreadyMineAny ||= res.alreadyMine.length > 0;
      if (sheet.kind === 'written') {
        sheetName = sheet.name;
        written.push(code);
      } else if (sheet.kind === 'unreachable') {
        unreachable.set(sheet.message, [...(unreachable.get(sheet.message) ?? []), code]);
      }
    } catch (e) {
      if (e instanceof JobError) {
        lines.push(`⚠️ ${e.message}`);
        continue;
      }
      // One flight going wrong must not take the others' answers with it: say so and carry on.
      ctx.log.error(`Could not reserve ${code} for ${user.id}: ${e instanceof Error ? e.message : e}`);
      lines.push(`⚠️ Something went wrong with **${code}**. Press **My flights** under the panel to see whether you have it.`);
    }
  }
  const footer = outcomeFooter(reservedAny, alreadyMineAny);
  if (footer) lines.push(footer);
  if (written.length > 0) {
    lines.push(
      `📝 I've put **${plainText(sheetName)}** against ${written.length === 1 ? `**${written[0]}**` : `${written.length} of them`} in the airline's sheet. Not how you appear there? Reply \`name <your name>\` and I'll use that from now on.`,
    );
  }
  for (const [message, codes] of unreachable) {
    lines.push(`⚠️ I couldn't update the airline's sheet (${message}), so it doesn't show your name on ${andList(codes.map((c) => `**${c}**`))} yet. Please ask a manager to add you to ${codes.length === 1 ? 'it' : 'them'} there.`);
  }

  const notes = [...unusable];
  if (multis.length > 0) {
    notes.push(
      `↪️ ${andList(multis.map((v) => `**${v.job.code}**`))} ${multis.length === 1 ? 'has' : 'have'} several legs, so I need to know which you're flying. Send me ${multis.length === 1 ? 'its ID' : 'one of those IDs'} on its own and I'll ask.`,
    );
  }
  // Still something to do: keep the conversation going, unless the person started another meanwhile.
  if ((multis.length > 0 || found.skipped.length > 0) && !ctx.store.getSession(user.id, ctx.now())) {
    ctx.store.upsertSession({ ...session, step: 'await_code', jobId: null, pendingLegs: [], attempts: 0, expiresAt: ctx.now() + SESSION_TTL_MS });
    notes.push('Say `cancel` when you are done.');
  }

  // One message holds 2000 characters; a long answer is sent in two rather than cut.
  const parts = [lines.join('\n'), notes.join('\n')].filter(Boolean);
  const whole = parts.join('\n\n');
  if (whole.length < 1900) await say(user, whole);
  else for (const part of parts) await say(user, part);
}

/* ------------------------------------------------------------------ buttons and menus in the DM */

async function handleDmComponent(ctx: BotContext, interaction: ButtonInteraction | StringSelectMenuInteraction): Promise<void> {
  try {
    await handleDmAction(ctx, interaction);
  } catch (e) {
    // Say an expected failure (the flight closed, a leg vanished) in the DM itself.
    if (e instanceof JobError || e instanceof UserError) {
      ctx.store.deleteSession(interaction.user.id);
      await interaction.update({ content: `${e.message}\nPress **Reserve** on the panel to try another flight.`, components: [], allowedMentions: noPings });
      return;
    }
    throw e;
  }
}

/**
 * Reserve and answer the button press with the outcome. Buttons only appear for flights with several
 * legs, and the sheet is only written for one-leg flights, so this never waits on Google.
 */
async function reserveAndUpdate(ctx: BotContext, interaction: ButtonInteraction | StringSelectMenuInteraction, view: JobView, legNos: number[]): Promise<void> {
  await interaction.update({ content: await reserveFor(ctx, interaction.user, view.job.id, legNos), components: [], allowedMentions: noPings });
}

async function handleDmAction(ctx: BotContext, interaction: ButtonInteraction | StringSelectMenuInteraction): Promise<void> {
  const action = interaction.customId.split(':')[1];
  const user = interaction.user;
  const session = ctx.store.getSession(user.id, ctx.now());
  const expired = { content: 'That conversation has closed. Press **Reserve** on the panel to start again.', components: [] as Row[], allowedMentions: noPings };

  if (!session || session.jobId === null) {
    await interaction.update(expired);
    return;
  }
  if (action === 'cancel') {
    ctx.store.deleteSession(user.id);
    await interaction.update({ content: 'Okay, cancelled.', components: [], allowedMentions: noPings });
    return;
  }

  const view = ctx.jobs.view(session.jobId);
  if (!view || view.job.status !== 'open') {
    ctx.store.deleteSession(user.id);
    await interaction.update({ content: 'That flight has just been closed, so there is nothing to reserve.', components: [], allowedMentions: noPings });
    return;
  }

  // A leg is someone else's if another Discord user reserved it, or the airline's schedule already names a pilot for it.
  const mineAlready = (l: JobView['legs'][number]) => l.holder?.discordId === user.id;
  const heldByOthers = view.legs.filter((l) => !mineAlready(l) && (l.holder || l.sheetHolder));
  const reservable = view.legs.filter((l) => mineAlready(l) || (!l.holder && !l.sheetHolder)).map((l) => l.legNo);

  switch (action) {
    case 'all': {
      if (heldByOthers.length === 0) {
        ctx.store.deleteSession(user.id);
        await reserveAndUpdate(ctx, interaction, view, view.legs.map((l) => l.legNo));
        return;
      }
      if (reservable.length === 0) {
        ctx.store.deleteSession(user.id);
        await interaction.update({ content: `Every leg of **${view.job.code}** is already taken:\n${heldByOthers.map((l) => `• leg ${l.legNo} (${legText(l)}): ${takenBy(l)}`).join('\n')}`, components: [], allowedMentions: noPings });
        return;
      }
      ctx.store.upsertSession({ ...session, step: 'await_confirm', pendingLegs: reservable });
      await interaction.update({
        content: `${heldByOthers.map((l) => `Leg ${l.legNo} (${legText(l)}) is already taken by ${takenBy(l)}.`).join('\n')}\n\nDo you want the other ${reservable.length === 1 ? 'leg' : 'legs'} (${legList(reservable)}) instead?`,
        components: [row(button('dm:take', `Take ${reservable.length === 1 ? 'leg' : 'legs'} ${legList(reservable)}`, ButtonStyle.Success), button('dm:cancel', 'Cancel', ButtonStyle.Secondary))],
        allowedMentions: noPings,
      });
      return;
    }

    case 'some': {
      const free = view.legs.filter((l) => !l.holder && !l.sheetHolder);
      if (free.length === 0) {
        ctx.store.deleteSession(user.id);
        await interaction.update({ content: `There are no free legs left on **${view.job.code}**.`, components: [], allowedMentions: noPings });
        return;
      }
      ctx.store.upsertSession({ ...session, step: 'await_legs' });
      const menu = new StringSelectMenuBuilder()
        .setCustomId('dm:legs')
        .setPlaceholder('Pick the legs you will fly')
        .setMinValues(1)
        .setMaxValues(free.length)
        .addOptions(free.map((l) => ({ label: `Leg ${l.legNo}: ${legText(l)}`, value: String(l.legNo) })));
      await interaction.update({
        content: `Which legs of **${view.job.code}** are you flying?${heldByOthers.length > 0 ? ' (Legs already taken by others aren\'t listed.)' : ''}`,
        components: [new ActionRowBuilder<MessageActionRowComponentBuilder>().addComponents(menu), row(button('dm:cancel', 'Cancel', ButtonStyle.Secondary))],
        allowedMentions: noPings,
      });
      return;
    }

    case 'legs': {
      if (!interaction.isStringSelectMenu()) return;
      const legNos = interaction.values.map(Number).filter((n) => Number.isInteger(n));
      ctx.store.deleteSession(user.id);
      await reserveAndUpdate(ctx, interaction, view, legNos);
      return;
    }

    case 'take': {
      ctx.store.deleteSession(user.id);
      const legNos = session.pendingLegs.length > 0 ? session.pendingLegs : reservable;
      await reserveAndUpdate(ctx, interaction, view, legNos);
      return;
    }

    default:
      await interaction.update({ content: 'That button is out of date.', components: [], allowedMentions: noPings });
  }
}

/* ------------------------------------------------------------------ handler registrations */

/* ------------------------------------------------------------------ which panel a button belongs to */

/** The panel a button, menu or form belongs to: it must be a panel of the server where it was pressed. */
function panelFor(ctx: BotContext, interaction: ComponentInteraction, panelId: number): Panel {
  const panel = ctx.store.getPanel(panelId);
  if (!panel || panel.guildId !== interaction.guildId) throw new UserError('That panel is no longer active.');
  return panel;
}

/* ------------------------------------------------------------------ the list view */

/** The List view button: post the pilot their own copy of the panel as a list in their DMs, and keep it up to date. */
async function startList(ctx: BotContext, interaction: ButtonInteraction, panelId: number): Promise<void> {
  await interaction.deferReply({ flags: MessageFlags.Ephemeral });
  const panel = panelFor(ctx, interaction, panelId);
  const result = await ctx.panels.follow(panel.id, interaction.user);
  if (!result.ok) {
    if (result.reason === 'dm-closed') {
      throw new UserError("I couldn't send you a DM. Allow direct messages from server members (Server name → Privacy Settings), then press **List view** again.");
    }
    if (result.reason === 'full') {
      throw new UserError(`${MAX_FOLLOWERS} people already have a list of this panel in their DMs, which is as many as I keep up to date. Use the panel here instead.`);
    }
    throw new UserError('That panel is no longer active.');
  }
  await interaction.editReply({
    content: `📃 Your list is in your DMs, and I'll keep it up to date there whenever the panel changes. Its buttons work like the panel's. Press **Stop updates** under it to end it.\nhttps://discord.com/channels/@me/${result.channelId}`,
  });
}

/** The Stop updates button under a pilot's list: take the list out of their DMs and stop keeping it up to date. */
async function stopList(ctx: BotContext, interaction: ButtonInteraction, panelId: number): Promise<void> {
  await interaction.deferReply({ flags: MessageFlags.Ephemeral });
  const had = await ctx.panels.unfollow(panelId, interaction.user.id);
  await interaction.editReply({
    content: had
      ? "🔕 Done. I've taken your list out of your DMs and I won't keep one up to date for you. Press **List view** on the panel to get it back."
      : "You don't have a list of that panel in your DMs.",
  });
}

/** Buttons on the panel itself: `panel:reserve:<id>`, `panel:mine:<id>`, `panel:release:<id>` (menu). */
export const panelHandler: ComponentHandler = {
  prefix: 'panel',
  async handle(ctx, interaction) {
    const [, action, rawId, extra] = interaction.customId.split(':');
    const panelId = Number(rawId);
    if (!Number.isInteger(panelId)) throw new UserError('That button is out of date.');
    ctx.panels.touch(panelId); // a button pressed on a grid panel keeps its folded messages folded a while longer
    if (action === 'flight' || action === 'fold' || action === 'foldall' || action === 'unfoldall') return handleGridAction(ctx, interaction, action, panelId, extra);
    if (action === 'reserve' && interaction.isButton()) return startReservation(ctx, interaction, panelId);
    if (action === 'mine' && interaction.isButton()) return showMine(ctx, interaction, panelId);
    if (action === 'list' && interaction.isButton()) return startList(ctx, interaction, panelId);
    if (action === 'unlist' && interaction.isButton()) return stopList(ctx, interaction, panelId);
    if (action === 'search' && interaction.isButton()) return startSearch(ctx, interaction, panelId);
    if (action === 'searchgo' && interaction.isModalSubmit()) return runSearch(ctx, interaction, panelId);
    if (action === 'backup' && interaction.isButton()) return startBackup(ctx, interaction, panelId);
    if (action === 'release' && interaction.isStringSelectMenu()) return releaseSelected(ctx, interaction, panelId);
    if (action === 'complete' && interaction.isButton()) return startCompletion(ctx, interaction, panelId);
    if (action === 'completepick' && interaction.isStringSelectMenu()) return confirmCompletion(ctx, interaction, panelId);
    if (action === 'completeyes' && interaction.isButton()) return finishCompletion(ctx, interaction, panelId, extra ?? '');
    if (action === 'completeno' && interaction.isButton()) {
      await interaction.update({ content: 'Okay, nothing was changed.', components: [], allowedMentions: noPings });
      return;
    }
    throw new UserError('That button is out of date.');
  },
};

/** Buttons and the leg menu in the DM: `dm:all`, `dm:some`, `dm:legs`, `dm:take`, `dm:cancel`. */
export const dmHandler: ComponentHandler = {
  prefix: 'dm',
  handle: (ctx, interaction) => (interaction.isModalSubmit() ? Promise.resolve() : handleDmComponent(ctx, interaction)),
};
