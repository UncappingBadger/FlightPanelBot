import type { BankParty, BankTransaction } from '../aeroconomy/banking.js';
import { formatMoney } from './contributions.js';
import { plainText, ts } from '../util/format.js';

/**
 * The words of a payment message. Names and descriptions come from other players, so they are made harmless (no formatting, no mentions) before they are
 * shown. Nothing here talks to anyone: it is text in, text out.
 */

/** The last four characters of an account number, so a message names the account without printing the whole number. */
export const last4 = (number: string): string => `…${number.slice(-4)}`;

interface Mine {
  number: string;
  name: string;
}

const accountText = (a: Mine): string => `**${plainText(a.name)}** (${last4(a.number)})`;

function partyText(p: BankParty | null): string {
  if (!p || (!p.name && !p.number)) return 'an account I cannot name';
  return `**${plainText(p.name ?? 'an account')}**${p.number ? ` (${last4(p.number)})` : ''}`;
}

/** A word for the kind of account Aeroconomy gave, or none. */
export function kindText(type: string | null): string {
  return type ? plainText(type.toLowerCase()) : 'account';
}

/**
 * One payment, as a message to the person whose account it touched. `mine` are their watched accounts the payment is listed under (one, or two when
 * they paid themselves). The money going in or out is decided by who sent it and who got it, and only then by the direction Aeroconomy gave.
 */
export function paymentMessage(tx: BankTransaction, mine: Mine[]): string {
  const own = new Map(mine.map((a) => [a.number, a]));
  const from = tx.sender?.number ? own.get(tx.sender.number) : undefined;
  const to = tx.recipient?.number ? own.get(tx.recipient.number) : undefined;
  const money = formatMoney(tx.amount);
  const lines: string[] = [];
  if (from && to) {
    lines.push(`↔️ **${money}** moved between your accounts: ${accountText(from)} → ${accountText(to)}`);
  } else if (to || (!from && tx.direction === 'credit')) {
    lines.push(`💰 **+${money}** into ${accountText((to ?? mine[0]) as Mine)}`, `From ${partyText(tx.sender)}`);
  } else if (from || tx.direction === 'debit') {
    lines.push(`💸 **-${money}** out of ${accountText((from ?? mine[0]) as Mine)}`, `To ${partyText(tx.recipient)}`);
  } else {
    lines.push(`💵 **${money}** on ${accountText(mine[0] as Mine)}`, `${partyText(tx.sender)} → ${partyText(tx.recipient)}`);
  }
  if (tx.description) lines.push(`For: ${plainText(tx.description)}`);
  if (tx.lines.length > 1) {
    for (const l of tx.lines.slice(0, 4)) lines.push(`• ${l.description ? plainText(l.description) : 'item'}: ${formatMoney(l.amount)}`);
    if (tx.lines.length > 4) lines.push(`• …and ${tx.lines.length - 4} more`);
  }
  if (tx.at !== null) lines.push(ts(tx.at, 'f'));
  return lines.join('\n');
}

/** Said first when there were more new payments than are sent one by one. */
export const manyPaymentsText = (total: number, shown: number): string => `💵 **${total}** new payments since I last looked. Here are the newest ${shown}; the rest are in your Aeroconomy bank.`;

/** What is said when the link ends because of something other than the person asking. */
export const TOKEN_REJECTED_TEXT =
  "🔕 Aeroconomy no longer accepts the token I had for you, so I've stopped watching your accounts and **deleted the token**. Send me `/banking` to set it up again with a new token.";
export const TOKEN_LOST_TEXT = "🔕 I can no longer read the token I had saved for you, so I've stopped watching your accounts and cleared what I had. Send me `/banking` to set it up again.";
export const NO_ACCOUNTS_LEFT_TEXT = "🔕 I can't read any of the accounts I was watching for you any more, so payment messages are **off** and your token is **deleted**. Send me `/banking` to start again.";
export const accountLostText = (a: Mine): string => `⚠️ Aeroconomy no longer shows me ${accountText(a)}, so I've stopped watching it.`;
