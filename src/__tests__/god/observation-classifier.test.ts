/**
 * Tests for Output Classifier + Non-Work Guard (Card B.1)
 * Source: FR-005, FR-006
 * Acceptance Criteria: AC-1 through AC-9
 */

import { describe, it, expect } from 'vitest';
import {
  classifyOutput,
  createObservation,
  deduplicateObservations,
  guardNonWorkOutput,
} from '../../god/observation-classifier.js';
import { ObservationSchema } from '../../types/observation.js';
import type { Observation, ObservationType } from '../../types/observation.js';

// ── Helper ──

const meta = { phaseId: 'phase-1', adapter: 'claude-code' };

// ── classifyOutput ──

describe('classifyOutput', () => {
  // --- quota_exhausted patterns ---

  // AC-1: "You're out of extra usage · resets 7pm" classified as quota_exhausted
  it('AC-1: classifies "You\'re out of extra usage · resets 7pm" as quota_exhausted', () => {
    const obs = classifyOutput(
      "You're out of extra usage · resets 7pm",
      'coder',
      meta,
    );
    expect(obs.type).toBe('quota_exhausted');
    expect(obs.source).toBe('coder');
  });

  it('classifies "rate limit exceeded" as quota_exhausted', () => {
    const obs = classifyOutput('Error: rate limit exceeded, please wait', 'coder', meta);
    expect(obs.type).toBe('quota_exhausted');
  });

  it('classifies "quota exceeded" as quota_exhausted', () => {
    const obs = classifyOutput('API quota exceeded for this billing period', 'coder', meta);
    expect(obs.type).toBe('quota_exhausted');
  });

  it('classifies "429" status as quota_exhausted', () => {
    const obs = classifyOutput('HTTP 429 Too Many Requests', 'coder', meta);
    expect(obs.type).toBe('quota_exhausted');
  });

  it('classifies "Usage limit" as quota_exhausted', () => {
    const obs = classifyOutput('Usage limit reached for your plan', 'reviewer', meta);
    expect(obs.type).toBe('quota_exhausted');
  });

  it('classifies "You\'re out of extra usage" (exact) as quota_exhausted', () => {
    const obs = classifyOutput("You're out of extra usage", 'coder', meta);
    expect(obs.type).toBe('quota_exhausted');
  });

  // --- auth_failed patterns ---

  it('classifies "authentication failed" as auth_failed', () => {
    const obs = classifyOutput('authentication failed: invalid credentials', 'coder', meta);
    expect(obs.type).toBe('auth_failed');
  });

  it('classifies "unauthorized" as auth_failed', () => {
    const obs = classifyOutput('Error: unauthorized access denied', 'coder', meta);
    expect(obs.type).toBe('auth_failed');
  });

  it('classifies "403" as auth_failed', () => {
    const obs = classifyOutput('HTTP 403 Forbidden', 'coder', meta);
    expect(obs.type).toBe('auth_failed');
  });

  it('classifies "invalid API key" as auth_failed', () => {
    const obs = classifyOutput('Error: invalid API key provided', 'coder', meta);
    expect(obs.type).toBe('auth_failed');
  });

  // --- empty_output ---

  // AC-2: empty string classified as empty_output, NOT work_output
  it('AC-2: classifies empty string as empty_output', () => {
    const obs = classifyOutput('', 'coder', meta);
    expect(obs.type).toBe('empty_output');
    expect(obs.type).not.toBe('work_output');
  });

  it('classifies whitespace-only string as empty_output', () => {
    const obs = classifyOutput('   \n\t  ', 'coder', meta);
    expect(obs.type).toBe('empty_output');
  });

  // --- meta_output ---

  it('classifies "I cannot" as meta_output', () => {
    const obs = classifyOutput('I cannot help with that request', 'coder', meta);
    expect(obs.type).toBe('meta_output');
  });

  it('classifies "As an AI" as meta_output', () => {
    const obs = classifyOutput('As an AI language model, I should clarify', 'coder', meta);
    expect(obs.type).toBe('meta_output');
  });

  // --- meta_output verdict marker protection (Change 6) ---

  describe('meta_output verdict marker protection (Change 6)', () => {
    it('reviewer output with "I cannot" + [CHANGES_REQUESTED] is classified as review_output, not meta_output', () => {
      const output = `I cannot find evidence that this edge case is handled.
The function at line 42 does not validate input.
[CHANGES_REQUESTED]`;
      const obs = classifyOutput(output, 'reviewer', meta);
      expect(obs.type).toBe('review_output');
      expect(obs.type).not.toBe('meta_output');
    });

    it('reviewer output with "I cannot" + [APPROVED] is classified as review_output', () => {
      const output = `I cannot identify any issues with this implementation.
[APPROVED]`;
      const obs = classifyOutput(output, 'reviewer', meta);
      expect(obs.type).toBe('review_output');
    });

    it('reviewer output with "I cannot" but NO verdict marker is still meta_output', () => {
      const obs = classifyOutput('I cannot help with that request', 'reviewer', meta);
      expect(obs.type).toBe('meta_output');
    });

    it('coder output with "I cannot" is still meta_output even with verdict marker', () => {
      const obs = classifyOutput('I cannot do this task [CHANGES_REQUESTED]', 'coder', meta);
      expect(obs.type).toBe('meta_output');
    });
  });

  // --- adapter_unavailable ---

  it('classifies "command not found" as adapter_unavailable', () => {
    const obs = classifyOutput('bash: claude-code: command not found', 'runtime', meta);
    expect(obs.type).toBe('adapter_unavailable');
  });

  it('classifies "ENOENT" as adapter_unavailable', () => {
    const obs = classifyOutput('Error: spawn claude-code ENOENT', 'runtime', meta);
    expect(obs.type).toBe('adapter_unavailable');
  });

  // --- tool_failure (from runtime source) ---

  it('classifies runtime error as tool_failure when source is runtime', () => {
    const obs = classifyOutput('Error: process exited with code 1', 'runtime', meta);
    expect(obs.type).toBe('tool_failure');
  });

  it('classifies traceback from runtime as tool_failure', () => {
    const obs = classifyOutput('Traceback (most recent call last):\n  File "x.py"', 'runtime', meta);
    expect(obs.type).toBe('tool_failure');
  });

  it('classifies exception from runtime as tool_failure', () => {
    const obs = classifyOutput('Unhandled exception: TypeError at line 42', 'runtime', meta);
    expect(obs.type).toBe('tool_failure');
  });

  // --- default classification ---

  it('classifies normal coder output as work_output', () => {
    const obs = classifyOutput('I have implemented the feature as requested. Here are the changes...', 'coder', meta);
    expect(obs.type).toBe('work_output');
  });

  it('classifies normal reviewer output as review_output', () => {
    const obs = classifyOutput('[APPROVED] The implementation looks good, all tests pass.', 'reviewer', meta);
    expect(obs.type).toBe('review_output');
  });

  it('classifies coder output with "error" in normal context as work_output', () => {
    // Coder discussing error handling is valid work, not a tool_failure
    const obs = classifyOutput('I added error handling for the edge case', 'coder', meta);
    expect(obs.type).toBe('work_output');
  });

  // --- meta fields ---

  it('carries phaseId from meta', () => {
    const obs = classifyOutput('some output', 'coder', { phaseId: 'phase-2' });
    expect(obs.phaseId).toBe('phase-2');
  });

  it('carries adapter from meta', () => {
    const obs = classifyOutput('some output', 'coder', { adapter: 'codex' });
    expect(obs.adapter).toBe('codex');
  });

  // AC-3: rawRef is carried in the observation
  it('AC-3: observation carries rawRef pointing to full output', () => {
    const raw = 'This is a very long coder output that represents the full work product...';
    const obs = classifyOutput(raw, 'coder', meta);
    expect(obs.rawRef).toBeDefined();
    expect(typeof obs.rawRef).toBe('string');
    // rawRef should contain or reference the raw output
    expect(obs.rawRef).toBe(raw);
  });

  // AC-4: classification latency < 5ms
  it('AC-4: classification latency is under 5ms', () => {
    const start = performance.now();
    for (let i = 0; i < 100; i++) {
      classifyOutput("You're out of extra usage · resets 7pm", 'coder', meta);
      classifyOutput('', 'coder', meta);
      classifyOutput('Normal work output', 'coder', meta);
      classifyOutput('authentication failed', 'coder', meta);
    }
    const elapsed = (performance.now() - start) / 400; // average per call
    expect(elapsed).toBeLessThan(5);
  });

  // --- Zod validation ---

  it('returns valid Observation per Zod schema', () => {
    const obs = classifyOutput('some output', 'coder', meta);
    expect(() => ObservationSchema.parse(obs)).not.toThrow();
  });

  it('returns valid Observation for each classification type', () => {
    const cases: Array<[string, string, Observation['source']]> = [
      ["You're out of extra usage", 'quota_exhausted', 'coder'],
      ['authentication failed', 'auth_failed', 'coder'],
      ['', 'empty_output', 'coder'],
      ['I cannot do this', 'meta_output', 'coder'],
      ['command not found', 'adapter_unavailable', 'runtime'],
      ['Error: crash', 'tool_failure', 'runtime'],
      ['normal output', 'work_output', 'coder'],
      ['looks good', 'review_output', 'reviewer'],
    ];
    for (const [raw, expectedType, source] of cases) {
      const obs = classifyOutput(raw, source, meta);
      expect(obs.type).toBe(expectedType);
      expect(() => ObservationSchema.parse(obs)).not.toThrow();
    }
  });

  // --- Priority: quota/auth should win over tool_failure patterns ---

  it('quota_exhausted takes priority over generic error patterns', () => {
    const obs = classifyOutput('Error 429: rate limit exceeded', 'runtime', meta);
    expect(obs.type).toBe('quota_exhausted');
  });

  it('auth_failed takes priority over generic error patterns', () => {
    const obs = classifyOutput('Error: 403 unauthorized access', 'runtime', meta);
    expect(obs.type).toBe('auth_failed');
  });

  // --- auth_failed substantive content protection (Change 7) ---

  describe('auth_failed substantive content protection (Change 7)', () => {
    it('output with auth keyword + 500+ chars substantive content is classified as work_output, not auth_failed', () => {
      // Simulate MCP "unauthorized" in init + real coder work output
      const substantiveWork = 'A'.repeat(600); // > 500 chars of non-tool-marker content
      const output = `[shell] Starting MCP servers...\nunauthorized: Gmail MCP needs-auth\n${substantiveWork}`;
      const obs = classifyOutput(output, 'coder', meta);
      expect(obs.type).toBe('work_output');
      expect(obs.type).not.toBe('auth_failed');
    });

    it('output with auth keyword + short content (< 500 chars) is still auth_failed', () => {
      const obs = classifyOutput('Error: unauthorized access denied. Please check your API key.', 'coder', meta);
      expect(obs.type).toBe('auth_failed');
    });

    it('output with "403" + large substantive content is work_output', () => {
      const analysis = 'I analyzed the codebase and found the following issues. '.repeat(15); // > 500 chars
      const output = `HTTP 403 from MCP Calendar\n${analysis}`;
      const obs = classifyOutput(output, 'coder', meta);
      expect(obs.type).toBe('work_output');
    });
  });
});

