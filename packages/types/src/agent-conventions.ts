/**
 * v823 — Project-Conventions Types.
 *
 * Repräsentiert die kuratierten CLAUDE.md/AGENTS.md-Conventions pro Projekt
 * (und optional pro Package in Monorepos, Phase 3.1). Mehr Details im
 * Design-Dokument; hier nur die Typen.
 */

export type ConventionsSection =
  | 'stack'
  | 'commands'
  | 'testSetup'
  | 'architecture'
  | 'style'
  | 'gotchas'
  | 'doNotTouch';

export type ConventionsLanguage = 'de' | 'en';

export type ConventionsGeneratedBy = 'auto' | 'manual' | 'imported' | 'lesson-derived';

export type ConventionsTrustSource =
  | 'merge-gate-failure'
  | 'plan-fix-loop-resolved'
  | 'plan-awaiting-user'
  | 'user-chat-explicit'
  | 'drift-refresh-detected'
  | 'cross-project-pattern'
  | 'scan-update';

export type ConventionsAutoApplyMode = 'off' | 'minor' | 'confident' | 'aggressive' | 'auto-pr';

export type ConventionsGenerateMode = 'single' | 'quorum-2' | 'quorum-3' | 'quorum-first-time';

export type ConventionsOutputFormat = 'claude.md' | 'agents.md' | 'cursor.rules' | 'copilot.md' | 'codex.md';

/** Neutral-Format: source-of-truth in DB, alle File-Outputs werden daraus abgeleitet. */
export interface NeutralConventions {
  meta: {
    version: '1';
    generatedAt?: string;
    scanHash?: string;
    contentHash?: string;
    lessonsCount: number;
    language: ConventionsLanguage;
  };
  sections: Partial<Record<ConventionsSection, string>> & { custom?: Record<string, string> };
  lessons: ConventionsLesson[];
}

export interface ConventionsLesson {
  id: string;
  learnedAt: string;
  source: ConventionsTrustSource;
  text: string;
  sessionId?: string;
  confidence: number;
  appliedToMain: boolean;
  userApproved: boolean | null;
  /** Inverse-Learning: wie oft hat ein Agent gegen diese Lesson verstoßen aber trotzdem erfolgreich abgeschlossen? */
  violationsResolvedAnyway?: number;
  /** Inverse-Learning: wie oft hat User die Lesson manuell außer Kraft gesetzt? */
  manualOverrides?: number;
  /** 0-1, low = möglicherweise problematisch (4.2). */
  healthScore?: number;
}

/** Primary Row in `project_conventions` DB-Tabelle. */
export interface AgentConventions {
  projectId: string;
  packagePath: string;                // '' = root, sonst e.g. 'packages/web'
  content: string;                    // aktuell aktive Markdown (für Display)
  draftContent: string | null;        // pending Draft vor Apply
  neutralFormat: NeutralConventions;  // source-of-truth (deserialisiert)
  scanHash: string;
  contentHash: string;
  generatedBy: ConventionsGeneratedBy;
  generatedAt: string | null;
  lastAppliedAt: string | null;
  lastDriftCheckAt: string | null;
  driftScore: number;
  sourceScan: ConventionsScanSnapshot | null;
  filesWritten: ConventionsOutputFormat[];
  skillContributions: Record<string, { version: number; includedAt: string }>;
  language: ConventionsLanguage;
  inheritsFrom: string | null;
  createdAt: string;
  updatedAt: string;
}

/** Repo-Scan-Snapshot der beim Generate verwendet wurde. */
export interface ConventionsScanSnapshot {
  capturedAt: string;
  cwd: string;
  packageManager?: string;
  framework?: string;
  hasTypescript?: boolean;
  hasTests?: boolean;
  testRunner?: string;
  topLevelDirs: string[];
  packageJsonScripts?: Record<string, string>;
  workspaces?: string[];
  envExampleKeys?: string[];
  migrationDirs?: string[];
  testSetupFiles?: string[];
  recentCommitsHash?: string;
  fileTreeHash?: string;
  totalFiles: number;
  totalCodeFiles: number;
  scanTimingMs: number;
}

/** Status-Returnshape für UI-Badge. */
export type ConventionsStatusBadge = 'present-fresh' | 'present-drift' | 'present-user-managed' | 'missing';

