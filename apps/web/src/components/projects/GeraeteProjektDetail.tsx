'use client';

import { useEffect, useState } from 'react';
import { ProjectConventionsView } from './ProjectConventionsView'; // v1426
import { GeraeteProjektDeploy } from './GeraeteProjektDeploy'; // v1439
import { ProjectEnvironmentsView } from './ProjectEnvironmentsView'; // v1443 B15 — Umgebungen wie beim Projekt-Agenten
import type { AlfredClient, ProjectDetail, GeraetLauf } from '@/lib/alfred-client';

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
  const protokollAn = !(p.tags ?? []).includes('protokoll-aus'); // v1425
  const mergeRequestsAn = (p.tags ?? []).includes('merge-requests'); // v1455
  const mrAutoAn = (p.tags ?? []).includes('mr-auto-merge'); // v1458
  const dev = p.deployZiel?.geraetDev ?? { art: p.deployZiel?.stufen && (p.deployZiel.stufen as Record<string, unknown>).dev ? 'host' as const : 'geraet' as const }; // v1460
  async function devAktion(felder: Record<string, unknown>) { setBusy(true); const r = await client.geraetProjektDeploy(p.id, 'dev', felder).catch((e: Error) => ({ success: false, error: e.message, display: undefined })); setBusy(false); setMeldung({ ok: r.success, text: r.success ? (r.display ?? 'Erledigt.') : (r.error ?? 'Fehler') }); if (r.success) onReload(); }
  function devEintragen() { const a = dev.angabe; const kein = confirm('Ist das Projekt KEIN Dienst (Bibliothek, Kommandozeile, Desktop-App)? OK = kein Dienst, Abbrechen = Startbefehl eintragen'); if (kein) { void devAktion({ dev_aktion: 'setzen', kein_dienst: true }); return; } const start = prompt('Startbefehl im Projektordner', a?.start ?? 'npm start'); if (!start) return; const port = prompt('Port (leer = ohne)', a?.port ? String(a.port) : ''); const pruefung = prompt('Prüfadresse (leer = ohne, z. B. /api/status)', a?.pruefung ?? ''); void devAktion({ dev_aktion: 'setzen', start, ...(port ? { port: Number(port) } : {}), ...(pruefung ? { pruefung } : {}) }); }
  const [wunsch, setWunsch] = useState('');
  const [frage, setFrage] = useState(''); // v1404
  const [busy, setBusy] = useState(false);
  const [meldung, setMeldung] = useState<{ ok: boolean; text: string } | null>(null);
  const [stand, setStand] = useState<string | null>(null);
  const [standLaedt, setStandLaedt] = useState(false);
  const [nameEdit, setNameEdit] = useState<string | null>(null);
  const [offen, setOffen] = useState<string | null>(laeufe[0]?.id ?? null);
  const [bericht, setBericht] = useState<string | null>(null); // v1417 G1 — aufgeklappte Etappe (lauf:nr)
  const [diff, setDiff] = useState<{ sha: string; dateien: string[]; text: string } | null>(null);
  const laeuftGerade = laeufe.some(l => l.status === 'laeuft' || l.status === 'wartet_owner');
  // v1418 G2 — läuft eine Etappe, alle 5 s neu laden (Live-Aktivität)
  const etappeLaeuft = laeufe.some(l => l.status === 'laeuft');
  useEffect(() => { if (!etappeLaeuft) return; const t = setInterval(onReload, 5000); return () => clearInterval(t); }, [etappeLaeuft, onReload]);

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
      setMeldung({ ok: r.success, text: r.success ? `${r.display ?? 'Gefragt.'}\nDie Antwort kommt ins Gespräch zum Projekt.` : (r.error ?? 'Fehler') });
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

  async function diffLaden(sha: string, dateien: string[], datei?: string) {
    setDiff({ sha, dateien, text: 'Lade …' });
    const r: { success: boolean; display?: string; error?: string } = await client.geraetProjektDiff(p.id, sha, datei).catch((e: unknown) => ({ success: false, error: String(e) }));
    setDiff({ sha, dateien, text: r.success ? (r.display ?? '') : `Fehler: ${r.error ?? ''}` });
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
          {/* v1457 — endgültig löschen (mit Owner-Bestätigung) */}
          {!laeuftGerade && (
            <button disabled={busy} onClick={async () => { if (!confirm(`Projekt "${p.name}" endgültig löschen? Du bekommst danach eine Bestätigung — erst nach deinem Ja wird gelöscht. Ordner und Repository bleiben.`)) return; setBusy(true); const r = await client.projektEndgueltigLoeschen(p.id).catch((e: Error) => ({ success: false, error: e.message, display: undefined })); setBusy(false); setMeldung({ ok: r.success, text: r.success ? (r.display ?? 'Zur Bestätigung gestellt.') : (r.error ?? 'Fehler') }); }} className="px-3 py-1 text-xs text-red-300 hover:bg-red-500/20 rounded border border-red-500/50">Endgültig löschen</button>
          )}
        </div>
      </div>

      <div className="grid grid-cols-1 sm:grid-cols-2 gap-2 text-xs">
        <div className="bg-[#1a1a1a] border border-[#2a2a2a] rounded p-2"><div className="text-gray-500">Gerät</div><div className="text-gray-200">📟 {p.geraet ?? '—'}</div></div>
        <div className="bg-[#1a1a1a] border border-[#2a2a2a] rounded p-2"><div className="text-gray-500">Verzeichnis (auf dem Gerät)</div><div className="text-gray-200 font-mono break-all">{p.cwd}</div></div>
        <div className="bg-[#1a1a1a] border border-[#2a2a2a] rounded p-2"><div className="text-gray-500">Abnahme je Etappe</div><div className="text-gray-200 font-mono">{p.pruefBefehle?.length ? p.pruefBefehle.join(' ; ') : 'keine — Alfred fragt nach jeder Etappe'}</div></div>
        <div className="bg-[#1a1a1a] border border-[#2a2a2a] rounded p-2"><div className="text-gray-500">Bisher</div><div className="text-gray-200">{laeufe.length} {laeufe.length === 1 ? 'Lauf' : 'Läufe'} · {usd(kosten)}</div></div>
        {/* v1425 — Schalter je Projekt: Auftrag und Bericht jeder Etappe unter .alfred/laeufe/ mit committen */}
        <label className="bg-[#1a1a1a] border border-[#2a2a2a] rounded p-2 sm:col-span-2 flex items-center gap-3 cursor-pointer">
          <input type="checkbox" className="h-4 w-4 accent-blue-500" checked={protokollAn} disabled={busy}
            onChange={async (ev) => { const an = ev.target.checked; setBusy(true); const r = await client.geraetProjektProtokoll(p.id, an).catch((e: Error) => ({ success: false, error: e.message, display: undefined })); setBusy(false); setMeldung({ ok: r.success, text: r.success ? (r.display ?? 'Gespeichert.') : (r.error ?? 'Fehler') }); if (r.success) onReload(); }} />
          <span><span className="text-gray-200">Protokoll im Projekt</span><span className="block text-gray-500">{protokollAn ? 'An: Auftrag und Bericht jeder Etappe werden unter .alfred/laeufe/ mit committet.' : 'Aus: Auftrag und Bericht bleiben nur lokal unter .alfred/laeufe/ (nicht in git).'}</span></span>
        </label>
        {/* v1455 — Schalter je Projekt: Etappen über eigenen Zweig und Merge Request in GitLab */}
        <label className="bg-[#1a1a1a] border border-[#2a2a2a] rounded p-2 sm:col-span-2 flex items-center gap-3 cursor-pointer">
          <input type="checkbox" className="h-4 w-4 accent-blue-500" checked={mergeRequestsAn} disabled={busy}
            onChange={async (ev) => { const an = ev.target.checked; setBusy(true); const r = await client.geraetProjektMergeRequests(p.id, an).catch((e: Error) => ({ success: false, error: e.message, display: undefined })); setBusy(false); setMeldung({ ok: r.success, text: r.success ? (r.display ?? 'Gespeichert.') : (r.error ?? 'Fehler') }); if (r.success) onReload(); }} />
          <span><span className="text-gray-200">Merge Requests</span><span className="block text-gray-500">{mergeRequestsAn ? `An: eigener Zweig je Lauf, Merge Request in GitLab${p.repoUrl ? '' : ' (braucht ein GitLab-Repository — Remote fehlt)'}; deine Kommentare dort gehen in die nächste Etappe. Sind alle Etappen grün, ${mrAutoAn ? 'führt Alfred automatisch zusammen' : 'fragt Alfred dich vor dem Zusammenführen'}.` : 'Aus: Etappen laufen direkt auf dem aktuellen Zweig.'}</span></span>
        </label>
        {/* v1460 — dev: am Gerät oder eigener Host */}
        <div className="bg-[#1a1a1a] border border-[#2a2a2a] rounded p-2 sm:col-span-2 space-y-2">
          <div className="flex items-center gap-2"><span className="text-gray-200">dev</span>
            {(['geraet', 'host'] as const).map(a => <button key={a} disabled={busy} onClick={() => devAktion({ dev_aktion: 'art', art: a })} className={`px-2 py-0.5 rounded border ${dev.art === a ? 'border-blue-500 text-blue-300' : 'border-[#2a2a2a] text-gray-400'}`}>{a === 'geraet' ? 'Am Gerät' : 'Eigener Host'}</button>)}
          </div>
          {dev.art === 'host' ? <div className="text-gray-500">dev wird über das dev-Ziel im Deploy-Bereich ausgerollt.</div> : <>
            <label className="flex items-center gap-2 cursor-pointer"><input type="checkbox" className="h-4 w-4 accent-blue-500" checked={dev.aktiv === true} disabled={busy} onChange={(ev) => devAktion({ dev_aktion: ev.target.checked ? 'einschalten' : 'ausschalten' })} /><span className="text-gray-200">dev am Gerät</span><span className="text-gray-500">{dev.aktiv ? 'Alfred startet die App nach jeder grünen Etappe im Arbeitsordner neu.' : 'Einschalten erkennt, wie das Projekt startet, und fragt dich.'}</span></label>
            <div className="text-gray-300">{!dev.angabe ? 'noch keine bestätigte Startangabe' : dev.angabe.dienst === false ? 'kein Dienst — dev heißt hier: Build und Tests grün' : `Start „${dev.angabe.start}“${dev.angabe.port ? ` · Port ${dev.angabe.port}` : ''}${dev.angabe.pruefung ? ` · Prüfadresse ${dev.angabe.pruefung}` : ''}`}{dev.quelle ? <span className="text-gray-500"> ({dev.quelle})</span> : null}</div>
            {dev.zuletzt && <div className="text-gray-400">{dev.zuletzt.ok ? '🟢' : '🔴'} {dev.zuletzt.url ? <a className="text-blue-400 hover:underline" href={dev.zuletzt.url} target="_blank" rel="noreferrer">{dev.zuletzt.url}</a> : dev.zuletzt.text}</div>}
            <div className="flex flex-wrap gap-2">
              <button disabled={busy} onClick={() => devAktion({ dev_aktion: 'erkennen' })} className="px-2 py-0.5 rounded border border-[#2a2a2a] text-gray-300">Erkennen</button>
              <button disabled={busy} onClick={devEintragen} className="px-2 py-0.5 rounded border border-[#2a2a2a] text-gray-300">Eintragen</button>
              {dev.angabe?.dienst && <button disabled={busy} onClick={() => devAktion({ dev_aktion: 'neustart' })} className="px-2 py-0.5 rounded border border-[#2a2a2a] text-gray-300">Neu starten</button>}
              {dev.angabe?.dienst && <button disabled={busy} onClick={() => devAktion({ dev_aktion: 'stoppen' })} className="px-2 py-0.5 rounded border border-[#2a2a2a] text-gray-300">Stoppen</button>}
            </div>
          </>}
        </div>
        {/* v1458 — automatisch zusammenführen (nur mit Merge Requests) */}
        {mergeRequestsAn && (
          <label className="bg-[#1a1a1a] border border-[#2a2a2a] rounded p-2 sm:col-span-2 flex items-center gap-3 cursor-pointer">
            <input type="checkbox" className="h-4 w-4 accent-blue-500" checked={mrAutoAn} disabled={busy}
              onChange={async (ev) => { const an = ev.target.checked; setBusy(true); const r = await client.geraetProjektMrAuto(p.id, an).catch((e: Error) => ({ success: false, error: e.message, display: undefined })); setBusy(false); setMeldung({ ok: r.success, text: r.success ? (r.display ?? 'Gespeichert.') : (r.error ?? 'Fehler') }); if (r.success) onReload(); }} />
            <span><span className="text-gray-200">Automatisch zusammenführen</span><span className="block text-gray-500">{mrAutoAn ? 'An: bei grünem Lauf ohne Rückfrage zusammenführen.' : 'Aus (Standard): Alfred fragt dich, bevor er zusammenführt; bei Nein bleibt der MR offen und der nächste Lauf arbeitet auf demselben Zweig weiter.'}</span></span>
          </label>
        )}
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
        <div className="text-[11px] text-gray-500">Claude Code liest im Projekt und antwortet, ändert aber nichts. Die Antwort kommt nach etwa einer Minute ins Gespräch zum Projekt.</div>
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
                <span className="text-[11px] text-gray-500">{l.status === 'laeuft' && l.nr > 0 ? `Etappe ${l.nr}/${l.plan.length}${ok > 0 ? ` · ${ok} abgenommen` : ''}` : `${ok}/${l.plan.length} abgenommen`} · {usd(l.kostenUsd)} · {datum(l.start)}</span>
              </button>
              {l.status === 'laeuft' && l.live && l.live.schritte.length > 0 && (
                <div className="mx-3 mb-2 p-2 rounded bg-black/40 border border-[#222] font-mono text-[11px] text-gray-300 space-y-0.5">
                  <div className="text-gray-500 font-sans">🔨 Claude Code arbeitet · {l.live.werkzeuge} Schritte</div>
                  {l.live.schritte.map((z, i) => <div key={i} className="truncate">{z}</div>)}
                </div>
              )}
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
                    const b = e?.bericht; const k = `${l.id}:${i}`;
                    return (
                      <div key={i}>
                        <button onClick={() => b && setBericht(bericht === k ? null : k)} className="w-full text-left text-xs text-gray-300 flex gap-2"><span>{icon}</span><span className="flex-1">{etappe}</span>{e && <span className="text-gray-500">{usd(e.kostenUsd)}</span>}{b && <span className="text-gray-500">{bericht === k ? '▴' : '▾'}</span>}</button>
                        {b && bericht === k && (
                          <div className="ml-5 my-1 p-2 rounded bg-[#111] border border-[#222] space-y-1 text-xs">
                            <div className="text-gray-500">{[b.abnahme ? (b.abnahme.ok ? 'Abnahme ✅' : 'Abnahme ❌') : 'ohne Abnahme', b.fixVersuche ? `${b.fixVersuche} Fix-Versuch(e)` : '', b.dauerS !== undefined ? `${Math.round(b.dauerS / 60)} min` : ''].filter(Boolean).join(' · ')}</div>
                            {b.zusammenfassung.trim() && <div className="text-gray-200 whitespace-pre-wrap">{b.zusammenfassung.trim()}</div>}
                            {b.dateienAnzahl > 0 && <div className="text-gray-400">Geänderte Dateien ({b.dateienAnzahl}): {b.dateien.slice(0, 12).join(', ')}{b.dateienAnzahl > 12 ? ' …' : ''}</div>}
                            {b.commit && <div className="flex items-center gap-2"><span className="text-gray-300 font-mono">{b.commit.sha.slice(0, 7)}</span><span className="text-gray-400 flex-1">{b.commit.titel}</span><button onClick={() => diffLaden(b.commit!.sha, b.dateien)} className="px-2 py-0.5 rounded border border-[#2a2a2a] text-gray-200 hover:bg-[#222]">Änderungen ansehen</button></div>}
                            {b.abnahme && !b.abnahme.ok && b.abnahme.protokoll && <pre className="text-red-300 whitespace-pre-wrap">{b.abnahme.protokoll}</pre>}
                          </div>
                        )}
                      </div>
                    );
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

      {diff && (
        <div className="fixed inset-0 bg-black/60 z-50 flex items-center justify-center p-4" onClick={() => setDiff(null)}>
          <div className="bg-[#141414] border border-[#2a2a2a] rounded-lg p-4 max-w-4xl w-full max-h-[85vh] overflow-auto space-y-2" onClick={e => e.stopPropagation()}>
            <div className="flex items-center gap-2"><div className="text-sm text-gray-200 flex-1">Änderungen {diff.sha.slice(0, 7)}</div><button onClick={() => setDiff(null)} className="text-gray-400">×</button></div>
            {diff.dateien.length > 0 && <div className="flex flex-wrap gap-1">{diff.dateien.slice(0, 20).map(d => <button key={d} onClick={() => diffLaden(diff.sha, diff.dateien, d)} className="px-2 py-0.5 text-[11px] rounded border border-[#2a2a2a] text-gray-300 hover:bg-[#222]">{d}</button>)}</div>}
            <pre className="text-[11px] text-gray-200 whitespace-pre-wrap font-mono">{diff.text}</pre>
          </div>
        </div>
      )}

      {/* v1419 G3 — ein Gespräch zum Projekt für App, Web und Telegram (/faden): der Projektfaden */}
      {/* v1426 — Projektregeln (Konventionen) je Projekt */}
      <ProjectConventionsView project={p} geraet onSaved={() => onReload()} />
      <GeraeteProjektDeploy client={client} projektId={p.id} />
      <ProjectEnvironmentsView projectId={p.id} projectName={p.name} />
      <a href={`/alfred/chat/?faden=projekt-${p.id.slice(0, 8)}`} className="inline-flex items-center gap-2 px-3 py-1.5 text-xs bg-[#1a1a1a] text-gray-200 rounded border border-[#2a2a2a] hover:bg-[#222]">💬 Gespräch zum Projekt öffnen</a>
    </div>
  );
}