// ── createObservation ──

describe('createObservation', () => {
  it('creates a valid Observation with required fields', () => {
    const obs = createObservation('work_output', 'coder', 'Coder produced output', {
    });
    expect(obs.type).toBe('work_output');
    expect(obs.source).toBe('coder');
    expect(obs.summary).toBe('Coder produced output');
    expect(obs.timestamp).toBeDefined();
    expect(() => ObservationSchema.parse(obs)).not.toThrow();
  });

  it('auto-fills timestamp as ISO string', () => {
    const before = new Date().toISOString();
    const obs = createObservation('work_output', 'coder', 'test', {});
    const after = new Date().toISOString();
    expect(obs.timestamp >= before).toBe(true);
    expect(obs.timestamp <= after).toBe(true);
  });

  it('accepts optional rawRef', () => {
    const obs = createObservation('work_output', 'coder', 'test', {
      rawRef: '/path/to/log',
    });
    expect(obs.rawRef).toBe('/path/to/log');
  });

  it('accepts optional phaseId', () => {
    const obs = createObservation('work_output', 'coder', 'test', {
      phaseId: 'phase-2',
    });
    expect(obs.phaseId).toBe('phase-2');
  });

  it('accepts optional adapter', () => {
    const obs = createObservation('work_output', 'coder', 'test', {
      adapter: 'claude-code',
    });
    expect(obs.adapter).toBe('claude-code');
  });

  it('accepts optional severity override', () => {
    const obs = createObservation('quota_exhausted', 'runtime', 'quota hit', {
      severity: 'fatal',
    });
    expect(obs.severity).toBe('fatal');
  });

  it('defaults severity to error', () => {
    const obs = createObservation('quota_exhausted', 'runtime', 'quota hit', {
    });
    expect(obs.severity).toBe('error');
  });
});

