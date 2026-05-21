import type { AutomationTemplateKind } from '@alfred/storage';

/**
 * v663b — Automation-Templates pro Projekt.
 * Jedes Template definiert: Default-Schedule, Default-Prompt, optionale
 * Data-Collectors. Der LLM bekommt zusätzlich automatisch Projekt-Kontext
 * (cwd, repo, sessions, openItems, conventions, lastCommits).
 *
 * Schedule-Format: Cron (Min Hour DOM Mon DOW) oder 'manual' (= nur on-demand)
 */
export interface AutomationTemplate {
  kind: AutomationTemplateKind;
  label: string;
  icon: string;
  defaultSchedule: string;
  description: string;
  /** Default-Prompt — kann pro Automation überschrieben werden. */
  defaultPrompt: string;
  /** Optionale Daten-Collectors die VOR dem LLM-Call laufen (Output wird in Prompt eingespeist). */
  collectors?: Array<'git_log_recent' | 'git_diff_summary' | 'npm_outdated' | 'pip_outdated' | 'npm_audit' | 'test_coverage' | 'tree_overview' | 'pr_open'>;
}

export const AUTOMATION_TEMPLATES: Record<AutomationTemplateKind, AutomationTemplate> = {
  // ── Core ──
  daily_standup: {
    kind: 'daily_standup',
    label: 'Daily Standup',
    icon: '📅',
    defaultSchedule: '0 8 * * *',
    description: 'Tägliche Standup-Zusammenfassung: was war gestern, was heute, blocker',
    defaultPrompt: 'Erstelle ein kompaktes Daily Standup für dieses Projekt. Struktur: (1) Gestern erledigt — letzte commits + erledigte open-items. (2) Heute geplant — in-progress + due-today open-items. (3) Blocker — stale open-items (>3d offen) + failed sessions. Max 10 Zeilen, sehr knapp.',
    collectors: ['git_log_recent'],
  },
  weekly_progress: {
    kind: 'weekly_progress',
    label: 'Wöchentlicher Fortschritt',
    icon: '📈',
    defaultSchedule: '0 9 * * 1',
    description: 'Wöchentliche Übersicht: Commits, geschlossene Items, Burndown',
    defaultPrompt: 'Wöchentlicher Fortschrittsbericht: (1) Commits diese Woche (count + Highlights aus messages). (2) Geschlossene Open-Items (was wurde erledigt). (3) Offene High-Prio. (4) Burndown — Trend gegenüber Vorwoche. Max 15 Zeilen.',
    collectors: ['git_log_recent'],
  },
  release_prep: {
    kind: 'release_prep',
    label: 'Release-Pflege',
    icon: '🚀',
    defaultSchedule: 'manual',
    description: 'Bereitet ein Release vor: CHANGELOG [Unreleased] → [X.Y.Z], Tag, Notes',
    defaultPrompt: 'Bereite ein Release vor: (1) Lies CHANGELOG.md und Sektion [Unreleased]. (2) Generiere passende Versionsnummer (semver). (3) Erstelle finale Release Notes als Markdown — gruppiert nach Added/Changed/Fixed/Removed. (4) Schlage Tag-Befehl vor. Setze die Änderungen NICHT um — gib nur den Vorschlag zur Bestätigung.',
    collectors: ['git_log_recent'],
  },
  code_review: {
    kind: 'code_review',
    label: 'Code-Review',
    icon: '🔍',
    defaultSchedule: 'manual',
    description: 'Review der letzten N Commits: Bugs, Best-Practices, Tests',
    defaultPrompt: 'Code-Review der letzten 5 Commits: (1) Mögliche Bugs / Race Conditions. (2) Style/Best-Practice-Verstöße. (3) Fehlende Tests für neue Features. (4) Sicherheits-Bedenken. Strukturiert nach Severity (critical/high/low). Konkret mit Datei-Pfaden und Zeilen wenn möglich.',
    collectors: ['git_diff_summary', 'git_log_recent'],
  },
  dependency_check: {
    kind: 'dependency_check',
    label: 'Dependency-Check',
    icon: '📦',
    defaultSchedule: '0 9 1 * *',
    description: 'Outdated Dependencies + Security-Audit (npm/pip)',
    defaultPrompt: 'Analyse der Dependencies: (1) Outdated-Packages (Major/Minor/Patch separat). (2) Security-Vulnerabilities. (3) Upgrade-Empfehlungen — welche zuerst, welche heikel. (4) Geschätzter Upgrade-Aufwand. Konkret und priorisiert.',
    collectors: ['npm_outdated', 'pip_outdated', 'npm_audit'],
  },
  open_items_triage: {
    kind: 'open_items_triage',
    label: 'Open-Items-Triage',
    icon: '🎯',
    defaultSchedule: '0 9 * * 1',
    description: 'Priorisiert offene Punkte, schließt stale, schlägt neue High-Prio vor',
    defaultPrompt: 'Triage der offenen Punkte: (1) Liste stale (>14d offen) Items zum Schließen-Vorschlag. (2) Re-priorisiere falsch eingestufte (z.B. blocker zu high). (3) Schlage neue High-Prio aus aktuellem Build/Code-Stand vor. (4) Doppelte/ähnliche Items zum Mergen finden. Konkrete Liste mit Item-IDs.',
  },
  documentation_drift: {
    kind: 'documentation_drift',
    label: 'Documentation-Drift',
    icon: '📝',
    defaultSchedule: '0 10 1 * *',
    description: 'README/Docs vs. tatsächlicher Code-State — Lücken identifizieren',
    defaultPrompt: 'Documentation-Drift-Check: (1) Liste Features die im Code existieren aber nicht in README. (2) README-Sektionen die veraltet sind (z.B. obsolete Setup-Schritte). (3) Fehlende API-Doku für public exports. Konkrete Verbesserungsvorschläge mit Datei-Pfaden.',
    collectors: ['tree_overview'],
  },

  // ── Erweiterungen (Prompt-basiert mit Projekt-Kontext) ──
  test_coverage_drift: {
    kind: 'test_coverage_drift',
    label: 'Test-Coverage-Drift',
    icon: '🧪',
    defaultSchedule: '0 11 * * 1',
    description: 'Coverage-Diff zu letzter Woche, neue uncovered lines',
    defaultPrompt: 'Test-Coverage-Analyse: (1) Welche neuen Files seit letzter Woche haben keine Tests. (2) Welche existierenden Files haben sinkende Coverage. (3) Top 3 Test-Lücken die am wichtigsten zu schließen sind. Empfehle konkrete Test-Cases.',
    collectors: ['test_coverage'],
  },
  activity_digest: {
    kind: 'activity_digest',
    label: 'Activity-Digest',
    icon: '📊',
    defaultSchedule: '0 18 * * 0',
    description: 'Wer hat was wann gemacht — sinnvoll für Multi-User-Teams',
    defaultPrompt: 'Activity-Digest der letzten Woche: (1) Commits pro Autor mit Themen. (2) Open-Items pro Autor (created/closed). (3) Project-Agent-Sessions pro Trigger-Quelle. Tabellarisch + Highlights.',
    collectors: ['git_log_recent'],
  },
  auto_rebase: {
    kind: 'auto_rebase',
    label: 'Auto-Rebase',
    icon: '🔄',
    defaultSchedule: '0 6 * * *',
    description: 'Feature-Branches gegen main rebasen',
    defaultPrompt: 'Branch-Rebase-Status: (1) Liste Feature-Branches die hinter main sind. (2) Welche können automatisch rebased werden (kein Konflikt erwartet). (3) Welche brauchen manuelles Eingreifen. NUR Vorschlag — Rebase nicht selbst durchführen.',
  },
  brainstorming_pulse: {
    kind: 'brainstorming_pulse',
    label: 'Brainstorming-Pulse',
    icon: '💡',
    defaultSchedule: 'manual',
    description: 'Open-Ended Brainstorming-Session — was als nächstes',
    defaultPrompt: 'Brainstorm "was wäre der nächste sinnvolle Schritt für dieses Projekt?". Berücksichtige aktuellen Stand, offene Roadmap-Items, Tech-Trends, mögliche Pain-Points. 5-7 konkrete Ideen mit Begründung und geschätztem Aufwand.',
  },
  pr_pflege: {
    kind: 'pr_pflege',
    label: 'PR-Pflege',
    icon: '🔀',
    defaultSchedule: '0 14 * * 1-5',
    description: 'Offene PRs analysieren — review-bereit, stale, conflict',
    defaultPrompt: 'PR-Pflege: (1) Stale PRs (>7d offen) zum Schließen. (2) Review-fertige PRs die warten. (3) PRs mit Merge-Conflict die rebase brauchen. (4) Generiere für PRs ohne Body einen Vorschlag aus den Commits.',
    collectors: ['pr_open'],
  },
  security_sentinel: {
    kind: 'security_sentinel',
    label: 'Security-Sentinel',
    icon: '🛡',
    defaultSchedule: '0 4 * * 1',
    description: 'Wöchentlich npm audit + CVE-Scan, kritisch → ITSM-Incident',
    defaultPrompt: 'Security-Audit: (1) npm audit / pip-audit Output analysieren. (2) Kritische CVEs separat aufführen. (3) Bei critical/high: schlage Schließen via ITSM-Incident vor (mit suggested incident-title + symptoms). (4) Patch-Pfad pro Vulnerability.',
    collectors: ['npm_audit'],
  },
  performance_baseline: {
    kind: 'performance_baseline',
    label: 'Performance-Baseline',
    icon: '⚡',
    defaultSchedule: '0 3 * * 1',
    description: 'Bench-Regression-Detection — wo wurden wir langsamer',
    defaultPrompt: 'Performance-Baseline-Check: (1) Falls bench-Script existiert: vergleiche aktuelle Werte mit Werten von vor 1 Woche. (2) Identifiziere Regressionen (>10% slowdown). (3) Verlinke wahrscheinliche Commits die das verursacht haben. (4) Empfehle profiling-Schritte.',
  },
  onboarding_doc: {
    kind: 'onboarding_doc',
    label: 'Onboarding-Doc',
    icon: '👋',
    defaultSchedule: 'manual',
    description: 'Generiere ONBOARDING.md aus Architektur-Analyse',
    defaultPrompt: 'Erstelle ein ONBOARDING.md für neue Repo-Member: (1) Quick-Setup (Clone + Install + Dev-Server). (2) Architektur-Übersicht (Module + ihre Verantwortlichkeiten). (3) Wo starten? — was sollte ein neuer Mitarbeiter zuerst lesen/verstehen. (4) Häufige Tasks + ihre Workflows. Max 200 Zeilen, sehr praktisch.',
    collectors: ['tree_overview'],
  },
  cost_tracking: {
    kind: 'cost_tracking',
    label: 'Cost-Tracking',
    icon: '💰',
    defaultSchedule: '0 9 1 * *',
    description: 'Pro Projekt: LLM-Tokens + Compute-Stunden + Trend',
    defaultPrompt: 'Cost-Tracking-Report: (1) LLM-Token-Verbrauch dieser Monat vs Vormonat (input/output/cache). (2) Project-Agent-Compute-Stunden. (3) Top 3 teuerste Sessions. (4) Empfehlung: wo kann Kosten reduziert werden (z.B. fast statt strong tier für bestimmte Phasen).',
  },
  stakeholder_briefing: {
    kind: 'stakeholder_briefing',
    label: 'Stakeholder-Briefing',
    icon: '👥',
    defaultSchedule: '0 16 * * 5',
    description: 'Wöchentliches Briefing für Stakeholder — was wurde geliefert',
    defaultPrompt: 'Stakeholder-Briefing (nicht-techn. Sprache!): (1) Welche User-sichtbaren Features wurden diese Woche geliefert. (2) Welche Bugs wurden gefixt. (3) Was ist der Plan für nächste Woche. (4) Bekannte Risiken/Blocker. Keine Dateien/Code-Snippets — nur Business-Sicht.',
    collectors: ['git_log_recent'],
  },
  license_audit: {
    kind: 'license_audit',
    label: 'License-Audit',
    icon: '⚖',
    defaultSchedule: '0 8 1 */3 *',
    description: 'Dependency-Licenses checken, GPL/AGPL-Konflikte flaggen',
    defaultPrompt: 'License-Audit: (1) Liste alle Dependencies + ihre Licenses. (2) Identifiziere GPL/AGPL/Copyleft-Konflikte mit dem Projekt-License-Modell. (3) Schlage Alternativen für problematische Deps vor. (4) Empfehle ob ein license-Header-Update für package.json/LICENSE nötig ist.',
  },
  pre_mortem: {
    kind: 'pre_mortem',
    label: 'Pre-Mortem',
    icon: '🔮',
    defaultSchedule: 'manual',
    description: 'Vor Release: was könnte schiefgehen + Mitigations',
    defaultPrompt: 'Pre-Mortem für anstehenden Release: (1) Liste die 5 wahrscheinlichsten Failure-Modi (was schiefgehen kann). (2) Pro Failure: Impact-Bewertung + Wahrscheinlichkeit. (3) Mitigations / Rollback-Plan. (4) Welche Tests/Checks vor Release zwingend laufen müssen.',
  },
  adr_decisions: {
    kind: 'adr_decisions',
    label: 'Architecture-Decision-Records',
    icon: '📜',
    defaultSchedule: 'manual',
    description: 'ADR aus letzten project_decisions generieren',
    defaultPrompt: 'Generiere ADRs (Architecture Decision Records) aus den letzten project_decisions: pro Decision eine Markdown-Datei docs/adr/NNNN-title.md mit Sections: Status, Context, Decision, Consequences, Alternatives. Saubere ADR-Format gemäß Michael Nygard.',
  },
  demo_day_prep: {
    kind: 'demo_day_prep',
    label: 'Demo-Day-Prep',
    icon: '🎬',
    defaultSchedule: 'manual',
    description: 'Vor Sprint-End: Demo-Script aus geschlossenen Items',
    defaultPrompt: 'Erstelle ein Demo-Script: (1) Welche neuen Features seit letztem Demo-Tag fertig sind. (2) Pro Feature: 3-4 Demo-Schritte (Klick-Pfad/Befehl). (3) Mögliche Demo-Risiken (z.B. Network-Dependencies). (4) Backup-Plan wenn was nicht funktioniert.',
  },
  recurring_bug_detector: {
    kind: 'recurring_bug_detector',
    label: 'Recurring-Bug-Detector',
    icon: '🐛',
    defaultSchedule: '0 10 1 * *',
    description: 'Pattern in Bug-Fixes finden — wo strukturelle Lösung nötig',
    defaultPrompt: 'Recurring-Bug-Analyse: (1) Liste alle Bug-fix-Commits der letzten 30 Tage. (2) Gruppiere nach betroffenen Files/Modulen. (3) Identifiziere Pattern (>2 Bugs in selber Datei). (4) Schlage strukturelle Lösung vor (Refactoring, Test-Lücke, Architektur-Issue).',
    collectors: ['git_log_recent'],
  },

  custom: {
    kind: 'custom',
    label: 'Custom Prompt',
    icon: '✨',
    defaultSchedule: 'manual',
    description: 'Eigener Prompt — User definiert die Logik',
    defaultPrompt: 'Eigener Prompt — bitte beim Anlegen definieren.',
  },
};

export function listAutomationTemplates(): AutomationTemplate[] {
  return Object.values(AUTOMATION_TEMPLATES);
}
