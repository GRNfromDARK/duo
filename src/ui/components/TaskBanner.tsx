/**
 * TaskBanner — Persistent task goal display below the status bar.
 * Shows the user's original task/request so it's always visible during execution.
 */

import React from 'react';
import { Text } from '../../tui/primitives.js';
import { buildTaskBannerLayout } from '../task-banner-layout.js';
import { Row } from '../tui-layout.js';

export interface TaskBannerProps {
  taskSummary: string;
  columns: number;
  contentWidth?: number;
}

export function TaskBanner({
  taskSummary,
  columns,
  contentWidth,
}: TaskBannerProps): React.ReactElement {
  const layout = buildTaskBannerLayout({ taskSummary, columns });
  const innerWidth = contentWidth ?? columns;

  return (
    <Row height={1} width={columns} justifyContent="center">
      <Row width={innerWidth}>
        <Text color="cyan" bold>▸</Text>
        <Text dimColor>{' Task '}</Text>
        <Text dimColor>{'· '}</Text>
        <Text color="white">{layout.displayText}</Text>
      </Row>
    </Row>
  );
}
