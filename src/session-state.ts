import { mkdir, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";

import type {
  PersistedPendingApprovalSnapshot,
  PersistedSessionMetadata,
  PersistedSessionState,
  ResumeCandidate,
  SessionStateStore,
} from "./types.ts";

export class FileSessionStateStore implements SessionStateStore {
  private readonly directoryPath: string;

  constructor(directoryPath: string) {
    this.directoryPath = directoryPath;
  }

  async savePending(snapshot: PersistedPendingApprovalSnapshot, metadata: PersistedSessionMetadata): Promise<void> {
    const state: PersistedSessionState = {
      updatedAt: new Date().toISOString(),
      metadata,
      pending: snapshot,
    };
    await mkdir(this.directoryPath, { recursive: true });
    await writeFile(this.filePath(snapshot.sessionId), JSON.stringify(state, null, 2), "utf8");
  }

  async listPending(): Promise<ResumeCandidate[]> {
    const entries = await this.readAllStates();
    return entries
      .map((state) => ({
        sessionId: state.pending.sessionId,
        approvalId: state.pending.approvalId,
        toolName: state.pending.pendingCall.name,
        updatedAt: state.updatedAt,
        metadata: state.metadata,
      }))
      .sort((left, right) => {
        if (left.updatedAt !== right.updatedAt) return left.updatedAt.localeCompare(right.updatedAt);
        return left.sessionId.localeCompare(right.sessionId);
      });
  }

  async loadPending(sessionId: string): Promise<PersistedSessionState | undefined> {
    try {
      return parsePersistedState(await readFile(this.filePath(sessionId), "utf8"));
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
      throw error;
    }
  }

  async clearPending(sessionId: string): Promise<void> {
    await rm(this.filePath(sessionId), { force: true });
  }

  private async readAllStates(): Promise<PersistedSessionState[]> {
    try {
      const names = await readdir(this.directoryPath);
      const states = await Promise.all(
        names
          .filter((name) => name.endsWith(".json"))
          .map(async (name) => parsePersistedState(await readFile(join(this.directoryPath, name), "utf8"))),
      );
      return states;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
      throw error;
    }
  }

  private filePath(sessionId: string): string {
    return join(this.directoryPath, `${encodeURIComponent(sessionId)}.json`);
  }
}

function parsePersistedState(text: string): PersistedSessionState {
  const parsed = JSON.parse(text) as PersistedSessionState;
  if (!parsed?.pending?.sessionId || !parsed?.pending?.approvalId || !parsed?.metadata?.provider || !parsed.updatedAt) {
    throw new Error("resume_state_invalid");
  }
  return parsed;
}
