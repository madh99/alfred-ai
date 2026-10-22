'use client';

/**
 * I4b Teil 1 (Owner 22.10.2026, 5b-7/5b-12) — Wartungsfenster, Sperrzeiten und Benachrichtigungen „wer wann wie“.
 * Dieselben Aktionen und Prüfungen wie im Gespräch (Skill infrastruktur). Der Ausführungsmotor startet ändernde Changes nur im
 * geltenden Fenster, nie in einer Sperrzeit (außer Notfall-Changes) und erst nach der verlangten Ankündigung.
 */
import { useEffect, useState, useCallback } from 'react';
import { useConfig } from '@/context/ConfigContext';
import type { WartungKalenderDto, WartungRegelDto } from '@/lib/alfred-client';

const TAGE = ['So', 'Mo', 'Di', 'Mi', 'Do', 'Fr', 'Sa'];
const ZEITPUNKTE: Record<string, string> = { '24h_vorher': '24 h vorher', '1h_vorher': '1 h vorher', start: 'Start', ende: 'Ende', stoerung: 'Störung' };
const KANAELE: Record<string, string> = { push: 'Push (iPhone)', telegram: 'Telegram', matrix: 'Matrix', email: 'E-Mail', homeassistant: 'Home Assistant' };
const feld = 'w-full bg-[#0a0a0a] border border-[#1f1f1f] rounded px-3 py-2 text-sm text-gray-200';

function regelText(r: WartungKalenderDto['regel']): string {
  if (r.art === 'einmalig') return `${new Date(r.von).toLocaleString('de-AT', { dateStyle: 'short', timeStyle: 'short' })} – ${new Date(r.bis).toLocaleString('de-AT', { dateStyle: 'short', timeStyle: 'short' })}`;
  return `${[...r.tage].sort().map(t => TAGE[t]).join(', ')} ${r.von}–${r.bis}`;
}
const geltungText = (g: { global?: boolean; assetIds?: string[] }) => (g.global ? 'alle Changes' : `${g.assetIds?.length ?? 0} Assets`);
const liste = (s: string) => s.split(',').map(x => x.trim()).filter(Boolean);

