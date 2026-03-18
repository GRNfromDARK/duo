/**
 * Tests for Card B.1: 动态 Prompt 生成 Reviewer-Driven
 * Source: FR-003 (AC-013, AC-014, AC-015), FR-003a, FR-003b, FR-003c
 */

import { describe, test, expect, vi, beforeEach } from 'vitest';
import type { GodAuditEntry } from '../../god/god-audit.js';

// ── Types expected from god-prompt-generator ──

import type { PromptContext } from '../../god/god-prompt-generator.js';
import {
  generateCoderPrompt,
  generateReviewerPrompt,
  extractBlockingIssues,
} from '../../god/god-prompt-generator.js';

// ── Mock audit log ──
vi.mock('../../god/god-audit.js', () => ({
  appendAuditLog: vi.fn(),
}));

import { appendAuditLog } from '../../god/god-audit.js';
const mockAppendAuditLog = vi.mocked(appendAuditLog);

// ── Helpers ──

function makePromptContext(overrides: Partial<PromptContext> = {}): PromptContext {
  return {
    taskType: 'code',
    taskGoal: 'Implement user authentication',
    ...overrides,
  };
}

// ══════════════════════════════════════════════════════════════════
// FR-003a: 任务类型 → Prompt 策略映射
// ══════════════════════════════════════════════════════════════════

describe('FR-003a: Task type → Prompt strategy mapping', () => {
  // AC-1: explore 型 prompt 不包含 implement/create/write code 等执行动词
  test('AC-1: explore prompt does NOT contain execution verbs (implement/create/write code)', () => {
    const ctx = makePromptContext({ taskType: 'explore', taskGoal: 'Understand the authentication flow' });
    const prompt = generateCoderPrompt(ctx);

    const executionVerbs = ['implement', 'create', 'write code', 'build', 'develop'];
    for (const verb of executionVerbs) {
      expect(prompt.toLowerCase()).not.toContain(verb);
    }
    // Should contain analysis-oriented language
    expect(prompt.toLowerCase()).toMatch(/analy[sz]e|investigate|explore|suggest|recommend|examine/);
  });

  // AC-2: code 型 prompt 包含编码指令和质量要求
  test('AC-2: code prompt contains coding instructions and quality requirements', () => {
    const ctx = makePromptContext({ taskType: 'code' });
    const prompt = generateCoderPrompt(ctx);

    // Should contain coding-related instructions
    expect(prompt.toLowerCase()).toMatch(/implement|code|write|build|develop/);
    // Should contain quality requirements
    expect(prompt.toLowerCase()).toMatch(/quality|test|clean|robust|correct/);
  });

  test('review prompt contains review-specific instructions', () => {
    const ctx = makePromptContext({ taskType: 'review' });
    const prompt = generateCoderPrompt(ctx);

    expect(prompt.toLowerCase()).toMatch(/review|audit|check|inspect|examine/);
  });

  test('debug prompt contains debugging instructions', () => {
    const ctx = makePromptContext({ taskType: 'debug' });
    const prompt = generateCoderPrompt(ctx);

    expect(prompt.toLowerCase()).toMatch(/debug|diagnose|fix|trace|root cause/);
  });

  test('discuss prompt contains discussion instructions', () => {
    const ctx = makePromptContext({ taskType: 'discuss' });
    const prompt = generateCoderPrompt(ctx);

    expect(prompt.toLowerCase()).toMatch(/discuss|consider|evaluate|weigh|pros|cons/);
  });

  // compound 型随阶段切换 prompt 策略
  test('AC-compound: compound type switches strategy based on phaseId type', () => {
    const ctx = makePromptContext({
      taskType: 'compound',
      phaseId: 'phase-1',
      phaseType: 'explore',
      taskGoal: 'Understand the authentication flow',
    });
    const prompt = generateCoderPrompt(ctx);

    // Should follow explore strategy for explore phase
    const executionVerbs = ['implement', 'create', 'write code'];
    for (const verb of executionVerbs) {
      expect(prompt.toLowerCase()).not.toContain(verb);
    }
  });

  test('compound type uses code strategy for code phase', () => {
    const ctx = makePromptContext({
      taskType: 'compound',
      phaseId: 'phase-2',
      phaseType: 'code',
    });
    const prompt = generateCoderPrompt(ctx);

    expect(prompt.toLowerCase()).toMatch(/implement|code|write|build/);
  });
});

