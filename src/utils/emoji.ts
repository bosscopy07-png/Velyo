// VEYLO Premium Emoji System
// Maps custom emoji IDs for Telegram Premium support

export const EMOJIS = {
  // Core Brand
  lightning: '6132195567532512343',
  rocket: '6131845772511024828',

  // Navigation & UI
  wallet: '5359785904535774578',
  gift: '6217489739675604129',
  coin: '5381975814415866082',
  shield: '5042328396193864923',
  lock: '5269257919605516540',
  check: '6330245868284812606',
  settings: '5298572699193325446',
  warning: '6305575331323450417',
  back: '5440509136259267820',
  forward: '5436044822697750252',
  home: '5416041192905265756',
  refresh: '5264727218734524899',
  chart: '5884161133174067365',

  // Actions
  deposit: '5433811242135331842',
  send: '5433614747381538714',
  copy: '5039600026809009149',
  search: '5258274739041883702',
  cancel: '6131800692534285654',
  confirm: '5039844895779455925',
  edit: '5039826874096681939',

  // Financial
  money: '5039789890133296083',
  bank: '5264895611517300926',
  card: '5269472852653912623',
  diamond: '5384426402495893753',
  naira: '5294456308047563965',

  // Status
  star: '6131878581766198553',
  trophy: '5462927083132970373',
  crown: '6266995104687330978',
  target: '5877235236416266965',
  sparkle: '6131673419768403090',
  party: '5989848973974704652',
  fire: '5041845079229072486',

  // Misc
  people: '5453957997418004470',
  person: '5877235236416266965',
  clock: '5386367538735104399',
  link: '5859270552153231910',
  document: '5444856076954520455',
  globe: '5042186567783809934',
  help: '6132015934820324637',
  message: '6266794310671275367',
  bell: '6264510702329797113',
} as const;

export type EmojiKey = keyof typeof EMOJIS;

/**
 * Unicode fallback map — used for button labels, alerts, and log lines
 * (contexts where HTML custom-emoji tags cannot render)
 */
export const EMOJI_FALLBACK: Record<EmojiKey, string> = {
  lightning: '⚡',
  rocket: '🚀',
  wallet: '💼',
  gift: '🎁',
  coin: '🪙',
  shield: '🛡',
  lock: '🔒',
  check: '✅',
  settings: '⚙',
  warning: '⚠️',
  back: '◀️',
  forward: '➡️',
  home: '🏠',
  refresh: '🔄',
  chart: '📊',
  deposit: '📥',
  send: '📤',
  copy: '📋',
  search: '🔍',
  cancel: '❌',
  confirm: '✔️',
  edit: '🔖',
  money: '💰',
  bank: '🏦',
  card: '💳',
  diamond: '💎',
  naira: '🇳🇬',
  star: '⭐',
  trophy: '🏆',
  crown: '👑',
  target: '🎯',
  sparkle: '✨',
  party: '🎉',
  fire: '🔥',
  people: '👥',
  person: '👤',
  clock: '⌛',
  link: '🔗',
  document: '🧾',
  globe: '🌐',
  help: '❓',
  message: '💬',
  bell: '🔔',
};

/**
 * Premium custom emoji for HTML-parse-mode message captions/text.
 * Renders as the animated custom emoji in Telegram; the inner fallback char
 * shows anywhere the tg-emoji tag can't render.
 *
 * ⚠️ ONLY use in messages sent with parse_mode: 'HTML'. Never in button
 * labels (they're plain text) — use eb() there.
 */
export function e(key: EmojiKey): string {
  return `<tg-emoji emoji-id="${EMOJIS[key]}">${EMOJI_FALLBACK[key]}</tg-emoji>`;
}

/**
 * Plain unicode emoji for inline KEYBOARD BUTTON labels.
 * Button text never parses HTML, so <tg-emoji> tags would show as raw text.
 */
export function eb(key: EmojiKey): string {
  return EMOJI_FALLBACK[key];
}
