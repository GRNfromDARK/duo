import React, { useState, useEffect, useRef } from 'react';
import { Box, Text, useInput, useStdin } from 'ink';
import { InputArea } from './InputArea.js';
import { ScrollIndicator } from './ScrollIndicator.js';
import { StatusBar, type WorkflowStatus } from './StatusBar.js';
import { TaskBanner } from './TaskBanner.js';
import { ThinkingIndicator, shouldShowThinking } from './ThinkingIndicator.js';
import { HelpOverlay } from './HelpOverlay.js';
import { ContextOverlay } from './ContextOverlay.js';
import { TimelineOverlay, type TimelineEvent } from './TimelineOverlay.js';
import { SearchOverlay } from './SearchOverlay.js';
import {
  INITIAL_SCROLL_STATE,
  computeScrollView,
  scrollUp,
  scrollDown,
  jumpToEnd,
} from '../scroll-state.js';
import type { ScrollState } from '../scroll-state.js';
import type { Message } from '../../types/ui.js';
import { type DisplayMode, toggleDisplayMode, filterMessages } from '../display-mode.js';
import { processKeybinding, type KeyAction } from '../keybindings.js';
import {
  INITIAL_OVERLAY_STATE,
  openOverlay,
  closeOverlay,
  updateSearchQuery,
  computeSearchResults,
  type OverlayState,
} from '../overlay-state.js';
import { buildRenderedMessageLines, type RenderedMessageLine } from '../message-lines.js';

export interface MainLayoutProps {
  messages: Message[];
  /** @deprecated Use statusBarProps instead for structured status bar */
  statusText?: string;
  columns: number;
  rows: number;
  isLLMRunning?: boolean;
  onInputSubmit?: (text: string) => void;
  onNewSession?: () => void;
  onInterrupt?: () => void;
  onClearScreen?: () => void;
  onReclassify?: () => void;
  /** Structured status bar props */
  statusBarProps?: {
    projectPath: string;
    round: number;
    maxRounds: number;
    status: WorkflowStatus;
    activeAgent: string | null;
    tokenCount: number;
    taskType?: string;
    currentPhase?: string;
    godAdapter?: string;
    reviewerAdapter?: string;
    degradationLevel?: string;
    godLatency?: number;
  };
  /** Context overlay data */
  contextData?: {
    roundNumber: number;
    coderName: string;
    reviewerName: string;
    taskSummary: string;
    tokenEstimate: number;
  };
  /** Timeline events */
  timelineEvents?: TimelineEvent[];
  footer?: React.ReactNode;
  footerHeight?: number;
  suspendGlobalKeys?: boolean;
}

const STATUS_BAR_HEIGHT = 1;
const TASK_BANNER_HEIGHT = 1;
const INPUT_AREA_HEIGHT = 3;
const SEPARATOR_LINES = 2; // two separator lines
const MOUSE_SCROLL_LINES = 3; // lines per mouse wheel tick

// Module-level mouse mode tracking to avoid duplicate exit listeners
let mouseModeEnabled = false;
function disableMouseMode(): void {
  if (!mouseModeEnabled) return;
  mouseModeEnabled = false;
  process.stdout.write('\x1b[?1000l');
  process.stdout.write('\x1b[?1006l');
}

/**
 * Build a single-column text scrollbar track.
 * Returns an array of single-character strings, one per row.
 */
function buildScrollTrack(
  trackHeight: number,
  totalLines: number,
  effectiveOffset: number,
  visibleSlots: number,
): string[] {
  if (totalLines <= visibleSlots || trackHeight <= 0) return [];

  const thumbSize = Math.max(1, Math.round((visibleSlots / totalLines) * trackHeight));
  const maxOffset = totalLines - visibleSlots;
  const thumbPos = maxOffset > 0
    ? Math.round((effectiveOffset / maxOffset) * (trackHeight - thumbSize))
    : 0;

  const track: string[] = [];
  for (let i = 0; i < trackHeight; i++) {
    if (i >= thumbPos && i < thumbPos + thumbSize) {
      track.push('█');
    } else {
      track.push('┃');
    }
  }
  return track;
}

