'use client';

import { useEffect, useState, useCallback } from 'react';
import { useConfig } from '@/context/ConfigContext';
import type { AutomationTemplate, ProjectAutomation } from '@/lib/alfred-client';

interface Props {
  projectId: string;
  projectName: string;
}

const DESTINATIONS = [
  { value: 'telegram', label: '✈️ Telegram' },
  { value: 'project_chat', label: '💬 Projekt-Chat' },
  { value: 'email', label: '📧 Email (TODO)' },
  { value: 'web_notification', label: '🔔 Web' },
];

function formatRelative(iso?: string): string {
  if (!iso) return '—';
  const ms = new Date(iso).getTime() - Date.now();
  const abs = Math.abs(ms);
  const sec = Math.floor(abs / 1000);
  const prefix = ms > 0 ? 'in ' : 'vor ';
  if (sec < 60) return `${prefix}${sec}s`;
  if (sec < 3600) return `${prefix}${Math.floor(sec / 60)}m`;
  if (sec < 86400) return `${prefix}${Math.floor(sec / 3600)}h`;
  return `${prefix}${Math.floor(sec / 86400)}d`;
}

/**
 * v663b — Project Automations View
 * Liste der konfigurierten Automations pro Projekt + Add-Modal mit Template-Picker
 */
export function ProjectAutomationsView({ projectId, projectName }: Props) {
  const { client } = useConfig();
  const [expanded, setExpanded] = useState(false);
  const [automations, setAutomations] = useState<ProjectAutomation[]>([]);
  const [templates, setTemplates] = useState<AutomationTemplate[]>([]);
  const [loading, setLoading] = useState(false);
  const [showAdd, setShowAdd] = useState(false);
  const [runningId, setRunningId] = useState<string | null>(null);
  const [resultModal, setResultModal] = useState<{ output: string; title: string } | null>(null);

  const load = useCallback(async () => {
    if (!client) return;
    setLoading(true);
    try {
      const [autos, tmpls] = await Promise.all([
        client.fetchProjectAutomations(projectId),
        client.fetchAutomationTemplates(),
      ]);
      setAutomations(autos);
      setTemplates(tmpls);
    } finally { setLoading(false); }
  }, [client, projectId]);

  useEffect(() => { if (expanded) load(); }, [expanded, load]);

  async function toggleEnabled(a: ProjectAutomation) {
    if (!client) return;
    await client.updateProjectAutomation(a.id, { enabled: !a.enabled });
    await load();
  }
  async function remove(a: ProjectAutomation) {
    if (!client) return;
    if (!confirm(`Automation "${a.name}" wirklich löschen?`)) return;
    await client.deleteProjectAutomation(a.id);
    await load();
  }
  async function runNow(a: ProjectAutomation) {
    if (!client) return;
    setRunningId(a.id);
    try {
      const r = await client.runProjectAutomation(a.id);
      if (r.ok && r.output) {
        setResultModal({ output: r.output, title: `${a.name} — Result` });
      } else if (!r.ok) {
        alert(`Fehler: ${r.error}`);
      }
      await load();
    } finally { setRunningId(null); }
  }

  if (!expanded) {
    return (
      <div className="pt-2 border-t border-[#222]">
        <button onClick={() => setExpanded(true)} className="w-full text-left flex items-center gap-2 text-sm font-semibold text-gray-400 hover:text-gray-200">
          <span>▸</span>
          <span>🤖 Automations</span>
          {automations.length > 0
            ? <span className="text-[10px] text-emerald-400 font-normal">{automations.filter(a => a.enabled).length}/{automations.length} aktiv</span>
            : <span className="text-[10px] text-gray-600 font-normal">— {templates.length > 0 ? `${templates.length} Templates verfügbar` : 'Templates beim Aufklappen laden'}</span>}
        </button>
      </div>
    );
  }

  return (
    <div className="pt-2 border-t border-[#222]">
      <div className="flex items-center justify-between mb-2">
        <button onClick={() => setExpanded(false)} className="flex items-center gap-2 text-sm font-semibold text-gray-400 hover:text-gray-200">
          <span>▾</span>
          <span>🤖 Automations — {projectName}</span>
        </button>
        <div className="flex gap-1.5">
          <button onClick={() => setShowAdd(true)} className="text-[10px] px-2 py-0.5 bg-blue-600 hover:bg-blue-500 text-white rounded">+ Add</button>
          <button onClick={load} disabled={loading} className="text-[10px] text-gray-500 hover:text-blue-400 px-2 py-0.5 rounded border border-[#1f1f1f]">↻</button>
        </div>
      </div>

      {loading && <div className="text-xs text-gray-500 italic">Lade…</div>}
      {!loading && automations.length === 0 && (
        <div className="text-xs text-gray-600 italic bg-[#0f0f0f] border border-dashed border-[#222] rounded p-3 text-center">
          Keine Automations konfiguriert. Klick „+ Add" um aus {templates.length > 0 ? `${templates.length} Templates` : 'den verfügbaren Templates'} zu wählen
          (Standup, Code-Review, Release-Pflege, Security-Audit, …).
        </div>
      )}

      <div className="space-y-1.5">
        {automations.map(a => {
          const tmpl = templates.find(t => t.kind === a.templateKind);
          return (
            <div key={a.id} className={`bg-[#0f0f0f] border rounded p-2 ${a.enabled ? 'border-[#222]' : 'border-[#222] opacity-60'}`}>
              <div className="flex items-start gap-2">
                <span className="text-base mt-0.5">{tmpl?.icon ?? '✨'}</span>
                <div className="flex-1 min-w-0">
                  <div className="flex items-center gap-2 flex-wrap">
                    <span className="text-sm font-medium text-gray-200">{a.name}</span>
                    <span className="text-[10px] text-gray-500 font-mono">{a.templateKind}</span>
                    {a.lastRunStatus === 'success' && <span className="text-[10px] text-emerald-400">✓ {formatRelative(a.lastRunAt)}</span>}
                    {a.lastRunStatus === 'failed' && <span className="text-[10px] text-red-400">✕ {formatRelative(a.lastRunAt)}</span>}
                  </div>
                  <div className="flex items-center gap-2 text-[10px] text-gray-500 mt-0.5 flex-wrap">
                    <span>📅 {a.schedule === 'manual' || !a.schedule ? 'manuell' : a.schedule}</span>
                    {a.nextRunAt && a.enabled && <span className="text-blue-400">⏭ {formatRelative(a.nextRunAt)}</span>}
                    <span>→ {DESTINATIONS.find(d => d.value === a.outputDestination)?.label ?? a.outputDestination}</span>
                  </div>
                </div>
                <div className="flex gap-1">
                  <button
                    onClick={() => runNow(a)}
                    disabled={runningId === a.id}
                    title="Jetzt ausführen"
                    className="text-[10px] px-2 py-0.5 bg-emerald-600/20 border border-emerald-500/40 text-emerald-300 rounded hover:bg-emerald-600/40 disabled:opacity-40"
                  >{runningId === a.id ? '⏳' : '▶'}</button>
                  <button onClick={() => toggleEnabled(a)} title={a.enabled ? 'Deaktivieren' : 'Aktivieren'} className="text-[10px] px-2 py-0.5 border border-[#2a2a2a] text-gray-400 hover:text-gray-200 rounded">
                    {a.enabled ? '⏸' : '▷'}
                  </button>
                  <button onClick={() => remove(a)} title="Löschen" className="text-[10px] px-2 py-0.5 border border-red-500/30 text-red-400 hover:bg-red-500/10 rounded">✕</button>
                </div>
              </div>
              {a.lastRunOutput && a.lastRunStatus === 'success' && (
                <details className="mt-1 ml-7">
                  <summary className="text-[10px] text-gray-500 cursor-pointer hover:text-gray-300">Last Output</summary>
                  <div className="mt-1 text-[11px] text-gray-300 whitespace-pre-wrap bg-black/40 rounded p-2 max-h-40 overflow-y-auto">{a.lastRunOutput}</div>
                </details>
              )}
            </div>
          );
        })}
      </div>

      {showAdd && <AddAutomationModal
        projectId={projectId}
        templates={templates}
        onClose={() => setShowAdd(false)}
        onAdded={() => { setShowAdd(false); load(); }}
      />}
      {resultModal && (
        <div className="fixed inset-0 bg-black/60 flex items-center justify-center z-50 p-4" onClick={() => setResultModal(null)}>
          <div className="bg-[#111] border border-[#2a2a2a] rounded-lg p-4 max-w-3xl w-full max-h-[80vh] overflow-hidden flex flex-col" onClick={(e) => e.stopPropagation()}>
            <div className="flex items-center justify-between mb-2">
              <h3 className="text-sm font-semibold text-gray-100">{resultModal.title}</h3>
              <button onClick={() => setResultModal(null)} className="text-gray-500 hover:text-red-400">✕</button>
            </div>
            <div className="flex-1 overflow-y-auto text-xs text-gray-200 whitespace-pre-wrap font-mono bg-black/40 rounded p-3">{resultModal.output}</div>
          </div>
        </div>
      )}
    </div>
  );
}

