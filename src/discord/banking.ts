import { ActionRowBuilder, ButtonBuilder, ButtonStyle, StringSelectMenuBuilder, StringSelectMenuOptionBuilder, type Message, type MessageActionRowComponentBuilder } from 'discord.js';
import type { BankAccount } from '../aeroconomy/banking.js';
import type { BankingAccount, BankingOffered } from '../db/store.js';
import { normalizeFsHubToken } from '../fshub/client.js';
import { BANKING_POLL_MS, MAX_TOKEN_TRIES, TOKEN_WAIT_MS } from '../services/banking.js';
import { kindText, last4, NO_ACCOUNTS_LEFT_TEXT, TOKEN_LOST_TEXT, TOKEN_REJECTED_TEXT } from '../services/bankingText.js';
import { plainText, truncate } from '../util/format.js';
import type { BotContext, ComponentHandler } from './context.js';
import { noPings } from './ui.js';

/** `/banking` (the slash is optional) in a DM, and what may follow it: `off` to stop. */
export const BANKING_REQUEST = /^\/?banking(?:\s+([\s\S]*))?$/i;

type Row = ActionRowBuilder<MessageActionRowComponentBuilder>;

const OFF_WORDS = new Set(['off', 'stop', 'disable', 'turn off', 'cancel', 'delete', 'remove']);
const CANCEL_WORDS = new Set(['cancel', 'stop', 'nevermind', 'never mind', 'quit', 'exit']);
const MENU_MAX = 25;

/* ------------------------------------------------------------------ the words */

export const BANKING_INTRO = [
  '💵 **Payment messages**',
  'I can message you here whenever money goes **into or out of** the Aeroconomy bank accounts you choose: your own, and any business accounts you have. I only ever **read**. I cannot pay, move or change anything.',
  '',
  'To read your accounts I need an API token. Aeroconomy accepts your **FsHub personal access token** for this:',
  '1. Sign in at fshub.io and open <https://fshub.io/settings/integrations>.',
  '2. Create a personal access token. A new one just for this is best, so you can delete it at any time without touching anything else. If FsHub lets you choose what it may do, choose the least.',
  '3. Copy it and **send it to me in this chat**.',
  '',
  'Before you do:',
  "• Aeroconomy's documentation lists no limits on what a token can do, so treat it like a password. I only use it to read your accounts and their payments, and I only ever send it to Aeroconomy.",
  '• I keep it **encrypted** on the computer of whoever runs this bot, and **delete it** as soon as you turn this off (send `/banking` again) or Aeroconomy stops accepting it. Whoever runs the bot can reach that computer, so only go on if you trust them.',
  '• Afterwards, **delete your message with the token** from this chat. I cannot do that for you.',
  '',
  'Say `cancel` to stop.',
].join('\n');

const WAITING_TEXT = "I'm waiting for your token (the long run of letters and numbers from fshub.io/settings/integrations). Send it on its own, or say `cancel`.";

export const BANKING_OFF_TEXT =
  '🔕 Payment messages are **off**. I have **deleted your token** and the list of accounts from my memory, so I can no longer see your Aeroconomy accounts at all. If you like, you can also delete the token itself at fshub.io/settings/integrations.';

const accountLine = (a: { name: string; number: string; kind: string | null }): string => `• **${plainText(a.name)}** (${kindText(a.kind)}, ${last4(a.number)})`;

/** What is being watched, and how to change it. `note` goes first. */
export function bankingStatusText(accounts: Array<{ name: string; number: string; kind: string | null }>, note = ''): string {
  return [
    ...(note ? [note, ''] : []),
    '💵 **Payment messages are on**',
    "I'm watching:",
    ...accounts.map(accountLine),
    '',
    `I look about every ${Math.round(BANKING_POLL_MS / 60_000)} minutes and message you here when money goes into or out of them.`,
    'To change which accounts I watch, choose them below. To stop, press **Turn off**: I delete your token and tell you so.',
  ].join('\n');
}

function chooseText(note = ''): string {
  return [
    ...(note ? [note, ''] : []),
    '✅ Aeroconomy accepted the token, and I have saved it (encrypted). **Delete your message with it from this chat now.**',
    '',
    `Which accounts should I watch? Choose one or more below. Only payments from now on are told; I will not send your history. If you don't choose within ${Math.round(TOKEN_WAIT_MS / 60_000)} minutes, I delete the token again.`,
  ].join('\n');
}

/* ------------------------------------------------------------------ the buttons and the list */

const offButton = (): ButtonBuilder => new ButtonBuilder().setCustomId('banking:off').setLabel('Turn off and delete my token').setStyle(ButtonStyle.Danger);

function cancelRow(): Row[] {
  return [new ActionRowBuilder<MessageActionRowComponentBuilder>().addComponents(new ButtonBuilder().setCustomId('banking:cancel').setLabel('Cancel').setStyle(ButtonStyle.Secondary))];
}

