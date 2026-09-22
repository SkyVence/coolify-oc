/**
 * Plugin options that both halves care about.
 *
 * Kept free of any OpenCode or TUI import so the defaults and the validation
 * can be unit tested directly, and so the TUI and the server cannot drift on
 * what "the default cadence" means.
 */

/** Idle refresh cadence, in seconds, when nothing is in flight. */
export const DEFAULT_REFRESH_SECONDS = 25

/** The accepted range for the `refreshSeconds` plugin option. */
export const MIN_REFRESH_SECONDS = 5
export const MAX_REFRESH_SECONDS = 600

/**
 * Read the `refreshSeconds` plugin option.
 *
 * Accepts an integer between five seconds and ten minutes. Anything else —
 * a float, a string, a value out of range, `undefined` — is ignored, and the
 * caller is told to fall back to the default rather than guessing a number.
 */
export function parseRefreshSeconds(value: unknown): number {
  if (typeof value !== "number" || !Number.isInteger(value)) return DEFAULT_REFRESH_SECONDS
  if (value < MIN_REFRESH_SECONDS || value > MAX_REFRESH_SECONDS) return DEFAULT_REFRESH_SECONDS
  return value
}
