'use client';

/**
 * v1429 R4a — Beobachter: Regeln am Server mit sichtbarem Schalter je Regel (dieselben wie in App und Gespräch).
 * Der Satellit beobachtet Ordner und meldet nur Dateiname/Größe; am Gerät lässt sich alles lokal abschalten.
 */
import { useEffect, useState, useCallback } from 'react';
import { useConfig } from '@/context/ConfigContext';
import type { BeobachterListe, BeobachterRegelDto } from '@/lib/alfred-client';

const WIRKUNG: Record<string, string> = { hinweis: 'Hinweis', vorgang: 'Vorgang', aufgabe: 'Aufgabe (Alfred erledigt)', projekt: 'Projekt weiterarbeiten (mit Bestätigung)' };
const ART: Record<string, string> = { neu: 'neu', geaendert: 'geändert', geloescht: 'gelöscht' };

export function BeobachterPage() {
  const { client } = useConfig();
  const [d, setD] = useState<BeobachterListe | null>(null);
  const [meldung, setMeldung] = useState<{ ok: boolean; text: string } | null>(null);
  const [busy, setBusy] = useState(false);
  const [neu, setNeu] = useState(false);
  const [f, setF] = useState({ geraet: '', pfad: '', muster: '', ereignisse: ['neu'] as string[], unterordner: false, wirkung: 'hinweis', auftrag: '', projekt: '', name: '' });

  const laden = useCallback(async () => {
    if (!client) return;
    const x = await client.beobachter();
    setD(x);
    if (x?.geraete?.length) setF(v => (v.geraet ? v : { ...v, geraet: x.geraete[0]!.id }));
  }, [client]);
  useEffect(() => { void laden(); }, [laden]);

  const aendern = async (r: BeobachterRegelDto, aktion: string) => {
    if (!client) return;
    setBusy(true);
    const x: { success: boolean; display?: string; error?: string } = await client.beobachterAendern(r.id, { aktion }).catch((e: Error) => ({ success: false, error: e.message }));
    setBusy(false);
    setMeldung({ ok: x.success, text: x.success ? (x.display ?? 'Gespeichert.') : (x.error ?? 'Fehler') });
    await laden();
  };
  const anlegen = async () => {
    if (!client) return;
    setBusy(true);
    const x: { success: boolean; display?: string; error?: string } = await client.beobachterAnlegen({ ...f, ...(f.wirkung === 'projekt' ? {} : { projekt: undefined }) }).catch((e: Error) => ({ success: false, error: e.message }));
    setBusy(false);
    setMeldung({ ok: x.success, text: x.success ? (x.display ?? 'Angelegt.') : (x.error ?? 'Fehler') });
    if (x.success) { setNeu(false); setF(v => ({ ...v, pfad: '', muster: '', auftrag: '', name: '' })); await laden(); }
  };

  const feld = 'bg-[#0d0d0d] border border-[#2a2a2a] rounded px-2 py-1 text-gray-200 text-xs';
  return (
    <div className="p-4 space-y-3 max-w-4xl">
      <div className="flex items-center gap-2">
        <h1 className="text-lg text-gray-100 font-semibold flex-1">🔭 Beobachter</h1>
        <button onClick={() => setNeu(!neu)} className="px-3 py-1 text-xs bg-blue-600 hover:bg-blue-500 text-white rounded">{neu ? 'Schließen' : 'Neue Regel'}</button>
        <button onClick={() => void laden()} className="px-3 py-1 text-xs text-gray-300 border border-[#2a2a2a] rounded hover:bg-[#222]">Aktualisieren</button>
      </div>
      <div className="text-xs text-gray-500">Alfred bemerkt, was auf deinen Geräten passiert, und reagiert nach diesen Regeln. Gemeldet werden nur Dateiname und Größe; am Gerät abschaltbar mit <code>alfred einstellungen beobachter aus</code>.</div>
      {meldung && <div className={`text-xs ${meldung.ok ? 'text-emerald-400' : 'text-red-400'}`}>{meldung.text}</div>}
      {neu && d && (
        <div className="bg-[#141414] border border-[#2a2a2a] rounded p-3 space-y-2 text-xs text-gray-300">
          <label className="flex items-center gap-2">Gerät
            <select className={feld} value={f.geraet} onChange={e => setF({ ...f, geraet: e.target.value })}>{d.geraete.map(g => <option key={g.id} value={g.id}>{g.name}{g.online ? '' : ' (offline)'}</option>)}</select></label>
          <input className={`${feld} w-full`} placeholder="Ordner auf dem Gerät (absolut, freigegeben), z. B. C:\Users\madh\Downloads" value={f.pfad} onChange={e => setF({ ...f, pfad: e.target.value })} />
          <input className={`${feld} w-full`} placeholder="Dateimuster (optional), z. B. *.pdf, Rechnung*" value={f.muster} onChange={e => setF({ ...f, muster: e.target.value })} />
          <div className="flex gap-3">{Object.entries(ART).map(([k, t]) => (
            <label key={k} className="flex items-center gap-1"><input type="checkbox" checked={f.ereignisse.includes(k)} onChange={e => setF({ ...f, ereignisse: e.target.checked ? [...f.ereignisse, k] : (f.ereignisse.length > 1 ? f.ereignisse.filter(x => x !== k) : f.ereignisse) })} />{t}</label>))}
            <label className="flex items-center gap-1"><input type="checkbox" checked={f.unterordner} onChange={e => setF({ ...f, unterordner: e.target.checked })} />Unterordner</label>
          </div>
          <label className="flex items-center gap-2">Dann
            <select className={feld} value={f.wirkung} onChange={e => setF({ ...f, wirkung: e.target.value })}>{Object.entries(WIRKUNG).map(([k, t]) => <option key={k} value={k}>{t}</option>)}</select></label>
          {f.wirkung === 'projekt' && (
            <label className="flex items-center gap-2">Projekt
              <select className={feld} value={f.projekt} onChange={e => setF({ ...f, projekt: e.target.value })}><option value="">wählen</option>{d.projekte.map(p => <option key={p.id} value={p.id}>{p.name}</option>)}</select></label>)}
          <textarea className={`${feld} w-full`} rows={2} placeholder={f.wirkung === 'hinweis' ? 'Notiz (optional)' : f.wirkung === 'vorgang' ? 'Nächster Schritt (optional)' : 'Was soll Alfred tun? (Pflicht)'} value={f.auftrag} onChange={e => setF({ ...f, auftrag: e.target.value })} />
          <input className={`${feld} w-full`} placeholder="Name (optional), z. B. Rechnungen" value={f.name} onChange={e => setF({ ...f, name: e.target.value })} />
          <div className="text-right"><button disabled={busy || !f.geraet} onClick={() => void anlegen()} className="px-3 py-1 bg-blue-600 hover:bg-blue-500 disabled:opacity-40 text-white rounded">Anlegen</button></div>
        </div>
      )}
      {d && d.regeln.length === 0 && <div className="text-xs text-gray-500 italic">Noch keine Beobachter. Beispiel im Chat: „Sag mir, wenn in Downloads eine PDF-Rechnung landet."</div>}
      {d?.regeln.map(r => (
        <div key={r.id} className="bg-[#1a1a1a] border border-[#2a2a2a] rounded p-3 flex items-start gap-3">
          <div className="flex-1 text-xs space-y-0.5">
            <div className="text-gray-100 text-sm">{r.name}</div>
            <div className="text-gray-400">{r.geraet}: <span className="font-mono">{String(r.filter.pfad ?? '')}</span>{r.filter.muster ? ` · ${String(r.filter.muster)}` : ''} · {((r.filter.ereignisse as string[] | undefined) ?? ['neu']).map(x => ART[x] ?? x).join('/')}</div>
            <div className="text-gray-300">→ {WIRKUNG[r.wirkung] ?? r.wirkung}{r.auftrag ? `: ${r.auftrag}` : ''}</div>
            <div className={r.stand === 'läuft' ? 'text-emerald-400' : r.stand === 'gestört' || r.stand === 'Satellit zu alt' ? 'text-red-400' : 'text-gray-500'}>{r.stand}{r.standGrund ? ` — ${r.standGrund}` : ''} · {r.treffer ?? 0} Treffer{r.letzterTreffer ? `, zuletzt ${new Date(r.letzterTreffer).toLocaleString('de-AT')}` : ''}</div>
          </div>
          <label className="flex items-center gap-2 text-xs text-gray-300 cursor-pointer">
            <input type="checkbox" className="h-4 w-4 accent-blue-500" checked={r.aktiv} disabled={busy} onChange={e => void aendern(r, e.target.checked ? 'an' : 'aus')} />{r.aktiv ? 'an' : 'aus'}
          </label>
          <button disabled={busy} onClick={() => void aendern(r, 'loeschen')} className="text-xs text-red-400 hover:text-red-300" title="Löschen">✕</button>
        </div>
      ))}
    </div>
  );
}
