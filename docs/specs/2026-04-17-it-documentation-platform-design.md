# IT Documentation Platform — Design Spec

## Goal

Alfred wird zur vollstaendigen IT-Dokumentationsplattform. System-Dokumentation, Service-Dokumentation, Runbooks, SOPs, Config-Snapshots, Netzwerk-Doku und Policies — alles persistent, versioniert, an CMDB-Assets gebunden, und per Chat oder WebUI verwaltbar.

## Architecture

Kein neues Modul — Erweiterung von 3 bestehenden Skills + WebUI + ReflectionEngine:

- **InfraDocs Skill (erweitert):** 25 Actions (7 bestehend + 18 neu). Dokument-CRUD, Auto-Generate, Runbook-Management, Versioning, Suche
- **ITSM Skill (erweitert):** Auto-Suggest Runbook bei Incidents, Runbook-Linking bei Changes, Problem→Runbook Generierung
- **CMDB Skill (erweitert):** 1 neue Action (asset_docs)
- **WebUI /docs (erweitert):** Sidebar-Baumansicht, Markdown-Viewer, Inline-Editor, Versioning, Suche
- **ReflectionEngine (erweitert):** DocReflector — monatliche Config-Snapshots, Stale-Doc-Erkennung, Runbook-Validierung

## Tech Stack

- TypeScript (bestehend)
- PostgreSQL/SQLite (bestehend, cmdb_documents Tabelle existiert)
- LLM fuer Auto-Generierung (strong tier)
- Pino Logger (bestehend)
- React/Next.js WebUI (bestehend)

## DB Schema

### Bestehend (cmdb_documents)
```sql
CREATE TABLE cmdb_documents (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL,
  doc_type TEXT NOT NULL,    -- erweitert um: system_doc, service_doc, setup_guide, config_snapshot, sop, network_doc, policy
  title TEXT NOT NULL,
  content TEXT NOT NULL,
  format TEXT NOT NULL DEFAULT 'markdown',
  linked_entity_type TEXT,   -- asset, service, incident, change_request, problem
  linked_entity_id TEXT,
  version INTEGER NOT NULL DEFAULT 1,
  generated_by TEXT DEFAULT 'infra_docs',
  created_at TEXT NOT NULL
);
```

### Neue Spalte auf cmdb_change_requests
```sql
ALTER TABLE cmdb_change_requests ADD COLUMN runbook_id TEXT DEFAULT NULL;
```

### Neue doc_type Werte
- `system_doc` — VM/Server Dokumentation (Hardware, OS, Netzwerk, Software)
- `service_doc` — Multi-VM Service Dokumentation (Architektur, Komponenten)
- `setup_guide` — Schritt-fuer-Schritt Installationsanleitung
- `config_snapshot` — Automatischer Config-Dump (Dateien, ENV, Ports)
- `sop` — Standard Operating Procedure
- `network_doc` — Netzwerk-Dokumentation (VLANs, Firewall, DNS, Routing)
- `policy` — IT-Richtlinien und Entscheidungen
- Bestehend: `runbook`, `postmortem`, `inventory`, `topology`, `service_map`, `change_log`, `problem_analysis`, `custom`

---

## InfraDocs Skill — Actions (25 total)

### Bestehende Actions (7, bleiben unveraendert)
- `inventory_report`, `topology_diagram`, `service_map`, `runbook` (LLM-generiert), `change_log`, `incident_report`, `export`

### Neue Actions: Dokument-CRUD (6)

| Action | Input | Beschreibung |
|---|---|---|
| `create_doc` | doc_type, title, content, linked_entity_type?, linked_entity_id?, format? | Dokument erstellen (manuell oder mit LLM-Content) |
| `get_doc` | doc_id ODER (linked_entity_type + linked_entity_id + doc_type) | Dokument lesen |
| `update_doc` | doc_id, content, title? | Neue Version erstellen (alte bleibt) |
| `delete_doc` | doc_id | Dokument loeschen |
| `list_docs` | doc_type?, linked_entity_type?, linked_entity_id?, search?, limit? | Dokumente auflisten |
| `search_docs` | query, doc_type?, limit? | Volltextsuche ueber Content + Titel |

### Neue Actions: Auto-Generierung (4)

| Action | Input | Beschreibung |
|---|---|---|
| `generate_system_doc` | asset_id ODER asset_name | Scannt Asset via Skills (Proxmox, Docker, Shell), generiert System-Doku |
| `generate_service_doc` | service_id ODER service_name | Scannt Service + Komponenten, generiert Service-Doku |
| `generate_network_doc` | scope? (full, vlan, firewall, dns) | Scannt MikroTik + pfSense + Cloudflare + UniFi, generiert Netzwerk-Doku |
| `generate_config_snapshot` | asset_id ODER asset_name | Liest Configs aus (Dateien, ENV, Ports), speichert als Snapshot |

