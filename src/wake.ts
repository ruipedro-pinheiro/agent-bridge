import {
  createCodexAppServerTransport,
  createCodexStdioTransport,
  wakeCodexThread,
  type CodexWakeResult,
} from "./codex-app-server.ts";
import { normalizeLoopbackHttpBaseUrl } from "./config.ts";

let proxyUnavailable = false;

export interface OpencodeWakeTarget {
  type: "opencode";
  baseUrl: string;
  prompt: string;
  debounceSeconds: number;
  maxWakesPerHour: number;
}

export interface CodexWakeTarget {
  type: "codex";
  command: string;
  prompt: string;
  debounceSeconds: number;
  maxWakesPerHour: number;
  retryDelaysSeconds: number[];
}

export type WakeTarget = OpencodeWakeTarget | CodexWakeTarget;
export type WakeResult = CodexWakeResult;


interface OpencodeSession {
  id: string;
  parentID?: string;
  title?: string;
  time?: { created?: number; updated?: number };
}

const FETCH_TIMEOUT_MS = 5000;

export async function wakeOpencode(target: OpencodeWakeTarget): Promise<WakeResult> {
  let baseUrl: string;
  try {
    baseUrl = normalizeLoopbackHttpBaseUrl(target.baseUrl);
  } catch (error) {
    return {
      disposition: "failed",
      detail: error instanceof Error ? error.message : String(error),
    };
  }

  let sessions: OpencodeSession[];
  try {
    const res = await fetch(`${baseUrl}/session`, {
      signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
    });
    if (!res.ok) return { disposition: "failed", detail: `GET /session -> ${res.status}` };
    sessions = (await res.json()) as OpencodeSession[];
  } catch (err) {
    return { disposition: "failed", detail: `opencode unreachable: ${String(err)}` };
  }

  const candidates = sessions
    .filter((s) => !s.parentID)
    .sort((a, b) => (b.time?.updated ?? 0) - (a.time?.updated ?? 0));
  if (candidates.length === 0) return { disposition: "failed", detail: "no opencode session to wake" };

  const session = candidates[0];
  try {
    const res = await fetch(`${baseUrl}/session/${encodeURIComponent(session.id)}/prompt_async`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ parts: [{ type: "text", text: target.prompt }] }),
      signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
    });
    if (res.status === 204 || res.ok) {
      return { disposition: "started", detail: `woke session ${session.id} (${session.title ?? "untitled"})` };
    }
    return { disposition: "failed", detail: `POST prompt_async -> ${res.status}: ${await res.text()}` };
  } catch (err) {
    return { disposition: "failed", detail: `wake failed: ${String(err)}` };
  }
}

export async function wakeCodex(
  command: string,
  input: { sessionId: string; mailbox: string; prompt: string; timeoutMs?: number },
): Promise<CodexWakeResult> {
  const timeoutMs = input.timeoutMs ?? 5000;
  const wakeInput = { ...input, timeoutMs };
  try {
    if (!proxyUnavailable) {
      const transport = await createCodexAppServerTransport(command, timeoutMs);
      const result = await wakeCodexThread(transport, wakeInput);
      if (
        result.disposition !== "failed" ||
        (!result.detail.includes("initialize failed: timeout") &&
          !result.detail.includes("proxy exited early"))
      ) {
        return result;
      }
      proxyUnavailable = true;
    }

    // stdio JSONL fallback, some Codex builds cannot attach via the proxy command
    return wakeCodexThread(createCodexStdioTransport(command), wakeInput);
  } catch (error) {
    try {
      proxyUnavailable = true;
      return wakeCodexThread(createCodexStdioTransport(command), wakeInput);
    } catch (fallbackError) {
      return {
        disposition: "failed",
        detail: fallbackError instanceof Error ? fallbackError.message : String(fallbackError),
      };
    }
  }
}