export interface ConventionsStatus {
  projectId: string;
  packagePath: string;
  badge: ConventionsStatusBadge;
  filePath: string | null;
  filePresent: boolean;
  alfredManaged: boolean;
  lastAppliedAt: string | null;
  driftScore: number;
  contentHashCurrent: string | null;
  contentHashOnDisk: string | null;
  /** Falls Mehrere Output-Files: deren Status. */
  multiOutputs?: Array<{ format: ConventionsOutputFormat; path: string; present: boolean }>;
}

/** Historie-Eintrag (Phase 3.2). */
export interface ConventionsHistoryEntry {
  id: string;
  projectId: string;
  packagePath: string;
  appliedAt: string;
  appliedBy: string;
  prevContentHash: string | null;
  newContentHash: string;
  prevContentSnapshot: string | null;
  diffSummary: string | null;
  triggerSource: string;
  triggerSessionId: string | null;
  rolledBackAt: string | null;
  rolledBackBy: string | null;
}

/** Cross-Project-Pattern (Phase 3.3). */
export interface ConventionPattern {
  id: string;
  masterUserId: string;
  patternText: string;
  patternSection: ConventionsSection;
  category: string;
  frameworkTags: string[];
  occurrenceCount: number;
  appliesToCount: number;
  confidence: number;
  embeddingId: string | null;
  firstObservedAt: string;
  lastObservedAt: string;
  retiredAt: string | null;
}

/** Per-Convention Violation (Phase 4.2). */
export interface ConventionViolation {
  id: string;
  projectId: string;
  packagePath: string;
  conventionSection: ConventionsSection;
  conventionExcerpt: string;
  sessionId: string | null;
  violatedAt: string;
  resolvedAnyway: boolean;
  manualOverride: boolean;
  detectionSource: string;
}

/** Test-Harness Run (Phase 4.6). */
export interface ConventionTestRun {
  id: string;
  projectId: string | null;
  conventionsVersionHash: string;
  canonicalTaskId: string;
  stack: string;
  withConventions: boolean;
  outcomePassed: boolean;
  outcomeDetails: string | null;
  fixAttempts: number;
  durationMs: number;
  costUsd: number;
  ranAt: string;
}

/** Generate-Input. */
export interface ConventionsGenerateOptions {
  projectId: string;
  packagePath?: string;
  language?: ConventionsLanguage;
  generateMode?: ConventionsGenerateMode;
  tier?: 'fast' | 'default' | 'strong';
  outputFormats?: ConventionsOutputFormat[];
}

/** Generate-Result. */
export interface ConventionsGenerateResult {
  ok: boolean;
  draft?: string;
  neutralFormat?: NeutralConventions;
  scanHash?: string;
  scanSnapshot?: ConventionsScanSnapshot;
  warnings?: string[];
  costUsd?: number;
  reason?: string;
}

/** Apply-Input. */
export interface ConventionsApplyOptions {
  projectId: string;
  packagePath?: string;
  content?: string;            // wenn unset: nimm draftContent
  commitToGit?: boolean;
  triggerSource?: string;
  triggerSessionId?: string;
}

/** Apply-Result. */
export interface ConventionsApplyResult {
  ok: boolean;
  filesWritten?: string[];
  commitSha?: string;
  historyId?: string;
  reason?: string;
}

/** Drift-Check-Result. */
export interface ConventionsDriftResult {
  projectId: string;
  packagePath: string;
  driftScore: number;
  reasons: string[];
  checkedAt: string;
}

/** Per-Project-Config-Sub-Object (in `AlfredConfig.projectConventions`). */
export interface AgentConventionsConfig {
  enabled: boolean;
  generateMode: ConventionsGenerateMode;
  generateTier: 'fast' | 'default' | 'strong';
  language: ConventionsLanguage;
  outputs: ConventionsOutputFormat[];
  primaryOutput: ConventionsOutputFormat;
  autoApplyMode: ConventionsAutoApplyMode;
  driftCheckIntervalHours: number;
  driftRefreshAuto: boolean;
  lessonsAggressiveLearning: boolean;
  crossProjectPool: 'on' | 'off' | 'per-project-optin';
  selfModifyAgent: {
    enabled: boolean;
    intervalDays: number;
    sessionThreshold: number;
  };
  embeddingInjection: boolean;
  inverseLearning: boolean;
  testHarness: {
    enabled: boolean;
    runsPerVersion: number;
  };
  budget: {
    monthlyUsdCap: number;
    alertAt: number;
  };
  /** Welche Sections für Auto-Apply zugelassen sind (Phase 3.2). */
  autoApplyAllowedSections: ConventionsSection[];
  /** Welche Skills zur Conventions-Contribution erlaubt sind (Phase 3.6). */
  allowedSkillContributions: string[] | '*';
}