/** The list of accounts to choose from (those watched are already picked), and the Turn off button when something is watched. */
export function bankingPicker(offered: BankingOffered[], watched: ReadonlySet<string>, withOff: boolean): Row[] {
  const shown = offered.slice(0, MENU_MAX);
  const menu = new StringSelectMenuBuilder()
    .setCustomId('banking:pick')
    .setPlaceholder('Choose the accounts to watch')
    .setMinValues(1)
    .setMaxValues(shown.length)
    .addOptions(
      shown.map((a) =>
        new StringSelectMenuOptionBuilder()
          .setLabel(truncate(`${a.name} · ${a.type ?? 'account'}`.replace(/\s+/g, ' '), 100))
          .setValue(a.number)
          .setDescription(truncate(`Account ${last4(a.number)}`, 100))
          .setDefault(watched.has(a.number)),
      ),
    );
  const rows: Row[] = [new ActionRowBuilder<MessageActionRowComponentBuilder>().addComponents(menu)];
  if (withOff) rows.push(new ActionRowBuilder<MessageActionRowComponentBuilder>().addComponents(offButton()));
  return rows;
}

const tooManyNote = (offered: BankingOffered[]): string => (offered.length > MENU_MAX ? `\n(Discord shows only ${MENU_MAX} at a time; these are the first ${MENU_MAX} of ${offered.length}.)` : '');

type Sender = Message['author'];

async function say(user: Sender, content: string, components: Row[] = []): Promise<void> {
  await user.send({ content, components, allowedMentions: noPings });
}

function endedText(why: 'rejected' | 'lost' | 'no-accounts'): string {
  return why === 'rejected' ? TOKEN_REJECTED_TEXT : why === 'lost' ? TOKEN_LOST_TEXT : NO_ACCOUNTS_LEFT_TEXT;
}

/* ------------------------------------------------------------------ `/banking` */

/**
 * `/banking` in a DM. With nothing set up it explains what it does and asks for the pilot's token. Once there is a token it lets them choose the accounts to
 * watch (their own and their businesses'); sent again it shows what is watched and lets them change it or turn it off. `/banking off` turns it off at once.
 * When it is off the token is deleted, and the pilot is told so.
 */
export async function showBanking(ctx: BotContext, message: Message, argument: string): Promise<void> {
  const user = message.author;
  const word = argument.trim().toLowerCase();

  if (OFF_WORDS.has(word)) {
    const had = ctx.banking.link(user.id) !== null;
    ctx.banking.turnOff(user.id);
    await say(user, had ? BANKING_OFF_TEXT : 'Payment messages were not on, and I have no token of yours.');
    return;
  }

  const link = ctx.banking.link(user.id);
  if (!link || link.step === 'await_token') {
    ctx.banking.beginSetup(user.id);
    await say(user, BANKING_INTRO, cancelRow());
    return;
  }

  const offer = await ctx.banking.offer(user.id);
  if (offer.kind === 'ended') {
    await say(user, `${endedText(offer.why)}`);
    return;
  }
  if (offer.kind === 'unavailable') {
    const watching = ctx.banking.accountsOf(user.id);
    await say(
      user,
      `${watching.length > 0 ? `${bankingStatusText(watching)}\n\n` : ''}⚠️ I couldn't reach Aeroconomy just now to list your accounts (${offer.message.replace(/\.$/, '')}). Send \`/banking\` again in a minute to change them, or \`/banking off\` to turn this off.`,
      watching.length > 0 ? [new ActionRowBuilder<MessageActionRowComponentBuilder>().addComponents(offButton())] : [],
    );
    return;
  }
  if (offer.kind !== 'accounts') return;

  const offered: BankingOffered[] = offer.accounts.map((a) => ({ number: a.number, name: a.name, type: a.type }));
  const watching = ctx.banking.accountsOf(user.id);
  if (link.step === 'choose' || watching.length === 0) {
    await say(user, `${chooseText()}${tooManyNote(offered)}`, bankingPicker(offered, offer.watched, false));
    return;
  }
  await say(user, `${bankingStatusText(watching)}${tooManyNote(offered)}`, bankingPicker(offered, offer.watched, true));
}

