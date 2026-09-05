param(
  [string]$SourceDir = (Get-Location).Path,
  [string]$ChannelDir = (Join-Path $env:LOCALAPPDATA "agent-bridge-channel"),
  [string]$BridgeUrl = "http://127.0.0.1:7447",
  [Parameter(Mandatory = $true)]
  [string]$Mailbox
)

$ErrorActionPreference = "Stop"

if (-not (Get-Command bun -ErrorAction SilentlyContinue)) {
  throw "bun is required. Install it first, then re-run this script."
}

$source = Resolve-Path $SourceDir
$srcDir = Join-Path $source "src"
foreach ($path in @(
  (Join-Path $srcDir "channel-shim.ts"),
  (Join-Path $srcDir "channel-config.ts"),
  (Join-Path $source "package.json"),
  (Join-Path $source "bun.lock")
)) {
  if (-not (Test-Path $path)) { throw "Missing required source file: $path" }
}

New-Item -ItemType Directory -Force -Path (Join-Path $ChannelDir "src") | Out-Null
Copy-Item (Join-Path $srcDir "channel-shim.ts") (Join-Path $ChannelDir "src/channel-shim.ts") -Force
Copy-Item (Join-Path $srcDir "channel-config.ts") (Join-Path $ChannelDir "src/channel-config.ts") -Force
Copy-Item (Join-Path $source "package.json") (Join-Path $ChannelDir "package.json") -Force
Copy-Item (Join-Path $source "bun.lock") (Join-Path $ChannelDir "bun.lock") -Force

Push-Location $ChannelDir
try {
  bun install --production --frozen-lockfile
} finally {
  Pop-Location
}

$shimPath = (Join-Path $ChannelDir "src/channel-shim.ts") -replace '\\', '/'
$entry = [ordered]@{
  mcpServers = [ordered]@{
    "agent-bridge-channel" = [ordered]@{
      command = "bun"
      args = @("run", $shimPath)
      env = [ordered]@{
        AGENT_BRIDGE_URL = $BridgeUrl
        AGENT_BRIDGE_MAILBOX = $Mailbox
      }
    }
  }
}

Write-Host "Installed agent-bridge channel files in: $ChannelDir"
Write-Host "Add this .claude.json MCP entry manually; this script does not edit ~/.claude.json."
Write-Host "If your bridge requires AGENT_BRIDGE_TOKEN, set it in your user environment or add it yourself without sharing it."
$entry | ConvertTo-Json -Depth 8
