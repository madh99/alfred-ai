'use client';

/**
 * v1487 — Befunde wie in der App (apps/flutter/lib/befunde.dart): offene Befunde aller Quellen,
 * Haus-Check nach Regeln A1–B3 gruppiert, Aktionen „Nicht mehr melden" / „Vorgang daraus" / „Nachfragen",
 * Regeln des Owners (Vorschläge übernehmen/ablehnen, aktive widerrufen) und die in 7 Tagen erledigten.
 * ?id=<befund> öffnet einen Befund, ?quelle=<quelle> setzt den Filter.
 */
import { useCallback, useEffect, useRef, useState } from 'react';
import clsx from 'clsx';
import { useConfig } from '@/context/ConfigContext';
import { ABGLEICH_MS, AbgleichHinweis, kurz, mitNeuen, verschwundeneIds } from '@/components/abgleich/Abgleich'; // v1494
import type { BefundZeile, RegelZeile } from '@/lib/alfred-client';

const BASE = '/alfred';
const STUMM_TAGE = [7, 30, 90] as const;

/** Anzeigename je Quelle (wie befundQuelle in der App) */
export function befundQuelle(q: string): string {
  switch (q) {
    case 'haus-check': return 'Haus-Check';
    case 'infra': return 'Infrastruktur';
    case 'energie': return 'Energie';
    case 'sensorbatterien': return 'Sensorbatterien';
    case 'haus': return 'Haus';
    case 'bmw': return 'Auto';
    case 'geraete': return 'Geräte';
    case 'mikrotik': return 'Netzwerk';
    case 'lebenszeichen': return 'Alfred selbst';
    default: return q;
  }
}

/** Regeln des Haus-Checks (Kurzform, wie regelName in der App) */
function regelName(r: string): string {
  switch (r) {
    case 'A1': return 'Automation verweist auf Fehlendes';
    case 'A2': return 'Automation lange nicht ausgelöst';
    case 'A3': return 'Automation lange deaktiviert';
    case 'B1': return 'Gerät lange nicht verfügbar';
    case 'B2': return 'Melder oder Messwert stumm';
    case 'B3': return 'Verbindung instabil';
    default: return r;
  }
}

/** Quellen-Reihenfolge: die übrigen zuerst (alphabetisch nach Anzeigename), Haus-Check zuletzt */
function quellenReihenfolge(l: BefundZeile[]): string[] {
  const q = Array.from(new Set(l.map(b => b.quelle)));
  return q.sort((a, b) => a === 'haus-check' ? 1 : b === 'haus-check' ? -1 : befundQuelle(a).localeCompare(befundQuelle(b), 'de'));
}

/** Gruppen einer Quelle: Haus-Check nach Regel, sonst eine Gruppe */
function befundGruppen(l: BefundZeile[]): Array<[string | null, BefundZeile[]]> {
  const m = new Map<string | null, BefundZeile[]>();
  for (const b of l) { const k = b.regel ?? null; m.set(k, [...(m.get(k) ?? []), b]); }
  return Array.from(m.entries()).sort((a, b) => (a[0] ?? '').localeCompare(b[0] ?? ''));
}

function datum(iso?: string): string | null {
  if (!iso) return null;
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? null : `${d.getDate()}.${d.getMonth() + 1}.`;
}

/** „neu" = in den letzten 7 Tagen entstanden */
function istNeu(b: BefundZeile): boolean {
  const t = Date.parse(b.entstanden);
  return !Number.isNaN(t) && Date.now() - t < 7 * 86_400_000;
}

const KNOPF = 'px-2 py-0.5 text-[11px] rounded border border-[#2a2a2a] text-gray-400 hover:text-gray-200 hover:bg-[#1a1a1a] disabled:opacity-40';