// ── guardNonWorkOutput ──

describe('guardNonWorkOutput', () => {
  const makeObs = (type: ObservationType, source: Observation['source'] = 'coder'): Observation => ({
    source,
    type,
    summary: 'test',
    severity: 'error',
    timestamp: new Date().toISOString(),
  });

  // --- Work observations ---

  it('work_output returns isWork: true, shouldRouteToGod: false', () => {
    const result = guardNonWorkOutput(makeObs('work_output'));
    expect(result.isWork).toBe(true);
    expect(result.shouldRouteToGod).toBe(false);
  });

  it('review_output returns isWork: true, shouldRouteToGod: false', () => {
    const result = guardNonWorkOutput(makeObs('review_output', 'reviewer'));
    expect(result.isWork).toBe(true);
    expect(result.shouldRouteToGod).toBe(false);
  });

  // --- Non-work observations: incident types ---

  // AC-5: quota_exhausted does NOT return isWork: true
  it('AC-5: quota_exhausted returns isWork: false', () => {
    const result = guardNonWorkOutput(makeObs('quota_exhausted', 'runtime'));
    expect(result.isWork).toBe(false);
  });

  // AC-6: auth_failed does NOT return isWork: true
  it('AC-6: auth_failed returns isWork: false', () => {
    const result = guardNonWorkOutput(makeObs('auth_failed', 'runtime'));
    expect(result.isWork).toBe(false);
  });

  // AC-7: all non-work observations route to God
  it('AC-7: quota_exhausted routes to God', () => {
    const result = guardNonWorkOutput(makeObs('quota_exhausted', 'runtime'));
    expect(result.shouldRouteToGod).toBe(true);
  });

  it('AC-7: auth_failed routes to God', () => {
    const result = guardNonWorkOutput(makeObs('auth_failed', 'runtime'));
    expect(result.shouldRouteToGod).toBe(true);
  });

  it('AC-7: adapter_unavailable routes to God', () => {
    const result = guardNonWorkOutput(makeObs('adapter_unavailable', 'runtime'));
    expect(result.shouldRouteToGod).toBe(true);
  });

  it('AC-7: empty_output routes to God', () => {
    const result = guardNonWorkOutput(makeObs('empty_output'));
    expect(result.shouldRouteToGod).toBe(true);
  });

  it('AC-7: meta_output routes to God', () => {
    const result = guardNonWorkOutput(makeObs('meta_output'));
    expect(result.shouldRouteToGod).toBe(true);
  });

  it('AC-7: tool_failure routes to God', () => {
    const result = guardNonWorkOutput(makeObs('tool_failure', 'runtime'));
    expect(result.shouldRouteToGod).toBe(true);
  });

  // --- Exhaustive non-work check ---

  it('all non-work observation types return isWork: false and shouldRouteToGod: true', () => {
    const nonWorkTypes: ObservationType[] = [
      'quota_exhausted',
      'auth_failed',
      'adapter_unavailable',
      'empty_output',
      'meta_output',
      'tool_failure',
    ];
    for (const type of nonWorkTypes) {
      const result = guardNonWorkOutput(makeObs(type, 'runtime'));
      expect(result.isWork).toBe(false);
      expect(result.shouldRouteToGod).toBe(true);
    }
  });

  // --- Human/runtime observation types also non-work ---

  it('human_interrupt is non-work', () => {
    const result = guardNonWorkOutput(makeObs('human_interrupt', 'human'));
    expect(result.isWork).toBe(false);
  });

  it('human_message is non-work', () => {
    const result = guardNonWorkOutput(makeObs('human_message', 'human'));
    expect(result.isWork).toBe(false);
  });

  it('runtime_invariant_violation is non-work', () => {
    const result = guardNonWorkOutput(makeObs('runtime_invariant_violation', 'runtime'));
    expect(result.isWork).toBe(false);
  });
});

