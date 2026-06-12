'use client';

/**
 * v873 — Dependency-Panel: strukturierte Outdated-Liste + Update-Lauf.
 *
 * Die deps-Probe meldete nur "N outdated direct dep(s): a, b, c..." — die
 * strukturierten npm-outdated-Daten wurden weggeworfen. Jetzt: Tabelle
 * (current/wanted/latest), Auswahl einzelner Pakete und „Update-Lauf starten"
 * (async Code-Agent mit Live-Panel, Build/Test-Verifikation, Auto-Push).
 */
import { useEffect, useState } from 'react';
import type { AlfredClient, ProjectOutdatedDep } from '@/lib/alfred-client';
import { CodeRunLivePanel } from './CodeRunLivePanel';

export function ProjectDepsView({ client, projectId, notify }: {
  client: AlfredClient;
  projectId: string;
  notify: (kind: 'success' | 'error' | 'info', text: string) => void;
}) {
  const [expanded, setExpanded] = useState(false);
  const [deps, setDeps] = useState<ProjectOutdatedDep[] | null>(null);
  const [manifest, setManifest] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [starting, setStarting] = useState(false);
  // Eigenes Live-Panel (unabhängig vom Open-Items-Panel der ProjectsPage —
  // das hängt am aufgeklappten Items-Bereich und wäre hier ggf. unsichtbar)
  const [runTaskId, setRunTaskId] = useState<string | null>(null);

  async function load() {
    setLoading(true);
    setError(null);
    try {
      const r = await client.fetchProjectDepsStatus(projectId);
      setDeps(r.deps);
      setManifest(r.manifest);
      setError(r.error ?? null);
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    // Projekt-Wechsel: Zustand zurücksetzen
    setDeps(null); setManifest(null); setError(null); setExpanded(false); setSelected(new Set());
  }, [projectId]);

  useEffect(() => {
    if (expanded && deps === null && !loading) void load();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [expanded]);

  function toggle(name: string) {
    setSelected(prev => { const n = new Set(prev); if (n.has(name)) n.delete(name); else n.add(name); return n; });
  }

  async function startUpdate() {
    if (starting) return;
    const pkgs = selected.size > 0 ? [...selected] : undefined;
    const what = pkgs ? `${pkgs.length} ausgewählte Pakete` : `alle ${deps?.length ?? 0} veralteten Pakete`;
    if (!confirm(
      `Dependency-Update-Lauf für ${what} starten?\n\n` +
      `Ein Code-Agent aktualisiert konservativ (bevorzugt innerhalb der Semver-Range), führt Install + Build/Tests aus und committet. ` +
      `Push erfolgt automatisch. Dauert einige Minuten, nutzt die CLI-Subscription.`,
    )) return;
    setStarting(true);
    try {
      const r = await client.projectUpdateDeps(projectId, pkgs);
      if (r.ok && r.liveTaskId) {
        setSelected(new Set());
        setRunTaskId(r.liveTaskId);
        notify('info', '📦 Dependency-Update gestartet — Live-Output im Panel, Telegram-Meldung am Ende.');
      } else {
        notify('error', `Start fehlgeschlagen: ${r.reason ?? 'unbekannt'}`);
      }
    } catch (e) {
      notify('error', e instanceof Error ? e.message : String(e));
    } finally {
      setStarting(false);
    }
  }

  if (!expanded) {
    return (
      <div className="pt-2 border-t border-[#222]">
        <button onClick={() => setExpanded(true)} className="text-xs text-gray-400 hover:text-gray-200 flex items-center gap-1.5">
          <span>📦</span>
          <span>Dependencies anzeigen</span>
        </button>
      </div>
    );
  }

  return (
    <div className="pt-2 border-t border-[#222]">
      <div className="flex items-center justify-between mb-2">
        <h3 className="text-xs font-semibold text-gray-300 flex items-center gap-1.5">
          <span>📦</span>
          <span>Dependencies{deps !== null ? ` — ${deps.length} veraltet` : ''}</span>
        </h3>
        <div className="flex items-center gap-2">
          <button onClick={() => void load()} disabled={loading} className="text-[10px] text-cyan-400 hover:underline disabled:opacity-60">
            {loading ? '⏳…' : 'aktualisieren'}
          </button>
          <button onClick={() => setExpanded(false)} className="text-[10px] text-gray-500 hover:text-gray-300">schließen</button>
        </div>
      </div>

      {/* Live-Output des Update-Laufs (SSE) — nach Ende Outdated-Liste neu laden */}
      {runTaskId && (
        <CodeRunLivePanel
          client={client}
          taskId={runTaskId}
          onEnded={() => { void load(); }}
          onClose={() => setRunTaskId(null)}
        />
      )}

      {error && <div className="text-xs text-red-400 mb-2">✗ {error}</div>}
      {loading && deps === null && <div className="text-xs text-gray-600">Prüfe Dependencies (npm outdated)…</div>}
      {!loading && deps !== null && manifest === null && !error && (
        <div className="text-xs text-gray-600">Kein erkanntes Dependency-Manifest (aktuell nur Node/package.json).</div>
      )}
      {deps !== null && manifest !== null && deps.length === 0 && !error && (
        <div className="text-xs text-emerald-400">✓ Alle direkten Dependencies aktuell.</div>
      )}

      {deps !== null && deps.length > 0 && (
        <>
          <table className="w-full text-[11px] mb-2">
            <thead>
              <tr className="text-gray-500 text-left">
                <th className="w-6 py-1"></th>
                <th className="py-1">Paket</th>
                <th className="py-1">installiert</th>
                <th className="py-1">wanted</th>
                <th className="py-1">latest</th>
              </tr>
            </thead>
            <tbody>
              {deps.map(d => {
                const majorJump = d.current && d.latest && d.current.split('.')[0] !== d.latest.split('.')[0];
                return (
                  <tr key={d.name} className={`border-t border-[#1a1a1a] ${selected.has(d.name) ? 'bg-blue-500/10' : ''}`}>
                    <td className="py-1">
                      <input type="checkbox" checked={selected.has(d.name)} onChange={() => toggle(d.name)} />
                    </td>
                    <td className="py-1 font-mono text-gray-300">{d.name}{d.type && d.type !== 'dependencies' ? <span className="text-gray-600 ml-1">({d.type})</span> : null}</td>
                    <td className="py-1 font-mono text-gray-500">{d.current ?? '—'}</td>
                    <td className="py-1 font-mono text-amber-300">{d.wanted ?? '—'}</td>
                    <td className={`py-1 font-mono ${majorJump ? 'text-red-400' : 'text-gray-400'}`} title={majorJump ? 'Major-Sprung — potenziell Breaking' : undefined}>
                      {d.latest ?? '—'}{majorJump ? ' ⚠' : ''}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
          <div className="flex items-center gap-2">
            <button
              onClick={() => void startUpdate()}
              disabled={starting}
              className="px-2 py-1 text-[11px] bg-emerald-600 hover:bg-emerald-500 disabled:opacity-50 text-white rounded"
              title="Code-Agent aktualisiert konservativ, verifiziert per Install + Build/Tests, committet und pusht"
            >{starting ? '⏳ Starte…' : `🔄 Update-Lauf starten${selected.size > 0 ? ` (${selected.size} Pakete)` : ' (alle)'}`}</button>
            {selected.size > 0 && (
              <button onClick={() => setSelected(new Set())} className="text-[10px] text-gray-500 hover:text-gray-300">Auswahl aufheben</button>
            )}
            <span className="text-[10px] text-gray-600">⚠ = Major-Sprung (nur mit grünem Build/Test übernommen)</span>
          </div>
        </>
      )}
    </div>
  );
}
