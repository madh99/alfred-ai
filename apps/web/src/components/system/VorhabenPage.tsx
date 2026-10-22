'use client';

/**
 * Vorhaben-Übersicht (Owner 22.10.2026: „ich sehe die Changes nirgends — was ist geplant?“): Infrastruktur-Vorhaben mit Ziel, Status,
 * Zielarchitektur (Dokument), zugehörigen Changes, Entscheidungen, Einwänden und Soll/Ist. Nur lesend; freigeben und widersprechen
 * im ITSM bzw. per Freigabe-Frage.
 */
import { useEffect, useState, useCallback } from 'react';
import { useConfig } from '@/context/ConfigContext';
import type { ChangeKurzDto, EinwandDto, VorhabenDto } from '@/lib/alfred-client';

const STATUS: Record<string, string> = { entwurf: 'Entwurf', architektur_vorgeschlagen: 'Architektur vorgeschlagen', angenommen: 'angenommen', verworfen: 'verworfen' };
const CHANGE: Record<string, string> = { draft: 'Entwurf', submitted: 'wartet auf Freigabe', approved: 'freigegeben', in_progress: 'läuft', completed: 'abgeschlossen', failed: 'fehlgeschlagen', rolled_back: 'zurückgerollt', cancelled: 'abgebrochen' };
const farbe = (s: string) => ({ submitted: 'text-amber-300', approved: 'text-emerald-300', in_progress: 'text-blue-300', completed: 'text-gray-400', failed: 'text-red-400', rolled_back: 'text-red-300', cancelled: 'text-gray-500', draft: 'text-gray-400' } as Record<string, string>)[s] ?? 'text-gray-300';

function ChangeZeilen({ changes }: { changes: ChangeKurzDto[] }) {
  if (!changes.length) return <p className="text-xs text-gray-500">Noch keine Changes.</p>;
  return (
    <table className="w-full text-xs">
      <thead><tr className="text-gray-500 text-left"><th className="pr-2">Change</th><th className="pr-2">Status</th><th className="pr-2">Typ</th><th className="pr-2">Schritte</th><th>Geplant</th></tr></thead>
      <tbody>{changes.map(c => (
        <tr key={c.id} className="border-t border-[#1f1f1f]">
          <td className="pr-2 py-1 text-gray-200">{c.titel} <span className="text-gray-600 font-mono">{c.id.slice(0, 8)}</span></td>
          <td className={`pr-2 py-1 ${farbe(c.status)}`}>{CHANGE[c.status] ?? c.status}{c.phase === 'angehalten' ? ' (angehalten)' : c.phase === 'wartet_owner' ? ' (wartet auf dich)' : ''}</td>
          <td className="pr-2 py-1 text-gray-400">{c.typ}{c.freigegebenUeber?.startsWith('standard:') ? ' · Vorlage' : ''}</td>
          <td className="pr-2 py-1 text-gray-400">{c.schritte}</td>
          <td className="py-1 text-gray-400">{c.geplantAb ? new Date(c.geplantAb).toLocaleString('de-AT') : '—'}</td>
        </tr>
      ))}</tbody>
    </table>
  );
}

const PHASE: Record<string, string> = { laeuft: 'läuft', angehalten: 'angehalten — wartet auf deine Entscheidung', wartet_owner: 'wartet auf deinen Handgriff', rueckweg: 'Rückweg läuft', fertig: 'fertig' };

