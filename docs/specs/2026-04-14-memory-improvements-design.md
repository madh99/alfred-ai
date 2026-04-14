# Memory System Improvements — Design Spec

Inspiriert von OpenClaw Memory-Architektur. 5 Verbesserungen für Alfreds Memory-System.

---

## 1. Semantic Memory Search (Embedding-basiert)

### Problem
Alfred sucht Memories per `ILIKE` — "BMW laden" findet nicht "Fahrzeug aufladen". Keyword-Suche verpasst semantisch verwandte Inhalte.

### Lösung
Hybrid-Search: Embedding-Vektor-Suche + bestehende Keyword-Suche, Ergebnisse gemerged mit gewichtetem Scoring.

### Architektur

```
User-Query → [Embedding Provider] → Vector
                                       ↓
                              pgvector cosine similarity
                                       ↓
                              + BM25/ILIKE Keyword-Match
                                       ↓
                              Weighted Merge (0.6 vector + 0.4 keyword)
                                       ↓
                              Top-N Results
```

### Implementierung

**DB-Änderung:**
- PostgreSQL: `CREATE EXTENSION IF NOT EXISTS vector`
- Neue Spalte: `ALTER TABLE memories ADD COLUMN embedding vector(384)` (384 = Mistral embed dimension)
- Index: `CREATE INDEX ON memories USING ivfflat (embedding vector_cosine_ops) WITH (lists = 50)`
- SQLite: `embedding BLOB` (cosine similarity in-process berechnen)

**Embedding-Provider:**
- Nutzt den bestehenden LLM-Provider-Mechanismus (`@alfred/llm`)
- Default: Mistral `mistral-embed` (bereits API-Key vorhanden, 384 Dimensionen)
- Fallback: OpenAI `text-embedding-3-small` (1536 Dim)
- Config: `memory.embeddingProvider: 'mistral' | 'openai' | 'none'`

**Memory-Repository Erweiterung:**
```typescript
// Beim Speichern: Embedding generieren + speichern
async save(userId, key, value, ...): Promise<Memory> {
  const embedding = await this.embedder?.embed(value);
  // ... INSERT mit embedding
}

// Neue Methode: Semantic Search
async semanticSearch(userId: string, query: string, limit = 10): Promise<Memory[]> {
  const queryEmbedding = await this.embedder.embed(query);
  // PG: ORDER BY embedding <=> $queryEmbedding LIMIT $limit
  // Merge mit keyword results
}
```

**Backfill:** Migration generiert Embeddings für alle existierenden Memories (batch, ~500 Memories = ~2 API-Calls bei Mistral).

### Config
```yaml
memory:
  embeddingProvider: mistral    # mistral | openai | none
  embeddingModel: mistral-embed
  hybridSearchWeight: 0.6      # 0 = nur keyword, 1 = nur vector
```

---

## 2. Active Memory per Nachricht

### Problem
Alfred lädt Memories nur im Reasoning-Kontext (alle 30 Min) und im System-Prompt (Top-N nach Confidence). Wenn der User etwas fragt das mit einer Memory zusammenhängt die nicht im Top-N ist, fehlt der Kontext.

### Lösung
Vor jedem LLM-Call: schnelle Semantic-Search auf die User-Nachricht → relevante Memories als versteckten System-Kontext injizieren.

### Architektur

```
User-Nachricht
       ↓
[Semantic Search] → Top-5 relevante Memories (≥0.7 Similarity)
       ↓
[Inject als System-Context] → "Relevanter Kontext aus dem Gedächtnis: ..."
       ↓
[LLM Call mit angereichtem Kontext]
```

### Implementierung

**message-pipeline.ts** — vor dem LLM-Call (nach System-Prompt, vor Tool-Auswahl):

```typescript
// Active Memory: inject relevant memories per message
if (this.memoryRepo && message.text && message.text.length > 10) {
  const relevantMemories = await this.memoryRepo.semanticSearch(
    userId, message.text, 5  // top 5
  );
  if (relevantMemories.length > 0) {
    const memoryContext = relevantMemories
      .map(m => `[${m.key}]: ${m.value.slice(0, 150)}`)
      .join('\n');
    systemPrompt += `\n\nRelevanter Kontext aus dem Gedächtnis:\n${memoryContext}`;
  }
}
```

**Performance-Budget:**
- Embedding-Call: ~50ms (Mistral API) oder ~10ms (lokal)
- DB-Vektor-Suche: ~5ms (pgvector)
- Gesamt: <100ms zusätzliche Latenz pro Nachricht
- Nur wenn Nachricht >10 Zeichen und Memory-System aktiv

