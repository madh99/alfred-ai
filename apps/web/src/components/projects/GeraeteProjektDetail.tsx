'use client';

import { useState } from 'react';
import type { AlfredClient, ProjectDetail, GeraetLauf } from '@/lib/alfred-client';
import { ProjectChat } from './ProjectChat';

/**
 * v1399 — Detailansicht eines Geräte-Projekts (Spec „Projekte sichtbar und fortsetzbar", Owner 12.10.: ins vorhandene Projekt-
 * System). Das Verzeichnis liegt auf einem Gerät: keine Server-Bereiche (Git, Deploy, Sandboxes …), sondern Läufe mit Etappen,
 * Weiterarbeiten (nur der Wunsch — Alfred plant mit dem Bestand und fragt dich zur Bestätigung), Stand mit Commits vom Gerät,
 * offene Punkte und der Projekt-Chat.
 */
interface Props {
  client: AlfredClient;
  detail: ProjectDetail;
  onReload: () => void;
  onArchive: () => void;
  onRename: (name: string) => Promise<void>;
}

const STATUS: Record<GeraetLauf['status'], { text: string; cls: string }> = {
  laeuft: { text: '▶ läuft', cls: 'text-blue-300 border-blue-500/40 bg-blue-500/10' },
  wartet_owner: { text: '⏳ wartet auf dich', cls: 'text-amber-300 border-amber-500/40 bg-amber-500/10' },
  fertig: { text: '✅ fertig', cls: 'text-emerald-300 border-emerald-500/40 bg-emerald-500/10' },
  angehalten: { text: '⏸ angehalten', cls: 'text-gray-300 border-gray-500/40 bg-gray-500/10' },
  abgebrochen: { text: '⏹ abgebrochen', cls: 'text-gray-400 border-gray-600/40 bg-gray-600/10' },
};

