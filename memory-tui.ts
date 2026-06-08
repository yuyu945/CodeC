import readline from "node:readline";

import { executeMemoryTuiCommand, FileMemoryStore, LocalMemoryManager, LocalMemorySurface, LocalMemoryTuiController } from "./src/index.ts";

const cwd = process.cwd();
const store = new FileMemoryStore(`${cwd}\\.memory.jsonl`);
const surface = new LocalMemorySurface(new LocalMemoryManager(store));
const controller = new LocalMemoryTuiController(surface);

await controller.load();
const initial = await executeMemoryTuiCommand("list", controller);
if (initial.output) process.stdout.write(initial.output);

const rl = readline.createInterface({
  input: process.stdin,
  output: process.stdout,
  prompt: "memory> ",
});

rl.prompt();
rl.on("line", async (line) => {
  const result = await executeMemoryTuiCommand(line, controller);
  if (result.output) process.stdout.write(result.output);
  if (result.done) {
    rl.close();
    return;
  }
  rl.prompt();
});
