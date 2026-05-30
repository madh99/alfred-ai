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
} from '../../lib/alfred-client';

interface Props {
  client: AlfredClient;
  projectId: string;
  projectName: string;
  open: boolean;
  onClose: () => void;
}

type Tab = 'view' | 'draft' | 'history';

export function AgentConventionsModal({ client, projectId, projectName, open, onClose }: Props) {
  const [status, setStatus] = useState<AgentConventionsStatus | null>(null);
  const [draft, setDraft] = useState<string>('');
  const [draftMeta, setDraftMeta] = useState<AgentConventionsGenerateData | null>(null);
  const [history, setHistory] = useState<AgentConventionsHistoryEntry[]>([]);
  const [tab, setTab] = useState<Tab>('view');
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [language, setLanguage] = useState<'de' | 'en'>('de');
  const [commitToGit, setCommitToGit] = useState(true);

  const loadStatus = useCallback(async () => {
    const r = await client.conventionsStatus(projectId);
    if (r.ok && r.data) setStatus(r.data);
    else setError(r.reason ?? null);
  }, [client, projectId]);

  const loadHistory = useCallback(async () => {
    const r = await client.conventionsHistory(projectId);
    if (r.ok && r.data) setHistory(r.data.entries);
  }, [client, projectId]);

  useEffect(() => {
    if (open) {
      setError(null); setNotice(null);
      loadStatus();
      loadHistory();
    }
  }, [open, loadStatus, loadHistory]);

  async function runGenerate() {
    setBusy('generate'); setError(null); setNotice(null);
    try {
      const r = await client.conventionsGenerate(projectId, { language, tier: 'strong' });
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
      const r = await client.conventionsRefresh(projectId, { language });
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
      const r = await client.conventionsApply(projectId, { content: draft, commitToGit });
      if (r.ok && r.data) {
        setNotice(`✓ Apply: ${r.data.filesWritten.join(', ')}${r.data.commitSha ? ` · commit ${r.data.commitSha}` : ''}${r.data.backupCreated ? ' · Backup erstellt' : ''}`);
        setDraft('');
        setDraftMeta(null);
        setTab('view');
        await loadStatus();
        await loadHistory();
      } else {
        setError(r.reason ?? 'Apply failed');
      }
    } finally { setBusy(null); }
  }

  async function runDriftCheck() {
    setBusy('drift'); setError(null); setNotice(null);
    try {
      const r = await client.conventionsDriftCheck(projectId);
      if (r.ok && r.data) {
        setNotice(`✓ Drift-Score: ${(r.data.driftScore * 100).toFixed(0)}% · Gründe: ${r.data.reasons.join('; ') || 'keine'}`);
        await loadStatus();
      } else {
        setError(r.reason ?? 'Drift-Check failed');
      }
    } finally { setBusy(null); }
  }

  async function runRollback(historyId: string) {
    if (!confirm(`Rollback auf Version ${historyId.slice(0, 12)}? Aktueller Inhalt wird überschrieben.`)) return;
    setBusy('rollback'); setError(null); setNotice(null);
    try {
      const r = await client.conventionsRollback(projectId, historyId);
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
        <div className="flex items-center justify-between px-4 py-3 border-b border-[#1f1f1f]">
          <div className="flex items-center gap-3">
            <h2 className="text-sm font-semibold text-gray-200">📜 Agent-Konventionen · {projectName}</h2>
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
          <button onClick={() => setTab('history')} className={`px-4 py-2 border-r border-[#1f1f1f] ${tab === 'history' ? 'bg-[#1a1a1a] text-gray-200' : 'text-gray-500 hover:bg-[#161616]'}`}>🕐 Historie ({history.length})</button>
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
            {busy === 'generate' ? '⏳ Generate …' : '✨ Generate (neu)'}
          </button>
          <button onClick={runRefresh} disabled={busy !== null || !status?.filePresent} className="px-3 py-1 bg-cyan-500/20 border border-cyan-500/40 text-cyan-300 hover:bg-cyan-500/30 rounded disabled:opacity-60">
            {busy === 'refresh' ? '⏳ Refresh …' : '🔄 Refresh (mit Vorlage)'}
          </button>
          <button onClick={runDriftCheck} disabled={busy !== null || !status?.filePresent} className="px-3 py-1 bg-amber-500/20 border border-amber-500/40 text-amber-300 hover:bg-amber-500/30 rounded disabled:opacity-60">
            {busy === 'drift' ? '⏳ Drift …' : '📊 Drift-Check'}
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
