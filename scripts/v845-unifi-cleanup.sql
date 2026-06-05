-- v845 Cleanup-SQL — UniFi IPS-Alert Watches und Memory-Akkumulation
--
-- DIESES SCRIPT NICHT AUTOMATISCH AUSFÜHREN. Manuell auf .91 prüfen
-- und einzeln entscheiden. Nach v845-Deploy und Verifikation, dass
-- list_alerts wieder funktioniert.
--
-- Hintergrund: Während der 404-Phase hat die Reasoning-Engine 17
-- redundante Watches und ~17 Insight-Memory-Keys akkumuliert, weil sie
-- das "list_alerts schlägt fehl"-Symptom mit immer neuen Watches zu
-- adressieren versuchte.

\set ON_ERROR_STOP on

-- ─── Schritt 1: Bestandsaufnahme (read-only) ─────────────────────────
\echo '── BESTANDSAUFNAHME UniFi-IPS-Alert Watches ──'
SELECT id, name, enabled, condition_field, condition_operator, condition_value,
       interval_minutes, last_triggered_at
FROM watches
WHERE skill_name = 'unifi'
  AND (skill_params LIKE '%list_alerts%' OR name ILIKE '%IPS%')
ORDER BY enabled DESC, created_at ASC;

\echo '── BESTANDSAUFNAHME akkumulierte Memory-Keys ──'
SELECT count(*) AS memory_keys_to_clean
FROM memories
WHERE key LIKE 'unifi_ips%'
   OR key LIKE 'unifi_ipsalert%'
   OR key LIKE 'insight_delivered:%ipsalert%'
   OR key LIKE 'insight_delivered:%ipsalerts%';

-- ─── Schritt 2: Watches konsolidieren ─────────────────────────────────
-- Empfehlung: EIN kanonisches Watch behalten, Rest deaktivieren (NICHT
-- löschen — falls User später entscheidet ihn doch zu reaktivieren).
--
-- Behalten: das jüngste enabled Watch mit gut formuliertem Namen.
-- Vorschlag: '0fbdd6b8-f883-4836-b846-955cb60939dd' (length-basiert,
-- threshold 2000). Falls anderer gewünscht, hier ID anpassen.

\echo '── DRY-RUN: würde 16 Watches deaktivieren ──'
SELECT id, name, enabled FROM watches
WHERE skill_name = 'unifi'
  AND id <> '0fbdd6b8-f883-4836-b846-955cb60939dd'
  AND (skill_params LIKE '%list_alerts%' OR name ILIKE '%IPS%')
  AND enabled = 1;

-- AKTIVIEREN (nach manueller Bestätigung):
-- UPDATE watches SET enabled = 0
-- WHERE skill_name = 'unifi'
--   AND id <> '0fbdd6b8-f883-4836-b846-955cb60939dd'
--   AND (skill_params LIKE '%list_alerts%' OR name ILIKE '%IPS%')
--   AND enabled = 1;

-- ─── Schritt 3: Kanonisches Watch aktualisieren ───────────────────────
-- Mit v845 unterstützt list_alerts den `filter`-Parameter. Das behaltene
-- Watch sollte ihn nutzen, damit nur EVT_IPS_IpsAlert gezählt werden
-- (sonst zählt es alle 2400+ Alarms inkl. AP-Lost-Contact etc.).

\echo '── DRY-RUN: kanonisches Watch updaten ──'
SELECT id, name, skill_params, condition_value FROM watches
WHERE id = '0fbdd6b8-f883-4836-b846-955cb60939dd';

-- AKTIVIEREN (nach manueller Bestätigung):
-- UPDATE watches
-- SET skill_params = '{"action":"list_alerts","filter":"EVT_IPS_IpsAlert"}',
--     condition_field = 'data.count',
--     condition_operator = 'gt',
--     condition_value = '50',
--     name = 'UniFi IPS-Alert Backlog (kanonisch, v845)'
-- WHERE id = '0fbdd6b8-f883-4836-b846-955cb60939dd';

-- ─── Schritt 4: Memory-Cleanup ────────────────────────────────────────
-- insight_delivered:* sind temporäre Cache-Markierungen aus dem Reasoning-
-- Engine "diese Insight wurde bereits dem User gemeldet". Sicher zu löschen
-- wenn das zugrundeliegende Problem behoben ist.
--
-- unifi_ips_alert_backlog_* sind LLM-generierte Memory-Insights über das
-- Symptom. Bleiben drin (haben historischen Wert), nur die insight_delivered-
-- Marker werden geräumt.

\echo '── DRY-RUN: würde insight_delivered:%ipsalert% löschen ──'
SELECT count(*) AS to_delete FROM memories
WHERE key LIKE 'insight_delivered:%ipsalert%'
   OR key LIKE 'insight_delivered:%ipsalerts%';

-- AKTIVIEREN (nach manueller Bestätigung):
-- DELETE FROM memories
-- WHERE key LIKE 'insight_delivered:%ipsalert%'
--    OR key LIKE 'insight_delivered:%ipsalerts%';

\echo '── FERTIG. Keine destructive operation ausgeführt. ──'
