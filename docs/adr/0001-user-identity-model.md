# ADR-0001: User-Identity-Modell

**Status**: Accepted (v804, 2026-05-27)
**Deciders**: madh
**Replaces**: implizites Verhalten pre-v804

## Kontext

Alfred unterstützt Multi-Platform-Messaging (Telegram, Matrix, Discord, WhatsApp, Signal, API). Jede Platform hat ihre eigenen User-ID-Formate:

| Platform | ID-Format | Beispiel |
|---|---|---|
| Telegram | numerisch, 6-15 Stellen | `5060785419` |
| Matrix | `@user:server.com` | `@madh:chat.3033.at` |
| Discord | Snowflake (numerisch, 17-19) | `438523487234123456` |
| API | beliebige Strings | `api-user-xyz` |

Intern braucht alfred eine **kanonische User-Identifikation** als FK für `projects.user_id`, `memories.user_id`, etc. Dafür existiert die `users`-Tabelle:

```
users
  id              UUID         (canonical, FK target)
  platform        text         ('telegram', 'matrix', ...)
  platform_user_id text         ('5060785419', '@madh:...')
  master_user_id  UUID NULL    (linked-account-resolution)
```

Plus eine ENV-Variable `ALFRED_OWNER_USER_ID` die den "Haupt-User" der Alfred-Instanz angibt.

### Das Problem (pre-v804)

Drei inkompatible User-ID-Formate koexistierten ohne klare Konversions-Strategie:

1. **Platform-ID** (z.B. Telegram `5060785419`) — beim Eingang via Messaging-Adapter
2. **DB-UUID** (z.B. `f165df7a-8689-...`) — als FK in projects, memories, etc.
3. **Env-Var-String** (`ALFRED_OWNER_USER_ID`) — undefined-format

Code-Stellen wie `projectRepo.getById(userId, projectId)` filterten nach `user_id`-Spalte. Wenn `userId` ein anderes Format hatte als die DB-Spalte erwartete, lieferte der Lookup `null`. Das führte zu silent fallback paths:

```ts
// Beispiel: Sandbox-Completion-Callback
const userId = this.ownerMasterUserId ?? this.config.security?.ownerUserId ?? '';
// ↑ könnte Telegram-ID "5060785419" sein, könnte UUID sein
const proj = await projectRepo.getById(userId, sbRow.project_id);
// ↑ wenn userId-Format ≠ project.user_id-Format → returns null
// → resolvedProjectId stays undefined
// → finishSession called without projectId
// → findOrCreate falls back to cwd-heuristik
// → creates ORPHAN project with worktree-path as cwd
```

7 Bug-Fixes in 30 Commits (v667, v721, v798, v800, v803) versuchten das Symptom an einzelnen Sites zu beheben — der Architektur-Riss blieb.

## Entscheidung

Wir führen ein **explizites Identity-Modell** ein mit drei Säulen:

### 1. Branded TypeScript Types

```ts
// packages/types/src/identity.ts
type UserUUID = string & { readonly [UserUUIDBrand]: never };
type PlatformUserId = string & { readonly [PlatformUserIdBrand]: never };
type MasterUserId = UserUUID & { readonly [MasterUserIdBrand]: never };
```

→ Compiler verhindert Format-Verwechslung zur Compile-Zeit.

### 2. IdentityResolver als Single Entry Point

```ts
// packages/core/src/identity/resolver.ts
class IdentityResolver {
  resolveOwnerFromConfig(envVar: string, platformHint?: string): Promise<UserUUID>
  resolveMasterId(uuid: UserUUID): Promise<UserUUID>
  findProjectOwner(projectId: string): Promise<UserUUID | null>
}
```

→ Niemand außer Resolver darf User-IDs interpretieren / konvertieren. Format-Mismatch ist nur noch an EINEM Punkt im Code möglich.

### 3. Repository-API-Disziplin

Repos die nach user_id filtern bieten ZWEI Methoden:

- `getById(userId: UserUUID, id)` — owner-scope, mit user-filter
- `getByIdAnyOwner(id)` — system-scope, ohne user-filter (für completion-callbacks, sandbox-linking)

Caller wählt **explizit** welche Variante er braucht. Bei Verwendung von `getById(...)` MUSS userId UUID-Format haben (Compiler + Runtime).

## Konsequenzen

### Positiv

- Compile-time-Safety für User-ID-Übergaben
- Single point of failure für Format-Resolution → einfacher zu debuggen + fixen
- Klare Semantik: owner-scope vs system-scope ist im Method-Namen sichtbar
- Tests für Identity-Resolution möglich (Unit-Tests gibt's jetzt: 18 in v804)
- Regression-Pfad geschlossen: zukünftige Code-Pfade die getById nutzen können nicht versehentlich falsche Formate übergeben

### Negativ

- ~25 bestehende Callsites müssen geändert werden (initial Refactor-Aufwand)
- Onboarding-Schwelle für neue Contributors: müssen Branded Types verstehen
- 8 Repos brauchen jetzt `getByIdAnyOwner`-Variante (additive Methoden)
- DB-Migration für non-UUID-Format-Rows nötig (audit-Tabelle in v804, eigentliche Fix-Migration in zukünftigem Release)

### Risiken

- **High**: existierende non-UUID-Werte in user_id-Spalten (Legacy-Daten) — werden vom Audit erfasst, nicht automatisch korrigiert
- **Medium**: deprecated `config.security.ownerUserId` als String — bleibt für Backward-Compat, wird intern durch Resolver geleitet
- **Low**: Tests decken die häufigsten Pfade ab, edge-cases im Multi-Platform-Linking sind unter-getestet

## Migrationspfad

| Version | Was wurde gemacht |
|---|---|
| v667 | erste `getByIdAnyOwner` in ProjectRepository (für Message-Pipeline) |
| v721 | sandbox→project Resolution-Code in Completion-Callbacks |
| v798 | projectId-Parameter in `AttachSessionParams` (eine Stelle) |
| v800 | findOrCreate nutzt `getByIdAnyOwner` (eine Stelle) |
| v803 | v721-Resolution nutzt `getByIdAnyOwner` (zwei Stellen) |
| **v804** | **Architektur-Refactor**: Branded Types + IdentityResolver + Init-Validation + Repo-API + Tests |

## Folge-Arbeiten (post-v804)

1. **v805+**: weitere ~10 Callsites in alfred.ts refactoren (in v804 nur die kritischsten)
2. **v806+**: `getByIdAnyOwner` für die noch fehlenden Repos: Todo, Note, Memory etc.
3. **v810+**: Audit-Tabelle auswerten → migrationsfähige Strategie für Legacy-Rows
4. **v815+**: Deprecation des Direct-Reads von `config.security.ownerUserId` als String

## Referenzen

- Original-Audit (subagent-report): siehe v804-Investigation-Session 2026-05-27
- Code: `packages/types/src/identity.ts`, `packages/core/src/identity/resolver.ts`
- Tests: `packages/core/src/identity/resolver.test.ts` (18 tests)
