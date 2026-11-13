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
import { JobError, type ReserveResult } from '../services/jobs.js';
import { parsePilotId } from '../services/pilotId.js';
import { dayOf, parseAirportCodes, parseSearchDate, type SearchDay } from '../services/search.js';
import { WriteBackError } from '../services/writeback.js';
import { legList, legText, mention, plainText, routeText, truncate, ts } from '../util/format.js';
import type { BotContext, ComponentHandler } from './context.js';
import { CONTRIBUTIONS_REQUEST, showContributions } from './contributions.js';
import { isDmClosed, UserError } from './errors.js';
import { memberHasRole } from './guard.js';
import { flightFacts, noPings, jobBlock, searchEmbeds } from './ui.js';

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

/** What happened when someone tried to reserve, in plain words. */
export function outcomeText(res: ReserveResult): string {
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
  if (res.reserved.length > 0) lines.push('The panel has been updated with your name.');
  else if (res.alreadyMine.length === 0) lines.push('Nothing was reserved.');
  return lines.join('\n');
}

/** An ID to give as an example: that of a flight that is really on the panel (it may be a flight number from the schedule), else the automatic form. */
const exampleId = (ctx: BotContext, panel: Panel): string => ctx.jobs.open(panel.id)[0]?.job.code ?? `${panel.prefix}-001`;

const askCodeText = (ctx: BotContext, panel: Panel) =>
  [
    `**Reserve a flight for ${panel.airlineName}.**`,
    `Reply with the flight ID shown on the panel, for example \`${exampleId(ctx, panel)}\`.`,
    'Say `cancel` to stop. This conversation closes in 10 minutes.',
  ].join('\n');

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
  const res = ctx.jobs.reserve(jobId, legNos, { discordId: user.id, username: user.username });
  const panel = ctx.store.getPanel(res.job.job.panelId);
  if (res.reserved.length === 0 || !panel || !writesToSheet(ctx, panel, res.job.legs.length)) return outcomeText(res);

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
      return `⚠️ ${e.message} So I haven't reserved **${job.code}** for you.`;
    }
    ctx.log.warn(`Could not write ${job.code} to the sheet: ${e.message}`);
    return `${outcomeText(res)}\n⚠️ I couldn't update the airline's sheet (${e.message}), so it doesn't show your name yet. Please ask a manager to add you to **${job.code}** there.`;
  }
  for (const legNo of res.reserved) ctx.store.setReservationSheetName(job.id, legNo, name);
  return `${outcomeText(res)}\n📝 I've put **${plainText(name)}** against it in the airline's sheet. Not how you appear there? Reply \`name <your name>\` and I'll use that from now on.`;
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
function rememberPilotId(ctx: BotContext, discordId: string, fshubId: number, name: string | null = null): void {
  ctx.store.setPilotId(discordId, fshubId, ctx.now(), name);
  for (const panelId of ctx.store.listPanelIdsHeldBy(discordId)) ctx.panels.schedule(panelId);
}

/**
 * What FsHub says about an ID someone typed.
 * - `found`: a pilot with that ID exists; `name` is theirs
 * - `missing`: FsHub has no such pilot, so it was most likely mistyped
 * - `unchecked`: FsHub could not be asked (no token saved, offline, busy). The ID is taken as typed, as it always was.
 */
type PilotCheck = { status: 'found'; name: string } | { status: 'missing' } | { status: 'unchecked' };

