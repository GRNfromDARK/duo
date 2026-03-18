/**
 * Tests for Observation Integration (Card B.2)
 * Source: FR-005, FR-006
 * Acceptance Criteria: AC-1 through AC-7
 *
 * Tests the GLUE layer that connects the observation classifier
 * to coder/reviewer/interrupt/error output sources.
 */

import { describe, it, expect } from 'vitest';
import {
  processWorkerOutput,
  createInterruptObservation,
  createTextInterruptObservation,
  createProcessErrorObservation,
  createTimeoutObservation,
} from '../../god/observation-integration.js';
import { ObservationSchema } from '../../types/observation.js';

const meta = { phaseId: 'phase-1', adapter: 'claude-code' };

// ── Task 1: Coder Output Integration ──

describe('processWorkerOutput — coder', () => {
  // AC-1: coder output goes through classifier before entering state machine
  it('AC-1: classifies normal coder output as work', () => {
    const result = processWorkerOutput(
      'I have implemented the feature. Here are the changes...',
      'coder',
      meta,
    );
    expect(result.isWork).toBe(true);
    expect(result.shouldRouteToGod).toBe(false);
    expect(result.observation.type).toBe('work_output');
    expect(result.observation.source).toBe('coder');
  });

  // AC-5: non-work outputs (quota_exhausted) do NOT return isWork: true
  it('AC-5: quota_exhausted coder output is NOT work', () => {
    const result = processWorkerOutput(
      "You're out of extra usage · resets 7pm",
      'coder',
      meta,
    );
    expect(result.isWork).toBe(false);
    expect(result.shouldRouteToGod).toBe(true);
    expect(result.observation.type).toBe('quota_exhausted');
  });

  it('AC-5: auth_failed coder output is NOT work', () => {
    const result = processWorkerOutput(
      'Error: authentication failed',
      'coder',
      meta,
    );
    expect(result.isWork).toBe(false);
    expect(result.shouldRouteToGod).toBe(true);
    expect(result.observation.type).toBe('auth_failed');
  });

  it('AC-5: empty coder output is NOT work', () => {
    const result = processWorkerOutput('', 'coder', meta);
    expect(result.isWork).toBe(false);
    expect(result.shouldRouteToGod).toBe(true);
    expect(result.observation.type).toBe('empty_output');
  });

  it('AC-5: meta coder output is NOT work', () => {
    const result = processWorkerOutput(
      'I cannot help with that request',
      'coder',
      meta,
    );
    expect(result.isWork).toBe(false);
    expect(result.shouldRouteToGod).toBe(true);
    expect(result.observation.type).toBe('meta_output');
  });

  it('observation carries adapter from meta', () => {
    const result = processWorkerOutput('output', 'coder', {
      adapter: 'codex',
      phaseId: 'phase-2',
    });
    expect(result.observation.adapter).toBe('codex');
    expect(result.observation.phaseId).toBe('phase-2');
  });

  it('observation passes Zod validation', () => {
    const result = processWorkerOutput('output', 'coder', meta);
    expect(() => ObservationSchema.parse(result.observation)).not.toThrow();
  });
});

// ── Task 2: Reviewer Output Integration ──

describe('processWorkerOutput — reviewer', () => {
  // AC-2: reviewer output goes through classifier before entering state machine
  it('AC-2: classifies normal reviewer output as work', () => {
    const result = processWorkerOutput(
      '[APPROVED] The implementation looks good.',
      'reviewer',
      meta,
    );
    expect(result.isWork).toBe(true);
    expect(result.shouldRouteToGod).toBe(false);
    expect(result.observation.type).toBe('review_output');
    expect(result.observation.source).toBe('reviewer');
  });

  it('AC-5: quota_exhausted reviewer output is NOT work', () => {
    const result = processWorkerOutput(
      'Error 429: rate limit exceeded',
      'reviewer',
      meta,
    );
    expect(result.isWork).toBe(false);
    expect(result.shouldRouteToGod).toBe(true);
    expect(result.observation.type).toBe('quota_exhausted');
  });

  it('AC-5: empty reviewer output is NOT work', () => {
    const result = processWorkerOutput('', 'reviewer', meta);
    expect(result.isWork).toBe(false);
    expect(result.shouldRouteToGod).toBe(true);
    expect(result.observation.type).toBe('empty_output');
  });

  it('observation passes Zod validation', () => {
    const result = processWorkerOutput('[APPROVED] ok', 'reviewer', meta);
    expect(() => ObservationSchema.parse(result.observation)).not.toThrow();
  });
});