**Konfigurierbar:**
```yaml
memory:
  activeMemory: true           # per-message memory injection
  activeMemoryTopK: 5          # max memories to inject
  activeMemoryThreshold: 0.7   # minimum similarity score
```

### Abgrenzung zum Reasoning-Kontext
- **Active Memory:** Pro Nachricht, schnell, semantisch, nur Memories
- **Reasoning-Kontext:** Alle 30 Min, umfassend, 15+ Quellen (BMW, Email, KG, etc.)
- Beide ergänzen sich — Active Memory für Chat-Relevanz, Reasoning für proaktives Denken

---

## 3. Dreaming / Memory-Konsolidierung

### Problem
Alfreds Memories werden nie konsolidiert. Alte, redundante, widersprüchliche Memories bleiben ewig. Das führt zu Rauschen im Kontext und falschen Informationen.

### Lösung
Wöchentlicher Konsolidierungsprozess (wie OpenClaws Dreaming) der:
1. Redundante Memories merged
2. Widersprüchliche Memories auflöst
3. Starke Signale promoted (Confidence erhöhen)
4. Schwache Signale vergisst (Confidence senken)
5. Zusammenfassungen erstellt

### 3-Phasen-Architektur

**Phase 1: Light (Statistik-basiert, kein LLM)**
- Scan alle Memories der letzten 7 Tage
- Identifiziere Duplikate (Jaccard-Similarity >0.8 auf Key+Value)
- Identifiziere veraltete Memories (letzte Referenz >30 Tage, Confidence <0.5)
- Markiere Kandidaten für Deep-Phase

**Phase 2: Deep (LLM-basiert)**
- LLM analysiert Kandidaten-Batch:
  - "Welche Memories sind redundant? Welche widersprechen sich? Was kann zusammengefasst werden?"
- Output: Merge-Vorschläge, Lösch-Vorschläge, Zusammenfassungen
- Gewichtetes Scoring pro Memory:
  - Frequency (0.25): Wie oft referenziert
  - Relevance (0.30): Durchschnittliche Retrieval-Qualität
  - Recency (0.20): Letzte Referenz
  - Diversity (0.15): In wie vielen verschiedenen Kontexten verwendet
  - Confidence (0.10): Bestehender Confidence-Wert

**Phase 3: Apply**
- Memories mit Score >0.7: Confidence auf 1.0 setzen (promoted)
- Memories mit Score <0.3: Confidence auf 0.1 setzen (wird beim nächsten Decay gelöscht)
- Redundante Memories: Werte mergen, schwächere löschen
- Zusammenfassungen als neue Memories mit Typ `consolidated` speichern

### Trigger
- Wöchentlich (Sonntag 04:00, zusammen mit Temporal Analyzer)
- Cluster-aware: AdapterClaimManager
- Optional: manuell per Chat "konsolidiere mein Gedächtnis"

### Config
```yaml
memory:
  dreaming:
    enabled: true
    schedule: "0 4 * * 0"         # Sonntag 04:00
    promotionThreshold: 0.7
    forgetThreshold: 0.3
    maxCandidatesPerRun: 100
    llmTier: default              # welcher LLM-Tier für Deep-Phase
```

---

## 4. Pre-Compaction Memory Flush

### Problem
Wenn Alfreds Kontext komprimiert wird (bei langen Sessions), gehen möglicherweise Informationen verloren die noch nicht als Memory gespeichert sind — z.B. Fakten die der User im Chat erwähnt hat.

### Lösung
Vor jeder Kontext-Komprimierung: einen unsichtbaren System-Turn einfügen der das LLM auffordert, wichtige ungespeicherte Informationen als Memories zu sichern.

### Implementierung

**message-pipeline.ts** oder **llm-provider** — beim Compaction-Trigger:

```typescript
// Before compaction: flush important context to memory
if (this.memorySkill && conversationHistory.length > compactionThreshold) {
  const flushPrompt = `SYSTEM: Die Konversation wird gleich komprimiert.
Prüfe ob es wichtige Informationen gibt die noch nicht als Memory gespeichert sind.
Falls ja, speichere sie jetzt mit dem memory-Skill (save action).
Wichtig: Nur NEUE Fakten speichern, nichts was bereits bekannt ist.
Antworte mit "FLUSH_COMPLETE" wenn fertig.`;

  await this.llmCall({
    messages: [...recentHistory, { role: 'system', content: flushPrompt }],
    tools: [memoryTool],
    maxTokens: 500,
  });
}
```

