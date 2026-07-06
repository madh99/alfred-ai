# Spec: Traffic-Statistik-API für fussball.cc (Klick-Rückkanal)

**Für:** Projekt-Agent fussball.cc · **Konsument:** Alfred Social-Skill (`collectTrafficStats`, ab v1001)
**Zweck:** Alfred postet auf Social-Kanälen Links zu Artikeln (mit UTM-Parametern, seit v999).
Dieser Endpoint liefert zurück, wie viele Besucher je Artikel und je Quelle kamen —
Alfred legt das als Kanal-Metriken ab und lernt daraus, welcher Kanal Traffic bringt.

## Endpoint

```
GET /api/integrations/stats?since=<ISO-8601>[&until=<ISO-8601>]
Authorization: Bearer <API_TOKEN>          ← derselbe Token wie /api/integrations/media
```

- `since` (Pflicht): Beginn des Zeitfensters (Alfred fragt täglich die letzten 7 Tage ab).
- `until` (optional): Ende, Default jetzt.
- Ohne/mit falschem Token → `401` (wie bestehende Integrations-Endpoints).

## Response

```json
{
  "ok": true,
  "audience": { "followers": 1234 },
  "data": [
    {
      "date": "2026-07-05",
      "path": "/news/kolumbien-komplettiert-das-achtelfinale",
      "views": 143,
      "sources": {
        "telegram_channel": 12,
        "facebook": 3,
        "instagram": 1
      }
    }
  ]
}
```

- **`audience` (NEU, v1019 — Kanalwachstum)**: aktueller Bestand der
  Plattform-Zielgruppe als `{ "followers": n }`. Für fussball.cc konkret:
  **Anzahl der registrierten User** (`COUNT(*) FROM users` ohne
  anonymisierte Konten). Generisch: jede Plattform meldet hier die Zahl,
  die für sie „Abonnenten" bedeutet. Optional — fehlt das Feld, trackt
  Alfred für diesen Kanal einfach kein Wachstum.
- **Eine Zeile je Artikel je Tag** im Zeitfenster (nur Tage mit `views > 0`).
- `date`: lokaler Kalendertag `YYYY-MM-DD`.
- `path`: URL-Pfad des Artikels (Alfred matcht ihn per `externalUrl.includes(path)`
  auf seine veröffentlichten Beiträge — bitte den kanonischen Pfad liefern,
  derselbe wie in der URL, die die Publish-API zurückgibt).
- `views`: Seitenaufrufe des Artikels an dem Tag (gesamt, alle Quellen).
- `sources`: Aufrufe aufgeschlüsselt nach `utm_source` (nur Aufrufe MIT utm_source;
  die Schlüssel kommen 1:1 aus dem Query-Parameter — Alfred sendet
  `telegram_channel`, `facebook`, `instagram`, `x`, `threads`, `youtube`).
  Quellen ohne utm_source (direct, organisch, Referrer) NICHT aufnehmen —
  Alfred ignoriert unbekannte Schlüssel ohnehin.

## Datenquelle (Vorschlag)

Die `ClickTracking`-Tabelle existiert bereits. Nötig ist:
1. Beim Seitenaufruf eines NewsPost `utm_source` (falls vorhanden) mit erfassen
   (Spalte oder JSON-Feld ergänzen, Migration).
2. Der Endpoint aggregiert: `GROUP BY date(created_at), post_path, utm_source`.
3. Performance: Index auf (created_at, path) genügt; das Fenster ist ≤ 7 Tage.

## Nicht-Ziele

- Keine Realtime-Anforderung — Alfred pollt einmal täglich um 07:00.
- Keine Nutzer-/Session-Daten, nur aggregierte Zähler (DSGVO-unkritisch).
- Kein Schreiben — reiner Lese-Endpoint.

## Alfred-Seite (bereits implementiert, v1001)

- Pollt täglich je rest-Kanal `config.base_url + (config.stats_path ?? '/api/integrations/stats')`.
- `views` → `channel_metrics` (kind `views`) auf dem Website-Kanal, dem Artikel-Item zugeordnet.
- `sources.<platform>` → kind `clicks` auf dem Familien-Kanal dieser Plattform,
  dem Follower-Beitrag derselben Story zugeordnet (falls auflösbar).
- Fehlender Endpoint (404) ist KEIN Fehler — Alfred bleibt still, bis es ihn gibt.
- Abschaltbar je Kanal: `config.traffic_stats: false`.