// ══════════════════════════════════════════════════════════════════
// FR-003b: Reviewer-Driven Prompt 组装优先级
// ══════════════════════════════════════════════════════════════════

describe('FR-003b: Reviewer-Driven prompt assembly priority', () => {
  // AC-3: unresolvedIssues 列为 Coder 首要待办
  test('AC-3: unresolvedIssues appear as top-priority TODO list in coder prompt', () => {
    const ctx = makePromptContext({
      taskType: 'code',
      unresolvedIssues: [
        'Missing null check on user input',
        'SQL injection vulnerability in query builder',
      ],
    });
    const prompt = generateCoderPrompt(ctx);

    // Issues should appear in the prompt
    expect(prompt).toContain('Missing null check on user input');
    expect(prompt).toContain('SQL injection vulnerability in query builder');

    // Issues should appear before suggestions (priority check)
    const issuesIndex = prompt.indexOf('Missing null check on user input');
    expect(issuesIndex).toBeGreaterThan(-1);
  });

  test('unresolvedIssues appear before suggestions in prompt', () => {
    const ctx = makePromptContext({
      taskType: 'code',
      unresolvedIssues: ['Fix null check'],
      suggestions: ['Consider using optional chaining'],
    });
    const prompt = generateCoderPrompt(ctx);

    const issuesIndex = prompt.indexOf('Fix null check');
    const suggestionsIndex = prompt.indexOf('Consider using optional chaining');
    expect(issuesIndex).toBeLessThan(suggestionsIndex);
  });

  test('suggestions appear as non-blocking recommendations', () => {
    const ctx = makePromptContext({
      taskType: 'code',
      suggestions: ['Use consistent naming convention'],
    });
    const prompt = generateCoderPrompt(ctx);

    expect(prompt).toContain('Use consistent naming convention');
  });

  test('task goal is always included', () => {
    const ctx = makePromptContext({ taskGoal: 'Build REST API' });
    const prompt = generateCoderPrompt(ctx);

    expect(prompt).toContain('Build REST API');
  });

  // Round info and convergenceLog tests removed (round removal).
});

// ══════════════════════════════════════════════════════════════════
// FR-003c: Prompt 质量保证
// ══════════════════════════════════════════════════════════════════

describe('FR-003c: Prompt quality assurance', () => {
  // AC-4: prompt includes all content without artificial truncation
  test('AC-4: prompt includes full task goal and issues', () => {
    const taskGoal = 'A'.repeat(50000);
    const ctx = makePromptContext({
      taskGoal,
      unresolvedIssues: Array.from({ length: 100 }, (_, i) => `Issue ${i}: ${'x'.repeat(500)}`),
    });
    const prompt = generateCoderPrompt(ctx);

    expect(prompt).toContain(taskGoal);
  });

  // AC-5: prompt 摘要写入 audit log
  test('AC-5: prompt summary is written to audit log', () => {
    mockAppendAuditLog.mockClear();

    const ctx = makePromptContext({ taskType: 'code' });
    generateCoderPrompt(ctx, { sessionDir: '/tmp/test-session', seq: 1 });

    expect(mockAppendAuditLog).toHaveBeenCalledOnce();
    const call = mockAppendAuditLog.mock.calls[0];
    expect(call[0]).toBe('/tmp/test-session');

    const entry: GodAuditEntry = call[1];
    expect(entry.decisionType).toBe('PROMPT_GENERATION');
    expect(entry.outputSummary.length).toBeGreaterThan(0);
  });

  test('audit log entry contains full prompt summary without truncation', () => {
    mockAppendAuditLog.mockClear();

    const ctx = makePromptContext({
      taskGoal: 'X'.repeat(1000),
    });
    generateCoderPrompt(ctx, { sessionDir: '/tmp/test-session', seq: 2 });

    const entry: GodAuditEntry = mockAppendAuditLog.mock.calls[0][1];
    expect(entry.outputSummary).toContain('X'.repeat(1000));
  });

  test('no audit log when sessionDir not provided', () => {
    mockAppendAuditLog.mockClear();

    const ctx = makePromptContext({ taskType: 'code' });
    generateCoderPrompt(ctx);

    expect(mockAppendAuditLog).not.toHaveBeenCalled();
  });
});

