import type { Logger } from 'pino';
import type { Platform } from '@alfred/types';
import { asUserUUID, tryUserUUID, isUserUUID, type UserUUID } from '@alfred/types';
import type { UserRepository, ProjectRepository } from '@alfred/storage';

/**
 * v804 — IdentityResolver: Single entry-point für User-ID-Resolution.
 *
 * Vor v804 verteilten sich User-ID-Lookups + Format-Konversionen über die ganze
 * Codebase. Resultat waren v798/v800/v803 Bug-Fixes — alles wegen
 * Format-Mismatch (Telegram-ID vs UUID vs Platform-ID).
 *
 * v804 zentralisiert das hier:
 *   - resolveOwnerFromConfig(envVar) → UserUUID — beim Alfred-Init aufgerufen
 *   - resolveMasterId(uuid) → MasterUserId — für linked-account-Aware-Lookups
 *   - findProjectOwner(projectId) → UserUUID — sandbox/completion-callbacks
 *
 * Niemand außer Resolver darf user-ids interpretieren. Repos akzeptieren
 * `UserUUID` als Branded Type — wer was anderes übergibt, wird vom
 * TypeScript-Compiler verwiesen.
 */
export class IdentityResolver {
  constructor(
    private readonly users: UserRepository,
    private readonly projects: ProjectRepository | undefined,
    private readonly logger: Logger,
  ) {}

  /**
   * Resolved den `ALFRED_OWNER_USER_ID`-env-var-Wert zur garantierten UserUUID.
   *
   * Akzeptiert beide Formate:
   *   - UUID-Format → direkt cast (validiert) — schnellster Pfad
   *   - Platform-ID (z.B. Telegram-Numerisch) → findOrCreate über UserRepository,
   *     liefert dessen DB-UUID
   *
   * @param envValue Roher String aus env-var oder Config
   * @param hintedPlatform optional Platform-Hint (config.security.ownerPlatform).
   *   Required falls envValue Platform-ID-Format hat.
   * @throws bei nicht-resolvable Inputs (kein UUID, kein platform hint)
   */
  async resolveOwnerFromConfig(envValue: string, hintedPlatform?: string): Promise<UserUUID> {
    if (!envValue || typeof envValue !== 'string') {
      throw new Error(`IdentityResolver.resolveOwnerFromConfig: empty/invalid envValue`);
    }

    // Pfad 1: bereits UUID → schneller cast
    if (isUserUUID(envValue)) {
      // Bonus: existiert dieser UUID auch in users-Tabelle?
      try {
        const u = await this.users.findById(envValue);
        if (!u) {
          this.logger.warn({ envValue: envValue.slice(0, 8) }, 'v804 owner UUID not found in users-table — accepting anyway (may belong to alfred_users table)');
        }
      } catch { /* swallow — UUID-cast bleibt valid auch ohne user-row */ }
      return asUserUUID(envValue);
    }

    // Pfad 2: Platform-ID → findOrCreate
    const platform = (hintedPlatform ?? this.guessPlatformFromFormat(envValue)) as Platform | undefined;
    if (!platform) {
      throw new Error(
        `IdentityResolver.resolveOwnerFromConfig: "${envValue.slice(0, 20)}" ist kein UUID-Format ` +
        `und keine platform-hint angegeben. Setze ALFRED_OWNER_PLATFORM=telegram (oder matrix/discord/etc.) ` +
        `oder ALFRED_OWNER_USER_ID direkt auf den DB-UUID.`,
      );
    }

    const user = await this.users.findOrCreate(platform, envValue);
    const resolved = tryUserUUID(user.id);
    if (!resolved) {
      throw new Error(`IdentityResolver: findOrCreate returned non-UUID id "${user.id}"`);
    }
    this.logger.info({
      platform,
      platformUserId: envValue.slice(0, 12) + '…',
      resolvedUUID: resolved.slice(0, 8) + '…',
    }, 'v804 owner platform-id resolved to UUID');
    return resolved;
  }

  /**
   * Resolve UserUUID → MasterUserId (für linked accounts).
   *
   * Wenn `getMasterUserId` einen anderen UUID zurückgibt (linked account-master),
   * nimm den. Sonst bleibt es identisch.
   */
  async resolveMasterId(userId: UserUUID): Promise<UserUUID> {
    try {
      const masterId = await this.users.getMasterUserId(userId);
      const resolved = tryUserUUID(masterId);
      return resolved ?? userId;
    } catch (err) {
      this.logger.debug({ err, userId: userId.slice(0, 8) }, 'v804 getMasterUserId failed, returning original');
      return userId;
    }
  }

  /**
   * System-Lookup: gegeben eine project-id, finde dessen Owner-UUID.
   *
   * Vor v804: Code rief `projectRepo.getById(maybeWrongUserId, projectId)` → null →
   * Fallback zu cwd-heuristik → ORPHAN. Jetzt: dieser Resolver findet den Owner
   * unabhängig von wem grad fragt.
   */
  async findProjectOwner(projectId: string): Promise<UserUUID | null> {
    if (!this.projects) return null;
    try {
      const proj = await this.projects.getByIdAnyOwner(projectId);
      return proj ? tryUserUUID(proj.userId) ?? null : null;
    } catch (err) {
      this.logger.debug({ err, projectId }, 'v804 findProjectOwner failed');
      return null;
    }
  }

  /**
   * Heuristik: erkennt Telegram-Numerische-IDs aus dem Format.
   * Nur als Fallback wenn config.security.ownerPlatform nicht gesetzt ist.
   * Best-effort — gibt undefined zurück wenn nicht eindeutig erkennbar.
   */
  private guessPlatformFromFormat(value: string): Platform | undefined {
    // Telegram: rein numerisch, 6-15 Stellen
    if (/^\d{6,15}$/.test(value)) return 'telegram';
    // Matrix: @user:server.com
    if (/^@[^:]+:[\w.-]+$/.test(value)) return 'matrix';
    // Discord-Snowflake: numerisch, 17-19 Stellen — überlappt mit Telegram-Range
    // → wir können nicht eindeutig zwischen Telegram vs Discord trennen ohne Hint
    return undefined;
  }
}
