# Monitor Thresholds + Per-Asset Overrides — Spezifikation

**Version:** 1.0 Draft
**Datum:** 2026-04-10
**Status:** Entwurf — Noch nicht umgesetzt
**Nachfolger von:** v435 (ITSM Auto-Recovery für Monitor-Incidents)

## Zusammenfassung

Zwei Phasen um die Monitor-Skill-Thresholds flexibler zu machen:

- **Phase 2:** Globale Thresholds per Config/ENV konfigurierbar (statt hardcoded)
- **Phase 3:** Per-Asset Overrides via CMDB Asset Attributes (`monitor_*` Namespace)

## Kontext

Nach Implementierung von Phase 1 (ITSM Auto-Recovery, v435) sind Monitor-erstellte Incidents selbst-heilend. Was fehlt: Thresholds können aktuell nur via Code-Edit geändert werden, und es gibt keine Möglichkeit pro Asset sagen "diese VM darf 98% Disk voll sein, das ist normal für einen Backup-Host".

### Aktuelle hardcoded Thresholds (`packages/skills/src/built-in/monitor.ts`)

| Check | Schwellwert | Zeile | Kommentar |
|---|---|---|---|
| Proxmox Node online | `online === false` | 119 | boolean, kein Threshold |
| Proxmox VM/LXC Disk | `> 90%` | 135 | **numerisch, konfigurierbar machen** |
| Proxmox VM RAM | `> 95%` (running only) | 149 | **numerisch, konfigurierbar machen** |
| UniFi Site Health | `subsystem.status !== 'ok'` | 258 | state-based, kein Threshold |
| UniFi Device | `state !== 1` | 271 | state-based, kein Threshold |
| UniFi Open Alarms | Count > 0 | 283 | state-based |
| HA Entity | `state === 'unavailable'` | 315 | state-based |
| HA Battery | `< 20%` | 328 | **numerisch, konfigurierbar machen** |
| PBS Backup Alter | `> maxAgeHours` (24h default) | 412 | bereits konfigurierbar via `ProxmoxBackupConfig.maxAgeHours` |

---

## Phase 2: Konfigurierbare Thresholds

### Scope

Nur die numerischen Thresholds konfigurierbar machen. State-based Checks bleiben unverändert (keine sinnvollen Thresholds).

### Neuer Config-Typ (`packages/types/src/config.ts`)

```typescript
export interface MonitorThresholds {
  proxmox?: {
    diskPct?: number;        // default 90, range 50-99
    ramPct?: number;         // default 95, range 50-99
  };
  homeassistant?: {
    lowBatteryPct?: number;  // default 20, range 1-50
  };
}

export interface MonitorConfig {
  thresholds?: MonitorThresholds;
}

// In AlfredConfig ergänzen:
// monitor?: MonitorConfig;
```

### Zod-Schema (`packages/config/src/schemas.ts`)

```typescript
const MonitorThresholdsSchema = z.object({
  proxmox: z.object({
    diskPct: z.number().min(50).max(99).optional(),
    ramPct: z.number().min(50).max(99).optional(),
  }).optional(),
  homeassistant: z.object({
    lowBatteryPct: z.number().min(1).max(50).optional(),
  }).optional(),
}).optional();

const MonitorConfigSchema = z.object({
  thresholds: MonitorThresholdsSchema,
}).optional();
```

### ENV-Overrides (`packages/config/src/loader.ts`)

In `ENV_MAP`:
```typescript
// Monitor thresholds
ALFRED_MONITOR_PROXMOX_DISK_PCT: ['monitor', 'thresholds', 'proxmox', 'diskPct'],
ALFRED_MONITOR_PROXMOX_RAM_PCT: ['monitor', 'thresholds', 'proxmox', 'ramPct'],
ALFRED_MONITOR_HA_BATTERY_PCT: ['monitor', 'thresholds', 'homeassistant', 'lowBatteryPct'],
```

In `NUMERIC_ENV_KEYS`:
```typescript
'ALFRED_MONITOR_PROXMOX_DISK_PCT',
'ALFRED_MONITOR_PROXMOX_RAM_PCT',
'ALFRED_MONITOR_HA_BATTERY_PCT',
```

