import assert from "node:assert/strict";
import { test } from "node:test";

import { AgentRuntime, ContextBuilder, JsonlEventStore, PermissionManager, Replay, ToolExecutor } from "../src/index.ts";
import * as runtimeModule from "../src/runtime.ts";
import * as contextModule from "../src/context.ts";
import * as eventModule from "../src/events.ts";
import * as permissionModule from "../src/permissions.ts";
import * as replayModule from "../src/replay.ts";
import * as toolModule from "../src/tools.ts";
import * as typesModule from "../src/types.ts";

test("split modules remain importable and barrel exports preserve the public surface", () => {
  assert.equal(typeof AgentRuntime, "function");
  assert.equal(typeof ContextBuilder, "function");
  assert.equal(typeof JsonlEventStore, "function");
  assert.equal(typeof PermissionManager, "function");
  assert.equal(typeof Replay, "function");
  assert.equal(typeof ToolExecutor, "function");

  assert.equal(runtimeModule.AgentRuntime, AgentRuntime);
  assert.equal(contextModule.ContextBuilder, ContextBuilder);
  assert.equal(eventModule.JsonlEventStore, JsonlEventStore);
  assert.equal(permissionModule.PermissionManager, PermissionManager);
  assert.equal(replayModule.Replay, Replay);
  assert.equal(toolModule.ToolExecutor, ToolExecutor);
  assert.equal(typeof typesModule, "object");
});
