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

Current repository state:

- the runtime is test-driven and runnable through the local test harness
- context, instruction, replay, retry, redaction, and local inspection behavior are implemented
- provider parity across fake, OpenAI, and Anthropic is implemented
- observability remains local-only and derived from existing events

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

Delivered in the working tree:

- `AnthropicAdapter`
- Anthropic request/response mapping
- Anthropic tool-call normalization
- Anthropic error taxonomy mapping
- Anthropic budget estimation
- shared adapter contract validation across fake, OpenAI, and Anthropic

### Phase 5: Local Observability

Delivered in the working tree:

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

Current verification status:

- full suite passes locally: `44/44`

## Next Recommended Milestone

The next two realistic phases are:

1. `Memory Manager`
   - project/reference memory boundary
   - durable memory record model
   - provenance and write policy
   - no Auto Dream yet

2. `Commit current provider + observability work`
   - commit Anthropic parity
   - commit local observability
   - keep design docs untracked unless explicitly requested

Do not start MCP, multi-agent, or product surfaces before one of those is stabilized.

## Known Constraints

- Event storage remains local JSONL.
- There is still no product surface such as CLI/TUI/API.
- Design documents remain local reference artifacts and are not part of the committed runtime history by default.
- Retry count in local observability is intentionally not reported as a derived metric because it is not safely inferable from the current event stream.
