import { e } from '../utils/emoji';
import { pricing } from '../services/pricing';
import type { AssetSymbol } from '../config';

export async function formatWalletMessage(
  balances: Array<{ asset: string; available: number; locked: number }>
): Promise<string> {
  let totalUSD = 0;
  const lines: string[] = [
    `${e('wallet')} <b>YOUR VEYLO WALLET</b>`,
    '',
  ];

  for (const bal of balances) {
    const usdValue = await pricing.convertToUSD(bal.asset, bal.available);
    const ngnValue = await pricing.convertToNGN(bal.asset, bal.available);
    totalUSD += usdValue;
    
    lines.push(
      `${bal.asset === 'BNB' ? '🟡' : '🟢'} <b>${bal.asset}</b>`,
      `${bal.available.toFixed(6)} ${bal.asset}`,
      `≈ ${pricing.formatUSD(usdValue)}`,
      `≈ ${pricing.formatNGN(ngnValue)}`,
      bal.locked > 0 ? `🔒 Locked: ${bal.locked.toFixed(6)}` : '',
      ''
    );
  }

  lines.splice(2, 0, `<b>Total Balance</b>`, `${pricing.formatUSD(totalUSD)}`, '');

  return lines.filter(Boolean).join('\n');
}

export function formatWelcomeMessage(firstName: string): string {
  return [
    `${e('lightning')} <b>Welcome to VEYLO</b>`,
    '',
    `Your crypto wallet built for speed.`,
    '',
    `Manage your assets, receive payments, create giveaways, and earn with simple Telegram tools.`,
    '',
    `Fast. Simple. Secure.`,
  ].join('\n');
}

export function formatDepositMessage(asset: string, address: string): string {
  return [
    `${e('deposit')} <b>DEPOSIT ${asset}</b>`,
    '',
    `<b>Network:</b> BNB Smart Chain (BEP20)`,
    '',
    `Send only ${asset} BEP20 to this address.`,
    '',
    `<code>${address}</code>`,
    '',
    `⚠️ Sending wrong assets or networks may result in permanent loss.`,
  ].join('\n');
}

export function formatGiveawayCreatedMessage(
  asset: string,
  total: number,
  claimers: number,
  reward: number,
  code: string
): string {
  return [
    `${e('party')} <b>GIVEAWAY CREATED</b>`,
    '',
    `<b>Total:</b> ${total} ${asset}`,
    `<b>Claimers:</b> ${claimers}`,
    `<b>Reward:</b> ${reward.toFixed(6)} ${asset} each`,
    '',
    `Claim Link:`,
    `<code>https://t.me/${process.env.BOT_USERNAME}?start=giveaway_${code}</code>`,
  ].join('\n');
}

export function formatClaimSuccessMessage(asset: string, amount: number): string {
  return [
    `${e('party')} <b>SPOT SECURED!</b>`,
    '',
    `You successfully secured a giveaway spot.`,
    '',
    `<b>Reward:</b> ${amount} ${asset}`,
    `<b>Estimated Value:</b> ≈ ${pricing.formatUSD(0)}`,
    '',
    `Your reward will be sent after you provide your ${asset} BEP20 address.`,
    '',
    `📥 Send your ${asset} BEP20 wallet address.`,
    '',
    `⚠️ Must support BNB Smart Chain (BEP20)`,
  ].join('\n');
}

export function formatAccountMessage(user: {
  firstName: string | null;
  username: string | null;
  joinDate: Date;
  walletAddress: string | null;
}): string {
  return [
    `${e('person')} <b>MY ACCOUNT</b>`,
    '',
    `<b>Name:</b> ${user.firstName || 'N/A'}`,
    `<b>Username:</b> ${user.username ? '@' + user.username : 'N/A'}`,
    `<b>Joined:</b> ${user.joinDate.toLocaleDateString('en-US', { month: 'long', year: 'numeric' })}`,
    `<b>Wallet:</b> <code>${user.walletAddress || 'Not created'}</code>`,
    `<b>Status:</b> 🟢 Active`,
  ].join('\n');
}
