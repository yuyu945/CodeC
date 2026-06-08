# Progress

Last updated: 2026-06-05

## Status

The project now has a stable runtime core with:

- MVP-0 single-agent runtime loop
- provider boundary with real OpenAI and Anthropic adapters
- context compaction foundation
- project-scoped instruction resolution
- micro-compact for historical tool results
- local observability derived from existing `AgentEvent`
- memory manager foundation for explicit project/reference records
- explicit caller-selected memory context integration
- memory maintenance analyzer groundwork
- explicit memory maintenance apply path
- memory product surface facade
- memory command-runner surface
- memory argv/bin wrapper
- memory human-facing TUI

Current repository state:

- the runtime is test-driven and runnable through the local test harness
- context, instruction, replay, retry, redaction, local inspection, and memory foundation behavior are implemented
- explicit memory injection and non-persistent memory suggestions are implemented
- read-only memory maintenance analysis is implemented
- caller-invoked memory maintenance write-back is implemented
- a library-level memory product surface is implemented
- a minimal memory command-runner surface is implemented
- a minimal shell-facing memory executable entrypoint is implemented
- a minimal local memory TUI is implemented
- provider parity across fake, OpenAI, and Anthropic is implemented
- observability remains local-only and derived from existing events
- memory remains explicit-write-only and does not auto-persist during normal turns or suggestions

## Completed

### Phase 0: Design

Artifacts:

- `design.md`
- `coding-agent-runtime-system-design.zh-CN.md`
- `coding-agent-runtime-system-design.md`

Outcome:

- runtime, context, memory, tool, permission, event, replay, and provider architecture are documented
- Codex CLI and Claude Code design influences are recorded

### Phase 1: MVP-0 Vertical Slice

Completed in commit:

- `18b40fb feat: add MVP-0 agent runtime vertical slice`

Delivered:

- `AgentRuntime.runTurn()` with real model/tool loop
- typed tool result injection
- `PermissionManager`
- `ToolExecutor`
- `JsonlEventStore`
- `Replay`
- runtime, tool, permission, and E2E tests

### Phase 2: Provider Boundary

Completed in commit:

- `0f12ca6 feat: add provider-aware runtime compaction foundation`

Delivered:

- canonical `ModelAdapter` boundary
- `FakeModelAdapter`
- `OpenAIResponsesAdapter`
- provider error taxonomy and retry/abort handling
- provider-focused tests

### Phase 3: Context Pipeline

Completed in commit:

- `774c7c9 feat: finalize context pipeline and instruction system`

Delivered:

- provider-owned budget estimation
- `AutoCompact`
- `Reactive Compact`
- `Snip`
- `MicroCompact`
- project-scoped `AGENTS.md` instruction resolution
- touched-path-aware instruction scope expansion
- instruction and compaction replay visibility
- tool-output redaction and stronger replay inspection

### Phase 4: Provider Parity

Completed in commit:

- `9a658ad feat: add anthropic parity and local observability`

Delivered:

- `AnthropicAdapter`
- Anthropic request/response mapping
- Anthropic tool-call normalization
- Anthropic error taxonomy mapping
- Anthropic budget estimation
- shared adapter contract validation across fake, OpenAI, and Anthropic

### Phase 5: Local Observability

Completed in commit:

- `9a658ad feat: add anthropic parity and local observability`

Delivered:

- `eventCoverageChecklist`
- `SessionSummary`
- `SessionMetrics`
- `SessionInspector`
- local JSON report generation

Observability scope:

- derived from existing `AgentEvent`
- local-only
- redacted by default
- no exporter / dashboard / telemetry backend

### Phase 6: Memory Manager Foundation

Completed in commit:

- `c700757 feat: add explicit memory manager foundation`

Delivered:

- `MemoryRecord`
- `MemoryQuery`
- `MemoryManager`
- `FileMemoryStore`
- `LocalMemoryManager`
- explicit project/reference memory scope classification
- write-time redaction enforcement
- explicit-write-only durable memory behavior

Memory scope:

- `project`
- `reference`

Memory constraints:

- no automatic writes from normal runtime turns
- no Auto Dream
- no semantic retrieval
- no user/feedback/episodic memory yet

### Phase 7: Memory Integration

Delivered in the working tree:

- `TurnRequest.memorySelections`
- aggregate `memory_context` system fragment injection
- per-selection memory retrieval limits with deterministic truncation
- cross-selection memory record deduplication
- injected memory redaction
- non-persistent `memorySuggestions` returned from runtime turns
- memory compaction summaries with stable `memory:` prefix

Memory integration constraints:

- memory retrieval occurs only when explicitly selected by the caller
- memory suggestions are returned to the caller but are not written automatically
- provider adapters do not parse provider-native responses into memory suggestions
- memory context is one aggregate fragment, not one fragment per selection

### Phase 8: Memory Maintenance Groundwork

Delivered in the working tree:

- `MemoryMaintenanceAnalyzer`
- serializable `MemoryMaintenanceReport`
- explicit conflict pair detection
- heuristic shared-tag signal-phrase conflict detection
- freshness aging suggestions from `lastSeenAt` / `createdAt`
- expiration-driven stale suggestions
- duplicate conflict suppression across explicit and heuristic detection