### Monitor-Skill Anpassung (`packages/skills/src/built-in/monitor.ts`)

`MonitorCheckConfig` erweitern:
```typescript
import type { MonitorThresholds } from '@alfred/types';

export interface MonitorCheckConfig {
  proxmox?: ProxmoxConfig;
  unifi?: UniFiConfig;
  homeassistant?: HomeAssistantConfig;
  proxmoxBackup?: ProxmoxBackupConfig;
  thresholds?: MonitorThresholds;
}
```

`checkProxmox()` — Zeilen 135 und 149:
```typescript
const diskThreshold = this.config.thresholds?.proxmox?.diskPct ?? 90;
if (diskPct > diskThreshold) {
  alerts.push({
    source: 'proxmox',
    message: `${name} disk usage ${diskPct.toFixed(1)}% (threshold: ${diskThreshold}%)`,
  });
}

const ramThreshold = this.config.thresholds?.proxmox?.ramPct ?? 95;
if (memPct > ramThreshold) {
  alerts.push({
    source: 'proxmox',
    message: `${name} RAM usage ${memPct.toFixed(1)}% (threshold: ${ramThreshold}%)`,
  });
}
```

`checkHomeAssistant()` — Zeile 328:
```typescript
const batteryThreshold = this.config.thresholds?.homeassistant?.lowBatteryPct ?? 20;
if (!isNaN(val) && val >= 0 && val < batteryThreshold) {
  // ... existing alert ...
}
```

### Wiring (`packages/core/src/alfred.ts:633`)

```typescript
skillRegistry.register(new MonitorSkill({
  proxmox: this.config.proxmox,
  unifi: this.config.unifi,
  homeassistant: this.config.homeassistant,
  proxmoxBackup: this.config.proxmoxBackup,
  thresholds: this.config.monitor?.thresholds,
}));
```

### Phase 2 Side-Effects

| Szenario | Verhalten |
|---|---|
| Config komplett leer | Fallback auf hardcoded Defaults → identisches Verhalten zu v435 |
| ENV setzt `ALFRED_MONITOR_PROXMOX_DISK_PCT=95` | Disk-Alert erst ab 95% |
| Zod schlägt fehl (diskPct=200) | Config-Load-Error beim Startup |
| Alert-Message | Enthält jetzt den aktuellen Threshold → bessere Debuggability |
| Backward Compat | Kein existierendes Deployment braucht Config-Änderungen |

**Keine DB-Migration. Rein Config-Refactoring.**

---

## Phase 3: Per-Asset Overrides via CMDB Asset Attributes

### Scope

User kann pro Asset in CMDB Monitor-Overrides setzen. Z.B. "VM `nfs-server` darf bis 98% Disk voll sein, weil das normal für einen Backup-Host ist". Die Overrides werden in der existierenden `cmdb_assets.attributes` JSON-Spalte gespeichert (keine Migration).

### Namespace-Konvention

User-Overrides nutzen Prefix `monitor_`:

| Attribut | Typ | Wirkung |
|---|---|---|
| `monitor_ignore` | `boolean` | Kein einziger Monitor-Alert für diesen Asset |
| `monitor_ignore_disk` | `boolean` | Nur Disk-Check überspringen |
| `monitor_ignore_ram` | `boolean` | Nur RAM-Check überspringen |
| `monitor_disk_pct` | `number` (50-99) | Per-Asset Disk-Threshold |
| `monitor_ram_pct` | `number` (50-99) | Per-Asset RAM-Threshold |
| `monitor_battery_pct` | `number` (1-50) | Per-HA-Entity Low-Battery-Threshold |

**Resolution-Reihenfolge:** Asset-Override → Phase-2-Global-Config → hardcoded Default.

### Blocker 1: `upsertAsset` überschreibt attributes beim Re-Discovery

**Problem:** `packages/storage/src/repositories/cmdb-repository.ts:141` setzt bei jedem Re-Discovery das komplette `attributes`-Feld neu. User-manuell gesetzte `monitor_*` Keys würden bei jedem 24h-Discovery vernichtet.

**Fix:** Attribute-Merge-Funktion die user-owned Keys aus dem bestehenden Row preservt.