async function checkPilotId(ctx: BotContext, id: number): Promise<PilotCheck> {
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
const pilotLabel = (id: number, name: string | null) => (name ? `**${id}** (${plainText(truncate(name, 40))} on FsHub)` : `**${id}**`);

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
  const panel = ctx.store.getPanel(panelId);
  if (!panel || panel.guildId !== interaction.guildId) throw new UserError('That panel is no longer active.');
  if (panel.requiredRoleId && !memberHasRole(interaction, panel.requiredRoleId)) {
    throw new UserError(`Reserving flights for **${panel.airlineName}** is limited to members with the <@&${panel.requiredRoleId}> role.`);
  }
  if (ctx.jobs.open(panel.id).length === 0) throw new UserError('There are no open flights to reserve right now.');

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
  const panel = ctx.store.getPanel(panelId);
  if (!panel || panel.guildId !== interaction.guildId) throw new UserError('That panel is no longer active.');

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

/** The Search button: a small form asking where from, where to, and on which day. Each is optional, but one is needed. */
async function startSearch(ctx: BotContext, interaction: ButtonInteraction, panelId: number): Promise<void> {
  const panel = ctx.store.getPanel(panelId);
  if (!panel || panel.guildId !== interaction.guildId) throw new UserError('That panel is no longer active.');
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
    );
  await interaction.showModal(modal);
}

/** The search form was sent: find the flights (only ones the panel lists) and answer privately with them. */
async function runSearch(ctx: BotContext, interaction: ModalSubmitInteraction, panelId: number): Promise<void> {
  await interaction.deferReply({ flags: MessageFlags.Ephemeral });
  const panel = ctx.store.getPanel(panelId);
  if (!panel || panel.guildId !== interaction.guildId) throw new UserError('That panel is no longer active.');
  const from = parseAirportCodes(interaction.fields.getTextInputValue('from'));
  const to = parseAirportCodes(interaction.fields.getTextInputValue('to'));
  const skipped = [...from.ignored, ...to.ignored];

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

  if (from.codes.length === 0 && to.codes.length === 0 && !day) {
    throw new UserError(
      skipped.length > 0
        ? `I couldn't use ${skipped.map((c) => `\`${c}\``).join(', ')} as an airport code. Airport codes are two to four letters or numbers, like \`EGLL\`.`
        : 'Type where you want to fly from, where you want to fly to, a date, or any of them together.',
    );
  }
  const matches = ctx.jobs.search(panel, from.codes, to.codes, day);
  await interaction.editReply({
    content: skipped.length > 0 ? `I skipped ${skipped.map((c) => `\`${c}\``).join(', ')}: not airport codes.` : '',
    embeds: searchEmbeds(panel, from.codes, to.codes, matches, ctx.now(), day),
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
  const panel = ctx.store.getPanel(panelId);
  if (!panel || panel.guildId !== interaction.guildId) throw new UserError('That panel is no longer active.');
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
  const problem = ctx.jobs.backupProblem(view, user.id);
  if (problem) {
    const attempts = session.attempts + 1;
    if (attempts >= MAX_ATTEMPTS) {
      ctx.store.deleteSession(user.id);
      await say(user, `${problem}\nThat's a few flights I couldn't use, so I've closed this. Press **Backup pilot** on the panel to start again.`);
      return;
    }
    ctx.store.upsertSession({ ...session, attempts, expiresAt: ctx.now() + SESSION_TTL_MS });
    await say(user, `${problem}\nSend a different flight ID, or say \`cancel\`.`);
    return;
  }
  const done = ctx.jobs.addBackup(view.job.id, { discordId: user.id, username: user.username });
  ctx.store.deleteSession(user.id);
  await say(
    user,
    `🛟 You're down as backup for **${done.job.code}** (${routeText(done.legs)}). The panel shows your name. If the pilot gives it back I'll tell you, and you can stand down any time from **My flights**.`,
  );
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