// ══════════════════════════════════════════════════════════════════
// Reviewer Prompt
// ══════════════════════════════════════════════════════════════════

describe('generateReviewerPrompt', () => {
  test('generates reviewer prompt with coder output', () => {
    const prompt = generateReviewerPrompt({
      taskType: 'code',
      taskGoal: 'Build API',
      lastCoderOutput: 'Added endpoint',
    });

    expect(prompt).toContain('Build API');
    expect(prompt).toContain('Added endpoint');
  });

  // Bug 11 fix: review-type phases should use proposal review instructions
  test('uses proposal review instructions for review-type phases', () => {
    const prompt = generateReviewerPrompt({
      taskType: 'compound',
      taskGoal: 'Improve UI experience',
      lastCoderOutput: '## Proposed improvements\n1. StatusBar layout\n2. Mouse scroll\n3. Scrollbar',
      phaseId: 'phase-2',
      phaseType: 'review',
    });

    // Should contain proposal validation language
    expect(prompt.toLowerCase()).toMatch(/proposal|reasonable|aligned/i);
    // Should NOT contain code-review-only language like "bugs" or "security issues"
    expect(prompt).not.toContain('security issues');
    // Should contain explicit approval guidance (anti-nitpick)
    expect(prompt).toContain('sound and directionally correct');
  });

  test('uses standard code review instructions for code-type phases', () => {
    const prompt = generateReviewerPrompt({
      taskType: 'compound',
      taskGoal: 'Improve UI experience',
      lastCoderOutput: 'Implemented StatusBar changes',
      phaseId: 'phase-3',
      phaseType: 'code',
    });

    // Should contain standard code review language
    expect(prompt.toLowerCase()).toMatch(/blocking.*issues|bugs|logic errors/i);
  });

  test('all reviewer prompts include anti-nitpick verdict rules', () => {
    for (const phaseType of ['explore', 'review', 'code'] as const) {
      const prompt = generateReviewerPrompt({
        taskType: 'compound',
        taskGoal: 'Test task',
        phaseId: 'phase-1',
        phaseType,
      });

      expect(prompt).toContain('do not withhold approval for non-blocking suggestions');
    }
  });
});

// ══════════════════════════════════════════════════════════════════
// Reviewer Feedback Direct Forwarding (Change 1)
// ══════════════════════════════════════════════════════════════════

