import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

import {
  AgentRuntime,
  ContextBuilder,
  FakeModelAdapter,
  InstructionResolver,
  JsonlEventStore,
  PermissionManager,
  Replay,
  ToolExecutor,
} from "../src/index.ts";

async function instructionWorkspace() {
  const cwd = await mkdtemp(join(tmpdir(), "codec-instructions-"));
  await mkdir(join(cwd, "src", "feature"), { recursive: true });
  await writeFile(join(cwd, "AGENTS.md"), "ROOT RULE\n");
  await writeFile(join(cwd, "src", "AGENTS.md"), "SRC RULE\n");
  await writeFile(join(cwd, "src", "feature", "AGENTS.md"), "FEATURE RULE\n");
  await writeFile(join(cwd, "src", "feature", "file.txt"), "payload\n");
  return cwd;
}

test("InstructionResolver merges root and nested AGENTS.md files in deterministic scope order", async () => {
  const cwd = await instructionWorkspace();
  const resolver = new InstructionResolver({ maxBytes: 1024 });

  const bundle = await resolver.resolve({
    workspaceRoot: cwd,
    cwd: join(cwd, "src"),
    touchedPaths: [],
  });

  assert.deepEqual(
    bundle.fragments.map((fragment) => fragment.normalizedText),
    ["ROOT RULE", "SRC RULE"],
  );
  assert.deepEqual(
    bundle.sources.map((source) => source.relativePath),
    ["AGENTS.md", "src/AGENTS.md"],
  );
});

test("InstructionResolver trims least-local instruction fragments when over byte budget", async () => {
  const cwd = await instructionWorkspace();
  await writeFile(join(cwd, "AGENTS.md"), "ROOT ".repeat(80));
  await writeFile(join(cwd, "src", "AGENTS.md"), "SRC ".repeat(20));
  const resolver = new InstructionResolver({ maxBytes: 120 });

  const bundle = await resolver.resolve({
    workspaceRoot: cwd,
    cwd: join(cwd, "src"),
    touchedPaths: [],
  });

  assert.equal(bundle.trimmed, true);
  assert.deepEqual(bundle.fragments.map((fragment) => fragment.relativePath), ["src/AGENTS.md"]);
  assert.deepEqual(bundle.trimmedSources, ["AGENTS.md"]);
});

test("ContextBuilder injects instruction fragments before user message and tool observations", async () => {
  const cwd = await instructionWorkspace();
  const resolver = new InstructionResolver({ maxBytes: 1024 });
  const builder = new ContextBuilder({ instructionResolver: resolver });

  const context = await builder.build({
    sessionId: "instruction-order",
    userMessage: "read file",
    workspace: { cwd: join(cwd, "src"), root: cwd },
  });

  const normalized = context.messages.map((message) => (typeof message.content === "string" ? message.content : JSON.stringify(message.content)));
  assert.equal(normalized[0].includes("MVP-0 single-agent runtime"), true);
  assert.equal(normalized[1].includes("ROOT RULE"), true);
  assert.equal(normalized[2].includes("SRC RULE"), true);
  assert.equal(normalized.at(-1), "read file");
});

test("Touched-path-aware AGENTS scope activates on the next turn after a deep file read", async () => {
  const cwd = await instructionWorkspace();
  const eventStore = new JsonlEventStore(join(cwd, ".events.jsonl"));
  const resolver = new InstructionResolver({ maxBytes: 1024 });
  const builder = new ContextBuilder({ instructionResolver: resolver });
  const seenInstructionSets: string[][] = [];

  const runtime = new AgentRuntime({
    model: new FakeModelAdapter([], {
      responder: async (request, invocation) => {
        const instructionTexts = request.messages
          .filter((message) => message.role === "system" && typeof message.content === "string" && message.content.includes("RULE"))
          .map((message) => String(message.content));
        seenInstructionSets.push(instructionTexts);

        if (invocation === 1) {
          return {
            toolCalls: [{ id: "read-deep", name: "read_file", input: { path: "feature/file.txt" } }],
          };
        }
        return { finalMessage: "done" };
      },
    }),
    eventStore,
    contextBuilder: builder,
    permissionManager: new PermissionManager(),
    toolExecutor: new ToolExecutor(),
  });

  const first = await runtime.runTurn({
    sessionId: "instruction-scope",
    userMessage: "first turn",
    workspace: { cwd: join(cwd, "src"), root: cwd },
  });
  assert.equal(first.finishReason, "final_message");

  const second = await runtime.runTurn({
    sessionId: "instruction-scope",
    userMessage: "second turn",
    workspace: { cwd: join(cwd, "src"), root: cwd },
  });
  assert.equal(second.finishReason, "final_message");

  assert.deepEqual(seenInstructionSets[0], ["ROOT RULE", "SRC RULE"]);
  assert.deepEqual(seenInstructionSets.at(-1), ["ROOT RULE", "SRC RULE", "FEATURE RULE"]);

  const replay = Replay.fromEvents(await eventStore.forSession("instruction-scope"));
  assert.deepEqual(replay.instructions.at(0)?.appliedSources, ["AGENTS.md", "src/AGENTS.md"]);
  assert.deepEqual(replay.instructions.at(-1)?.appliedSources, ["AGENTS.md", "src/AGENTS.md", "src/feature/AGENTS.md"]);
});