function BefundKarte({ b, erledigt, offen, markiert, busy, onToggle, onStumm, onVorgang }: {
  b: BefundZeile; erledigt?: boolean; offen: boolean; markiert: boolean; busy: boolean;
  onToggle: () => void; onStumm: (tage: 7 | 30 | 90) => void; onVorgang: () => void;
}) {
  const [stummMenue, setStummMenue] = useState(false);
  const neu = !erledigt && istNeu(b);
  const hatDetail = !!b.detail && b.detail.trim() !== '' && b.detail !== b.titel;
  const nachfragen = `Zum Befund „${b.titel}"${hatDetail ? ` (${b.detail})` : ''}: `;
  const meta = [
    datum(b.entstanden) ? `seit ${datum(b.entstanden)}` : null,
    erledigt && datum(b.erledigt) ? `erledigt ${datum(b.erledigt)}` : null,
    `${b.anzahl}× gesehen`,
    b.vorgang ? 'mit Vorgang' : null,
    hatDetail && !offen ? 'Klick: Einzelheiten' : null,
  ].filter(Boolean).join(' · ');

  return (
    <div id={`befund-${b.id}`} className={clsx('rounded-lg border px-3 py-2 mb-2 bg-[#111111]', markiert ? 'border-blue-500/60' : 'border-[#1f1f1f]')}>
      <div className={clsx('flex items-start gap-2', hatDetail && 'cursor-pointer')} onClick={hatDetail ? onToggle : undefined}>
        {neu && <span className="mt-0.5 shrink-0 px-1.5 rounded text-[10px] bg-blue-500/20 text-blue-300">neu</span>}
        <span className={clsx('text-sm text-gray-200 flex-1', erledigt && 'line-through text-gray-500')}>{b.titel}</span>
        {hatDetail && <span className="text-gray-500 text-xs">{offen ? '▾' : '▸'}</span>}
      </div>
      {hatDetail && offen && <div className="mt-1.5 text-xs text-gray-300 whitespace-pre-wrap select-text">{b.detail}</div>}
      <div className="mt-1.5 flex flex-wrap items-center gap-1.5">
        <span className="text-[11px] text-gray-500 flex-1 min-w-0 truncate">{meta}</span>
        {!erledigt && !b.nieStumm && (
          <span className="relative">
            <button disabled={busy} onClick={() => setStummMenue(s => !s)} className={KNOPF} title="Beim nächsten Auftreten kein Vorgang und keine Meldung">🔕 Nicht mehr melden</button>
            {stummMenue && (
              <span className="absolute right-0 top-full mt-1 z-10 flex flex-col rounded border border-[#2a2a2a] bg-[#151515] shadow-lg">
                {STUMM_TAGE.map(t => (
                  <button key={t} disabled={busy} onClick={() => { setStummMenue(false); onStumm(t); }} className="px-3 py-1 text-[11px] text-left text-gray-300 hover:bg-[#1f1f1f] whitespace-nowrap">{t} Tage</button>
                ))}
              </span>
            )}
          </span>
        )}
        {!erledigt && b.nieStumm && <span className="text-[11px] text-gray-600" title="Sicherheitsbefunde und Alfreds eigener Zustand lassen sich nicht stummschalten">nicht stummschaltbar</span>}
        {!erledigt && !b.vorgang && <button disabled={busy} onClick={onVorgang} className={KNOPF}>📋 Als Vorgang</button>}
        {b.vorgang && b.vorgangId && <a href={`${BASE}/vorgaenge/?id=${encodeURIComponent(b.vorgangId)}`} className={KNOPF}>Vorgang öffnen</a>}
        {!erledigt && <a href={`${BASE}/chat/?draft=${encodeURIComponent(nachfragen)}`} className={KNOPF} title="Im Chat mit Bezug weiterfragen">💬 Nachfragen</a>}
      </div>
    </div>
  );
}