```typescript
// Top der Datei
const USER_OWNED_ATTR_PREFIXES = ['monitor_', 'user_'];

function mergeAssetAttributes(
  existingJson: string | null | undefined,
  incoming: Record<string, unknown>,
): string {
  const existing: Record<string, unknown> = existingJson
    ? (() => { try { return JSON.parse(existingJson); } catch { return {}; } })()
    : {};
  const userOwned = Object.fromEntries(
    Object.entries(existing).filter(([k]) =>
      USER_OWNED_ATTR_PREFIXES.some(p => k.startsWith(p)),
    ),
  );
  return JSON.stringify({ ...incoming, ...userOwned });  // user wins
}
```

Beide UPDATE-Branches in `upsertAsset` (manual assets Z.101, source-based Z.123) müssen jetzt auch `attributes` in ihrem SELECT laden und durch `mergeAssetAttributes` schicken statt blind zu überschreiben.

**Backward Compat:** Bestehende attributes ohne Prefix → discovery-owned → werden wie bisher überschrieben. Keine Migration nötig, existierende Daten sind neutral.

### Blocker 2: MonitorSkill hat keine Callbacks

**Fix:** Neuer Callback-Mechanismus nach Pattern von `cmdbSkill.setKgSyncCallback`.

```typescript
// In MonitorSkill:
private getSourceAttributesFn?: (sourceSkill: string) => Promise<Map<string, Record<string, unknown>>>;

setSourceAttributesCallback(fn: typeof this.getSourceAttributesFn): void {
  this.getSourceAttributesFn = fn;
}
```

**Bulk-Load statt N Queries:** Der Callback liefert eine vollständige Map für alle Assets einer Source (1 DB-Query), dann wird in-memory pro Resource gelookt.

### Per-Check Logik in Monitor

Helper:
```typescript
private resolveNumber(override: unknown, global: number | undefined, fallback: number): number {
  if (typeof override === 'number' && Number.isFinite(override)) return override;
  return global ?? fallback;
}
```

`checkProxmox()`:
```typescript
const overridesMap = await this.getSourceAttributesFn?.('proxmox') ?? new Map();

for (const r of resources) {
  const sourceId = `${r.node}:${r.vmid}`;  // matches CMDB discovery convention
  const overrides = overridesMap.get(sourceId) ?? {};

  if (overrides.monitor_ignore === true) continue;

  if (overrides.monitor_ignore_disk !== true) {
    const thresh = this.resolveNumber(
      overrides.monitor_disk_pct,
      this.config.thresholds?.proxmox?.diskPct,
      90,
    );
    // ... existing disk check with thresh ...
  }

  if (overrides.monitor_ignore_ram !== true && status === 'running') {
    const thresh = this.resolveNumber(
      overrides.monitor_ram_pct,
      this.config.thresholds?.proxmox?.ramPct,
      95,
    );
    // ... existing ram check with thresh ...
  }
}
```

`checkHomeAssistant()`: analog per Entity ID.

`checkUnifi()`: nur `monitor_ignore` Support per MAC, da Device-Checks state-based sind.

### Wiring (`packages/core/src/alfred.ts`)

Nach MonitorSkill-Registrierung (aktuell ~Z.640):

```typescript
const monitorSkillRef = skillRegistry.get('monitor');
if (monitorSkillRef && cmdbRepo) {
  (monitorSkillRef as any).setSourceAttributesCallback(async (sourceSkill: string) => {
    const userId = this.ownerMasterUserId;
    if (!userId) return new Map();
    try {
      const assets = await cmdbRepo.listAssets(userId, { sourceSkill });
      const map = new Map<string, Record<string, unknown>>();
      for (const a of assets) {
        if (a.sourceId && a.attributes) {
          const monitorAttrs = Object.fromEntries(
            Object.entries(a.attributes).filter(([k]) => k.startsWith('monitor_')),
          );
          if (Object.keys(monitorAttrs).length > 0) {
            map.set(a.sourceId, monitorAttrs);
          }
        }
      }
      return map;
    } catch (err) {
      this.logger.warn({ err: (err as Error).message, sourceSkill }, 'Failed to load monitor overrides from CMDB');
      return new Map();
    }
  });
}
```

