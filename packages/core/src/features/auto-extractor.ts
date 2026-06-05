/**
 * v851 — Feature-Auto-Extractor
 *
 * Nach jedem erfolgreichen Project-Agent-Run analysiert ein LLM-Call
 * welche Features implementiert wurden — und schreibt sie als
 * `pending` Einträge in die `project_features` Tabelle. User bestätigt
 * sie über die UI (Pending-Features-Tab).
 *
 * Trigger-Bedingungen (UND-verknüpft):
 *   - goalKind ∈ {feature, refactor} (aus v846 Plan-Klassifikation)
 *   - modifiedFiles.length >= 5
 *   - last_build_passed = true
 *
 * Sonst: kein Extraktor-Call → spart Token + reduziert False-Positives.
 *
 * Auto-Insert nur wenn confidence >= 0.7. 0.4-0.7 landet als 'pending'.
 * < 0.4 verworfen.
 *
 * Privacy: alle auto-extracted features bekommen visibility='private'.
 * User aktiviert role-shared manuell pro Feature.
 */

import type { Logger } from 'pino';
import type { LLMProvider } from '@alfred/llm';
import type { ProjectFeaturesRepository } from '@alfred/storage';

const EXTRACTOR_PROMPT = `Du bist ein Senior-Engineer der nach Code-Änderungen
analysiert: welches FACHLICHE Feature wurde implementiert?

Du bekommst:
- GOAL: das ursprüngliche Ziel der Session
- DIFF-SUMMARY: kurze Beschreibungen der commits + geänderte File-Pfade
- TECH-STACK: erkannte Frameworks/Libraries

WICHTIG:
- "Feature" = ein FACHLICHES Konzept, KEINE technische Änderung
  GUT:    "Crowd Funding", "OAuth Login", "Email Queue Worker", "Stripe Payments"
  SCHLECHT: "Add jwt dep", "Fix linter warnings", "Update README"
- Nur SUBSTANZIELLE Features extrahieren (nicht jede kleine Anpassung)
- Confidence-Score 0-1: 1.0 = absolut sicher dass es ein neues Feature ist,
  0.0 = wahrscheinlich nur Bugfix/Refactor ohne neues Feature

Antworte NUR mit validem JSON-Array (max 3 Features):
[
  {
    "name": "Crowd Funding",
    "description": "Stripe-basierte Spendenkampagnen mit Anteils-Aufteilung",
    "techStack": ["Stripe Connect", "Next.js API Routes", "PostgreSQL"],
    "sourceFiles": ["src/lib/funding/**", "src/api/funding/**"],
    "confidence": 0.85
  }
]

Wenn KEIN substanzielles Feature: leeres Array [].`;

export interface FeatureExtractorInput {
  /** Project-Agent Session-Daten. */
  goal: string;
  goalKind?: string;
  modifiedFiles: string[];
  commitMessages: string[];
  techStackHints?: string[];
  buildPassed: boolean;
  /** Repository für persist. */
  repo: ProjectFeaturesRepository;
  /** LLM für die Extraktion. */
  llm: LLMProvider;
  logger: Logger;
  /** Project-Id + User-Id für insert. */
  projectId: string;
  userId: string;
  /** Optional: git-sha des merge-commits. */
  gitSha?: string;
}

export interface FeatureExtractorResult {
  /** True wenn Extractor-Call lief (Trigger-Bedingungen erfüllt). */
  ran: boolean;
  /** Anzahl auto-inserted features (confidence >= 0.7). */
  autoInserted: number;
  /** Anzahl als 'pending' markierte features (confidence 0.4-0.7). */
  pending: number;
  /** Anzahl discarded (confidence < 0.4). */
  discarded: number;
  /** Optional: Grund warum nicht gelaufen. */
  skipReason?: string;
}

const MIN_FILES_FOR_FEATURE = 5;
const CONFIDENCE_AUTO_THRESHOLD = 0.7;
const CONFIDENCE_PENDING_THRESHOLD = 0.4;

/**
 * Hauptfunktion: prüft Trigger, ruft LLM, persistiert features.
 */
