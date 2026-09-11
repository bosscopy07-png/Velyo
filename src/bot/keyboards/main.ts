import { Markup } from 'telegraf';
import { e } from '../../utils/emoji';

// mainKeyboard is now a function — pass isAdmin to reveal the Admin button
export const mainKeyboard = (isAdmin = false) => {
  const rows = [
    [
      Markup.button.callback(`${e('wallet')} Wallet`, 'wallet'),
      Markup.button.callback(`${e('gift')} Giveaway`, 'giveaway'),
    ],
    [
      Markup.button.callback(`${e('document')} History`, 'history'),
    ],
    [
      Markup.button.callback(`${e('person')} Account`, 'account'),
      Markup.button.callback(`${e('help')} Help`, 'help'),
    ],
  ];
  if (isAdmin) {
    rows.push([Markup.button.callback(`${e('shield')} Admin`, 'admin')]);
  }
  return Markup.inlineKeyboard(rows);
};

export const walletKeyboard = Markup.inlineKeyboard([
  [
    Markup.button.callback(`${e('deposit')} Deposit`, 'wallet:deposit'),
    Markup.button.callback(`${e('refresh')} Refresh`, 'wallet:refresh'),
  ],
  [
    Markup.button.callback(`${e('gift')} Giveaway`, 'giveaway'),
    Markup.button.callback(`${e('document')} History`, 'wallet:history'),
  ],
  [Markup.button.callback(`${e('back')} Back`, 'main')],
]);

export const depositKeyboard = (asset: string) => Markup.inlineKeyboard([
  [
    Markup.button.callback(`${e('copy')} Copy Address`, `wallet:copy:${asset}`),
    Markup.button.callback(`${e('refresh')} Check Deposit`, `wallet:check:${asset}`),
  ],
  [Markup.button.callback(`${e('back')} Back`, 'wallet')],
]);

export const giveawayTypeKeyboard = Markup.inlineKeyboard([
  [
    Markup.button.callback(`${e('person')} Single Claim`, 'giveaway:single'),
    Markup.button.callback(`${e('people')} Multiple Claim`, 'giveaway:multiple'),
  ],
  [
    Markup.button.callback(`${e('chart')} My Giveaways`, 'giveaway:mine'),
    Markup.button.callback(`${e('back')} Back`, 'main'),
  ],
]);

export const backKeyboard = (callback: string) => Markup.inlineKeyboard([
  [Markup.button.callback(`${e('back')} Back`, callback)],
]);

export const confirmCancelKeyboard = (confirm: string, cancel: string) => Markup.inlineKeyboard([
  [
    Markup.button.callback(`${e('check')} Confirm`, confirm),
    Markup.button.callback(`${e('cancel')} Cancel`, cancel),
  ],
]);

// `back` parameter lets callers override the Back target (default 'main')
export const assetKeyboard = (callbackPrefix: string, back = 'main') => Markup.inlineKeyboard([
  [
    Markup.button.callback('🟡 BNB', `${callbackPrefix}:BNB`),
    Markup.button.callback('🟢 USDT (BEP20)', `${callbackPrefix}:USDT`),
  ],
  [Markup.button.callback(`${e('back')} Back`, back)],
]);

export const adminKeyboard = Markup.inlineKeyboard([
  [Markup.button.callback(`${e('chart')} Refresh Stats`, 'admin:stats')],
  [Markup.button.callback(`${e('people')} Broadcast`, 'admin:broadcast')],
  [Markup.button.callback(`${e('back')} Back`, 'main')],
]);
    
