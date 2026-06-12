'use client';

/**
 * v872 — Repo-Status-Karte: frischer Git-Zustand on-demand (nicht der 6h-Health-Cache).
 *
 * Macht genau die Zustände sichtbar, die im Betrieb teuer waren:
 *  - uncommittete Dateien nach Agent-Läufen (dirty)
 *  - ungepushte Commits (ahead of origin)
 *  - Arbeit auf dem falschen Branch (branch ≠ default_branch)
 * Dazu das CI-Pipeline-Badge je Forge-Provider (GitLab/GitHub).
 */
import { useCallback, useEffect, useState } from 'react';
import type { AlfredClient, Project, ProjectRepoStatus, ProjectPipelineInfo, ProjectMergeRequest } from '@/lib/alfred-client';

const PIPELINE_META: Record<ProjectPipelineInfo['state'], { icon: string; cls: string; label: string }> = {
  success: { icon: '●', cls: 'text-emerald-400', label: 'success' },
  running: { icon: '◐', cls: 'text-blue-400', label: 'running' },
  pending: { icon: '◌', cls: 'text-amber-400', label: 'pending' },
  failure: { icon: '●', cls: 'text-red-400', label: 'failed' },
  unknown: { icon: '○', cls: 'text-gray-500', label: 'unknown' },
};

