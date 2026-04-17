# Service Management System — Design Spec

## Goal

Vollstaendiges Service-Management: Services per Chat oder WebUI aus CMDB-Assets erstellen, mit Failure-Modes, automatischer Doku/SOP/Runbook-Generierung, Impact-Analyse, und ITSM-Integration. Ein Asset kann Teil mehrerer Services sein mit unterschiedlichen Rollen/Impact pro Service.

## Architecture

Erweiterung bestehender Skills + neue WebUI-Seite:

- **ITSM Skill (erweitert):** 6 neue Actions (create_service_from_description, add/remove/update_failure_mode, service_impact_analysis, generate_service_docs)
- **ITSM Repository (erweitert):** failure_modes JSON-Feld, Impact-Queries ueber Services
- **WebUI /services (neu):** Service-Liste + Detail-Ansicht + ForceGraph2D Visualisierung + Failure-Mode Editor + Doku-Links + Erstellen-Dialog
- **Background Doku-Generierung:** Service-Doku + SOP pro Failure-Mode aus vorhandenen System-Dokus
- **ITSM vollintegriert:** Incident/Change/Health-Check erkennen Service-Impact automatisch

## Tech Stack

- TypeScript (bestehend)
- PostgreSQL/SQLite (bestehend, cmdb_services erweitert)
- LLM (strong tier fuer Doku-Generierung)
- ForceGraph2D (bestehend, fuer Service-Graph)
- React/Next.js (bestehend)

---

## Datenmodell

### Komponenten-Modell (erweitert)

Bestehende `components` JSON-Spalte auf `cmdb_services` wird um Felder erweitert:

```typescript
interface ServiceComponent {
  name: string;              // "PostgreSQL Primary"
  role: string;              // "database", "cache", "compute", "proxy", "api", "storage", "messaging", "monitoring", "dns", "other"
  assetId?: string;          // CMDB-Asset UUID — N:M (selbes Asset in mehreren Services moeglich)
  serviceId?: string;        // oder ein anderer Service als Abhaengigkeit
  externalUrl?: string;      // oder eine externe Ressource
  required: boolean;         // true = Ausfall → Service down
  failureImpact: 'down' | 'degraded' | 'no_impact';
  failureDescription?: string;  // "DB weg → keine Daten, Redis-Cache haelt 5min"
  dependsOn?: string[];      // andere Komponenten-Namen in diesem Service
  ports?: number[];          // [5432]
  protocol?: string;         // "tcp", "http", "https", "mqtt"
  dns?: string;              // "pg.alfred.local"
  ip?: string;               // "192.168.1.91" (aus Asset oder manuell)
  healthCheckUrl?: string;   // fuer component-level Health-Check
  healthStatus?: string;     // "healthy", "degraded", "down", "unknown"
  healthReason?: string;
}
```

Rolle ist PRO SERVICE — dasselbe Asset kann in Service A "required/database" und in Service B "optional/metrics-store" sein.

### Failure-Mode-Modell (neu)

Neues JSON-Feld `failure_modes` auf `cmdb_services`:

```typescript
interface FailureMode {
  name: string;              // "DB-Ausfall"
  trigger: string;           // "PostgreSQL auf .91 nicht erreichbar"
  affectedComponents: string[];  // ["PostgreSQL Primary"]
  serviceImpact: 'down' | 'degraded';
  cascadeEffects?: string[]; // ["Redis-Cache laeuft leer nach 5min", "Alle Nodes verlieren State"]
  runbookId?: string;        // verknuepftes Runbook (cmdb_documents)
  sopId?: string;            // verknuepftes SOP (cmdb_documents)
  estimatedRecoveryMinutes?: number;
}
```

### DB-Aenderung

```sql
-- Migration v58
ALTER TABLE cmdb_services ADD COLUMN failure_modes TEXT DEFAULT '[]';
```

Kein neues Schema — erweitert bestehende Tabelle.

---

## ITSM Skill — Neue Actions (6)

### create_service_from_description

Input: natuerliche Sprache (User-Beschreibung des Services)

Ablauf:
1. LLM parst Beschreibung → extrahiert Service-Name, Komponenten, Rollen, Failure-Modes
2. Fuer jede Komponente: CMDB-Asset per Name/IP matchen (resolveAsset Pattern)
3. Laedt vorhandene System-Dokus der gematchten Assets
4. Erstellt Service via bestehende add_service + add_component Actions
5. Setzt failure_modes
6. Startet Background-Task fuer Doku-Generierung
7. Antwortet mit Service-Uebersicht

