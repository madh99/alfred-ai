-- Auswertungsblock ~26.10.2026 (Spec docs/specs/2026-10-04-jarvis-architektur.md) — NUR LESEN.
-- Aufruf auf .92: psql "$DSN" -v ab="'2026-10-12'" -f 2026-10-26.sql
-- Alle Zeitspalten sind TEXT (ISO, UTC) → Vergleiche immer über ::timestamptz.
\if :{?ab}
\else
  \set ab '''2026-10-12'''
\endif
\pset footer off

\echo '=== E2 Haltefristen: Befunde je Quelle (seit :ab) ==='
-- Haltefrist wie core/src/vorgaenge/regeln.ts haltefristMin (haus-check: nie Vorgang; lebenszeichen/Sicherheit: 0)
WITH b AS (
  SELECT quelle, gegenstand, zustand, vorgang_id, entstanden::timestamptz AS ent, erledigt_am::timestamptz AS erl,
    CASE
      WHEN quelle = 'haus-check' THEN NULL
      WHEN quelle = 'lebenszeichen' OR (quelle || ':' || gegenstand) ~* '(rauch|smoke|carbon_monoxide|(^|[:._])co([:._]|$)|wasser|moisture|leck|leak|alarm|einbruch|sabotage|tamper|intrusion)' THEN 0 -- = SICHERHEIT in regeln.ts
      WHEN lower(gegenstand) ~ 'baseline' THEN 1440
      WHEN lower(gegenstand) ~ '(batter|akku|:leer|niedrig|low)' OR quelle = 'sensorbatterien' THEN 1440
      ELSE 120
    END AS frist_min
  FROM befunde WHERE entstanden::timestamptz >= :ab::timestamptz
)
SELECT quelle,
  count(*) AS befunde,
  count(*) FILTER (WHERE vorgang_id IS NOT NULL) AS mit_vorgang,
  count(*) FILTER (WHERE erl IS NOT NULL) AS erledigt,
  max(frist_min) AS frist_min,
  count(*) FILTER (WHERE erl IS NOT NULL AND frist_min IS NOT NULL AND extract(epoch FROM erl - ent) / 60 < frist_min) AS innerhalb_frist_erledigt,
  count(*) FILTER (WHERE vorgang_id IS NOT NULL AND erl IS NOT NULL AND frist_min IS NOT NULL AND extract(epoch FROM erl - ent) / 60 < frist_min) AS vorgang_waere_entfallen,
  round(percentile_cont(0.5) WITHIN GROUP (ORDER BY extract(epoch FROM erl - ent) / 60)::numeric, 0) AS median_dauer_min
FROM b GROUP BY quelle ORDER BY befunde DESC;

\echo '=== E2: Befund-Vorgänge je Woche und Ausgang (Ziel ≤ 15/Woche) ==='
SELECT to_char(date_trunc('week', erstellt::timestamptz), 'YYYY-MM-DD') AS woche, split_part(dedupe_key, ':', 2) AS befund_quelle, status, coalesce(ergebnis_art, '-') AS ergebnis_art, count(*)
FROM vorgaenge WHERE dedupe_key LIKE 'befund:%' AND erstellt::timestamptz >= :ab::timestamptz
GROUP BY 1, 2, 3, 4 ORDER BY 1, 5 DESC;

\echo '=== Haus-Check: Läufe aus dem Job-Register (nur Sonntag 09:00; Erst-/Änderungsläufe siehe Log-Auswertung) ==='
SELECT started_at, ok, zaehler, left(coalesce(fehler, ''), 120) AS fehler FROM job_runs
WHERE job_key = 'haus-check' AND started_at::timestamptz >= :ab::timestamptz ORDER BY started_at::timestamptz;

\echo '=== Haus-Check: Befunde je Regel (gegenstand bis zum ersten Doppelpunkt) und Zustand ==='
SELECT split_part(gegenstand, ':', 1) AS regel, zustand, count(*), round(avg(gesehen_anzahl)::numeric, 1) AS gesehen_avg
FROM befunde WHERE quelle = 'haus-check' GROUP BY 1, 2 ORDER BY 3 DESC;

\echo '=== K1/Schleife 2: Hinweis-Reaktionen je Kategorie (seit :ab) ==='
SELECT category, coalesce(reaktion, '(keine)') AS reaktion, status, count(*)
FROM alfred_insights WHERE created_at::timestamptz >= :ab::timestamptz
GROUP BY 1, 2, 3 ORDER BY 1, 4 DESC;

\echo '=== K1: Präzision je Kategorie = nützlich / (nützlich + negativ); negativ wie NEGATIV in insights/hinweis-reaktion.ts ==='
SELECT category,
  count(*) FILTER (WHERE reaktion = 'nuetzlich') AS nuetzlich,
  count(*) FILTER (WHERE reaktion IN ('nicht_nuetzlich', 'bekannt', 'falsch', 'kein_interesse', 'zu_oft')) AS negativ,
  count(*) FILTER (WHERE reaktion = 'bekannt') AS davon_bekannt,
  count(*) FILTER (WHERE reaktion IN ('gelesen', 'besprochen')) AS neutral,
  round(100.0 * count(*) FILTER (WHERE reaktion = 'nuetzlich') / nullif(count(*) FILTER (WHERE reaktion IN ('nuetzlich', 'nicht_nuetzlich', 'bekannt', 'falsch', 'kein_interesse', 'zu_oft')), 0), 0) AS praezision_pct