#### Auto-Generate Ablauf (generate_system_doc)
1. CMDB: Asset laden (IP, OS, Typ, Tags, Relations)
2. Proxmox/Docker: VM-Config, Container, Ports, Volumes
3. Shell (SSH): installierte Pakete, Services, Disk-Usage, Netzwerk
4. CMDB Relations: welche Services laufen auf diesem Asset?
5. Bestehende Doku laden (merge, nicht ueberschreiben)
6. LLM (strong tier): strukturierte Markdown-Doku generieren
7. Speichern als cmdb_document (type: system_doc)

#### Auto-Generate Ablauf (generate_config_snapshot)
1. Asset-Typ ermitteln (VM, Container, Network Device, etc.)
2. Typ-spezifische Config auslesen:
   - VM/LXC → Proxmox API (CPU, RAM, Disk, Network, OS)
   - Container → Docker inspect (Image, Ports, Volumes, ENV, Restart)
   - Server → Shell SSH (OS, Pakete, Services, Disk, Netzwerk)
   - Network → MikroTik/pfSense (Interfaces, Rules, VLANs, DHCP, Routes)
   - DNS → Cloudflare (Records pro Zone)
   - Proxy → Nginx PM (Hosts, Certificates)
   - Backup → Commvault (Clients, Plans, Storage, Media Agents)
3. Speichern als cmdb_document (type: config_snapshot, neue Version)

### Neue Actions: Runbook-Management (5)

| Action | Input | Beschreibung |
|---|---|---|
| `create_runbook` | title, content?, service_id?, incident_id?, auto_generate? | Manuell oder LLM-generiert aus Incident/Problem-Kontext |
| `get_runbook` | runbook_id | Runbook lesen |
| `update_runbook` | runbook_id, content, title? | Runbook bearbeiten (neue Version) |
| `suggest_runbook` | query ODER incident_id | Passende Runbooks finden (Keyword-Match auf Titel + Content) |
| `execute_runbook` | runbook_id | Runbook-Schritte als Workflow ausfuehren (AutomationBuilder) |

#### Runbook Auto-Suggest Logik
1. Keywords aus Incident-Titel + Symptoms extrahieren (>=4 chars, sortiert)
2. Alle Runbooks laden (cmdb_documents WHERE doc_type = 'runbook')
3. Keyword-Match: >=2 shared words zwischen Incident-Keywords und Runbook-Titel/Content
4. Top-3 Matches zurueckgeben mit Relevanz-Score

#### Runbook Execute Logik
1. Runbook-Content parsen: Schritte erkennen (nummerierte Liste oder Markdown-Headers)
2. Fuer jeden Schritt: pruefen ob ein Skill-Call moeglich ist (Pattern-Match auf bekannte Aktionen)
3. Workflow erstellen mit den erkannten Steps
4. Workflow im Confirmation-Modus starten (jeder Step braucht Bestaetigung)

### Neue Actions: Versioning (3)

| Action | Input | Beschreibung |
|---|---|---|
| `doc_versions` | doc_id ODER (entity_type + entity_id + doc_type) | Alle Versionen auflisten |
| `doc_diff` | doc_id, version_a, version_b | Zeilenweiser Diff zwischen zwei Versionen |
| `doc_revert` | doc_id, target_version | Auf aeltere Version zuruecksetzen (erstellt neue Version mit altem Content) |

---

## ITSM Skill — Erweiterungen

### 1. Auto-Suggest Runbook bei create_incident
In der bestehenden `create_incident` Methode:
- Nach Incident-Erstellung: Keyword-Suche in Runbooks
- Wenn Matches gefunden: im Response-Display anzeigen
- Kein neuer Action-Name, integriert in bestehenden Flow

### 2. Runbook-Linking bei Change Requests
- `create_change_request` und `update_change` akzeptieren optionales `runbook_id` Feld
- Migration: `ALTER TABLE cmdb_change_requests ADD COLUMN runbook_id TEXT DEFAULT NULL`

### 3. Problem → Runbook Vorschlag
In der bestehenden `update_problem` Methode:
- Wenn Status auf `root_cause_identified` wechselt und kein Runbook verknuepft ist
- Im Response-Display Vorschlag: "Soll ich ein Runbook fuer zukuenftige Incidents erstellen?"

---

## CMDB Skill — 1 neue Action

| Action | Input | Beschreibung |
|---|---|---|
| `asset_docs` | asset_id ODER service_id | Alle Dokumente fuer ein Asset/Service auflisten |

---

## WebUI /docs Erweiterung

### Layout: Sidebar + Content

**Sidebar:**
- Baumansicht gruppiert nach: Assets, Services, Runbooks, SOPs, Network, Policies
- Jeder Knoten zeigt Anzahl Dokumente
- Klick oeffnet Dokument im Content-Bereich
- Suchfeld oben

**Content:**
- Markdown-Rendering (react-markdown, bereits als Dependency vorhanden)
- Mermaid-Diagramme inline gerendert (wenn format=mermaid)
- Toolbar: [Bearbeiten] [Versionen] [Neu generieren] [Loeschen]
- Version-Dropdown (wenn mehrere Versionen existieren)

**Editor:**
- Textarea mit Markdown-Preview (Side-by-Side oder Toggle)
- Speichern erstellt neue Version
- Typ + Entity-Verknuepfung beim Erstellen waehlbar

