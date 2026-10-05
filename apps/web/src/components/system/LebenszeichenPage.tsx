'use client';

/**
 * v1162 — Jarvis Schicht 0: Kachel „Lebenszeichen".
 *
 * Zeigt, ob Alfred lebt: registrierte Jobs mit Takt und letztem Lauf,
 * Provider-Puls je LLM-Tier, die letzten synthetischen Proben und offene
 * Wächter-Meldungen. Reine Anzeige aus job_runs + provider_puls — kein
 * eigenes Datenmodell.
 */
import { useEffect, useState, useCallback } from 'react';
import clsx from 'clsx';
import { useConfig } from '@/context/ConfigContext';
import type { LebenszeichenStatus, LebenszeichenJob, LebenszeichenPuls, LebenszeichenProbe } from '@/lib/alfred-client';

function alter(iso?: string | null): string {
  if (!iso) return '—';
  const ms = Date.now() - Date.parse(iso);
  const min = Math.round(ms / 60_000);
  if (min < 1) return 'gerade eben';
  if (min < 60) return `vor ${min} min`;
  const h = Math.round(min / 60);
  if (h < 48) return `vor ${h} h`;
  return `vor ${Math.round(h / 24)} Tagen`;
}

function taktText(t: LebenszeichenJob['takt']): string {
  if (t.art === 'taeglich') return `täglich ${t.um}`;
  if (t.art === 'woechentlich') return `${['So', 'Mo', 'Di', 'Mi', 'Do', 'Fr', 'Sa'][t.tag]} ${t.um}`;
  return `alle ${t.minuten} min`;
}

function fristMs(t: LebenszeichenJob['takt']): number {
  if (t.art === 'taeglich') return 26 * 3600_000;
  if (t.art === 'woechentlich') return 8 * 86_400_000;
  return Math.max(30 * 60_000, 2 * t.minuten * 60_000);
}

function jobAmpel(j: LebenszeichenJob, registerGestartetAm: string | null): 'ok' | 'warn' | 'bad' {
  if (!j.letzterLauf) {
    if (!registerGestartetAm) return 'warn';
    return Date.now() - Date.parse(registerGestartetAm) > fristMs(j.takt) ? 'bad' : 'warn';
  }
  if (j.letzterLauf.ok === false) return 'bad';
  return Date.now() - Date.parse(j.letzterLauf.startedAt) > fristMs(j.takt) ? 'bad' : 'ok';
}

function pulsAmpel(p: LebenszeichenPuls): 'ok' | 'warn' | 'bad' {
  if (!p.letzterFehler) return p.letzterErfolg ? 'ok' : 'warn';
  if (!p.letzterErfolg || p.letzterFehler > p.letzterErfolg) return 'bad';
  return 'ok';
}

const AMPEL: Record<'ok' | 'warn' | 'bad', string> = {
  ok: 'bg-emerald-500',
  warn: 'bg-amber-400',
  bad: 'bg-red-500',
};

const KENNZAHL_LABELS: Array<[string, string]> = [
  ['vollpaesse', 'Vollpässe'], ['rundgaenge', 'Rundgänge ohne LLM'], ['miniPaesse', 'Mini-Pässe'],
  ['insightsGesendet', 'Insights gesendet'], ['insightsAufgeschoben', 'aufgeschoben'], ['insightsStill', 'still abgelegt'],
  ['gateTreffer', 'Gate-Treffer'], ['gateAusgesetzt', 'Gate ausgesetzt'],
  ['aktionenAusgefuehrt', 'Aktionen ausgeführt'], ['aktionenBestaetigung', 'zur Bestätigung'], ['aktionenBlockiert', 'blockiert'], ['aktionenUebersprungen', 'übersprungen'], ['aktionenFehlgeschlagen', 'fehlgeschlagen'],
  ['vorgaengeAngelegt', 'Vorgänge angelegt'],
];

function Punkt({ zustand }: { zustand: 'ok' | 'warn' | 'bad' }) {
  return <span className={clsx('inline-block w-2.5 h-2.5 rounded-full', AMPEL[zustand])} />;
}

