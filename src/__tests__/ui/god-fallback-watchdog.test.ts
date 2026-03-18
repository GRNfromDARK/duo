/**
 * Tests for withRetry integration with WatchdogService.
 * Validates retry + backoff + pause behavior end-to-end.
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

async function runWithRetry<T>(
  fn: () => Promise<T>,
  watchdog: WatchdogService,
) {
  const promise = withRetry(fn, watchdog);
  for (let i = 0; i < 10; i++) {
    await vi.advanceTimersByTimeAsync(20_000);
  }
  return promise;
}

describe('withRetry + WatchdogService integration', () => {
  test('returns result when God call succeeds on first try', async () => {
    const w = new WatchdogService();
    const r = await runWithRetry(async () => 'god-result', w);

    expect(isPaused(r)).toBe(false);
    if (!isPaused(r)) {
      expect(r.result).toBe('god-result');
      expect(r.retryCount).toBe(0);
    }
    expect(w.getConsecutiveFailures()).toBe(0);
  });

  test('retries and succeeds after transient failures', async () => {
    const w = new WatchdogService();
    let calls = 0;
    const r = await runWithRetry(async () => {
      calls++;
      if (calls === 1) throw new Error('crash');
      return 'retry-ok';
    }, w);

    expect(isPaused(r)).toBe(false);
    if (!isPaused(r)) {
      expect(r.result).toBe('retry-ok');
      expect(r.retryCount).toBe(1);
    }
    // handleSuccess resets consecutive failures
    expect(w.getConsecutiveFailures()).toBe(0);
  });

  test('pauses after exhausting all retries', async () => {
    const w = new WatchdogService();
    const r = await runWithRetry(async () => { throw new Error('always fails'); }, w);

    expect(isPaused(r)).toBe(true);
    expect(w.isPaused()).toBe(true);
    expect(w.isGodAvailable()).toBe(false);
  });

  test('paused watchdog: fn that throws returns paused immediately', async () => {
    const w = new WatchdogService();

    // Exhaust retries
    await runWithRetry(async () => { throw new Error('fail'); }, w);
    expect(w.isPaused()).toBe(true);

    // Second call with a failing fn returns paused immediately
    const r2 = await runWithRetry(async () => { throw new Error('still failing'); }, w);
    expect(isPaused(r2)).toBe(true);
  });

  test('paused watchdog: fn that succeeds returns success and resets', async () => {
    const w = new WatchdogService();

    // Exhaust retries
    await runWithRetry(async () => { throw new Error('fail'); }, w);
    expect(w.isPaused()).toBe(true);

    // If fn succeeds despite watchdog being paused, return success
    // (the system recovered on its own)
    const r2 = await runWithRetry(async () => 'recovered', w);
    expect(isPaused(r2)).toBe(false);
    if (!isPaused(r2)) {
      expect(r2.result).toBe('recovered');
    }
    expect(w.isPaused()).toBe(false);
  });

  test('reset allows retry after pause', async () => {
    const w = new WatchdogService();

    // Exhaust retries
    await runWithRetry(async () => { throw new Error('fail'); }, w);
    expect(w.isPaused()).toBe(true);

    // Reset
    w.reset();
    expect(w.isPaused()).toBe(false);

    // Now can succeed
    const r = await runWithRetry(async () => 'recovered', w);
    expect(isPaused(r)).toBe(false);
    if (!isPaused(r)) {
      expect(r.result).toBe('recovered');
    }
  });
});
