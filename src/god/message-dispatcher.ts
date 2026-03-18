/**
 * Natural-Language Message Dispatcher — routes GodDecisionEnvelope messages.
 * Source: FR-008 (Natural-Language Message Channel)
 * Card: C.3
 *
 * Key constraint: Message dispatch MUST NOT trigger any state change (NFR-001 / FR-016).
 * Only allowed side effects are displayToUser() and auditLogger writes.
 */

import type { GodAction } from '../types/god-actions.js';
import type { EnvelopeMessage } from '../types/god-envelope.js';
import type { Observation } from '../types/observation.js';
import type { GodAuditLogger } from './god-audit.js';
import { formatGodMessage } from '../ui/god-message-style.js';

// ── Types ──

export interface DispatchContext {
  pendingCoderMessage: string | null;
  pendingReviewerMessage: string | null;
  displayToUser: (message: string) => void;
  auditLogger: GodAuditLogger;
}

export interface DispatchResult {
  pendingCoderMessage: string | null;
  pendingReviewerMessage: string | null;
}

// ── Main Function ──

/**
 * Dispatch messages from a GodDecisionEnvelope to their targets.
 *
 * - target: 'coder' → returned in result.pendingCoderMessage
 * - target: 'reviewer' → returned in result.pendingReviewerMessage
 * - target: 'user' → formatted via god-message-style, displayed via context.displayToUser()
 * - target: 'system_log' → written to god-audit.jsonl via context.auditLogger
 *
 * DOES NOT mutate context.pendingCoderMessage or context.pendingReviewerMessage.
 * Returns new pending messages as a pure result (NFR-001 / FR-016).
 */
export function dispatchMessages(
  messages: EnvelopeMessage[],
  context: DispatchContext,
): DispatchResult {
  let pendingCoderMessage: string | null = null;
  let pendingReviewerMessage: string | null = null;

  for (const msg of messages) {
    switch (msg.target) {
      case 'coder':
        pendingCoderMessage = pendingCoderMessage
          ? `${pendingCoderMessage}\n${msg.content}`
          : msg.content;
        break;

      case 'reviewer':
        pendingReviewerMessage = pendingReviewerMessage
          ? `${pendingReviewerMessage}\n${msg.content}`
          : msg.content;
        break;

      case 'user': {
        // Format via god-message-style then display
        const formatted = formatGodMessage(msg.content, 'auto_decision');
        context.displayToUser(formatted.join('\n'));
        break;
      }

      case 'system_log':
        // Write to audit log (allowed side effect)
        context.auditLogger.append({
          timestamp: new Date().toISOString(),
          decisionType: 'message_dispatch',
          inputSummary: `system_log message dispatched`,
          outputSummary: msg.content,
          decision: { target: 'system_log', content: msg.content },
        });
        break;
    }
  }

  return { pendingCoderMessage, pendingReviewerMessage };
}

// ── NL Invariant Checks (Card D.3, FR-016) ──

// ── NL Invariant Check Patterns ──

// SPEC-DECISION: chose regex + keyword patterns over LLM-based detection.
// Reason: <1ms latency, deterministic, zero API cost per AR-003.
// Patterns cover both Chinese and English keywords for state changes.

const PHASE_CHANGE_PATTERN = /(?:进入|切换到?|transition\s+to|move\s+to|enter|set)\s+phase/i;
const ACCEPT_PATTERN = /\baccept(?:ed|ing)?\s+(?:the\s+)?(?:task|result)\b|接受(?:任务|结果)/i;
const ADAPTER_SWITCH_PATTERN = /(?:切换|switch|change|swap)\s+adapter/i;

/**
 * Check for NL/Action inconsistencies: state-change keywords in NL messages
 * without corresponding actions. Returns runtime_invariant_violation observations.
 *
 * Source: FR-016 (State Changes Must Be Action-Backed), NFR-001
 * Card: D.3
 */
export function checkNLInvariantViolations(
  messages: EnvelopeMessage[],
  actions: GodAction[],
  context: { phaseId: string },
): Observation[] {
  if (messages.length === 0) return [];

  const allContent = messages.map(m => m.content).join(' ');
  const violations: Observation[] = [];
  const timestamp = new Date().toISOString();

  // Check phase change keywords without set_phase action
  if (PHASE_CHANGE_PATTERN.test(allContent)) {
    const hasSetPhase = actions.some(a => a.type === 'set_phase');
    if (!hasSetPhase) {
      violations.push({
        source: 'runtime',
        type: 'runtime_invariant_violation',
        summary: 'NL message mentions phase change but no set_phase action present (FR-016)',
        severity: 'error',
        timestamp,
        phaseId: context.phaseId,
      });
    }
  }

  // Check accept keywords without accept_task action
  if (ACCEPT_PATTERN.test(allContent)) {
    const hasAcceptTask = actions.some(a => a.type === 'accept_task');
    if (!hasAcceptTask) {
      violations.push({
        source: 'runtime',
        type: 'runtime_invariant_violation',
        summary: 'NL message mentions accept but no accept_task action present (FR-016)',
        severity: 'error',
        timestamp,
        phaseId: context.phaseId,
      });
    }
  }

  // Check adapter switch keywords without switch_adapter action
  if (ADAPTER_SWITCH_PATTERN.test(allContent)) {
    const hasSwitchAdapter = actions.some(a => a.type === 'switch_adapter');
    if (!hasSwitchAdapter) {
      violations.push({
        source: 'runtime',
        type: 'runtime_invariant_violation',
        summary: 'NL message mentions adapter switch but no switch_adapter action present (FR-016)',
        severity: 'error',
        timestamp,
        phaseId: context.phaseId,
      });
    }
  }

  return violations;
}