FROM alfred_insights WHERE created_at::timestamptz >= :ab::timestamptz AND reaktion IS NOT NULL
GROUP BY 1 ORDER BY 2 + 3 DESC;

\echo '=== Kennzahlen-Zähler (messwerte, quelle=kennzahl) seit :ab ==='
SELECT entity, count(*) AS messungen, sum(wert) AS summe, max(gemessen_at) AS zuletzt
FROM messwerte WHERE quelle = 'kennzahl' AND gemessen_at::timestamptz >= :ab::timestamptz
GROUP BY 1 ORDER BY 1;

\echo '=== Schleife 2: Erledigung je Kategorie, 28 Tage (Kandidat Digest: Quote < 25 % bei ≥ 4 abgeschlossenen) ==='
SELECT coalesce(kategorie, '(ohne)') AS kategorie,
  count(*) AS angelegt,
  count(*) FILTER (WHERE status = 'erledigt') AS erledigt,
  count(*) FILTER (WHERE status = 'verworfen') AS verworfen,
  count(*) FILTER (WHERE status IN ('offen', 'wartet')) AS offen,
  round(100.0 * count(*) FILTER (WHERE status = 'erledigt') / nullif(count(*) FILTER (WHERE status IN ('erledigt', 'verworfen')), 0), 0) AS quote_pct,
  CASE WHEN count(*) FILTER (WHERE status IN ('erledigt', 'verworfen')) >= 4
        AND count(*) FILTER (WHERE status = 'erledigt')::numeric / nullif(count(*) FILTER (WHERE status IN ('erledigt', 'verworfen')), 0) < 0.25
       THEN 'Kandidat Digest' ELSE '' END AS hinweis
FROM vorgaenge WHERE erstellt::timestamptz >= now() - interval '28 days'
GROUP BY 1 ORDER BY 2 DESC;

-- L0: Proben und Tests laufen über chat_id „api-…“ und zählen nicht. Kanal „api“ umfasst App, Geräte-Sitzungen und Fäden → Herkunft aus chat_id.
\echo '=== L0: Herkunft der Anfragen (ohne Proben api-…) ==='
SELECT CASE WHEN chat_id LIKE 'sitzung:%' THEN 'Geräte-Sitzung' WHEN chat_id LIKE 'owner:faden:%' THEN 'App-Faden' WHEN kanal = 'telegram' THEN 'Telegram' ELSE kanal || ':' || left(chat_id, 12) END AS herkunft,
  count(*), round(100.0 * count(*) FILTER (WHERE folgesignal IS NOT NULL) / count(*), 0) AS folgesignal_pct
FROM anfrage_protokoll WHERE zeit::timestamptz >= :ab::timestamptz AND chat_id NOT LIKE 'api-%'
GROUP BY 1 ORDER BY 2 DESC;

\echo '=== L0: Absicht = erstes Werkzeug (Skill/Aktion) — Häufigkeit, Folgesignale, Dauer, Kosten, Runden ==='
SELECT coalesce(nullif(werkzeuge::jsonb -> 0 ->> 'skill', '') || '/' || coalesce(werkzeuge::jsonb -> 0 ->> 'aktion', '-'), '(ohne Werkzeug)') AS absicht,
  count(*) AS anfragen,
  count(*) FILTER (WHERE folgesignal = 'korrigiert') AS korrigiert,
  count(*) FILTER (WHERE folgesignal = 'wiederholt') AS wiederholt,
  count(*) FILTER (WHERE folgesignal = 'abgebrochen') AS abgebrochen,
  round(percentile_cont(0.5) WITHIN GROUP (ORDER BY dauer_ms)::numeric / 1000, 1) AS p50_s,
  round(sum(kosten_usd)::numeric, 2) AS kosten_usd,
  round(avg(runden)::numeric, 1) AS runden_avg
FROM anfrage_protokoll WHERE zeit::timestamptz >= :ab::timestamptz AND chat_id NOT LIKE 'api-%'
GROUP BY 1 ORDER BY 2 DESC LIMIT 25;

\echo '=== L0: je Stufe und Modell (ohne Proben) ==='
SELECT coalesce(stufe, '-') AS stufe, coalesce(modell, '-') AS modell, count(*),
  round(100.0 * count(*) FILTER (WHERE folgesignal IS NOT NULL) / count(*), 0) AS folgesignal_pct,
  round(percentile_cont(0.5) WITHIN GROUP (ORDER BY dauer_ms)::numeric / 1000, 1) AS p50_s
FROM anfrage_protokoll WHERE zeit::timestamptz >= :ab::timestamptz AND chat_id NOT LIKE 'api-%'
GROUP BY 1, 2 ORDER BY 3 DESC;

\echo '=== L0: wiederkehrende Fragen (gleicher Textanfang ≥ 3×, ohne Proben) — Kandidaten für L1 ==='
SELECT left(lower(regexp_replace(text_auszug, '\s+', ' ', 'g')), 60) AS frage, count(*)
FROM anfrage_protokoll WHERE zeit::timestamptz >= :ab::timestamptz AND chat_id NOT LIKE 'api-%'
GROUP BY 1 HAVING count(*) >= 3 ORDER BY 2 DESC LIMIT 20;