// ── deduplicateObservations ──

describe('deduplicateObservations', () => {
  it('removes duplicate observations by timestamp+source+type', () => {
    const obs1: Observation = {
      type: 'work_output',
      source: 'coder',
      summary: 'First output',
      severity: 'info',
      timestamp: '2026-03-17T00:00:01.000Z',
    };
    const obs2: Observation = {
      type: 'review_output',
      source: 'reviewer',
      summary: 'Review result',
      severity: 'info',
      timestamp: '2026-03-17T00:00:02.000Z',
    };
    // Duplicate of obs1 (same timestamp+source+type)
    const obs1Dup: Observation = {
      type: 'work_output',
      source: 'coder',
      summary: 'First output',
      severity: 'info',
      timestamp: '2026-03-17T00:00:01.000Z',
    };

    const result = deduplicateObservations([obs1, obs2, obs1Dup]);
    expect(result).toHaveLength(2);
    expect(result[0]).toBe(obs1);
    expect(result[1]).toBe(obs2);
  });

  it('preserves order of first occurrence', () => {
    const clarification: Observation = {
      type: 'human_message',
      source: 'human',
      summary: 'User answered question',
      severity: 'info',
      timestamp: '2026-03-17T00:00:01.000Z',
    };
    const current: Observation = {
      type: 'work_output',
      source: 'coder',
      summary: 'Coder output',
      severity: 'info',
      timestamp: '2026-03-17T00:00:02.000Z',
    };

    const result = deduplicateObservations([clarification, current, clarification]);
    expect(result).toHaveLength(2);
    expect(result[0]).toBe(clarification);
    expect(result[1]).toBe(current);
  });

  it('returns empty array for empty input', () => {
    expect(deduplicateObservations([])).toEqual([]);
  });
});