/** What a pilot sent while we are waiting for their token: try it. Returns false if this is not for the token (the message is then handled as any other). */
export async function maybeTakeToken(ctx: BotContext, message: Message, text: string): Promise<boolean> {
  const user = message.author;
  if (!ctx.banking.isWaitingForToken(user.id)) return false;
  const hasSession = ctx.store.getSession(user.id, ctx.now()) !== null;
  if (CANCEL_WORDS.has(text.toLowerCase())) {
    if (hasSession) return false; // the Reserve conversation has the word
    ctx.banking.cancelSetup(user.id);
    await say(user, 'Okay, cancelled. I saved nothing. Send `/banking` whenever you want to set it up.');
    return true;
  }
  const looksLikeToken = /^[\x21-\x7e]{16,256}$/.test(normalizeFsHubToken(text));
  if (!looksLikeToken) {
    if (hasSession) return false;
    await say(user, WAITING_TEXT, cancelRow());
    return true;
  }

  const r = await ctx.banking.submitToken(user.id, text);
  switch (r.kind) {
    case 'not-waiting':
      return false;
    case 'bad-shape':
      await say(user, r.gaveUp ? `${r.message}\nThat's ${MAX_TOKEN_TRIES} tries, so I've stopped and saved nothing. Send \`/banking\` to start again.` : `${r.message}\nSend it again, or say \`cancel\`.`);
      return true;
    case 'rejected':
      await say(
        user,
        r.gaveUp
          ? `Aeroconomy didn't accept that token either. That's ${MAX_TOKEN_TRIES} tries, so I've stopped and saved nothing. Check the token at fshub.io/settings/integrations, then send \`/banking\` to start again.`
          : "Aeroconomy didn't accept that token. Check that you copied all of it (no spaces) and that it hasn't been deleted at fshub.io/settings/integrations, then send it again, or say `cancel`. (If Aeroconomy has given you an API token of its own, you can send that instead.)",
      );
      return true;
    case 'forbidden':
      await say(user, "Aeroconomy accepted that token but won't show it any bank accounts, so I can't use it. I kept nothing. Send a different token, or say `cancel`.");
      return true;
    case 'unavailable':
      await say(user, `I couldn't reach Aeroconomy just now (${r.message.replace(/\.$/, '')}). I kept nothing. Send the token again in a minute, or say \`cancel\`.`);
      return true;
    case 'no-accounts':
      await say(user, 'That token works, but Aeroconomy shows no bank accounts for it, so there is nothing for me to watch. I kept nothing.');
      return true;
    case 'accounts': {
      const offered = ctx.banking.link(user.id)?.offered ?? r.accounts.map((a: BankAccount) => ({ number: a.number, name: a.name, type: a.type }));
      await say(user, `${chooseText()}${tooManyNote(offered)}`, bankingPicker(offered, new Set(), false));
      return true;
    }
  }
}

/* ------------------------------------------------------------------ the buttons and the list */

/** `banking:pick` (the accounts chosen), `banking:off` (turn off and delete the token) and `banking:cancel` (stop waiting for a token). */
export const bankingHandler: ComponentHandler = {
  prefix: 'banking',
  async handle(ctx, interaction) {
    const action = interaction.customId.split(':')[1];
    const userId = interaction.user.id;
    const stale = { content: 'That is out of date. Send me `/banking` for the current settings.', components: [] as Row[], allowedMentions: noPings };

    if (action === 'off' && interaction.isButton()) {
      const had = ctx.banking.link(userId) !== null;
      ctx.banking.turnOff(userId);
      await interaction.update({ content: had ? BANKING_OFF_TEXT : 'Payment messages were not on, and I have no token of yours.', components: [], allowedMentions: noPings });
      return;
    }

    if (action === 'cancel' && interaction.isButton()) {
      const was = ctx.banking.cancelSetup(userId);
      await interaction.update({ content: was ? 'Okay, cancelled. I saved nothing. Send `/banking` whenever you want to set it up.' : stale.content, components: [], allowedMentions: noPings });
      return;
    }

    if (action === 'pick' && interaction.isStringSelectMenu()) {
      // Looking at the first payment of each account takes a few seconds, longer than Discord waits for an answer.
      await interaction.deferUpdate();
      const r = await ctx.banking.choose(userId, interaction.values);
      if (r.kind === 'none' || r.kind === 'nothing-chosen') {
        await interaction.editReply(stale);
        return;
      }
      if (r.kind === 'ended') {
        await interaction.editReply({ content: endedText(r.why), components: [], allowedMentions: noPings });
        return;
      }
      if (r.kind === 'unreadable') {
        await interaction.editReply({ content: `Aeroconomy won't show me ${r.names.map((n) => `**${plainText(n)}**`).join(', ')} with your token, so nothing is changed. Choose another account, or send \`/banking off\` to turn this off.`, allowedMentions: noPings });
        return;
      }
      const link = ctx.banking.link(userId);
      const watched = new Set(r.accounts.map((a: BankingAccount) => a.number));
      const note = r.unreadable.length > 0 ? `⚠️ Aeroconomy won't show me ${r.unreadable.map((n) => `**${plainText(n)}**`).join(', ')}, so I left ${r.unreadable.length === 1 ? 'it' : 'them'} out.` : '✅ Done.';
      await interaction.editReply({ content: bankingStatusText(r.accounts, note), components: bankingPicker(link?.offered ?? [], watched, true), allowedMentions: noPings });
      return;
    }

    if (interaction.isButton() || interaction.isStringSelectMenu()) await interaction.update(stale);
  },
};
