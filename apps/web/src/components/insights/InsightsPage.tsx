'use client';

import { useEffect, useState, useCallback, useMemo } from 'react';
import clsx from 'clsx';
import { useConfig } from '@/context/ConfigContext';
import type { InsightItem } from '@/lib/alfred-client';

const CATEGORY_ICONS: Record<string, string> = {
  'infra-forecast': '📈',
  'calendar-mismatch': '📅',
  'kg-gap': '🧠',
  'cross-source-mention': '🔗',
  'open-loop': '💬',
  'goal-drift': '🎯',
  'skill-workflow': '⚙️',
  'finance': '💰',
  'meta': '🤖',
  'reasoning': '💭',
  'itsm-reflection': '🛠️',
  'automation': '🔁',
  'interests': '📡',
  'interest-suggestion': '📡',
  'social': '📣',
  'social-approval': '📤',
};

const CATEGORY_LABEL: Record<string, string> = {
  'infra-forecast': 'Infrastruktur',
  'calendar-mismatch': 'Kalender',
  'kg-gap': 'Knowledge-Graph',
  'cross-source-mention': 'Quervergleich',
  'open-loop': 'Offene Themen',
  'goal-drift': 'Ziele',
  'skill-workflow': 'Workflows',
  'finance': 'Finanzen',
  'meta': 'Alfred-Meta',
  'reasoning': 'Beobachtungen (still)',
  'itsm-reflection': 'ITSM-Reflexion',
  'automation': 'Automationen',
  'interests': 'Interessen-Digest',
  'interest-suggestion': 'Themen-Vorschläge',
  'social': 'Social-Media',
  'social-approval': 'Post-Freigaben',
};

// v928 — Fallback-Labels wenn ein Insight kein sprechendes actionLabel mitbringt.
// Vorher stand der rohe Skill-Name auf dem Button („▶ memory").
const SKILL_ACTION_LABEL: Record<string, string> = {
  memory: 'Ins Gedächtnis übernehmen',
  todo: 'Todo anlegen',
  watch: 'Watch anlegen',
  calendar: 'Termin anlegen',
  reminder: 'Erinnerung anlegen',
  itsm: 'ITSM-Aktion ausführen',
  homeassistant: 'Smart-Home-Aktion',
  briefing: 'Briefing abrufen',
};

interface InputFieldDef { key: string; label: string; type: 'date' | 'text' | 'number' }

function getInputFields(i: InsightItem): InputFieldDef[] {
  const raw = i.sourceData?.inputFields;
  if (!Array.isArray(raw)) return [];
  return raw
    .filter((f): f is Record<string, unknown> => !!f && typeof f === 'object' && typeof (f as any).key === 'string')
    .map(f => ({
      key: String(f.key),
      label: typeof f.label === 'string' ? f.label : String(f.key),
      type: f.type === 'date' || f.type === 'number' ? f.type : 'text',
    }));
}

function getActionLabel(i: InsightItem): string {
  const custom = i.sourceData?.actionLabel;
  if (typeof custom === 'string' && custom.length > 0) return custom;
  if (i.actionSkill && SKILL_ACTION_LABEL[i.actionSkill]) return SKILL_ACTION_LABEL[i.actionSkill];
  return i.actionSkill ? `Aktion: ${i.actionSkill}` : 'Aktion ausführen';
}

/** v927-Router-Einträge tragen ihre Dringlichkeit in sourceData. */
function getRouterUrgency(i: InsightItem): string | null {
  if (i.sourceData?.router !== true) return null;
  const u = i.sourceData?.urgency;
  return typeof u === 'string' ? u : null;
}

