'use client';

import { useEffect, useState, useCallback } from 'react';
import { useConfig } from '@/context/ConfigContext';
import type { ProjectFeatureDto } from '@/lib/alfred-client';

interface Props {
  projectId: string;
}

/**
 * v851 — Project-Features-View. Zeigt die Feature-Library für ein Projekt.
 *
 * Tabs:
 *  - Confirmed: aktive features (auto-extracted mit hoher confidence + manuell)
 *  - Pending: auto-extracted mit confidence 0.4-0.7 — User bestätigt/lehnt ab
 *  - Rejected: vom User abgelehnt (für Audit)
 *
 * Pro Feature:
 *  - Name + Description + Tech-Stack-Tags
 *  - Visibility-Toggle (private/role-shared/global)
 *  - Source-Files-Liste
 *  - Confidence-Score (für auto)
 *  - Retire-Button
 */
export function ProjectFeaturesView({ projectId }: Props) {
  const { client } = useConfig();
  const [features, setFeatures] = useState<ProjectFeatureDto[]>([]);
  const [tab, setTab] = useState<'confirmed' | 'pending' | 'rejected'>('confirmed');
  const [loading, setLoading] = useState(false);
  const [expanded, setExpanded] = useState(false);

  const load = useCallback(async () => {
    if (!client) return;
    setLoading(true);
    try {
      const list = await client.fetchProjectFeatures(projectId, tab);
      setFeatures(list);
    } finally { setLoading(false); }
  }, [client, projectId, tab]);

  useEffect(() => { if (expanded) load(); }, [expanded, load]);

  async function changeVisibility(f: ProjectFeatureDto, v: 'private' | 'role-shared' | 'global') {
    if (!client) return;
    await client.setFeatureVisibility(f.id, v);
    load();
  }
  async function confirmOrReject(f: ProjectFeatureDto, action: 'confirm' | 'reject') {
    if (!client) return;
    await client.confirmFeature(f.id, action);
    load();
  }
  // v898 — Pending-Vorschlag aus der Historie nachträglich in ein Feature überführen
  // (Plan-Lauf wie im Discovery-Modal) bzw. ablehnen.
  async function decidePending(f: ProjectFeatureDto, decision: 'accept' | 'reject') {
    if (!client) return;
    if (decision === 'accept' && !confirm(`Vorschlag „${f.name}" als Feature planen?\nEin Agent arbeitet den Umsetzungsplan aus und legt die Arbeitspakete in der Roadmap an.`)) return;
    const r = await client.projectFeatureDecision(projectId, { title: f.name, description: f.description, decision });
    if (!r.ok) { alert(`Fehler: ${r.reason}`); return; }
    if (decision === 'accept') alert(`🗺 Plan-Lauf gestartet für „${f.name}" — Arbeitspakete erscheinen anschließend in der Roadmap.`);
    load();
  }
  async function retire(f: ProjectFeatureDto) {
    if (!client) return;
    if (!confirm(`Feature "${f.name}" zurückziehen?`)) return;
    await client.retireFeature(f.id, 'user-retired');
    load();
  }

  if (!expanded) {
    return (
      <div className="pt-2 border-t border-[#222]">
        <button onClick={() => setExpanded(true)} className="text-xs text-gray-400 hover:text-gray-200 flex items-center gap-1.5">
          <span>🏗</span>
          <span>Features-Library anzeigen</span>
        </button>
      </div>
    );
  }

  const visBadge = (v: string) => ({
    'private': { color: 'text-gray-400 bg-gray-500/10', label: '🔒 privat' },
    'role-shared': { color: 'text-emerald-300 bg-emerald-500/10', label: '👥 role-shared' },
    'global': { color: 'text-blue-300 bg-blue-500/10', label: '🌐 global' },
  })[v] ?? { color: 'text-gray-400 bg-gray-500/10', label: v };

  return (
    <div className="pt-2 border-t border-[#222]">
      <div className="flex items-center justify-between mb-2">
        <h3 className="text-xs font-semibold text-gray-300 flex items-center gap-1.5">
          <span>🏗</span>
          <span>Features-Library ({features.length})</span>
        </h3>
        <button onClick={() => setExpanded(false)} className="text-[10px] text-gray-500 hover:text-gray-300">schließen</button>
      </div>

      <div className="flex gap-1 mb-2 text-[10px]">
        {(['confirmed', 'pending', 'rejected'] as const).map(t => (
          <button
            key={t}
            onClick={() => setTab(t)}
            className={`px-2 py-1 rounded ${tab === t ? 'bg-blue-500/20 border border-blue-500/50 text-blue-300' : 'border border-[#222] text-gray-400 hover:border-[#333]'}`}
          >
            {t === 'confirmed' && '✓ bestätigt'}
            {t === 'pending' && '⏳ ausstehend'}
            {t === 'rejected' && '✗ abgelehnt'}
          </button>
        ))}
      </div>

      {loading && <div className="text-[10px] text-gray-500 italic">lade…</div>}
      {!loading && features.length === 0 && (
        <div className="text-[10px] text-gray-600 italic">
          {tab === 'confirmed' && 'Keine bestätigten Features. Werden beim nächsten erfolgreichen Project-Agent-Run automatisch erkannt.'}
          {tab === 'pending' && 'Keine Features warten auf Bestätigung.'}
          {tab === 'rejected' && 'Keine abgelehnten Features.'}
        </div>
      )}

      <div className="space-y-1.5">
        {features.map(f => {
          const v = visBadge(f.visibility);
          return (
            <div key={f.id} className="border border-[#222] bg-[#0a0a0a] rounded p-2 text-[11px] space-y-1">
              <div className="flex items-center gap-2 flex-wrap">
                <span className="font-medium text-gray-200 flex-1">{f.name}</span>
                <span className={`text-[9px] px-1.5 py-0.5 rounded ${v.color}`}>{v.label}</span>
                <span className="text-[9px] text-gray-500">v{f.version}</span>
                {f.source === 'auto' && (
                  <span className="text-[9px] text-amber-300/70">conf={Math.round(f.confidence * 100)}%</span>
                )}
              </div>
              {f.description && <div className="text-[10px] text-gray-400">{f.description}</div>}
              {f.plannedMilestone && (
                <div className="text-[9px] text-emerald-300/80">→ übernommen in <span className="font-medium">{f.plannedMilestone}</span></div>
              )}
              {f.techStack.length > 0 && (
                <div className="flex gap-1 flex-wrap">
                  {f.techStack.slice(0, 6).map(t => (
                    <span key={t} className="text-[9px] bg-blue-500/10 text-blue-300/80 px-1.5 py-0.5 rounded">{t}</span>
                  ))}
                </div>
              )}
              {f.sourceFiles.length > 0 && (
                <details className="text-[10px] text-gray-500">
                  <summary className="cursor-pointer hover:text-gray-300">{f.sourceFiles.length} source paths</summary>
                  <div className="font-mono pl-3 mt-0.5">
                    {f.sourceFiles.slice(0, 20).map(p => <div key={p}>{p}</div>)}
                  </div>
                </details>
              )}
              <div className="flex gap-1 pt-1 border-t border-[#1a1a1a]">
                {tab === 'pending' && (
                  <>
                    <button onClick={() => decidePending(f, 'accept')} className="text-[10px] px-2 py-0.5 bg-emerald-500/15 text-emerald-300 rounded hover:bg-emerald-500/25">🗺 In Feature planen</button>
                    <button onClick={() => decidePending(f, 'reject')} className="text-[10px] px-2 py-0.5 bg-red-500/10 text-red-300 rounded hover:bg-red-500/20">✗ Ablehnen</button>
                  </>
                )}
                {tab === 'confirmed' && (
                  <>
                    <select
                      value={f.visibility}
                      onChange={e => changeVisibility(f, e.target.value as 'private' | 'role-shared' | 'global')}
                      className="text-[10px] bg-[#0a0a0a] border border-[#222] rounded px-1.5 py-0.5"
                    >
                      <option value="private">🔒 privat</option>
                      <option value="role-shared">👥 role-shared</option>
                      <option value="global">🌐 global</option>
                    </select>
                    <button onClick={() => retire(f)} className="text-[10px] px-2 py-0.5 bg-red-500/10 text-red-300 rounded hover:bg-red-500/20">🗑 Retire</button>
                  </>
                )}
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
}
