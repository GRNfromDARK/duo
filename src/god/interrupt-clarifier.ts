import type { GodAdapter } from '../types/god-adapter.js';
import { appendAuditLog, type GodAuditEntry } from './god-audit.js';
import { collectGodAdapterOutput } from './god-call.js';

export interface InterruptClassification {
  intent: 'restart' | 'redirect' | 'continue';
  instruction: string;
  reasoning: string;
  needsClarification: boolean;
}

export interface InterruptContext {
  userInput: string;
  taskGoal: string;
  currentPhaseId?: string;
  lastCoderOutput?: string;
  lastReviewerOutput?: string;
  sessionDir: string;
  seq: number;
  projectDir?: string;
}

const GOD_TIMEOUT_MS = 600_000;

const INTERRUPT_SYSTEM_PROMPT = `You are the God orchestrator classifying a human observer interrupt.
The human rarely interrupts, so treat the message as important directional guidance.

- "restart": restart the current attempt with a different approach
- "redirect": change direction but keep useful progress
- "continue": keep the current direction with a small tactical adjustment

Always return a clear actionable instruction.
If the message is ambiguous, set needsClarification=true and place the clarifying question in instruction.`;

export async function classifyInterruptIntent(
  godAdapter: GodAdapter,
  context: InterruptContext,
  model?: string,
): Promise<InterruptClassification> {
  const prompt = buildInterruptPrompt(context);

  try {
    const rawOutput = await collectGodAdapterOutput({
      adapter: godAdapter,
      prompt,
      systemPrompt: INTERRUPT_SYSTEM_PROMPT,
      projectDir: context.projectDir,
      timeoutMs: GOD_TIMEOUT_MS,
      model,
      logging: {
        sessionDir: context.sessionDir,
        kind: 'god_interrupt_classification',
        meta: { attempt: 1 },
      },
    });
    const parsed = parseInterruptResponse(rawOutput);

    const entry: GodAuditEntry = {
      seq: context.seq,
      timestamp: new Date().toISOString(),
      decisionType: 'INTERRUPT_CLASSIFICATION',
      inputSummary: context.userInput,
      outputSummary: JSON.stringify(parsed),
      decision: parsed,
    };
    appendAuditLog(context.sessionDir, entry);

    return parsed;
  } catch {
    return {
      intent: 'redirect',
      instruction: context.userInput,
      reasoning: 'Fallback: God unavailable, using user input as redirect instruction',
      needsClarification: false,
    };
  }
}

function buildInterruptPrompt(context: InterruptContext): string {
  return [
    '## Interrupt Classification',
    'The human observer has interrupted the AI coding session.',
    '',
    `User says: "${context.userInput}"`,
    `Task: ${context.taskGoal}`,
    context.currentPhaseId ? `Phase: ${context.currentPhaseId}` : '',
    context.lastCoderOutput ? `Last coder output:\n${context.lastCoderOutput}` : '',
    context.lastReviewerOutput ? `Last reviewer output:\n${context.lastReviewerOutput}` : '',
    '',
    'Output a JSON code block:',
    '```json',
    '{',
    '  "intent": "restart" | "redirect" | "continue",',
    '  "instruction": "clear instruction for the system",',
    '  "reasoning": "why this classification",',
    '  "needsClarification": false',
    '}',
    '```',
  ].filter(Boolean).join('\n');
}

function parseInterruptResponse(rawOutput: string): InterruptClassification {
  const jsonMatch = rawOutput.match(/```json\s*([\s\S]*?)```/);
  if (jsonMatch) {
    try {
      const parsed = JSON.parse(jsonMatch[1]) as Partial<InterruptClassification>;
      const intent = parsed.intent === 'restart' || parsed.intent === 'redirect' || parsed.intent === 'continue'
        ? parsed.intent
        : 'redirect';
      return {
        intent,
        instruction: typeof parsed.instruction === 'string' ? parsed.instruction : '',
        reasoning: typeof parsed.reasoning === 'string' ? parsed.reasoning : '',
        needsClarification: parsed.needsClarification === true,
      };
    } catch {
      // Fall through to raw-output fallback below.
    }
  }

  return {
    intent: 'redirect',
    instruction: rawOutput.trim(),
    reasoning: 'Could not parse God response, using raw output',
    needsClarification: false,
  };
}