/** Owner 22.10.: laufende und angehaltene Changes sofort sichtbar — welcher Schritt, wie weit, was ist los, was kann ich tun */
function AktiveChanges({ changes }: { changes: ChangeKurzDto[] }) {
  if (!changes.length) return <div className="text-sm rounded-xl px-4 py-3 bg-[#111111] border border-[#1f1f1f] text-gray-400">Gerade läuft kein Change.</div>;
  return (
    <div className="space-y-3">
      {changes.map(c => {
        const l = c.lauf;
        const angehalten = c.phase === 'angehalten';
        const farbeRahmen = angehalten ? 'border-amber-500/50' : c.phase === 'rueckweg' ? 'border-red-500/50' : 'border-blue-500/50';
        const kurzId = c.id.slice(0, 8);
        const minuten = l?.start ? Math.round((Date.now() - Date.parse(l.start)) / 60_000) : null;
        return (
          <section key={c.id} className={`bg-[#111111] border ${farbeRahmen} rounded-xl p-4 space-y-2`}>
            <div className="flex items-center justify-between gap-3">
              <h2 className="text-sm font-semibold text-gray-100">{c.titel} <span className="text-gray-600 font-mono">{kurzId}</span></h2>
              <span className={`text-xs ${angehalten ? 'text-amber-300' : 'text-blue-300'}`}>{PHASE[c.phase ?? ''] ?? c.phase ?? c.status}{minuten !== null ? ` · seit ${minuten} min` : ''}</span>
            </div>
            {l && <p className="text-xs text-gray-300">Schritt {l.schritt ?? '?'} von {c.schritte}{l.schrittTitel ? `: ${l.schrittTitel}` : ''} · {l.fertig} erledigt</p>}
            {l && (
              <div className="flex gap-1">
                {l.schrittListe.map(s => <span key={s.nr} title={`${s.nr}. ${s.titel}`} className={`h-2 flex-1 rounded ${s.ok === true ? 'bg-emerald-500' : s.ok === false ? 'bg-red-500' : s.nr === l.schritt ? 'bg-blue-400 animate-pulse' : 'bg-[#2a2a2a]'}`} />)}
              </div>
            )}
            {angehalten && l?.grund && <p className="text-xs text-amber-200 whitespace-pre-wrap">{l.grund}</p>}
            {angehalten && <p className="text-xs text-gray-400">Im Chat: „Change {kurzId} Schritt wiederholen“ · „Change {kurzId} abbrechen“ · „Change {kurzId} Rückweg ausführen“</p>}
          </section>
        );
      })}
    </div>
  );
}

