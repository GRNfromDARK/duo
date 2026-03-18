/**
 * Output Classifier + Non-Work Guard for Sovereign God Runtime.
 * Source: FR-005 (Observation Normalization), FR-006 (Non-Work Outputs Must Not Advance)
 * Card: B.1
 *
 * Uses regex + keyword pattern matching (no LLM calls).
 * Latency target: < 5ms per classification (pure synchronous).
 */

import { isWorkObservation } from '../types/observation.js';
import type { Observation, ObservationType, ObservationSource, ObservationSeverity } from '../types/observation.js';
import { stripToolMarkers } from './god-decision-service.js';

// ── Pattern Definitions ──

// SPEC-DECISION: Pattern priority order — quota/auth checked before generic error patterns.
// Reason: "Error 429: rate limit" should be quota_exhausted, not tool_failure.

const QUOTA_EXHAUSTED_PATTERNS: RegExp[] = [
  /you'?re out of extra usage/i,
  /rate limit/i,
  /quota exceeded/i,
  /\b429\b/,
  /usage limit/i,
  /too many requests/i,
];

const AUTH_FAILED_PATTERNS: RegExp[] = [
  /authentication failed/i,
  /\bunauthorized\b/i,
  /\b403\b/,
  /invalid api key/i,
];

const ADAPTER_UNAVAILABLE_PATTERNS: RegExp[] = [
  /command not found/i,
  /\bENOENT\b/,
];

const META_OUTPUT_PATTERNS: RegExp[] = [
  /\bI cannot\b/i,
  /\bAs an AI\b/i,
];

// tool_failure patterns — only matched when source is 'runtime'
const TOOL_FAILURE_PATTERNS: RegExp[] = [
  /\berror\b/i,
  /\bexception\b/i,
  /\btraceback\b/i,
];

// ── Classification Helpers ──

function matchesAny(raw: string, patterns: RegExp[]): boolean {
  for (const p of patterns) {
    if (p.test(raw)) return true;
  }
  return false;
}

function classifyType(raw: string, source: ObservationSource): ObservationType {
  // 1. Empty output — highest priority structural check
  if (raw.trim() === '') return 'empty_output';

  // 2. Quota exhausted — check before generic error patterns
  if (matchesAny(raw, QUOTA_EXHAUSTED_PATTERNS)) return 'quota_exhausted';

  // 3. Auth failed — check before generic error patterns
  if (matchesAny(raw, AUTH_FAILED_PATTERNS)) {
    const substantiveLength = stripToolMarkers(raw).length;
    if (substantiveLength > 500) {
      // Auth keyword from auxiliary output (MCP init, etc.) — don't override real work
    } else {
      return 'auth_failed';
    }
  }

  // 4. Adapter unavailable
  if (matchesAny(raw, ADAPTER_UNAVAILABLE_PATTERNS)) return 'adapter_unavailable';

  // 5. Meta output (non-work AI refusals)
  if (matchesAny(raw, META_OUTPUT_PATTERNS)) {
    const hasVerdict = /\[(APPROVED|CHANGES_REQUESTED)\]/.test(raw);
    if (source === 'reviewer' && hasVerdict) {
      // Real review containing analytical "I cannot" — skip meta_output classification
    } else {
      return 'meta_output';
    }
  }

  // 6. Tool failure — only from runtime source to avoid false positives
  //    (coder discussing "error handling" is valid work_output)
  if (source === 'runtime' && matchesAny(raw, TOOL_FAILURE_PATTERNS)) return 'tool_failure';

  // 7. Default: source-based classification
  if (source === 'reviewer') return 'review_output';
  return 'work_output';
}

function severityForType(type: ObservationType): ObservationSeverity {
  switch (type) {
    case 'quota_exhausted':
    case 'auth_failed':
    case 'adapter_unavailable':
    case 'tool_failure':
      return 'error';
    case 'empty_output':
    case 'meta_output':
      return 'warning';
    case 'runtime_invariant_violation':
      return 'fatal';
    default:
      return 'info';
  }
}

// ── Public API ──

/**
 * Classify raw output into a typed Observation.
 * Pure synchronous regex matching — no LLM calls, < 5ms latency.
 */
