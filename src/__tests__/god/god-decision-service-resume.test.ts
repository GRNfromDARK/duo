import { describe, it, expect } from 'vitest';
import {
  buildObservationsSection,
  SYSTEM_PROMPT,
  GodDecisionService,
} from '../../god/god-decision-service.js';
import { createMockWatchdog } from '../helpers/mock-watchdog.js';
import type { GodAdapter, GodExecOptions } from '../../types/god-adapter.js';
import type { OutputChunk } from '../../types/adapter.js';
import type { GodDecisionContext } from '../../god/god-decision-service.js';
import type { Observation } from '../../types/observation.js';

// ── Baseline tests ──

describe('Resume prompt slimming — baseline', () => {
  const mockObservations: Observation[] = [
    {
      source: 'coder',
      type: 'work_output',
      summary: 'Implemented feature X with tests',
      severity: 'info',
      timestamp: '2026-03-16T10:00:00Z',
    },
  ];

  it('buildObservationsSection still works for resume prompt', () => {
    const section = buildObservationsSection(mockObservations);
    expect(section).toContain('Recent Observations');
    expect(section).toContain('Implemented feature X');
  });

  it('SYSTEM_PROMPT contains format instructions for reminder reference', () => {
    expect(SYSTEM_PROMPT).toContain('GodDecisionEnvelope');
    expect(SYSTEM_PROMPT).toContain('JSON');
  });
});

// ── Mock adapter that captures prompts ──

function createMockAdapter(capturedPrompts: string[]): GodAdapter {
  return {
    name: 'mock-god',
    displayName: 'Mock God',
    version: '1.0.0',
    toolUsePolicy: 'forbid',
    isInstalled: async () => true,
    getVersion: async () => '1.0.0',
    execute: async function* (prompt: string, _opts: GodExecOptions): AsyncIterable<OutputChunk> {
      capturedPrompts.push(prompt);
      yield {
        type: 'text',
        content: '```json\n' + JSON.stringify({
          diagnosis: { summary: 'test', currentGoal: 'test', currentPhaseId: 'p1', notableObservations: [] },
          authority: { userConfirmation: 'not_required', reviewerOverride: false, acceptAuthority: 'reviewer_aligned' },
          actions: [{ type: 'wait', reason: 'test' }],
          messages: [],
        }) + '\n```',
        metadata: {},
        timestamp: Date.now(),
      };
    },
    kill: async () => {},
    isRunning: () => false,
  };
}

// ── makeDecision with isResuming ──

describe('GodDecisionService.makeDecision with isResuming', () => {
  const baseContext: GodDecisionContext = {
    taskGoal: 'Implement login feature',
    currentPhaseId: 'phase-1',
    currentPhaseType: 'code',
    previousDecisions: [],
    availableAdapters: ['claude-code', 'codex'],
    activeRole: 'coder',
    sessionDir: '/tmp/test-session',
  };

  it('first round (isResuming=false) includes full prompt with Hand catalog and Task Goal', async () => {
    const capturedPrompts: string[] = [];
    const adapter = createMockAdapter(capturedPrompts);
    const degradation = createMockWatchdog();
    const service = new GodDecisionService(adapter, degradation);

    await service.makeDecision(
      [{ source: 'coder', type: 'work_output', summary: 'code output', severity: 'info', timestamp: '2026-03-16T10:00:00Z'}],
      baseContext,
      false,
    );

    const prompt = capturedPrompts[0];
    expect(prompt).toContain('Task Goal');
    expect(prompt).toContain('Available Hand Actions');
    expect(prompt).toContain('Available Adapters');
    expect(prompt).toContain('Implement login feature');
  });

  it('resume round (isResuming=true) sends slim prompt without Hand catalog or Task Goal', async () => {
    const capturedPrompts: string[] = [];
    const adapter = createMockAdapter(capturedPrompts);
    const degradation = createMockWatchdog();
    const service = new GodDecisionService(adapter, degradation);

    await service.makeDecision(
      [{ source: 'coder', type: 'work_output', summary: 'code output', severity: 'info', timestamp: '2026-03-16T10:00:00Z'}],
      baseContext,
      true,
    );

    const prompt = capturedPrompts[0];
    // Slim prompt should NOT contain these sections
    expect(prompt).not.toContain('Task Goal');
    expect(prompt).not.toContain('Available Hand Actions');
    expect(prompt).not.toContain('Available Adapters');
    expect(prompt).not.toContain('Last Decision Summary');
    // But SHOULD contain these
    expect(prompt).toContain('## Phase');
    expect(prompt).toContain('Recent Observations');
    expect(prompt).toContain('Reminder:');
    expect(prompt).toContain('system prompt');
    expect(prompt).toContain('GodDecisionEnvelope');
  });

  it('resume prompt contains phase and active role', async () => {
    const capturedPrompts: string[] = [];
    const adapter = createMockAdapter(capturedPrompts);
    const degradation = createMockWatchdog();
    const service = new GodDecisionService(adapter, degradation);

    await service.makeDecision(
      [{ source: 'reviewer', type: 'review_output', summary: '[APPROVED] looks good', severity: 'info', timestamp: '2026-03-16T10:00:00Z'}],
      baseContext,
      true,
    );

    const prompt = capturedPrompts[0];
    expect(prompt).toContain('phase-1');
    expect(prompt).toContain('coder');
  });
});
