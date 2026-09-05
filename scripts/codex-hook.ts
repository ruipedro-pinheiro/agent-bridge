const url = process.env.AGENT_BRIDGE_CODEX_HOOK_URL ?? "http://127.0.0.1:7447/codex/hook";
const configuredTimeout = Number(process.env.AGENT_BRIDGE_CODEX_HOOK_TIMEOUT_MS ?? 2000);
const timeoutMs = Number.isFinite(configuredTimeout) && configuredTimeout > 0 ? configuredTimeout : 2000;

function failOpen(error: unknown): void {
  console.error(`[agent-bridge codex hook] ${error instanceof Error ? error.message : String(error)}`);
  console.log("{}");
}

try {
  const text = await Bun.stdin.text();
  const payload = JSON.parse(text) as unknown;
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) {
    throw new Error("stdin must contain one JSON object");
  }

  const response = await fetch(url, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(payload),
    signal: AbortSignal.timeout(timeoutMs),
  });
  if (response.status >= 500) throw new Error(`bridge returned HTTP ${response.status}`);

  const body = (await response.json()) as unknown;
  if (!body || typeof body !== "object" || Array.isArray(body)) {
    throw new Error("bridge returned invalid JSON");
  }
  console.log(JSON.stringify(body));
} catch (error) {
  failOpen(error);
}

export {};
