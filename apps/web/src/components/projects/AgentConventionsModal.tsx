'use client';

// v824 — AgentConventionsModal.
// Vollständiges UI für die Phase-1-Conventions-Verwaltung: Status anzeigen,
// generieren, draft reviewen + editieren, applyen (mit/ohne git-commit),
// Drift-Check, Refresh, History + Rollback.

import { useState, useEffect, useCallback } from 'react';
import type {
  AlfredClient,
  AgentConventionsStatus,
  AgentConventionsHistoryEntry,
  AgentConventionsGenerateData,
  AgentConventionsLesson,
  AgentConventionsPackage,
  AgentConventionsEffectivenessData,
  AgentConventionsPattern,
  AgentConventionsSectionHealth,
} from '../../lib/alfred-client';

interface Props {
  client: AlfredClient;
  projectId: string;
  projectName: string;
  open: boolean;
  onClose: () => void;
}

type Tab = 'view' | 'draft' | 'history' | 'lessons' | 'effectiveness' | 'patterns' | 'settings';

export function AgentConventionsModal({ client, projectId, projectName, open, onClose }: Props) {
  const [status, setStatus] = useState<AgentConventionsStatus | null>(null);
  const [draft, setDraft] = useState<string>('');
  const [draftMeta, setDraftMeta] = useState<AgentConventionsGenerateData | null>(null);
  const [history, setHistory] = useState<AgentConventionsHistoryEntry[]>([]);
  const [lessons, setLessons] = useState<AgentConventionsLesson[]>([]);
  const [pendingLessonsCount, setPendingLessonsCount] = useState(0);
  // v826 — Monorepo-Support: Package-Selector
  const [packages, setPackages] = useState<AgentConventionsPackage[]>([]);
  const [isMonorepo, setIsMonorepo] = useState(false);
  const [selectedPackagePath, setSelectedPackagePath] = useState<string>('');
  // v832 — Phase 4.1 + 3.3 UI
  const [effectiveness, setEffectiveness] = useState<AgentConventionsEffectivenessData | null>(null);
  const [patterns, setPatterns] = useState<AgentConventionsPattern[]>([]);
  const [sectionHealth, setSectionHealth] = useState<AgentConventionsSectionHealth[]>([]);
  const [suggestedRemovals, setSuggestedRemovals] = useState<AgentConventionsSectionHealth[]>([]);
  // v834 — Per-Project Settings Override
  const [configOverrides, setConfigOverrides] = useState<{ global: Record<string, unknown>; overrides: Record<string, unknown>; effective: Record<string, unknown> } | null>(null);
  const [overridesText, setOverridesText] = useState<string>('{}');
  const [tab, setTab] = useState<Tab>('view');
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [language, setLanguage] = useState<'de' | 'en'>('de');
  const [commitToGit, setCommitToGit] = useState(true);

  const loadStatus = useCallback(async () => {
    const r = await client.conventionsStatus(projectId, selectedPackagePath);
    if (r.ok && r.data) setStatus(r.data);
    else setError(r.reason ?? null);
  }, [client, projectId, selectedPackagePath]);

  const loadHistory = useCallback(async () => {
    const r = await client.conventionsHistory(projectId, selectedPackagePath);
    if (r.ok && r.data) setHistory(r.data.entries);
  }, [client, projectId, selectedPackagePath]);

  const loadLessons = useCallback(async () => {
    const r = await client.conventionsListLessons(projectId, selectedPackagePath);
    if (r.ok && r.data) {
      setLessons(r.data.lessons);
      setPendingLessonsCount(r.data.pendingCount);
    }
  }, [client, projectId, selectedPackagePath]);

  const loadPackages = useCallback(async () => {
    const r = await client.conventionsListPackages(projectId);
    if (r.ok && r.data) {
      setPackages(r.data.packages);
      setIsMonorepo(r.data.isMonorepo);
    }
  }, [client, projectId]);

  useEffect(() => {
    if (open) {
      setError(null); setNotice(null);
      loadPackages();
    }
  }, [open, loadPackages]);

  const loadEffectiveness = useCallback(async () => {
    const r = await client.conventionsEffectivenessMetrics(projectId);
    if (r.ok && r.data) setEffectiveness(r.data);
  }, [client, projectId]);

  const loadPatterns = useCallback(async () => {
    const r = await client.conventionsListPatterns();
    if (r.ok && r.data) setPatterns(r.data.patterns);
  }, [client]);

  const loadSectionHealth = useCallback(async () => {
    const r = await client.conventionsSectionHealth(projectId);
    if (r.ok && r.data) {
      setSectionHealth(r.data.stats);
      setSuggestedRemovals(r.data.suggestedRemoval);
    }
  }, [client, projectId]);

  const loadConfigOverrides = useCallback(async () => {
    const r = await client.conventionsGetConfigOverrides(projectId);
    if (r.ok && r.data) {
      setConfigOverrides(r.data);
      setOverridesText(JSON.stringify(r.data.overrides, null, 2));
    }
  }, [client, projectId]);

  async function saveConfigOverrides() {
    setBusy('save-overrides'); setError(null); setNotice(null);
    try {
      let parsed: Record<string, unknown>;
      try { parsed = JSON.parse(overridesText); } catch (err) { setError(`JSON-Parse: ${(err as Error).message}`); return; }
      const r = await client.conventionsSetConfigOverrides(projectId, parsed);
      if (r.ok) {
        setNotice('✓ Per-Project-Overrides gespeichert');
        await loadConfigOverrides();
      } else {
        setError(r.reason ?? 'Save failed');
      }
    } finally { setBusy(null); }
  }

  useEffect(() => {
    if (open) {
      loadStatus();
      loadHistory();
      loadLessons();
      loadEffectiveness();
      loadPatterns();
      loadSectionHealth();
      loadConfigOverrides();
    }
  }, [open, selectedPackagePath, loadStatus, loadHistory, loadLessons, loadEffectiveness, loadPatterns, loadSectionHealth, loadConfigOverrides]);

  async function runGenerate() {
    setBusy('generate'); setError(null); setNotice(null);
    try {
      const r = await client.conventionsGenerate(projectId, { packagePath: selectedPackagePath, language, tier: 'strong' });
      if (r.ok && r.data) {
        setDraft(r.data.draft);
        setDraftMeta(r.data);
        setTab('draft');
        setNotice(`✓ Draft generiert (${r.data.draft.length} chars, $${r.data.costUsd?.toFixed(4) ?? '0'}, ${r.data.warnings.length} Warnungen)`);
      } else {
        setError(r.reason ?? 'Generate failed');
      }
    } catch (err) {
      setError((err as Error).message);
    } finally { setBusy(null); }
  }

  async function runRefresh() {
    setBusy('refresh'); setError(null); setNotice(null);
    try {
      const r = await client.conventionsRefresh(projectId, { packagePath: selectedPackagePath, language });
      if (r.ok && r.data) {
        setDraft(r.data.draft);
        setDraftMeta(r.data);
        setTab('draft');
        setNotice('✓ Refresh-Draft generiert (mit Vorlagen-Kontext)');
      } else {
        setError(r.reason ?? 'Refresh failed');
      }
    } finally { setBusy(null); }
  }

  async function runApply() {
    if (!draft) { setError('Kein Draft zum Apply'); return; }
    setBusy('apply'); setError(null); setNotice(null);
    try {
      const r = await client.conventionsApply(projectId, { packagePath: selectedPackagePath, content: draft, commitToGit });
      if (r.ok && r.data) {
        // v880.1 — abgeräumte Lessons sichtbar machen + Lessons-Liste neu laden
        const lessonsNote = (r.data.lessonsMarkedApplied ?? 0) > 0 ? ` · 💡 ${r.data.lessonsMarkedApplied} Lessons als angewendet markiert` : '';
        setNotice(`✓ Apply: ${r.data.filesWritten.join(', ')}${r.data.commitSha ? ` · commit ${r.data.commitSha}` : ''}${r.data.backupCreated ? ' · Backup erstellt' : ''}${lessonsNote}`);
        setDraft('');
        setDraftMeta(null);
        setTab('view');
        await loadStatus();
        await loadHistory();
        await loadLessons();
      } else {
        setError(r.reason ?? 'Apply failed');
      }
    } finally { setBusy(null); }
  }

  async function runConsolidate() {
    setBusy('consolidate'); setError(null); setNotice(null);
    try {
      const r = await client.conventionsConsolidateLessons(projectId, selectedPackagePath);
      if (r.ok && r.data) {
        setDraft(r.data.draft);
        setDraftMeta(r.data);
        setTab('draft');
        setNotice(`✓ ${r.data.consolidatedLessonsCount} Lessons in den Draft integriert — sie bleiben "pending", bis du den Draft per Apply anwendest (erst dann werden sie abgeräumt).`);
      } else {
        setError(r.reason ?? 'Consolidate failed');
      }
    } finally { setBusy(null); }
  }

  async function runDriftCheck() {
    setBusy('drift'); setError(null); setNotice(null);
    try {
      const r = await client.conventionsDriftCheck(projectId, selectedPackagePath);
      if (r.ok && r.data) {
        setNotice(`✓ Drift-Score: ${(r.data.driftScore * 100).toFixed(0)}% · Gründe: ${r.data.reasons.join('; ') || 'keine'}`);
        await loadStatus();
      } else {
        setError(r.reason ?? 'Drift-Check failed');
      }
    } finally { setBusy(null); }
  }

  async function runGenerateAllPackages() {
    if (!confirm(`Generate für ALLE ${packages.length} Pakete starten? Das macht ${packages.length} LLM-Calls sequenziell (kann mehrere Minuten dauern + entsprechend kosten).`)) return;
    setBusy('generate-all'); setError(null); setNotice(null);
    try {
      const r = await client.conventionsGenerateAllPackages(projectId);
      if (r.ok && r.data) {
        setNotice(`✓ ${r.data.successCount}/${r.data.packagesProcessed} Pakete generiert · $${r.data.totalCostUsd.toFixed(4)}${r.data.failureCount > 0 ? ` · ${r.data.failureCount} Fehler` : ''}`);
        await loadPackages();
        await loadStatus();
      } else {
        setError(r.reason ?? 'Generate-All failed');
      }
    } finally { setBusy(null); }
  }

  async function runRollback(historyId: string) {
    if (!confirm(`Rollback auf Version ${historyId.slice(0, 12)}? Aktueller Inhalt wird überschrieben.`)) return;
    setBusy('rollback'); setError(null); setNotice(null);
    try {
      const r = await client.conventionsRollback(projectId, historyId, selectedPackagePath);
      if (r.ok && r.data) {
        setNotice(`✓ Rollback erfolgreich auf ${historyId.slice(0, 12)} (${r.data.filePath})`);
        await loadStatus();
        await loadHistory();
      } else {
        setError(r.reason ?? 'Rollback failed');
      }
    } finally { setBusy(null); }
  }

  if (!open) return null;

  const badgeColor: Record<string, string> = {
    'present-fresh': 'text-emerald-300 bg-emerald-500/10 border-emerald-500/40',
    'present-drift': 'text-amber-300 bg-amber-500/10 border-amber-500/40',
    'present-user-managed': 'text-blue-300 bg-blue-500/10 border-blue-500/40',
    'missing': 'text-red-300 bg-red-500/10 border-red-500/40',
  };

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/70" onClick={onClose}>
      <div className="bg-[#0a0a0a] border border-[#1f1f1f] rounded-lg w-[min(1100px,95vw)] max-h-[90vh] overflow-hidden flex flex-col" onClick={e => e.stopPropagation()}>
        {/* Header */}
        <div className="flex items-center justify-between px-4 py-3 border-b border-[#1f1f1f] gap-3">
          <div className="flex items-center gap-3 flex-wrap">
            <h2 className="text-sm font-semibold text-gray-200">📜 Agent-Konventionen · {projectName}</h2>
            {/* v826 — Monorepo Package-Selector */}
            {isMonorepo && (
              <div className="flex items-center gap-1 text-[11px]">
                <span className="text-gray-500">Package:</span>
                <select
                  value={selectedPackagePath}
                  onChange={e => setSelectedPackagePath(e.target.value)}
                  className="bg-[#0d0d0d] border border-[#1f1f1f] rounded px-2 py-1 text-gray-300 max-w-[280px]"
                  title="Package wählen — root = projekt-globale Konventionen, sonst per-Package"
                >
                  {packages.map(p => {
                    const lessonsLabel = p.pendingLessonsCount > 0 ? ` · ${p.pendingLessonsCount}💡` : '';
                    const driftLabel = p.driftScore > 0.4 ? ' · ⚠' : '';
                    const presentLabel = p.filePresent ? '' : ' (fehlt)';
                    return (
                      <option key={p.path || 'root'} value={p.path}>
                        {p.name}{presentLabel}{lessonsLabel}{driftLabel}
                      </option>
                    );
                  })}
                </select>
                <span className="text-[10px] text-gray-500">{packages.length} Pakete</span>
              </div>
            )}
            {status && (
              <span className={`text-[10px] px-2 py-0.5 border rounded ${badgeColor[status.badge]}`}>
                {status.badge === 'present-fresh' && '✓ Aktuell'}
                {status.badge === 'present-drift' && `⚠ Drift ${(status.driftScore * 100).toFixed(0)}%`}
                {status.badge === 'present-user-managed' && '🔵 User-verwaltet'}
                {status.badge === 'missing' && '✕ Fehlt'}
              </span>
            )}
          </div>
          <button onClick={onClose} className="text-gray-400 hover:text-gray-200 text-lg">✕</button>
        </div>

        {/* Tabs */}
        <div className="flex border-b border-[#1f1f1f] text-xs">
          <button onClick={() => setTab('view')} className={`px-4 py-2 border-r border-[#1f1f1f] ${tab === 'view' ? 'bg-[#1a1a1a] text-gray-200' : 'text-gray-500 hover:bg-[#161616]'}`}>📄 Aktuelle Datei</button>
          <button onClick={() => setTab('draft')} className={`px-4 py-2 border-r border-[#1f1f1f] ${tab === 'draft' ? 'bg-[#1a1a1a] text-gray-200' : 'text-gray-500 hover:bg-[#161616]'}`}>✏️ Draft {draft && '●'}</button>
          <button onClick={() => setTab('lessons')} className={`px-4 py-2 border-r border-[#1f1f1f] ${tab === 'lessons' ? 'bg-[#1a1a1a] text-gray-200' : 'text-gray-500 hover:bg-[#161616]'}`}>
            💡 Lessons ({lessons.length})
            {pendingLessonsCount > 0 && <span className="ml-1 text-[9px] px-1.5 py-0.5 rounded bg-amber-500/30 text-amber-200">{pendingLessonsCount} pending</span>}
          </button>
          <button onClick={() => setTab('history')} className={`px-4 py-2 border-r border-[#1f1f1f] ${tab === 'history' ? 'bg-[#1a1a1a] text-gray-200' : 'text-gray-500 hover:bg-[#161616]'}`}>🕐 Historie ({history.length})</button>
          <button onClick={() => setTab('effectiveness')} className={`px-4 py-2 border-r border-[#1f1f1f] ${tab === 'effectiveness' ? 'bg-[#1a1a1a] text-gray-200' : 'text-gray-500 hover:bg-[#161616]'}`}>
            📊 Effectiveness
            {suggestedRemovals.length > 0 && <span className="ml-1 text-[9px] px-1.5 py-0.5 rounded bg-amber-500/30 text-amber-200">⚠ {suggestedRemovals.length}</span>}
          </button>
          <button onClick={() => setTab('patterns')} className={`px-4 py-2 border-r border-[#1f1f1f] ${tab === 'patterns' ? 'bg-[#1a1a1a] text-gray-200' : 'text-gray-500 hover:bg-[#161616]'}`}>🌐 Cross-Project ({patterns.length})</button>
          <button onClick={() => setTab('settings')} className={`px-4 py-2 border-r border-[#1f1f1f] ${tab === 'settings' ? 'bg-[#1a1a1a] text-gray-200' : 'text-gray-500 hover:bg-[#161616]'}`}>
            ⚙️ Settings{configOverrides && Object.keys(configOverrides.overrides).length > 0 && <span className="ml-1 text-[9px] px-1.5 py-0.5 rounded bg-purple-500/30 text-purple-200">{Object.keys(configOverrides.overrides).length}</span>}
          </button>
        </div>

        {/* Body */}
        <div className="flex-1 overflow-auto p-4 text-xs">
          {error && <div className="mb-3 p-2 border border-red-500/40 bg-red-500/10 text-red-300 rounded">✗ {error}</div>}
          {notice && <div className="mb-3 p-2 border border-emerald-500/40 bg-emerald-500/10 text-emerald-300 rounded">{notice}</div>}

          {tab === 'view' && (
            <div>
              {!status?.filePresent ? (
                <div className="text-gray-500 italic">
                  Keine CLAUDE.md/AGENTS.md im Repo vorhanden. Klicke unten auf "Generate" um eine zu erzeugen.
                </div>
              ) : status.alfredManaged ? (
                <div>
                  <div className="text-[10px] text-gray-500 mb-2">
                    Datei: <span className="font-mono text-gray-400">{status.filePath}</span> · Hash: {status.contentHashOnDisk?.slice(0, 8)} · Last apply: {status.lastAppliedAt ? new Date(status.lastAppliedAt).toLocaleString('de-AT') : '—'}
                  </div>
                  <div className="text-amber-400 text-[10px] mb-3">📝 Live-Preview wird derzeit nicht angezeigt. Öffne die Datei direkt im Editor oder klicke "Refresh" für neuen Draft.</div>
                </div>
              ) : (
                <div className="text-blue-300 text-[11px]">
                  🔵 Diese CLAUDE.md ist User-verwaltet (kein Alfred-Frontmatter). Alfred mischt sich nicht ein. Wenn du Auto-Management willst: klicke "Generate" — wir machen einen Draft, du reviewst, dann überschreiben wir mit Backup.
                </div>
              )}
            </div>
          )}

          {tab === 'draft' && (
            <div>
              {!draft ? (
                <div className="text-gray-500 italic">
                  Noch kein Draft. Klicke unten auf "Generate" (neu) oder "Refresh" (mit Vorlage).
                </div>
              ) : (
                <div>
                  {draftMeta && (
                    <div className="text-[10px] text-gray-500 mb-2 flex flex-wrap gap-3">
                      <span>Framework: <span className="text-gray-400">{draftMeta.scanSnapshot.framework ?? '?'}</span></span>
                      <span>Files: <span className="text-gray-400">{draftMeta.scanSnapshot.totalFiles}</span></span>
                      <span>Cost: <span className="text-gray-400">${draftMeta.costUsd.toFixed(4)}</span></span>
                      <span>Hash: <span className="text-gray-400 font-mono">{draftMeta.contentHash}</span></span>
                      {draftMeta.warnings.length > 0 && <span className="text-amber-400">⚠ {draftMeta.warnings.length} Warnungen</span>}
                    </div>
                  )}
                  <textarea
                    value={draft}
                    onChange={e => setDraft(e.target.value)}
                    className="w-full h-[55vh] bg-[#0d0d0d] border border-[#1f1f1f] rounded p-3 font-mono text-[11px] text-gray-200"
                    spellCheck={false}
                  />
                </div>
              )}
            </div>
          )}

          {tab === 'lessons' && (
            <div>
              <div className="mb-3 text-[11px] text-gray-500">
                Lessons werden automatisch aus Merge-Gate-Failures, Plan-Agent-awaiting-user und
                Fix-Loop-Resolutions abgeleitet. Mit "Consolidate" werden alle pending Lessons in
                einen neuen Draft-CLAUDE.md integriert.
              </div>
              {lessons.length === 0 ? (
                <div className="text-gray-500 italic">Noch keine Lessons gesammelt.</div>
              ) : (
                <div className="space-y-2">
                  {lessons.map(l => (
                    <div key={l.id} className={`p-2 border rounded ${l.appliedToMain ? 'border-gray-700 opacity-60' : 'border-amber-500/40 bg-amber-500/5'}`}>
                      <div className="flex items-center justify-between text-[10px] text-gray-500 mb-1">
                        <span>
                          {l.appliedToMain ? '✓ applied' : '⏳ pending'} ·
                          <span className="ml-1 font-mono">{l.source}</span> ·
                          <span className="ml-1">conf {(l.confidence * 100).toFixed(0)}%</span> ·
                          <span className="ml-1">{new Date(l.learnedAt).toLocaleString('de-AT')}</span>
                        </span>
                      </div>
                      <div className="text-[11px] text-gray-300 whitespace-pre-wrap">{l.text}</div>
                    </div>
                  ))}
                </div>
              )}
            </div>
          )}

          {tab === 'effectiveness' && (
            <div>
              <div className="mb-3 text-[11px] text-gray-500">
                Pre/Post-Apply Vergleich der Convention-Violations. Wertet aus ob die
                Konventionen Coding-Quality tatsächlich messbar verbessern.
              </div>
              {!effectiveness?.hasBaseline ? (
                <div className="text-gray-500 italic">
                  ⏳ Noch keine Baseline. {effectiveness?.reason ?? 'Conventions müssen erst einmal applied werden, dann werden Violations vor/nach getrennt gezählt.'}
                </div>
              ) : (
                <div className="space-y-3">
                  <div className="p-3 border border-[#1f1f1f] rounded bg-[#0d0d0d]">
                    <div className="text-[10px] text-gray-500 mb-2">Apply-Cutoff: {new Date(effectiveness.appliedAt!).toLocaleString('de-AT')}</div>
                    <div className="grid grid-cols-3 gap-3 text-center">
                      <div>
                        <div className="text-2xl text-red-400">{effectiveness.preApplyViolations}</div>
                        <div className="text-[10px] text-gray-500">Pre-Apply Violations</div>
                      </div>
                      <div>
                        <div className="text-2xl text-emerald-400">{effectiveness.postApplyViolations}</div>
                        <div className="text-[10px] text-gray-500">Post-Apply Violations</div>
                      </div>
                      <div>
                        <div className={`text-2xl ${effectiveness.improvement == null ? 'text-gray-500' : effectiveness.improvement > 0 ? 'text-emerald-400' : 'text-amber-400'}`}>
                          {effectiveness.improvement == null ? '—' : `${effectiveness.improvement}%`}
                        </div>
                        <div className="text-[10px] text-gray-500">Improvement</div>
                      </div>
                    </div>
                    <div className="mt-3 text-[10px] text-gray-500 text-center">
                      Confidence: {effectiveness.confidence === 'statistically-relevant'
                        ? <span className="text-emerald-400">statistically-relevant (≥10 samples)</span>
                        : <span className="text-amber-400">too-few-samples (warten)</span>}
                    </div>
                  </div>
                  <div className="p-3 border border-[#1f1f1f] rounded bg-[#0d0d0d]">
                    <div className="text-[10px] text-gray-500 mb-2">Lessons</div>
                    <div className="flex justify-between text-xs">
                      <span>Total: <span className="text-gray-300">{effectiveness.lessonsTotal}</span></span>
                      <span>Applied: <span className="text-emerald-400">{effectiveness.lessonsApplied}</span></span>
                      <span>Drift-Score: <span className={`${(effectiveness.driftScore ?? 0) > 0.4 ? 'text-amber-400' : 'text-gray-300'}`}>{((effectiveness.driftScore ?? 0) * 100).toFixed(0)}%</span></span>
                    </div>
                  </div>
                  {sectionHealth.length > 0 && (
                    <div className="p-3 border border-[#1f1f1f] rounded bg-[#0d0d0d]">
                      <div className="text-[10px] text-gray-500 mb-2">Section-Health (Phase 4.2 Inverse-Learning)</div>
                      <div className="space-y-1">
                        {sectionHealth.map(s => (
                          <div key={s.section} className="flex items-center justify-between text-xs">
                            <span className="font-mono">{s.section}</span>
                            <span className={`${s.healthScore >= 0.7 ? 'text-emerald-400' : s.healthScore >= 0.4 ? 'text-amber-400' : 'text-red-400'}`}>
                              health {(s.healthScore * 100).toFixed(0)}% ({s.violations} violations, {s.resolvedAnyway} resolved-anyway)
                            </span>
                          </div>
                        ))}
                      </div>
                      {suggestedRemovals.length > 0 && (
                        <div className="mt-2 p-2 border border-amber-500/40 bg-amber-500/5 rounded">
                          <div className="text-[10px] text-amber-300 font-semibold mb-1">⚠ Suggested Removal:</div>
                          {suggestedRemovals.map(s => (
                            <div key={s.section} className="text-[11px] text-amber-200">
                              "{s.section}" ist möglicherweise zu eng — {s.violations} violations, davon {s.resolvedAnyway} resolved-anyway. Refactor oder entfernen empfohlen.
                            </div>
                          ))}
                        </div>
                      )}
                    </div>
                  )}
                </div>
              )}
            </div>
          )}

          {tab === 'patterns' && (
            <div>
              <div className="mb-3 text-[11px] text-gray-500">
                Cross-Project-Patterns aus dem Lessons-Pool aller deiner Projekte. Wird
                wöchentlich gemined (Jaccard-Similarity). Patterns mit ≥2 Lessons aus
                ≥2 Projekten werden hier sichtbar + automatisch beim Generate vorgeschlagen.
              </div>
              {patterns.length === 0 ? (
                <div className="text-gray-500 italic">
                  Noch keine Cross-Project-Patterns. Tritt auf wenn dieselbe Lesson in
                  mehreren Projekten gelernt wird (Pattern-Mining läuft alle 7 Tage automatisch).
                </div>
              ) : (
                <div className="space-y-2">
                  {patterns.map(p => (
                    <div key={p.id} className="p-2 border border-[#1f1f1f] rounded bg-[#0d0d0d]">
                      <div className="flex items-center justify-between text-[10px] text-gray-500 mb-1">
                        <span>
                          <span className="font-mono">{p.patternSection}</span> ·
                          <span className="ml-1">conf {(p.confidence * 100).toFixed(0)}%</span> ·
                          <span className="ml-1">{p.occurrenceCount}× beobachtet</span> ·
                          <span className="ml-1">{p.appliesToCount} Projekte applied</span>
                        </span>
                      </div>
                      <div className="text-[11px] text-gray-300 whitespace-pre-wrap">{p.patternText}</div>
                      {p.frameworkTags.length > 0 && (
                        <div className="mt-1 flex gap-1">
                          {p.frameworkTags.map(t => (
                            <span key={t} className="text-[9px] px-1.5 py-0.5 rounded bg-cyan-500/15 text-cyan-300 border border-cyan-500/30">{t}</span>
                          ))}
                        </div>
                      )}
                    </div>
                  ))}
                </div>
              )}
            </div>
          )}

          {tab === 'settings' && (
            <div>
              <div className="mb-3 text-[11px] text-gray-500">
                Per-Project Config-Overrides. Werden über die globale Config aus
                <code className="text-cyan-400 mx-1">config/default.yml</code> gemerged.
                Beispiel: in einem Projekt aggressiver auto-apply, in anderen off.
                JSON-Format (subset von AgentConventionsConfig).
              </div>
              <div className="mb-2 text-[10px] text-gray-500">Beispiel:</div>
              <pre className="text-[10px] bg-[#0d0d0d] border border-[#1f1f1f] rounded p-2 mb-3 text-gray-400">{`{
  "autoApplyMode": "aggressive",
  "generateTier": "default",
  "language": "en"
}`}</pre>
              <textarea
                value={overridesText}
                onChange={e => setOverridesText(e.target.value)}
                className="w-full h-[35vh] bg-[#0d0d0d] border border-[#1f1f1f] rounded p-3 font-mono text-[11px] text-gray-200"
                spellCheck={false}
              />
              <div className="mt-3 flex justify-end gap-2">
                <button
                  onClick={() => { setOverridesText('{}'); }}
                  disabled={busy !== null}
                  className="px-3 py-1 text-xs text-gray-400 border border-gray-500/40 rounded hover:bg-gray-500/10"
                >Reset zu {}</button>
                <button
                  onClick={saveConfigOverrides}
                  disabled={busy !== null}
                  className="px-3 py-1 text-xs bg-purple-500/20 border border-purple-500/40 text-purple-300 hover:bg-purple-500/30 rounded disabled:opacity-60"
                >{busy === 'save-overrides' ? '⏳ Speichern …' : '💾 Speichern'}</button>
              </div>
              {configOverrides && (
                <details className="mt-4">
                  <summary className="text-[10px] text-gray-500 cursor-pointer">Effektive Config (global + overrides)</summary>
                  <pre className="text-[10px] text-gray-400 bg-[#0d0d0d] border border-[#1f1f1f] rounded p-2 mt-1 overflow-auto">
                    {JSON.stringify(configOverrides.effective, null, 2)}
                  </pre>
                </details>
              )}
            </div>
          )}

          {tab === 'history' && (
            <div>
              {history.length === 0 ? (
                <div className="text-gray-500 italic">Keine Apply-Historie.</div>
              ) : (
                <div className="space-y-1">
                  {history.map(h => (
                    <div key={h.id} className={`p-2 border rounded ${h.rolledBackAt ? 'border-gray-700 opacity-60' : 'border-[#1f1f1f]'}`}>
                      <div className="flex items-center justify-between">
                        <div className="font-mono text-[10px] text-gray-400">{new Date(h.appliedAt).toLocaleString('de-AT')} · {h.appliedBy} · {h.triggerSource}</div>
                        {!h.rolledBackAt && h.prevContentSnapshot && (
                          <button
                            onClick={() => runRollback(h.id)}
                            disabled={busy !== null}
                            className="text-[10px] px-2 py-0.5 border border-amber-500/40 text-amber-300 hover:bg-amber-500/15 rounded"
                          >↶ Rollback</button>
                        )}
                        {h.rolledBackAt && (
                          <span className="text-[10px] text-gray-500">↷ rollbacked {new Date(h.rolledBackAt).toLocaleDateString('de-AT')}</span>
                        )}
                      </div>
                      <div className="text-[10px] text-gray-500 mt-1">
                        {h.prevContentHash?.slice(0, 8) ?? '∅'} → {h.newContentHash.slice(0, 8)} · {h.diffSummary ?? ''}
                      </div>
                    </div>
                  ))}
                </div>
              )}
            </div>
          )}
        </div>

        {/* Footer */}
        <div className="border-t border-[#1f1f1f] px-4 py-3 flex flex-wrap items-center gap-2 text-xs">
          <div className="flex items-center gap-2 mr-2">
            <label className="text-gray-500">Sprache:</label>
            <select value={language} onChange={e => setLanguage(e.target.value as 'de' | 'en')} className="bg-[#0d0d0d] border border-[#1f1f1f] rounded px-2 py-1 text-gray-300">
              <option value="de">Deutsch</option>
              <option value="en">English</option>
            </select>
          </div>
          <button onClick={runGenerate} disabled={busy !== null} className="px-3 py-1 bg-emerald-500/20 border border-emerald-500/40 text-emerald-300 hover:bg-emerald-500/30 rounded disabled:opacity-60">
            {busy === 'generate' ? '⏳ Generate …' : `✨ Generate${isMonorepo && selectedPackagePath ? ` (${selectedPackagePath})` : ''}`}
          </button>
          {isMonorepo && (
            <button onClick={runGenerateAllPackages} disabled={busy !== null} className="px-3 py-1 bg-emerald-500/20 border border-emerald-500/40 text-emerald-300 hover:bg-emerald-500/30 rounded disabled:opacity-60" title={`Generate für alle ${packages.length} Pakete sequenziell`}>
              {busy === 'generate-all' ? '⏳ All …' : `✨ All (${packages.length})`}
            </button>
          )}
          <button onClick={runRefresh} disabled={busy !== null || !status?.filePresent} className="px-3 py-1 bg-cyan-500/20 border border-cyan-500/40 text-cyan-300 hover:bg-cyan-500/30 rounded disabled:opacity-60">
            {busy === 'refresh' ? '⏳ Refresh …' : '🔄 Refresh (mit Vorlage)'}
          </button>
          <button onClick={runDriftCheck} disabled={busy !== null || !status?.filePresent} className="px-3 py-1 bg-amber-500/20 border border-amber-500/40 text-amber-300 hover:bg-amber-500/30 rounded disabled:opacity-60">
            {busy === 'drift' ? '⏳ Drift …' : '📊 Drift-Check'}
          </button>
          <button
            onClick={runConsolidate}
            disabled={busy !== null || pendingLessonsCount === 0}
            title={pendingLessonsCount === 0 ? 'Keine pending Lessons' : `${pendingLessonsCount} Lessons konsolidieren`}
            className="px-3 py-1 bg-purple-500/20 border border-purple-500/40 text-purple-300 hover:bg-purple-500/30 rounded disabled:opacity-60"
          >
            {busy === 'consolidate' ? '⏳ Consolidate …' : `💡 Consolidate Lessons${pendingLessonsCount > 0 ? ` (${pendingLessonsCount})` : ''}`}
          </button>
          <div className="flex-1" />
          <label className="flex items-center gap-1 text-[10px] text-gray-500">
            <input type="checkbox" checked={commitToGit} onChange={e => setCommitToGit(e.target.checked)} />
            git commit
          </label>
          <button
            onClick={runApply}
            disabled={busy !== null || !draft}
            className="px-3 py-1 bg-purple-500/20 border border-purple-500/40 text-purple-300 hover:bg-purple-500/30 rounded disabled:opacity-60"
          >
            {busy === 'apply' ? '⏳ Apply …' : '✓ Apply Draft'}
          </button>
        </div>
      </div>
    </div>
  );
}
