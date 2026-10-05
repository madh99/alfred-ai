'use client';

/**
 * v1185 — Jarvis Schicht 3: Kachel „Vorgänge".
 *
 * Zeigt, woran Alfred arbeitet und was der Owner entscheiden muss: offene
 * Vorgänge mit Besitzer, Autonomie-Klasse, nächstem Schritt und Frist, die in
 * den letzten 7 Tagen abgeschlossenen Vorgänge und das Ausführungsgedächtnis
 * (Schritte der letzten 14 Tage). Reine Anzeige aus vorgaenge + vorgang_schritte.
 */
import { useEffect, useState, useCallback } from 'react';
import clsx from 'clsx';
import { useConfig } from '@/context/ConfigContext';
import type { VorgaengeStatus, VorgangDto, VorgangSchrittDto } from '@/lib/alfred-client';

function alter(iso?: string | null): string {
  if (!iso) return '—';
  const min = Math.round((Date.now() - new Date(iso).getTime()) / 60_000);
  if (Number.isNaN(min)) return '—';
  if (min < 1) return 'gerade eben';
  if (min < 60) return `vor ${min} min`;
  if (min < 48 * 60) return `vor ${Math.round(min / 60)} h`;
  return `vor ${Math.round(min / 1440)} Tagen`;
}

function fristText(iso?: string): { text: string; knapp: boolean } {
  if (!iso) return { text: '—', knapp: false };
  const h = (new Date(iso).getTime() - Date.now()) / 3_600_000;
  if (Number.isNaN(h)) return { text: '—', knapp: false };
  if (h < 0) return { text: 'abgelaufen', knapp: true };
  if (h < 24) return { text: `noch ${Math.max(1, Math.round(h))} h`, knapp: true };
  return { text: `noch ${Math.round(h / 24)} Tage`, knapp: false };
}

const AUTONOMIE_LABEL: Record<VorgangDto['autonomie'], string> = { auto: 'automatisch', bestaetigen: 'mit Bestätigung', nie: 'nur manuell' };
const STATUS_LABEL: Record<VorgangDto['status'], string> = { offen: 'offen', wartet: 'wartet', erledigt: 'erledigt', verworfen: 'verworfen' };
const ART_LABEL: Record<string, string> = {
  vorgeschlagen: 'vorgeschlagen', ausgefuehrt: 'ausgeführt', zur_bestaetigung: 'zur Bestätigung', bestaetigt: 'bestätigt', abgelehnt: 'abgelehnt',
  fehlgeschlagen: 'fehlgeschlagen', blockiert: 'blockiert', uebersprungen: 'übersprungen', notiz: 'Notiz',
};

function artFarbe(art: string): string {
  if (art === 'ausgefuehrt' || art === 'bestaetigt') return 'text-emerald-400';
  if (art === 'fehlgeschlagen' || art === 'blockiert' || art === 'abgelehnt') return 'text-red-400';
  if (art === 'zur_bestaetigung') return 'text-amber-300';
  return 'text-gray-400';
}

