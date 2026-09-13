import { Markup } from 'telegraf';
import { eb } from '../../utils/emoji';

// mainKeyboard is now a function — pass isAdmin to reveal the Admin button
export const mainKeyboard = (isAdmin = false) => {
  const rows = [
    [
      Markup.button.callback(`${eb('wallet')} Wallet`, 'wallet'),
      Markup.button.callback(`${eb('gift')} Giveaway`, 'giveaway'),
    ],
    [
      Markup.button.callback(`${eb('document')} History`, 'history'),
    ],
    [
      Markup.button.callback(`${eb('person')} Account`, 'account'),
      Markup.button.callback(`${eb('help')} Help`, 'help'),
    ],
  ];
  if (isAdmin) {
    rows.push([Markup.button.callback(`${eb('shield')} Admin`, 'admin')]);
  }
  return Markup.inlineKeyboard(rows);
};

export const walletKeyboard = Markup.inlineKeyboard([
  [
    Markup.button.callback(`${eb('deposit')} Deposit`, 'wallet:deposit'),
    Markup.button.callback(`${eb('refresh')} Refresh`, 'wallet:refresh'),
  ],
  [
    Markup.button.callback(`${eb('gift')} Giveaway`, 'giveaway'),
    Markup.button.callback(`${eb('document')} History`, 'wallet:history'),
  ],
  [Markup.button.callback(`${eb('back')} Back`, 'main')],
]);

export const depositKeyboard = (asset: string) => Markup.inlineKeyboard([
  [
    Markup.button.callback(`${eb('copy')} Copy Address`, `wallet:copy:${asset}`),
    Markup.button.callback(`${eb('refresh')} Check Deposit`, `wallet:check:${asset}`),
  ],
  [Markup.button.callback(`${eb('back')} Back`, 'wallet')],
]);

export const giveawayTypeKeyboard = Markup.inlineKeyboard([
  [
    Markup.button.callback(`${eb('person')} Single Claim`, 'giveaway:single'),
    Markup.button.callback(`${eb('people')} Multiple Claim`, 'giveaway:multiple'),
  ],
  [
    Markup.button.callback(`${eb('chart')} My Giveaways`, 'giveaway:mine'),
    Markup.button.callback(`${eb('back')} Back`, 'main'),
  ],
]);

export const backKeyboard = (callback: string) => Markup.inlineKeyboard([
  [Markup.button.callback(`${eb('back')} Back`, callback)],
]);

export const confirmCancelKeyboard = (confirm: string, cancel: string) => Markup.inlineKeyboard([
  [
    Markup.button.callback(`${eb('check')} Confirm`, confirm),
    Markup.button.callback(`${eb('cancel')} Cancel`, cancel),
  ],
]);

// `back` parameter lets callers override the Back target (default 'main')
export const assetKeyboard = (callbackPrefix: string, back = 'main') => Markup.inlineKeyboard([
  [
    Markup.button.callback('🟡 BNB', `${callbackPrefix}:BNB`),
    Markup.button.callback('🟢 USDT (BEP20)', `${callbackPrefix}:USDT`),
  ],
  [Markup.button.callback(`${eb('back')} Back`, back)],
]);

export const adminKeyboard = Markup.inlineKeyboard([
  [Markup.button.callback(`${eb('chart')} Refresh Stats`, 'admin:stats')],
  [Markup.button.callback(`${eb('people')} Broadcast`, 'admin:broadcast')],
  [Markup.button.callback(`${eb('back')} Back`, 'main')],
]);
  
