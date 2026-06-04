import { randomUUID } from "node:crypto";
import { appendFile, mkdir, readFile } from "node:fs/promises";
import { dirname } from "node:path";

import type { AgentEvent } from "./types.ts";

export class JsonlEventStore {
  private readonly filePath: string;
  private sequences = new Map<string, number>();

  constructor(filePath: string) {
    this.filePath = filePath;
  }

  async append(event: Omit<AgentEvent, "id" | "sequence" | "timestamp">): Promise<AgentEvent> {
    const sessionId = event.sessionId;
    const nextSequence = (this.sequences.get(sessionId) ?? (await this.loadLastSequence(sessionId))) + 1;
    this.sequences.set(sessionId, nextSequence);
    const fullEvent = {
      ...event,
      id: randomUUID(),
      sequence: nextSequence,
      timestamp: new Date().toISOString(),
    } as AgentEvent;

    await mkdir(dirname(this.filePath), { recursive: true });
    await appendFile(this.filePath, `${JSON.stringify(fullEvent)}\n`, "utf8");
    return fullEvent;
  }

  async forSession(sessionId: string): Promise<AgentEvent[]> {
    const all = await this.readAll();
    return all.filter((event) => event.sessionId === sessionId).sort((a, b) => a.sequence - b.sequence);
  }

  private async loadLastSequence(sessionId: string): Promise<number> {
    const events = await this.forSession(sessionId);
    return events.at(-1)?.sequence ?? 0;
  }

  private async readAll(): Promise<AgentEvent[]> {
    try {
      const text = await readFile(this.filePath, "utf8");
      return text
        .split(/\r?\n/)
        .filter(Boolean)
        .map((line) => JSON.parse(line) as AgentEvent);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
      throw error;
    }
  }
}
