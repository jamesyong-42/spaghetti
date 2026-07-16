/**
 * Numeric option guards for commander flags.
 *
 * commander's `parseInt` coercer yields `NaN` on non-numeric input
 * (e.g. `--limit abc`). Plain `?? default` does not catch `NaN` — it is
 * neither `null` nor `undefined` — so an unguarded limit flows straight into
 * `Array.slice(0, NaN)` and produces an empty page. These helpers fall back
 * to the default whenever the value isn't a usable finite number.
 */

/** Resolve a `--limit`-style flag: positive finite number, else `fallback`. */
export function resolveLimit(value: number | undefined, fallback: number): number {
  return typeof value === 'number' && Number.isFinite(value) && value > 0 ? value : fallback;
}

/** Resolve an `--offset`-style flag: non-negative finite number, else `fallback` (default 0). */
export function resolveOffset(value: number | undefined, fallback = 0): number {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : fallback;
}

/**
 * Resolve an optional positive-count flag such as `--last`: a finite number
 * greater than zero, or `undefined` when absent/garbage so callers can treat
 * it as "not provided" (`NaN` from a bad `--last foo` must not slip through as
 * a truthy value).
 */
export function resolveOptionalCount(value: number | undefined): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) && value > 0 ? value : undefined;
}
