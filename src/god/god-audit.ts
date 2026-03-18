/**
 * God audit log — append-only JSONL log for God decisions.
 * Source: FR-020 (AC-051, AC-052), NFR-008
 * Card F.2: FR-018 (Decision Audit Must Explain God), NFR-002, NFR-006
 */

import { appendFileSync, existsSync, mkdirSync, readFileSync, readdirSync, unlinkSync, statSync } from 'fs';
import { writeFileSync } from 'node:fs';
import { join } from 'path';
import type { GodDecisionEnvelope } from '../types/god-envelope.js';
import type { Observation } from '../types/observation.js';

export interface GodAuditEntry {
  seq: number;
  timestamp: string;
  round?: number;
  decisionType: string;
  inputSummary: string;   // ≤ 2000 chars
  outputSummary: string;  // ≤ 2000 chars
  inputTokens?: number;
  outputTokens?: number;
  latencyMs?: number;
  decision: unknown;
  model?: string;
  phaseId?: string;
  outputRef?: string;     // god-decisions/ 中的完整输出引用
}

const AUDIT_FILENAME = 'god-audit.jsonl';
const DECISIONS_DIR = 'god-decisions';
const SUMMARY_MAX_LENGTH = 2000;

/** Truncate a summary string to SUMMARY_MAX_LENGTH, appending '…' if truncated. Unicode-boundary-safe. */
function truncateSummary(s: string): string {
  if (s.length <= SUMMARY_MAX_LENGTH) return s;
  let truncated = s.slice(0, SUMMARY_MAX_LENGTH - 1);
  // Drop lone high surrogate at the end to avoid broken characters
  const lastCode = truncated.charCodeAt(truncated.length - 1);
  if (lastCode >= 0xD800 && lastCode <= 0xDBFF) {
    truncated = truncated.slice(0, -1);
  }
  return truncated + '…';
}

/**
 * Append a God audit entry to the session's god-audit.jsonl file.
 * Creates the file and parent directories if they don't exist.
 * Retained for backward compatibility (AR-004).
 */
export function appendAuditLog(sessionDir: string, entry: GodAuditEntry): void {
  const logPath = join(sessionDir, AUDIT_FILENAME);

  if (!existsSync(sessionDir)) {
    mkdirSync(sessionDir, { recursive: true });
  }

  const sanitized: GodAuditEntry = {
    ...entry,
    inputSummary: truncateSummary(entry.inputSummary),
    outputSummary: truncateSummary(entry.outputSummary),
  };

  appendFileSync(logPath, JSON.stringify(sanitized) + '\n');
}

/**
 * GodAuditLogger — class-based audit logger with seq tracking and outputRef support.
 * Source: FR-020 (AC-051, AC-052)
 */
export class GodAuditLogger {
  private readonly sessionDir: string;
  private seq: number;

  constructor(sessionDir: string) {
    this.sessionDir = sessionDir;
    this.seq = this.loadCurrentSeq();
  }

  /**
   * Append an audit entry. Optionally store full God output in god-decisions/.
   */
  append(entry: Omit<GodAuditEntry, 'seq'>, fullOutput?: unknown): void {
    if (!existsSync(this.sessionDir)) {
      mkdirSync(this.sessionDir, { recursive: true });
    }

    this.seq += 1;
    const seqStr = String(this.seq).padStart(3, '0');

    let outputRef: string | undefined;
    if (fullOutput !== undefined) {
      const decisionsDir = join(this.sessionDir, DECISIONS_DIR);
      if (!existsSync(decisionsDir)) {
        mkdirSync(decisionsDir, { recursive: true });
      }
      const filename = `${seqStr}-${entry.decisionType}.json`;
      outputRef = `${DECISIONS_DIR}/${filename}`;
      writeFileSync(join(decisionsDir, filename), JSON.stringify(fullOutput, null, 2));
    }

    const sanitized: GodAuditEntry = {
      ...entry,
      seq: this.seq,
      inputSummary: truncateSummary(entry.inputSummary),
      outputSummary: truncateSummary(entry.outputSummary),
      ...(outputRef ? { outputRef } : {}),
    };

    const logPath = join(this.sessionDir, AUDIT_FILENAME);
    appendFileSync(logPath, JSON.stringify(sanitized) + '\n');
  }

  /**
   * Read all audit entries, optionally filtered by decisionType.
   */
  getEntries(filter?: { type?: string }): GodAuditEntry[] {
    const logPath = join(this.sessionDir, AUDIT_FILENAME);
    if (!existsSync(logPath)) return [];

    const content = readFileSync(logPath, 'utf-8');
    if (!content.trim()) return [];

    const entries: GodAuditEntry[] = content
      .split('\n')
      .filter(line => line.trim())
      .map(line => JSON.parse(line) as GodAuditEntry);

    if (filter?.type) {
      return entries.filter(e => e.decisionType === filter.type);
    }
    return entries;
  }

