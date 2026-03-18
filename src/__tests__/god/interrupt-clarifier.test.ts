import { describe, expect, it } from 'vitest';

import {
  classifyInterruptIntent,
  type InterruptClassification,
} from '../../god/interrupt-clarifier.js';

function makeAdapter(payload: InterruptClassification) {
  return {
    name: 'claude-code',
    execute: async function* () {
      yield {
        type: 'text',
        content: `\`\`\`json\n${JSON.stringify(payload)}\n\`\`\``,
        timestamp: Date.now(),
      };
    },
    kill: async () => {},
    isRunning: () => false,
  } as any;
}

describe('classifyInterruptIntent', () => {
  it('classifies restart intent as a soft restart of the current attempt', async () => {
    const result = await classifyInterruptIntent(makeAdapter({
      intent: 'restart',
      instruction: 'Discard the current approach and restart the attempt with Zustand.',
      reasoning: 'The user wants to change approach completely.',
      needsClarification: false,
    }), {
      userInput: '重新开始，用 Zustand',
      taskGoal: 'build login feature',
      sessionDir: '/tmp/test',
      seq: 1,
    });

    expect(result.intent).toBe('restart');
  });

  it('classifies redirect intent', async () => {
    const result = await classifyInterruptIntent(makeAdapter({
      intent: 'redirect',
      instruction: 'Keep current progress but switch the state layer to Zustand.',
      reasoning: 'The user is redirecting the implementation.',
      needsClarification: false,
    }), {
      userInput: '不要用 Redux，改用 Zustand',
      taskGoal: 'build state management',
      sessionDir: '/tmp/test',
      seq: 1,
    });

    expect(result.intent).toBe('redirect');
  });

  it('classifies continue intent', async () => {
    const result = await classifyInterruptIntent(makeAdapter({
      intent: 'continue',
      instruction: 'Continue, but handle the failing test first.',
      reasoning: 'The user wants a small tactical adjustment.',
      needsClarification: false,
    }), {
      userInput: '继续，但是先处理错误',
      taskGoal: 'fix bugs',
      sessionDir: '/tmp/test',
      seq: 1,
    });

    expect(result.intent).toBe('continue');
  });
});
