import type { AgentSessionRef } from "../../agents/sessions/types.js";

/**
 * Telegram callback payloads are capped at 64 bytes. Provider session ids are
 * UUID-shaped and fit comfortably, but an unexpected long id must not produce a
 * button the API will reject, so such rows are listed without one.
 */
export const SESSION_CALLBACK_PREFIX = "sr:";
const MAX_CALLBACK_BYTES = 64;

export function buildSessionCallbackData(sessionId: string): string | null {
  const data = `${SESSION_CALLBACK_PREFIX}${String(sessionId ?? "").trim()}`;
  if (data === SESSION_CALLBACK_PREFIX || Buffer.byteLength(data, "utf8") > MAX_CALLBACK_BYTES) {
    return null;
  }
  return data;
}

export function parseSessionCallbackData(data: unknown): string | null {
  const text = String(data ?? "");
  if (!text.startsWith(SESSION_CALLBACK_PREFIX)) {
    return null;
  }
  return text.slice(SESSION_CALLBACK_PREFIX.length).trim() || null;
}

function formatAge(updatedAt: number, now: number): string {
  const minutes = Math.round((now - updatedAt) / 60_000);
  if (!Number.isFinite(minutes) || minutes < 1) return "刚刚";
  if (minutes < 60) return `${minutes} 分钟前`;
  const hours = Math.round(minutes / 60);
  if (hours < 24) return `${hours} 小时前`;
  return `${Math.round(hours / 24)} 天前`;
}

function rowLabel(session: AgentSessionRef, index: number): string {
  const title = session.title?.trim() || session.preview?.trim() || session.sessionId.slice(0, 8);
  // Telegram truncates long button labels mid-glyph; cut on a character boundary.
  const trimmed = Array.from(title).slice(0, 24).join("");
  return `${index + 1}. ${trimmed}${Array.from(title).length > 24 ? "…" : ""}`;
}

export interface SessionListMessage {
  text: string;
  buttons: Array<{ label: string; data: string }>;
}

/**
 * Render the picker as a Telegram message plus one button per resumable row.
 * Mirrors the web picker's disclosures: provenance, age, and what was folded
 * away, so a short list never reads as "nothing else exists".
 */
export function formatSessionListMessage(args: {
  items: AgentSessionRef[];
  agentId: string;
  cwd: string;
  now?: number;
  degraded?: string[];
  hidden?: { singleTurn: number; duplicates: number; forks: number };
}): SessionListMessage {
  const now = args.now ?? Date.now();
  if (args.items.length === 0) {
    return {
      text: `📭 ${args.agentId} 在 ${args.cwd} 下没有找到可恢复的会话`,
      buttons: [],
    };
  }

  const lines = [`🗂 ${args.agentId} 最近会话（${args.cwd}）`, ""];
  const buttons: SessionListMessage["buttons"] = [];

  args.items.forEach((session, index) => {
    const marks: string[] = [];
    if (session.isCurrent) marks.push("当前");
    if ((session.forkCount ?? 1) > 1) marks.push(`分支 ${session.forkCount}`);
    const suffix = marks.length > 0 ? `［${marks.join(" · ")}］` : "";
    lines.push(`${rowLabel(session, index)} ${suffix}`.trimEnd());
    lines.push(`   ${formatAge(session.updatedAt, now)} · ${session.sessionId.slice(0, 8)}`);

    const data = buildSessionCallbackData(session.sessionId);
    if (data) {
      buttons.push({ label: rowLabel(session, index), data });
    }
  });

  const folded = args.hidden?.forks ?? 0;
  if (folded > 0) {
    lines.push("", `已合并 ${folded} 个同对话的历史分支，只保留最新的一个`);
  }
  const noise = (args.hidden?.singleTurn ?? 0) + (args.hidden?.duplicates ?? 0);
  if (noise > 0) {
    lines.push(`已隐藏 ${noise} 个一次性/重名会话`);
  }
  if (args.degraded && args.degraded.length > 0) {
    lines.push("⚠️ 部分来源不可用，列表可能不完整");
  }
  lines.push("", "点击下方按钮恢复对应会话，下一条消息将接续它的上下文。");

  return { text: lines.join("\n"), buttons };
}
