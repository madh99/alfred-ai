'use client';

/**
 * v1185 — Jarvis Schicht 3: Kachel „Vorgänge".
 *
 * v1487 — wie die App (vorgaenge_ansicht.dart): offene Vorgänge gruppiert in „Für dich“, „Bei Alfred“ und
 * „Zurückgestellt“, je Vorgang Ausführen (vorgeschlagene Aktion, mit Bestätigung), Später, Abschließen
 * („Was war es?“ / „Und künftig?“) und Nachfragen (Chat mit vorbelegtem Text). Ähnliche Titel werden markiert.
 * Erledigt/Verwerfen entfällt — die App kennt dafür nur noch Abschließen. Deep-Link ?id=<vorgang> öffnet das Detail.
 */
import { useEffect, useState, useCallback, useRef } from 'react';
import clsx from 'clsx';
import { useConfig } from '@/context/ConfigContext';
import { ABGLEICH_MS, AbgleichHinweis, kurz, mitNeuen, verschwundeneIds } from '@/components/abgleich/Abgleich'; // v1494
import type { VorgaengeStatus, VorgangDto, VorgangSchrittDto } from '@/lib/alfred-client';
import {
  AusfuehrenDialog, SpaeterMenue, VorgangDetail, chatLink, datum, knopfAusfuehren, knopfNeutral, knopfPrimaer, zurueckBis,
} from '@/components/vorgaenge/vorgang-dialoge';

function alter(iso?: string | null): string {
  if (!iso) return '—';
  const min = Math.round((Date.now() - new Date(iso).getTime()) / 60_000);
  if (Number.isNaN(min)) return '—';
  if (min < 1) return 'gerade eben';
  if (min < 60) return `vor ${min} min`;
  if (min < 48 * 60) return `vor ${Math.round(min / 60)} h`;
  return `vor ${Math.round(min / 1440)} Tagen`;
}

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

/** v1487 — Gruppen wie App: zurückgestellte zuerst aussortiert; „für dich“ = wartet oder beim Owner; nach Frist sortiert. */
function gruppen(offene: VorgangDto[], jetzt: number) {
  const fuerDich: VorgangDto[] = [], beiAlfred: VorgangDto[] = [], zurueck: VorgangDto[] = [];
  for (const v of offene) {
    if (zurueckBis(v, jetzt)) { zurueck.push(v); continue; }
    (v.status === 'wartet' || v.besitzer === 'user' ? fuerDich : beiAlfred).push(v);
  }
  const frist = (v: VorgangDto) => { const t = v.frist ? new Date(v.frist).getTime() : NaN; return Number.isNaN(t) ? Number.MAX_SAFE_INTEGER : t; };
  fuerDich.sort((a, b) => frist(a) - frist(b));
  zurueck.sort((a, b) => (a.zurueckBis ?? '').localeCompare(b.zurueckBis ?? ''));
  return { fuerDich, beiAlfred, zurueck };
}

const woerter = (t: string) => new Set(t.toLowerCase().replace(/[^a-zäöüß0-9 ]/g, ' ').split(/\s+/).filter(w => w.length >= 4));

/** v1487 — ähnliche offene Vorgänge (wie App): ≥ 2 gemeinsame Wörter und mindestens die Hälfte des kürzeren Titels. */
function aehnliche(offene: VorgangDto[]): Map<string, string> {
  const aus = new Map<string, string>();
  const w = offene.map(v => woerter(v.titel ?? ''));
  for (let i = 0; i < offene.length; i++) {
    for (let j = i + 1; j < offene.length; j++) {
      let gemeinsam = 0;
      w[i].forEach(x => { if (w[j].has(x)) gemeinsam++; });
      const kleiner = Math.min(w[i].size, w[j].size);
      if (gemeinsam >= 2 && kleiner > 0 && gemeinsam * 2 >= kleiner) {
        if (!aus.has(offene[i].id)) aus.set(offene[i].id, offene[j].titel);
        if (!aus.has(offene[j].id)) aus.set(offene[j].id, offene[i].titel);
      }
    }
  }
  return aus;
}

