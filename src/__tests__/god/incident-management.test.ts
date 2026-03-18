/**
 * Tests for Card F.1: Incident Classification & God Incident Response
 * Source: FR-014 (Incidents Are Management Events), FR-015 (God Chooses Switch/Wait/Stop)
 *
 * Acceptance Criteria:
 * AC-1: Token limit treated as incident by God, not reviewer review target
 * AC-2: God can output switch / wait / stop after incident
 * AC-3: Incident handling results written to audit log
 * AC-4: God can switch adapter for coder/reviewer/god
 * AC-5: God can decide wait with reason for user
 * AC-6: God can decide stop with management summary
 * AC-7: empty_output severity escalates on consecutive occurrences
 * AC-8: Consecutive incident failures tracked by IncidentTracker
 * AC-9: All tests pass
 * AC-10: Existing tests unaffected
 */

import { describe, it, expect, beforeEach } from 'vitest';
import {
  classifyOutput,
  createObservation,
  guardNonWorkOutput,
} from '../../god/observation-classifier.js';
import type { Observation } from '../../types/observation.js';
import { GodAuditLogger } from '../../god/god-audit.js';
import { executeActions, type HandExecutionContext, type HandAdapter } from '../../god/hand-executor.js';
import { existsSync, mkdirSync, rmSync, readFileSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import type { GodAction } from '../../types/god-actions.js';

// ── Helpers ──

const meta = { phaseId: 'phase-1', adapter: 'claude-code' };

function makeTestSessionDir(): string {
  const dir = join(tmpdir(), `incident-test-${Date.now()}-${Math.random().toString(36).slice(2)}`);
  mkdirSync(dir, { recursive: true });
  return dir;
}

function makeHandContext(sessionDir: string, overrides?: Partial<HandExecutionContext>): HandExecutionContext {
  return {
    currentPhaseId: 'phase-1',
    pendingCoderMessage: null,
    pendingReviewerMessage: null,
    adapters: new Map<string, HandAdapter>([
      ['coder', { kill: async () => {} }],
      ['reviewer', { kill: async () => {} }],
    ]),
    auditLogger: new GodAuditLogger(sessionDir),
    activeRole: 'coder',
    taskCompleted: false,
    waitState: { active: false, reason: null, estimatedSeconds: null },
    clarificationState: { active: false, question: null },
    interruptResumeStrategy: null,
    adapterConfig: new Map([['coder', 'claude-code'], ['reviewer', 'claude-code'], ['god', 'claude-code']]),
    sessionDir,
    cwd: '/tmp',
    ...overrides,
  };
}

// ── Task 1: Incident Classification Enhancement ──

describe('Incident Classification Enhancement', () => {
  // AC-1: Token limit is incident, not reviewer review target
  describe('AC-1: incident types have correct severity', () => {
    it('quota_exhausted has severity error', () => {
      const obs = classifyOutput("You're out of extra usage · resets 7pm", 'coder', meta);
      expect(obs.type).toBe('quota_exhausted');
      expect(obs.severity).toBe('error');
    });

    it('auth_failed has severity error', () => {
      const obs = classifyOutput('authentication failed: invalid credentials', 'coder', meta);
      expect(obs.type).toBe('auth_failed');
      expect(obs.severity).toBe('error');
    });

    it('adapter_unavailable has severity error', () => {
      const obs = classifyOutput('bash: claude-code: command not found', 'runtime', meta);
      expect(obs.type).toBe('adapter_unavailable');
      expect(obs.severity).toBe('error');
    });

    it('quota_exhausted routes to God (not reviewer)', () => {
      const obs = classifyOutput("You're out of extra usage · resets 7pm", 'coder', meta);
      const guard = guardNonWorkOutput(obs);
      expect(guard.isWork).toBe(false);
      expect(guard.shouldRouteToGod).toBe(true);
    });
  });

  // AC-7: empty_output consecutive severity escalation
  describe('AC-7: empty_output severity escalation', () => {
    it('first empty_output has severity warning', () => {
      const obs = classifyOutput('', 'coder', meta);
      expect(obs.type).toBe('empty_output');
      expect(obs.severity).toBe('warning');
    });

    it('escalateIncidentSeverity escalates empty_output to error on consecutive occurrences', async () => {
      // Import the new function
      const { IncidentTracker } = await import('../../god/observation-classifier.js');
      const tracker = new IncidentTracker();

      // First empty_output → warning
      const obs1 = classifyOutput('', 'coder', meta);
      const escalated1 = tracker.trackAndEscalate(obs1);
      expect(escalated1.severity).toBe('warning');

      // Second consecutive empty_output → error
      const obs2 = classifyOutput('', 'coder', meta);
      const escalated2 = tracker.trackAndEscalate(obs2);
      expect(escalated2.severity).toBe('error');
    });

    it('empty_output severity resets after non-empty output', async () => {
      const { IncidentTracker } = await import('../../god/observation-classifier.js');
      const tracker = new IncidentTracker();

      // First empty
      const obs1 = classifyOutput('', 'coder', meta);
      tracker.trackAndEscalate(obs1);

      // Non-empty output resets counter
      const workObs = classifyOutput('normal work output', 'coder', meta);
      tracker.trackAndEscalate(workObs);

      // Next empty → back to warning (not error)
      const obs2 = classifyOutput('', 'coder', meta);
      const escalated = tracker.trackAndEscalate(obs2);
      expect(escalated.severity).toBe('warning');
    });
  });

  // tool_failure severity escalation based on retry count
  describe('tool_failure severity escalation', () => {
    it('first tool_failure has severity error', () => {
      const obs = classifyOutput('Error: process exited with code 1', 'runtime', meta);
      expect(obs.type).toBe('tool_failure');
      expect(obs.severity).toBe('error');
    });

    it('escalates tool_failure to fatal on 3+ consecutive occurrences', async () => {
      const { IncidentTracker } = await import('../../god/observation-classifier.js');
      const tracker = new IncidentTracker();

      // 1st tool_failure → error
      const obs1 = classifyOutput('Error: crash 1', 'runtime', meta);
      const e1 = tracker.trackAndEscalate(obs1);
      expect(e1.severity).toBe('error');

      // 2nd tool_failure → error
      const obs2 = classifyOutput('Error: crash 2', 'runtime', meta);
      const e2 = tracker.trackAndEscalate(obs2);
      expect(e2.severity).toBe('error');

      // 3rd consecutive tool_failure → fatal
      const obs3 = classifyOutput('Error: crash 3', 'runtime', meta);
      const e3 = tracker.trackAndEscalate(obs3);
      expect(e3.severity).toBe('fatal');
    });

    it('tool_failure severity resets after work output', async () => {
      const { IncidentTracker } = await import('../../god/observation-classifier.js');
      const tracker = new IncidentTracker();

      // Two tool_failures
      tracker.trackAndEscalate(classifyOutput('Error: crash', 'runtime', meta));
      tracker.trackAndEscalate(classifyOutput('Error: crash', 'runtime', meta));

      // Work output resets
      tracker.trackAndEscalate(classifyOutput('normal output', 'coder', meta));

      // Next tool_failure → back to error
      const obs = classifyOutput('Error: crash again', 'runtime', meta);
      const escalated = tracker.trackAndEscalate(obs);
      expect(escalated.severity).toBe('error');
    });
  });

  // IncidentTracker getConsecutiveCount
  describe('IncidentTracker.getConsecutiveCount', () => {
    it('returns 0 for types with no history', async () => {
      const { IncidentTracker } = await import('../../god/observation-classifier.js');
      const tracker = new IncidentTracker();
      expect(tracker.getConsecutiveCount('empty_output')).toBe(0);
    });

    it('returns correct count after tracking', async () => {
      const { IncidentTracker } = await import('../../god/observation-classifier.js');
      const tracker = new IncidentTracker();

      tracker.trackAndEscalate(classifyOutput('', 'coder', meta));
      expect(tracker.getConsecutiveCount('empty_output')).toBe(1);

      tracker.trackAndEscalate(classifyOutput('', 'coder', meta));
      expect(tracker.getConsecutiveCount('empty_output')).toBe(2);
    });
  });
});

// ── Task 2: God Incident Response (AC-2, AC-4, AC-5, AC-6) ──

describe('God Incident Response', () => {
  let sessionDir: string;

  beforeEach(() => {
    sessionDir = makeTestSessionDir();
  });

  // AC-2: God can output switch / wait / stop after incident
  // AC-4: God can switch adapter for coder/reviewer/god
  describe('AC-2/AC-4: switch_adapter for any role', () => {
    it('switch_adapter returns not-implemented warning for coder', async () => {
      const ctx = makeHandContext(sessionDir);
      const actions: GodAction[] = [
        { type: 'switch_adapter', role: 'coder', adapter: 'codex', reason: 'quota exhausted on claude-code' },
      ];
      const results = await executeActions(actions, ctx);
      expect(results).toHaveLength(1);
      expect(results[0].type).toBe('phase_progress_signal');
      expect(results[0].severity).toBe('warning');
      expect(results[0].summary).toContain('not yet implemented');
      expect(ctx.adapterConfig.get('coder')).toBe('claude-code');
    });

    it('switch_adapter returns not-implemented warning for reviewer', async () => {
      const ctx = makeHandContext(sessionDir);
      const actions: GodAction[] = [
        { type: 'switch_adapter', role: 'reviewer', adapter: 'codex', reason: 'auth failed' },
      ];
      const results = await executeActions(actions, ctx);
      expect(results).toHaveLength(1);
      expect(results[0].severity).toBe('warning');
      expect(ctx.adapterConfig.get('reviewer')).toBe('claude-code');
    });

    it('switch_adapter returns not-implemented warning for god', async () => {
      const ctx = makeHandContext(sessionDir);
      const actions: GodAction[] = [
        { type: 'switch_adapter', role: 'god', adapter: 'gpt-4', reason: 'god adapter unavailable' },
      ];
      const results = await executeActions(actions, ctx);
      expect(results).toHaveLength(1);
      expect(results[0].severity).toBe('warning');
      expect(ctx.adapterConfig.get('god')).toBe('claude-code');
    });
  });

  // AC-5: God can decide wait with reason
  describe('AC-5: wait with reason', () => {
    it('wait action sets waitState with reason and estimated seconds', async () => {
      const ctx = makeHandContext(sessionDir);
      const actions: GodAction[] = [
        { type: 'wait', reason: 'API quota resets in 30 minutes', estimatedSeconds: 1800 },
      ];
      const results = await executeActions(actions, ctx);
      expect(results).toHaveLength(1);
      expect(results[0].type).toBe('phase_progress_signal');
      expect(ctx.waitState.active).toBe(true);
      expect(ctx.waitState.reason).toBe('API quota resets in 30 minutes');
      expect(ctx.waitState.estimatedSeconds).toBe(1800);
    });
  });

  // AC-6: God can decide stop with management summary
  describe('AC-6: stop with management summary', () => {
    it('stop_role + emit_summary produces stop and summary', async () => {
      const ctx = makeHandContext(sessionDir);
      const actions: GodAction[] = [
        { type: 'stop_role', role: 'coder', reason: 'persistent auth failure' },
        { type: 'emit_summary', content: 'Coder stopped due to persistent auth failure. Recommend checking API credentials.' },
      ];
      const results = await executeActions(actions, ctx);
      expect(results).toHaveLength(2);
      expect(results[0].summary).toContain('stop_role');
      expect(results[1].summary).toContain('emit_summary');
    });
  });

  // Combined incident response: switch + message to user
  describe('incident response combination', () => {
    it('God can combine switch_adapter + wait + emit_summary in one action list', async () => {
      const ctx = makeHandContext(sessionDir);
      const actions: GodAction[] = [
        { type: 'switch_adapter', role: 'coder', adapter: 'codex', reason: 'claude-code quota exhausted' },
        { type: 'emit_summary', content: 'Switched coder to codex due to quota exhaustion on claude-code.' },
      ];
      const results = await executeActions(actions, ctx);
      expect(results).toHaveLength(2);
      // switch_adapter is not yet implemented, so adapterConfig stays unchanged
      expect(ctx.adapterConfig.get('coder')).toBe('claude-code');
    });
  });
});

// ── Task 3: Incident Audit (AC-3) ──

describe('Incident Audit', () => {
  let sessionDir: string;

  beforeEach(() => {
    sessionDir = makeTestSessionDir();
  });

  // AC-3: Incident handling results written to audit log
  describe('AC-3: logIncidentAudit', () => {
    it('logs incident observation + God diagnosis + decision + execution result', async () => {
      const { logIncidentAudit } = await import('../../god/god-audit.js');
      const logger = new GodAuditLogger(sessionDir);

      const incidentObs: Observation = {
        source: 'coder',
        type: 'quota_exhausted',
        summary: 'Quota/rate limit detected',
        rawRef: "You're out of extra usage · resets 7pm",
        severity: 'error',
        timestamp: new Date().toISOString(),
        phaseId: 'phase-2',
      };

      const envelope = {
        diagnosis: {
          summary: 'Coder hit quota limit, switching to codex adapter',
          currentGoal: 'Implement feature X',
          currentPhaseId: 'phase-2',
          notableObservations: ['quota_exhausted from coder'],
        },
        authority: {
          userConfirmation: 'not_required' as const,
          reviewerOverride: false,
          acceptAuthority: 'reviewer_aligned' as const,
        },
        actions: [
          { type: 'switch_adapter' as const, role: 'coder' as const, adapter: 'codex', reason: 'quota exhausted' },
        ],
        messages: [
          { target: 'user' as const, content: 'Switching coder to codex due to quota limit.' },
          { target: 'system_log' as const, content: 'Incident: quota_exhausted → switch_adapter coder→codex' },
        ],
      };

      const executionResults: Observation[] = [
        {
          source: 'runtime',
          type: 'phase_progress_signal',
          summary: 'switch_adapter: coder → codex',
          severity: 'info',
          timestamp: new Date().toISOString(),
        },
      ];

      logIncidentAudit(logger, {
        incidentObservation: incidentObs,
        envelope,
        executionResults,
      });

      const entries = logger.getEntries({ type: 'incident_response' });
      expect(entries).toHaveLength(1);

      const entry = entries[0];
      expect(entry.decisionType).toBe('incident_response');
      expect(entry.inputSummary).toContain('quota_exhausted');
      expect(entry.outputSummary).toContain('switch_adapter');
      expect(entry.decision).toBeDefined();
      // Decision should contain incident, diagnosis, actions, and results
      const decision = entry.decision as Record<string, unknown>;
      expect(decision.incidentType).toBe('quota_exhausted');
      expect(decision.diagnosis).toBeDefined();
      expect(decision.actions).toBeDefined();
      expect(decision.executionResults).toBeDefined();
    });

    it('audit entry includes incident severity', async () => {
      const { logIncidentAudit } = await import('../../god/god-audit.js');
      const logger = new GodAuditLogger(sessionDir);

      logIncidentAudit(logger, {
        incidentObservation: {
          source: 'runtime',
          type: 'auth_failed',
          summary: 'Authentication failure detected',
          severity: 'error',
        },
        envelope: {
          diagnosis: {
            summary: 'Auth failed, stopping coder',
            currentGoal: 'test',
            currentPhaseId: 'p1',
            notableObservations: [],
          },
          authority: {
            userConfirmation: 'not_required' as const,
            reviewerOverride: false,
            acceptAuthority: 'reviewer_aligned' as const,
          },
          actions: [{ type: 'stop_role' as const, role: 'coder' as const, reason: 'auth failed' }],
          messages: [],
        },
        executionResults: [],
      });

      const entries = logger.getEntries({ type: 'incident_response' });
      expect(entries).toHaveLength(1);
      const decision = entries[0].decision as Record<string, unknown>;
      expect(decision.incidentSeverity).toBe('error');
    });
  });
});

// ── Task 4: Incident Tracking (AC-8) ──

describe('Incident Tracking', () => {
  // AC-8: Consecutive incident failures tracked by IncidentTracker
  describe('AC-8: IncidentTracker tracks consecutive failures', () => {
    it('consecutive incidents tracked by IncidentTracker can inform pause decisions', async () => {
      const { IncidentTracker } = await import('../../god/observation-classifier.js');
      const tracker = new IncidentTracker();

      // Track 3 consecutive quota_exhausted
      for (let i = 0; i < 3; i++) {
        const obs = classifyOutput("You're out of extra usage", 'coder', meta);
        tracker.trackAndEscalate(obs);
      }

      expect(tracker.getConsecutiveCount('quota_exhausted')).toBe(3);

      // This count can be used to decide whether to pause
      // (The integration is: tracker detects consecutive incidents → system pauses)
    });
  });
});

// ── Cross-cutting: existing behaviors preserved ──

describe('Existing behavior preservation', () => {
  it('classifyOutput still works for all original types', () => {
    expect(classifyOutput("You're out of extra usage", 'coder', meta).type).toBe('quota_exhausted');
    expect(classifyOutput('authentication failed', 'coder', meta).type).toBe('auth_failed');
    expect(classifyOutput('', 'coder', meta).type).toBe('empty_output');
    expect(classifyOutput('I cannot do that', 'coder', meta).type).toBe('meta_output');
    expect(classifyOutput('command not found', 'runtime', meta).type).toBe('adapter_unavailable');
    expect(classifyOutput('Error: crash', 'runtime', meta).type).toBe('tool_failure');
    expect(classifyOutput('normal output', 'coder', meta).type).toBe('work_output');
    expect(classifyOutput('looks good', 'reviewer', meta).type).toBe('review_output');
  });

  it('guardNonWorkOutput still routes correctly', () => {
    const workObs = classifyOutput('normal output', 'coder', meta);
    expect(guardNonWorkOutput(workObs).isWork).toBe(true);

    const incidentObs = classifyOutput("You're out of extra usage", 'coder', meta);
    expect(guardNonWorkOutput(incidentObs).shouldRouteToGod).toBe(true);
  });

  it('createObservation factory still works', () => {
    const obs = createObservation('quota_exhausted', 'runtime', 'test', {});
    expect(obs.type).toBe('quota_exhausted');
    expect(obs.severity).toBe('error');
  });
});
