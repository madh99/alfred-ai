/**
 * v850 — Tool-Registry für Alfred MCP-Server.
 *
 * Jeder Tool hat ein JSON-Schema für MCP-clients + einen handler der Daten
 * aus dem DB-Adapter zurückgibt. Alle Tools sind READ-ONLY in v850.
 *
 * Tool-Naming-Convention: `alfred.<domain>.<verb>` (z.B. `alfred.memory.recall`).
 * Das hilft Agents bei der Unterscheidung von alfred-tools vs ihre eigenen.
 */

import type { McpServerDeps } from '../types.js';
import { memoryRecallTool } from './memory.js';
import { kgQueryTool } from './kg.js';
import { projectConventionsTool } from './project.js';
import { featuresFindTool } from './features.js';
import { runbookFindTool } from './runbook.js';

export interface McpTool {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
  handler: (args: Record<string, unknown>, deps: McpServerDeps) => Promise<unknown>;
}

export function getAllTools(): McpTool[] {
  return [
    memoryRecallTool,
    kgQueryTool,
    projectConventionsTool,
    featuresFindTool,
    runbookFindTool,
  ];
}

export function findTool(name: string): McpTool | undefined {
  return getAllTools().find(t => t.name === name);
}