### add_failure_mode

Input: service_id, name, trigger, affectedComponents, serviceImpact, cascadeEffects?, estimatedRecoveryMinutes?

Fuegt Failure-Mode zum failure_modes JSON-Array hinzu.

### remove_failure_mode

Input: service_id, failure_mode_name

Entfernt Failure-Mode aus dem Array.

### update_failure_mode

Input: service_id, failure_mode_name, updates (partial)

Aktualisiert einzelne Felder eines Failure-Modes.

### service_impact_analysis

Input: asset_id ODER "was passiert wenn X ausfaellt"

Ablauf:
1. Findet ALLE Services die das Asset als Komponente haben
2. Fuer jeden Service: prueft welcher Failure-Mode durch den Asset-Ausfall getriggert wird
3. Gibt Impact-Report: Service → Impact (down/degraded) + Cascade-Effekte + verknuepfte Runbooks/SOPs

### generate_service_docs

Input: service_id

Startet Background-Generierung:
1. Service-Doku — LLM generiert aus Service-Definition + Komponenten + vorhandene System-Dokus
2. SOP pro Failure-Mode — LLM generiert operatives SOP pro Failure-Mode mit konkreten Recovery-Schritten
3. Service-Map Update — Mermaid-Diagramm aktualisiert

Kontext fuer LLM: Service-Definition + alle Komponenten-System-Dokus (Deep-Scan Dokus wenn vorhanden) + Failure-Mode-Beschreibungen.

---

## ITSM-Integration (bestehende Actions erweitert)

### create_incident (erweitert)

Nach Incident-Erstellung:
1. Pruefe affected_asset_ids gegen alle Services
2. Fuer jeden betroffenen Service: bestimme Impact (down/degraded) basierend auf Failure-Modes
3. Setze affected_service_ids auf dem Incident
4. Zeige Service-Impact im Response: "Asset X betrifft 2 Services: Alfred HA (DOWN), Monitoring (DEGRADED)"
5. Schlage passende Failure-Mode-SOPs/Runbooks vor

### health_check (erweitert)

Bestehende 3-Layer Health-Check + Failure-Mode-Evaluation:
1. Wenn Komponente down → pruefe welcher Failure-Mode matcht
2. Setze Service-Status auf Impact des Failure-Modes (down/degraded)
3. Wenn auto_incident konfiguriert → erstelle Incident mit Service-Impact

### create_change_request (erweitert)

Zeige betroffene Services wenn Change ein Asset betrifft:
"Maintenance auf .91 → Alfred HA Cluster und Monitoring Stack betroffen"

---

## Background Doku-Generierung

### Trigger

Bei `create_service_from_description` oder `generate_service_docs`.

### Was wird generiert

1. **Service-Doku** (doc_type: service_doc)
   - Uebersicht, Architektur, Komponenten mit Rollen/IPs/Ports/DNS
   - Abhaengigkeiten (interne + externe)
   - Failure-Modes mit Impact
   - Gespeichert als cmdb_document linked zu service

2. **SOP pro Failure-Mode** (doc_type: sop)
   - Symptom, Diagnose-Schritte, Recovery, Nachhaltige Massnahmen
   - Basierend auf: Failure-Mode Definition + System-Dokus der betroffenen Komponenten
   - Ein SOP pro Failure-Mode
   - Gespeichert als cmdb_document linked zu service

3. **Service-Map Update** (doc_type: service_map)
   - Mermaid-Diagramm mit allen Services und Abhaengigkeiten
   - Aktualisiert bei jeder Service-Aenderung

### LLM-Kontext

Fuer jede Generierung wird zusammengestellt:
- Service-Definition (Name, Beschreibung, Criticality)
- Alle Komponenten mit: Name, Rolle, IP, Ports, DNS, failureImpact
- Vorhandene System-Dokus der Komponenten-Assets (Deep-Scan Doku wenn verfuegbar)
- Failure-Modes mit Trigger, Impact, Cascade-Effekte
- Bestehende Runbooks der Komponenten

---

## WebUI /services

### Layout: Service-Liste + Detail + Graph

**Service-Liste (links, 250px):**
- Alle Services mit Health-Status-Dot (gruen/gelb/rot)
- Criticality-Badge
- Klick oeffnet Detail

**Service-Detail (rechts):**

**Header:**
- Name, Status-Dot, Criticality-Badge
- Beschreibung
- Toolbar: [Bearbeiten] [Impact-Analyse] [Doku generieren] [Loeschen]

