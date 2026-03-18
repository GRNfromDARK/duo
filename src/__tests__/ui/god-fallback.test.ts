/**
 * Tests for withRetry — simple retry wrapper.
 */
import { describe, test, expect, vi, beforeEach, afterEach } from 'vitest';
import { withRetry, isPaused } from '../../ui/god-fallback.js';
import { WatchdogService } from '../../god/watchdog.js';

beforeEach(() => {
  vi.useFakeTimers();
});

afterEach(() => {
  vi.useRealTimers();
});

/**
 * Helper: run withRetry to completion while advancing fake timers
 * so backoff sleeps resolve instantly.
 */
async function runWithRetry<T>(
  fn: () => Promise<T>,
  watchdog: WatchdogService,
) {
  const promise = withRetry(fn, watchdog);
  // Advance timers repeatedly to flush all pending sleep calls
  for (let i = 0; i < 10; i++) {
    await vi.advanceTimersByTimeAsync(20_000);
  }
  return promise;
}

describe('withRetry', () => {
  test('returns result on first success', async () => {
    const w = new WatchdogService();
    const r = await runWithRetry(async () => 'ok', w);
    expect(isPaused(r)).toBe(false);
    if (!isPaused(r)) {
      expect(r.result).toBe('ok');
      expect(r.retryCount).toBe(0);
    }
  });

  test('retries on failure and returns result on success', async () => {
    const w = new WatchdogService();
    let calls = 0;
    const r = await runWithRetry(async () => {
      calls++;
      if (calls < 3) throw new Error('fail');
      return 'ok';
    }, w);
    expect(isPaused(r)).toBe(false);
    if (!isPaused(r)) {
      expect(r.result).toBe('ok');
      expect(r.retryCount).toBe(2);
    }
  });

  test('returns paused after exhausting retries', async () => {
    const w = new WatchdogService();
    const r = await runWithRetry(async () => { throw new Error('always fail'); }, w);
    expect(isPaused(r)).toBe(true);
    if (isPaused(r)) {
      expect(r.retryCount).toBe(4);
    }
  });

  test('resets failure count on success', async () => {
    const w = new WatchdogService();
    let calls = 0;
    await runWithRetry(async () => {
      calls++;
      if (calls <= 2) throw new Error('fail');
      return 'ok';
    }, w);
    expect(w.getConsecutiveFailures()).toBe(0);
  });
});

describe('isPaused', () => {
  test('returns true for paused result', () => {
    expect(isPaused({ paused: true, retryCount: 4 })).toBe(true);
  });

  test('returns false for success result', () => {
    expect(isPaused({ result: 'ok', retryCount: 0 })).toBe(false);
  });
});
