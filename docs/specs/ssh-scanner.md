# SSH Network Scanner — Spezifikation

**Version:** 1.0 Draft
**Datum:** 2026-04-07
**Status:** Entwurf — Noch nicht freigegeben

## Zusammenfassung

SSH-basierter Scanner der im CMDB Discovery-Cycle aktive VMs/LXCs/Server per SSH scannt um Netzwerk-Connections (Service-Dependencies), Listening-Services und System-Load zu entdecken.

## Status: NICHT UMSETZEN — Offene Punkte

1. Root-Zugang auf allen Hosts als Voraussetzung für `ss -tpn` mit Prozess-Info
2. Keine Metadaten welche Hosts SSH-fähig sind
3. Zwei-Pass Cross-Host-Matching Komplexität
4. Duplikat-Erkennung mit Docker/Proxmox Discovery
5. Auto-Service-Component Zuordnung Validierung
6. Per-Host SSH-User Konfiguration

## Referenz

Siehe `docs/specs/satellite-agent.md` für die langfristige Lösung (Alfred Agent).

## Wenn umgesetzt

- Als Discovery-Source `ssh_scanner` nach Proxmox/Docker/UniFi
- Port-Whitelist statt alles entdecken (5432, 3306, 6379, 9000, 80, 443, etc.)
- testSsh Pre-Check (2s) vor vollem Scan
- Shared SSH-Utility statt Code-Duplizierung
- sudo-Option konfigurierbar
- ~8h Aufwand
