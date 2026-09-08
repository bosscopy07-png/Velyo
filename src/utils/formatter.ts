export function formatCrypto(amount: number, decimals = 6): string {
  return amount.toLocaleString('en-US', {
    minimumFractionDigits: 0,
    maximumFractionDigits: decimals,
  });
}

export function truncate(str: string, length = 20): string {
  if (str.length <= length) return str;
  return str.slice(0, length / 2) + '...' + str.slice(-length / 2);
}