export function LebenszeichenPage() {
  const { client } = useConfig();
  const [data, setData] = useState<LebenszeichenStatus | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const d = await client.fetchLebenszeichen();
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

  const offen = data?.offen ?? [];

  return (
    <div className="p-6 max-w-5xl mx-auto space-y-6">
      <div className="flex items-center justify-between">
        <h1 className="text-xl font-semibold text-gray-200">💓 Lebenszeichen</h1>
        <button onClick={load} className="px-2.5 py-1 text-xs rounded border border-[#1f1f1f] text-gray-500 hover:text-gray-300">Aktualisieren</button>
      </div>

      {loading && !data && <div className="text-gray-500 text-sm">Laden…</div>}
      {error && <div className="text-red-400 text-sm">Fehler: {error}</div>}

      {data && (
        <>
          {/* Offene Meldungen */}
          <div className={clsx('rounded-lg px-4 py-2.5 text-xs border', offen.length ? 'bg-red-500/5 border-red-500/30 text-red-300' : 'bg-emerald-500/5 border-emerald-500/20 text-emerald-300/80')}>
            {offen.length === 0
              ? '✅ Keine offene Meldung — alle Tiers, Jobs und Datenquellen im Takt.'
              : (
                <ul className="space-y-1">
                  {offen.map(o => <li key={o.key}>⚠️ {o.text} <span className="text-gray-500">(offen seit {alter(o.offenSeit)}, zuletzt gemeldet {alter(o.zuletztGemeldet)})</span></li>)}
                </ul>
              )}
          </div>

          {/* Warum? (v1197 — Interaktion) */}
          {data.warum && data.warum.length > 0 && (
            <section className="bg-[#111111] border border-[#1f1f1f] rounded-xl p-4">
              <h2 className="text-sm font-semibold text-gray-300 mb-1">Warum? — Begründungen der letzten Meldungen</h2>
              <div className="text-xs text-gray-500 mb-3">Deterministisch aus dem Pass: Art, Auslöser (geänderte Sektion mit erster Abweichung oder Zustandswechsel), Gate-Aussetzung, Zustellung. Im Chat genügt „warum?".</div>
              <ul className="space-y-2 text-xs">
                {data.warum.map(b => (
                  <li key={b.zeit} className="border-t border-[#1a1a1a] pt-2">
                    <div className="flex flex-wrap gap-x-3 text-gray-400">
                      <span className="text-gray-200">{alter(b.zeit)}</span>
                      <span>{b.art === 'vollpass' ? 'Vollpass' : b.art === 'minipass' ? 'Mini-Pass' : 'Ereignis-Pass'}</span>
                      <span className={clsx(b.zustellung === 'gesendet' ? 'text-emerald-400' : b.zustellung === 'aufgeschoben' ? 'text-amber-300' : 'text-gray-500')}>{b.zustellung}</span>
                      {b.dauerMs ? <span>{(b.dauerMs / 1000).toFixed(1)} s</span> : null}
                      {b.insights.length > 0 && <span>{b.insights.length} Meldung{b.insights.length === 1 ? '' : 'en'}</span>}
                    </div>
                    <div className="text-gray-300">Auslöser: {b.ausloeser.length ? b.ausloeser.join(' · ') : 'Vollpass nach Zeitablauf'}</div>
                    {b.gateAusgesetzt.length > 0 && <div className="text-amber-300">Gate ausgesetzt: {b.gateAusgesetzt.join(', ')}</div>}
                    {b.insights.length > 0 && <div className="text-gray-500">{b.insights.map(t => `„${t}"`).join(', ')}</div>}
                  </li>
                ))}
              </ul>
            </section>
          )}

          {/* Kennzahlen (v1183 — Jarvis Schicht 4) */}
          {data.kennzahlen && (
            <section className="bg-[#111111] border border-[#1f1f1f] rounded-xl p-4">
              <h2 className="text-sm font-semibold text-gray-300 mb-1">Kennzahlen</h2>
              <div className="text-xs text-gray-500 mb-3">gezählt seit {alter(data.kennzahlen.seit)} — Tagesabschluss 23:50 schreibt sie als Messwerte, die Lern-Telemetrie (So 19:15) rechnet die Woche</div>
              <div className="grid grid-cols-2 sm:grid-cols-4 lg:grid-cols-7 gap-2">
                {KENNZAHL_LABELS.map(([key, label]) => (
                  <div key={key} className="rounded-lg border border-[#1a1a1a] px-3 py-2">
                    <div className="text-lg tabular-nums text-gray-200">{data.kennzahlen?.werte[key] ?? 0}</div>
                    <div className="text-[11px] text-gray-500 leading-tight">{label}</div>
                  </div>
                ))}
              </div>
            </section>
          )}

          {/* Adapter (v1191) */}
          {data.adapter && data.adapter.length > 0 && (
            <section className="bg-[#111111] border border-[#1f1f1f] rounded-xl p-4">
              <h2 className="text-sm font-semibold text-gray-300 mb-3">Messaging-Adapter</h2>
              <div className="flex flex-wrap gap-2">
                {data.adapter.map(a => (
                  <div key={a.platform} className="flex items-center gap-2 rounded-lg border border-[#1a1a1a] px-3 py-1.5 text-xs">
                    <Punkt zustand={a.status === 'connected' ? 'ok' : 'bad'} />
                    <span className="text-gray-200">{a.platform}</span>
                    <span className="text-gray-500">{a.status === 'connected' ? 'verbunden' : `${a.status}${a.getrenntSeitMs ? ` · seit ${alter(new Date(a.getrenntSeitMs).toISOString())}` : ''}`}</span>
                  </div>
                ))}
              </div>
            </section>
          )}

          {/* Provider-Puls */}
          <section className="bg-[#111111] border border-[#1f1f1f] rounded-xl p-4">
            <h2 className="text-sm font-semibold text-gray-300 mb-3">Provider-Puls</h2>
            {data.puls.length === 0 && <div className="text-xs text-gray-500">Noch keine LLM-Aufrufe seit Start.</div>}
            <table className="w-full text-xs">
              <thead className="text-gray-500 text-left">
                <tr><th className="py-1 pr-2"></th><th className="py-1 pr-3">Tier</th><th className="py-1 pr-3">Provider / Modell</th><th className="py-1 pr-3">Letzter Erfolg</th><th className="py-1 pr-3">Letzter Fehler</th><th className="py-1 pr-3">Klasse</th><th className="py-1 pr-3">Gestört seit</th><th className="py-1 text-right">OK / Fehler</th></tr>
              </thead>
              <tbody className="text-gray-300">
                {data.puls.map(p => (
                  <tr key={p.tier} className="border-t border-[#1a1a1a]">
                    <td className="py-1.5 pr-2"><Punkt zustand={pulsAmpel(p)} /></td>
                    <td className="py-1.5 pr-3 font-medium">{p.tier}</td>
                    <td className="py-1.5 pr-3 text-gray-400">{p.provider} / {p.model}</td>
                    <td className="py-1.5 pr-3">{alter(p.letzterErfolg)}</td>
                    <td className="py-1.5 pr-3">{alter(p.letzterFehler)}</td>
                    <td className="py-1.5 pr-3">{p.fehlerKlasse ?? '—'}</td>
                    <td className="py-1.5 pr-3">{p.gestoertSeit ? alter(p.gestoertSeit) : '—'}</td>
                    <td className="py-1.5 text-right tabular-nums">{p.erfolge} / {p.fehler}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </section>

          {/* Jobs */}
          <section className="bg-[#111111] border border-[#1f1f1f] rounded-xl p-4">
            <h2 className="text-sm font-semibold text-gray-300 mb-1">Jobs im Register</h2>
            <div className="text-[11px] text-gray-500 mb-3">Register gestartet {alter(data.registerGestartetAm)} · 10-min-Raster · Nachholen nach Restart</div>
            <table className="w-full text-xs">
              <thead className="text-gray-500 text-left">
                <tr><th className="py-1 pr-2"></th><th className="py-1 pr-3">Job</th><th className="py-1 pr-3">Takt</th><th className="py-1 pr-3">Bereich</th><th className="py-1 pr-3">Letzter Lauf</th><th className="py-1 pr-3">Ergebnis</th><th className="py-1">Zähler</th></tr>
              </thead>
              <tbody className="text-gray-300">
                {data.jobs.map(j => (
                  <tr key={j.key} className="border-t border-[#1a1a1a]">
                    <td className="py-1.5 pr-2"><Punkt zustand={jobAmpel(j, data.registerGestartetAm)} /></td>
                    <td className="py-1.5 pr-3"><div className="font-medium">{j.key}</div><div className="text-gray-500">{j.beschreibung}</div></td>
                    <td className="py-1.5 pr-3">{taktText(j.takt)}</td>
                    <td className="py-1.5 pr-3">{j.bereich}</td>
                    <td className="py-1.5 pr-3">{alter(j.letzterLauf?.startedAt)}</td>
                    <td className="py-1.5 pr-3">{j.letzterLauf ? (j.letzterLauf.ok ? 'ok' : <span className="text-red-400">{j.letzterLauf.fehler ?? 'Fehler'}</span>) : '—'}</td>
                    <td className="py-1.5 text-gray-400">{j.letzterLauf?.zaehler ? Object.entries(j.letzterLauf.zaehler).map(([k, v]) => `${k} ${v}`).join(' · ') : ''}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </section>

          {/* Proben */}
          <section className="bg-[#111111] border border-[#1f1f1f] rounded-xl p-4">
            <h2 className="text-sm font-semibold text-gray-300 mb-1">Synthetische Proben</h2>
            <div className="text-[11px] text-gray-500 mb-3">täglich 06:50 · {data.proben.zeit ? `zuletzt ${alter(data.proben.zeit)}` : 'noch nicht gelaufen (erster Lauf 06:50)'}</div>
            {data.proben.ergebnisse.length > 0 && (
              <ul className="space-y-1 text-xs text-gray-300">
                {data.proben.ergebnisse.map((p: LebenszeichenProbe) => (
                  <li key={`${p.art}:${p.name}`} className="flex items-start gap-2">
                    <Punkt zustand={p.ok ? 'ok' : 'bad'} />
                    <span className="text-gray-500 w-12 shrink-0">{p.art}</span>
                    <span className="font-medium w-40 shrink-0">{p.name}</span>
                    <span className="text-gray-400">{p.detail}</span>
                  </li>
                ))}
              </ul>
            )}
          </section>

          {/* Letzte Läufe */}
          <section className="bg-[#111111] border border-[#1f1f1f] rounded-xl p-4">
            <h2 className="text-sm font-semibold text-gray-300 mb-3">Letzte Läufe (job_runs)</h2>
            <table className="w-full text-xs">
              <thead className="text-gray-500 text-left">
                <tr><th className="py-1 pr-3">Zeit</th><th className="py-1 pr-3">Job</th><th className="py-1 pr-3">User</th><th className="py-1 pr-3">Dauer</th><th className="py-1 pr-3">Ergebnis</th><th className="py-1">Zähler / Fehler</th></tr>
              </thead>
              <tbody className="text-gray-300">
                {data.letzteLaeufe.map(r => (
                  <tr key={r.id} className="border-t border-[#1a1a1a]">
                    <td className="py-1 pr-3 text-gray-400 whitespace-nowrap">{new Date(r.startedAt).toLocaleString('de-AT')}</td>
                    <td className="py-1 pr-3">{r.jobKey}</td>
                    <td className="py-1 pr-3 text-gray-500">{r.userId ? r.userId.slice(0, 8) : 'global'}</td>
                    <td className="py-1 pr-3 tabular-nums">{r.finishedAt ? `${Math.max(0, Math.round((Date.parse(r.finishedAt) - Date.parse(r.startedAt)) / 1000))} s` : 'läuft'}</td>
                    <td className="py-1 pr-3">{r.ok === undefined ? '…' : r.ok ? 'ok' : <span className="text-red-400">Fehler</span>}</td>
                    <td className="py-1 text-gray-400">{r.fehler ?? (r.zaehler ? Object.entries(r.zaehler).map(([k, v]) => `${k} ${v}`).join(' · ') : '')}</td>
                  </tr>
                ))}
              </tbody>
            </table>
            {data.letzteLaeufe.length === 0 && <div className="text-xs text-gray-500">Noch keine Läufe — der erste Nachtjob schreibt ab 03:00.</div>}
          </section>
        </>
      )}
    </div>
  );
}
