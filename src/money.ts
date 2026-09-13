/**
 * Money helpers. c402 uses integer minor units (centavos) for COP.
 * COP has 2 decimal places, so 1 peso = 100 centavos.
 */

export const MINOR_UNITS_PER_MAJOR = 100

/** COP pesos -> minor units (centavos). Accepts decimals, returns integer. */
export function copToCents(pesos: number): number {
  if (!Number.isFinite(pesos)) throw new TypeError('copToCents: amount must be a finite number')
  return Math.round(pesos * MINOR_UNITS_PER_MAJOR)
}

/** Minor units (centavos) -> COP pesos (may be fractional). */
export function centsToCop(cents: number): number {
  if (!Number.isFinite(cents)) throw new TypeError('centsToCop: amount must be a finite number')
  return cents / MINOR_UNITS_PER_MAJOR
}

/** True when the value is a valid positive integer minor-unit amount. */
export function isValidAmountCents(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value > 0
}

/** Format minor units for display, e.g. 250000 -> "COP 2,500.00". */
export function formatCents(cents: number, currency = 'COP'): string {
  const major = centsToCop(cents)
  return `${currency} ${major.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`
}
