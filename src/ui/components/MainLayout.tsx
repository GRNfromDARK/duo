import React, { useRef, useState } from 'react';
import { Box, ScrollBox, Text, useInput } from '../../tui/primitives.js';
import { InputArea } from './InputArea.js';
import { StatusBar, type WorkflowStatus } from './StatusBar.js';
import { TaskBanner } from './TaskBanner.js';
import { MessageView } from './MessageView.js';
import { ThinkingIndicator, shouldShowThinking } from './ThinkingIndicator.js';
import { HelpOverlay } from './HelpOverlay.js';
import { ContextOverlay } from './ContextOverlay.js';
import { TimelineOverlay, type TimelineEvent } from './TimelineOverlay.js';
import { SearchOverlay } from './SearchOverlay.js';
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
import { computeSessionContentWidth } from '../screen-shell-layout.js';
import { CenteredContent, Column, Divider, Row } from '../tui-layout.js';

export type WorkflowStateHint =
  | { phase: 'idle' }
  | { phase: 'llm_running' }
  | { phase: 'task_init' }
  | { phase: 'god_deciding' }
  | { phase: 'god_convergence' }
  | { phase: 'observing' }
  | { phase: 'executing' }
  | { phase: 'classifying_intent' }
  | { phase: 'done' };

export interface MainLayoutProps {
  messages: Message[];
  statusText?: string;
  columns: number;
  rows: number;
  isLLMRunning?: boolean;
  workflowState?: WorkflowStateHint;
  onInputSubmit?: (text: string) => void;
  onNewSession?: () => void;
  onInterrupt?: () => void;
  onClearScreen?: () => void;
  onReclassify?: () => void;
  statusBarProps?: {
    projectPath: string;
    status: WorkflowStatus;
    activeAgent: string | null;
    tokenCount: number;
    taskType?: string;
    currentPhase?: string;
    godAdapter?: string;
    reviewerAdapter?: string;
    coderModel?: string;
    reviewerModel?: string;
    godLatency?: number;
  };
  contextData?: {
    coderName: string;
    reviewerName: string;
    taskSummary: string;
    tokenEstimate: number;
  };
  timelineEvents?: TimelineEvent[];
  footer?: React.ReactNode;
  footerHeight?: number;
  suspendGlobalKeys?: boolean;
}

const STATUS_BAR_HEIGHT = 1;
const TASK_BANNER_HEIGHT = 1;
const INPUT_AREA_HEIGHT = 3;
const HEADER_SEPARATOR_LINES = 1;
const FOOTER_SEPARATOR_HEIGHT = 1;

function resolveIndicatorConfig(
  workflowState: WorkflowStateHint | undefined,
  isLLMRunning: boolean,
  messages: Message[],
): { message: string; color: string; showElapsed: boolean } | null {
  if (!workflowState) {
    return null;
  }

  switch (workflowState.phase) {
    case 'task_init':
      return { message: 'Analyzing task...', color: 'yellow', showElapsed: true };
    case 'god_deciding':
      return { message: 'God deciding next step...', color: 'yellow', showElapsed: true };
    case 'god_convergence':
      return { message: 'Evaluating convergence...', color: 'yellow', showElapsed: true };
    case 'classifying_intent':
      return { message: 'Understanding your input...', color: 'yellow', showElapsed: true };
    case 'observing':
      return { message: 'Analyzing output...', color: 'yellow', showElapsed: false };
    case 'executing':
      return { message: 'Executing actions...', color: 'yellow', showElapsed: false };
    case 'llm_running':
      return shouldShowThinking(isLLMRunning, messages)
        ? { message: 'Thinking...', color: 'cyan', showElapsed: false }
        : null;
    default:
      return null;
  }
}

