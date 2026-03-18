import { describe, it, expect } from 'vitest';
import { z } from 'zod';
import {
  ObservationTypeSchema,
  ObservationSourceSchema,
  ObservationSeveritySchema,
  ObservationSchema,
  isWorkObservation,
  OBSERVATION_TYPES,
} from '../../types/observation.js';
import type { Observation } from '../../types/observation.js';

describe('ObservationType', () => {
  const allTypes = [
    'work_output',
    'review_output',
    'quota_exhausted',
    'auth_failed',
    'adapter_unavailable',
    'empty_output',
    'meta_output',
    'tool_failure',
    'human_interrupt',
    'human_message',
    'clarification_answer',
    'phase_progress_signal',
    'runtime_invariant_violation',
  ] as const;

  it('should define exactly 13 observation types', () => {
    expect(OBSERVATION_TYPES).toHaveLength(13);
  });

  it.each(allTypes)('should accept valid type: %s', (type) => {
    expect(() => ObservationTypeSchema.parse(type)).not.toThrow();
  });

  it('should reject invalid type', () => {
    expect(() => ObservationTypeSchema.parse('invalid_type')).toThrow();
  });
});

describe('ObservationSchema', () => {
  const validObservation: Observation = {
    source: 'coder',
    type: 'work_output',
    summary: 'Coder produced implementation',
    severity: 'info',
    timestamp: '2026-03-13T10:00:00.000Z',
  };

  // AC-1: Zod schema can validate all 13 observation types
  it('AC-1: should validate all 13 observation types', () => {
    const types = [
      'work_output', 'review_output', 'quota_exhausted', 'auth_failed',
      'adapter_unavailable', 'empty_output', 'meta_output', 'tool_failure',
      'human_interrupt', 'human_message', 'clarification_answer',
      'phase_progress_signal', 'runtime_invariant_violation',
    ] as const;

    for (const type of types) {
      const obs = { ...validObservation, type };
      expect(() => ObservationSchema.parse(obs)).not.toThrow();
    }
  });

  it('should accept all valid sources', () => {
    const sources = ['coder', 'reviewer', 'god', 'human', 'runtime'] as const;
    for (const source of sources) {
      const obs = { ...validObservation, source };
      expect(() => ObservationSchema.parse(obs)).not.toThrow();
    }
  });

  it('should accept all valid severities', () => {
    const severities = ['info', 'warning', 'error', 'fatal'] as const;
    for (const severity of severities) {
      const obs = { ...validObservation, severity };
      expect(() => ObservationSchema.parse(obs)).not.toThrow();
    }
  });

  it('should accept optional fields', () => {
    const obs: Observation = {
      ...validObservation,
      rawRef: '/path/to/output.log',
      phaseId: 'phase-1',
      adapter: 'claude-code',
    };
    const parsed = ObservationSchema.parse(obs);
    expect(parsed.rawRef).toBe('/path/to/output.log');
    expect(parsed.phaseId).toBe('phase-1');
    expect(parsed.adapter).toBe('claude-code');
  });

  it('should accept null phaseId', () => {
    const obs = { ...validObservation, phaseId: null };
    const parsed = ObservationSchema.parse(obs);
    expect(parsed.phaseId).toBeNull();
  });

  it('should reject missing required fields', () => {
    expect(() => ObservationSchema.parse({})).toThrow();
    expect(() => ObservationSchema.parse({ source: 'coder' })).toThrow();
  });

  it('should reject invalid source', () => {
    expect(() => ObservationSchema.parse({ ...validObservation, source: 'unknown' })).toThrow();
  });

  it('should reject invalid severity', () => {
    expect(() => ObservationSchema.parse({ ...validObservation, severity: 'critical' })).toThrow();
  });

  // Round validation tests removed (round removal).
});

describe('isWorkObservation', () => {
  const makeObs = (type: Observation['type']): Observation => ({
    source: 'coder',
    type,
    summary: 'test',
    severity: 'info',
    timestamp: '2026-03-13T10:00:00.000Z',
  });

  // AC-3: empty_output is NOT classified as work observation
  it('AC-3: empty_output should NOT be classified as work observation', () => {
    expect(isWorkObservation(makeObs('empty_output'))).toBe(false);
  });

  // AC-4: isWorkObservation returns false for non-work types
  it('AC-4: should return false for non-work types', () => {
    const nonWorkTypes: Observation['type'][] = [
      'quota_exhausted',
      'auth_failed',
      'adapter_unavailable',
      'empty_output',
      'meta_output',
      'tool_failure',
      'human_interrupt',
      'human_message',
      'clarification_answer',
      'phase_progress_signal',
      'runtime_invariant_violation',
    ];
    for (const type of nonWorkTypes) {
      expect(isWorkObservation(makeObs(type))).toBe(false);
    }
  });

  it('should return true for work_output', () => {
    expect(isWorkObservation(makeObs('work_output'))).toBe(true);
  });

  it('should return true for review_output', () => {
    expect(isWorkObservation(makeObs('review_output'))).toBe(true);
  });
});

// AC-2: quota_exhausted severity defaults to error
describe('AC-2: quota_exhausted default severity', () => {
  it('should default severity to error when omitted', () => {
    const obs = ObservationSchema.parse({
      source: 'runtime',
      type: 'quota_exhausted',
      summary: 'You are out of extra usage',
      timestamp: '2026-03-13T10:00:00.000Z',
    });
    expect(obs.severity).toBe('error');
    expect(obs.type).toBe('quota_exhausted');
  });

  it('should allow explicit severity to override default', () => {
    const obs = ObservationSchema.parse({
      source: 'runtime',
      type: 'quota_exhausted',
      summary: 'You are out of extra usage',
      severity: 'fatal',
      timestamp: '2026-03-13T10:00:00.000Z',
    });
    expect(obs.severity).toBe('fatal');
  });
});
