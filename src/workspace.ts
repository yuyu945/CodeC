import { extname, isAbsolute, join, relative, resolve } from "node:path";
import { readdir, stat } from "node:fs/promises";

export function isInsideWorkspace(pathValue: string, cwd: string): boolean {
  try {
    resolveWorkspacePath(pathValue, cwd);
    return true;
  } catch {
    return false;
  }
}

export function resolveWorkspacePath(pathValue: string, cwd: string): string {
  const workspace = resolve(cwd);
  const target = isAbsolute(pathValue) ? resolve(pathValue) : resolve(workspace, pathValue);
  const rel = relative(workspace, target);
  if (rel === "" || (!rel.startsWith("..") && !isAbsolute(rel))) return target;
  throw new Error("path_outside_workspace");
}

export function normalizeRelative(cwd: string, absolutePath: string): string {
  return relative(resolve(cwd), absolutePath).replaceAll("\\", "/");
}

export async function listFiles(
  root: string,
  options: {
    ignoredDirectories?: string[];
    maxFiles?: number;
    maxFileBytes?: number;
  } = {},
): Promise<{ files: string[]; scannedFiles: number; skippedLargeFiles: number; budgetExceeded: boolean }> {
  const ignoredDirectories = new Set(options.ignoredDirectories ?? [".git", "node_modules", ".next", "dist", "build", "coverage"]);
  const maxFiles = options.maxFiles ?? 500;
  const maxFileBytes = options.maxFileBytes ?? 256_000;
  const info = await stat(root);
  if (info.isFile()) {
    return info.size <= maxFileBytes && isProbablyTextFile(root)
      ? { files: [root], scannedFiles: 1, skippedLargeFiles: 0, budgetExceeded: false }
      : { files: [], scannedFiles: 0, skippedLargeFiles: info.size > maxFileBytes ? 1 : 0, budgetExceeded: false };
  }
  const files: string[] = [];
  let scannedFiles = 0;
  let skippedLargeFiles = 0;
  let budgetExceeded = false;

  const walk = async (directory: string): Promise<void> => {
    if (budgetExceeded) return;
    const entries = (await readdir(directory, { withFileTypes: true })).sort((left, right) => left.name.localeCompare(right.name));
    for (const entry of entries) {
      if (budgetExceeded) return;
      if (entry.name === ".events.jsonl") continue;
      const absolute = join(directory, entry.name);
      if (entry.isDirectory()) {
        if (!ignoredDirectories.has(entry.name)) {
          await walk(absolute);
        }
        continue;
      }
      if (!entry.isFile()) continue;
      if (!isProbablyTextFile(absolute)) continue;
      const fileInfo = await stat(absolute);
      if (fileInfo.size > maxFileBytes) {
        skippedLargeFiles += 1;
        continue;
      }
      scannedFiles += 1;
      files.push(absolute);
      if (scannedFiles >= maxFiles) {
        budgetExceeded = true;
        return;
      }
    }
  };

  await walk(root);
  return { files, scannedFiles, skippedLargeFiles, budgetExceeded };
}

function isProbablyTextFile(pathValue: string): boolean {
  const extension = extname(pathValue).toLowerCase();
  const ignoredBinaryExtensions = new Set([".png", ".jpg", ".jpeg", ".gif", ".bmp", ".webp", ".ico", ".pdf", ".zip", ".gz", ".tar", ".exe", ".dll", ".so", ".bin"]);
  return !ignoredBinaryExtensions.has(extension);
}
