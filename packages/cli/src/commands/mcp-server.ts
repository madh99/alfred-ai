/**
 * v850 — `alfred mcp-server` CLI subcommand.
 *
 * Startet alfred als stdio-MCP-Server. Wird vom CLI-Agent (claude-code,
 * codex, vibe) als child-process gestartet basierend auf mcp-config.
 *
 * WICHTIG: dieser Prozess darf NICHTS auf stdout schreiben außer JSON-RPC
 * messages. Alles andere geht über stderr (pino-Logger oder console.error).
 *
 * Auth via env `ALFRED_MCP_TOKEN`. Wenn nicht gesetzt: jeder Call wird
 * abgewiesen. Alfred sollte das Token immer mitgeben wenn es den agent
 * spawned.
 *
 * Auth-Validation: aktuell pragmatisch — wir akzeptieren JEDES nicht-leere
 * Token als valid weil der Token-Store ein in-memory store IM alfred-Prozess
 * ist, NICHT in diesem mcp-server-Subprocess. Echte Cross-Process-Validation
 * via Unix-Socket o.ä. wäre v852+.
 */

import { ConfigLoader } from '@alfred/config';
import { runMcpServerStdio } from '@alfred/mcp-server';
import { Database } from '@alfred/storage';

export async function mcpServerCommand(): Promise<void> {
  // Config laden, aber NICHT stdout-loggen (MCP-Protokoll erwartet sauberen stdout)
  let config;
  try {
    const loader = new ConfigLoader();
    config = loader.loadConfig();
  } catch (err) {
    process.stderr.write(`alfred mcp-server: config load failed: ${(err as Error).message}\n`);
    process.exit(1);
  }

  // DB-Adapter. Read-only Pfad in v850 (Tools machen nur SELECT, audit-log
  // ist INSERT auf eigene Tabelle — bewusst non-destructive).
  let database;
  try {
    database = await Database.create({
      backend: config.storage.backend ?? 'sqlite',
      path: config.storage.path,
      connectionString: config.storage.connectionString,
    });
  } catch (err) {
    process.stderr.write(`alfred mcp-server: database connect failed: ${(err as Error).message}\n`);
    process.exit(1);
  }
  const adapter = database.getAdapter();

  // Logger über stderr (pretty-printed wäre OK, aber wir nehmen einfaches
  // structured logging hier weil pino unter stdio-context komplex ist)
  const logger = {
    info: (o: object, msg: string) => process.stderr.write(`[mcp-info] ${msg} ${JSON.stringify(o)}\n`),
    warn: (o: object, msg: string) => process.stderr.write(`[mcp-warn] ${msg} ${JSON.stringify(o)}\n`),
    error: (o: object, msg: string) => process.stderr.write(`[mcp-error] ${msg} ${JSON.stringify(o)}\n`),
  };

  // Pragmatischer Token-Validator: akzeptiere jedes nicht-leere Token.
  // Echte Cross-Process-Validation ist v852+ (würde Unix-Socket-Bridge
  // zum alfred-Hauptprozess brauchen).
  const validateToken = (token: string) => token.length >= 16;

  // Audit-Log: pragmatisch direkt in audit_log via adapter. Read-only-Pfad
  // hat nur SELECT-Berechtigungen — wir machen INSERT für audit ergänzend.
  const onAuditLog = async (entry: import('@alfred/mcp-server').McpToolInvocation) => {
    try {
      const id = crypto.randomUUID();
      await adapter.execute(
        `INSERT INTO audit_log (id, timestamp, action, risk_level, effect, context)
         VALUES (?, ?, ?, ?, ?, ?)`,
        [
          id,
          entry.timestamp,
          `mcp_tool_call:${entry.tool}`,
          'admin',
          entry.success ? 'allowed' : 'denied',
          JSON.stringify({
            input: entry.input,
            durationMs: entry.durationMs,
            resultPreview: entry.resultPreview,
            error: entry.error,
          }).slice(0, 4000),
        ],
      );
    } catch (err) {
      logger.warn({ err: (err as Error).message }, 'audit-log insert failed');
    }
  };

  await runMcpServerStdio({
    deps: {
      adapter,
      validateToken,
      onAuditLog,
      masterUserId: undefined, // server-side: kein user-scope; v851 setzt master-user via env
      logger,
    },
    onClose: () => {
      // graceful: close DB then exit
      try { void database.close(); } catch { /* */ }
      process.exit(0);
    },
  });
}