export function InsightsPage() {
  const { client } = useConfig();
  const [insights, setInsights] = useState<InsightItem[]>([]);
  const [stats, setStats] = useState<Record<string, number>>({});
  const [muted, setMuted] = useState<string[]>([]);
  const [filterCat, setFilterCat] = useState<string>('all');
  const [filterStatus, setFilterStatus] = useState<string>('pending');
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState<string | null>(null);
  const [sweeping, setSweeping] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [expandedIds, setExpandedIds] = useState<Set<string>>(new Set());
  const [collapsedGroups, setCollapsedGroups] = useState<Set<string>>(new Set());
  // v928 — geöffnetes Inline-Eingabeformular je Insight + Feldwerte
  const [inputOpenId, setInputOpenId] = useState<string | null>(null);
  const [inputValues, setInputValues] = useState<Record<string, string>>({});
  // v928 — Batch-Eingabemodus je Gruppe (kg-gap: Tabelle Person|Datum)
  const [batchGroup, setBatchGroup] = useState<string | null>(null);
  const [batchValues, setBatchValues] = useState<Record<string, string>>({});

  const load = useCallback(async () => {
    if (!client) return;
    setLoading(true); setError(null);
    try {
      const [list, s, m] = await Promise.all([
        client.fetchInsights({
          category: filterCat === 'all' ? undefined : filterCat,
          status: filterStatus,
          limit: 200,
        }),
        client.fetchInsightsStats().catch(() => ({})),
        client.fetchMutedInsightCategories().catch(() => []),
      ]);
      setInsights(list);
      setStats(s);
      setMuted(m);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally { setLoading(false); }
  }, [client, filterCat, filterStatus]);

  useEffect(() => { load(); }, [load]);

  // v928 — Gruppierung nach Kategorie (Reihenfolge: größte Gruppe zuerst)
  const groups = useMemo(() => {
    const map = new Map<string, InsightItem[]>();
    for (const i of insights) {
      const list = map.get(i.category) ?? [];
      list.push(i);
      map.set(i.category, list);
    }
    return [...map.entries()].sort((a, b) => b[1].length - a[1].length);
  }, [insights]);

  async function runSweep() {
    if (!client) return;
    setSweeping(true); setError(null);
    try {
      const r = await client.runInsightsSweep();
      alert(`Sweep abgeschlossen: ${r.inserted} neu, ${r.refreshed} aktualisiert.${r.errors.length ? '\n\nFehler:\n' + r.errors.join('\n') : ''}`);
      await load();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally { setSweeping(false); }
  }

  async function dismissGroup(category: string, count: number) {
    if (!client) return;
    if (!confirm(`Alle ${count} offenen Insights in "${CATEGORY_LABEL[category] ?? category}" als erledigt markieren?`)) return;
    setBusy(`bulk-${category}`);
    try {
      const r = await client.dismissInsightsCategory(category);
      alert(`${r.dismissed} Insights als erledigt markiert.`);
      await load();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally { setBusy(null); }
  }

  // v928 — „Solche nicht mehr": Kategorie muten (keine neuen Kandidaten mehr)
  async function toggleMute(category: string) {
    if (!client) return;
    const isMuted = muted.includes(category);
    if (!isMuted && !confirm(`Kategorie "${CATEGORY_LABEL[category] ?? category}" stummschalten?\n\nAlfred erzeugt dann keine neuen Insights dieser Art mehr. Bestehende bleiben sichtbar.`)) return;
    setBusy(`mute-${category}`);
    try {
      await client.muteInsightCategory(category, !isMuted);
      setMuted(prev => isMuted ? prev.filter(c => c !== category) : [...prev, category]);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally { setBusy(null); }
  }

  async function handleDismiss(id: string) {
    if (!client) return;
    setBusy(id);
    try { await client.dismissInsight(id); await load(); }
    catch (e) { setError(e instanceof Error ? e.message : String(e)); }
    finally { setBusy(null); }
  }

  async function handleSnooze(id: string, hours: number) {
    if (!client) return;
    setBusy(id);
    try { await client.snoozeInsight(id, hours); await load(); }
    catch (e) { setError(e instanceof Error ? e.message : String(e)); }
    finally { setBusy(null); }
  }

  // v928 — Aktion ausführen; bei inputFields erst Formular öffnen, dann mit Werten senden
  async function handleAct(insight: InsightItem) {
    if (!client) return;
    const fields = getInputFields(insight);
    if (fields.length > 0 && inputOpenId !== insight.id) {
      setInputOpenId(insight.id);
      setInputValues({});
      return;
    }
    if (fields.length > 0) {
      const missing = fields.filter(f => !(inputValues[f.key] ?? '').trim());
      if (missing.length > 0) { alert(`Bitte ausfüllen: ${missing.map(f => f.label).join(', ')}`); return; }
    }
    setBusy(insight.id);
    try {
      const params = fields.length > 0 ? Object.fromEntries(fields.map(f => [f.key, inputValues[f.key]])) : undefined;
      const r = await client.actOnInsight(insight.id, params);
      if (r.ok) {
        setInputOpenId(null); setInputValues({});
        await load();
      } else {
        alert(`Fehler: ${r.reason}`);
      }
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally { setBusy(null); }
  }

  // v928 — Batch: alle ausgefüllten Zeilen einer Gruppe nacheinander ausführen
  async function handleBatchSubmit(items: InsightItem[]) {
    if (!client) return;
    const filled = items.filter(i => {
      const f = getInputFields(i)[0];
      return f && (batchValues[i.id] ?? '').trim().length > 0;
    });
    if (filled.length === 0) { alert('Keine Eingaben ausgefüllt.'); return; }
    setBusy('batch');
    let ok = 0; const errs: string[] = [];
    for (const i of filled) {
      const f = getInputFields(i)[0];
      try {
        const r = await client.actOnInsight(i.id, { [f.key]: batchValues[i.id].trim() });
        if (r.ok) ok++; else errs.push(`${i.title}: ${r.reason}`);
      } catch (e) {
        errs.push(`${i.title}: ${e instanceof Error ? e.message : String(e)}`);
      }
    }
    setBusy(null);
    alert(`${ok} von ${filled.length} übernommen.${errs.length ? '\n\nFehler:\n' + errs.join('\n') : ''}`);
    setBatchGroup(null); setBatchValues({});
    await load();
  }

  function discussHref(i: InsightItem): string {
    const draft = `Ich möchte dieses Insight besprechen:\n\n**${i.title}**\n${i.body.slice(0, 600)}`;
    return `/chat?draft=${encodeURIComponent(draft)}`;
  }

  function toggleExpand(id: string) {
    setExpandedIds(prev => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id); else next.add(id);
      return next;
    });
  }

  function toggleGroup(category: string) {
    setCollapsedGroups(prev => {
      const next = new Set(prev);
      if (next.has(category)) next.delete(category); else next.add(category);
      return next;
    });
  }

  const categories = ['all', ...Object.keys(CATEGORY_LABEL)];
  const statuses = ['pending', 'snoozed', 'acted', 'dismissed', 'expired'];

  function renderCard(i: InsightItem) {
    const conf = Math.round(i.confidence * 100);
    const flag = i.confidence >= 0.8 ? 'text-red-400 border-red-500/40 bg-red-500/5'
      : i.confidence >= 0.6 ? 'text-amber-400 border-amber-500/40 bg-amber-500/5'
      : 'text-emerald-400 border-emerald-500/40 bg-emerald-500/5';
    const isExpanded = expandedIds.has(i.id);
    const fields = getInputFields(i);
    const routerUrgency = getRouterUrgency(i);
    const inputOpen = inputOpenId === i.id;
    return (
      <div key={i.id} className={clsx('border rounded-lg p-4', flag)}>
        <div className="flex items-start gap-3">
          <div className="text-2xl">{CATEGORY_ICONS[i.category] ?? '💡'}</div>
          <div className="flex-1 min-w-0">
            <div className="flex items-center gap-2 flex-wrap text-[10px] uppercase tracking-wide text-gray-500 mb-1">
              <span className="font-semibold">{CATEGORY_LABEL[i.category] ?? i.category}</span>
              <span>·</span>
              <span>Confidence {conf}%</span>
              {routerUrgency && (
                <><span>·</span><span className="text-purple-400">still abgelegt ({routerUrgency})</span></>
              )}
              {i.status === 'snoozed' && i.snoozedUntil && (
                <><span>·</span><span>snoozed bis {i.snoozedUntil.slice(0, 16)}</span></>
              )}
              <span>·</span>
              <span className="font-mono normal-case">{i.id.slice(0, 8)}</span>
            </div>
            <h3 className="text-base font-semibold text-gray-100 mb-2">{i.title}</h3>
            <div className={clsx('text-sm text-gray-300 whitespace-pre-wrap break-words', !isExpanded && 'line-clamp-3')}>
              {i.body}
            </div>
            {i.body.length > 200 && (
              <button
                onClick={() => toggleExpand(i.id)}
                className="text-xs text-blue-400 hover:text-blue-300 mt-1"
              >{isExpanded ? '▲ einklappen' : '▼ mehr anzeigen'}</button>
            )}
            {/* v928 — Inline-Eingabefelder (z.B. Geburtstag) */}
            {inputOpen && fields.length > 0 && (
              <div className="mt-3 p-3 bg-black/30 border border-[#2a2a2a] rounded space-y-2">
                {fields.map(f => (
                  <label key={f.key} className="block text-xs text-gray-400">
                    {f.label}
                    <input
                      type={f.type}
                      value={inputValues[f.key] ?? ''}
                      onChange={e => setInputValues(v => ({ ...v, [f.key]: e.target.value }))}
                      className="mt-1 w-full max-w-xs block bg-[#0a0a0a] border border-[#2a2a2a] rounded px-2 py-1.5 text-sm text-gray-200"
                    />
                  </label>
                ))}
              </div>
            )}
            <div className="flex items-center gap-2 mt-3 flex-wrap">
              {i.actionSkill && i.status === 'pending' && (
                <button
                  onClick={() => handleAct(i)}
                  disabled={busy === i.id}
                  className="px-2 py-1 text-xs bg-blue-600 hover:bg-blue-500 disabled:opacity-50 text-white rounded"
                >{inputOpen ? '✓ Übernehmen' : `▶ ${getActionLabel(i)}`}</button>
              )}
              {inputOpen && (
                <button
                  onClick={() => { setInputOpenId(null); setInputValues({}); }}
                  className="px-2 py-1 text-xs border border-gray-500/40 text-gray-400 hover:bg-gray-500/15 rounded"
                >Abbrechen</button>
              )}
              <a
                href={discussHref(i)}
                className="px-2 py-1 text-xs border border-blue-500/30 text-blue-400 hover:bg-blue-500/15 rounded"
              >💬 Mit Alfred besprechen</a>
              {i.status === 'pending' && (
                <>
                  <button
                    onClick={() => handleSnooze(i.id, 24)}
                    disabled={busy === i.id}
                    className="px-2 py-1 text-xs border border-gray-500/40 text-gray-400 hover:bg-gray-500/15 rounded"
                  >💤 24h</button>
                  <button
                    onClick={() => handleSnooze(i.id, 168)}
                    disabled={busy === i.id}
                    className="px-2 py-1 text-xs border border-gray-500/40 text-gray-400 hover:bg-gray-500/15 rounded"
                  >💤 7 Tage</button>
                </>
              )}
              {(i.status === 'pending' || i.status === 'snoozed') && (
                <button
                  onClick={() => handleDismiss(i.id)}
                  disabled={busy === i.id}
                  className="px-2 py-1 text-xs border border-red-500/30 text-red-400 hover:bg-red-500/15 rounded"
                >✕ Erledigt</button>
              )}
            </div>
          </div>
        </div>
      </div>
    );
  }

  function renderGroup(category: string, items: InsightItem[]) {
    const collapsed = collapsedGroups.has(category);
    const isMuted = muted.includes(category);
    // Batch-Eingabe: sinnvoll wenn ≥2 Karten genau EIN Eingabefeld haben (z.B. kg-gap Geburtstage)
    const batchable = items.filter(i => i.status === 'pending' && getInputFields(i).length === 1);
    const inBatch = batchGroup === category;
    return (
      <div key={category} className="border border-[#1f1f1f] rounded-lg overflow-hidden">
        <div className="flex items-center gap-2 px-3 py-2 bg-[#111] flex-wrap">
          <button onClick={() => toggleGroup(category)} className="flex items-center gap-2 text-sm text-gray-200 font-semibold">
            <span>{collapsed ? '▸' : '▾'}</span>
            <span>{CATEGORY_ICONS[category] ?? '💡'} {CATEGORY_LABEL[category] ?? category}</span>
            <span className="text-xs font-normal text-gray-500">({items.length})</span>
          </button>
          {isMuted && <span className="text-[10px] px-1.5 py-0.5 bg-gray-500/20 text-gray-400 rounded uppercase">stumm</span>}
          <div className="flex-1" />
          {batchable.length >= 2 && filterStatus === 'pending' && (
            <button
              onClick={() => { setBatchGroup(inBatch ? null : category); setBatchValues({}); }}
              className="px-2 py-1 text-xs border border-blue-500/30 text-blue-400 hover:bg-blue-500/15 rounded"
            >{inBatch ? 'Batch schließen' : `⚡ Batch-Eingabe (${batchable.length})`}</button>
          )}
          {filterStatus === 'pending' && (
            <button
              onClick={() => dismissGroup(category, items.length)}
              disabled={busy === `bulk-${category}`}
              className="px-2 py-1 text-xs border border-red-500/30 text-red-400 hover:bg-red-500/15 disabled:opacity-50 rounded"
            >✕ Alle erledigen</button>
          )}
          <button
            onClick={() => toggleMute(category)}
            disabled={busy === `mute-${category}`}
            title={isMuted ? 'Kategorie wieder aktivieren' : 'Keine neuen Insights dieser Art mehr erzeugen'}
            className="px-2 py-1 text-xs border border-gray-500/40 text-gray-400 hover:bg-gray-500/15 disabled:opacity-50 rounded"
          >{isMuted ? '🔔 Wieder aktivieren' : '🔕 Solche nicht mehr'}</button>
        </div>
        {/* v928 — Batch-Tabelle: eine Eingabe je Karte, ein Submit für alle */}
        {inBatch && !collapsed && (
          <div className="p-3 bg-black/30 border-b border-[#1f1f1f] space-y-2">
            {batchable.map(i => {
              const f = getInputFields(i)[0];
              return (
                <div key={i.id} className="flex items-center gap-3">
                  <span className="text-xs text-gray-300 flex-1 truncate" title={i.title}>{i.title}</span>
                  <input
                    type={f.type}
                    placeholder={f.label}
                    value={batchValues[i.id] ?? ''}
                    onChange={e => setBatchValues(v => ({ ...v, [i.id]: e.target.value }))}
                    className="w-48 bg-[#0a0a0a] border border-[#2a2a2a] rounded px-2 py-1 text-sm text-gray-200"
                  />
                </div>
              );
            })}
            <div className="flex justify-end">
              <button
                onClick={() => handleBatchSubmit(batchable)}
                disabled={busy === 'batch'}
                className="px-3 py-1.5 text-xs bg-blue-600 hover:bg-blue-500 disabled:opacity-50 text-white rounded"
              >{busy === 'batch' ? 'Übernehme …' : '✓ Ausgefüllte übernehmen'}</button>
            </div>
          </div>
        )}
        {!collapsed && (
          <div className="p-3 space-y-3">
            {items.map(renderCard)}
          </div>
        )}
      </div>
    );
  }

  return (
    <div className="p-6 max-w-6xl mx-auto space-y-4">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-bold text-gray-100">💡 Insights</h1>
          <p className="text-sm text-gray-500">Cross-Domain-Vorschläge und still gesammelte Beobachtungen — kombiniert aus Calendar, KG, ITSM, Chats &amp; Infra-Daten.</p>
        </div>
        <button
          onClick={runSweep}
          disabled={sweeping}
          className="px-3 py-1.5 text-sm bg-blue-600 hover:bg-blue-500 disabled:opacity-50 text-white rounded"
        >{sweeping ? 'Sweep läuft …' : '🔄 Sweep jetzt'}</button>
      </div>

      {/* Stats row */}
      {Object.keys(stats).length > 0 && (
        <div className="flex gap-3 text-xs">
          {(['pending', 'snoozed', 'acted', 'dismissed', 'expired'] as const).map(k => (
            <div key={k} className="bg-[#111] border border-[#1f1f1f] rounded px-3 py-2">
              <div className="text-gray-500 uppercase">{k}</div>
              <div className="text-gray-200 font-mono text-base">{stats[k] ?? 0}</div>
            </div>
          ))}
        </div>
      )}

      {/* Filters */}
      <div className="flex gap-2 flex-wrap">
        <select
          value={filterCat}
          onChange={(e) => setFilterCat(e.target.value)}
          className="bg-[#0a0a0a] border border-[#1f1f1f] rounded px-3 py-1.5 text-sm text-gray-200"
        >
          {categories.map(c => (
            <option key={c} value={c}>{c === 'all' ? 'Alle Kategorien' : `${CATEGORY_ICONS[c] ?? '·'} ${CATEGORY_LABEL[c] ?? c}`}</option>
          ))}
        </select>
        <select
          value={filterStatus}
          onChange={(e) => setFilterStatus(e.target.value)}
          className="bg-[#0a0a0a] border border-[#1f1f1f] rounded px-3 py-1.5 text-sm text-gray-200"
        >
          {statuses.map(s => <option key={s} value={s}>{s}</option>)}
        </select>
        <div className="flex-1" />
        <button onClick={load} className="px-3 py-1.5 text-sm text-blue-400 hover:text-blue-300">↻ Neu laden</button>
      </div>

      {error && (
        <div className="bg-red-500/10 border border-red-500/40 rounded px-3 py-2 text-sm text-red-400">{error}</div>
      )}

      {loading && <div className="text-gray-500 text-sm">Lade …</div>}

      {!loading && insights.length === 0 && (
        <div className="border border-dashed border-[#2a2a2a] rounded-lg p-12 text-center text-gray-500">
          <div className="text-4xl mb-2">🎉</div>
          <div className="text-sm">Keine offenen Insights — alles im Griff!</div>
          <div className="text-xs mt-2 text-gray-600">Sweep läuft täglich um 09:00 lokal, oder per Button.</div>
        </div>
      )}

      {/* v928 — gruppiert nach Kategorie (collapsible, Bulk-Aktionen je Gruppe) */}
      <div className="space-y-4">
        {groups.map(([category, items]) => renderGroup(category, items))}
      </div>
    </div>
  );
}
