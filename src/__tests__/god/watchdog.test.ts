/**
 * Tests for WatchdogService — simple retry + backoff + pause.
 */
import { describe, it, expect } from 'vitest';
import { WatchdogService } from '../../god/watchdog.js';

describe('WatchdogService', () => {
  describe('shouldRetry', () => {
    it('returns true for first 3 failures', () => {
      const w = new WatchdogService();
      expect(w.shouldRetry()).toBe(true);  // failure 1
      expect(w.shouldRetry()).toBe(true);  // failure 2
      expect(w.shouldRetry()).toBe(true);  // failure 3
    });

    it('returns false on 4th failure and pauses', () => {
      const w = new WatchdogService();
      w.shouldRetry(); // 1
      w.shouldRetry(); // 2
      w.shouldRetry(); // 3
      expect(w.shouldRetry()).toBe(false); // 4 → pause
      expect(w.isPaused()).toBe(true);
    });
  });

  describe('getBackoffMs', () => {
    it('returns exponential backoff: 2s, 4s, 8s', () => {
      const w = new WatchdogService();
      w.shouldRetry(); // failure 1
      expect(w.getBackoffMs()).toBe(2000);
      w.shouldRetry(); // failure 2
      expect(w.getBackoffMs()).toBe(4000);
      w.shouldRetry(); // failure 3
      expect(w.getBackoffMs()).toBe(8000);
    });

    it('caps at 10s', () => {
      const w = new WatchdogService();
      w.shouldRetry(); // 1
      w.shouldRetry(); // 2
      w.shouldRetry(); // 3
      w.shouldRetry(); // 4
      expect(w.getBackoffMs()).toBe(10000);
    });
  });

  describe('handleSuccess', () => {
    it('resets consecutive failures', () => {
      const w = new WatchdogService();
      w.shouldRetry();
      w.shouldRetry();
      w.handleSuccess();
      expect(w.getConsecutiveFailures()).toBe(0);
      expect(w.isPaused()).toBe(false);
    });
  });

  describe('reset', () => {
    it('unpauses after exhaustion', () => {
      const w = new WatchdogService();
      w.shouldRetry(); w.shouldRetry(); w.shouldRetry(); w.shouldRetry();
      expect(w.isPaused()).toBe(true);
      w.reset();
      expect(w.isPaused()).toBe(false);
      expect(w.isGodAvailable()).toBe(true);
    });
  });

  describe('isGodAvailable', () => {
    it('returns true initially', () => {
      expect(new WatchdogService().isGodAvailable()).toBe(true);
    });

    it('returns false when paused', () => {
      const w = new WatchdogService();
      w.shouldRetry(); w.shouldRetry(); w.shouldRetry(); w.shouldRetry();
      expect(w.isGodAvailable()).toBe(false);
    });
  });
});