function AddAutomationModal({ projectId, templates: initialTemplates, onClose, onAdded }: {
  projectId: string;
  templates: AutomationTemplate[];
  onClose: () => void;
  onAdded: () => void;
}) {
  const { client } = useConfig();
  const [picked, setPicked] = useState<AutomationTemplate | null>(null);
  const [name, setName] = useState('');
  const [schedule, setSchedule] = useState('');
  const [prompt, setPrompt] = useState('');
  const [destination, setDestination] = useState('telegram');
  const [saving, setSaving] = useState(false);
  // v668 — Modal lädt Templates selbst nochmal nach. Falls die Parent-Liste
  // zum Modal-Open-Zeitpunkt noch leer war (Race-Condition oder Endpoint-Fehler),
  // ist hier ein expliziter Loading-State + Retry-Button.
  const [templates, setTemplates] = useState<AutomationTemplate[]>(initialTemplates);
  const [loadingTemplates, setLoadingTemplates] = useState(false);
  const [loadError, setLoadError] = useState<string | null>(null);

  const reloadTemplates = useCallback(async () => {
    if (!client) return;
    setLoadingTemplates(true);
    setLoadError(null);
    try {
      const t = await client.fetchAutomationTemplates();
      setTemplates(t);
      if (t.length === 0) setLoadError('Backend lieferte 0 Templates. Pruefe ob die Automations-Engine im Server verwired ist.');
    } catch (err) {
      setLoadError((err as Error).message ?? 'Templates konnten nicht geladen werden.');
    } finally { setLoadingTemplates(false); }
  }, [client]);

  useEffect(() => {
    if (templates.length === 0) reloadTemplates();
  }, [templates.length, reloadTemplates]);

  function pick(t: AutomationTemplate) {
    setPicked(t);
    setName(t.label);
    setSchedule(t.defaultSchedule);
    setPrompt(t.defaultPrompt);
  }

  async function save() {
    if (!client || !picked) return;
    setSaving(true);
    try {
      const r = await client.addProjectAutomation(projectId, {
        name,
        templateKind: picked.kind,
        schedule: schedule === 'manual' || !schedule.trim() ? undefined : schedule.trim(),
        promptOverride: prompt.trim() !== picked.defaultPrompt.trim() ? prompt.trim() : undefined,
        outputDestination: destination as 'telegram' | 'project_chat' | 'email' | 'web_notification',
        enabled: true,
      });
      if (r) onAdded();
    } finally { setSaving(false); }
  }

  return (
    <div className="fixed inset-0 bg-black/60 flex items-center justify-center z-50 p-4" onClick={onClose}>
      <div className="bg-[#111] border border-[#2a2a2a] rounded-lg p-4 max-w-3xl w-full max-h-[90vh] overflow-y-auto" onClick={(e) => e.stopPropagation()}>
        <div className="flex items-center justify-between mb-3">
          <h3 className="text-lg font-semibold text-gray-100">🤖 Automation hinzufügen</h3>
          <button onClick={onClose} className="text-gray-500 hover:text-red-400">✕</button>
        </div>

        {!picked && (
          <div>
            <div className="flex items-center justify-between mb-2">
              <div className="text-[10px] uppercase tracking-wider text-gray-500">
                {loadingTemplates ? 'Lade Templates…' : `${templates.length} ${templates.length === 1 ? 'Template' : 'Templates'} verfügbar`}
              </div>
              <button
                onClick={reloadTemplates}
                disabled={loadingTemplates}
                title="Templates neu laden"
                className="text-[10px] text-gray-500 hover:text-blue-400 disabled:opacity-40"
              >↻ Neu laden</button>
            </div>
            {/* v668 — Loading / Empty / Error States damit der User weiss was passiert */}
            {loadingTemplates && (
              <div className="text-xs text-gray-500 italic bg-[#0f0f0f] border border-dashed border-[#222] rounded p-6 text-center animate-pulse">
                ⏳ Lade Automation-Templates vom Backend…
              </div>
            )}
            {!loadingTemplates && templates.length === 0 && (
              <div className="text-xs text-amber-300 bg-amber-500/5 border border-amber-500/30 rounded p-4 text-center space-y-2">
                <div className="font-semibold">⚠️ Keine Templates verfügbar</div>
                {loadError && <div className="text-amber-300/80 font-mono text-[11px]">{loadError}</div>}
                <div className="text-gray-500 text-[11px]">
                  Mögliche Ursachen: Server-Version &lt; v663b · automation-engine nicht initialisiert · Auth-Header fehlt.
                </div>
                <button onClick={reloadTemplates} className="text-blue-400 hover:text-blue-300 underline text-[11px]">Erneut versuchen</button>
              </div>
            )}
            {!loadingTemplates && templates.length > 0 && (
              <div className="grid grid-cols-2 gap-1.5 max-h-[60vh] overflow-y-auto">
                {templates.map(t => (
                  <button key={t.kind} onClick={() => pick(t)} className="text-left bg-[#0d0d0d] border border-[#2a2a2a] rounded p-2 hover:border-blue-500/60 transition-colors">
                    <div className="flex items-center gap-1.5">
                      <span>{t.icon}</span>
                      <span className="text-xs font-medium text-gray-200">{t.label}</span>
                    </div>
                    <div className="text-[10px] text-gray-500 mt-0.5">{t.description}</div>
                    <div className="text-[10px] text-gray-600 mt-0.5 font-mono">{t.defaultSchedule === 'manual' ? 'nur manuell' : `cron: ${t.defaultSchedule}`}</div>
                  </button>
                ))}
              </div>
            )}
          </div>
        )}

        {picked && (
          <div className="space-y-3">
            <button onClick={() => setPicked(null)} className="text-[10px] text-gray-500 hover:text-blue-400">← Anderes Template</button>
            <div className="text-base text-gray-100 flex items-center gap-2">{picked.icon} {picked.label}</div>
            <div>
              <label className="text-[10px] uppercase tracking-wider text-gray-500 mb-0.5 block">Name</label>
              <input value={name} onChange={(e) => setName(e.target.value)} className="w-full bg-[#0d0d0d] border border-[#2a2a2a] rounded px-2 py-1.5 text-xs text-gray-200" />
            </div>
            <div className="grid grid-cols-2 gap-2">
              <div>
                <label className="text-[10px] uppercase tracking-wider text-gray-500 mb-0.5 block">Schedule (cron oder „manual")</label>
                <input value={schedule} onChange={(e) => setSchedule(e.target.value)} placeholder="0 8 * * *" className="w-full bg-[#0d0d0d] border border-[#2a2a2a] rounded px-2 py-1.5 text-xs text-gray-200 font-mono" />
                <div className="text-[10px] text-gray-600 mt-0.5">Default: <code>{picked.defaultSchedule}</code></div>
              </div>
              <div>
                <label className="text-[10px] uppercase tracking-wider text-gray-500 mb-0.5 block">Output-Ziel</label>
                <select value={destination} onChange={(e) => setDestination(e.target.value)} className="w-full bg-[#0d0d0d] border border-[#2a2a2a] rounded px-2 py-1.5 text-xs text-gray-200">
                  {DESTINATIONS.map(d => <option key={d.value} value={d.value}>{d.label}</option>)}
                </select>
              </div>
            </div>
            <div>
              <label className="text-[10px] uppercase tracking-wider text-gray-500 mb-0.5 block">Prompt (bearbeitbar)</label>
              <textarea value={prompt} onChange={(e) => setPrompt(e.target.value)} rows={6} className="w-full bg-[#0d0d0d] border border-[#2a2a2a] rounded px-2 py-1.5 text-xs text-gray-200 font-mono resize-y" />
            </div>
            <div className="flex justify-end gap-2 pt-2 border-t border-[#222]">
              <button onClick={onClose} className="px-3 py-1.5 text-xs text-gray-400 hover:text-gray-200 border border-[#2a2a2a] rounded">Abbrechen</button>
              <button onClick={save} disabled={saving || !name.trim()} className="px-3 py-1.5 text-xs bg-blue-600 hover:bg-blue-500 disabled:opacity-40 text-white rounded font-semibold">{saving ? '…' : 'Speichern'}</button>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
