/**
 * ReclassifyOverlay — TUI overlay for runtime task reclassification.
 * Card C.3: FR-002a (AC-010, AC-011, AC-012)
 *
 * Full-screen overlay: user selects a new task type via arrow keys / number keys.
 * Uses pure state functions from reclassify-overlay.ts.
 */

import React, { useState } from 'react';
import { Text, useInput, useStdout } from '../../tui/primitives.js';
import type { TaskType } from '../task-analysis-card.js';
import {
  createReclassifyState,
  handleReclassifyKey,
  type ReclassifyOverlayState,
} from '../reclassify-overlay.js';
import { computeOverlaySurfaceWidth } from '../screen-shell-layout.js';
import { CenteredContent, Column, FooterHint, LabelValueRow, Panel, Row, SectionTitle, SelectionRow } from '../tui-layout.js';

export interface ReclassifyOverlayProps {
  currentType: string;
  onSelect: (newType: string) => void;
  onCancel: () => void;
}

/** Human-readable descriptions for each task type */
const RECLASSIFY_LABELS: Record<string, string> = {
  explore: 'Explore first, then code',
  code: 'Direct coding implementation',
  review: 'Code review only',
  debug: 'Focused debugging',
};

export function ReclassifyOverlay({
  currentType,
  onSelect,
  onCancel,
}: ReclassifyOverlayProps): React.ReactElement {
  const { stdout } = useStdout();
  const panelWidth = computeOverlaySurfaceWidth(stdout.columns || 80);
  const [state, setState] = useState<ReclassifyOverlayState>(() =>
    createReclassifyState(currentType as TaskType),
  );

  useInput((input, key) => {
    if (state.visible === false) return;

    let keyStr: string;
    if (key.downArrow) keyStr = 'arrow_down';
    else if (key.upArrow) keyStr = 'arrow_up';
    else if (key.return) keyStr = 'enter';
    else if (key.escape) keyStr = 'escape';
    else keyStr = input;

    const { state: next, action } = handleReclassifyKey(state, keyStr);
    setState(next);

    if (action === 'confirm') {
      onSelect(next.selectedType);
    } else if (action === 'cancel') {
      onCancel();
    }
  });

  return (
    <CenteredContent width={panelWidth} height="100%" justifyContent="center">
      <Panel tone="overlay" width={panelWidth} paddingX={2}>
        <Row justifyContent="center">
          <SectionTitle title="Reclassify Task" tone="hero" />
        </Row>

        <Column marginTop={1}>
          <LabelValueRow
            label="Current"
            value={<>
              <Text bold>[{currentType}]</Text>
              <Text dimColor>{`  ${RECLASSIFY_LABELS[currentType] ?? ''}`}</Text>
            </>}
            labelWidth={10}
          />
        </Column>

        <Column marginTop={1}>
          {state.availableTypes.map((type, i) => {
            const isCurrent = type === currentType;
            return (
              <Row key={type}>
                <SelectionRow
                  label={`[${i + 1}] ${type.padEnd(10)}`}
                  selected={state.selectedType === type}
                />
                <Text dimColor>{` ${RECLASSIFY_LABELS[type] ?? ''}`}</Text>
                {isCurrent && <Text color="yellow">{' ← current'}</Text>}
              </Row>
            );
          })}
        </Column>

        <Row marginTop={1}>
          <FooterHint text="[↑↓] select   [Enter] confirm   [Esc] cancel" />
        </Row>
      </Panel>
    </CenteredContent>
  );
}
