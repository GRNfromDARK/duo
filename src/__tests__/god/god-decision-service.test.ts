/**
 * Tests for God Decision Service (Card C.1)
 * Source: FR-003, FR-004
 * Acceptance Criteria: AC-1 through AC-8
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

import type { OutputChunk } from '../../types/adapter.js';
import type { GodAdapter, GodExecOptions } from '../../types/god-adapter.js';
import type { GodDecisionEnvelope } from '../../types/god-envelope.js';
import type { Observation } from '../../types/observation.js';
import {
  GodDecisionService,
  type GodDecisionContext,
  REVIEWER_HANDLING_INSTRUCTIONS,
  SYSTEM_PROMPT,
} from '../../god/god-decision-service.js';
import { WatchdogService } from '../../god/watchdog.js';

// ── Mock Watchdog Factory ──

function createMockWatchdog(): WatchdogService {
  return new WatchdogService();
}

// ── Mock Adapter Factory ──

function createMockAdapter(
  responseText: string,
  name = 'mock-god',
): { adapter: GodAdapter; getLastPrompt(): string | undefined; getLastSystemPrompt(): string | undefined } {
  let lastPrompt: string | undefined;
  let lastSystemPrompt: string | undefined;

  return {
    adapter: {
      name,
      displayName: 'Mock God',
      version: '1.0.0',
      toolUsePolicy: 'forbid' as const,
      isInstalled: async () => true,
      getVersion: async () => '1.0.0',
      execute(prompt: string, opts: GodExecOptions): AsyncIterable<OutputChunk> {
        lastPrompt = prompt;
        lastSystemPrompt = opts.systemPrompt;
        return {
          async *[Symbol.asyncIterator]() {
            yield { type: 'text' as const, content: responseText, timestamp: Date.now() };
          },
        };
      },
      kill: async () => {},
      isRunning: () => false,
    },
    getLastPrompt: () => lastPrompt,
    getLastSystemPrompt: () => lastSystemPrompt,
  };
}

// ── Test Fixtures ──

function makeValidEnvelopeJson(): string {
  const envelope: GodDecisionEnvelope = {
    diagnosis: {
      summary: 'Coder produced valid output, send to reviewer',
      currentGoal: 'Implement feature X',
      currentPhaseId: 'phase-1',
      notableObservations: ['work_output from coder'],
    },
    authority: {
      userConfirmation: 'not_required',
      reviewerOverride: false,
      acceptAuthority: 'reviewer_aligned',
    },
    actions: [
      { type: 'send_to_reviewer', message: 'Please review the implementation' },
    ],
    messages: [
      { target: 'system_log', content: 'Routing to reviewer after coder output' },
    ],
  };
  return '```json\n' + JSON.stringify(envelope, null, 2) + '\n```';
}

function makeObservation(overrides: Partial<Observation> = {}): Observation {
  return {
    source: 'coder',
    type: 'work_output',
    summary: 'Coder completed implementation',
    severity: 'info',
    timestamp: new Date().toISOString(),
    ...overrides,
  };
}

function makeContext(overrides: Partial<GodDecisionContext> = {}): GodDecisionContext {
  return {
    taskGoal: 'Implement feature X',
    currentPhaseId: 'phase-1',
    previousDecisions: [],
    availableAdapters: ['claude-code', 'codex'],
    activeRole: 'coder',
    sessionDir: '/tmp/test-session',
    ...overrides,
  };
}

// ── Tests ──

describe('GodDecisionService', () => {
  let tmpDir: string;
  let sessionDir: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'duo-god-decision-'));
    sessionDir = path.join(tmpDir, 'session');
    fs.mkdirSync(sessionDir, { recursive: true });
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  // AC-1: makeDecision accepts observations + context, returns GodDecisionEnvelope
  describe('AC-1: makeDecision returns GodDecisionEnvelope', () => {
    it('returns a valid GodDecisionEnvelope when God outputs valid JSON', async () => {
      const { adapter } = createMockAdapter(makeValidEnvelopeJson());
      const service = new GodDecisionService(adapter, createMockWatchdog());
      const observations = [makeObservation()];
      const context = makeContext({ sessionDir });

      const result = await service.makeDecision(observations, context);

      expect(result.diagnosis).toBeDefined();
      expect(result.diagnosis.summary).toBe('Coder produced valid output, send to reviewer');
      expect(result.authority).toBeDefined();
      expect(result.actions).toBeInstanceOf(Array);
      expect(result.actions.length).toBeGreaterThan(0);
      expect(result.messages).toBeInstanceOf(Array);
    });

    it('accepts multiple observations', async () => {
      const { adapter } = createMockAdapter(makeValidEnvelopeJson());
      const service = new GodDecisionService(adapter, createMockWatchdog());
      const observations = [
        makeObservation({ type: 'work_output', severity: 'info' }),
        makeObservation({ type: 'quota_exhausted', severity: 'error', source: 'runtime' }),
      ];
      const context = makeContext({ sessionDir });

      const result = await service.makeDecision(observations, context);

      expect(result.diagnosis).toBeDefined();
    });
  });

  // AC-2: God prompt contains available Hand action catalog
  describe('AC-2: prompt includes Hand action catalog', () => {
    it('includes Hand action types in the prompt sent to God', async () => {
      const { adapter, getLastPrompt } = createMockAdapter(makeValidEnvelopeJson());
      const service = new GodDecisionService(adapter, createMockWatchdog());
      const observations = [makeObservation()];
      const context = makeContext({ sessionDir });

      await service.makeDecision(observations, context);

      const prompt = getLastPrompt()!;
      // Must contain all 11 Hand action types
      expect(prompt).toContain('send_to_coder');
      expect(prompt).toContain('send_to_reviewer');
      expect(prompt).toContain('stop_role');
      expect(prompt).toContain('retry_role');
      expect(prompt).toContain('switch_adapter');
      expect(prompt).toContain('set_phase');
      expect(prompt).toContain('accept_task');
      expect(prompt).toContain('wait');
      expect(prompt).toContain('request_user_input');
      expect(prompt).toContain('resume_after_interrupt');
      expect(prompt).toContain('emit_summary');
    });
  });

  // AC-3: God prompt requires GodDecisionEnvelope JSON format output
  describe('AC-3: prompt requires envelope JSON format', () => {
    it('system prompt instructs God to output GodDecisionEnvelope JSON', async () => {
      const { adapter, getLastSystemPrompt } = createMockAdapter(makeValidEnvelopeJson());
      const service = new GodDecisionService(adapter, createMockWatchdog());
      const observations = [makeObservation()];
      const context = makeContext({ sessionDir });

      await service.makeDecision(observations, context);

      const systemPrompt = getLastSystemPrompt()!;
      expect(systemPrompt).toContain('diagnosis');
      expect(systemPrompt).toContain('authority');
      expect(systemPrompt).toContain('actions');
      expect(systemPrompt).toContain('messages');
      expect(systemPrompt).toContain('JSON');
    });
  });

  // AC-4: Zod validation success → returns valid envelope
  describe('AC-4: valid JSON parses successfully', () => {
    it('returns envelope that passes Zod validation', async () => {
      const { adapter } = createMockAdapter(makeValidEnvelopeJson());
      const service = new GodDecisionService(adapter, createMockWatchdog());
      const observations = [makeObservation()];
      const context = makeContext({ sessionDir });

      const result = await service.makeDecision(observations, context);

      // Verify it matches GodDecisionEnvelope structure
      expect(result.diagnosis.currentGoal).toBe('Implement feature X');
      expect(result.authority.userConfirmation).toBe('not_required');
      expect(result.actions[0].type).toBe('send_to_reviewer');
    });
  });

  // AC-5: Zod validation failure → JSON extraction → retry with extraction
  describe('AC-5: parse failure triggers degradation', () => {
    it('retries with JSON extraction on malformed JSON', async () => {
      // First call returns bad JSON, retry adapter returns valid
      let callCount = 0;
      const validJson = makeValidEnvelopeJson();
      const adapter: GodAdapter = {
        name: 'mock-god',
        displayName: 'Mock God',
        version: '1.0.0',
        toolUsePolicy: 'forbid',
        isInstalled: async () => true,
        getVersion: async () => '1.0.0',
        execute(prompt: string, opts: GodExecOptions): AsyncIterable<OutputChunk> {
          callCount++;
          const content = callCount === 1
            ? '```json\n{ "invalid": true }\n```'
            : validJson;
          return {
            async *[Symbol.asyncIterator]() {
              yield { type: 'text' as const, content, timestamp: Date.now() };
            },
          };
        },
        kill: async () => {},
        isRunning: () => false,
      };

      const watchdog = new WatchdogService();
      const service = new GodDecisionService(adapter, watchdog);
      const observations = [makeObservation()];
      const context = makeContext({ sessionDir });

      const result = await service.makeDecision(observations, context);

      // Should have retried and succeeded
      expect(callCount).toBe(2);
      expect(result.diagnosis).toBeDefined();
    });

    it('triggers watchdog escalation when all parse attempts fail', async () => {
      const adapter: GodAdapter = {
        name: 'mock-god',
        displayName: 'Mock God',
        version: '1.0.0',
        toolUsePolicy: 'forbid',
        isInstalled: async () => true,
        getVersion: async () => '1.0.0',
        execute(): AsyncIterable<OutputChunk> {
          return {
            async *[Symbol.asyncIterator]() {
              yield { type: 'text' as const, content: '```json\n{ "garbage": 123 }\n```', timestamp: Date.now() };
            },
          };
        },
        kill: async () => {},
        isRunning: () => false,
      };

      const watchdog = createMockWatchdog();
      const service = new GodDecisionService(adapter, watchdog);
      const observations = [makeObservation()];
      const context = makeContext({ sessionDir });

      // Should still return a fallback envelope (not throw)
      const result = await service.makeDecision(observations, context);

      // Fallback envelope should have sensible defaults
      expect(result.diagnosis).toBeDefined();
      expect(result.actions).toBeInstanceOf(Array);
      expect(result.messages).toBeInstanceOf(Array);

      // Watchdog should have recorded the failure
      expect(watchdog.getConsecutiveFailures()).toBeGreaterThan(0);
    });

    it('returns fallback envelope when God returns no JSON block at all', async () => {
      const { adapter } = createMockAdapter('I am thinking about the problem...');
      const watchdog = createMockWatchdog();
      const service = new GodDecisionService(adapter, watchdog);
      const observations = [makeObservation()];
      const context = makeContext({ sessionDir });

      const result = await service.makeDecision(observations, context);

      expect(result.diagnosis).toBeDefined();
      expect(result.actions).toBeInstanceOf(Array);
    });
  });

  // AC-6: Service calls God via GodAdapter interface (not hardcoded)
  describe('AC-6: uses GodAdapter interface', () => {
    it('works with any adapter implementing GodAdapter interface', async () => {
      const { adapter: adapterA } = createMockAdapter(makeValidEnvelopeJson(), 'adapter-a');
      const { adapter: adapterB } = createMockAdapter(makeValidEnvelopeJson(), 'adapter-b');

      const serviceA = new GodDecisionService(adapterA, createMockWatchdog());
      const serviceB = new GodDecisionService(adapterB, createMockWatchdog());

      const observations = [makeObservation()];
      const context = makeContext({ sessionDir });

      const resultA = await serviceA.makeDecision(observations, context);
      const resultB = await serviceB.makeDecision(observations, context);

      expect(resultA.diagnosis).toBeDefined();
      expect(resultB.diagnosis).toBeDefined();
    });
  });

  // Prompt content: observations sorted by severity, high first
  describe('prompt includes observations sorted by severity', () => {
    it('includes observation summaries in the prompt', async () => {
      const { adapter, getLastPrompt } = createMockAdapter(makeValidEnvelopeJson());
      const service = new GodDecisionService(adapter, createMockWatchdog());

      const observations = [
        makeObservation({ summary: 'Low priority info', severity: 'info', timestamp: '2026-01-01T00:00:01Z' }),
        makeObservation({ summary: 'Critical error detected', severity: 'error', timestamp: '2026-01-01T00:00:02Z' }),
        makeObservation({ summary: 'Warning signal', severity: 'warning', timestamp: '2026-01-01T00:00:03Z' }),
      ];
      const context = makeContext({ sessionDir });

      await service.makeDecision(observations, context);

      const prompt = getLastPrompt()!;
      expect(prompt).toContain('Critical error detected');
      expect(prompt).toContain('Low priority info');
      expect(prompt).toContain('Warning signal');

      // Error severity should appear before info severity in the prompt
      const errorIdx = prompt.indexOf('Critical error detected');
      const infoIdx = prompt.indexOf('Low priority info');
      expect(errorIdx).toBeLessThan(infoIdx);
    });
  });

  // Prompt content: task goal and phase info
  describe('prompt includes context information', () => {
    it('includes task goal, phase, and round info', async () => {
      const { adapter, getLastPrompt } = createMockAdapter(makeValidEnvelopeJson());
      const service = new GodDecisionService(adapter, createMockWatchdog());
      const observations = [makeObservation()];
      const context = makeContext({
        sessionDir,
        taskGoal: 'Fix authentication bug',
        currentPhaseId: 'debug-phase',
      });

      await service.makeDecision(observations, context);

      const prompt = getLastPrompt()!;
      expect(prompt).toContain('Fix authentication bug');
      expect(prompt).toContain('debug-phase');
      expect(prompt).toContain('3');
      expect(prompt).toContain('8');
    });

    it('includes previous decision summary when available', async () => {
      const { adapter, getLastPrompt } = createMockAdapter(makeValidEnvelopeJson());
      const service = new GodDecisionService(adapter, createMockWatchdog());
      const observations = [makeObservation()];

      const previousDecision: GodDecisionEnvelope = {
        diagnosis: {
          summary: 'Sent code to reviewer for first pass',
          currentGoal: 'Implement feature X',
          currentPhaseId: 'phase-1',
          notableObservations: [],
        },
        authority: {
          userConfirmation: 'not_required',
          reviewerOverride: false,
          acceptAuthority: 'reviewer_aligned',
        },
        actions: [{ type: 'send_to_reviewer', message: 'review this' }],
        messages: [],
      };

      const context = makeContext({
        sessionDir,
        previousDecisions: [previousDecision],
      });

      await service.makeDecision(observations, context);

      const prompt = getLastPrompt()!;
      expect(prompt).toContain('Sent code to reviewer for first pass');
    });
  });

  // System prompt: Sovereign God role
  describe('system prompt establishes Sovereign God role', () => {
    it('system prompt declares God as sovereign decision maker', async () => {
      const { adapter, getLastSystemPrompt } = createMockAdapter(makeValidEnvelopeJson());
      const service = new GodDecisionService(adapter, createMockWatchdog());
      const observations = [makeObservation()];
      const context = makeContext({ sessionDir });

      await service.makeDecision(observations, context);

      const systemPrompt = getLastSystemPrompt()!;
      // Should establish God's sovereign role
      expect(systemPrompt.toLowerCase()).toMatch(/sovereign|唯一|sole.*decision/i);
    });
  });

  // Bug 11 fix: Phase plan injection into unified decision prompt
  describe('phase plan injection', () => {
    it('includes phase plan with types and descriptions when phases are provided', async () => {
      const { adapter, getLastPrompt } = createMockAdapter(makeValidEnvelopeJson());
      const service = new GodDecisionService(adapter, createMockWatchdog());
      const observations = [makeObservation()];
      const context = makeContext({
        sessionDir,
        currentPhaseId: 'phase-1',
        currentPhaseType: 'explore',
        phases: [
          { id: 'phase-1', name: 'Explore', type: 'explore', description: 'Explore the project' },
          { id: 'phase-2', name: 'Validate Proposals', type: 'review', description: 'Reviewer validates proposals' },
          { id: 'phase-3', name: 'Implement', type: 'code', description: 'Implement changes' },
        ],
      });

      await service.makeDecision(observations, context);

      const prompt = getLastPrompt()!;
      // Must contain all phase IDs and types
      expect(prompt).toContain('phase-1');
      expect(prompt).toContain('phase-2');
      expect(prompt).toContain('phase-3');
      expect(prompt).toContain('explore');
      expect(prompt).toContain('review');
      expect(prompt).toContain('code');
      // Must indicate current phase
      expect(prompt).toContain('Explore the project');
      expect(prompt).toContain('Reviewer validates proposals');
    });

    it('includes current phase type in prompt', async () => {
      const { adapter, getLastPrompt } = createMockAdapter(makeValidEnvelopeJson());
      const service = new GodDecisionService(adapter, createMockWatchdog());
      const observations = [makeObservation()];
      const context = makeContext({
        sessionDir,
        currentPhaseId: 'phase-2',
        currentPhaseType: 'review',
        phases: [
          { id: 'phase-1', name: 'Explore', type: 'explore', description: 'Explore' },
          { id: 'phase-2', name: 'Validate', type: 'review', description: 'Validate proposals' },
        ],
      });

      await service.makeDecision(observations, context);

      const prompt = getLastPrompt()!;
      // Phase & Round section must show the phase type
      expect(prompt).toMatch(/Phase:.*phase-2.*review/s);
    });

    it('system prompt includes phase-following guidance for review-type phases', async () => {
      const { adapter, getLastSystemPrompt } = createMockAdapter(makeValidEnvelopeJson());
      const service = new GodDecisionService(adapter, createMockWatchdog());
      const observations = [makeObservation()];
      const context = makeContext({
        sessionDir,
        currentPhaseId: 'phase-1',
        phases: [
          { id: 'phase-1', name: 'Explore', type: 'explore', description: 'Explore' },
          { id: 'phase-2', name: 'Review', type: 'review', description: 'Review proposals' },
        ],
      });

      await service.makeDecision(observations, context);

      const systemPrompt = getLastSystemPrompt()!;
      // Must instruct God to follow phase plan and involve reviewer for review-type phases
      expect(systemPrompt).toMatch(/review.*phase/i);
      expect(systemPrompt).toMatch(/send_to_reviewer/i);
    });

    it('does not include phase plan section when phases is undefined', async () => {
      const { adapter, getLastPrompt } = createMockAdapter(makeValidEnvelopeJson());
      const service = new GodDecisionService(adapter, createMockWatchdog());
      const observations = [makeObservation()];
      const context = makeContext({ sessionDir });

      await service.makeDecision(observations, context);

      const prompt = getLastPrompt()!;
      expect(prompt).not.toContain('Phase Plan');
    });
  });

  // Watchdog success resets
  describe('Watchdog integration', () => {
    it('calls handleGodSuccess on successful parse', async () => {
      const { adapter } = createMockAdapter(makeValidEnvelopeJson());
      const watchdog = createMockWatchdog();
      const service = new GodDecisionService(adapter, watchdog);

      // Verify initial state is clean
      expect(watchdog.getConsecutiveFailures()).toBe(0);

      const observations = [makeObservation()];
      const context = makeContext({ sessionDir });

      await service.makeDecision(observations, context);

      // Success should keep state clean
      expect(watchdog.getConsecutiveFailures()).toBe(0);
      expect(watchdog.isPaused()).toBe(false);
    });
  });

  // ── REVIEWER_HANDLING_INSTRUCTIONS content (Change 3) ──

  describe('REVIEWER_HANDLING_INSTRUCTIONS auto-forwarding guidance', () => {
    it('REVIEWER_HANDLING_INSTRUCTIONS includes auto-forwarding guidance', () => {
      expect(REVIEWER_HANDLING_INSTRUCTIONS).toContain('auto-forwarding');
      expect(REVIEWER_HANDLING_INSTRUCTIONS).toContain('ROUTING GUIDANCE');
      expect(REVIEWER_HANDLING_INSTRUCTIONS).toContain('Do NOT repeat or summarize');
    });
  });

  describe('CHOICE_HANDLING_INSTRUCTIONS', () => {
    it('is included in SYSTEM_PROMPT', () => {
      expect(SYSTEM_PROMPT).toContain('Worker choice handling');
      expect(SYSTEM_PROMPT).toContain('autonomousResolutions');
      expect(SYSTEM_PROMPT).toContain('request_user_input');
    });
  });

  describe('MODE_SPECIFICATION_INSTRUCTIONS', () => {
    it('is included in SYSTEM_PROMPT', () => {
      expect(SYSTEM_PROMPT).toContain('Worker mode specification');
    });
  });
});
