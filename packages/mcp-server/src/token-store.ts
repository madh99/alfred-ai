/**
 * v850 — Token-Store für One-Time-Tokens.
 *
 * Alfred generiert pro CLI-Agent-Spawn ein neues Token, übergibt es als
 * `ALFRED_MCP_TOKEN` env-var an den agent, und registriert es hier. Der
 * MCP-Server validiert kommende calls gegen das Set.
 *
 * Tokens haben TTL (default 1h). Nach TTL: automatisch entfernt.
 * Alfred kann tokens auch explizit zurückrufen wenn der Agent-Spawn
 * beendet (skill execution done).
 */

import { randomBytes } from 'node:crypto';

interface TokenEntry {
  token: string;
  createdAt: number;
  expiresAt: number;
  /** Optional: welcher agent hat das token bekommen (für audit). */
  agentName?: string;
  /** Optional: cwd des agent-spawns (für audit). */
  cwd?: string;
}

export class McpTokenStore {
  private readonly tokens = new Map<string, TokenEntry>();
  private readonly ttlMs: number;
  private cleanupTimer: ReturnType<typeof setInterval> | null = null;

  constructor(ttlMs: number = 60 * 60 * 1000) {
    this.ttlMs = ttlMs;
    // periodischer cleanup expired tokens
    this.cleanupTimer = setInterval(() => this.cleanup(), 5 * 60 * 1000);
    if (typeof this.cleanupTimer.unref === 'function') this.cleanupTimer.unref();
  }

  /**
   * Erzeuge ein neues Token für einen Agent-Spawn. Token ist 32 random bytes
   * als hex-string (64 chars). Wird im env an den agent-subprocess übergeben.
   */
  issue(opts?: { agentName?: string; cwd?: string }): string {
    const token = randomBytes(32).toString('hex');
    const now = Date.now();
    this.tokens.set(token, {
      token,
      createdAt: now,
      expiresAt: now + this.ttlMs,
      agentName: opts?.agentName,
      cwd: opts?.cwd,
    });
    return token;
  }

  /** Validiere ein Token. Returns true wenn valid + nicht expired. */
  validate(token: string): boolean {
    const entry = this.tokens.get(token);
    if (!entry) return false;
    if (Date.now() > entry.expiresAt) {
      this.tokens.delete(token);
      return false;
    }
    return true;
  }

  /** Explizit ein Token zurückziehen (z.B. wenn skill execution done). */
  revoke(token: string): boolean {
    return this.tokens.delete(token);
  }

  /** Anzahl aktiver tokens (für monitoring). */
  size(): number {
    return this.tokens.size;
  }

  /** Stoppt den cleanup-timer (für tests / shutdown). */
  destroy(): void {
    if (this.cleanupTimer) clearInterval(this.cleanupTimer);
    this.cleanupTimer = null;
    this.tokens.clear();
  }

  private cleanup(): void {
    const now = Date.now();
    for (const [t, e] of this.tokens.entries()) {
      if (now > e.expiresAt) this.tokens.delete(t);
    }
  }
}