**Graph (ForceGraph2D):**
- Komponenten als Nodes
- Node-Farbe = healthStatus (gruen/gelb/rot/grau)
- Node-Label = Name + IP + Rolle
- Node-Rand = required (dick) vs optional (duenn)
- Edges = dependsOn Beziehungen
- Klick auf Node → Asset-Detail-Panel (IP, Ports, DNS, Role, Impact, verlinkte System-Doku)

**Failure-Modes (unter Graph):**
- Liste mit Impact-Icons (rot=down, gelb=degraded)
- Pro Mode: Trigger, betroffene Komponenten, Cascade, Recovery-Zeit
- Verlinktes SOP/Runbook (Klick oeffnet in /docs)

**Dokumente (unter Failure-Modes):**
- Verlinkte Service-Doku, SOPs, Runbooks
- Klick oeffnet im /docs Viewer

**Erstellen-Dialog (Wizard):**
1. Name, Beschreibung, Criticality (critical/high/medium/low)
2. Komponenten hinzufuegen — Asset aus CMDB suchen + Rolle/Impact/Ports/DNS setzen
3. Failure-Modes definieren — Name, Trigger, betroffene Komponenten, Impact, Cascade
4. Bestaetigen → Service erstellt, Background-Doku startet

### API Endpoints (9 neu)

| Endpoint | Methode | Beschreibung |
|---|---|---|
| GET /api/services | GET | Alle Services mit Komponenten + Failure-Modes + Health |
| GET /api/services/{id} | GET | Service-Detail mit Graph-Daten |
| POST /api/services | POST | Service erstellen |
| PATCH /api/services/{id} | PATCH | Service bearbeiten |
| DELETE /api/services/{id} | DELETE | Service loeschen |
| POST /api/services/{id}/failure-modes | POST | Failure-Mode hinzufuegen |
| DELETE /api/services/{id}/failure-modes/{name} | DELETE | Failure-Mode entfernen |
| GET /api/services/{id}/impact | GET | Impact-Analyse |
| POST /api/services/{id}/generate-docs | POST | Doku-Generierung triggern |

---

## Dateien

### Neue Dateien
| Datei | Beschreibung |
|---|---|
| `apps/web/src/app/services/page.tsx` | WebUI Route |
| `apps/web/src/components/services/ServicesPage.tsx` | Service-Liste + Detail + Graph + Failure-Modes |

### Modifizierte Dateien
| Datei | Aenderung |
|---|---|
| `packages/skills/src/built-in/itsm.ts` | 6 neue Actions, erweiterte create_incident/health_check/create_change |
| `packages/storage/src/repositories/itsm-repository.ts` | failure_modes Feld, Service-Impact-Queries |
| `packages/storage/src/migrations/pg-migrations.ts` | Migration v58: failure_modes Spalte |
| `packages/messaging/src/adapters/http.ts` | 9 neue /api/services/* Endpoints |
| `packages/core/src/alfred.ts` | Service-API Callbacks |
| `apps/web/src/types/api.ts` | ServiceDetail, FailureMode, ServiceComponent Interfaces |
| `apps/web/src/lib/alfred-client.ts` | Service API-Client Methoden |
| `apps/web/src/components/layout/Sidebar.tsx` | Services-Link |
| `packages/types/src/config.ts` | ServiceComponent/FailureMode Interfaces (optional) |

---

## Sicherheit

| Action | Risk | Bestaetigung? |
|---|---|---|
| create_service_from_description | proactive | User wird informiert |
| add/remove/update_failure_mode | proactive | User wird informiert |
| generate_service_docs | proactive | LLM-Kosten, User wird informiert |
| service_impact_analysis | auto | Read-only |
| delete Service | confirm | User muss bestaetigen |

---

## Verifikation

- Service per Chat erstellen: "Alfred HA Cluster mit 3 VMs" → Service mit Komponenten + Failure-Modes
- Service per WebUI erstellen: Wizard durchgehen, Assets auswaehlen, Failure-Modes definieren
- WebUI Graph: Nodes zeigen Assets mit Health-Status, Klick zeigt Details
- Impact-Analyse: "Was passiert wenn .91 ausfaellt?" → zeigt alle betroffenen Services
- Doku-Generierung: Service-Doku + SOPs werden automatisch erstellt, erscheinen in /docs
- ITSM: Incident fuer .91 → zeigt "Alfred HA Cluster: DOWN, Monitoring: DEGRADED"
- N:M: Selbes Asset in 2 Services mit unterschiedlichem Impact
