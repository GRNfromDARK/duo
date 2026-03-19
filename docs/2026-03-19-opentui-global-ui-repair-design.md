# OpenTUI Global UI Repair Design

**Date:** 2026-03-19  
**Status:** Approved in-session, implementation in progress  
**Branch:** `codex/ui-followup-repair`

## Goal

Repair the entire OpenTUI presentation layer so startup, session, completion, and overlays share one coherent UI language instead of a mix of Ink-era assumptions and partial OpenTUI migrations.

This pass is not limited to the transcript screen. It covers:

- setup/startup wizard
- live session layout
- completion footer flow
- full-screen overlays
- in-session cards rendered as full replacements

## User-Approved Direction

- Use a shared `TUI layout primitives` layer
- Migrate `SetupWizard + MainLayout + Completion + Overlays` onto one theme
- Keep the startup page’s **large logo + framed hero box**
- Update startup text to emphasize **Coder / Reviewer / God collaboration and convergence**

## Root Cause

The current OpenTUI UI has two interacting structural problems.

### 1. Missing shared layout primitives

Many components still render raw `Box` + `Text` trees directly, with no shared abstraction for:

- horizontal rows
- label/value pairs
- section dividers
- framed panels
- selection lists
- input rows
- footer hints

That by itself would be manageable, except many components also rely on the old renderer’s layout defaults.

### 2. Ink-era layout assumptions survived the migration

Across the codebase, components still assume that a plain `<Box>` will behave like a horizontal container. In OpenTUI that assumption is unsafe, and it causes the visible breakage in the screenshots:

- role label, timestamp, and message content split into vertical stacks
- `Path:` label and typed value render on separate lines
- model-selection chevrons and labels drift apart
- overlay two-column rows collapse into awkward vertical lists
- footer/completion UI stops reading as intentional layout

This is a renderer-level mismatch, not a one-page bug.

## Design Direction

Adopt a single **hybrid OpenTUI theme** with two visual modes:

### 1. Branded startup mode

The setup flow keeps a strong branded entry:

- large cyan Duo logo
- prominent framed hero box
- updated copy focused on the three-role workflow

But the rest of the setup screen below the hero should use the same shared primitives as the session UI, so it no longer feels like a different product.

### 2. Compact operational mode

The live session, overlays, and completion states use a compact hybrid layout:

- narrow chrome
- clean reading column
- explicit row/column structure
- restrained separators
- clearer hierarchy between agent output, system output, and controls

## Target UI Language

### Shared Theme Rules

- Every horizontal grouping must be explicit via a shared row primitive
- Every stacked region must be explicit via a shared column primitive
- Borders and panels should be used for framing, not for every content block
- Separators should be offset and light, never full-screen heavy slabs unless framing a hero area
- Prompt rows, selection rows, and label/value rows should be visually consistent across setup, session, and overlays

### Startup / Setup

The startup flow should read as:

1. Hero box with big logo and updated collaboration-focused copy
2. Compact progress stepper below it
3. One focused work panel for the active step

The active step panel should reuse the same building blocks for:

- directory entry
- agent selection
- model selection
- task entry
- confirmation summary

### Session

The session screen should read as:

1. compact status line
2. task strip
3. transcript
4. bottom composer or completion footer

Transcript rules:

- one message = one block
- one header row per message
- one light rail per message body
- explicit paragraph/block rhythm inside content
- system output lighter than agent output

### Overlays and Cards

Overlays should stop looking like old ad hoc Ink boxes. They should all share:

- framed panel
- title row
- content rows with explicit columns
- footer hint row

TaskAnalysisCard, ReclassifyOverlay, and similar replacement views should also use the same row and list primitives so they stop drifting visually from the rest of the app.

## Copy Direction

The startup page copy should emphasize the workflow, not generic “AI coding engine” branding.

Recommended structure:

- hero slogan: short, confident, role-based
- subhead: one-line explanation of convergence-oriented collaboration
- bullets: each bullet explains a distinct role/value of the three-agent system

The wording should be shorter and stronger than the current copy so it survives narrow terminals.

## Implementation Strategy

### 1. Introduce shared layout primitives first

Create one small shared UI layer for:

- `Row`
- `Column`
- `Panel`
- `Divider`
- `SectionTitle`
- `LabelValueRow`
- `SelectionRow`
- `PromptRow`
- `FooterHint`

The point is not abstraction for its own sake. The point is to remove renderer ambiguity and establish one reusable theme surface.

### 2. Migrate setup flow next

The startup wizard is the most visibly broken after the transcript. It should be migrated first because it exercises the same primitives needed elsewhere:

- selection rows
- prompt rows
- framed panels
- label/value alignment

### 3. Migrate session and completion together

The session and completion footer must share the same bottom-region identity. Completion should no longer look like a separate mini-app.

### 4. Migrate overlays and cards last

Once the primitives and session theme are stable, the remaining overlays and modal-replacement cards can be updated mechanically and consistently.

## Files Expected To Change

### Create

- `docs/2026-03-19-opentui-global-ui-repair-design.md`
- `docs/2026-03-19-opentui-global-ui-repair-plan.md`
- `src/ui/tui-layout.tsx`
- `src/ui/setup-copy.ts`
- `src/__tests__/ui/tui-layout.test.ts`
- `src/__tests__/ui/setup-copy.test.ts`

### Modify

- `src/ui/components/SetupWizard.tsx`
- `src/ui/components/DirectoryPicker.tsx`
- `src/ui/components/MainLayout.tsx`
- `src/ui/components/StatusBar.tsx`
- `src/ui/components/TaskBanner.tsx`
- `src/ui/components/MessageView.tsx`
- `src/ui/components/SystemMessage.tsx`
- `src/ui/components/ThinkingIndicator.tsx`
- `src/ui/components/CompletionScreen.tsx`
- `src/ui/components/HelpOverlay.tsx`
- `src/ui/components/SearchOverlay.tsx`
- `src/ui/components/ContextOverlay.tsx`
- `src/ui/components/TimelineOverlay.tsx`
- `src/ui/components/ReclassifyOverlay.tsx`
- `src/ui/components/TaskAnalysisCard.tsx`
- `src/ui/components/PhaseTransitionBanner.tsx`
- `src/ui/components/DisagreementCard.tsx`

## Acceptance Criteria

- setup wizard no longer has broken row/column alignment
- startup hero keeps the large logo and frame, but the rest of setup uses the same theme as the session UI
- startup copy clearly communicates the Coder / Reviewer / God workflow
- session header, transcript blocks, thinking indicator, and completion footer share one visual language
- overlays and replacement cards use the same shared row/panel primitives
- no screen shown in the current app relies on implicit `Box` direction for critical layout
- full regression suite and build pass