export function VorhabenPage() {
  const { client } = useConfig();
  const [liste, setListe] = useState<{ vorhaben: VorhabenDto[]; ohneVorhaben: ChangeKurzDto[] } | null>(null);
  const [offen, setOffen] = useState<string | null>(null);
  const [detail, setDetail] = useState<Awaited<ReturnType<NonNullable<typeof client>['vorhabenDetail']>> | null>(null);
  const [sollIst, setSollIst] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [fehler, setFehler] = useState<string | null>(null);

  const laden = useCallback(async () => {
    if (!client) return;
    const x: Awaited<ReturnType<typeof client.vorhabenListe>> = await client.vorhabenListe().catch((e: Error) => ({ error: e.message }));
    if (x.error) { setFehler(x.error); return; }
    setListe({ vorhaben: x.vorhaben ?? [], ohneVorhaben: x.ohneVorhaben ?? [] });
  }, [client]);
  useEffect(() => { void laden(); }, [laden]);
  // laufende Changes: alle 10 s neu laden
  useEffect(() => { const t = setInterval(() => { void laden(); }, 10_000); return () => clearInterval(t); }, [laden]);
  const aktiv = liste ? [...liste.vorhaben.flatMap(v => v.changes ?? []), ...liste.ohneVorhaben].filter(c => c.status === 'in_progress') : [];

  const oeffne = async (id: string) => {
    if (!client) return;
    if (offen === id) { setOffen(null); setDetail(null); return; }
    setOffen(id); setDetail(null); setSollIst(null);
    setDetail(await client.vorhabenDetail(id).catch(() => null));
  };
  const abgleich = async (id: string) => {
    if (!client) return;
    setBusy(true);
    const r: Awaited<ReturnType<typeof client.vorhabenSollIst>> = await client.vorhabenSollIst(id).catch((e: Error) => ({ error: e.message }));
    setBusy(false);
    setSollIst(r.error ? `Fehler: ${r.error}` : (r.text ?? ''));
  };

  return (
    <div className="p-6 max-w-5xl space-y-6">
      <div>
        <h1 className="text-xl font-semibold text-gray-100">Vorhaben</h1>
        <p className="text-sm text-gray-500 mt-1">Was an der Infrastruktur geplant ist: Ziel, Zielarchitektur, Changes und wie weit Soll und Ist auseinanderliegen. Freigeben und widersprechen per Freigabe-Frage oder unter ITSM → Changes.</p>
      </div>
      {fehler && <div className="text-sm rounded px-3 py-2 bg-red-500/10 text-red-300">{fehler}</div>}
      {liste && <div><h2 className="text-sm font-semibold text-gray-300 mb-2">Jetzt aktiv</h2><AktiveChanges changes={aktiv} /></div>}
      {liste?.vorhaben.length === 0 && <p className="text-sm text-gray-500">Noch keine Vorhaben.</p>}
      {liste?.vorhaben.map(v => (
        <section key={v.id} className="bg-[#111111] border border-[#1f1f1f] rounded-xl p-4 space-y-3">
          <button onClick={() => void oeffne(v.id)} className="w-full text-left">
            <div className="flex items-center justify-between">
              <h2 className="text-base font-semibold text-gray-100">{v.titel}</h2>
              <span className="text-xs text-gray-400">{STATUS[v.status] ?? v.status} · Architektur v{v.architekturVersion} · {v.changes?.length ?? 0} Changes</span>
            </div>
            <p className="text-sm text-gray-400 mt-1">{v.ziel}</p>
          </button>
          {offen === v.id && (
            <div className="space-y-4">
              {!detail && <p className="text-xs text-gray-500">Lade …</p>}
              {detail?.vorhaben && (<>
                <div>
                  <h3 className="text-xs font-semibold text-gray-400 mb-1">Changes</h3>
                  <ChangeZeilen changes={detail.changes ?? []} />
                </div>
                {detail.vorhaben.status === 'angenommen' && (
                  <div>
                    <button disabled={busy} onClick={() => void abgleich(v.id)} className="px-3 py-1.5 text-xs bg-blue-600 hover:bg-blue-500 text-white rounded disabled:opacity-50">{busy ? 'Gleiche ab …' : 'Soll/Ist abgleichen'}</button>
                    {sollIst && <pre className="mt-2 text-xs text-gray-300 whitespace-pre-wrap bg-[#0a0a0a] border border-[#1f1f1f] rounded p-3 max-h-96 overflow-y-auto">{sollIst}</pre>}
                  </div>
                )}
                {(detail.vorhaben.entscheidungen ?? []).length > 0 && (
                  <div>
                    <h3 className="text-xs font-semibold text-gray-400 mb-1">Deine Entscheidungen</h3>
                    {detail.vorhaben.entscheidungen.map((e, i) => <p key={i} className="text-xs text-gray-300">{new Date(e.zeit).toLocaleString('de-AT')} · {e.entscheidung} (v{e.architekturVersion}): „{e.wortlaut}“</p>)}
                  </div>
                )}
                {(detail.einwaende ?? []).length > 0 && (
                  <div>
                    <h3 className="text-xs font-semibold text-gray-400 mb-1">Einwände</h3>
                    {(detail.einwaende as EinwandDto[]).map(e => <p key={e.id} className="text-xs text-gray-300">{e.status} · {e.bezug}: „{e.text}“{e.antwort ? ` → ${e.antwortArt}: ${e.antwort}` : ''}</p>)}
                  </div>
                )}
                {detail.architektur && (
                  <details>
                    <summary className="text-xs font-semibold text-gray-400 cursor-pointer">Zielarchitektur (Version {detail.architektur.version})</summary>
                    <pre className="mt-2 text-xs text-gray-300 whitespace-pre-wrap bg-[#0a0a0a] border border-[#1f1f1f] rounded p-3 max-h-[32rem] overflow-y-auto">{detail.architektur.inhalt}</pre>
                  </details>
                )}
              </>)}
            </div>
          )}
        </section>
      ))}
      {liste && liste.ohneVorhaben.length > 0 && (
        <section className="bg-[#111111] border border-[#1f1f1f] rounded-xl p-4">
          <h2 className="text-sm font-semibold text-gray-300 mb-2">Changes ohne Vorhaben (Proben, Standard-Changes)</h2>
          <ChangeZeilen changes={liste.ohneVorhaben} />
        </section>
      )}
    </div>
  );
}
