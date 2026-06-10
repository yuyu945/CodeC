import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

import { normalizeToolCall, PermissionManager, toolDefinitionsForUserMessage, ToolExecutor } from "../src/index.ts";

async function workspace() {
  const dir = await mkdtemp(join(tmpdir(), "codec-tools-"));
  await writeFile(join(dir, "file.txt"), "first line\nsecond line\n");
  return dir;
}

test("PermissionManager allows read/search inside workspace and denies path escape", async () => {
  const cwd = await workspace();
  const permissions = new PermissionManager();

  assert.equal(
    (await permissions.evaluate({ id: "1", name: "read_file", input: { path: "file.txt" } }, { cwd })).kind,
    "allow",
  );
  assert.equal(
    (await permissions.evaluate({ id: "2", name: "search_text", input: { pattern: "first", path: "." } }, { cwd }))
      .kind,
    "allow",
  );
  assert.equal(
    (await permissions.evaluate({ id: "3", name: "read_file", input: { path: "../outside.txt" } }, { cwd })).kind,
    "deny",
  );
});

test("PermissionManager asks for edits by default and allows edits under test policy", async () => {
  const cwd = await workspace();
  const defaultPermissions = new PermissionManager();
  const testPermissions = new PermissionManager({ allowEdits: true });

  assert.equal(
    (await defaultPermissions.evaluate({ id: "1", name: "edit_file", input: { path: "file.txt" } }, { cwd })).kind,
    "ask",
  );
  assert.equal(
    (await testPermissions.evaluate({ id: "2", name: "edit_file", input: { path: "file.txt" } }, { cwd })).kind,
    "allow",
  );
});

test("PermissionManager allows read-only shell and rejects risky shell", async () => {
  const cwd = await workspace();
  const permissions = new PermissionManager();

  assert.equal(
    (await permissions.evaluate({ id: "1", name: "shell", input: { command: "node --version" } }, { cwd })).kind,
    "allow",
  );
  assert.equal(
    (await permissions.evaluate({ id: "2", name: "shell", input: { command: "rm file.txt" } }, { cwd })).kind,
    "deny",
  );
  assert.equal(
    (await permissions.evaluate({ id: "3", name: "shell", input: { command: "git status" } }, { cwd })).kind,
    "ask",
  );
});

test("ToolExecutor normalizes read/search/edit/shell results", async () => {
  const cwd = await workspace();
  const tools = new ToolExecutor({ timeoutMs: 5000 });

  const read = await tools.execute({ id: "read", name: "read_file", input: { path: "file.txt" } }, { cwd });
  assert.equal(read.ok, true);
  assert.equal(read.output.path, "file.txt");
  assert.match(read.output.text, /first line/);

  const search = await tools.execute(
    { id: "search", name: "search_text", input: { pattern: "second", path: "." } },
    { cwd },
  );
  assert.equal(search.ok, true);
  assert.equal(search.output.matches.length, 1);

  const edit = await tools.execute(
    { id: "edit", name: "edit_file", input: { path: "file.txt", content: "updated\n" } },
    { cwd },
  );
  assert.equal(edit.ok, true);
  assert.notEqual(edit.metadata.beforeHash, edit.metadata.afterHash);
  assert.equal(await readFile(join(cwd, "file.txt"), "utf8"), "updated\n");

  const shell = await tools.execute({ id: "shell", name: "shell", input: { command: "node --version" } }, { cwd });
  assert.equal(shell.ok, true);
  assert.equal(shell.output.exitCode, 0);
  assert.match(shell.output.stdout, /^v/);
});

test("ToolExecutor redacts secrets from read_file and shell outputs", async () => {
  const cwd = await workspace();
  await writeFile(join(cwd, ".env"), "OPENAI_API_KEY=sk-secret-123\nTOKEN=abc123\n");
  const tools = new ToolExecutor({ timeoutMs: 5000 });

  const read = await tools.execute({ id: "read", name: "read_file", input: { path: ".env" } }, { cwd });
  assert.equal(read.ok, true);
  assert.doesNotMatch(read.output.text, /sk-secret-123/);
  assert.match(read.output.text, /\[REDACTED/);
  assert.equal(read.metadata.redacted, true);

  const shell = await tools.execute(
    { id: "shell", name: "shell", input: { command: 'node -e "console.log(`sk-secret-123`)"' } },
    { cwd },
  );
  assert.equal(shell.ok, true);
  assert.doesNotMatch(shell.output.stdout, /sk-secret-123/);
  assert.match(shell.output.stdout, /\[REDACTED/);
  assert.equal(shell.metadata.redacted, true);
});

test("search_text skips ignored directories and large files within a bounded scan budget", async () => {
  const cwd = await workspace();
  await mkdir(join(cwd, "node_modules"), { recursive: true });
  await mkdir(join(cwd, ".git"), { recursive: true });
  await writeFile(join(cwd, "notes.txt"), "needle in workspace\n");
  await writeFile(join(cwd, "big.log"), "x".repeat(300_000), "utf8");
  await writeFile(join(cwd, ".gitignore"), "needle in root\n", "utf8");
  await writeFile(join(cwd, "node_modules", "lib.js"), "needle hidden\n", "utf8");
  await writeFile(join(cwd, ".git", "config"), "needle hidden too\n", "utf8");

  const tools = new ToolExecutor({ maxSearchMatches: 10, maxSearchFiles: 10, maxFileBytes: 32_000 });
  const search = await tools.execute(
    { id: "search", name: "search_text", input: { pattern: "needle", path: "." } },
    { cwd },
  );

  assert.equal(search.ok, true);
  assert.deepEqual(
    search.output.matches.map((match) => match.path).sort(),
    [".gitignore", "notes.txt"],
  );
  assert.equal(search.metadata.skippedLargeFiles, 1);
  assert.equal(search.metadata.scannedFiles, 3);
  assert.equal(search.metadata.budgetExceeded, false);
});

test("toolDefinitionsForUserMessage narrows structure questions to read-only exploration tools", () => {
  const tools = toolDefinitionsForUserMessage("我的项目结构是什么");
  assert.deepEqual(
    tools.map((tool) => tool.name),
    ["read_file", "search_text"],
  );
});

test("normalizeToolCall repairs common nested or aliased tool input shapes", () => {
  assert.deepEqual(
    normalizeToolCall({ id: "1", name: "read_file", input: { input: { file: "package.json" } } }),
    { id: "1", name: "read_file", input: { path: "package.json" } },
  );
  assert.deepEqual(
    normalizeToolCall({ id: "2", name: "search_text", input: { query: "needle", file: "." } }),
    { id: "2", name: "search_text", input: { pattern: "needle", path: "." } },
  );
  assert.deepEqual(
    normalizeToolCall({ id: "3", name: "shell", input: { cmd: "node --version" } }),
    { id: "3", name: "shell", input: { command: "node --version" } },
  );
  assert.deepEqual(
    normalizeToolCall({ id: "4", name: "edit_file", input: { filepath: "file.txt", text: "updated\n" } }),
    { id: "4", name: "edit_file", input: { path: "file.txt", content: "updated\n" } },
  );
});
