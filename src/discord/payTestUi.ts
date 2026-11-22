import { randomBytes } from 'node:crypto';
import { ActionRowBuilder, ButtonBuilder, ButtonStyle, MessageFlags, type MessageActionRowComponentBuilder } from 'discord.js';
import { NOT_CONNECTED_TEXT } from '../services/payGateway.js';
import { testRequest, type TestTransfer } from '../services/payTest.js';
import { plainText } from '../util/format.js';
import type { BotContext, ComponentHandler } from './context.js';
import { UserError } from './errors.js';
import { mayConfirm } from './profitUi.js';
import { noPings } from './ui.js';

/**
 * The confirmation of a test transfer. `/payroll test-transfer` works out what would be sent and shows it with a **Send** button; nothing moves until the admin
 * who asked presses it. Pressing it twice cannot send it twice: the first press takes it off the list, and the payment carries a unique ID that Aeroconomy
 * treats as one payment however often it is sent.
 */

const PENDING_MS = 10 * 60_000;

interface Pending {
  userId: string;
  guildId: string;
  transfer: TestTransfer;
  /** The payment's unique ID, made once, here: it is the payment's idempotency key. */
  uniqueId: string;
  expires: number;
}

const pending = new Map<string, Pending>();

const GONE = 'That test transfer has expired, or was already used. Nothing was sent. `/payroll test-transfer` makes a fresh one.';
const last4 = (n: string): string => n.slice(-4);

/** An amount in cents as dollars and cents, which a test of a dollar needs (`$1.00`, `$48,749.00`). */
const dollarsText = (cents: number): string => `$${(cents / 100).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;

const who = (a: { name: string; number: string }): string => `**${plainText(a.name)}** (\`${a.number}\`)`;

/** The message that asks for the go-ahead, and keeps the transfer waiting for it. */
export function askTest(ctx: BotContext, userId: string, guildId: string, airline: string, transfer: TestTransfer): { content: string; components: ActionRowBuilder<MessageActionRowComponentBuilder>[] } {
  const now = ctx.now();
  for (const [k, v] of pending) if (v.expires <= now) pending.delete(k);
  const token = randomBytes(9).toString('hex');
  pending.set(token, { userId, guildId, transfer, uniqueId: `fpb-test-${randomBytes(8).toString('hex')}`, expires: now + PENDING_MS });
  return {
    content: [
      `💷 **Test transfer** · ${plainText(airline)}`,
      `Send **${dollarsText(transfer.cents)}** from ${who(transfer.from)} to ${who(transfer.to)}?`,
      'This moves real money, once, between two accounts the FsHub token can see: it proves the bank connection works. Nothing is sent until you press **Send**, and pressing it twice sends it once.',
    ].join('\n'),
    components: [
      new ActionRowBuilder<MessageActionRowComponentBuilder>().addComponents(
        new ButtonBuilder().setCustomId(`paytest:go:${token}`).setLabel(`Send ${dollarsText(transfer.cents)}`).setStyle(ButtonStyle.Danger),
        new ButtonBuilder().setCustomId(`paytest:no:${token}`).setLabel('Cancel').setStyle(ButtonStyle.Secondary),
      ),
    ],
  };
}

/** `paytest:go:<token>` and `paytest:no:<token>`. Only the admin who asked can press them. */
export const payTestHandler: ComponentHandler = {
  prefix: 'paytest',
  async handle(ctx, interaction) {
    if (!interaction.isButton()) return;
    const [, way, token] = interaction.customId.split(':');
    if ((way !== 'go' && way !== 'no') || !token) throw new UserError('That button is out of date.');
    const kept = pending.get(token);
    if (!kept || kept.expires <= ctx.now()) {
      pending.delete(token);
      await interaction.update({ content: GONE, components: [], allowedMentions: noPings });
      return;
    }
    if (!(await mayConfirm(interaction, { userId: kept.userId, guildId: kept.guildId }, null))) {
      await interaction.reply({ content: 'Only the admin who asked for this test can confirm it.', flags: MessageFlags.Ephemeral, allowedMentions: noPings });
      return;
    }
    // Nothing is awaited between the check and taking it off the list, so when it is pressed twice at once only one press goes on.
    if (!pending.delete(token)) {
      await interaction.reply({ content: 'That was pressed a moment ago, so nothing more was sent.', flags: MessageFlags.Ephemeral, allowedMentions: noPings });
      return;
    }
    if (way === 'no') {
      await interaction.update({ content: 'Cancelled. Nothing was sent.', components: [], allowedMentions: noPings });
      return;
    }
    const gateway = ctx.payroll?.gateway;
    if (!gateway || !gateway.connected) {
      await interaction.update({ content: NOT_CONNECTED_TEXT, components: [], allowedMentions: noPings });
      return;
    }
    const t = kept.transfer;
    await interaction.update({ content: `Sending ${dollarsText(t.cents)} from ${who(t.from)} to ${who(t.to)}…`, components: [], allowedMentions: noPings });
    let text: string;
    try {
      const result = await gateway.pay(testRequest(t, kept.uniqueId));
      if (result.ok) {
        ctx.log.info(`A test transfer of ${dollarsText(t.cents)} (…${last4(t.from.number)} to …${last4(t.to.number)}) was taken by Aeroconomy`);
        text = [
          `✅ Sent **${dollarsText(t.cents)}** from ${who(t.from)} to ${who(t.to)}.`,
          ...(result.reference ? [`Aeroconomy's transaction number: \`${result.reference}\`.`] : []),
          ...(result.balanceCents != null ? [`${plainText(t.from.name)} now holds **${dollarsText(result.balanceCents)}**.`] : []),
          'The bank connection works: paying pilots from this account will send payments the same way.',
        ].join('\n');
      } else {
        text = `❌ Aeroconomy did not take it, so nothing was sent.\n${plainText(result.reason)}`;
      }
    } catch (e) {
      ctx.log.warn('A test transfer got no answer from Aeroconomy', e);
      text = `⛔ ${e instanceof Error ? plainText(e.message) : 'Aeroconomy gave no answer.'}\nCheck the transactions of both accounts on Aeroconomy before trying again: this test had its own ID, and a new test is a new payment.`;
    }
    await interaction.editReply({ content: text, allowedMentions: noPings });
  },
};