export function RepoStatusCard({ client, projectId, project, onProjectUpdated }: {
  client: AlfredClient;
  projectId: string;
  /** v874 — für den Review-Gate-Schalter (conventions.branching.strategy). */
  project?: Project;
  onProjectUpdated?: (p: Project) => void;
}) {
  const [status, setStatus] = useState<ProjectRepoStatus | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [pipelines, setPipelines] = useState<ProjectPipelineInfo[] | null>(null);
  const [mergeRequests, setMergeRequests] = useState<ProjectMergeRequest[] | null>(null);
  const [loading, setLoading] = useState(false);
  const [filesExpanded, setFilesExpanded] = useState(false);
  const [gateSaving, setGateSaving] = useState(false);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      // Repo-Status zuerst (lokal, schnell) — Forge-Calls danach (können dauern)
      const rs = await client.fetchProjectRepoStatus(projectId);
      if ('error' in rs) {
        setError(rs.error);
        setStatus(null);
      } else {
        setStatus(rs);
        setError(null);
      }
      const [ps, mrs] = await Promise.all([
        client.fetchProjectPipelineStatus(projectId),
        client.fetchProjectMergeRequests(projectId),
      ]);
      setPipelines(ps.pipelines);
      setMergeRequests(mrs.mergeRequests);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setLoading(false);
    }
  }, [client, projectId]);

  useEffect(() => {
    setStatus(null); setPipelines(null); setMergeRequests(null); setError(null); setFilesExpanded(false);
    void load();
  }, [load]);

  // v874 — Review-Gate: feature-branches erzwingt branchPerSession im Runner
  // (v663a) + Auto-MR nach Push (v874). Der Schalter saß bisher versteckt im
  // Conventions-Formular.
  const gateOn = project?.conventions?.branching?.strategy === 'feature-branches';
  async function toggleGate() {
    if (!project || !onProjectUpdated || gateSaving) return;
    const next = gateOn ? 'main-only' : 'feature-branches';
    if (!confirm(gateOn
      ? 'Review-Gate deaktivieren? Agent-Sessions committen dann wieder direkt auf den Arbeits-Branch.'
      : 'Review-Gate aktivieren? Jede Agent-Session arbeitet dann auf einem eigenen Feature-Branch und erstellt nach dem Push automatisch einen MR/PR auf den Deploy-Branch — gemergt wird erst nach deinem Review.')) return;
    setGateSaving(true);
    try {
      const conv = { ...(project.conventions ?? {}), branching: { ...(project.conventions?.branching ?? {}), strategy: next as 'main-only' | 'feature-branches' } };
      const updated = await client.updateProject(project.id, { conventions: conv });
      if (updated) onProjectUpdated(updated);
    } finally {
      setGateSaving(false);
    }
  }

  const branchMismatch = status?.onDefaultBranch === false;
  const dirty = (status?.dirtyCount ?? 0) > 0;
  const ahead = (status?.ahead ?? 0) > 0;
  const behind = (status?.behind ?? 0) > 0;
  const allClean = status && !dirty && !ahead && !behind && !branchMismatch;

  return (
    <div className="pt-2 border-t border-[#222]">
      <div className="flex items-center justify-between mb-2">
        <h3 className="text-sm font-semibold text-gray-400">Repo-Status</h3>
        <div className="flex items-center gap-1">
          {/* v874 — Review-Gate prominent (vorher nur tief im Conventions-Formular) */}
          {project && onProjectUpdated && (
            <button
              onClick={() => void toggleGate()}
              disabled={gateSaving}
              className={`px-2 py-0.5 text-[10px] rounded border disabled:opacity-60 ${gateOn
                ? 'text-emerald-300 border-emerald-500/40 bg-emerald-500/10 hover:bg-emerald-500/20'
                : 'text-gray-400 border-[#2a2a2a] hover:bg-[#222]'}`}
              title={gateOn
                ? 'Review-Gate AKTIV: Agent-Sessions arbeiten auf Feature-Branches und erstellen nach dem Push automatisch einen MR/PR auf den Deploy-Branch. Klick zum Deaktivieren.'
                : 'Review-Gate AUS: Agent-Sessions committen direkt auf den Arbeits-Branch. Klick zum Aktivieren (Feature-Branch pro Session + Auto-MR).'}
            >{gateSaving ? '⏳…' : gateOn ? '🛡 Review-Gate an' : '🛡 Review-Gate aus'}</button>
          )}
          <button
            onClick={() => void load()}
            disabled={loading}
            className="px-2 py-0.5 text-[10px] text-cyan-400 hover:bg-cyan-500/10 border border-cyan-500/30 rounded disabled:opacity-60 disabled:cursor-wait"
            title="Git-Zustand jetzt neu lesen (dirty/ahead/behind/Branch)"
          >{loading ? '⏳…' : '🔄 Aktualisieren'}</button>
        </div>
      </div>

      {error && <div className="text-xs text-red-400">✗ {error}</div>}
      {!error && !status && <div className="text-xs text-gray-600">{loading ? 'Lese Git-Zustand…' : 'Kein Status verfügbar.'}</div>}

      {status && (
        <div className="space-y-1 text-xs">
          <div className="flex flex-wrap items-center gap-2">
            <span className={`font-mono px-1.5 py-0.5 rounded border ${branchMismatch ? 'text-amber-300 border-amber-500/40 bg-amber-500/10' : 'text-gray-300 border-[#2a2a2a] bg-[#1a1a1a]'}`}>
              {status.branch}
            </span>
            {branchMismatch && (
              <span className="text-amber-400" title={`Konfigurierter Default-/Deploy-Branch: ${status.defaultBranch}`}>
                ⚠ nicht auf {status.defaultBranch}
              </span>
            )}
            <span className="font-mono text-gray-500">{status.sha}</span>
            <span className="text-gray-600">
              letzter Commit {status.commitAgeDays === 0 ? 'heute' : `vor ${status.commitAgeDays} Tag${status.commitAgeDays === 1 ? '' : 'en'}`}
            </span>
          </div>

          <div className="flex flex-wrap items-center gap-3">
            {dirty ? (
              <button
                onClick={() => setFilesExpanded(e => !e)}
                className="text-red-400 hover:underline"
                title="Uncommittete Dateien anzeigen"
              >🔴 {status.dirtyCount} uncommittete Datei{status.dirtyCount === 1 ? '' : 'en'} {filesExpanded ? '▼' : '▶'}</button>
            ) : (
              <span className="text-gray-500">✓ working tree clean</span>
            )}
            {status.upstream === null ? (
              <span className="text-gray-600" title="Branch hat keinen Tracking-Remote-Branch (push -u fehlt)">⚪ kein Upstream</span>
            ) : (
              <>
                {ahead && <span className="text-amber-400" title={`${status.ahead} lokale Commits noch nicht gepusht (${status.upstream})`}>⬆ {status.ahead} ungepusht</span>}
                {behind && <span className="text-blue-400" title={`${status.behind} Commits hinter ${status.upstream}`}>⬇ {status.behind} hinter Remote</span>}
                {!ahead && !behind && <span className="text-gray-500">✓ synchron mit {status.upstream}</span>}
              </>
            )}
            {allClean && <span className="text-emerald-400">✓</span>}
          </div>

          {filesExpanded && dirty && (
            <div className="font-mono text-[10px] text-gray-500 pl-4 space-y-0.5">
              {status.dirtyFiles.map(f => <div key={f} className="truncate">{f}</div>)}
              {status.dirtyCount > status.dirtyFiles.length && (
                <div className="italic">… +{status.dirtyCount - status.dirtyFiles.length} weitere</div>
              )}
            </div>
          )}

          {/* CI-Pipeline-Badge je Provider — nur rendern wenn Forge etwas geliefert hat */}
          {pipelines && pipelines.length > 0 && (
            <div className="flex flex-wrap items-center gap-3 pt-1">
              <span className="text-gray-600">CI:</span>
              {pipelines.map(p => {
                const meta = PIPELINE_META[p.state] ?? PIPELINE_META.unknown;
                const label = `${p.provider} ${meta.label} (${p.ref})`;
                return p.url ? (
                  <a key={p.provider} href={p.url} target="_blank" rel="noreferrer" className={`${meta.cls} hover:underline`} title={label}>
                    {meta.icon} {p.provider}: {meta.label}
                  </a>
                ) : (
                  <span key={p.provider} className={meta.cls} title={label}>
                    {meta.icon} {p.provider}: {meta.label}
                  </span>
                );
              })}
            </div>
          )}

          {/* v874 — offene MRs/PRs (Self-Healing + Review-Gate erstellen welche;
              sichtbar waren sie bisher nur im Forge) */}
          {mergeRequests && mergeRequests.length > 0 && (
            <div className="pt-1">
              <div className="text-gray-600 mb-0.5">Offene MRs/PRs ({mergeRequests.length}):</div>
              <div className="space-y-0.5 pl-2">
                {mergeRequests.slice(0, 8).map(mr => (
                  <div key={`${mr.provider}-${mr.number}`} className="flex items-center gap-2 min-w-0">
                    <span className="text-gray-600 font-mono shrink-0">!{mr.number}</span>
                    <a href={mr.url} target="_blank" rel="noreferrer" className="text-blue-400 hover:underline truncate" title={mr.title}>
                      {mr.title}
                    </a>
                    <span className="text-gray-600 font-mono text-[10px] shrink-0" title={`${mr.sourceBranch} → ${mr.targetBranch} (${mr.provider})`}>
                      {mr.sourceBranch} → {mr.targetBranch}
                    </span>
                  </div>
                ))}
                {mergeRequests.length > 8 && (
                  <div className="text-[10px] text-gray-600 italic">… +{mergeRequests.length - 8} weitere im Forge</div>
                )}
              </div>
            </div>
          )}
        </div>
      )}
    </div>
  );
}
