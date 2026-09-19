export function parsePriceToCents(raw: string | null | undefined): number | null {
  if (!raw?.trim()) {
    return null;
  }
  const match = raw.trim().replace(/[$,\s]/g, '').match(/^(\d+)(?:\.(\d{1,2}))?$/);
  if (!match) {
    return null;
  }
  const dollars = Number(match[1]);
  const cents = match[2] ? Number(match[2].padEnd(2, '0')) : 0;
  if (!Number.isInteger(dollars) || dollars < 0) {
    return null;
  }
  return dollars * 100 + cents;
}

export function formatCents(cents: number): string {
  const abs = Math.abs(cents);
  const dollars = Math.floor(abs / 100);
  const remainder = String(abs % 100).padStart(2, '0');
  const formatted = `$${dollars}.${remainder}`;
  return cents < 0 ? `-${formatted}` : formatted;
}
