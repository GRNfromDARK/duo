/**
 * TaskAnalysisCard — TUI card for displaying God's task analysis result.
 * Card A.3: FR-001a (AC-004, AC-005, AC-006, AC-007)
 *
 * Renders a bordered card with task type selection, countdown timer,
 * and keyboard interaction. Uses pure state functions from task-analysis-card.ts.
 */

import React, { useState, useEffect, useRef } from 'react';
import { Text, useInput, useStdout } from '../../tui/primitives.js';
import type { GodTaskAnalysis } from '../../types/god-schemas.js';
import {
  createTaskAnalysisCardState,
  handleKeyPress,
  tickCountdown,
  TASK_TYPE_LIST,
  type TaskAnalysisCardState,
  type TaskType,
} from '../task-analysis-card.js';
import { computeOverlaySurfaceWidth } from '../screen-shell-layout.js';
import { CenteredContent, Column, FooterHint, Panel, Row, SectionTitle, SelectionRow } from '../tui-layout.js';

export interface TaskAnalysisCardProps {
  analysis: GodTaskAnalysis;
  onConfirm: (taskType: string) => void;
  onTimeout: () => void;
}

/** Detect if text contains CJK characters (Chinese/Japanese/Korean) */
function isCJK(text: string): boolean {
  return /[\u4e00-\u9fff\u3040-\u30ff\uac00-\ud7af]/.test(text);
}

/** Human-readable descriptions for each task type */
const TASK_TYPE_LABELS_EN: Record<TaskType, string> = {
  explore: 'Explore first, then code',
  code: 'Direct coding implementation',
  discuss: 'Discussion and planning',
  review: 'Code review only',
  debug: 'Focused debugging',
  compound: 'Multi-phase compound task',
};

const TASK_TYPE_LABELS_ZH: Record<TaskType, string> = {
  explore: '先探索，再编码',
  code: '直接编码实现',
  discuss: '讨论与规划',
  review: '仅代码审查',
  debug: '专项调试',
  compound: '多阶段复合任务',
};

interface I18nStrings {
  header: string;
  confirmed: string;
  paused: string;
  autoStart: (s: number) => string;
  task: string;
  confidence: string;
  criteria: string;
  recommended: string;
  hints: (n: number) => string;
  labels: Record<TaskType, string>;
}

const EN: I18nStrings = {
  header: '◈ TASK ANALYSIS',
  confirmed: 'confirmed',
  paused: 'paused',
  autoStart: (s) => `auto-start: ${s}s`,
  task: 'Task  ',
  confidence: 'Confidence',
  criteria: 'Criteria',
  recommended: '★ recommended',
  hints: (n) => `[↑↓] select  [Enter] confirm  [Space] use recommended  [1-${n}] quick select`,
  labels: TASK_TYPE_LABELS_EN,
};

const ZH: I18nStrings = {
  header: '◈ 任务分析',
  confirmed: '已确认',
  paused: '已暂停',
  autoStart: (s) => `自动开始: ${s}s`,
  task: '任务  ',
  confidence: '置信度',
  criteria: '完成条件',
  recommended: '★ 推荐',
  hints: (n) => `[↑↓] 选择  [Enter] 确认  [Space] 使用推荐  [1-${n}] 快速选择`,
  labels: TASK_TYPE_LABELS_ZH,
};

export function TaskAnalysisCard({
  analysis,
  onConfirm,
  onTimeout,
}: TaskAnalysisCardProps): React.ReactElement {
  const { stdout } = useStdout();
  const panelWidth = computeOverlaySurfaceWidth(stdout.columns || 80);
  const [state, setState] = useState<TaskAnalysisCardState>(() =>
    createTaskAnalysisCardState(analysis),
  );
  const confirmedRef = useRef(false);

  // 1-second countdown timer (AC-005)
  useEffect(() => {
    if (state.confirmed || state.countdownPaused) return;

    const timer = setInterval(() => {
      setState((prev) => tickCountdown(prev));
    }, 1000);

    return () => clearInterval(timer);
  }, [state.confirmed, state.countdownPaused]);

  // Fire callbacks when confirmed
  useEffect(() => {
    if (!state.confirmed || confirmedRef.current) return;
    confirmedRef.current = true;

    if (state.countdown <= 0) {
      onTimeout();
    }
    onConfirm(state.selectedType);
  }, [state.confirmed]);

  // Keyboard input (AC-006, AC-007)
  useInput((input, key) => {
    if (state.confirmed) return;

    if (key.downArrow) {
      setState((prev) => handleKeyPress(prev, 'arrow_down'));
    } else if (key.upArrow) {
      setState((prev) => handleKeyPress(prev, 'arrow_up'));
    } else if (key.return) {
      setState((prev) => handleKeyPress(prev, 'enter'));
    } else if (input === ' ') {
      setState((prev) => handleKeyPress(prev, 'space'));
    } else if (input >= '1' && input <= '9') {
      setState((prev) => handleKeyPress(prev, input));
    }
  });

  const recommended = analysis.taskType;
  const t = isCJK(analysis.reasoning) ? ZH : EN;

  return (
    <CenteredContent width={panelWidth} height="100%" justifyContent="center">
      <Panel tone="overlay" width={panelWidth} paddingX={2}>
        <Row justifyContent="space-between">
          <SectionTitle title={t.header} tone="hero" />
          <Text color={state.countdownPaused ? 'yellow' : 'cyan'}>
            {state.confirmed
              ? t.confirmed
              : state.countdownPaused
                ? t.paused
                : t.autoStart(state.countdown)}
          </Text>
        </Row>

        <Row marginTop={1}>
          <Text dimColor>{t.task}</Text>
          <Text>&quot;{analysis.reasoning.slice(0, 60)}{analysis.reasoning.length > 60 ? '…' : ''}&quot;</Text>
        </Row>

        <Column marginTop={1}>
          {TASK_TYPE_LIST.map((type, i) => {
            const isRecommended = type === recommended;
            return (
              <Row key={type}>
                <SelectionRow
                  label={`[${i + 1}] ${type.padEnd(10)}`}
                  selected={state.selectedType === type}
                />
                <Text dimColor>{t.labels[type]}</Text>
                {isRecommended && <Text color="yellow"> {t.recommended}</Text>}
              </Row>
            );
          })}
        </Column>

        <Row marginTop={1}>
          <Text dimColor>{t.confidence}: {Math.round(analysis.confidence * 100)}%</Text>
        </Row>

        <Row marginTop={1}>
          <FooterHint text={t.hints(Math.min(TASK_TYPE_LIST.length, 9))} />
        </Row>
      </Panel>
    </CenteredContent>
  );
}
