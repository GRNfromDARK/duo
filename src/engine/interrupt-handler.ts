/**
 * InterruptHandler — manages Ctrl+C, text interrupt, and double-Ctrl+C exit.
 * Source: FR-007, FR-011 (Card E.1: Interrupt → Observation normalization)
 *
 * Responsibilities:
 * - Single Ctrl+C: kill LLM process → emit human_interrupt observation via pipeline
 * - Text interrupt: user types during LLM run → kill + emit human_message observation
 * - User input after interrupt: emit clarification_answer observation via pipeline
 * - Double Ctrl+C (<500ms): save session → exit app (only path that bypasses God)
 *
 * Card E.1 change: InterruptHandler no longer sends events directly to the state machine.
 * All interrupt/input observations are routed through the observation pipeline (onObservation).
 * The pipeline is responsible for sending INCIDENT_DETECTED/OBSERVATIONS_READY to the actor.
 */

import {
  createInterruptObservation,
  createTextInterruptObservation,
} from '../god/observation-integration.js';
import { createObservation } from '../god/observation-classifier.js';
import type { Observation } from '../types/observation.js';

const DOUBLE_CTRLC_THRESHOLD_MS = 500;

/** States that have an active LLM process running */
const ACTIVE_STATES = new Set(['CODING', 'REVIEWING']);

export interface InterruptedInfo {
  bufferedOutput: string;
  interrupted: true;
  userInstruction?: string;
}

export interface InterruptHandlerDeps {
  processManager: {
    kill(): Promise<void>;
    isRunning(): boolean;
    getBufferedOutput(): string;
  };
  sessionManager: {
    saveState(sessionId: string, state: Record<string, unknown>): void;
  };
  /** Card E.1: read-only state accessor — InterruptHandler must not send events to actor */
  actor: {
    send(event: Record<string, unknown>): void;
    getSnapshot(): {
      value: string;
      context: {
        sessionId: string | null;
        round: number;
        activeProcess: string | null;
      };
    };
  };
  onExit: () => void;
  onInterrupted: (info: InterruptedInfo) => void;
  /** Card E.1: required — observation pipeline callback for routing to God */
  onObservation: (obs: Observation) => void;
}

export class InterruptHandler {
  private deps: InterruptHandlerDeps;
  private lastSigintTime = 0;
  private hasPendingSigint = false;
  private disposed = false;

  constructor(deps: InterruptHandlerDeps) {
    this.deps = deps;
  }

  /**
   * Handle a SIGINT (Ctrl+C) signal.
   * - First press: kill LLM process, emit human_interrupt observation
   * - Second press within 500ms: save session and exit
   */
  async handleSigint(): Promise<void> {
    if (this.disposed) return;
    const now = Date.now();
    const timeSinceLast = now - this.lastSigintTime;
    this.lastSigintTime = now;

    // Double Ctrl+C detection: second press within threshold
    if (this.hasPendingSigint && timeSinceLast <= DOUBLE_CTRLC_THRESHOLD_MS) {
      this.hasPendingSigint = false;
      this.saveAndExit();
      return;
    }

    this.hasPendingSigint = true;
    await this.interruptCurrentProcess();
  }

  /**
   * Handle text interrupt — user typed during LLM execution and pressed enter.
   * Kills process and emits human_message observation via pipeline.
   */
  async handleTextInterrupt(text: string, resumeAs: 'coder' | 'reviewer'): Promise<void> {
    if (this.disposed) return;
    if (!this.deps.processManager.isRunning()) {
      return;
    }

    const snapshot = this.deps.actor.getSnapshot();
    if (!ACTIVE_STATES.has(snapshot.value)) {
      return;
    }

    const bufferedOutput = this.deps.processManager.getBufferedOutput();

    try {
      await this.deps.processManager.kill();
    } catch {
      // Process may have already exited — continue
    }

    // Card E.1: emit observation via pipeline, NOT actor.send({ type: 'USER_INTERRUPT' })
    this.deps.onObservation(
      createTextInterruptObservation(text, snapshot.context.round),
    );

    this.deps.onInterrupted({
      bufferedOutput,
      interrupted: true,
      userInstruction: text,
    });
  }

  /**
   * Card E.1: Emit clarification_answer observation for user input after interrupt.
   * The observation routes through the pipeline to God for evaluation.
   * No longer sends USER_INPUT event directly to actor.
   */
  handleUserInput(input: string, resumeAs: 'coder' | 'reviewer' | 'decision'): void {
    if (this.disposed) return;
    const snapshot = this.deps.actor.getSnapshot();
    this.deps.onObservation(
      createObservation('clarification_answer', 'human', input, {
        round: snapshot.context.round,
        severity: 'info',
        rawRef: input,
      }),
    );
  }

  /**
   * Clean up resources.
   */
  dispose(): void {
    this.disposed = true;
  }

  // ── Private ──

  private async interruptCurrentProcess(): Promise<void> {
    const snapshot = this.deps.actor.getSnapshot();

    // Only interrupt if in an active LLM state
    if (!ACTIVE_STATES.has(snapshot.value)) {
      return;
    }

    const bufferedOutput = this.deps.processManager.getBufferedOutput();

    if (this.deps.processManager.isRunning()) {
      try {
        await this.deps.processManager.kill();
      } catch {
        // Process may have already exited — continue
      }
    }

    // Card E.1: emit observation via pipeline, NOT actor.send({ type: 'USER_INTERRUPT' })
    this.deps.onObservation(
      createInterruptObservation(snapshot.context.round),
    );

    this.deps.onInterrupted({
      bufferedOutput,
      interrupted: true,
    });
  }

  private saveAndExit(): void {
    const snapshot = this.deps.actor.getSnapshot();
    const sessionId = snapshot.context.sessionId;

    if (sessionId) {
      try {
        this.deps.sessionManager.saveState(sessionId, {
          round: snapshot.context.round,
          status: 'interrupted',
          currentRole: snapshot.context.activeProcess ?? 'coder',
        });
      } catch {
        // Best effort — still exit even if save fails
      }
    }

    this.deps.onExit();
  }
}
