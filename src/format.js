/**
 * Presentation formatting for the report. These functions only change how numbers are
 * displayed; the values themselves come from the SQL analytics layer unchanged.
 */

// Fixed locale: report output must not depend on the server's regional settings.
const MONEY_FORMAT = new Intl.NumberFormat('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
const PERCENT_FORMAT = new Intl.NumberFormat('en-US', { minimumFractionDigits: 0, maximumFractionDigits: 1 });

/**
 * "USD 2,266.30" - always thousands separators and exactly two decimals, prefixed with
 * the configured currency code. Negative amounts render as "-USD 5.00". Anything that is
 * not a finite number renders as "N/A" instead of "USD NaN".
 */
export function formatMoney(value, currency) {
  if (value === null || value === undefined || value === '') return 'N/A';
  const amount = Number(value);
  if (!Number.isFinite(amount)) return 'N/A';
  const digits = MONEY_FORMAT.format(Math.abs(amount));
  const negative = amount < 0 && digits !== '0.00'; // never show "-USD 0.00"
  return `${negative ? '-' : ''}${currency} ${digits}`;
}

/**
 * Period-over-period change as { label, direction }.
 *   +12.5% / -23.1% / 0%  (one decimal at most, thousands separators for large values)
 * `null` means the baseline was zero, so no percentage exists.
 */
export function formatPercentChange(value, unavailableLabel = 'N/A') {
  if (value === null || value === undefined || !Number.isFinite(Number(value))) {
    return { label: unavailableLabel, direction: 'unavailable' };
  }
  const rounded = Math.round(Number(value) * 10) / 10;
  if (rounded === 0) return { label: '0%', direction: 'neutral' };
  const text = PERCENT_FORMAT.format(Math.abs(rounded));
  return rounded > 0 ? { label: `+${text}%`, direction: 'positive' } : { label: `-${text}%`, direction: 'negative' };
}
