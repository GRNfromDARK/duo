interface KillableAdapter {
  kill(): Promise<void>;
}

interface InterruptibleOutputManager {
  interrupt(): void;
}

export interface SafeShutdownOptions {
  adapters: KillableAdapter[];
  outputManager?: InterruptibleOutputManager;
  beforeExit?: () => void;
  onExit: () => void;
}

export async function performSafeShutdown({
  adapters,
  outputManager,
  beforeExit,
  onExit,
}: SafeShutdownOptions): Promise<void> {
  outputManager?.interrupt();

  await Promise.allSettled(
    adapters.map((adapter) => adapter.kill()),
  );

  try {
    beforeExit?.();
  } catch {
    // Best effort: exiting should not depend on persistence succeeding.
  }

  onExit();
}
