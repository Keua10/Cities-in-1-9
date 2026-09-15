/** Saved balances and simulation costs are in ledger units. One unit is now 10,000 won.
 * Keep this conversion at the UI boundary: old saves retain their purchasing power. */
export const WON_PER_UNIT = 10_000;
export const MAX_ADMIN_WON = 1_000_000_000_000;

export function toWon(units: number): number {
  return Math.round(units * WON_PER_UNIT);
}

export function formatMoney(units: number, compact = false, signed = false): string {
  const won = toWon(units);
  if (!Number.isFinite(won)) return '—';
  const abs = Math.abs(won);
  const sign = won < 0 ? '-' : signed && won > 0 ? '+' : '';
  const tier = compact
    ? [
        [1_000_000_000_000, '조'],
        [100_000_000, '억'],
        [10_000, '만'],
      ].find(([n]) => abs >= Number(n))
    : undefined;
  const number = tier
    ? `${(abs / Number(tier[0])).toLocaleString('ko-KR', { maximumFractionDigits: 2 })}${tier[1]}`
    : abs.toLocaleString('ko-KR');
  return `${sign}₩${number}`;
}

/** User enters won; return ledger units for the existing save/simulation contract. */
export function parseAdminMoney(value: string): number | null {
  if (!/^\d+$/.test(value.trim())) return null;
  const won = Number(value);
  return Number.isSafeInteger(won) && won >= 0 && won <= MAX_ADMIN_WON ? won / WON_PER_UNIT : null;
}