**Diff-View:**
- Zwei Versionen nebeneinander
- Geaenderte Zeilen hervorgehoben (gruen=hinzugefuegt, rot=entfernt)

### API-Endpoints (7 neu)

| Endpoint | Methode | Beschreibung |
|---|---|---|
| GET /api/docs/list | GET | Alle Dokumente (filter: type, entity, search) |
| GET /api/docs/{id} | GET | Einzelnes Dokument |
| POST /api/docs | POST | Dokument erstellen |
| PATCH /api/docs/{id} | PATCH | Dokument bearbeiten (neue Version) |
| DELETE /api/docs/{id} | DELETE | Dokument loeschen |
| GET /api/docs/{id}/versions | GET | Versionen auflisten |
| GET /api/docs/tree | GET | Baumstruktur (Assets + Services + Docs gruppiert) |

---

## ReflectionEngine — DocReflector

### Neuer Reflector: DocReflector

Laeuft monatlich (konfigurierbar). Drei Aufgaben:

**1. Config-Snapshots (monatlich)**
- Alle aktiven CMDB-Assets laden
- Fuer jedes: letzten config_snapshot pruefen
- Wenn aelter als configSnapshotIntervalDays (default: 30) oder nicht vorhanden:
  - Config via Skills auslesen (Typ-abhaengig)
  - Neuen Snapshot speichern
  - Risk: auto (leise)

**2. Stale-Doc-Erkennung**
- Alle Dokumente pruefen: letzte Version aelter als staleDocWarningDays (default: 90)?
- Wenn ja: ReflectionResult mit risk: proactive ("Doku fuer X ist 95 Tage alt — Update empfohlen")

**3. Runbook-Validierung**
- Alle Runbooks laden
- Fuer jedes: verknuepfte Assets/Services pruefen (existieren sie noch? Status?)
- Wenn decommissioned/geloescht: ReflectionResult mit risk: proactive ("Runbook X referenziert geloeschtes Asset Y")

### Konfiguration
```yaml
reflection:
  docs:
    enabled: true
    configSnapshotIntervalDays: 30
    staleDocWarningDays: 90
    runbookValidation: true
```

### Runbook-Verweis im Reasoning-Kontext
Der ReasoningContextCollector prueft bei ITSM-Incidents ob passende Runbooks existieren und haengt sie als Hinweis an die ITSM-Section an.

---

## Sicherheit

| Action | Risk | Bestaetigung? |
|---|---|---|
| create_doc, update_doc, create_runbook, update_runbook | proactive | Nein (Doku schreiben ist low-risk) |
| delete_doc | proactive | User wird informiert |
| generate_* | proactive | User wird informiert (LLM-Kosten) |
| execute_runbook | confirm | Jeder Step braucht Bestaetigung |
| doc_revert | proactive | User wird informiert |

---

## Dateien + Aenderungen

### Neue Dateien
| Datei | Beschreibung |
|---|---|
| `packages/core/src/reflection/doc-reflector.ts` | Config-Snapshots, Stale-Detection, Runbook-Validierung |
| `apps/web/src/app/docs/page.tsx` | WebUI Docs-Seite (Routing) |
| `apps/web/src/components/docs/DocsPage.tsx` | Baumansicht + Viewer + Editor |

### Modifizierte Dateien
| Datei | Aenderung |
|---|---|
| `packages/skills/src/built-in/infra-docs.ts` | 18 neue Actions |
| `packages/skills/src/built-in/itsm.ts` | Runbook Auto-Suggest, Change-Linking |
| `packages/skills/src/built-in/cmdb.ts` | asset_docs Action |
| `packages/storage/src/migrations/pg-migrations.ts` | Migration: runbook_id auf change_requests |
| `packages/storage/src/repositories/cmdb-repository.ts` | Erweiterte Document-Queries (Suche, Tree) |
| `packages/messaging/src/adapters/http.ts` | 7 neue /api/docs/* Endpoints |
| `packages/core/src/alfred.ts` | Docs-API Callbacks, DocReflector wiring |
| `packages/core/src/reflection-engine.ts` | DocReflector einbinden |
| `packages/core/src/reasoning-context-collector.ts` | Runbook-Suggest in ITSM-Section |
| `apps/web/src/types/api.ts` | Document-Types |
| `apps/web/src/lib/alfred-client.ts` | Docs API-Client Methoden |
| `apps/web/src/components/layout/Sidebar.tsx` | Docs-Link aktualisieren |

---

## Verifikation

- InfraDocs CRUD: Dokument erstellen, lesen, bearbeiten, versionieren, loeschen
- Auto-Generate: `generate_system_doc` fuer eine bekannte VM → pruefe ob Proxmox/Docker/Shell-Daten korrekt zusammengefuehrt werden
- Runbook: erstellen, bei neuem Incident auto-suggest, execute als Workflow
- Config-Snapshot: manuell ausloesen, pruefen ob Daten korrekt gespeichert
- WebUI: Baumansicht navigieren, Dokument oeffnen, bearbeiten, Versionen vergleichen
- ReflectionEngine: DocReflector simulieren, pruefen ob Stale-Warnungen kommen