**Safeguards:**
- Maximal 5 Memory-Saves pro Flush (verhindert Spam)
- Flush nur wenn Session >20 Nachrichten (kurze Sessions haben wenig zu verlieren)
- Timeout: 15s (Flush darf die Compaction nicht blockieren)
- Kein User-sichtbarer Output

### Config
```yaml
memory:
  preCompactionFlush: true
  flushMaxSaves: 5
  flushMinMessages: 20
```

---

## 5. Temporal Decay bei Memory-Retrieval

### Problem
Alfreds `getRecentForPrompt` sortiert nach Confidence und Type, aber nicht nach Alter. Eine 3 Monate alte Memory mit Confidence 0.8 rankt höher als eine gestrige mit 0.7 — obwohl die gestrige wahrscheinlich relevanter ist.

### Lösung
Graduelles Temporal Decay beim Retrieval — ältere Memories bekommen einen Recency-Bonus-Abzug im Ranking.

### Scoring-Formel
```
effectiveScore = confidence × recencyMultiplier

recencyMultiplier = max(0.3, 1.0 - (daysSinceLastSeen / halfLifeDays) × 0.5)
```

Mit `halfLifeDays = 30`:
- Heute gesehen: multiplier = 1.0
- Vor 7 Tagen: multiplier = 0.88
- Vor 30 Tagen: multiplier = 0.5
- Vor 60 Tagen: multiplier = 0.3 (Minimum — alte Memories verschwinden nie komplett)

### Implementierung

**memory-repository.ts** — `getRecentForPrompt`:

```typescript
async getRecentForPrompt(userId: string, limit = 20): Promise<Memory[]> {
  const all = await this.query(
    `SELECT * FROM memories WHERE user_id = ? AND (expires_at IS NULL OR expires_at > ?) ORDER BY confidence DESC LIMIT ?`,
    [userId, new Date().toISOString(), limit * 3], // fetch 3x, then re-rank
  );

  const now = Date.now();
  const halfLife = (this.config?.temporalDecayDays ?? 30) * 24 * 60 * 60_000;

  return all
    .map(m => {
      const age = now - new Date(m.lastSeenAt ?? m.createdAt).getTime();
      const recency = Math.max(0.3, 1.0 - (age / halfLife) * 0.5);
      return { ...m, effectiveScore: m.confidence * recency };
    })
    .sort((a, b) => b.effectiveScore - a.effectiveScore)
    .slice(0, limit);
}
```

**Auch für `search`:**
Gleiche Logik — Suchergebnisse nach `effectiveScore` re-ranken.

### Config
```yaml
memory:
  temporalDecayDays: 30         # Half-life in Tagen
  temporalDecayMinimum: 0.3     # Minimum Multiplier (nie unter 30%)
```

---

## Priorität + Abhängigkeiten

| # | Feature | Aufwand | Impact | Abhängigkeit |
|---|---------|---------|--------|-------------|
| 1 | Semantic Search | Mittel | Hoch | pgvector Extension, Embedding-Provider |
| 2 | Active Memory | Niedrig | Hoch | Abhängig von #1 (Semantic Search) |
| 5 | Temporal Decay | Niedrig | Mittel | Keine |
| 4 | Pre-Compaction Flush | Niedrig | Mittel | Keine |
| 3 | Dreaming | Hoch | Mittel | Abhängig von #1 (für Relevance-Scoring) |

**Empfohlene Reihenfolge:** 5 → 4 → 1 → 2 → 3

5 und 4 sind unabhängig und schnell. 1 (Semantic Search) ist Grundlage für 2 und 3. 3 (Dreaming) ist das komplexeste Feature.

## Dateien

| Feature | Dateien |
|---------|---------|
| #1 Semantic Search | `packages/storage/src/repositories/memory-repository.ts`, `packages/storage/src/migrations/`, `packages/types/src/config.ts`, `packages/config/src/schema.ts` |
| #2 Active Memory | `packages/core/src/message-pipeline.ts` |
| #3 Dreaming | `packages/core/src/memory-consolidator.ts` (neu), `packages/core/src/alfred.ts` |
| #4 Pre-Compaction Flush | `packages/core/src/message-pipeline.ts` oder `packages/llm/src/providers/*.ts` |
| #5 Temporal Decay | `packages/storage/src/repositories/memory-repository.ts` |