// ── Task 3: Interrupt Observation Integration ──

describe('createInterruptObservation', () => {
  // AC-3: Ctrl+C produces human_interrupt observation
  it('AC-3: creates human_interrupt observation for Ctrl+C', () => {
    const obs = createInterruptObservation();
    expect(obs.type).toBe('human_interrupt');
    expect(obs.source).toBe('human');
    expect(obs.severity).toBe('warning');
    expect(obs.summary).toContain('Ctrl+C');
  });

  it('carries optional phaseId', () => {
    const obs = createInterruptObservation({ phaseId: 'phase-3' });
    expect(obs.phaseId).toBe('phase-3');
  });

  it('passes Zod validation', () => {
    const obs = createInterruptObservation();
    expect(() => ObservationSchema.parse(obs)).not.toThrow();
  });
});

describe('createTextInterruptObservation', () => {
  it('creates human_message observation for text interrupt', () => {
    const obs = createTextInterruptObservation('fix the bug instead');
    expect(obs.type).toBe('human_message');
    expect(obs.source).toBe('human');
    expect(obs.severity).toBe('info');
    expect(obs.summary).toBe('fix the bug instead');
  });

  it('carries rawRef with the user text', () => {
    const obs = createTextInterruptObservation('use a different approach');
    expect(obs.rawRef).toBe('use a different approach');
  });

  it('passes Zod validation', () => {
    const obs = createTextInterruptObservation('hello');
    expect(() => ObservationSchema.parse(obs)).not.toThrow();
  });
});

// ── Task 4: Error / Timeout Observation Integration ──

describe('createProcessErrorObservation', () => {
  it('creates tool_failure observation for process errors', () => {
    const obs = createProcessErrorObservation('Process exited with code 1');
    expect(obs.type).toBe('tool_failure');
    expect(obs.source).toBe('runtime');
    expect(obs.severity).toBe('error');
    expect(obs.summary).toBe('Process exited with code 1');
  });

  it('carries adapter and phaseId', () => {
    const obs = createProcessErrorObservation('crash', {
      adapter: 'codex',
      phaseId: 'phase-1',
    });
    expect(obs.adapter).toBe('codex');
    expect(obs.phaseId).toBe('phase-1');
  });

  it('carries rawRef with the error message', () => {
    const obs = createProcessErrorObservation('segfault');
    expect(obs.rawRef).toBe('segfault');
  });

  it('passes Zod validation', () => {
    const obs = createProcessErrorObservation('error');
    expect(() => ObservationSchema.parse(obs)).not.toThrow();
  });
});

describe('createTimeoutObservation', () => {
  // AC-4: process timeout produces tool_failure observation
  it('AC-4: creates tool_failure observation for timeout', () => {
    const obs = createTimeoutObservation();
    expect(obs.type).toBe('tool_failure');
    expect(obs.source).toBe('runtime');
    expect(obs.severity).toBe('error');
    expect(obs.summary).toBe('Process timeout');
  });

  it('carries adapter and phaseId', () => {
    const obs = createTimeoutObservation({
      adapter: 'claude-code',
      phaseId: 'phase-2',
    });
    expect(obs.adapter).toBe('claude-code');
    expect(obs.phaseId).toBe('phase-2');
  });

  it('passes Zod validation', () => {
    const obs = createTimeoutObservation();
    expect(() => ObservationSchema.parse(obs)).not.toThrow();
  });
});
