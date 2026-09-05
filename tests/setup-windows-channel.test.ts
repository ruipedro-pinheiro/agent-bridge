import { describe, expect, test } from "bun:test";
import { readFileSync } from "fs";
import { join } from "path";

const ROOT = join(import.meta.dir, "..");

describe("Windows channel setup script", () => {
  test("is minimal and avoids writing Claude config or printing tokens", () => {
    const script = readFileSync(join(ROOT, "scripts", "setup-windows-channel.ps1"), "utf8");

    expect(script).toContain("param(");
    expect(script).toContain("Get-Command bun");
    expect(script).toContain("Copy-Item");
    expect(script).toContain("auth.ts");
    expect(script).toContain("config.ts");
    expect(script).toContain("token-env.ts");
    expect(script).toContain(".claude.json MCP entry");
    expect(script).toContain("AGENT_BRIDGE_CLAUDE_TOKEN");
    expect(script).not.toContain("Set-Content $claudeJson");
    expect(script).not.toContain("Add-Content $claudeJson");
    expect(script).not.toContain("Write-Output $env:AGENT_BRIDGE_TOKEN");
    expect(script).not.toContain("Write-Host $env:AGENT_BRIDGE_TOKEN");
  });
});
