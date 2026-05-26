/**
 * v804 — User-Identity-Modell: Type-Branding für Format-Safety.
 *
 * Hintergrund: vor v804 wurden "user-ids" in 3 Formaten gemischt:
 *   - UUID (z.B. f165df7a-8689-49b6-9318-41839913846f) — DB-Owner-FK
 *   - Platform-ID (z.B. 5060785419 Telegram, @user:server.com Matrix)
 *   - Env-var-String (ALFRED_OWNER_USER_ID — kann beides sein)
 *
 * Folge waren v798/v800/v803 Bug-Fixes wo `getById(envVarValue, projectId)`
 * silent null lieferte weil Format-Mismatch. Branded Types lassen den Compiler
 * dieses Klassen-Verwechseln zur Compile-Zeit fangen.
 *
 * Resolution-Path (zur Laufzeit):
 *   env-var | platform-id → IdentityResolver.resolveOwnerFromConfig() → UserUUID
 *
 * Repos die nach user_id filtern nehmen jetzt `UserUUID`-Type statt `string`.
 * Wer was anderes übergeben will, muss explizit konvertieren — und damit
 * sichtbar machen dass es eine bewusste Entscheidung ist.
 */

declare const UserUUIDBrand: unique symbol;
declare const PlatformUserIdBrand: unique symbol;
declare const MasterUserIdBrand: unique symbol;

/**
 * UUID einer Row aus `users`-Tabelle. Garantiert Format
 * `^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$`.
 * Wird als FK in `projects.user_id`, `memories.user_id` etc. verwendet.
 */
export type UserUUID = string & { readonly [UserUUIDBrand]: never };

/**
 * Plattform-spezifische User-ID — Telegram numerisch (`5060785419`),
 * Matrix `@user:server.com`, Discord-Snowflake, etc. Format ist pro Plattform.
 * KEINE Verwendung als DB-Owner-FK — muss erst durch UserRepository
 * zum UserUUID resolved werden.
 */
export type PlatformUserId = string & { readonly [PlatformUserIdBrand]: never };

/**
 * Master-User-ID = canonical UUID für linked-account-Setups. Wenn der gleiche
 * Mensch mehrere Platform-Accounts hat (Telegram + Matrix), zeigen alle
 * `users.master_user_id` auf den gleichen Master-User. Repo-Lookups für
 * persönliche Daten (Memory, KG, etc.) müssen Master-ID nutzen, NICHT
 * Platform-spezifische UUIDs.
 *
 * Strukturell ist MasterUserId auch ein UserUUID — aber semantisch heißt es
 * "die Master-Identität nach Linking-Resolution", nicht "irgendein User".
 */
export type MasterUserId = UserUUID & { readonly [MasterUserIdBrand]: never };

const UUID_REGEX = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** True wenn String UUID-Format hat. */
export function isUserUUID(v: string): v is UserUUID {
  return typeof v === 'string' && UUID_REGEX.test(v);
}

/**
 * Cast string → UserUUID mit Runtime-Validation. Wirft bei Format-Verletzung.
 *
 * Nur an System-Boundaries verwenden:
 *  - DB-Row-Mapping (`rowToProject`) — wir wissen DB hält UUIDs
 *  - Nach Identity-Resolver-Output
 *  - In Tests
 *
 * Niemals zum "Umcasten" von env-var-Strings — das ist der Bug den wir lösen wollen.
 * Für env-var-Inputs: IdentityResolver.resolveOwnerFromConfig() nutzen.
 */
export function asUserUUID(v: string): UserUUID {
  if (!isUserUUID(v)) {
    throw new Error(`asUserUUID: not a valid UUID format (got "${v.slice(0, 50)}")`);
  }
  return v as UserUUID;
}

/** Soft-Cast: returns UserUUID falls valid, undefined sonst. Für defensives Lookup. */
export function tryUserUUID(v: string | null | undefined): UserUUID | undefined {
  if (typeof v !== 'string') return undefined;
  return isUserUUID(v) ? (v as UserUUID) : undefined;
}

/** Cast UserUUID → MasterUserId (struktur-identisch, semantischer Cast). */
export function asMasterUserId(v: UserUUID): MasterUserId {
  return v as MasterUserId;
}

/**
 * Cast string → PlatformUserId. Keine Format-Validation weil pro Platform anders.
 * Best-effort: nur Length-Check (> 0, < 200).
 */
export function asPlatformUserId(v: string): PlatformUserId {
  if (typeof v !== 'string' || v.length === 0 || v.length > 200) {
    throw new Error(`asPlatformUserId: invalid (length=${v?.length})`);
  }
  return v as PlatformUserId;
}

/**
 * Discriminator-Helper: bestimmt mit hoher Confidence ob ein String UUID oder
 * Platform-ID ist. Wird vom Resolver genutzt um env-var-Input zu interpretieren.
 *
 * Returns: 'uuid' wenn UUID-Format, 'platform' sonst.
 */
export function classifyUserIdFormat(v: string): 'uuid' | 'platform' {
  return isUserUUID(v) ? 'uuid' : 'platform';
}