Memory maintenance constraints:

- analyzer is read-only and does not mutate input records
- analyzer does not read or write memory stores directly
- no automatic write-back of freshness or conflict metadata
- no background executor / Auto Dream

### Phase 9: Explicit Memory Maintenance Apply Path

Delivered in the working tree:

- `MemoryManager.applyMaintenance()`
- `MemoryMaintenanceApplyRequest`
- `MemoryMaintenanceApplyResult`
- caller-selected freshness write-back
- caller-selected conflict write-back
- no-op apply short-circuit without store rewrite
- full-order persisted record return from apply results

Memory maintenance apply constraints:

- apply remains caller-invoked and separate from analysis
- no automatic/background execution
- apply only changes approved freshness/conflict fields
- apply skips stale approvals when current record state has drifted

### Phase 10: Memory Product Surface

Delivered in the working tree:

- `MemorySurface`
- `MemoryInspectRequest`
- `MemoryInspectResult`
- `LocalMemorySurface`
- query-view `inspect()` flow
- full-library-view `analyze()` flow
- direct `apply()` facade delegation

Memory product surface constraints:

- product surface is library-only, not CLI/TUI/API yet
- inspect and analyze remain intentionally different views
- inspect with maintenance analyzes only the returned record set
- no automatic maintenance execution is introduced

### Phase 11: Memory CLI Surface

Delivered in the working tree:

- `MemoryCliCommand`
- `runMemoryCli()`
- default memory store path resolution from `cwd`
- explicit relative `storePath` resolution
- JSON-shaped inspect / analyze / apply command results
- deterministic command dispatch errors

Memory CLI surface constraints:

- surface is command-runner only, not full `argv` parsing
- no bin script or interactive UI yet
- no automatic maintenance execution is introduced
- command runner reuses existing memory facade and manager boundaries

### Phase 12: Memory argv/bin Wrapper

Delivered in the working tree:

- `parseMemoryCliArgv()`
- `executeMemoryCli()`
- `memory-cli.ts`
- repo-local `memory` package script
- deterministic stdout / stderr / exitCode contract
- relative request-file resolution from `cwd`

Executable wrapper constraints:

- wrapper is minimal and shell-facing, but not a full published npm `bin`
- output remains JSON-only
- no interactive UI or autonomous maintenance execution is introduced
- executable layer remains a thin wrapper over the command-runner

### Phase 13: Memory Human-Facing TUI

Delivered in the working tree:

- `MemoryTuiState`
- `MemoryTuiResult`
- `MemoryTuiCommand`
- `LocalMemoryTuiController`
- `parseMemoryTuiCommand()`
- `executeMemoryTuiCommand()`
- `memory-tui.ts`
- repo-local `memory:tui` package script

Memory TUI constraints:

- TUI is minimal and local-only
- built on Node `readline`, without third-party TUI libraries
- uses explicit inspect / analyze / apply flows only
- no autonomous maintenance execution is introduced

## Current Test Surface

Test files:

- `tests/runtime.test.ts`
- `tests/tools-permissions.test.ts`
- `tests/replay-e2e.test.ts`
- `tests/providers.test.ts`
- `tests/compaction.test.ts`
- `tests/instructions.test.ts`
- `tests/module-exports.test.ts`
- `tests/observability.test.ts`
- `tests/memory.test.ts`

Covered behavior:

- runtime loop behavior
- permission decisions
- tool execution
- provider mapping
- cross-provider adapter contract parity
- provider retry and abort
- replay inspection
- compaction tiers
- instruction resolution and trimming
- micro-compact behavior
- local observability summaries and metrics
- explicit durable memory storage and retrieval
- explicit memory context injection
- non-persistent runtime memory suggestions
- read-only memory conflict and freshness analysis
- caller-invoked memory maintenance persistence
- library-level memory inspect/analyze/apply facade behavior
- command-runner memory inspect/analyze/apply behavior
- shell-facing memory executable wrapper behavior
- local interactive memory TUI behavior

Current verification status:

- full suite passes locally: `115/115`

## Next Recommended Milestone

The next realistic phase is:

1. `Memory UX Refinement`
   - improve readability, discoverability, and command ergonomics across CLI/TUI surfaces
   - still no autonomous background maintenance

Do not start MCP or multi-agent work before the memory UX boundary is stabilized.

## Known Constraints

- Event storage remains local JSONL.
- Memory storage is local JSONL/file-backed and separate from event storage.
- There is now a minimal shell-facing memory executable entrypoint and a local TUI, but no general API.
- Design documents remain local reference artifacts and are not part of the committed runtime history by default.
- Retry count in local observability is intentionally not reported as a derived metric because it is not safely inferable from the current event stream.
- Memory suggestions remain non-persistent caller-facing outputs.
- Memory maintenance remains explicit and caller-driven with no autonomous persistence.
- Memory product surface is still library-only with no user-facing command surface.
- Memory command surfaces are JSON-first and not yet optimized for human-readable UX.
- Memory TUI is intentionally minimal and local-only, not a general UI framework.