export function BefundePage() {
  const { client } = useConfig();
  const [offen, setOffen] = useState<BefundZeile[] | null>(null);
  const [erledigt, setErledigt] = useState<BefundZeile[]>([]);
  const [vorschlaege, setVorschlaege] = useState<RegelZeile[]>([]);
  const [regeln, setRegeln] = useState<RegelZeile[]>([]);
  const [quelle, setQuelle] = useState<string | null>(null);
  const [fehler, setFehler] = useState<string | null>(null);
  const [meldung, setMeldung] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [ganz, setGanz] = useState<Set<string>>(new Set());
  const [erledigteZeigen, setErledigteZeigen] = useState(false);
  const [ziel, setZiel] = useState<string | null>(null);
  const zielErledigt = useRef(false);

  // v1487 — Sprung aus Lebenszeichen/Telegram: ?id=… öffnet einen Befund, ?quelle=… filtert
  useEffect(() => {
    if (typeof window === 'undefined') return;
    const p = new URLSearchParams(window.location.search);
    const id = p.get('id');
    const q = p.get('quelle');
    if (q) setQuelle(q);
    if (id) { setZiel(id); setGanz(new Set([id])); }
  }, []);

  const regelnLaden = useCallback(async () => {
    try {
      const r = await client.fetchRegeln();
      setVorschlaege(r.vorschlaege ?? []);
      setRegeln(r.aktiv ?? []);
    } catch { /* älterer Server ohne Regeln — Abschnitt bleibt leer */ }
  }, [client]);

  // v1494 — Abgleich wie in der App 1.40.0
  const vorherRef = useRef<Map<string, string> | null>(null);
  const [inzwischen, setInzwischen] = useState<string[]>([]);

  const laden = useCallback(async (abgleich?: unknown) => {
    try {
      const r = await client.fetchBefunde();
      const jetzt = new Map((r.offen ?? []).map(x => [x.id, x.titel] as [string, string]));
      const vorher = vorherRef.current;
      if (abgleich === true && vorher) { const weg = verschwundeneIds(vorher, jetzt.keys()); if (weg.length) setInzwischen(alt => mitNeuen(alt, weg.map(id => `${kurz(vorher.get(id) ?? id, 80)} — von selbst erledigt`))); }
      vorherRef.current = jetzt;
      setOffen(r.offen ?? []);
      setErledigt(r.erledigt ?? []);
      setFehler(null);
      await regelnLaden();
    } catch (e) {
      setFehler((e as Error).message);
    }
  }, [client, regelnLaden]);

  useEffect(() => { laden(); const t = setInterval(() => laden(true), ABGLEICH_MS); return () => clearInterval(t); }, [laden]);

  // Ziel-Befund einmal anspringen, sobald geladen (erledigte ggf. aufklappen)
  useEffect(() => {
    if (!ziel || !offen || zielErledigt.current) return;
    zielErledigt.current = true;
    if (!offen.some(b => b.id === ziel) && erledigt.some(b => b.id === ziel)) setErledigteZeigen(true);
    const b = [...offen, ...erledigt].find(x => x.id === ziel);
    if (b && quelle && b.quelle !== quelle) setQuelle(null);
    if (!b) setMeldung('Dieser Befund ist nicht mehr in der Liste.');
    setTimeout(() => document.getElementById(`befund-${ziel}`)?.scrollIntoView({ behavior: 'smooth', block: 'center' }), 100);
  }, [ziel, offen, erledigt, quelle]);

  const stumm = async (b: BefundZeile, tage: 7 | 30 | 90) => {
    setBusy(true);
    try {
      const r = await client.befundAktion(b.id, { aktion: 'stumm', tage });
      setMeldung(`🔕 ${r.regel ?? 'Nicht mehr melden'}`);
      await laden();
    } catch (e) { setMeldung(`🔕 Nicht geändert: ${(e as Error).message}`); }
    finally { setBusy(false); }
  };

  const vorgang = async (b: BefundZeile) => {
    setBusy(true);
    try {
      const r = await client.befundAktion(b.id, { aktion: 'vorgang' });
      setMeldung(r.neu ? `📋 Vorgang angelegt: ${r.titel ?? ''}` : `📋 Vorgang gibt es schon: ${r.titel ?? ''}`);
      await laden();
    } catch (e) { setMeldung(`📋 Kein Vorgang: ${(e as Error).message}`); }
    finally { setBusy(false); }
  };

  const regelAendern = async (r: RegelZeile, aktion: 'uebernehmen' | 'ablehnen' | 'widerrufen') => {
    setBusy(true);
    try {
      await client.regelAendern(r.id, aktion);
      setMeldung(aktion === 'uebernehmen' ? `📏 Regel übernommen: ${r.text}` : aktion === 'ablehnen' ? '📏 Vorschlag abgelehnt' : `📏 Regel widerrufen: ${r.text}`);
      await regelnLaden();
    } catch (e) { setMeldung(`📏 Nicht geändert: ${(e as Error).message}`); }
    finally { setBusy(false); }
  };

  const toggle = (id: string) => setGanz(s => { const n = new Set(s); if (n.has(id)) n.delete(id); else n.add(id); return n; });

  const o = offen ?? [];
  const sichtbar = o.filter(b => !quelle || b.quelle === quelle);
  const sichtbarErledigt = erledigt.filter(b => !quelle || b.quelle === quelle);
  const quellen = quellenReihenfolge([...o, ...erledigt]);

  const karte = (b: BefundZeile, istErledigt = false) => (
    <BefundKarte key={b.id} b={b} erledigt={istErledigt} offen={ganz.has(b.id)} markiert={b.id === ziel} busy={busy}
      onToggle={() => toggle(b.id)} onStumm={t => stumm(b, t)} onVorgang={() => vorgang(b)} />
  );

  return (
    <div className="p-6 max-w-4xl mx-auto space-y-4">
      <AbgleichHinweis texte={inzwischen} onSchliessen={() => setInzwischen([])} />
      <div className="flex items-center justify-between">
        <h1 className="text-xl font-semibold text-gray-200">⚠️ Befunde {offen && <span className="text-sm font-normal text-gray-500 ml-2">{o.length} offen</span>}</h1>
        <button onClick={() => laden()} className="px-2.5 py-1 text-xs rounded border border-[#1f1f1f] text-gray-500 hover:text-gray-300">Aktualisieren</button>
      </div>
      <div className="text-xs text-gray-500">Was Alfred als auffällig führt. Befunde erledigen sich von selbst, sobald die Ursache weg ist.</div>

      <div className="flex flex-wrap gap-1.5">
        <button onClick={() => setQuelle(null)} className={clsx('px-2.5 py-1 text-xs rounded-full border', !quelle ? 'border-blue-500/50 bg-blue-500/10 text-blue-300' : 'border-[#2a2a2a] text-gray-400 hover:text-gray-200')}>Alle ({o.length})</button>
        {quellen.map(q => (
          <button key={q} onClick={() => setQuelle(q)} className={clsx('px-2.5 py-1 text-xs rounded-full border', quelle === q ? 'border-blue-500/50 bg-blue-500/10 text-blue-300' : 'border-[#2a2a2a] text-gray-400 hover:text-gray-200')}>
            {befundQuelle(q)} ({o.filter(b => b.quelle === q).length})
          </button>
        ))}
      </div>

      {meldung && (
        <div className="flex items-start gap-2 rounded-lg px-3 py-2 text-xs border border-[#2a2a2a] bg-[#111111] text-gray-300">
          <span className="flex-1">{meldung}</span>
          <button onClick={() => setMeldung(null)} className="text-gray-500 hover:text-gray-300">✕</button>
        </div>
      )}

      {fehler ? (
        <div className="text-red-400 text-sm">Befunde nicht geladen: {fehler}</div>
      ) : !offen ? (
        <div className="text-gray-500 text-sm">Laden…</div>
      ) : (
        <>
          {/* Regeln: Vorschläge von Alfred zuerst, dann aktive */}
          {(vorschlaege.length > 0 || regeln.length > 0) && (
            <section className="bg-[#111111] border border-[#1f1f1f] rounded-xl p-4">
              <h2 className="text-sm font-semibold text-gray-300 mb-2">Regeln</h2>
              <ul className="space-y-1.5 text-xs">
                {vorschlaege.map(r => (
                  <li key={r.id} className="flex items-start gap-2">
                    <span className="text-amber-300">💡</span>
                    <span className="flex-1 text-gray-300">Vorschlag von Alfred: {r.text}{r.begruendung ? <span className="text-gray-500"> — {r.begruendung}</span> : null}</span>
                    <button disabled={busy} onClick={() => regelAendern(r, 'uebernehmen')} className="px-2 py-0.5 text-[11px] rounded border border-emerald-500/40 text-emerald-300 hover:bg-emerald-500/10 disabled:opacity-40">Übernehmen</button>
                    <button disabled={busy} onClick={() => regelAendern(r, 'ablehnen')} className={KNOPF}>Ablehnen</button>
                  </li>
                ))}
                {regeln.map(r => (
                  <li key={r.id} className="flex items-start gap-2">
                    <span className="text-gray-500">{r.abgelaufen ? '⌛' : '📏'}</span>
                    <span className={clsx('flex-1', r.abgelaufen ? 'text-gray-500' : 'text-gray-300')}>
                      {r.text}{r.herkunft === 'alfred' ? ' · von Alfred vorgeschlagen' : ''}{r.begruendung ? <span className="text-gray-500"> — {r.begruendung}</span> : null}
                    </span>
                    {!r.abgelaufen && <button disabled={busy} onClick={() => regelAendern(r, 'widerrufen')} className={KNOPF}>Widerrufen</button>}
                  </li>
                ))}
              </ul>
            </section>
          )}

          {sichtbar.length === 0 && <div className="py-6 text-sm text-gray-500">Keine offenen Befunde{quelle ? ` für ${befundQuelle(quelle)}` : ''}.</div>}

          {quellenReihenfolge(sichtbar).map(q => (
            <section key={q}>
              {!quelle && <h2 className="text-sm font-semibold text-gray-300 mt-3 mb-2">{befundQuelle(q)}</h2>}
              {befundGruppen(sichtbar.filter(b => b.quelle === q)).map(([regel, liste]) => (
                <div key={regel ?? '-'}>
                  {regel && <div className="text-xs font-medium text-blue-300 mt-2 mb-1.5">{regel} — {regelName(regel)} ({liste.length})</div>}
                  {liste.map(b => karte(b))}
                </div>
              ))}
            </section>
          ))}

          {sichtbarErledigt.length > 0 && (
            <section>
              <button onClick={() => setErledigteZeigen(s => !s)} className="text-xs text-gray-400 hover:text-gray-200 mt-2 mb-2">
                {erledigteZeigen ? '▾' : '▸'} In den letzten 7 Tagen erledigt ({sichtbarErledigt.length})
              </button>
              {erledigteZeigen && sichtbarErledigt.map(b => karte(b, true))}
            </section>
          )}
        </>
      )}
    </div>
  );
}