  /**
   * Get current sequence number (0 if no entries yet).
   */
  getSequence(): number {
    return this.seq;
  }

  /**
   * Load current seq from existing log file.
   */
  private loadCurrentSeq(): number {
    const logPath = join(this.sessionDir, AUDIT_FILENAME);
    if (!existsSync(logPath)) return 0;

    const content = readFileSync(logPath, 'utf-8');
    if (!content.trim()) return 0;

    const lines = content.split('\n').filter(line => line.trim());
    if (lines.length === 0) return 0;

    const lastLine = lines[lines.length - 1];
    try {
      const entry = JSON.parse(lastLine) as GodAuditEntry;
      return entry.seq ?? 0;
    } catch {
      return 0;
    }
  }
}

/**
 * Log a reviewer override/aligned audit entry.
 * Card D.2: FR-002, FR-010 — tracks reviewer original conclusion + God final verdict.
 *
 * @param logger - GodAuditLogger instance
 * @param params - reviewer observation, God envelope, round
 */
export function logReviewerOverrideAudit(
  logger: GodAuditLogger,
  params: {
    reviewerObservation: { summary: string; rawRef?: string };
    envelope: {
      authority: { reviewerOverride: boolean; acceptAuthority: string };
      diagnosis: { summary: string; notableObservations: string[] };
      messages: Array<{ target: string; content: string }>;
      actions: unknown[];
    };
  },
): void {
  const { reviewerObservation, envelope } = params;

  // Extract reviewer verdict from observation text
  const verdictMatch = /\[(APPROVED|CHANGES_REQUESTED)\]/.exec(
    reviewerObservation.rawRef ?? reviewerObservation.summary,
  );
  const reviewerVerdict = verdictMatch ? verdictMatch[1] : 'unknown';

  const isOverride = envelope.authority.reviewerOverride;
  const godVerdict = envelope.authority.acceptAuthority;

  // Extract override reason from system_log messages
  const systemLogMessages = envelope.messages
    .filter(m => m.target === 'system_log')
    .map(m => m.content);
  const overrideReason = systemLogMessages.join('; ') || null;

  logger.append({
    timestamp: new Date().toISOString(),
    decisionType: isOverride ? 'reviewer_override' : 'reviewer_aligned',
    inputSummary: `Reviewer verdict: ${reviewerVerdict} — ${reviewerObservation.summary}`,
    outputSummary: `God verdict: ${godVerdict}${isOverride ? ' (override)' : ''}`,
    decision: {
      reviewerVerdict,
      godVerdict,
      overrideReason,
      envelope,
    },
  });
}

/**
 * Log an incident response audit entry.
 * Card F.1: FR-014, FR-015 — tracks incident observation + God diagnosis + decision + execution result.
 */
export function logIncidentAudit(
  logger: GodAuditLogger,
  params: {
    incidentObservation: {
      type: string;
      summary: string;
      severity: string;
      source: string;
      rawRef?: string;
    };
    envelope: {
      diagnosis: { summary: string; currentGoal: string; currentPhaseId: string; notableObservations: string[] };
      authority: { userConfirmation: string; reviewerOverride: boolean; acceptAuthority: string };
      actions: Array<{ type: string; [key: string]: unknown }>;
      messages: Array<{ target: string; content: string }>;
    };
    executionResults: Array<{ type: string; summary: string; severity: string; [key: string]: unknown }>;
  },
): void {
  const { incidentObservation, envelope, executionResults } = params;
  const actionTypes = envelope.actions.map(a => a.type).join(', ');

  logger.append({
    timestamp: new Date().toISOString(),
    decisionType: 'incident_response',
    inputSummary: `Incident: ${incidentObservation.type} (${incidentObservation.severity}) — ${incidentObservation.summary}`,
    outputSummary: `God response: ${actionTypes || 'no actions'} — ${envelope.diagnosis.summary}`,
    decision: {
      incidentType: incidentObservation.type,
      incidentSeverity: incidentObservation.severity,
      incidentSource: incidentObservation.source,
      diagnosis: envelope.diagnosis.summary,
      actions: envelope.actions,
      executionResults: executionResults.map(r => ({ type: r.type, summary: r.summary, severity: r.severity })),
    },
  });
}

// ── Reviewer verdict extraction (reuse from god-decision-service.ts pattern) ──

const VERDICT_PATTERN = /\[(APPROVED|CHANGES_REQUESTED)\]/;

function extractReviewerVerdictFromObs(obs: Observation): string {
  if (obs.source !== 'reviewer' || obs.type !== 'review_output') return 'unknown';
  const text = obs.rawRef ?? obs.summary;
  const match = VERDICT_PATTERN.exec(text);
  return match ? match[1] : 'unknown';
}

// ── Card F.2: Enhanced Envelope Decision Audit ──