function Zustand({ v, jetzt }: { v: VorgangDto; jetzt: number }) {
  const zb = zurueckBis(v, jetzt);
  const [text, farbe] = zb ? [`zurückgestellt bis ${datum(v.zurueckBis)}`, 'bg-gray-500/15 text-gray-400']
    : v.status === 'wartet' ? ['wartet auf dich', 'bg-amber-500/15 text-amber-300']
    : v.besitzer === 'user' ? ['bei dir', 'bg-sky-500/15 text-sky-300']
    : ['bei Alfred', 'bg-violet-500/15 text-violet-300'];
  return <span className={clsx('px-2 py-0.5 rounded-full text-[11px] font-semibold whitespace-nowrap', farbe)}>{text}</span>;
}

export function VorgaengePage() {
  const { client } = useConfig();
  const [data, setData] = useState<VorgaengeStatus | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [meldungen, setMeldungen] = useState<{ id: number; text: string }[]>([]);
  const [detail, setDetail] = useState<VorgangDto | null>(null);
  const [ausfuehren, setAusfuehren] = useState<VorgangDto | null>(null);
  const [zurueckZeigen, setZurueckZeigen] = useState(false);
  const [erledigtZeigen, setErledigtZeigen] = useState(false);
  const [schritteZeigen, setSchritteZeigen] = useState(false);
  const [busy, setBusy] = useState(false);
  const deepLinkErledigt = useRef(false);
  // v1494 — Abgleich: was zwischen zwei Abfragen anderswo erledigt wurde, nennen statt stumm verschwinden lassen
  const vorherRef = useRef<Map<string, string> | null>(null);
  const [inzwischen, setInzwischen] = useState<string[]>([]);

  const load = useCallback(async (abgleich?: unknown) => {
    setLoading(true);
    try {
      const d = await client.fetchVorgaenge();
      if (d) {
        const jetzt = new Map(d.offene.map(x => [x.id, x.titel] as [string, string]));
        const vorher = vorherRef.current;
        if (abgleich === true && vorher) {
          const ergebnis = new Map(d.abgeschlossene.map(x => [x.id, x.ergebnis ?? x.status] as [string, string]));
          const weg = verschwundeneIds(vorher, jetzt.keys());
          if (weg.length) setInzwischen(alt => mitNeuen(alt, weg.map(id => `${kurz(vorher.get(id) ?? id, 70)}${ergebnis.get(id) ? ` — ${kurz(ergebnis.get(id)!, 60)}` : ''}`)));
        }
        vorherRef.current = jetzt;
      }
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
    const t = setInterval(() => load(true), ABGLEICH_MS);
    return () => clearInterval(t);
  }, [load]);

  // v1487 — Deep-Link ?id=<vorgang> öffnet einmalig das Detail
  useEffect(() => {
    if (!data || deepLinkErledigt.current || typeof window === 'undefined') return;
    deepLinkErledigt.current = true;
    const id = new URLSearchParams(window.location.search).get('id');
    if (!id) return;
    const v = [...data.offene, ...data.abgeschlossene].find(x => x.id === id);
    if (v) setDetail(v);
  }, [data]);

  const meldung = useCallback((text: string) => {
    const id = Date.now() + Math.random();
    setMeldungen(m => [...m, { id, text }]);
    setTimeout(() => setMeldungen(m => m.filter(x => x.id !== id)), 10_000);
  }, []);

  const fertig = useCallback(() => { setDetail(null); setAusfuehren(null); load(); }, [load]);

  const wiederAufnehmen = useCallback(async (v: VorgangDto) => {
    setBusy(true);
    try {
      await client.vorgangSpaeter(v.id, { bis: 'zurueck' });
      meldung(`↩️ Wieder aufgenommen: ${v.titel}`);
      await load();
    } catch (err) {
      meldung(`⏰ Nicht wieder aufgenommen: ${(err as Error).message}`);
    } finally {
      setBusy(false);
    }
  }, [client, load, meldung]);

  const jetzt = Date.now();
  const offene = data?.offene ?? [];
  const g = gruppen(offene, jetzt);
  const aehnlich = aehnliche([...g.fuerDich, ...g.beiAlfred]);

  const karte = (v: VorgangDto, abgeschlossenListe = false) => {
    const vs = v.vorschlag;
    const ausfuehrbar = !abgeschlossenListe && vs?.ausfuehrbar === true;
    const zb = zurueckBis(v, jetzt);
    const info = [
      !abgeschlossenListe && v.naechsterSchritt ? `Nächster Schritt: ${v.naechsterSchritt}` : '',
      v.frist ? `Frist ${datum(v.frist)}` : '',
      v.erstellt ? `seit ${datum(v.erstellt)}` : '',
      abgeschlossenListe && v.ergebnis ? v.ergebnis : '',
    ].filter(Boolean).join(' · ');
    return (
      <div key={v.id} className="bg-[#111111] border border-[#1f1f1f] rounded-xl p-4 mb-2.5 hover:border-[#2a2a2a] cursor-pointer" onClick={() => setDetail(v)}>
        <div className="flex items-start gap-2">
          <div className={clsx('flex-1 text-sm text-gray-200', abgeschlossenListe && 'line-through text-gray-400')}>{v.titel}</div>
          {abgeschlossenListe ? <span className="text-[11px] text-gray-500">{v.status}</span> : <Zustand v={v} jetzt={jetzt} />}
        </div>
        {info && <div className="text-xs text-gray-500 mt-1 line-clamp-2">{info}</div>}
        {vs && !abgeschlossenListe && (
          <div className="flex items-center gap-1.5 mt-1.5 text-[11px] text-gray-500">
            <span className={ausfuehrbar ? 'text-sky-300' : ''}>{ausfuehrbar ? '⚡' : '⛔'}</span>
            <span className="font-mono truncate">{vs.text}</span>
          </div>
        )}
        {vs && !vs.ausfuehrbar && vs.grund && !abgeschlossenListe && <div className="text-[11px] text-gray-600 mt-0.5 truncate">Nicht ausführbar: {vs.grund}</div>}
        {aehnlich.get(v.id) && !abgeschlossenListe && (
          <div className="text-[11px] text-amber-400 mt-1.5 truncate">⧉ Ähnlich wie: {aehnlich.get(v.id)}</div>
        )}
        {!abgeschlossenListe && (
          <div className="flex flex-wrap items-center gap-1.5 mt-2" onClick={e => e.stopPropagation()}>
            {ausfuehrbar && <button disabled={busy} onClick={() => setAusfuehren(v)} className={knopfAusfuehren}>▶ Ausführen…</button>}
            <button disabled={busy} onClick={() => setDetail(v)} className={knopfPrimaer}>✓ Abschließen…</button>
            {zb
              ? <button disabled={busy} onClick={() => wiederAufnehmen(v)} className={knopfNeutral}>↩ Wieder aufnehmen</button>
              : <SpaeterMenue client={client} v={v} meldung={meldung} onFertig={load} disabled={busy} />}
            <a href={chatLink(v)} className={knopfNeutral}>↩ Nachfragen</a>
          </div>
        )}
      </div>
    );
  };

  const kopf = (text: string, n: number, icon: string) => (
    <h2 className="flex items-center gap-2 text-sm font-semibold text-gray-300 mt-5 mb-2">
      <span>{icon}</span><span>{text}</span><span className="text-gray-500 font-normal">{n}</span>
    </h2>
  );

  const aufklapper = (offen: boolean, setzen: (b: boolean) => void, text: string) => (
    <button onClick={() => setzen(!offen)} className="mt-4 mb-2 text-xs text-sky-300 hover:text-sky-200">{offen ? '▾' : '▸'} {text}</button>
  );

  return (
    <div className="p-6 max-w-4xl mx-auto">
      <div className="mb-3"><AbgleichHinweis texte={inzwischen} onSchliessen={() => setInzwischen([])} /></div>
      <div className="flex items-center gap-3">
        <h1 className="text-xl font-semibold text-gray-200">🗂️ Vorgänge</h1>
        {data && <span className="text-sm text-gray-500">{offene.length} offen</span>}
        <div className="flex-1" />
        <button onClick={() => load()} className="px-2.5 py-1 text-xs rounded border border-[#1f1f1f] text-gray-500 hover:text-gray-300">Aktualisieren</button>
      </div>
      <div className="text-xs text-gray-500 mt-1">Was gerade läuft oder eine Entscheidung braucht. Ausführen führt genau die Aktion aus, die Alfred vorgeschlagen hat.</div>

      {meldungen.length > 0 && (
        <div className="mt-3 space-y-1.5">
          {meldungen.map(m => (
            <div key={m.id} className="flex items-start gap-2 rounded-lg px-3 py-2 text-xs border border-[#2a2a2a] bg-[#161616] text-gray-200">
              <span className="flex-1 whitespace-pre-wrap break-words">{m.text}</span>
              <button onClick={() => setMeldungen(x => x.filter(y => y.id !== m.id))} className="text-gray-500 hover:text-gray-300">✕</button>
            </div>
          ))}
        </div>
      )}

      {loading && !data && <div className="text-gray-500 text-sm mt-4">Laden…</div>}
      {error && <div className="text-red-400 text-sm mt-4">Vorgänge nicht geladen: {error}</div>}

      {data && (
        <>
          {offene.length === 0 && <div className="text-gray-500 text-sm py-8">Keine offenen Vorgänge. 🎉</div>}
          {g.fuerDich.length > 0 && <>{kopf('Für dich', g.fuerDich.length, '👤')}{g.fuerDich.map(v => karte(v))}</>}
          {g.beiAlfred.length > 0 && <>{kopf('Bei Alfred', g.beiAlfred.length, '🤖')}{g.beiAlfred.map(v => karte(v))}</>}
          {g.zurueck.length > 0 && (
            <div>
              {aufklapper(zurueckZeigen, setZurueckZeigen, `Zurückgestellt (${g.zurueck.length})`)}
              {zurueckZeigen && g.zurueck.map(v => karte(v))}
            </div>
          )}
          {data.abgeschlossene.length > 0 && (
            <div>
              {aufklapper(erledigtZeigen, setErledigtZeigen, `In den letzten 7 Tagen abgeschlossen (${data.abgeschlossene.length})`)}
              {erledigtZeigen && data.abgeschlossene.map(v => karte(v, true))}
            </div>
          )}

          {/* Ausführungsgedächtnis bleibt als aufklappbare Übersicht (in der App nur je Vorgang im Detail) */}
          {data.schritte.length > 0 && (
            <div>
              {aufklapper(schritteZeigen, setSchritteZeigen, `Ausführungsgedächtnis (14 Tage, ${data.schritte.length})`)}
              {schritteZeigen && (
                <section className="bg-[#111111] border border-[#1f1f1f] rounded-xl p-4">
                  <div className="text-xs text-gray-500 mb-3">Jeder Ausgang einer vorgeschlagenen Aktion. Dieselbe Liste speist den Reasoning-Kontext als „Bereits getan“.</div>
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
                </section>
              )}
            </div>
          )}
        </>
      )}

      {detail && (
        <VorgangDetail key={detail.id} client={client} v={detail} schritte={data?.schritte ?? []} meldung={meldung}
          onClose={() => setDetail(null)} onFertig={fertig}
          onAusfuehren={v => { setDetail(null); setAusfuehren(v); }} />
      )}
      {ausfuehren && <AusfuehrenDialog client={client} v={ausfuehren} meldung={meldung} onClose={() => setAusfuehren(null)} onFertig={fertig} />}
    </div>
  );
}
