import { MessageFlags, type ButtonInteraction } from 'discord.js';
import { confirmationsFor } from '../services/flightMatch.js';
import type { BotContext, ComponentInteraction } from './context.js';
import { UserError } from './errors.js';
import { avatarIdsOf, completedCard, noPings, openCard, stampFiles } from './ui.js';

/** A flight's card, shown privately, goes away by itself after this long. */
export const DETAILS_SHOWN_MS = 90_000;

/** The card each person has open on each panel, so pressing another flight (or waiting) takes the old one away. */
const showing = new Map<string, { interaction: ButtonInteraction; timer: NodeJS.Timeout }>();

/** Take a person's open card away, if they have one. Never throws: it may have been dismissed already. */
function closeDetails(key: string): void {
  const open = showing.get(key);
  if (!open) return;
  clearTimeout(open.timer);
  showing.delete(key);
  void Promise.resolve()
    .then(() => open.interaction.deleteReply())
    .catch(() => undefined);
}

/**
 * The buttons of a grid panel that are not the panel's own: a flight (shows its card privately, closing the last one the person
 * opened), and the fold buttons (anyone may fold or unfold; it is the same message for everyone). Each fold redraws the panel.
 */
export async function handleGridAction(ctx: BotContext, interaction: ComponentInteraction, action: string, panelId: number, extra: string | undefined): Promise<void> {
  if (!interaction.isButton()) throw new UserError('That button is out of date.');
  const panel = ctx.store.getPanel(panelId);
  if (!panel || (interaction.guildId !== null && interaction.guildId !== panel.guildId)) throw new UserError('That panel is gone.');
  if (panel.layout !== 'grid') throw new UserError('That button is out of date: this panel is drawn as cards now.');

  if (action === 'fold' || action === 'foldall' || action === 'unfoldall') {
    if (action === 'foldall') ctx.panels.setAllFolds(panelId, true);
    else if (action === 'unfoldall') ctx.panels.setAllFolds(panelId, false);
    else {
      const part = Number(extra);
      if (!Number.isInteger(part) || part < 0) throw new UserError('That button is out of date.');
      ctx.panels.setFold(panelId, part, !ctx.panels.foldsOf(panelId).has(part));
    }
    await interaction.deferUpdate();
    await ctx.panels.refresh(panelId);
    return;
  }

  // A flight: show its card to the person who pressed it, and no one else.
  const jobId = Number(extra);
  if (!Number.isInteger(jobId)) throw new UserError('That button is out of date.');
  await interaction.deferReply({ flags: MessageFlags.Ephemeral });
  const view = ctx.jobs.view(jobId);
  if (!view || view.job.panelId !== panelId || (view.job.status !== 'open' && view.job.completedAt === null)) {
    await interaction.editReply({ content: 'That flight is no longer on the panel. The panel will update in a moment.', allowedMentions: noPings });
    ctx.panels.schedule(panelId);
    return;
  }
  const now = ctx.now();
  const embeds =
    view.job.completedAt !== null
      ? [completedCard(view, confirmationsFor(ctx.store, panel, [view], now).get(view.job.id))]
      : [openCard(view, now, await ctx.panels.avatarsFor(avatarIdsOf([view])), { showOpened: true, eta: ctx.etas?.forPanel(panelId).get(view.job.id) ?? null })];
  const key = `${interaction.user.id}:${panelId}`;
  closeDetails(key);
  await interaction.editReply({ embeds, files: stampFiles(embeds), allowedMentions: noPings });
  const timer = setTimeout(() => closeDetails(key), DETAILS_SHOWN_MS);
  timer.unref?.();
  showing.set(key, { interaction, timer });
}