function VorgangZeile({ v, onEntscheid, busy }: { v: VorgangDto; onEntscheid: (id: string, status: 'erledigt' | 'verworfen') => void; busy: boolean }) {
  const frist = fristText(v.frist);
  return (
    <tr className="border-t border-[#1a1a1a] align-top">
      <td className="py-1.5 pr-3">
        <div className="text-gray-200">{v.titel}</div>
        {v.naechsterSchritt && <div className="text-[11px] text-gray-500">nächster Schritt: {v.naechsterSchritt}</div>}
        {v.ergebnis && <div className="text-[11px] text-gray-500">Ergebnis: {v.ergebnis}</div>}
      </td>
      <td className="py-1.5 pr-3 text-gray-400">{v.besitzer === 'alfred' ? 'Alfred' : 'Owner'}</td>
      <td className="py-1.5 pr-3 text-gray-400">{AUTONOMIE_LABEL[v.autonomie] ?? v.autonomie}</td>
      <td className="py-1.5 pr-3 text-gray-400">{v.kategorie ? `${v.quelle} · ${v.kategorie}` : v.quelle}</td>
      <td className={clsx('py-1.5 pr-3', frist.knapp ? 'text-amber-300' : 'text-gray-400')}>{frist.text}</td>
      <td className="py-1.5 pr-3 text-gray-500 whitespace-nowrap">{alter(v.aktualisiert)}</td>
      <td className="py-1.5 whitespace-nowrap">
        {/* v1186 — Entscheidung des Owners = Ergebnis-Signal für die Erledigungsquote */}
        <button disabled={busy} onClick={() => onEntscheid(v.id, 'erledigt')} className="px-2 py-0.5 text-[11px] rounded border border-emerald-500/40 text-emerald-300 hover:bg-emerald-500/10 disabled:opacity-40 mr-1">Erledigt</button>
        <button disabled={busy} onClick={() => onEntscheid(v.id, 'verworfen')} className="px-2 py-0.5 text-[11px] rounded border border-[#2a2a2a] text-gray-400 hover:text-gray-200 disabled:opacity-40">Verwerfen</button>
      </td>
    </tr>
  );
}

