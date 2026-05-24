'use client';

import { useEffect, useState } from 'react';
import { useConfig } from '@/context/ConfigContext';

interface Props {
  projectId: string;
  currentMax?: number;
  onUpdate?: (newMax: number | null) => void;
}

/**
 * v755 — Per-Project-Quota: maximale gleichzeitig aktive Sandboxes für dieses Projekt.
 * NULL/leer = nutzt globale User-Quota. Zeigt auch aktuelle Auslastung (active/limit).
 */
export function ProjectQuotaView({ projectId, currentMax, onUpdate }: Props) {
  const { client } = useConfig();
  const [expanded, setExpanded] = useState(false);
  const [value, setValue] = useState<string>(currentMax != null ? String(currentMax) : '');
  const [activeCount, setActiveCount] = useState<number | null>(null);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => { setValue(currentMax != null ? String(currentMax) : ''); }, [currentMax]);

  useEffect(() => {
    if (!expanded || !client) return;
    let cancelled = false;
    (async () => {
      try {
        const list = await client.listSandboxes({ projectId });
        if (cancelled) return;
        const active = list.filter(s => s.status === 'creating' || s.status === 'running' || s.status === 'paused').length;
        setActiveCount(active);
      } catch { /* */ }
    })();
    return () => { cancelled = true; };
  }, [expanded, client, projectId]);

  async function handleSave() {
    if (!client) return;
    const parsed = value.trim() === '' ? null : Number(value);
    if (parsed !== null && (!Number.isFinite(parsed) || parsed < 0 || parsed > 999)) {
      setError('Muss leer oder eine Zahl 0..999 sein');
      return;
    }
    setSaving(true); setError(null);
    try {
      const updated = await client.updateProject(projectId, { maxConcurrentSandboxes: parsed });
      if (!updated) { setError('Update fehlgeschlagen'); return; }
      onUpdate?.(parsed);
    } finally { setSaving(false); }
  }

  const reaching = activeCount != null && currentMax != null && activeCount >= currentMax;

  return (
    <div className="pt-2 border-t border-[#222]">
      <button
        onClick={() => setExpanded(e => !e)}
        className="w-full flex items-center justify-between text-sm font-semibold text-gray-400 hover:text-gray-200 mb-2"
      >
        <span>
          ⚖️ Sandbox-Quota{currentMax != null ? ` (${currentMax})` : ' (global)'}
          {activeCount != null && currentMax != null && (
            <span className={`ml-2 text-[10px] ${reaching ? 'text-amber-400' : 'text-gray-500'}`}>
              {activeCount}/{currentMax} aktiv
            </span>
          )}
        </span>
        <span className="text-xs">{expanded ? '▼' : '▶'}</span>
      </button>
      {expanded && (
        <div className="space-y-3 text-xs">
          {error && <div className="bg-red-500/10 border border-red-500/30 text-red-400 px-2 py-1 rounded">{error}</div>}
          <div className="text-[10px] text-gray-500">
            Maximum gleichzeitig aktive (creating/running/paused) Sandboxes für dieses Projekt. Leer = nur globale User-Quota gilt.
            {activeCount != null && (
              <> Aktuell aktiv: <span className="text-gray-300 font-semibold">{activeCount}</span></>
            )}
          </div>
          <div className="flex items-center gap-2">
            <input
              type="number" min={0} max={999} value={value} onChange={e => setValue(e.target.value)}
              placeholder="z.B. 2 — leer = global"
              className="w-32 bg-[#0a0a0a] border border-[#1a1a1a] rounded px-2 py-1 text-[11px] text-gray-200"
            />
            <button onClick={handleSave} disabled={saving} className="px-3 py-1 bg-blue-600 hover:bg-blue-500 disabled:opacity-50 text-white rounded text-[11px]">
              {saving ? '⏳…' : 'Speichern'}
            </button>
            {currentMax != null && (
              <button
                onClick={() => { setValue(''); }}
                className="px-2 py-1 border border-gray-600 text-gray-400 hover:bg-gray-700/40 rounded text-[11px]"
                title="Auf User-Quota zurücksetzen (leer machen)"
              >Reset</button>
            )}
          </div>
          {reaching && (
            <div className="bg-amber-500/10 border border-amber-500/30 text-amber-300 px-2 py-1 rounded text-[10px]">
              ⚠️ Quota erreicht — neue Sandboxes für dieses Projekt werden abgelehnt bis eine pausiert/verworfen wird.
            </div>
          )}
        </div>
      )}
    </div>
  );
}
