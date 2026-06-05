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

Current repository state:

- the runtime is test-driven and runnable through the local test harness
- context, instruction, replay, retry, redaction, local inspection, and memory foundation behavior are implemented
- explicit memory injection and non-persistent memory suggestions are implemented
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

Current verification status:

- full suite passes locally: `60/60`

## Next Recommended Milestone

The next realistic phase is:

1. `Memory Maintenance Groundwork`
   - conflict detection
   - freshness/aging mechanics
   - still no background Auto Dream executor

Do not start MCP, multi-agent, or product surfaces before memory maintenance groundwork is stabilized.

## Known Constraints

- Event storage remains local JSONL.
- Memory storage is local JSONL/file-backed and separate from event storage.
- There is still no product surface such as CLI/TUI/API.
- Design documents remain local reference artifacts and are not part of the committed runtime history by default.
- Retry count in local observability is intentionally not reported as a derived metric because it is not safely inferable from the current event stream.
- Memory suggestions remain non-persistent caller-facing outputs.
