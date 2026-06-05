/**
 * v850 — Type-Definitionen für Alfred MCP-Server.
 */

import type { AsyncDbAdapter } from '@alfred/storage';

/**
 * Validator für One-Time-Tokens. Alfred generiert pro CLI-Agent-Spawn ein
 * Token und übergibt es als env-var. Der MCP-Server validiert das Token
 * gegen alfreds in-memory store BEVOR ein tool-call ausgeführt wird.
 *
 * Wenn `false`: tool-call wird mit -32001 Unauthorized abgewiesen, der
 * agent bekommt klare Fehlermeldung.
 */
export type McpTokenValidator = (token: string) => boolean;

export interface McpServerDeps {
  /**
   * DB-Adapter für direkten read access auf alfred-stores.
   * MCP-Server nutzt das nur READ-ONLY in v850 — keine writes.
   */
  adapter: AsyncDbAdapter;
  /**
   * Token-Validator. Wenn null: token-validation übersprungen (debug-mode).
   */
  validateToken: McpTokenValidator | null;
  /**
   * Optional: Audit-Callback der bei jedem erfolgreichen tool-call gerufen
   * wird. Alfred kann hier in `audit_log` schreiben damit MCP-Aktivität
   * sichtbar ist.
   */
  onAuditLog?: (entry: McpToolInvocation) => Promise<void>;
  /**
   * Master-User-ID die für alle queries genutzt wird (wer "ist" der MCP-Server).
   * Default: alfred's owner-master-user. Fall: queries laufen scoped.
   */
  masterUserId?: string;
  /**
   * Optional: Logger für stderr-output (MCP nutzt stdout für JSON-RPC,
   * stderr ist frei).
   */
  logger?: { info(o: object, msg: string): void; warn(o: object, msg: string): void; error(o: object, msg: string): void };
}

export interface McpToolInvocation {
  tool: string;
  /** Input arguments (JSON-serializable). Truncated by audit-callback wenn zu lang. */
  input: Record<string, unknown>;
  /** Outcome: success oder error mit message. */
  success: boolean;
  error?: string;
  durationMs: number;
  /** Truncated result preview für audit (max 200 char). */
  resultPreview?: string;
  timestamp: string;
}
