import { access, readFile } from "node:fs/promises";
import { dirname, isAbsolute, relative, resolve } from "node:path";

import type { InstructionBundle, InstructionFragment, InstructionSource } from "./types.ts";
import { hashJson, redactSecretsInString } from "./shared.ts";

export class InstructionResolver {
  private readonly maxBytes: number;

  constructor(options: { maxBytes?: number } = {}) {
    this.maxBytes = options.maxBytes ?? 4_096;
  }

  async resolve(input: {
    workspaceRoot: string;
    cwd: string;
    touchedPaths: string[];
  }): Promise<InstructionBundle> {
    const workspaceRoot = resolve(input.workspaceRoot);
    const cwd = resolve(input.cwd);
    const directorySet = new Set<string>(directoryChain(cwd, workspaceRoot));

    for (const touchedPath of input.touchedPaths) {
      const absolute = isAbsolute(touchedPath) ? resolve(touchedPath) : resolve(workspaceRoot, touchedPath);
      for (const directory of directoryChain(dirname(absolute), workspaceRoot)) {
        directorySet.add(directory);
      }
    }

    const orderedDirectories = [...directorySet].sort((left, right) => left.length - right.length);
    const sources: InstructionSource[] = [];

    for (const directory of orderedDirectories) {
      const candidate = resolve(directory, "AGENTS.md");
      if (!(await exists(candidate))) continue;
      const rawText = await readFile(candidate, "utf8");
      const normalized = normalizeInstruction(rawText);
      const redacted = redactSecretsInString(normalized);
      const relativePath = relative(workspaceRoot, candidate).replaceAll("\\", "/") || "AGENTS.md";
      sources.push({
        absolutePath: candidate,
        relativePath,
        scopeDepth: depthFromRoot(directory, workspaceRoot),
        byteSize: Buffer.byteLength(redacted.text),
        rawText,
        normalizedText: redacted.text,
      });
    }

    let totalBytes = 0;
    const kept: InstructionSource[] = [];
    const trimmedSources: string[] = [];

    for (const source of [...sources].sort((left, right) => right.scopeDepth - left.scopeDepth)) {
      if (totalBytes + source.byteSize <= this.maxBytes) {
        kept.push(source);
        totalBytes += source.byteSize;
      } else {
        trimmedSources.push(source.relativePath);
      }
    }

    const orderedKept = kept.sort((left, right) => left.scopeDepth - right.scopeDepth);
    const fragments: InstructionFragment[] = orderedKept.map((source) => ({
      ...source,
      priority: 80 + source.scopeDepth,
      pinned: true,
    }));

    return {
      fragments,
      sources: orderedKept,
      totalBytes,
      trimmed: trimmedSources.length > 0,
      trimmedSources: trimmedSources.sort(),
    };
  }
}

export function instructionHash(bundle: InstructionBundle): string {
  return hashJson(bundle.sources.map((source) => source.relativePath));
}

function normalizeInstruction(value: string): string {
  return value.trim().replace(/\r\n/g, "\n");
}

function directoryChain(start: string, root: string): string[] {
  const chain: string[] = [];
  let current = resolve(start);
  const resolvedRoot = resolve(root);

  while (current.startsWith(resolvedRoot)) {
    chain.push(current);
    if (current === resolvedRoot) break;
    current = dirname(current);
  }

  return chain.reverse();
}

function depthFromRoot(directory: string, root: string): number {
  const relativePath = relative(resolve(root), resolve(directory));
  return relativePath ? relativePath.split(/[\\/]/).length : 0;
}

async function exists(pathValue: string): Promise<boolean> {
  try {
    await access(pathValue);
    return true;
  } catch {
    return false;
  }
}
