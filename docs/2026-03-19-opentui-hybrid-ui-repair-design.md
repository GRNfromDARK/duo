# OpenTUI Hybrid UI Repair Design

**Date:** 2026-03-19  
**Status:** Approved in conversation, pending written-spec review  
**Branch:** `codex/ui-hybrid-polish`

## Goal

Repair the OpenTUI session UI so it keeps a compact terminal-tool feel in the status region while restoring readable, structured message presentation in the conversation body.

The repaired UI must address the regression shown in the current OpenTUI build:

- top bar reads as one dense black strip instead of two information groups
- task summary is visually merged into the status chrome
- message content is flattened into line-by-line rails, making long answers, tables, and code blocks hard to scan
- system messages and agent messages compete at the same visual weight
- the input area reads like another message line instead of a dedicated composer

## Non-Goals

- No change to workflow orchestration, adapters, God logic, or session persistence
- No redesign of overlays beyond alignment with the repaired session theme
- No attempt to create a fully card-based, web-like chat UI
- No reintroduction of Ink-era manual viewport slicing

## Design Direction

Adopt a **hybrid terminal layout**:

- keep the top status zone compact and information-dense
- make the conversation body noticeably more readable than the current OpenTUI port
- reduce decorative rails and heavy separators so the text content regains focus
- preserve TUI affordances: fast scanning, keyboard-first usage, narrow-column tolerance

This is intentionally a middle ground between:

- the old dense CLI presentation
- a softer, card-heavy reading layout

## Root Cause

The current OpenTUI port preserved too much of the Ink-era presentation model:

1. `MainLayout` renders the message area from `buildRenderedMessageLines(...)`, which flattens each message into line records.
2. The flattened renderer repeats the role rail on every line, which overemphasizes borders and de-emphasizes content.
3. Markdown structures are reduced to wrapped text too early, so tables, code blocks, summaries, and normal prose lose hierarchy.
4. The status bar and footer still assume earlier terminal rendering behavior and are not using OpenTUI’s layout model to create distinct horizontal groups.

The fix should target that structure, not only colors and spacing.

## UX Principles

### 1. Compact chrome, readable body

The header and footer should remain narrow and efficient. The conversation body should get the visual breathing room.

### 2. One message, one container

Each message should render as one visual block with:

- a lightweight header row
- one content rail
- internal block spacing handled by content type, not by repeating the outer border

### 3. Content type determines emphasis

- normal prose: neutral text with stable wrapping
- activity summaries: accent-colored operational status
- code blocks: low-contrast surface with clear folded/expanded controls
- tables: dimmed structured rows, not plain wrapped paragraphs
- system messages: lighter, separate emphasis from agent responses

### 4. Input must look interactive

The composer should always read as a dedicated input region, not as another transcript row.

## Information Architecture

### 1. Status Region

#### StatusBar

The status bar becomes two compact groups on one line:

- left group: `Duo`, shortened project path, current state, active agent
- right group: latency and token metrics

Behavior:

- project path truncates in the middle before higher-priority status items disappear
- active state color remains the primary header accent
- inverse/full-black treatment becomes lighter and more deliberate, avoiding the “solid slab” look

#### TaskBanner

The task summary becomes a distinct strip below the status bar:

- single-line summary
- softer background/separator than the status bar
- visually grouped with the transcript, not with the application header

### 2. Conversation Region

#### MainLayout

`MainLayout` should stop rendering the transcript from pre-flattened line records.

Instead:

- keep `ScrollBox` as the scroll container
- render a vertical stack of structured message blocks
- append the thinking indicator as its own block at the bottom

This change is the central architectural repair.

#### MessageView

`MessageView` becomes the primary transcript block renderer:

- header row: role + optional role label + timestamp
- body row: one light rail plus the content column
- bottom spacing between messages stays compact but consistent

The role rail should appear once per message body, not once per wrapped line.

#### SystemMessage

System messages should remain clearly visible, but lighter than agent outputs:

- no heavy transcript rail
- simpler accent treatment
- better alignment with system semantics: routing, interrupts, waiting, completion

### 3. Content Blocks Inside Messages

#### StreamRenderer

`StreamRenderer` should preserve structure instead of collapsing everything into line-level text too early.

Required treatment:

- paragraphs separated by tight but visible vertical rhythm
- activity summaries remain single-line and concise in minimal mode
- verbose activity output preserves subordinate detail without dominating the transcript
- tables render as grouped rows with visible column rhythm
- inline code remains distinct but not visually louder than code blocks

#### CodeBlock

Code blocks should switch from “full-width gray stripes per line” to a lighter surface model:

- low-contrast container background
- optional language label above
- preview/fold state visually tied to the container
- compact padding to keep the TUI feel

The result should be more readable without looking like a GUI card.

### 4. Composer Region

#### InputArea

The input composer should become a stable footer region:

- always visually separated from transcript content
- stronger prompt identity
- placeholder and running states clearer
- multi-line input remains compact but obviously editable

Cursor rendering should remain terminal-native in spirit, but more intentional than the current inline block character dropped into transcript-like rows.

## File-Level Design

### Create

- `docs/2026-03-19-opentui-hybrid-ui-repair-design.md`
- `docs/2026-03-19-opentui-hybrid-ui-repair-plan.md`
- `src/ui/status-bar-layout.ts`
  Pure helper module for segment priority, truncation, and grouping logic.
- `src/ui/message-blocks.ts`
  Pure helper module for mapping markdown/message content into structured transcript blocks suitable for OpenTUI rendering.

### Modify

- `src/ui/components/MainLayout.tsx`
- `src/ui/components/StatusBar.tsx`
- `src/ui/components/TaskBanner.tsx`
- `src/ui/components/MessageView.tsx`
- `src/ui/components/SystemMessage.tsx`
- `src/ui/components/StreamRenderer.tsx`
- `src/ui/components/CodeBlock.tsx`
- `src/ui/components/InputArea.tsx`
- `src/tui/primitives.tsx`
  Only if a small wrapper improvement is needed for layout/text grouping.

### Leave Unchanged Unless Needed

- workflow and adapter layers
- session state management
- overlay behavior
- OpenTUI CLI entrypoint

## Testing Strategy

Because OpenTUI renderer regressions are hard to cover with the old Ink-style component tests, the repair should combine:

1. pure helper tests for status truncation/grouping
2. pure helper tests for structured message block generation
3. existing integration smoke tests for OpenTUI bootstrap/resume
4. one targeted end-to-end transcript rendering smoke test if needed

The design deliberately pushes layout decisions into pure helpers where possible so that behavior can be regression-tested without relying on terminal snapshots for every case.

## Acceptance Criteria

- top bar reads as two intentional groups, not one dense black strip
- task summary is visually separate from global status
- each message reads as one coherent block
- agent and system outputs are distinguishable without overwhelming color noise
- long markdown answers remain readable in minimal mode
- code blocks and tables regain structure
- input composer is visually identifiable as the footer interaction zone
- no regression to mouse-wheel transcript scrolling

## Recommended Implementation Order

1. repair status/header grouping
2. replace flattened transcript rendering with structured message blocks
3. restyle content blocks (`StreamRenderer`, `CodeBlock`, `SystemMessage`)
4. repair composer/footer presentation
5. run OpenTUI integration verification and manual smoke test
