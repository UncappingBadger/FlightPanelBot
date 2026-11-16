import { ActionRowBuilder, ButtonBuilder, ButtonStyle, type Message, type MessageActionRowComponentBuilder } from 'discord.js';
import { NOTICE_KINDS, type NoticeKind } from '../db/store.js';
import { NOTICE_INFO, NOTICES_REQUEST, parseNoticeChange } from '../services/notices.js';
import type { BotContext, ComponentHandler } from './context.js';
import { noPings } from './ui.js';

export { NOTICES_REQUEST };

const state = (on: boolean) => (on ? '✅ on' : '🔕 off');

/** The settings as a message: what each optional message is and whether it is on, and what always stays on. `note` goes first. */
export function noticesText(prefs: Record<NoticeKind, boolean>, note = ''): string {
  return [
    ...(note ? [note, ''] : []),
    '🔔 **Your notifications**',
    'I send two kinds of message that you can switch off:',
    ...NOTICE_KINDS.map((k) => `• **${NOTICE_INFO[k].name}**: ${state(prefs[k])}. ${NOTICE_INFO[k].what}`),
    '',
    'What I tell you about your reservations always stays on: a flight of yours being released or removed, a backup spot ending, and a manager changing your FsHub pilot ID. So does every answer to something you did yourself.',
    'Press a button to switch one, or send me `notifications completed off`, `notifications takeoff on`, `notifications off` (both) or `notifications on`.',
  ].join('\n');
}

/**
 * One button for each kind, showing whether it is on; pressing it switches that one. The button says which way it switches
 * (`notices:completed:off`), so an old message pressed twice does not flip the setting back.
 */
export function noticesButtons(prefs: Record<NoticeKind, boolean>): ActionRowBuilder<MessageActionRowComponentBuilder>[] {
  return [
    new ActionRowBuilder<MessageActionRowComponentBuilder>().addComponents(
      NOTICE_KINDS.map((k) =>
        new ButtonBuilder()
          .setCustomId(`notices:${k}:${prefs[k] ? 'off' : 'on'}`)
          .setLabel(`${NOTICE_INFO[k].name}: ${prefs[k] ? 'on' : 'off'}`)
          .setStyle(prefs[k] ? ButtonStyle.Success : ButtonStyle.Secondary),
      ),
    ),
  ];
}

/** What changed, in a line. */
function changeNote(kinds: NoticeKind[], on: boolean): string {
  const names = kinds.map((k) => `**${NOTICE_INFO[k].name}**`).join(' and ');
  return `${on ? '✅ Switched on' : '🔕 Switched off'}: ${names}.`;
}

/**
 * `notifications ...` in a DM: show which optional messages the person gets, or switch some on or off. It leaves an open
 * Reserve conversation alone.
 */
export async function showNotices(ctx: BotContext, message: Message, argument: string): Promise<void> {
  const user = message.author;
  const change = parseNoticeChange(argument);
  let note = '';
  if (change.kind === 'set') {
    for (const k of change.kinds) ctx.store.setNotice(user.id, k, change.on, ctx.now());
    note = changeNote(change.kinds, change.on);
  } else if (change.kind === 'unclear') {
    note = "I couldn't tell what you wanted to change, so nothing is different. Here is how things are:";
  }
  const prefs = ctx.store.getNotices(user.id);
  await user.send({ content: noticesText(prefs, note), components: noticesButtons(prefs), allowedMentions: noPings });
}

/** The buttons on that message: `notices:<kind>:<on|off>`. The message is redrawn to show how things are now. */
export const noticesHandler: ComponentHandler = {
  prefix: 'notices',
  async handle(ctx, interaction) {
    if (!interaction.isButton()) return;
    const [, kind, way] = interaction.customId.split(':');
    const wanted = NOTICE_KINDS.find((k) => k === kind);
    if (!wanted || (way !== 'on' && way !== 'off')) {
      await interaction.update({ content: 'That button is out of date. Send me `notifications` for the current ones.', components: [], allowedMentions: noPings });
      return;
    }
    const userId = interaction.user.id;
    ctx.store.setNotice(userId, wanted, way === 'on', ctx.now());
    const prefs = ctx.store.getNotices(userId);
    await interaction.update({ content: noticesText(prefs, changeNote([wanted], way === 'on')), components: noticesButtons(prefs), allowedMentions: noPings });
  },
};