**Achtung:** Muss NACH `cmdbRepo`-Initialisierung passieren. Bei Implementierung prüfen wo `cmdbRepo` im lexikalischen Scope verfügbar ist relativ zur MonitorSkill-Registrierung.

### Phase 3 Side-Effects

| Szenario | Verhalten | Sicher? |
|---|---|---|
| User setzt `monitor_ignore=true` auf "Backup-VM" | Keine Alerts für diese VM | ✅ User-Intent |
| User setzt `monitor_disk_pct="high"` (falscher Typ) | `resolveNumber` fällt auf Global zurück | ✅ Type-safe |
| User setzt `monitor_disk_pct=150` | `> 150` ist nie true → effektiv wie ignore | ✅ Harmless |
| Auto-Discovery nach User-Änderung | `mergeAssetAttributes` preservt `monitor_*` Keys | ✅ Key Fix |
| 50 VMs mit Discovery | 1 callback call = 1 DB-Query pro Source, in-memory Lookup | ✅ Performant |
| Zombie-Assets (LXC-Migration) | `Map.set` überschreibt, letzter wins — User-Override auf altem zombie nicht wirksam | ⚠️ Pre-existing zombie bug bites |
| Callback schlägt fehl (DB down) | try/catch → warning log → leere Map → Global-Defaults | ✅ Graceful |
| Monitor parallel zu Auto-Discovery | Monitor liest Snapshot, Discovery modifiziert danach — atomar | ✅ |
| Asset hat pre-v2 attributes ohne prefix | Discovery überschreibt wie bisher | ✅ Backward compat |

### Offene Frage Phase 3: WebUI-Support

**Nicht verifiziert:** Ob die CMDB-Page im WebUI bereits arbiträre Attribute-Editierung erlaubt oder nur vordefinierte Felder.

Falls WebUI keine Attribute-Edit bietet:
- **Option A:** Phase 3 nur mit CLI/Chat/DB-Edit unterstützen, WebUI-Panel als **Phase 3b** nachreichen
- **Option B:** Phase 3 mit WebUI-Edit zusammen ausliefern (mehr Scope, aber benutzerfreundlicher)

Zu klären vor Implementierungs-Start.

---

## Reihenfolge & Abhängigkeiten

Phase 2 und Phase 3 sind logisch unabhängig, aber **Phase 3 profitiert von Phase 2** (nutzt dieselbe Config-Struktur als Global-Fallback).

### Empfohlener Pfad

1. **Phase 2 zuerst** als eigener Release (v436?) — bringt `MonitorThresholds` Config, liefert sofort Mehrwert ohne das Merge-Risiko.
2. **Phase 3 danach** als separater Release (v437?) — Merge-Fix und Callback-Integration, nachdem WebUI-Frage geklärt ist.

### Aufwand-Schätzung

| | Dateien | Zeilen geschätzt | DB-Migration | Breaking | Risiko |
|---|---|---|---|---|---|
| Phase 2 | 5 | ~100 | nein | nein | niedrig |
| Phase 3 | 3 (+WebUI?) | ~200 | nein | nein | mittel (upsertAsset Merge-Logik) |

---

## Entscheidungen vor Implementation

1. **Separate Releases oder kombiniert?** (Empfehlung: separat)
2. **`monitor_*` Prefix OK** oder anderer Namespace (`mon_`, `override_`, `user_monitor_`)?
3. **WebUI-Attribute-Editor:** vorher verifizieren, dann Entscheidung Phase 3 zusammen oder 3b separat
4. **Zusätzliche Thresholds in Phase 2** die hier fehlen? (z.B. PBS backup failure count als Option)
5. **Defaults beibehalten** (90/95/20) oder andere Werte als sinnvollere Defaults?

---

## Referenzen

- Phase 1 Implementation: `v435` — ITSM Auto-Recovery für Monitor-erstellte Incidents
- Monitor-Skill: `packages/skills/src/built-in/monitor.ts`
- CMDB upsertAsset: `packages/storage/src/repositories/cmdb-repository.ts:93-170`
- Config Loader Pattern: `packages/config/src/loader.ts:228-268`
- Callback-Pattern Beispiel: `packages/core/src/alfred.ts:1143-1156` (`setKgSyncCallback`)