export async function extractFeaturesFromSession(input: FeatureExtractorInput): Promise<FeatureExtractorResult> {
  // Trigger-Bedingung 1: Build muss grün sein
  if (!input.buildPassed) {
    return { ran: false, autoInserted: 0, pending: 0, discarded: 0, skipReason: 'build not passed' };
  }
  // Trigger-Bedingung 2: goalKind muss feature oder refactor sein
  if (input.goalKind !== 'feature' && input.goalKind !== 'refactor') {
    return { ran: false, autoInserted: 0, pending: 0, discarded: 0, skipReason: `goalKind=${input.goalKind} not in {feature, refactor}` };
  }
  // Trigger-Bedingung 3: mindestens MIN_FILES_FOR_FEATURE files geändert
  if (input.modifiedFiles.length < MIN_FILES_FOR_FEATURE) {
    return { ran: false, autoInserted: 0, pending: 0, discarded: 0, skipReason: `only ${input.modifiedFiles.length} files changed (< ${MIN_FILES_FOR_FEATURE})` };
  }

  // LLM-Call: was wurde implementiert?
  const userBlock = [
    `GOAL: ${input.goal.slice(0, 1500)}`,
    '',
    `DIFF-SUMMARY (commits + files):`,
    ...input.commitMessages.slice(0, 20).map(m => `  - ${m.slice(0, 200)}`),
    '',
    `MODIFIED FILES (first 30 of ${input.modifiedFiles.length}):`,
    ...input.modifiedFiles.slice(0, 30).map(f => `  - ${f}`),
    '',
    input.techStackHints && input.techStackHints.length > 0
      ? `TECH-STACK HINTS: ${input.techStackHints.join(', ')}`
      : '',
  ].filter(Boolean).join('\n');

  let raw: string;
  try {
    const response = await input.llm.complete({
      system: EXTRACTOR_PROMPT,
      messages: [{ role: 'user', content: userBlock }],
      tier: 'fast', // schneller LLM reicht für simple Extraction
      maxTokens: 1024,
      temperature: 0.2,
    });
    raw = response.content;
  } catch (err) {
    input.logger.warn({ err: (err as Error).message, projectId: input.projectId }, 'v851 feature-extractor LLM call failed');
    return { ran: true, autoInserted: 0, pending: 0, discarded: 0, skipReason: 'LLM call failed' };
  }

  // Parse: JSON-array extrahieren
  let parsed: Array<{
    name: string;
    description?: string;
    techStack?: string[];
    sourceFiles?: string[];
    confidence?: number;
  }> = [];
  const jsonMatch = raw.match(/\[\s*[\s\S]*\]/);
  if (jsonMatch) {
    try { parsed = JSON.parse(jsonMatch[0]); } catch { /* */ }
  }
  if (!Array.isArray(parsed) || parsed.length === 0) {
    return { ran: true, autoInserted: 0, pending: 0, discarded: 0, skipReason: 'LLM returned no features' };
  }

  let autoInserted = 0;
  let pending = 0;
  let discarded = 0;

  for (const f of parsed.slice(0, 3)) {
    const name = String(f.name ?? '').trim();
    if (!name || name.length < 3) { discarded++; continue; }
    const confidence = typeof f.confidence === 'number' ? Math.max(0, Math.min(1, f.confidence)) : 0.5;
    if (confidence < CONFIDENCE_PENDING_THRESHOLD) {
      discarded++;
      continue;
    }
    const status = confidence >= CONFIDENCE_AUTO_THRESHOLD ? 'confirmed' : 'pending';

    try {
      const result = await input.repo.upsertOrBumpVersion({
        projectId: input.projectId,
        userId: input.userId,
        name: name.slice(0, 200),
        description: String(f.description ?? '').slice(0, 2000),
        techStack: Array.isArray(f.techStack) ? f.techStack.map(String).slice(0, 20) : [],
        sourceFiles: Array.isArray(f.sourceFiles) ? f.sourceFiles.map(String).slice(0, 20) : [],
        gitShaIntroduced: input.gitSha,
        visibility: 'private', // Auto-Extracted = immer private (User aktiviert role-shared manuell)
        confidence,
        source: 'auto',
        status: status as 'pending' | 'confirmed',
      });
      if (status === 'confirmed') autoInserted++;
      else pending++;
      input.logger.info({
        projectId: input.projectId, featureId: result.id, name, confidence, status,
        bumped: !result.isNew,
      }, 'v851 feature extracted');
    } catch (err) {
      input.logger.warn({ err: (err as Error).message, name }, 'v851 feature upsert failed');
      discarded++;
    }
  }

  return { ran: true, autoInserted, pending, discarded };
}
