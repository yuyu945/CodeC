import { executeMemoryCli } from "./src/index.ts";

const result = await executeMemoryCli(process.argv.slice(2));
if (result.stdout) process.stdout.write(result.stdout);
if (result.stderr) process.stderr.write(result.stderr);
process.exitCode = result.exitCode;
