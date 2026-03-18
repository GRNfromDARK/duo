/**
 * Test helper: creates a WatchdogService instance for tests.
 */

import { WatchdogService } from '../../god/watchdog.js';

export function createMockWatchdog(): WatchdogService {
  return new WatchdogService();
}
