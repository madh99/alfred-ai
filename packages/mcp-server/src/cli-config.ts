/**
 * v850 — CLI-Config-Generation für die drei Agents.
 *
 * Jeder CLI hat sein eigenes Config-Format:
 *   claude:  JSON mit `mcpServers: { name: { command, args, env } }`
 *   codex:   TOML mit `[mcp_servers.name]` Block
 *   vibe:    TOML mit `[[mcp_servers]]` Array
 *
 * Diese Module sind PURE generators — sie schreiben keine Files, sie liefern
 * den gerenderten Content. Patching auf Disk macht `cli-config-patcher.ts`
 * (idempotent: Alfred-Block wird ersetzt, andere User-MCP-Server bleiben).
 */

import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'node:fs';
import path from 'node:path';
import os from 'node:os';

const ALFRED_MCP_NAME = 'alfred';

/**
 * Claude-Code MCP-Config-Snippet.
 * Format: JSON. Pfad: `~/.claude/mcp.json` (global) ODER via `--mcp-config <file>`.
 */
export function generateMcpConfigForClaude(alfredCommand: string, alfredArgs: string[]): {
  mcpServers: Record<string, { command: string; args: string[] }>;
} {
  return {
    mcpServers: {
      [ALFRED_MCP_NAME]: {
        command: alfredCommand,
        args: alfredArgs,
        // env wird per-spawn von alfred übergeben (ALFRED_MCP_TOKEN)
      },
    },
  };
}

/**
 * Codex MCP-Config TOML-Block.
 * Format: TOML. Pfad: `~/.codex/config.toml`.
 *
 * codex erwartet `[mcp_servers.NAME]` als Inline-Tabellen-Pfad.
 */
export function generateMcpConfigForCodex(alfredCommand: string, alfredArgs: string[]): string {
  const argsArray = JSON.stringify(alfredArgs);
  return `# ─── Alfred MCP Server (managed by alfred, do not edit) ───
[mcp_servers.${ALFRED_MCP_NAME}]
command = ${JSON.stringify(alfredCommand)}
args = ${argsArray}
# ─── /Alfred ───
`;
}

/**
 * Vibe MCP-Config TOML-Array-Block.
 * Format: TOML. Pfad: `~/.vibe/config.toml`.
 *
 * vibe erwartet `[[mcp_servers]]` als Array-of-Tables.
 */
export function generateMcpConfigForVibe(alfredCommand: string, alfredArgs: string[]): string {
  const argsArray = JSON.stringify(alfredArgs);
  return `# ─── Alfred MCP Server (managed by alfred, do not edit) ───
[[mcp_servers]]
name = ${JSON.stringify(ALFRED_MCP_NAME)}
transport = "stdio"
command = ${JSON.stringify(alfredCommand)}
args = ${argsArray}
# ─── /Alfred ───
`;
}

/**
 * Patcht eine claude `mcp.json`-Datei idempotent.
 * Existierende user-mcpServers bleiben erhalten, alfred-Block wird ersetzt.
 */
export function patchClaudeMcpConfig(configPath: string, alfredCommand: string, alfredArgs: string[]): { changed: boolean; reason: string } {
  const newAlfred = { command: alfredCommand, args: alfredArgs };
  let current: { mcpServers?: Record<string, unknown> } = {};
  if (existsSync(configPath)) {
    try { current = JSON.parse(readFileSync(configPath, 'utf-8')); } catch { /* corrupt, overwrite */ }
  } else {
    mkdirSync(path.dirname(configPath), { recursive: true });
  }
  if (!current.mcpServers) current.mcpServers = {};
  const existing = current.mcpServers[ALFRED_MCP_NAME];
  if (existing && JSON.stringify(existing) === JSON.stringify(newAlfred)) {
    return { changed: false, reason: 'already up to date' };
  }
  current.mcpServers[ALFRED_MCP_NAME] = newAlfred;
  writeFileSync(configPath, JSON.stringify(current, null, 2));
  return { changed: true, reason: existing ? 'updated' : 'inserted' };
}

/**
 * Patcht codex' config.toml idempotent.
 * Alfred-Block wird durch Marker `# ─── Alfred MCP Server` identifiziert.
 */
export function patchCodexMcpConfig(configPath: string, alfredCommand: string, alfredArgs: string[]): { changed: boolean; reason: string } {
  const newBlock = generateMcpConfigForCodex(alfredCommand, alfredArgs);
  return patchTomlBlock(configPath, newBlock, '# ─── Alfred MCP Server', '# ─── /Alfred ───');
}

/**
 * Patcht vibe' config.toml idempotent.
 * Alfred-Block wird durch Marker identifiziert.
 */
export function patchVibeMcpConfig(configPath: string, alfredCommand: string, alfredArgs: string[]): { changed: boolean; reason: string } {
  const newBlock = generateMcpConfigForVibe(alfredCommand, alfredArgs);
  return patchTomlBlock(configPath, newBlock, '# ─── Alfred MCP Server', '# ─── /Alfred ───');
}

/**
 * Generischer TOML-Block-Patcher mit Markern.
 * Idempotent: wenn Block schon ident → no-op. Sonst replace zwischen Markern,
 * oder append am Ende der Datei.
 */
function patchTomlBlock(
  configPath: string,
  newBlock: string,
  startMarker: string,
  endMarker: string,
): { changed: boolean; reason: string } {
  let content = '';
  if (existsSync(configPath)) {
    content = readFileSync(configPath, 'utf-8');
  } else {
    mkdirSync(path.dirname(configPath), { recursive: true });
  }
  const startIdx = content.indexOf(startMarker);
  const endIdx = content.indexOf(endMarker);
  if (startIdx >= 0 && endIdx > startIdx) {
    // Block existiert — vergleichen + ggf. ersetzen
    const existing = content.slice(startIdx, endIdx + endMarker.length);
    const newTrimmed = newBlock.trim();
    const existingTrimmed = existing.trim();
    if (existingTrimmed === newTrimmed) {
      return { changed: false, reason: 'already up to date' };
    }
    const before = content.slice(0, startIdx);
    const after = content.slice(endIdx + endMarker.length);
    writeFileSync(configPath, before + newTrimmed + after);
    return { changed: true, reason: 'updated' };
  } else {
    // Block fehlt — anhängen mit leading newline
    const sep = content.length > 0 && !content.endsWith('\n') ? '\n\n' : '\n';
    writeFileSync(configPath, content + sep + newBlock);
    return { changed: true, reason: 'inserted' };
  }
}

/**
 * Default config-Pfade pro Agent.
 */
export function defaultClaudeMcpPath(homeDir?: string): string {
  return path.join(homeDir ?? os.homedir(), '.claude', 'mcp.json');
}
export function defaultCodexConfigPath(homeDir?: string): string {
  return path.join(homeDir ?? os.homedir(), '.codex', 'config.toml');
}
export function defaultVibeConfigPath(homeDir?: string): string {
  return path.join(homeDir ?? os.homedir(), '.vibe', 'config.toml');
}