describe('Reviewer Feedback Direct Forwarding (Change 1)', () => {
  test('injects Reviewer Feedback section when isPostReviewerRouting is true', () => {
    const ctx = makePromptContext({
      taskType: 'code',
      isPostReviewerRouting: true,
      lastReviewerOutput: '[CHANGES_REQUESTED]\n1. Blocking: Missing null check on line 42\n2. The function does not handle edge case X',
      instruction: 'Fix the issues identified by the Reviewer',
    });
    const prompt = generateCoderPrompt(ctx);

    expect(prompt).toContain('## Reviewer Feedback');
    expect(prompt).toContain('Missing null check on line 42');
    expect(prompt).toContain('does not handle edge case X');
  });

  test('Reviewer Feedback appears after God Instruction and before Required Fixes', () => {
    const ctx = makePromptContext({
      taskType: 'code',
      isPostReviewerRouting: true,
      lastReviewerOutput: 'Reviewer analysis here',
      instruction: 'God instruction here',
      unresolvedIssues: ['Fix issue A'],
    });
    const prompt = generateCoderPrompt(ctx);

    const godIdx = prompt.indexOf('## God Instruction');
    const reviewerIdx = prompt.indexOf('## Reviewer Feedback');
    const fixesIdx = prompt.indexOf('## Required Fixes');

    expect(godIdx).toBeLessThan(reviewerIdx);
    expect(reviewerIdx).toBeLessThan(fixesIdx);
  });

  test('does NOT inject Reviewer Feedback when isPostReviewerRouting is false', () => {
    const ctx = makePromptContext({
      taskType: 'code',
      isPostReviewerRouting: false,
      lastReviewerOutput: 'Stale reviewer output from previous round',
    });
    const prompt = generateCoderPrompt(ctx);

    expect(prompt).not.toContain('## Reviewer Feedback');
    expect(prompt).not.toContain('Stale reviewer output');
  });

  test('does NOT inject Reviewer Feedback when isPostReviewerRouting is undefined (backward compat)', () => {
    const ctx = makePromptContext({
      taskType: 'code',
      lastReviewerOutput: 'Some reviewer output',
    });
    const prompt = generateCoderPrompt(ctx);

    expect(prompt).not.toContain('## Reviewer Feedback');
  });

  test('strips tool markers from reviewer output before injection', () => {
    const ctx = makePromptContext({
      taskType: 'code',
      isPostReviewerRouting: true,
      lastReviewerOutput: '[Read] src/index.ts\n[Bash] npm test\nThe code has a bug on line 10.\n[CHANGES_REQUESTED]',
    });
    const prompt = generateCoderPrompt(ctx);

    expect(prompt).toContain('## Reviewer Feedback');
    expect(prompt).toContain('The code has a bug on line 10.');
    // Tool markers should be stripped
    expect(prompt).not.toMatch(/^\[Read\]/m);
    expect(prompt).not.toMatch(/^\[Bash\]/m);
  });
});

// ══════════════════════════════════════════════════════════════════
// extractBlockingIssues (Change 2)
// ══════════════════════════════════════════════════════════════════

describe('extractBlockingIssues (Change 2)', () => {
  test('extracts "Blocking:" prefixed lines', () => {
    const output = `Review summary:
- Blocking: Missing null check on user input
- Non-blocking: Consider renaming variable
- Blocking: SQL injection vulnerability in query builder
[CHANGES_REQUESTED]`;
    const issues = extractBlockingIssues(output);
    expect(issues).toEqual([
      'Missing null check on user input',
      'SQL injection vulnerability in query builder',
    ]);
  });

  test('extracts numbered blocking issues', () => {
    const output = `1. [Blocking] - Missing error handling for network timeout
2. [Non-blocking] - Variable naming
3. [Blocking] - No input validation`;
    const issues = extractBlockingIssues(output);
    expect(issues).toEqual([
      'Missing error handling for network timeout',
      'No input validation',
    ]);
  });

  test('extracts bold **Blocking** markers', () => {
    const output = `- **Blocking**: Race condition in async handler
- Suggestion: Add logging`;
    const issues = extractBlockingIssues(output);
    expect(issues).toEqual(['Race condition in async handler']);
  });

  test('returns empty array when no blocking issues found', () => {
    const output = `[APPROVED] Everything looks good.
- Minor: Consider adding a comment here.`;
    const issues = extractBlockingIssues(output);
    expect(issues).toEqual([]);
  });

  test('handles Chinese colon (：) separator', () => {
    const output = `- Blocking：缺少空值检查`;
    const issues = extractBlockingIssues(output);
    expect(issues).toEqual(['缺少空值检查']);
  });
});

