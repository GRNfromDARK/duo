/**
 * withRetry — simple retry wrapper for God calls.
 *
 * Core principle: retry up to 3x with backoff, then pause.
 * No fallback. No degraded mode.
 */

import { WatchdogService } from '../god/watchdog.js';

export interface RetryResult<T> {
  result: T;
  retryCount: number;
}

export interface PausedResult {
  paused: true;
  retryCount: number;
}

function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}

/**
 * Wrap an async operation with retry + exponential backoff.
 * Returns { result } on success or { paused: true } when retries exhausted.
 */
export async function withRetry<T>(
  fn: () => Promise<T>,
  watchdog: WatchdogService,
): Promise<RetryResult<T> | PausedResult> {
  let retryCount = 0;
  while (true) {
    try {
      const result = await fn();
      watchdog.handleSuccess();
      return { result, retryCount };
    } catch {
      if (!watchdog.shouldRetry()) {
        return { paused: true, retryCount: ++retryCount };
      }
      retryCount++;
      await sleep(watchdog.getBackoffMs());
    }
  }
}

/** Type guard: check if result is paused. */
export function isPaused<T>(r: RetryResult<T> | PausedResult): r is PausedResult {
  return 'paused' in r && r.paused === true;
}
