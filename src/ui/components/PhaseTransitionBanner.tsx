/**
 * PhaseTransitionBanner — TUI banner for compound task phase transition.
 * Card C.3: FR-010 (AC-033, AC-034)
 *
 * Shows a 2-second escape window when God triggers a phase transition.
 * [Space] = immediate confirm, [Esc] = cancel and stay in current phase.
 * Uses pure state functions from phase-transition-banner.ts.
 */

import React, { useState, useEffect, useRef } from 'react';
import { Text, useInput, useStdout } from '../../tui/primitives.js';
import {
  createPhaseTransitionBannerState,
  handlePhaseTransitionKeyPress,
  tickPhaseTransitionCountdown,
  PHASE_ESCAPE_WINDOW_MS,
  PHASE_TICK_INTERVAL_MS,
  type PhaseTransitionBannerState,
} from '../phase-transition-banner.js';
import { computeOverlaySurfaceWidth } from '../screen-shell-layout.js';
import { CenteredContent, Column, FooterHint, Panel, Row, SectionTitle } from '../tui-layout.js';

export interface PhaseTransitionBannerProps {
  nextPhaseId: string;
  previousPhaseSummary: string;
  onConfirm: () => void;
  onCancel: () => void;
}

export function PhaseTransitionBanner({
  nextPhaseId,
  previousPhaseSummary,
  onConfirm,
  onCancel,
}: PhaseTransitionBannerProps): React.ReactElement {
  const { stdout } = useStdout();
  const panelWidth = computeOverlaySurfaceWidth(stdout.columns || 80);
  const [state, setState] = useState<PhaseTransitionBannerState>(() =>
    createPhaseTransitionBannerState(nextPhaseId, previousPhaseSummary),
  );
  const firedRef = useRef(false);

  // Countdown timer (100ms ticks for smooth progress bar)
  useEffect(() => {
    if (state.cancelled || state.confirmed) return;

    const timer = setInterval(() => {
      setState((prev) => tickPhaseTransitionCountdown(prev));
    }, PHASE_TICK_INTERVAL_MS);

    return () => clearInterval(timer);
  }, [state.cancelled, state.confirmed]);

  // Fire callbacks when state terminal
  useEffect(() => {
    if (firedRef.current) return;

    if (state.confirmed) {
      firedRef.current = true;
      onConfirm();
    } else if (state.cancelled) {
      firedRef.current = true;
      onCancel();
    }
  }, [state.confirmed, state.cancelled]);

  // Keyboard: Space = confirm, Esc = cancel
  useInput((_input, key) => {
    if (state.cancelled || state.confirmed) return;

    if (_input === ' ') {
      setState((prev) => handlePhaseTransitionKeyPress(prev, 'space'));
    } else if (key.escape) {
      setState((prev) => handlePhaseTransitionKeyPress(prev, 'escape'));
    }
  });

  // Progress bar
  const progress = state.countdown / PHASE_ESCAPE_WINDOW_MS;
  const BAR_WIDTH = 20;
  const filled = Math.round(progress * BAR_WIDTH);
  const bar = '█'.repeat(filled) + '░'.repeat(BAR_WIDTH - filled);
  const secondsLeft = (state.countdown / 1000).toFixed(1);

  return (
    <CenteredContent width={panelWidth} height="100%" justifyContent="center">
      <Panel tone="section" width={panelWidth} borderColor="magenta" paddingX={2}>
        <Row>
          <SectionTitle title="Phase Transition" tone="hero" />
          <Text>  → {nextPhaseId}</Text>
        </Row>

        {previousPhaseSummary && (
          <Row marginTop={1}>
            <Text dimColor>{previousPhaseSummary.slice(0, 120)}</Text>
          </Row>
        )}

        <Row marginTop={1}>
          <Text color="magenta">{bar}</Text>
          <Text>  {secondsLeft}s</Text>
        </Row>

        <Row marginTop={1}>
          <FooterHint text="[Space] confirm transition   [Esc] stay in current phase" />
        </Row>
      </Panel>
    </CenteredContent>
  );
}