export function MainLayout({
  messages,
  statusText,
  columns,
  rows,
  isLLMRunning = false,
  onInputSubmit,
  onNewSession,
  onInterrupt,
  onClearScreen,
  onReclassify,
  statusBarProps,
  contextData,
  timelineEvents = [],
  footer,
  footerHeight,
  suspendGlobalKeys = false,
}: MainLayoutProps): React.ReactElement {
  const activeFooterHeight = footer ? (footerHeight ?? INPUT_AREA_HEIGHT) : INPUT_AREA_HEIGHT;
  const hasTaskBanner = Boolean(contextData?.taskSummary);
  const bannerHeight = hasTaskBanner ? TASK_BANNER_HEIGHT : 0;
  const messageAreaHeight = Math.max(
    1,
    rows - STATUS_BAR_HEIGHT - bannerHeight - activeFooterHeight - SEPARATOR_LINES,
  );

  const [scrollState, setScrollState] = useState<ScrollState>(INITIAL_SCROLL_STATE);
  const [displayMode, setDisplayMode] = useState<DisplayMode>('minimal');
  const [overlayState, setOverlayState] = useState<OverlayState>(INITIAL_OVERLAY_STATE);
  const [inputEmpty, setInputEmpty] = useState(true);
  const [clearedCount, setClearedCount] = useState(0);

  // ── Compute visible messages and lines ──
  const filteredMessages = filterMessages(messages, displayMode);
  const visibleFilteredMessages = filteredMessages.slice(clearedCount);
  const renderedLines = buildRenderedMessageLines(
    visibleFilteredMessages,
    displayMode,
    columns,
  );
  const totalLines = renderedLines.length;
  const { effectiveOffset, visibleSlots, showIndicator, newMessageCount } = computeScrollView(
    scrollState,
    totalLines,
    messageAreaHeight,
  );

  const visibleLines = renderedLines.slice(
    effectiveOffset,
    effectiveOffset + visibleSlots,
  );

  // ── Thinking indicator: LLM running but no assistant output yet ──
  const isThinking = shouldShowThinking(isLLMRunning, visibleFilteredMessages);

  // ── Scroll position indicator (scrollbar) ──
  const needsScrollbar = totalLines > visibleSlots;
  const scrollTrack = needsScrollbar
    ? buildScrollTrack(messageAreaHeight, totalLines, effectiveOffset, visibleSlots)
    : [];

  // ── Mouse scroll support ──
  // Use refs to avoid stale closures in the stdin data handler
  const scrollParamsRef = useRef({ totalLines, messageAreaHeight });
  scrollParamsRef.current = { totalLines, messageAreaHeight };

  const { stdin } = useStdin();

  useEffect(() => {
    if (!stdin) return;

    const handleMouseData = (data: Buffer): void => {
      const str = data.toString('utf-8');
      const { totalLines: tl, messageAreaHeight: mah } = scrollParamsRef.current;

      // Parse SGR mouse sequences: \x1b[<button;col;rowM or \x1b[<button;col;rowm
      const sgrMatch = str.match(/\x1b\[<(\d+);\d+;\d+[Mm]/);
      if (sgrMatch) {
        const button = parseInt(sgrMatch[1]!, 10);
        if (button === 64) {
          setScrollState((s) => scrollUp(s, MOUSE_SCROLL_LINES, tl, mah));
        } else if (button === 65) {
          setScrollState((s) => scrollDown(s, MOUSE_SCROLL_LINES, tl, mah));
        }
        return;
      }
      // Parse legacy X10/normal mouse sequences: \x1b[M + 3 bytes
      const legacyMatch = str.match(/\x1b\[M(.)/);
      if (legacyMatch) {
        const cb = legacyMatch[1]!.charCodeAt(0) - 32;
        if (cb === 64) {
          setScrollState((s) => scrollUp(s, MOUSE_SCROLL_LINES, tl, mah));
        } else if (cb === 65) {
          setScrollState((s) => scrollDown(s, MOUSE_SCROLL_LINES, tl, mah));
        }
      }
    };

    // Enable SGR mouse mode (one global exit handler)
    if (!mouseModeEnabled) {
      mouseModeEnabled = true;
      process.stdout.write('\x1b[?1000h');
      process.stdout.write('\x1b[?1006h');
      process.on('exit', disableMouseMode);
    }

    stdin.on('data', handleMouseData);

    return () => {
      stdin.off('data', handleMouseData);
      disableMouseMode();
      process.off('exit', disableMouseMode);
    };
  }, [stdin]); // Only re-run when stdin changes

  const searchResults = overlayState.activeOverlay === 'search'
    ? computeSearchResults(messages, overlayState.searchQuery)
    : [];

  function handleAction(action: KeyAction): void {
    switch (action.type) {
      case 'scroll_up':
        setScrollState((s) => scrollUp(s, action.amount, totalLines, messageAreaHeight));
        break;
      case 'scroll_down':
        setScrollState((s) => scrollDown(s, action.amount, totalLines, messageAreaHeight));
        break;
      case 'jump_to_end':
        setScrollState(() => jumpToEnd(totalLines, messageAreaHeight));
        break;
      case 'toggle_display_mode':
        setDisplayMode((m) => toggleDisplayMode(m));
        break;
      case 'open_overlay':
        setOverlayState((s) => openOverlay(s, action.overlay));
        break;
      case 'close_overlay':
        setOverlayState((s) => closeOverlay(s));
        break;
      case 'clear_screen':
        setClearedCount(filteredMessages.length);
        setScrollState(INITIAL_SCROLL_STATE);
        onClearScreen?.();
        break;
      case 'new_session':
        onNewSession?.();
        break;
      case 'interrupt':
        onInterrupt?.();
        break;
      case 'reclassify':
        onReclassify?.();
        break;
      case 'toggle_code_block':
        break;
      case 'tab_complete':
        break;
      case 'noop':
        break;
    }
  }

  useInput((input, key) => {
    if (suspendGlobalKeys) return;
    const action = processKeybinding(input, key, {
      overlayOpen: overlayState.activeOverlay,
      inputEmpty,
      pageSize: messageAreaHeight,
    });
    handleAction(action);

    // Search overlay: route text input to search query
    if (overlayState.activeOverlay === 'search' && !key.ctrl && !key.escape) {
      if (key.backspace || key.delete) {
        setOverlayState((s) => updateSearchQuery(s, s.searchQuery.slice(0, -1)));
      } else if (input && !key.return && !key.tab && input !== '/') {
        setOverlayState((s) => updateSearchQuery(s, s.searchQuery + input));
      }
    }
  });

  const hasOverlay = overlayState.activeOverlay !== null;

  // Scroll position text for the separator line (e.g., "L45/120")
  const scrollPosText = needsScrollbar
    ? ` L${effectiveOffset + 1}/${totalLines} `
    : '';

  return (
    <Box flexDirection="column" width={columns} height={rows}>
      {hasOverlay ? (
        // Render overlay full-screen
        <>
          {overlayState.activeOverlay === 'help' && (
            <HelpOverlay columns={columns} rows={rows} />
          )}
          {overlayState.activeOverlay === 'context' && contextData && (
            <ContextOverlay
              columns={columns}
              rows={rows}
              {...contextData}
            />
          )}
          {overlayState.activeOverlay === 'timeline' && (
            <TimelineOverlay
              columns={columns}
              rows={rows}
              events={timelineEvents}
            />
          )}
          {overlayState.activeOverlay === 'search' && (
            <SearchOverlay
              columns={columns}
              rows={rows}
              query={overlayState.searchQuery}
              results={searchResults}
            />
          )}
        </>
      ) : (
        // Normal layout
        <>
          {/* Status Bar */}
          {statusBarProps ? (
            <StatusBar
              projectPath={statusBarProps.projectPath}
              round={statusBarProps.round}
              maxRounds={statusBarProps.maxRounds}
              status={statusBarProps.status}
              activeAgent={statusBarProps.activeAgent}
              tokenCount={statusBarProps.tokenCount}
              columns={columns}
              taskType={statusBarProps.taskType}
              currentPhase={statusBarProps.currentPhase}
              godAdapter={statusBarProps.godAdapter}
              reviewerAdapter={statusBarProps.reviewerAdapter}
              degradationLevel={statusBarProps.degradationLevel}
              godLatency={statusBarProps.godLatency}
            />
          ) : (
            <Box height={STATUS_BAR_HEIGHT}>
              <Text inverse bold> {statusText ?? ''} </Text>
            </Box>
          )}

          {/* Task Banner — persistent task goal display */}
          {hasTaskBanner && (
            <TaskBanner
              taskSummary={contextData!.taskSummary}
              columns={columns}
            />
          )}

          {/* Separator with scroll position */}
          <Box height={1}>
            <Text dimColor>
              {'─'.repeat(Math.max(0, columns - scrollPosText.length))}
            </Text>
            {scrollPosText && (
              <Text color="gray">{scrollPosText}</Text>
            )}
          </Box>

          {/* Message Area with optional scrollbar */}
          <Box flexDirection="row" height={messageAreaHeight} overflow="hidden">
            {/* Messages */}
            <Box flexDirection="column" width={needsScrollbar ? columns - 1 : columns} overflow="hidden">
              {visibleLines.map((line) => (
                <RenderedLineView key={line.key} line={line} />
              ))}
              {isThinking && (
                <ThinkingIndicator columns={needsScrollbar ? columns - 1 : columns} />
              )}
              <ScrollIndicator visible={showIndicator} columns={needsScrollbar ? columns - 1 : columns} newMessageCount={newMessageCount} />
            </Box>

            {/* Scrollbar track */}
            {needsScrollbar && (
              <Box flexDirection="column" width={1}>
                {scrollTrack.map((ch, i) => (
                  <Text key={i} color={ch === '█' ? 'cyan' : undefined} dimColor={ch !== '█'}>
                    {ch}
                  </Text>
                ))}
              </Box>
            )}
          </Box>

          {/* Separator */}
          <Box height={1}>
            <Text dimColor>{'─'.repeat(columns)}</Text>
          </Box>

          {/* Input Area — InputArea is fully uncontrolled (manages its own value/cursor state).
             We only observe emptiness via onValueChange for keybinding routing (j/k scroll
             only activates when input is empty). No `value` prop exists on InputArea. */}
          {footer ? (
            <Box flexDirection="column" height={activeFooterHeight} overflow="hidden">
              {footer}
            </Box>
          ) : (
            <InputArea
              isLLMRunning={isLLMRunning}
              onSubmit={onInputSubmit ?? (() => {})}
              onValueChange={(v) => setInputEmpty(v === '')}
              onSpecialKey={(k) => {
                if (k === '?') setOverlayState((s) => openOverlay(s, 'help'));
                if (k === '/') setOverlayState((s) => openOverlay(s, 'search'));
              }}
              disabled={hasOverlay}
            />
          )}
        </>
      )}
    </Box>
  );
}

function RenderedLineView({ line }: { line: RenderedMessageLine }): React.ReactElement {
  return (
    <Box>
      {line.spans.map((span, index) => (
        <Text
          key={index}
          color={span.color}
          bold={span.bold}
          dimColor={span.dimColor}
        >
          {span.text}
        </Text>
      ))}
    </Box>
  );
}