export function VorgaengePage() {
  const { client } = useConfig();
  const [data, setData] = useState<VorgaengeStatus | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const d = await client.fetchVorgaenge();
      setData(d);
      setError(d ? null : 'Keine Daten (Endpoint nicht verfügbar)');
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setLoading(false);
    }
  }, [client]);

  useEffect(() => {
    load();
    const t = setInterval(load, 60_000);
    return () => clearInterval(t);
  }, [load]);

  const [busy, setBusy] = useState(false);
  const entscheide = useCallback(async (id: string, status: 'erledigt' | 'verworfen') => {
    setBusy(true);
    try {
      await client.entscheideVorgang(id, status);
      await load();
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(false);
    }
  }, [client, load]);

  const offene = data?.offene ?? [];
  const owner = offene.filter(v => v.besitzer === 'user');
  const alfred = offene.filter(v => v.besitzer === 'alfred');

  return (
    <div className="p-6 max-w-5xl mx-auto space-y-6">
      <div className="flex items-center justify-between">
        <h1 className="text-xl font-semibold text-gray-200">🗂️ Vorgänge</h1>
        <button onClick={load} className="px-2.5 py-1 text-xs rounded border border-[#1f1f1f] text-gray-500 hover:text-gray-300">Aktualisieren</button>
      </div>

      {loading && !data && <div className="text-gray-500 text-sm">Laden…</div>}
      {error && <div className="text-red-400 text-sm">Fehler: {error}</div>}

      {data && (
        <>
          <div className={clsx('rounded-lg px-4 py-2.5 text-xs border', owner.length ? 'bg-amber-500/5 border-amber-500/30 text-amber-200' : 'bg-emerald-500/5 border-emerald-500/30 text-emerald-300')}>
            {owner.length === 0
              ? '✅ Nichts wartet auf eine Entscheidung des Owners.'
              : `${owner.length} Vorgang${owner.length === 1 ? '' : 'e'} wartet${owner.length === 1 ? '' : 'en'} auf den Owner · ${alfred.length} bei Alfred`}
          </div>

          <section className="bg-[#111111] border border-[#1f1f1f] rounded-xl p-4">
            <h2 className="text-sm font-semibold text-gray-300 mb-1">Offen</h2>
            <div className="text-xs text-gray-500 mb-3">Vorgänge mit Besitzer, Autonomie-Klasse (Freigabe 05.10.), nächstem Schritt und Frist. Nach Ablauf der Frist ohne Entscheidung werden sie verworfen.</div>
            {offene.length === 0 && <div className="text-xs text-gray-500">Keine offenen Vorgänge.</div>}
            {offene.length > 0 && (
              <table className="w-full text-xs">
                <thead className="text-gray-500 text-left">
                  <tr><th className="py-1 pr-3">Vorgang</th><th className="py-1 pr-3">Besitzer</th><th className="py-1 pr-3">Autonomie</th><th className="py-1 pr-3">Quelle</th><th className="py-1 pr-3">Frist</th><th className="py-1 pr-3">Aktualisiert</th><th className="py-1">Entscheidung</th></tr>
                </thead>
                <tbody>{offene.map(v => <VorgangZeile key={v.id} v={v} onEntscheid={entscheide} busy={busy} />)}</tbody>
              </table>
            )}
          </section>

          <section className="bg-[#111111] border border-[#1f1f1f] rounded-xl p-4">
            <h2 className="text-sm font-semibold text-gray-300 mb-3">Abgeschlossen (7 Tage)</h2>
            {data.abgeschlossene.length === 0 && <div className="text-xs text-gray-500">Noch nichts abgeschlossen.</div>}
            {data.abgeschlossene.length > 0 && (
              <table className="w-full text-xs">
                <thead className="text-gray-500 text-left">
                  <tr><th className="py-1 pr-3">Vorgang</th><th className="py-1 pr-3">Status</th><th className="py-1 pr-3">Quelle</th><th className="py-1">Abgeschlossen</th></tr>
                </thead>
                <tbody className="text-gray-300">
                  {data.abgeschlossene.map(v => (
                    <tr key={v.id} className="border-t border-[#1a1a1a] align-top">
                      <td className="py-1.5 pr-3">
                        <div>{v.titel}</div>
                        {v.ergebnis && <div className="text-[11px] text-gray-500">{v.ergebnis}</div>}
                      </td>
                      <td className={clsx('py-1.5 pr-3', v.status === 'erledigt' ? 'text-emerald-400' : 'text-gray-500')}>{STATUS_LABEL[v.status]}</td>
                      <td className="py-1.5 pr-3 text-gray-400">{v.quelle}</td>
                      <td className="py-1.5 text-gray-500 whitespace-nowrap">{alter(v.aktualisiert)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            )}
          </section>

          <section className="bg-[#111111] border border-[#1f1f1f] rounded-xl p-4">
            <h2 className="text-sm font-semibold text-gray-300 mb-1">Ausführungsgedächtnis (14 Tage)</h2>
            <div className="text-xs text-gray-500 mb-3">Jeder Ausgang einer vorgeschlagenen Aktion. Dieselbe Liste speist den Reasoning-Kontext als „Bereits getan".</div>
            {data.schritte.length === 0 && <div className="text-xs text-gray-500">Noch keine Schritte.</div>}
            {data.schritte.length > 0 && (
              <table className="w-full text-xs">
                <thead className="text-gray-500 text-left">
                  <tr><th className="py-1 pr-3">Zeit</th><th className="py-1 pr-3">Ausgang</th><th className="py-1 pr-3">Skill</th><th className="py-1">Aktion</th></tr>
                </thead>
                <tbody className="text-gray-300">
                  {data.schritte.map((s: VorgangSchrittDto) => (
                    <tr key={s.id} className="border-t border-[#1a1a1a] align-top">
                      <td className="py-1 pr-3 text-gray-500 whitespace-nowrap">{alter(s.zeit)}</td>
                      <td className={clsx('py-1 pr-3 whitespace-nowrap', artFarbe(s.art))}>{ART_LABEL[s.art] ?? s.art}</td>
                      <td className="py-1 pr-3 text-gray-400 whitespace-nowrap">{s.skill ?? '—'}{s.aktion ? `/${s.aktion}` : ''}</td>
                      <td className="py-1">
                        <div>{s.beschreibung}</div>
                        {s.ergebnis && <div className="text-[11px] text-gray-500">{s.ergebnis}</div>}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            )}
          </section>
        </>
      )}
    </div>
  );
}
