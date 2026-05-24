'use client';

import { useEffect, useState, useCallback } from 'react';
import { useConfig } from '@/context/ConfigContext';
import type { ProjectLastDeploy } from '@/lib/alfred-client';

interface Props {
  projectId: string;
  projectName: string;
  defaultRepoUrl?: string;
  /** Callback um DeployModal mit Prefill zu öffnen (Re-Deploy). */
  onReDeploy?: (deploy: ProjectLastDeploy) => void;
}

function formatDate(iso?: string): string {
  if (!iso) return '—';
  try {
    const d = new Date(iso);
    return d.toLocaleString('de-DE', { day: '2-digit', month: '2-digit', year: 'numeric', hour: '2-digit', minute: '2-digit' });
  } catch { return iso; }
}

function formatRelative(iso?: string): string {
  if (!iso) return '';
  try {
    const ms = Date.now() - new Date(iso).getTime();
    const sec = Math.floor(ms / 1000);
    if (sec < 60) return `${sec}s`;
    if (sec < 3600) return `${Math.floor(sec / 60)}m`;
    if (sec < 86400) return `${Math.floor(sec / 3600)}h`;
    if (sec < 86400 * 30) return `${Math.floor(sec / 86400)}d`;
    return `${Math.floor(sec / 86400 / 30)}mo`;
  } catch { return ''; }
}

/**
 * v741 — Deploy-History pro Project.
 * Liste aller Deploys aus deploy_*-Memories (auto-saved nach jedem Deploy).
 * Pro Eintrag: Status (success/failed), Host, Runtime/PM, Port, Date.
 * Action: Re-Deploy → öffnet DeployModal mit Prefill.
 */
export function ProjectDeployHistoryView({ projectId, projectName, onReDeploy }: Props) {
  const { client } = useConfig();
  const [expanded, setExpanded] = useState(false);
  const [deploys, setDeploys] = useState<ProjectLastDeploy[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [filterHost, setFilterHost] = useState<string>('');

  const load = useCallback(async () => {
    if (!client) return;
    setLoading(true); setError(null);
    try {
      const r = await client.fetchProjectLastDeploys(projectId);
      setDeploys(r.deploys);
    } catch (e) { setError(e instanceof Error ? e.message : String(e)); }
    finally { setLoading(false); }
  }, [client, projectId]);

  useEffect(() => {
    if (!expanded) return;
    load();
  }, [expanded, load]);

  const hosts = Array.from(new Set(deploys.map(d => d.host))).sort();
  const filtered = filterHost ? deploys.filter(d => d.host === filterHost) : deploys;
  const successCount = deploys.filter(d => !d.failed).length;
  const failedCount = deploys.filter(d => d.failed).length;

  return (
    <div className="pt-2 border-t border-[#222]">
      <button
        onClick={() => setExpanded(e => !e)}
        className="w-full flex items-center justify-between text-sm font-semibold text-gray-400 hover:text-gray-200 mb-2"
      >
        <span>
          📦 Deploy-Verlauf
          {deploys.length > 0 && (
            <span className="ml-2 text-xs">
              <span className="text-emerald-400">✓ {successCount}</span>
              {failedCount > 0 && <span className="text-red-400 ml-1">✗ {failedCount}</span>}
              <span className="text-gray-500 ml-1">/ {deploys.length}</span>
            </span>
          )}
        </span>
        <span className="text-xs">{expanded ? '▼' : '▶'}</span>
      </button>
      {expanded && (
        <div className="space-y-2 text-xs">
          {error && <div className="bg-red-500/10 border border-red-500/30 text-red-400 px-2 py-1 rounded">{error}</div>}

          {loading && deploys.length === 0 && <div className="text-gray-500 italic">Lädt…</div>}

          {!loading && deploys.length === 0 && (
            <div className="text-gray-500 italic">
              Keine Deploys für <span className="text-gray-400">{projectName}</span> gefunden. Nach dem ersten 🚀 Deploy landet hier die History.
            </div>
          )}

          {deploys.length > 0 && (
            <div className="flex items-center gap-2 flex-wrap">
              <label className="text-[10px] text-gray-500">Host-Filter:</label>
              <select
                value={filterHost}
                onChange={(e) => setFilterHost(e.target.value)}
                className="bg-[#0a0a0a] border border-[#1a1a1a] rounded px-2 py-1 text-[11px] text-gray-200"
              >
                <option value="">alle ({deploys.length})</option>
                {hosts.map(h => <option key={h} value={h}>{h} ({deploys.filter(d => d.host === h).length})</option>)}
              </select>
              <button onClick={load} className="px-2 py-1 border border-gray-500/40 text-gray-300 hover:bg-gray-500/15 rounded text-[10px] ml-auto">🔄 Refresh</button>
            </div>
          )}

          <div className="space-y-1">
            {filtered.map((d, i) => {
              const failed = d.failed === true;
              const borderCls = failed ? 'border-red-500/30 bg-red-500/5' : 'border-[#1a1a1a] bg-[#0a0a0a]';
              return (
                <div key={`${d.host}-${d.date ?? d.updatedAt ?? i}`} className={`rounded p-2 border ${borderCls}`}>
                  <div className="flex items-center gap-2 flex-wrap">
                    <span className={`text-[10px] px-1.5 py-0.5 rounded border ${failed ? 'border-red-500/40 text-red-400 bg-red-500/10' : 'border-emerald-500/40 text-emerald-300 bg-emerald-500/10'}`}>
                      {failed ? '✗ failed' : '✓ deployed'}
                    </span>
                    <code className="text-amber-300 font-mono text-[11px]">{d.user}@{d.host}</code>
                    {d.runtime && <span className="text-[10px] text-gray-500">{d.runtime}</span>}
                    {d.processManager && <span className="text-[10px] text-gray-500">· {d.processManager}{d.composeVariant ? ` (${d.composeVariant})` : ''}</span>}
                    {d.port && <span className="text-[10px] text-gray-500">· port {d.port}</span>}
                    {d.verified && <span className="text-[10px] text-emerald-400" title="Verified via Post-Deploy-Check">✓</span>}
                    <span className="text-[10px] text-gray-500 ml-auto" title={d.date ?? d.updatedAt}>
                      {formatRelative(d.date ?? d.updatedAt)} {d.date || d.updatedAt ? `(${formatDate(d.date ?? d.updatedAt)})` : ''}
                    </span>
                  </div>
                  {failed && d.error && (
                    <div className="text-[10px] text-red-300 italic mt-1 line-clamp-2" title={d.error}>{d.error}</div>
                  )}
                  {onReDeploy && (
                    <div className="flex justify-end mt-1">
                      <button
                        onClick={() => onReDeploy(d)}
                        className="px-2 py-0.5 border border-blue-500/40 text-blue-300 hover:bg-blue-500/15 rounded text-[10px]"
                        title="DeployModal mit diesen Werten vorausfüllen"
                      >↻ Re-Deploy</button>
                    </div>
                  )}
                </div>
              );
            })}
          </div>
        </div>
      )}
    </div>
  );
}