async function releaseSelected(ctx: BotContext, interaction: StringSelectMenuInteraction, panelId: number): Promise<void> {
  await interaction.deferUpdate();
  const freed: string[] = [];
  const stoodDown: string[] = [];
  const written: Array<{ sourceKey: string; name: string }> = [];
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
    const done = ctx.jobs.release(job.id, interaction.user.id, [legNo as number]);
    if (done.length > 0) {
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
  const said = [
    freed.length > 0 ? `Released: ${freed.join(', ')}. The panel is updated and those legs are free again.${note}` : '',
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
 */
async function completeFromFsHub(ctx: BotContext, interaction: ButtonInteraction, panel: Panel): Promise<void> {
  const user = interaction.user;
  const reply = (content: string) => interaction.editReply({ content, allowedMentions: noPings });

  const held = ctx.jobs.completable(panel.id, user.id);
  if (held.length === 0) {
    await reply("You don't have a flight to complete. Reserve one first; once you've flown it, press **Complete** and I'll check FsHub for your landing.");
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
  const confirmed = confirmationsFor(ctx.store, current, started, now, { strict: true });
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

    // Where the airline's sheet follows what pilots do, tick the flight there too, as completing by hand does.
    const inSheet = writesToSheet(ctx, current, view.legs.length);
    if (inSheet) {
      try {
        await ctx.writeback!.complete(current, view.job.sourceKey, pilotNameFor(ctx, user));
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
      ctx.jobs.complete(view.job.id, user.id, 'fshub');
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
  }
  const waiting = held.length - started.length;
  if (waiting > 0) lines.push(`${waiting} other flight${waiting === 1 ? '' : 's'} you hold ${waiting === 1 ? "hasn't" : "haven't"} started yet.`);
  if (doneCount > 0 && sheetNotWritten) lines.push("ℹ️ I can't write to the airline's sheet, so it still shows those as not done there. The panel is up to date.");
  await reply(lines.join('\n'));
}

/** The Complete button: on a panel linked to FsHub, complete what FsHub shows flown; otherwise pick which flights you have flown. */
async function startCompletion(ctx: BotContext, interaction: ButtonInteraction, panelId: number): Promise<void> {
  await interaction.deferReply({ flags: MessageFlags.Ephemeral });
  const panel = ctx.store.getPanel(panelId);
  if (!panel || panel.guildId !== interaction.guildId) throw new UserError('That panel is no longer active.');
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
  const panel = ctx.store.getPanel(panelId);
  if (!panel || panel.guildId !== interaction.guildId) throw new UserError('That panel is no longer active.');
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
  const panel = ctx.store.getPanel(panelId);
  if (!panel || panel.guildId !== interaction.guildId) throw new UserError('That panel is no longer active.');
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
      await say(user, 'To reserve a flight, press **Reserve** on a flight panel in your server (or **Backup pilot** to stand by for one that is taken). I\'ll ask for the flight ID here. Send me `flights` any time to see the flights you have, or `my contributions` to see what your completed flights made for the airline.');
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

  const view = ctx.jobs.findByCode(panel, text);
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
    await backUpFlight(ctx, user, session, view);
    return;
  }
  await proceedWithJob(ctx, user, session, view);
}

/** Found the flight: take it straight away if it has one leg, otherwise ask which legs. */
async function proceedWithJob(
  ctx: BotContext,
  user: Message['author'],
  session: DmSession,
  view: JobView,
): Promise<void> {
  if (view.legs.length === 1) {
    ctx.store.deleteSession(user.id);
    await say(user, await reserveFor(ctx, user, view.job.id, [1]));
    return;
  }
  ctx.store.upsertSession({ ...session, step: 'await_mode', jobId: view.job.id, pendingLegs: [], attempts: 0, expiresAt: ctx.now() + SESSION_TTL_MS });
  await say(
    user,
    `${jobBlock(view, ctx.now())}\n\n**${view.job.code}** has ${view.legs.length} legs. Are you flying all of them, or just some?`,
    [row(button('dm:all', 'All legs', ButtonStyle.Success), button('dm:some', 'Some legs', ButtonStyle.Primary), button('dm:cancel', 'Cancel', ButtonStyle.Secondary))],
  );
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

/** Buttons on the panel itself: `panel:reserve:<id>`, `panel:mine:<id>`, `panel:release:<id>` (menu). */
export const panelHandler: ComponentHandler = {
  prefix: 'panel',
  async handle(ctx, interaction) {
    const [, action, rawId, extra] = interaction.customId.split(':');
    const panelId = Number(rawId);
    if (!Number.isInteger(panelId)) throw new UserError('That button is out of date.');
    if (action === 'reserve' && interaction.isButton()) return startReservation(ctx, interaction, panelId);
    if (action === 'mine' && interaction.isButton()) return showMine(ctx, interaction, panelId);
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