export function classifyOutput(
  raw: string,
  source: ObservationSource,
  meta: { round: number; phaseId?: string; adapter?: string },
): Observation {
  const type = classifyType(raw, source);

  return {
    source,
    type,
    summary: buildSummary(type, raw),
    rawRef: raw,
    severity: severityForType(type),
    timestamp: new Date().toISOString(),
    round: meta.round,
    phaseId: meta.phaseId ?? null,
    adapter: meta.adapter,
  };
}

/**
 * Factory function to create an Observation with auto-filled timestamp.
 */
export function createObservation(
  type: ObservationType,
  source: ObservationSource,
  summary: string,
  opts: {
    round: number;
    rawRef?: string;
    phaseId?: string;
    adapter?: string;
    severity?: ObservationSeverity;
  },
): Observation {
  return {
    source,
    type,
    summary,
    rawRef: opts.rawRef,
    severity: opts.severity ?? severityForType(type),
    timestamp: new Date().toISOString(),
    round: opts.round,
    phaseId: opts.phaseId ?? null,
    adapter: opts.adapter,
  };
}

/**
 * Guard: determine if an observation represents real work or a non-work incident.
 * Non-work observations MUST NOT trigger CODE_COMPLETE / REVIEW_COMPLETE events.
 */
export function guardNonWorkOutput(obs: Observation): {
  isWork: boolean;
  shouldRouteToGod: boolean;
} {
  if (isWorkObservation(obs)) {
    return { isWork: true, shouldRouteToGod: false };
  }
  return { isWork: false, shouldRouteToGod: true };
}

// ── Incident Tracking (Card F.1: FR-014) ──

/**
 * Tracks consecutive incident occurrences for severity escalation.
 * - empty_output: warning → error on 2+ consecutive
 * - tool_failure: error → fatal on 3+ consecutive
 * Non-incident observations reset the counters.
 */
export class IncidentTracker {
  private consecutiveCounts: Map<ObservationType, number> = new Map();

  /**
   * Track an observation and return a copy with escalated severity if needed.
   * Work observations reset all incident counters.
   */
  trackAndEscalate(obs: Observation): Observation {
    if (isWorkObservation(obs)) {
      this.consecutiveCounts.clear();
      return obs;
    }

    const isIncident = obs.type === 'empty_output' || obs.type === 'tool_failure'
      || obs.type === 'quota_exhausted' || obs.type === 'auth_failed'
      || obs.type === 'adapter_unavailable';

    if (!isIncident) {
      return obs;
    }

    // Increment count for this type, reset others
    const prevCount = this.consecutiveCounts.get(obs.type) ?? 0;
    // Reset counts for other incident types
    for (const key of this.consecutiveCounts.keys()) {
      if (key !== obs.type) {
        this.consecutiveCounts.delete(key);
      }
    }
    this.consecutiveCounts.set(obs.type, prevCount + 1);

    const count = prevCount + 1;
    let escalatedSeverity = obs.severity;

    if (obs.type === 'empty_output' && count >= 2) {
      escalatedSeverity = 'error';
    } else if (obs.type === 'tool_failure' && count >= 3) {
      escalatedSeverity = 'fatal';
    }

    if (escalatedSeverity !== obs.severity) {
      return { ...obs, severity: escalatedSeverity };
    }
    return obs;
  }

  /**
   * Get the current consecutive count for a given observation type.
   */
  getConsecutiveCount(type: ObservationType): number {
    return this.consecutiveCounts.get(type) ?? 0;
  }
}

// ── Internal Helpers ──

function buildSummary(type: ObservationType, raw: string): string {
  switch (type) {
    case 'quota_exhausted':
      return 'Quota/rate limit detected';
    case 'auth_failed':
      return 'Authentication failure detected';
    case 'empty_output':
      return 'Empty or whitespace-only output';
    case 'meta_output':
      return 'Non-work meta output detected';
    case 'adapter_unavailable':
      return 'Adapter process unavailable';
    case 'tool_failure':
      return 'Tool/process failure detected';
    default:
      // No truncation here — full content preserved for God prompt.
      // Prompt-level budget management is handled by buildObservationsSection().
      return raw;
  }
}

// ── Observation Deduplication ──

/**
 * Remove duplicate observations using timestamp+source+type as identity key.
 * Used when merging clarificationObservations with currentObservations,
 * since clarificationObservations already contains current-round observations.
 */
export function deduplicateObservations(observations: Observation[]): Observation[] {
  const seen = new Set<string>();
  return observations.filter(obs => {
    const key = `${obs.timestamp}-${obs.source}-${obs.type}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}
