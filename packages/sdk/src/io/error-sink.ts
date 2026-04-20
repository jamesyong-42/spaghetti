/**
 * error-sink.ts — Single error sink interface for live components.
 *
 * Four components used to invent their own error surface:
 *
 *   - `live-updates.ts` — `onError: (err: Error) => void` via options
 *   - `subscriber-registry.ts` — `onListenerError: (err, change) => void`
 *   - `idle-maintenance.ts` — `onError?: (err) => void` defaulting to console.warn
 *   - `live/spaghetti-live.ts` events iterator — swallowed `onDrop` errors silently
 *
 * Centralising on one `ErrorSink` lets `create.ts` install a single
 * default (a console.warn variant prefixed with `[spaghetti-sdk]`)
 * and lets advanced consumers swap in app-specific telemetry without
 * threading a separate callback through every constructor.
 *
 * `subscriber-registry`'s listener-error surface still wraps this —
 * the registry needs the offending `Change` for context, but it
 * forwards to the sink underneath so the user-facing
 * "everything is logged the same way" guarantee holds.
 */

// ═══════════════════════════════════════════════════════════════════════════
// PUBLIC TYPES
// ═══════════════════════════════════════════════════════════════════════════

export interface ErrorContext {
  /**
   * Short identifier for the component that surfaced the error, e.g.
   * `'LiveUpdates'`, `'IdleMaintenance'`, `'SubscriberRegistry'`,
   * `'SpaghettiLive.events'`. Lets a single sink format messages
   * with the originating subsystem visible.
   */
  component: string;
  /**
   * Free-form context fields. For the subscriber registry this carries
   * the offending `Change`; for live-updates it might carry a path or
   * a category. Callers stamp whatever they have.
   */
  [key: string]: unknown;
}

export interface ErrorSink {
  /**
   * Surface an error. Must never throw — callers route errors here
   * from inside watchdog loops, debounce timers, and async drains
   * that can't recover from a sink failure.
   */
  error(err: Error, context?: ErrorContext): void;
}

// ═══════════════════════════════════════════════════════════════════════════
// FACTORIES
// ═══════════════════════════════════════════════════════════════════════════

/**
 * Default sink: writes to `console.warn` with an optional prefix and
 * the component name (when provided in context). Mirrors the format
 * the four pre-extraction sites used today so existing log scrapers
 * keep matching.
 */
export function createConsoleErrorSink(prefix = '[spaghetti-sdk]'): ErrorSink {
  return {
    error(err: Error, context?: ErrorContext): void {
      const component = context?.component;
      const head = component ? `${prefix} ${component}` : prefix;
      try {
        // eslint-disable-next-line no-console
        console.warn(`${head} error: ${err.message}`);
      } catch {
        /* console.warn itself shouldn't throw, but be defensive. */
      }
    },
  };
}

/**
 * No-op sink for tests + library consumers that route errors through
 * a different channel and want the SDK to stay silent.
 */
export function createNoopErrorSink(): ErrorSink {
  return {
    error(): void {
      /* no-op */
    },
  };
}

/**
 * Adapter: wrap a legacy `(err: Error) => void` callback so it
 * satisfies `ErrorSink`. Used internally in `LiveUpdates` so callers
 * that still pass `options.onError` keep working.
 */
export function errorSinkFromCallback(cb: (err: Error) => void): ErrorSink {
  return {
    error(err: Error): void {
      try {
        cb(err);
      } catch {
        /* sink callbacks must never throw; swallow. */
      }
    },
  };
}
