# Kip Development Plan

This plan is the working checklist for the build. The contract lives in
[`SPEC.md`](./SPEC.md); this file tracks execution and verification.

## Ground Rules

- Zero questions: every open detail is resolved from the spec's principles.
- Validate SDK shape from `node_modules/*.d.ts` before wiring it.
- Typecheck and test after every phase.
- One conventional commit per milestone, pushed immediately.
- No keys, tokens, or generated credentials in git.

## Phase 1 — Scaffold and dual-process build

- [x] Initialize the `kip` repository and Electrobun project.
- [x] Install runtime, agent, UI, and build dependencies.
- [x] `electrobun.config.ts`, `vite.config.ts`, `tsconfig.json`.
- [x] Shared type + RPC contract (`src/shared/`).
- [x] Minimal Bun entrypoint, window, and end-to-end RPC heartbeat.
- [x] `bun run typecheck` and `bun run build` succeed.

## Phase 2 — Storage and system services

- [x] `db.ts`: WAL SQLite schema, migrations, typed DAO.
- [x] `keychain.ts`: macOS Keychain with AES-256-GCM fallback.
- [x] `fs-dialog.ts`: native folder picker, file listing, safe traversal.
- [x] `git-inspector.ts`: branch and dirty-file counts.
- [x] Unit tests for database, key storage, and command/path policies.

## Phase 3 — Pi orchestration and tool approval

- [x] `ModelRegistry`: OpenAI-compatible custom providers plus Pi model bridge.
- [x] `pi-orchestrator.ts`: session pool, resume, streaming, abort, compact.
- [x] `tool-interceptor.ts`: path guard, command classifier, approval promise.
- [x] `session-bridge.ts`: Pi messages to turn/blocks projection.
- [x] 16 ms frame coalescing and automatic thread titles.
- [x] Headless integration test for approval suspend/resume and abort.
- [x] Live end-to-end run against a real provider (tool calls, approval, abort).

## Phase 4 — Editorial interface

- [x] Tokens, typography, light/dark themes, hairlines, motion springs.
- [x] App shell, frameless title bar, collapsible sidebar, top bar.
- [x] Editorial thread canvas with scroll anchor and jump-to-latest pill.
- [x] Markdown + dark Shiki code blocks, folded work log, nested diffs, approval card.
- [x] Floating composer with @file search, image paste, model selector.
- [x] Progressive disclosure: collapsed work log, live action header, staggered reveal.
- [x] Readability pass: 16px prose, higher-contrast text, dark code surface, clay actions.

## Phase 5 — Shortcuts, onboarding, polish

- [x] Command palette and global shortcuts.
- [x] Zero-key onboarding and contextual empty state.
- [x] Settings modal: providers, keys, appearance, safety, sync.
- [x] Error recovery, graceful shutdown, scratchpad workspace.
- [x] S3 sync, Markdown export, full backup import/export.
- [x] Icon system and generated platform assets.
- [x] Final typecheck, tests, build, launch, README.

## Deliberate Decisions

- **Electrobun 1.18 + CEF on macOS.** Electrobun 2.x and 1.x both call a WebKit API
  introduced in macOS 14. macOS 13 therefore runs the bundled CEF renderer; macOS 14+
  can switch to native by changing two renderer settings.
- **Kip-scoped Pi configuration.** Sessions load `~/.kip/agent` with extensions, skills,
  prompts, and themes disabled, so a user's global Pi setup cannot change Kip's tool
  surface or system prompt.
- **Credential boundary.** Keys are injected with `setRuntimeApiKey` at runtime and never
  serialized into SQLite or sync payloads.
- **Bash policy.** Bash is classified, not assumed mutating. Safe inspection commands run
  automatically under `read-only-auto`; everything else asks.
- **Approval duration.** Tool durations include time spent waiting for a decision, which
  is why an ignored approval can show a long duration.

## Verification Log

| Date | Check | Result |
| --- | --- | --- |
| 2026-11-18 | `tsc --noEmit` | 0 errors |
| 2026-11-18 | `bun test` | 29 passed, 0 failed |
| 2026-11-18 | App launch on macOS 13.7 / arm64 | CEF window renders, RPC connected |
| 2026-11-18 | Live agent turn (Command Code / DeepSeek) | Streaming text, thinking, tool calls |
| 2026-11-18 | Write approval | Diff preview, allow, file written |
| 2026-11-18 | Abort | Session stopped, composer returned to idle |
| 2026-11-18 | Light/dark themes | Both verified via CDP screenshots |
| 2026-11-18 | Work log folding | 49-step turn collapses to one line; expands to a timeline |
| 2026-11-18 | Write denial | Deny path verified; model received the denial and file stayed absent |
| 2026-11-18 | `bun run build` | Packaging completed |

## Next Ideas

- Native renderer switch for macOS 14+ with a runtime capability check.
- Spell-check toggle and per-workspace model defaults.
- Drag-and-drop file attachments (images are already paste/file-picker enabled).
- WebDAV or Git sync provider behind the `SyncProvider` seam.
- Signed and notarized release pipeline.