export function MainLayout({
  messages,
  statusText,
  columns,
  rows,
  isLLMRunning = false,
  workflowState,
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
    rows - STATUS_BAR_HEIGHT - bannerHeight - activeFooterHeight - HEADER_SEPARATOR_LINES,
  );
  const footerBodyHeight = Math.max(1, activeFooterHeight - FOOTER_SEPARATOR_HEIGHT);
  const separatorWidth = Math.max(1, columns - 2);
  const sessionContentWidth = computeSessionContentWidth(columns);

  const scrollRef = useRef<any>(null);
  const [displayMode, setDisplayMode] = useState<DisplayMode>('minimal');
  const [overlayState, setOverlayState] = useState<OverlayState>(INITIAL_OVERLAY_STATE);
  const [inputEmpty, setInputEmpty] = useState(true);
  const [clearedCount, setClearedCount] = useState(0);

  const filteredMessages = filterMessages(messages, displayMode);
  const visibleMessages = filteredMessages.slice(clearedCount);
  const indicatorConfig = resolveIndicatorConfig(workflowState, isLLMRunning, visibleMessages);
  const isThinking = !workflowState && shouldShowThinking(isLLMRunning, visibleMessages);
  const searchResults = overlayState.activeOverlay === 'search'
    ? computeSearchResults(messages, overlayState.searchQuery)
    : [];

  function scrollByLines(delta: number): void {
    scrollRef.current?.scrollBy?.({ x: 0, y: delta });
  }

  function scrollToBottom(): void {
    const target = scrollRef.current?.scrollHeight ?? Number.MAX_SAFE_INTEGER;
    scrollRef.current?.scrollTo?.({ x: 0, y: target });
  }

  function handleAction(action: KeyAction): void {
    switch (action.type) {
      case 'scroll_up':
        scrollByLines(-action.amount);
        break;
      case 'scroll_down':
        scrollByLines(action.amount);
        break;
      case 'jump_to_end':
        scrollToBottom();
        break;
      case 'toggle_display_mode':
        setDisplayMode((mode) => toggleDisplayMode(mode));
        break;
      case 'open_overlay':
        setOverlayState((state) => openOverlay(state, action.overlay));
        break;
      case 'close_overlay':
        setOverlayState((state) => closeOverlay(state));
        break;
      case 'clear_screen':
        setClearedCount(filteredMessages.length);
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
      case 'tab_complete':
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

    if (overlayState.activeOverlay === 'search' && !key.ctrl && !key.escape) {
      if (key.backspace || key.delete) {
        setOverlayState((state) => updateSearchQuery(state, state.searchQuery.slice(0, -1)));
      } else if (input && !key.return && !key.tab && input !== '/') {
        setOverlayState((state) => updateSearchQuery(state, state.searchQuery + input));
      }
    }
  });

  const hasOverlay = overlayState.activeOverlay !== null;

  return (
    <Column width={columns} height={rows}>
      {hasOverlay ? (
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
        <>
          {statusBarProps ? (
            <StatusBar
              projectPath={statusBarProps.projectPath}
              status={statusBarProps.status}
              activeAgent={statusBarProps.activeAgent}
              tokenCount={statusBarProps.tokenCount}
              columns={columns}
              taskType={statusBarProps.taskType}
              currentPhase={statusBarProps.currentPhase}
              godAdapter={statusBarProps.godAdapter}
              reviewerAdapter={statusBarProps.reviewerAdapter}
              coderModel={statusBarProps.coderModel}
              reviewerModel={statusBarProps.reviewerModel}
              godLatency={statusBarProps.godLatency}
            />
          ) : (
            <Row height={STATUS_BAR_HEIGHT} width={columns}>
              <Text inverse>{` ${statusText ?? ''}`}</Text>
            </Row>
          )}

          {hasTaskBanner && (
            <TaskBanner
              taskSummary={contextData!.taskSummary}
              columns={columns}
              contentWidth={sessionContentWidth}
            />
          )}

          <Row height={1}>
            <Divider width={separatorWidth + 1} />
          </Row>

          <ScrollBox
            ref={scrollRef}
            height={messageAreaHeight}
            width={columns}
            stickyScroll
            stickyStart="bottom"
            scrollY
            viewportCulling={false}
            scrollbarOptions={{ backgroundColor: 'black' }}
          >
            <Row width={columns} justifyContent="center">
              <Column width={sessionContentWidth}>
                {visibleMessages.map((message) => (
                  <MessageView
                    key={message.id}
                    message={message}
                    displayMode={displayMode}
                    columns={sessionContentWidth}
                  />
                ))}
                {indicatorConfig && (
                  <ThinkingIndicator
                    columns={sessionContentWidth}
                    message={indicatorConfig.message}
                    color={indicatorConfig.color}
                    showElapsed={indicatorConfig.showElapsed}
                  />
                )}
                {isThinking && !indicatorConfig && (
                  <ThinkingIndicator columns={sessionContentWidth} />
                )}
              </Column>
            </Row>
          </ScrollBox>

          <Column height={activeFooterHeight}>
            <Row height={FOOTER_SEPARATOR_HEIGHT}>
              <Divider width={separatorWidth + 1} />
            </Row>
            <Column
              height={footerBodyHeight}
              paddingX={1}
              overflow="hidden"
            >
              <CenteredContent width={sessionContentWidth} height={footerBodyHeight}>
                {footer ? footer : (
                  <InputArea
                    isLLMRunning={isLLMRunning}
                    onSubmit={onInputSubmit ?? (() => {})}
                    maxLines={footerBodyHeight}
                    onValueChange={(value) => setInputEmpty(value === '')}
                    onSpecialKey={(value) => {
                      if (value === '?') setOverlayState((state) => openOverlay(state, 'help'));
                      if (value === '/') setOverlayState((state) => openOverlay(state, 'search'));
                    }}
                    disabled={hasOverlay}
                  />
                )}
              </CenteredContent>
            </Column>
          </Column>
        </>
      )}
    </Column>
  );
}
