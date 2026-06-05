import type { AgentEvent } from "./types.ts";

export class Replay {
  static fromEvents(events: AgentEvent[]) {
    const sorted = [...events].sort((a, b) => a.sequence - b.sequence);
    const starts = new Map<string, Extract<AgentEvent, { type: "ToolCallStarted" }>>();
    const finishes = new Map<string, Extract<AgentEvent, { type: "ToolCallFinished" }>>();
    const injections = new Map<string, Extract<AgentEvent, { type: "ToolResultInjected" }>>();
    const compactions: Array<Extract<AgentEvent, { type: "ContextCompacted" }>> = [];
    const instructions: Array<{
      appliedSources: string[];
      trimmedSources: string[];
      totalBytes: number;
    }> = [];
    const permissions = new Set<string>();
    let injectedBeforeNextModelCall = true;
    const pendingResults = new Set<string>();

    for (const event of sorted) {
      if (event.type === "ContextCompacted") compactions.push(event);
      if (event.type === "InstructionsResolved") {
        instructions.push({
          appliedSources: event.appliedSources,
          trimmedSources: [],
          totalBytes: event.totalBytes,
        });
      }
      if (event.type === "InstructionsTrimmed" && instructions.length > 0) {
        instructions[instructions.length - 1] = {
          ...instructions[instructions.length - 1],
          trimmedSources: event.trimmedSources,
          totalBytes: event.totalBytes,
        };
      }
      if (event.type === "PermissionEvaluated") permissions.add(event.callId);
      if (event.type === "ToolCallStarted") starts.set(event.callId, event);
      if (event.type === "ToolCallFinished") {
        finishes.set(event.callId, event);
        pendingResults.add(event.callId);
      }
      if (event.type === "ToolResultInjected") {
        injections.set(event.callId, event);
        pendingResults.delete(event.callId);
      }
      if (event.type === "ModelResponseReceived" && pendingResults.size > 0) injectedBeforeNextModelCall = false;
    }

    const toolPairs = [...starts.values()].map((start) => {
      const finish = finishes.get(start.callId);
      return {
        callId: start.callId,
        toolName: start.toolName,
        status: finish?.status ?? "error",
      };
    });

    const inspectedToolCalls = Object.fromEntries(
      [...starts.keys()].map((callId) => [
        callId,
        {
          started: starts.get(callId),
          finished: finishes.get(callId),
          injection: injections.get(callId),
        },
      ]),
    );

    return {
      events: sorted,
      compactions,
      instructions,
      toolPairs,
      inspectedToolCalls,
      hasPermissionForEveryToolCall: [...starts.keys()].every((callId) => permissions.has(callId)),
      toolResultsInjectedBeforeNextModelCall: injectedBeforeNextModelCall,
    };
  }
}
