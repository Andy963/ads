import { truncateForLog } from "../../utils.js";

export interface DelegationTracker {
  stash(agentId: string, prompt: string): string;
  pop(agentId: string, prompt: string): string;
}

function delegationFingerprint(agentId: string, prompt: string): string {
  return `${String(agentId ?? "").trim().toLowerCase()}:${truncateForLog(prompt, 200)}`;
}

function nextDelegationId(): string {
  return `${Date.now()}-${Math.random().toString(16).slice(2)}`;
}

export function createDelegationTracker(): DelegationTracker {
  const idsByFingerprint = new Map<string, string[]>();

  return {
    stash(agentId: string, prompt: string): string {
      const fp = delegationFingerprint(agentId, prompt);
      const existing = idsByFingerprint.get(fp) ?? [];
      const id = nextDelegationId();
      idsByFingerprint.set(fp, [...existing, id]);
      return id;
    },
    pop(agentId: string, prompt: string): string {
      const fp = delegationFingerprint(agentId, prompt);
      const existing = idsByFingerprint.get(fp) ?? [];
      if (existing.length === 0) {
        return nextDelegationId();
      }
      const [head, ...tail] = existing;
      if (tail.length > 0) idsByFingerprint.set(fp, tail);
      else idsByFingerprint.delete(fp);
      return head!;
    },
  };
}
