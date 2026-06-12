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
  collectors?: Array<
    | 'git_log_recent' | 'git_diff_summary' | 'npm_outdated' | 'pip_outdated' | 'npm_audit'
    | 'test_coverage' | 'tree_overview' | 'pr_open'
    // v881 — neue Collectors: echte Daten statt Versprechen ohne Grundlage
    | 'changelog_head' | 'readme_content' | 'git_log_files' | 'git_diff_patch'
    | 'git_shortlog' | 'branch_status' | 'license_summary' | 'bench_run'
    | 'cost_stats' | 'forge_prs'
  >;
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
    // v881 — CHANGELOG-Inhalt + Tag-Liste liegen jetzt wirklich im Kontext
    defaultPrompt: 'Bereite ein Release vor (CHANGELOG-Inhalt + letzte Tags liegen im Collector-Output): (1) Analysiere die [Unreleased]-Sektion. (2) Generiere passende Versionsnummer (semver, anschließend an die Tag-Liste). (3) Erstelle finale Release Notes als Markdown — gruppiert nach Added/Changed/Fixed/Removed. (4) Schlage Tag-Befehl vor. Setze die Änderungen NICHT um — gib nur den Vorschlag zur Bestätigung.',
    collectors: ['changelog_head', 'git_log_recent'],
  },
  code_review: {
    kind: 'code_review',
    label: 'Code-Review',
    icon: '🔍',
    defaultSchedule: 'manual',
    description: 'Review der letzten N Commits: Bugs, Best-Practices, Tests',
    // v881 — vorher nur git_diff_summary (--stat = Dateinamen ohne Inhalt):
    // "Bugs mit Datei:Zeile" war ohne Diff-Inhalt eine Halluzinations-Aufforderung.
    defaultPrompt: 'Code-Review des gelieferten Diffs der letzten 5 Commits (Collector git_diff_patch): (1) Mögliche Bugs / Race Conditions. (2) Style/Best-Practice-Verstöße. (3) Fehlende Tests für neue Features. (4) Sicherheits-Bedenken. Strukturiert nach Severity (critical/high/low), mit Datei-Pfaden aus dem Diff. Bewerte NUR was im Diff sichtbar ist — für ein Komplett-Review der Codebase auf 🔍 Codebase-Review im Projekt-Detail verweisen.',
    collectors: ['git_diff_patch', 'git_log_recent'],
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
    // v881 — README-Inhalt war vorher NIE im Kontext (nur Dateibaum)
    defaultPrompt: 'Documentation-Drift-Check (README-Inhalt, Dateibaum und letzte Commits liegen im Collector-Output): (1) Themen aus letzten Commits/Dateibaum, die im README fehlen. (2) README-Sektionen die laut Dateibaum/Commits veraltet wirken. (3) Konkrete Verbesserungsvorschläge mit Datei-Pfaden. Bewerte NUR anhand der gelieferten Daten — tiefer Code-vs-Doku-Abgleich braucht den 🔍 Codebase-Review.',
    collectors: ['tree_overview', 'readme_content', 'git_log_recent'],
  },

  // ── Erweiterungen (Prompt-basiert mit Projekt-Kontext) ──
  test_coverage_drift: {
    kind: 'test_coverage_drift',
    label: 'Test-Coverage-Drift',
    icon: '🧪',
    defaultSchedule: '0 11 * * 1',
    description: 'Coverage-Diff zu letzter Woche, neue uncovered lines',
    // v881 — Drift-Aussagen jetzt über den Vorheriger-Lauf-Block (echte Vergleichsbasis)
    defaultPrompt: 'Test-Coverage-Analyse (coverage-summary.json im Collector-Output; Vergleichsbasis = Vorheriger-Lauf-Block): (1) Aktuelle Gesamt-Coverage + schwächste Bereiche. (2) Diff zur Vergleichsbasis — NUR wenn ein Vorheriger-Lauf-Block existiert, sonst explizit "Erstlauf, keine Vergleichsbasis". (3) Top 3 Test-Lücken mit konkreten Test-Case-Empfehlungen. Fehlt coverage-summary.json: sage das klar und empfehle Coverage-Aktivierung im Test-Script.',
    collectors: ['test_coverage'],
  },
  activity_digest: {
    kind: 'activity_digest',
    label: 'Activity-Digest',
    icon: '📊',
    defaultSchedule: '0 18 * * 0',
    description: 'Wer hat was wann gemacht — sinnvoll für Multi-User-Teams',
    // v881 — Commits pro Autor jetzt echt via git shortlog
    defaultPrompt: 'Activity-Digest der letzten Woche (Commits pro Autor = git_shortlog im Collector-Output): (1) Commits pro Autor mit Themen aus den Messages. (2) Erledigte vs. neue Open-Items (aus dem Projekt-Kontext). (3) Sessions der Woche. Tabellarisch + Highlights.',
    collectors: ['git_shortlog', 'git_log_recent'],
  },
  auto_rebase: {
    kind: 'auto_rebase',
    label: 'Auto-Rebase',
    icon: '🔄',
    defaultSchedule: '0 6 * * *',
    description: 'Feature-Branches gegen main rebasen',
    // v881 — vorher KEIN Branch-Collector: das Template sah keine einzige
    // Branch. Jetzt: echte ahead/behind-Lage + merge-tree-Konflikt-Dry-Run.
    defaultPrompt: 'Branch-Rebase-Status (echte Branch-Lage inkl. ahead/behind + Konflikt-Dry-Run im Collector-Output): (1) Branches hinter dem Default-Branch. (2) Welche laut Dry-Run konfliktfrei rebased werden können. (3) Welche manuelles Eingreifen brauchen. NUR Vorschlag — Rebase nicht selbst durchführen.',
    collectors: ['branch_status'],
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
    // v881 — forge_prs: funktioniert auch auf GitLab (pr_open nutzt gh = nur GitHub)
    collectors: ['forge_prs', 'pr_open'],
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
    // v881 — Bench wird wirklich ausgeführt; Vergleich über Vorheriger-Lauf-Block
    defaultPrompt: 'Performance-Baseline-Check (Bench-Output im Collector, Vergleichsbasis = Vorheriger-Lauf-Block): (1) Aktuelle Bench-Werte zusammenfassen. (2) Regressionen >10% gegenüber der Vergleichsbasis — NUR wenn ein Vorheriger-Lauf-Block existiert, sonst explizit "Erstlauf = neue Baseline". (3) Wahrscheinliche Verursacher-Commits aus dem git-Kontext. (4) Profiling-Schritte. Ohne bench-Script: sage das klar.',
    collectors: ['bench_run', 'git_log_recent'],
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
    // v881 — vorher OHNE jede Datenquelle: das Template ERFAND Token-Zahlen.
    // Jetzt: echte Zahlen aus cli_agent_runs (pro Projekt) + llm_usage (global).
    defaultPrompt: 'Cost-Tracking-Report (ECHTE Zahlen im Collector cost_stats — verwende ausschließlich diese, erfinde KEINE): (1) CLI-Agent-Kosten dieses Projekts: letzte 30 Tage vs. 30 Tage davor. (2) Verteilung nach Agent/Session-Typ. (3) Globaler LLM-Verbrauch als Einordnung. (4) Konkrete Spar-Empfehlungen aus den Zahlen.',
    collectors: ['cost_stats'],
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
    // v881 — echte Lizenzliste via license-checker statt Vermutung
    defaultPrompt: 'License-Audit (echte Lizenz-Summary im Collector-Output): (1) Lizenz-Verteilung zusammenfassen. (2) GPL/AGPL/Copyleft-Risiken gegen das Projekt-Lizenzmodell flaggen. (3) Alternativen für problematische Deps. (4) Ist ein license-Feld/LICENSE-Update nötig? Ohne Lizenzdaten: sage das klar.',
    collectors: ['license_summary'],
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
    // v881 — git log mit --name-only: Datei-Gruppierung war vorher unmöglich
    defaultPrompt: 'Recurring-Bug-Analyse (Commits inkl. betroffener Dateien im Collector git_log_files): (1) Bug-fix-Commits der letzten 30 Tage. (2) Gruppiere nach betroffenen Files/Modulen. (3) Pattern: >2 Bugs in derselben Datei. (4) Strukturelle Lösung vorschlagen (Refactoring, Test-Lücke, Architektur-Issue).',
    collectors: ['git_log_files'],
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
