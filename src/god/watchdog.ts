/**
 * WatchdogService — simple retry + backoff + pause for God failures.
 *
 * Core principle: LLM down = system pause, not degraded mode.
 * Retry up to 3 times with exponential backoff, then pause.
 */

export class WatchdogService {
  private consecutiveFailures = 0;
  private paused = false;

  static readonly MAX_RETRIES = 3;

  handleSuccess(): void {
    this.consecutiveFailures = 0;
    this.paused = false;
  }

  /**
   * Record a failure and return whether to retry.
   * Call this after each God call failure.
   */
  shouldRetry(): boolean {
    this.consecutiveFailures++;
    if (this.consecutiveFailures > WatchdogService.MAX_RETRIES) {
      this.paused = true;
      return false;
    }
    return true;
  }

  /** Exponential backoff: 2s, 4s, 8s (capped at 10s). */
  getBackoffMs(): number {
    return Math.min(2000 * Math.pow(2, this.consecutiveFailures - 1), 10_000);
  }

  isPaused(): boolean {
    return this.paused;
  }

  isGodAvailable(): boolean {
    return !this.paused;
  }

  /** User chose to retry after pause. */
  reset(): void {
    this.consecutiveFailures = 0;
    this.paused = false;
  }

  getConsecutiveFailures(): number {
    return this.consecutiveFailures;
  }
}