function usd(n: number): string { return `${n.toFixed(2).replace('.', ',')} USD`; }
function datum(iso: string): string { return new Date(iso).toLocaleString('de-AT', { day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit' }); }

export function GeraeteProjektDetail({ client, detail, onReload, onArchive, onRename }: Props) {
  const p = detail.project;
  const laeufe = [...(detail.geraetLaeufe ?? [])].sort((a, b) => b.start.localeCompare(a.start));
  const kosten = laeufe.reduce((s, l) => s + l.kostenUsd, 0);
  const [wunsch, setWunsch] = useState('');
  const [frage, setFrage] = useState(''); // v1404
  const [busy, setBusy] = useState(false);
  const [meldung, setMeldung] = useState<{ ok: boolean; text: string } | null>(null);
  const [stand, setStand] = useState<string | null>(null);
  const [standLaedt, setStandLaedt] = useState(false);
  const [nameEdit, setNameEdit] = useState<string | null>(null);
  const [offen, setOffen] = useState<string | null>(laeufe[0]?.id ?? null);
  const laeuftGerade = laeufe.some(l => l.status === 'laeuft' || l.status === 'wartet_owner');

  async function weiter() {
    const text = wunsch.trim();
    if (!text) return;
    setBusy(true); setMeldung(null);
    try {
      const r = await client.geraetProjektWeiter(p.id, text);
      setMeldung({ ok: r.success, text: r.success ? `${r.display ?? 'Geplant.'}\nDie Planfrage kommt zur Bestätigung (Telegram/App).` : (r.error ?? 'Fehler') });
      if (r.success) { setWunsch(''); setTimeout(onReload, 1500); }
    } catch (err) { setMeldung({ ok: false, text: err instanceof Error ? err.message : String(err) }); }
    finally { setBusy(false); }
  }

  async function entscheiden(lauf: string, e: 'freigeben' | 'ablehnen') {
    setBusy(true); setMeldung(null);
    try {
      const r = await client.geraetLaufEntscheiden(p.id, lauf, e);
      setMeldung({ ok: r.success, text: r.success ? (r.display ?? 'Entschieden.') : (r.error ?? 'Fehler') });
      if (r.success) setTimeout(onReload, 800);
    } catch (err) { setMeldung({ ok: false, text: err instanceof Error ? err.message : String(err) }); }
    finally { setBusy(false); }
  }

  async function fragen() {
    const text = frage.trim();
    if (!text) return;
    setBusy(true); setMeldung(null);
    try {
      const r = await client.geraetProjektFrage(p.id, text);
      setMeldung({ ok: r.success, text: r.success ? `${r.display ?? 'Gefragt.'}\nDie Antwort kommt als Meldung (Telegram/App).` : (r.error ?? 'Fehler') });
      if (r.success) setFrage('');
    } catch (err) { setMeldung({ ok: false, text: err instanceof Error ? err.message : String(err) }); }
    finally { setBusy(false); }
  }

  async function fortsetzen(lauf: string) {
    setBusy(true); setMeldung(null);
    try {
      const r = await client.geraetLaufFortsetzen(p.id, lauf);
      setMeldung({ ok: r.success, text: r.success ? (r.display ?? 'Fortgesetzt.') : (r.error ?? 'Fehler') });
      if (r.success) setTimeout(onReload, 800);
    } catch (err) { setMeldung({ ok: false, text: err instanceof Error ? err.message : String(err) }); }
    finally { setBusy(false); }
  }

  async function standLaden() {
    setStandLaedt(true);
    try { const r = await client.geraetProjektStand(p.id); setStand(r.success ? (r.display ?? '') : `Fehler: ${r.error ?? 'unbekannt'}`); }
    catch (err) { setStand(`Fehler: ${err instanceof Error ? err.message : String(err)}`); }
    finally { setStandLaedt(false); }
  }

  const offenePunkte = detail.openItems.filter(i => i.status === 'open' || i.status === 'in_progress');

  return (
    <div className="space-y-4">
      <div className="flex items-start justify-between gap-3 flex-wrap">
        {nameEdit !== null ? (
          <div className="flex gap-2 flex-1">
            <input value={nameEdit} onChange={e => setNameEdit(e.target.value)} className="flex-1 px-3 py-1.5 bg-[#1a1a1a] border border-[#2a2a2a] rounded text-gray-200" />
            <button onClick={async () => { if (nameEdit.trim()) await onRename(nameEdit.trim()); setNameEdit(null); }} className="px-3 py-1.5 bg-emerald-500/20 text-emerald-400 rounded border border-emerald-500/40 text-sm">Speichern</button>
            <button onClick={() => setNameEdit(null)} className="px-3 py-1.5 bg-[#1a1a1a] text-gray-400 rounded border border-[#2a2a2a] text-sm">×</button>
          </div>
        ) : (
          <h2 className="text-xl font-bold text-gray-100 flex items-center gap-2">
            {p.name}
            <button onClick={() => setNameEdit(p.name)} className="text-xs text-gray-500 hover:text-gray-300" title="Umbenennen">✎</button>
          </h2>
        )}
        <div className="flex gap-2">
          <button onClick={onReload} className="px-3 py-1 text-xs text-gray-300 hover:bg-[#222] rounded border border-[#2a2a2a]">Aktualisieren</button>
          {p.status !== 'archived' && !laeuftGerade && (
            <button onClick={onArchive} className="px-3 py-1 text-xs text-red-400 hover:bg-red-500/10 rounded border border-red-500/30">Archivieren</button>
          )}
        </div>
      </div>

      <div className="grid grid-cols-1 sm:grid-cols-2 gap-2 text-xs">
        <div className="bg-[#1a1a1a] border border-[#2a2a2a] rounded p-2"><div className="text-gray-500">Gerät</div><div className="text-gray-200">📟 {p.geraet ?? '—'}</div></div>
        <div className="bg-[#1a1a1a] border border-[#2a2a2a] rounded p-2"><div className="text-gray-500">Verzeichnis (auf dem Gerät)</div><div className="text-gray-200 font-mono break-all">{p.cwd}</div></div>
        <div className="bg-[#1a1a1a] border border-[#2a2a2a] rounded p-2"><div className="text-gray-500">Abnahme je Etappe</div><div className="text-gray-200 font-mono">{p.pruefBefehle?.length ? p.pruefBefehle.join(' ; ') : 'keine — Alfred fragt nach jeder Etappe'}</div></div>
        <div className="bg-[#1a1a1a] border border-[#2a2a2a] rounded p-2"><div className="text-gray-500">Bisher</div><div className="text-gray-200">{laeufe.length} {laeufe.length === 1 ? 'Lauf' : 'Läufe'} · {usd(kosten)}</div></div>
      </div>
      {p.description && <div className="text-xs text-gray-400 whitespace-pre-wrap">{p.description}</div>}

      {p.status !== 'archived' && (
        <div className="bg-[#161616] border border-[#2a2a2a] rounded p-3 space-y-2">
          <div className="text-sm text-gray-200 font-medium">Weiterarbeiten</div>
          <div className="text-[11px] text-gray-500">Nur, was als Nächstes passieren soll. Gerät, Verzeichnis, Abnahme und den Bestand kennt Alfred. Er plant und fragt dich vor dem Start.</div>
          <textarea value={wunsch} onChange={e => setWunsch(e.target.value)} rows={3} placeholder="z. B. Die Merkliste soll man per Link teilen können." className="w-full px-3 py-2 bg-[#1a1a1a] border border-[#2a2a2a] rounded text-sm text-gray-200" disabled={busy || laeuftGerade} />
          <div className="flex items-center gap-2">
            <button onClick={weiter} disabled={busy || laeuftGerade || !wunsch.trim()} className="px-3 py-1.5 text-xs bg-blue-500/20 text-blue-300 rounded border border-blue-500/40 disabled:opacity-40">{busy ? 'Plane …' : 'Planen lassen'}</button>
            {laeuftGerade && <span className="text-[11px] text-amber-300">Ein Lauf läuft oder wartet gerade — erst danach weiter.</span>}
          </div>
          {meldung && <div className={`text-xs whitespace-pre-wrap rounded px-2 py-1 border ${meldung.ok ? 'text-emerald-300 border-emerald-500/30 bg-emerald-500/10' : 'text-red-300 border-red-500/30 bg-red-500/10'}`}>{meldung.text}</div>}
        </div>
      )}

      <div className="bg-[#161616] border border-[#2a2a2a] rounded p-3 space-y-2">
        <div className="text-sm text-gray-200 font-medium">Frage zum Projekt</div>
        <div className="text-[11px] text-gray-500">Claude Code liest im Projekt und antwortet, ändert aber nichts. Die Antwort kommt nach etwa einer Minute als Meldung.</div>
        <div className="flex gap-2">
          <input value={frage} onChange={e => setFrage(e.target.value)} onKeyDown={e => { if (e.key === 'Enter') fragen(); }} placeholder="z. B. Woher holt die App die Hofer-Angebote?" className="flex-1 px-3 py-1.5 bg-[#1a1a1a] border border-[#2a2a2a] rounded text-sm text-gray-200" disabled={busy} />
          <button onClick={fragen} disabled={busy || !frage.trim()} className="px-3 py-1.5 text-xs bg-[#1a1a1a] text-gray-200 rounded border border-[#2a2a2a] disabled:opacity-40">Fragen</button>
        </div>
      </div>

      <div className="space-y-2">
        <div className="text-sm text-gray-200 font-medium">Läufe</div>
        {laeufe.length === 0 && <div className="text-xs text-gray-500 italic">Noch keine Läufe.</div>}
        {laeufe.map(l => {
          const ok = l.erledigt.filter(e => e.ok).length;
          const st = l.status === 'laeuft' && l.wartetAufGeraet ? { text: '⏳ wartet auf Gerät', cls: 'text-amber-300 border-amber-500/40 bg-amber-500/10' } : (STATUS[l.status] ?? STATUS.abgebrochen);
          return (
            <div key={l.id} className="bg-[#1a1a1a] border border-[#2a2a2a] rounded">
              <button onClick={() => setOffen(offen === l.id ? null : l.id)} className="w-full text-left px-3 py-2 flex items-center gap-2 flex-wrap">
                <span className={`text-[10px] px-1.5 py-0.5 rounded border ${st.cls}`}>{st.text}</span>
                <span className="text-xs text-gray-200 flex-1 min-w-[12rem]">{l.ziel.slice(0, 140)}</span>
                <span className="text-[11px] text-gray-500">{ok}/{l.plan.length} · {usd(l.kostenUsd)} · {datum(l.start)}</span>
              </button>
              {l.status === 'angehalten' && (
                <div className="mx-3 mb-2"><button onClick={() => fortsetzen(l.id)} disabled={busy} className="px-3 py-1 text-xs bg-blue-500/20 text-blue-300 rounded border border-blue-500/40 disabled:opacity-40">▶ Fortsetzen</button></div>
              )}
              {l.status === 'wartet_owner' && l.frage && (
                <div className="mx-3 mb-2 p-2 rounded border border-amber-500/40 bg-amber-500/10 space-y-2">
                  <div className="text-xs text-amber-100 whitespace-pre-wrap">{l.frage}</div>
                  <div className="flex gap-2">
                    <button onClick={() => entscheiden(l.id, 'freigeben')} disabled={busy} className="px-3 py-1 text-xs bg-emerald-500/20 text-emerald-300 rounded border border-emerald-500/40 disabled:opacity-40">Freigeben</button>
                    <button onClick={() => entscheiden(l.id, 'ablehnen')} disabled={busy} className="px-3 py-1 text-xs bg-red-500/10 text-red-300 rounded border border-red-500/30 disabled:opacity-40">Ablehnen</button>
                  </div>
                </div>
              )}
              {offen === l.id && (
                <div className="px-3 pb-2 space-y-1">
                  {l.grund && <div className="text-[11px] text-gray-400">{l.grund}</div>}
                  {l.plan.map((etappe, i) => {
                    const e = l.erledigt.find(x => x.nr === i + 1);
                    const icon = e?.ok ? '✅' : l.status === 'laeuft' && i + 1 === l.nr ? '▶' : e ? '❌' : '·';
                    return <div key={i} className="text-xs text-gray-300 flex gap-2"><span>{icon}</span><span className="flex-1">{etappe}</span>{e && <span className="text-gray-500">{usd(e.kostenUsd)}</span>}</div>;
                  })}
                  <div className="text-[10px] text-gray-600 font-mono">{l.id}</div>
                </div>
              )}
            </div>
          );
        })}
      </div>

      <div className="space-y-2">
        <div className="flex items-center gap-2">
          <div className="text-sm text-gray-200 font-medium flex-1">Stand auf dem Gerät</div>
          <button onClick={standLaden} disabled={standLaedt} className="px-3 py-1 text-xs text-gray-300 hover:bg-[#222] rounded border border-[#2a2a2a] disabled:opacity-40">{standLaedt ? 'Lese …' : 'Commits und Stand laden'}</button>
        </div>
        {stand && <pre className="text-[11px] text-gray-300 bg-[#111] border border-[#222] rounded p-2 whitespace-pre-wrap">{stand}</pre>}
      </div>

      {offenePunkte.length > 0 && (
        <div className="space-y-1">
          <div className="text-sm text-gray-200 font-medium">Offene Punkte ({offenePunkte.length})</div>
          {offenePunkte.slice(0, 20).map(i => <div key={i.id} className="text-xs text-gray-300">• {i.title}</div>)}
        </div>
      )}

      <ProjectChat projectId={p.id} projectName={p.name} projectCwd={p.cwd ?? undefined} />
    </div>
  );
}