export interface EnvelopeDecisionParams {
  observations: Observation[];
  envelope: GodDecisionEnvelope;
  executionResults: Observation[];
}

/**
 * Log a complete God decision with full envelope context.
 * Card F.2: FR-018 — every critical God decision records:
 * - Input observations (summary + severity + type)
 * - God diagnosis
 * - Authority override details
 * - Chosen actions
 * - NL messages
 * - Action execution results
 *
 * Override tracking (NFR-002):
 * - userConfirmation = 'god_override' → records override reason
 * - reviewerOverride = true → records reviewer original conclusion + override reason
 */
export function logEnvelopeDecision(
  logger: GodAuditLogger,
  params: EnvelopeDecisionParams,
): void {
  const { observations, envelope, executionResults } = params;

  // Build human-readable inputSummary (NFR-006)
  const obsSummaries = observations.map(o => `${o.type}(${o.severity})`);
  const inputSummary = `Observations: ${obsSummaries.join(', ')}`;

  // Build human-readable outputSummary (NFR-006)
  const actionTypes = envelope.actions.map(a => a.type).join(', ');
  const outputSummary = `${envelope.diagnosis.summary} → ${actionTypes || 'no actions'}`;

  // Build override tracking (NFR-002)
  const overrides = buildOverrideTracking(envelope, observations);

  // Build structured decision payload (AC-5)
  const decision: Record<string, unknown> = {
    observations: observations.map(o => ({
      type: o.type,
      severity: o.severity,
      summary: o.summary,
    })),
    diagnosis: envelope.diagnosis,
    authority: envelope.authority,
    actions: envelope.actions,
    messages: envelope.messages,
    executionResults: executionResults.map(r => ({
      type: r.type,
      summary: r.summary,
      severity: r.severity,
    })),
  };

  // Only include overrides section when there are actual overrides
  if (overrides) {
    decision.overrides = overrides;
  }

  // Store full archive in god-decisions/
  const fullOutput = {
    envelope,
    observations,
    executionResults,
  };

  logger.append(
    {
      timestamp: new Date().toISOString(),
      decisionType: 'god_decision',
      inputSummary,
      outputSummary,
      decision,
      phaseId: envelope.diagnosis.currentPhaseId,
    },
    fullOutput,
  );
}

/**
 * Build override tracking from envelope authority.
 * Returns null if no overrides are present (standard authority).
 */
function buildOverrideTracking(
  envelope: GodDecisionEnvelope,
  observations: Observation[],
): Record<string, unknown> | null {
  const { authority, messages } = envelope;

  const hasUserOverride = authority.userConfirmation === 'god_override';
  const hasReviewerOverride = authority.reviewerOverride;

  if (!hasUserOverride && !hasReviewerOverride) return null;

  // Extract system_log messages as override reasons
  const systemLogMessages = messages
    .filter(m => m.target === 'system_log')
    .map(m => m.content);
  const overrideReason = systemLogMessages.join('; ') || null;

  const result: Record<string, unknown> = {};

  if (hasUserOverride) {
    result.userConfirmationOverride = true;
    result.userConfirmationOverrideReason = overrideReason;
  }

  if (hasReviewerOverride) {
    // Find reviewer observation to extract original conclusion
    const reviewerObs = observations.find(
      o => o.source === 'reviewer' && o.type === 'review_output',
    );
    const originalConclusion = reviewerObs
      ? extractReviewerVerdictFromObs(reviewerObs)
      : 'unknown';

    result.reviewerOverride = true;
    result.reviewerOriginalConclusion = originalConclusion;
    result.reviewerOverrideReason = overrideReason;
  }

  return result;
}

/**
 * Clean up oldest decision files when directory exceeds size limit.
 * Source: NFR-008 (god-decisions/ 目录上限 50MB)
 * @returns Number of files removed
 */
export function cleanupOldDecisions(dir: string, maxSizeMB: number): number {
  if (!existsSync(dir)) return 0;

  const maxBytes = maxSizeMB * 1024 * 1024;

  const files = readdirSync(dir)
    .filter(f => f.endsWith('.json'))
    .sort((a, b) => {
      // Numeric sort by seq prefix to handle seq > 999 correctly
      const seqA = parseInt(a.split('-')[0], 10);
      const seqB = parseInt(b.split('-')[0], 10);
      if (!isNaN(seqA) && !isNaN(seqB)) return seqA - seqB;
      return a.localeCompare(b);
    });

  let totalSize = 0;
  const fileSizes: { name: string; size: number }[] = [];
  for (const f of files) {
    const size = statSync(join(dir, f)).size;
    totalSize += size;
    fileSizes.push({ name: f, size });
  }

  if (totalSize <= maxBytes) return 0;

  let removed = 0;
  for (const { name, size } of fileSizes) {
    if (totalSize <= maxBytes) break;
    unlinkSync(join(dir, name));
    totalSize -= size;
    removed++;
  }

  return removed;
}
