# Spec: Mehrsprachige News-Artikel für fussball.cc (Option A, Plattform-Seite)

**Für:** Projekt-Agent fussball.cc · **Zulieferer:** Alfred Social-Skill (ab v1006)
**Kontext:** Die Site-UI ist bereits 4-sprachig (de/en/fr/it via NEXT_LOCALE-Cookie),
NewsPost ist aber einsprachig. Alfred liefert ab sofort beim Veröffentlichen
fertige Übersetzungen mit — die Plattform muss sie nur speichern und rendern.

## 1. Eingang: erweitertes Publish-Payload

Alfred sendet an den bestehenden Publish-Endpoint (`POST /api/integrations/…`,
unverändert) zusätzlich ein optionales Feld:

```json
{
  "title": "Kolumbien komplettiert das Achtelfinale",
  "body": "…",
  "status": "PUBLISHED",
  "translations": {
    "en": { "title": "Colombia completes the round of 16", "body": "…" },
    "fr": { "title": "…", "body": "…" },
    "it": { "title": "…", "body": "…" }
  }
}
```

- `translations` ist optional und kann fehlen (einsprachiger Artikel) oder
  nur einen Teil der Locales enthalten (Übersetzung war best-effort).
- Schlüssel sind ISO-639-1-Codes, passend zu den Site-Locales.
- Unbekannte Locales ignorieren, nicht ablehnen.

## 2. Datenmodell

Neues Modell `NewsPostTranslation` (Prisma):

```prisma
model NewsPostTranslation {
  id        String   @id @default(cuid())
  postId    String
  locale    String   // "en" | "fr" | "it" | …
  title     String
  body      String   @db.Text
  createdAt DateTime @default(now())
  updatedAt DateTime @updatedAt
  post      NewsPost @relation(fields: [postId], references: [id], onDelete: Cascade)
  @@unique([postId, locale])
}
```

Upsert je `[postId, locale]` — ein erneutes Publish/Update desselben Artikels
mit translations überschreibt die vorhandene Übersetzung.

## 3. Rendering

- Artikel-Seite (`/news/[slug]`): Ist `NEXT_LOCALE` ≠ Basis-Sprache UND eine
  Übersetzung vorhanden → übersetzten Titel/Body rendern; sonst Fallback auf
  das Original (mit dezentem Hinweis „Dieser Artikel ist nur auf Deutsch
  verfügbar" in der UI-Sprache).
- News-Listen/Teaser: gleiche Logik für den Titel.
- SEO: `hreflang`-Links zwischen den Sprachversionen; kanonische URL bleibt
  der Original-Slug (keine übersetzten Slugs in Phase 1).

## 4. Management-API / Admin

- `GET /api/integrations/…` (Artikel-Detail, falls vorhanden): translations
  mit ausliefern.
- Admin-Editor: Tabs je Locale (de = Original, weitere read/write) — Phase 2,
  wenn Zeit; Phase 1 braucht nur Speichern + Rendern.

## 5. Nicht-Ziele (Phase 1)

- KEINE übersetzten Slugs/URLs, KEINE automatische Übersetzung auf
  Plattform-Seite (macht Alfred), KEINE Übersetzung von Alt-Artikeln
  (nur neue Publishes tragen translations).

## 6. Alfred-Seite (bereits implementiert, v1006)

- Kanal-Config `translate_to: ["en","fr","it"]` auf dem fussball.cc-Kanal
  aktiviert die Mitlieferung; die Übersetzung passiert beim Publish (LLM,
  best-effort — schlägt sie fehl, kommt der Artikel einsprachig und die
  Plattform rendert Fallback).
- `language: "de"` ist die deklarierte Basis-Sprache des Kanals.