export function WartungPage() {
  const { client } = useConfig();
  const [kalender, setKalender] = useState<WartungKalenderDto[]>([]);
  const [regeln, setRegeln] = useState<WartungRegelDto[]>([]);
  const [meldung, setMeldung] = useState<{ ok: boolean; text: string } | null>(null);
  const [busy, setBusy] = useState(false);
  const [k, setK] = useState({ art: 'fenster', name: '', regelArt: 'woechentlich', tage: [1, 2, 3, 4, 5] as number[], von: '22:00', bis: '06:00', vonDatum: '', bisDatum: '', fuer: '', notiz: '' });
  const [r, setR] = useState({ name: '', owner: true, nutzer: '', emails: '', haDienst: '', kanaele: ['push', 'telegram'] as string[], zeitpunkte: ['24h_vorher', 'start', 'ende', 'stoerung'] as string[], fuer: '' });

  const laden = useCallback(async () => {
    if (!client) return;
    const x = await client.wartung().catch(() => null);
    if (x?.success && x.data) { setKalender(x.data.kalender); setRegeln(x.data.regeln); }
    else if (x && !x.success) setMeldung({ ok: false, text: x.error ?? 'Laden fehlgeschlagen' });
  }, [client]);
  useEffect(() => { void laden(); }, [laden]);

  const ausfuehren = async (b: Record<string, unknown>) => {
    if (!client) return;
    setBusy(true);
    const x = await client.wartungAktion(b).catch((e: Error) => ({ success: false, error: e.message }));
    setBusy(false);
    setMeldung({ ok: x.success, text: x.success ? ((x as { display?: string }).display ?? 'Gespeichert.') : (x.error ?? 'Fehler') });
    if (x.success) await laden();
  };
  const kalenderAnlegen = () => ausfuehren({
    action: k.art === 'fenster' ? 'fenster_anlegen' : 'sperre_anlegen', name: k.name, fuer: liste(k.fuer), ...(k.notiz ? { notiz: k.notiz } : {}),
    regel: k.regelArt === 'woechentlich' ? { art: 'woechentlich', tage: k.tage, von: k.von, bis: k.bis } : { art: 'einmalig', von: k.vonDatum ? new Date(k.vonDatum).toISOString() : '', bis: k.bisDatum ? new Date(k.bisDatum).toISOString() : '' },
  });
  const regelAnlegen = () => ausfuehren({
    action: 'benachrichtigung_anlegen', name: r.name, fuer: liste(r.fuer), kanaele: r.kanaele, zeitpunkte: r.zeitpunkte,
    empfaenger: [
      ...(r.owner ? [{ art: 'owner', name: 'Owner' }] : []),
      ...liste(r.nutzer).map(name => ({ art: 'nutzer', name, ...(r.haDienst ? { haDienst: r.haDienst } : {}) })),
      ...liste(r.emails).map(email => ({ art: 'kontakt', name: email, email })),
      ...(r.haDienst && !liste(r.nutzer).length ? [{ art: 'kontakt', name: `HA ${r.haDienst}`, haDienst: r.haDienst }] : []),
    ],
  });
  const entfernen = (id: string, name: string) => { if (confirm(`„${name}“ entfernen?`)) void ausfuehren({ action: 'wartung_entfernen', id }); };
  const umschalten = <T,>(arr: T[], x: T) => (arr.includes(x) ? arr.filter(y => y !== x) : [...arr, x]);

  return (
    <div className="p-6 max-w-5xl space-y-6">
      <div>
        <h1 className="text-xl font-semibold text-gray-100">Wartung</h1>
        <p className="text-sm text-gray-500 mt-1">Wann Alfred freigegebene Infrastruktur-Changes ausführen darf, wann nicht, und wer wann wie informiert wird. Ohne Wartungsfenster dürfen Changes jederzeit starten (außer in Sperrzeiten); Notfall-Changes sind ausgenommen.</p>
      </div>
      {meldung && <div className={`text-sm rounded px-3 py-2 ${meldung.ok ? 'bg-green-500/10 text-green-300' : 'bg-red-500/10 text-red-300'}`}>{meldung.text}</div>}

      {(['fenster', 'sperre'] as const).map(art => (
        <section key={art} className="bg-[#111111] border border-[#1f1f1f] rounded-xl p-4">
          <h2 className="text-sm font-semibold text-gray-300 mb-2">{art === 'fenster' ? 'Wartungsfenster' : 'Sperrzeiten'}</h2>
          {kalender.filter(e => e.art === art).length === 0 && <p className="text-xs text-gray-500">Keine.</p>}
          {kalender.filter(e => e.art === art).map(e => (
            <div key={e.id} className="flex items-center justify-between text-sm py-1 border-t border-[#1f1f1f]">
              <span className={e.aktiv ? 'text-gray-200' : 'text-gray-500 line-through'}><strong>{e.name}</strong> — {regelText(e.regel)} · {geltungText(e.geltung)}{e.notiz ? ` · ${e.notiz}` : ''}</span>
              <button disabled={busy} onClick={() => entfernen(e.id, e.name)} className="text-xs text-red-400 hover:text-red-300">entfernen</button>
            </div>
          ))}
        </section>
      ))}

      <section className="bg-[#111111] border border-[#1f1f1f] rounded-xl p-4 space-y-2">
        <h2 className="text-sm font-semibold text-gray-300">Neues Fenster / neue Sperre</h2>
        <div className="grid grid-cols-2 gap-2">
          <select className={feld} value={k.art} onChange={e => setK({ ...k, art: e.target.value })}><option value="fenster">Wartungsfenster</option><option value="sperre">Sperrzeit</option></select>
          <input className={feld} placeholder="Name, z. B. werktags nachts" value={k.name} onChange={e => setK({ ...k, name: e.target.value })} />
          <select className={feld} value={k.regelArt} onChange={e => setK({ ...k, regelArt: e.target.value })}><option value="woechentlich">wöchentlich</option><option value="einmalig">einmalig</option></select>
          <input className={feld} placeholder="gilt für Assets (Komma), leer = alle" value={k.fuer} onChange={e => setK({ ...k, fuer: e.target.value })} />
        </div>
        {k.regelArt === 'woechentlich' ? (
          <div className="flex flex-wrap items-center gap-3 text-sm text-gray-300">
            {TAGE.map((t, i) => <label key={t} className="flex items-center gap-1"><input type="checkbox" checked={k.tage.includes(i)} onChange={() => setK({ ...k, tage: umschalten(k.tage, i) })} />{t}</label>)}
            <input className="bg-[#0a0a0a] border border-[#1f1f1f] rounded px-2 py-1 w-20" value={k.von} onChange={e => setK({ ...k, von: e.target.value })} />–
            <input className="bg-[#0a0a0a] border border-[#1f1f1f] rounded px-2 py-1 w-20" value={k.bis} onChange={e => setK({ ...k, bis: e.target.value })} />
            <span className="text-xs text-gray-500">Wiener Zeit; bis &lt; von = über Mitternacht</span>
          </div>
        ) : (
          <div className="grid grid-cols-2 gap-2"><input type="datetime-local" className={feld} value={k.vonDatum} onChange={e => setK({ ...k, vonDatum: e.target.value })} /><input type="datetime-local" className={feld} value={k.bisDatum} onChange={e => setK({ ...k, bisDatum: e.target.value })} /></div>
        )}
        <input className={feld} placeholder="Notiz (optional)" value={k.notiz} onChange={e => setK({ ...k, notiz: e.target.value })} />
        <button disabled={busy || !k.name} onClick={() => void kalenderAnlegen()} className="px-3 py-1.5 text-xs bg-blue-600 hover:bg-blue-500 text-white rounded disabled:opacity-50">Anlegen</button>
      </section>

      <section className="bg-[#111111] border border-[#1f1f1f] rounded-xl p-4">
        <h2 className="text-sm font-semibold text-gray-300 mb-2">Benachrichtigungen</h2>
        {regeln.length === 0 && <p className="text-xs text-gray-500">Keine — informiert wird nur der Owner (Start, Ende, Anhalten).</p>}
        {regeln.map(x => (
          <div key={x.id} className="flex items-center justify-between text-sm py-1 border-t border-[#1f1f1f]">
            <span className={x.aktiv ? 'text-gray-200' : 'text-gray-500 line-through'}><strong>{x.name}</strong> — {x.empfaenger.map(e => e.name ?? e.art).join(', ')} über {x.kanaele.map(c => KANAELE[c] ?? c).join(', ')} · {x.zeitpunkte.map(z => ZEITPUNKTE[z] ?? z).join(', ')} · {geltungText(x.geltung)}</span>
            <button disabled={busy} onClick={() => entfernen(x.id, x.name)} className="text-xs text-red-400 hover:text-red-300">entfernen</button>
          </div>
        ))}
      </section>

      <section className="bg-[#111111] border border-[#1f1f1f] rounded-xl p-4 space-y-2">
        <h2 className="text-sm font-semibold text-gray-300">Neue Benachrichtigung</h2>
        <div className="grid grid-cols-2 gap-2">
          <input className={feld} placeholder="Name, z. B. Familie bei Home Assistant" value={r.name} onChange={e => setR({ ...r, name: e.target.value })} />
          <input className={feld} placeholder="gilt für Assets (Komma), leer = alle" value={r.fuer} onChange={e => setR({ ...r, fuer: e.target.value })} />
          <input className={feld} placeholder="Alfred-Benutzer (Komma), z. B. alex" value={r.nutzer} onChange={e => setR({ ...r, nutzer: e.target.value })} />
          <input className={feld} placeholder="weitere E-Mail-Adressen (Komma)" value={r.emails} onChange={e => setR({ ...r, emails: e.target.value })} />
          <input className={feld} placeholder="Home-Assistant notify-Ziel (optional), z. B. mobile_app_…" value={r.haDienst} onChange={e => setR({ ...r, haDienst: e.target.value })} />
          <label className="flex items-center gap-2 text-sm text-gray-300"><input type="checkbox" checked={r.owner} onChange={e => setR({ ...r, owner: e.target.checked })} />auch mich (Owner)</label>
        </div>
        <div className="flex flex-wrap gap-3 text-sm text-gray-300">{Object.entries(KANAELE).map(([kk, t]) => <label key={kk} className="flex items-center gap-1"><input type="checkbox" checked={r.kanaele.includes(kk)} onChange={() => setR({ ...r, kanaele: umschalten(r.kanaele, kk) })} />{t}</label>)}</div>
        <div className="flex flex-wrap gap-3 text-sm text-gray-300">{Object.entries(ZEITPUNKTE).map(([z, t]) => <label key={z} className="flex items-center gap-1"><input type="checkbox" checked={r.zeitpunkte.includes(z)} onChange={() => setR({ ...r, zeitpunkte: umschalten(r.zeitpunkte, z) })} />{t}</label>)}</div>
        <p className="text-xs text-gray-500">„24 h vorher“ bzw. „1 h vorher“ verschiebt den Start: Alfred kündigt den Termin an und beginnt frühestens nach der Vorlaufzeit.</p>
        <button disabled={busy || !r.name} onClick={() => void regelAnlegen()} className="px-3 py-1.5 text-xs bg-blue-600 hover:bg-blue-500 text-white rounded disabled:opacity-50">Anlegen</button>
      </section>
    </div>
  );
}
