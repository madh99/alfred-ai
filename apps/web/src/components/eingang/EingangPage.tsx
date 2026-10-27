'use client';

/**
 * v1487 — Eingang wie in der App: Bestätigungen, Vorgänge für dich, fällige Aufgaben und offene Hinweise
 * in einer Liste, das Dringendste zuerst. Keine eigene Server-Route — dieselben Aktionen wie in den Einzelansichten.
 * Owner-Quellen (/api/owner/*) liefern für andere Nutzer 403 → kurzer Hinweis, der Rest wird trotzdem gezeigt.
 */
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import clsx from 'clsx';
import { useConfig } from '@/context/ConfigContext';
import { ABGLEICH_MS, AbgleichHinweis, kurz, mitNeuen, verschwundeneIds } from '@/components/abgleich/Abgleich'; // v1494
import type { AufgabeZeile, HinweisZeile, PendingConfirmationItem, VorgangDto } from '@/lib/alfred-client';
import { ART_EINZELN, ART_NAME, ARTEN, eingangEintraege, hinweisOffen, type EingangArt, type EingangEintrag } from './eingang-logik';

const BASE = '/alfred';

const ART_SYMBOL: Record<EingangArt, { icon: string; farbe: string }> = {
  bestaetigung: { icon: '🔔', farbe: 'bg-amber-500/15 border-amber-500/30' },
  vorgang: { icon: '🗂️', farbe: 'bg-blue-500/15 border-blue-500/30' },
  aufgabe: { icon: '✅', farbe: 'bg-emerald-500/15 border-emerald-500/30' },
  hinweis: { icon: '💡', farbe: 'bg-purple-500/15 border-purple-500/30' },
};

function zeitText(d?: Date): string {
  if (!d) return '';
  return `${d.getDate()}.${d.getMonth() + 1}. ${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
}

const knopf = 'text-xs px-2.5 py-1 rounded border transition-colors disabled:opacity-40';
const knopfHaupt = clsx(knopf, 'bg-blue-500/15 border-blue-500/40 text-blue-300 hover:bg-blue-500/25');
const knopfNeben = clsx(knopf, 'border-[#2a2a2a] text-gray-300 hover:bg-[#1a1a1a]');

export function EingangPage() {
  const { client } = useConfig();
  const [bestaetigungen, setBestaetigungen] = useState<PendingConfirmationItem[]>([]);
  const [vorgaenge, setVorgaenge] = useState<VorgangDto[]>([]);
  const [aufgaben, setAufgaben] = useState<AufgabeZeile[]>([]);
  const [hinweise, setHinweise] = useState<HinweisZeile[]>([]);
  const [geladen, setGeladen] = useState(false);
  const [fehler, setFehler] = useState<string | null>(null);
  const [meldung, setMeldung] = useState<string | null>(null);
  const [filter, setFilter] = useState<EingangArt | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  // v1696 — Eingabefelder eines Hinweises (Owner 27.10.: Adresse ließ sich nicht eintragen)
  const [formular, setFormular] = useState<string | null>(null);
  const [werte, setWerte] = useState<Record<string, string>>({});

  // Filter aus der Adresse (?art=bestaetigung), z. B. vom Seitenleisten-Eintrag „Bestätigungen"
  useEffect(() => {
    if (typeof window === 'undefined') return;
    const a = new URLSearchParams(window.location.search).get('art');
    if (a && (ARTEN as string[]).includes(a)) setFilter(a as EingangArt);
  }, []);

  // v1494 — Abgleich wie in der App 1.40.0
  const vorherRef = useRef<Map<string, string> | null>(null);
  const [inzwischen, setInzwischen] = useState<string[]>([]);

  const laden = useCallback(async (abgleich?: unknown) => {
    if (!client) return;
    const teile: string[] = [];
    const hole = async <T,>(name: string, f: () => Promise<T>): Promise<T | null> => {
      try { return await f(); } catch (e) { teile.push(`${name}: ${(e as Error).message}`); return null; }
    };
    const [b, v, a, h] = await Promise.all([
      hole('Bestätigungen', () => client.fetchPendingConfirmations()),
      hole('Vorgänge', async () => { const r = await client.fetchVorgaenge(); if (!r) throw new Error('nicht verfügbar'); return r; }),
      hole('Aufgaben', () => client.fetchOwnerAufgaben()),
      hole('Hinweise', () => client.fetchHinweise()),
    ]);
    if (b) setBestaetigungen(b.filter(x => x.status === 'pending'));
    if (v) setVorgaenge(v.offene);
    if (a) setAufgaben(a.aufgaben ?? []);
    if (h) setHinweise(h.hinweise ?? []);
    if (b && v && a && h) {
      const jetzt = new Map(eingangEintraege({ bestaetigungen: b.filter(x => x.status === 'pending'), vorgaenge: v.offene, aufgaben: a.aufgaben ?? [], hinweise: h.hinweise ?? [], jetzt: new Date() }).map(x => [`${x.art}:${x.id}`, x.titel] as [string, string]));
      const vorher = vorherRef.current;
      if (abgleich === true && vorher) { const weg = verschwundeneIds(vorher, jetzt.keys()); if (weg.length) setInzwischen(alt => mitNeuen(alt, weg.map(k => kurz(vorher.get(k) ?? k, 80)))); }
      vorherRef.current = jetzt;
    }
    setFehler(teile.length ? teile.join(' · ') : null);
    setGeladen(true);
  }, [client]);

  useEffect(() => { laden(); const t = setInterval(() => laden(true), ABGLEICH_MS); return () => clearInterval(t); }, [laden]);

  const alle = useMemo(() => eingangEintraege({ bestaetigungen, vorgaenge, aufgaben, hinweise, jetzt: new Date() }), [bestaetigungen, vorgaenge, aufgaben, hinweise]);
  const sichtbar = filter ? alle.filter(e => e.art === filter) : alle;
  const anzahl = (a: EingangArt) => alle.filter(e => e.art === a).length;

  async function aktion(id: string, f: () => Promise<string | null | void>) {
    setBusy(id);
    try {
      const m = await f();
      if (m) setMeldung(m);
    } catch (e) {
      setMeldung(`Nicht möglich: ${(e as Error).message}`);
    } finally {
      setBusy(null);
      await laden();
    }
  }

  const bestaetigen = (b: PendingConfirmationItem, entscheidung: string) => aktion(b.id, async () => {
    const r = await client.decideConfirmation(b.id, entscheidung);
    return r.ok ? (r.fehler ? `❌ Freigegeben, aber fehlgeschlagen: ${r.fehler}` : null) : `Bestätigung fehlgeschlagen: ${r.reason ?? 'unbekannt'}`; // v1512 P3
  });

  const ausfuehren = (v: VorgangDto) => {
    if (!v.vorschlag) return;
    if (!confirm(`Vorgang ausführen?\n\n${v.titel}\n\n${v.vorschlag.text}`)) return;
    return aktion(v.id, async () => {
      const r = await client.vorgangAusfuehren(v.id);
      return `${r.erfolg ? '✅' : '⚠️'} ${r.titel}: ${r.text}`;
    });
  };

  const spaeter = (v: VorgangDto) => aktion(v.id, async () => {
    await client.vorgangSpaeter(v.id, { stunden: 3 });
    return `⏰ Zurückgestellt für 3 h: ${v.titel}`;
  });

  const erledigt = (a: AufgabeZeile) => aktion(a.id, async () => {
    await client.aufgabeErledigt(a.id);
    return `✅ Erledigt: ${a.titel}`;
  });

  const hinweis = (h: HinweisZeile, was: 'gelesen' | 'nuetzlich' | 'nicht_nuetzlich' | 'ausfuehren', eingaben?: Record<string, string>) => aktion(h.id, async () => {
    const r = await client.hinweisReagieren(h.id, was, eingaben);
    if (r.ok && was === 'ausfuehren') { setFormular(null); setWerte({}); }
    if (!r.ok) return `💡 Nicht möglich: ${r.grund ?? 'unbekannt'}`;
    return was === 'nuetzlich' || was === 'nicht_nuetzlich' ? '💡 Danke für die Rückmeldung' : null;
  });

  async function alleGelesen() {
    setBusy('alle');
    for (const h of hinweise.filter(hinweisOffen)) {
      try { await client.hinweisReagieren(h.id, 'gelesen'); } catch { /* nächster */ }
    }
    setBusy(null);
    setMeldung('💡 Alle Hinweise als gelesen markiert');
    await laden();
  }

  function knoepfe(e: EingangEintrag) {
    const aus = busy === e.id || busy === 'alle';
    switch (e.art) {
      case 'bestaetigung':
        return (
          <>
            <button className={knopfHaupt} disabled={aus} onClick={() => bestaetigen(e.roh, 'approve')}>✓ Ja</button>
            <button className={knopfNeben} disabled={aus} onClick={() => bestaetigen(e.roh, 'reject')}>✕ Nein</button>
            {e.roh.extraActions?.map(ea => (
              <button key={ea.key} className={knopfNeben} disabled={aus} onClick={() => bestaetigen(e.roh, ea.key)}>{ea.label}</button>
            ))}
          </>
        );
      case 'vorgang':
        return (
          <>
            {e.roh.vorschlag?.ausfuehrbar && (
              <button className={knopfHaupt} disabled={aus} onClick={() => ausfuehren(e.roh)} title={e.roh.vorschlag.text}>▶ Ausführen…</button>
            )}
            <a className={knopfNeben} href={`${BASE}/vorgaenge/?id=${encodeURIComponent(e.id)}`}>↗ Öffnen</a>
            <button className={knopfNeben} disabled={aus} onClick={() => spaeter(e.roh)} title="Für 3 Stunden zurückstellen">⏰ Später (3 h)</button>
          </>
        );
      case 'aufgabe':
        return <button className={knopfHaupt} disabled={aus} onClick={() => erledigt(e.roh)}>✓ Erledigt</button>;
      case 'hinweis':
        return (
          <>
            {e.roh.aktion && formular !== e.id && <button className={knopfHaupt} disabled={aus} onClick={() => (e.roh.felder?.length ? (setFormular(e.id), setWerte({})) : hinweis(e.roh, 'ausfuehren'))}>▶ {e.roh.aktion}</button>}
            {formular === e.id && e.roh.felder?.length ? (
              <span className="flex flex-wrap items-end gap-2 w-full">
                {e.roh.felder.map(f => (
                  <label key={f.key} className="text-xs text-gray-400 flex flex-col">{f.label}
                    <input type={f.type} autoFocus={f === e.roh.felder![0]} value={werte[f.key] ?? ''} onChange={ev => setWerte(w => ({ ...w, [f.key]: ev.target.value }))}
                      onKeyDown={ev => { if (ev.key === 'Enter') hinweis(e.roh, 'ausfuehren', werte); }}
                      className="mt-1 min-w-[16rem] bg-[#0a0a0a] border border-[#2a2a2a] rounded px-2 py-1 text-sm text-gray-200" />
                  </label>
                ))}
                <button className={knopfHaupt} disabled={aus || e.roh.felder.some(f => !(werte[f.key] ?? '').trim())} onClick={() => hinweis(e.roh, 'ausfuehren', werte)}>✓ Übernehmen</button>
                <button className={knopfNeben} onClick={() => { setFormular(null); setWerte({}); }}>Abbrechen</button>
              </span>
            ) : null}
            <button className={knopfNeben} disabled={aus} onClick={() => hinweis(e.roh, 'gelesen')}>Gelesen</button>
            <button className={knopfNeben} disabled={aus} onClick={() => hinweis(e.roh, 'nuetzlich')} title="Nützlich">👍</button>
            <button className={knopfNeben} disabled={aus} onClick={() => hinweis(e.roh, 'nicht_nuetzlich')} title="Nicht nützlich">👎</button>
          </>
        );
    }
  }

  function zeile(e: EingangEintrag) {
    const praefix = e.art === 'vorgang' && e.roh.frist ? 'Frist ' : e.art === 'aufgabe' ? 'fällig ' : '';
    const meta = [ART_EINZELN[e.art], e.zeit ? `${praefix}${zeitText(e.zeit)}` : null].filter(Boolean).join(' · ');
    const s = ART_SYMBOL[e.art];
    return (
      <div key={`${e.art}:${e.id}`} className="flex gap-3 rounded-lg border border-[#1f1f1f] bg-[#111] px-3 py-2.5">
        <div className={clsx('w-9 h-9 shrink-0 rounded-lg border flex items-center justify-center text-base', s.farbe)}>{s.icon}</div>
        <div className="flex-1 min-w-0">
          <div className="text-sm text-gray-200 line-clamp-3 break-words">{e.titel}</div>
          {e.text?.trim() && <div className="text-xs text-gray-500 mt-0.5 line-clamp-2 break-words">{e.text}</div>}
          <div className="text-[11px] text-gray-600 mt-0.5">{meta}</div>
          <div className="flex flex-wrap items-center gap-1.5 mt-2">{knoepfe(e)}</div>
        </div>
      </div>
    );
  }

  return (
    <div className="p-6 max-w-4xl mx-auto space-y-4">
      <AbgleichHinweis texte={inzwischen} onSchliessen={() => setInzwischen([])} />
      <div className="flex flex-wrap items-center gap-3">
        <h1 className="text-xl font-semibold text-gray-200">📥 Eingang</h1>
        {geladen && <span className="text-sm text-gray-500">{alle.length} {alle.length === 1 ? 'braucht' : 'brauchen'} dich</span>}
        <div className="flex-1" />
        {anzahl('hinweis') > 0 && (
          <button onClick={alleGelesen} disabled={busy === 'alle'} className="px-2.5 py-1 text-xs rounded border border-[#1f1f1f] text-gray-400 hover:text-gray-200 disabled:opacity-40">✓✓ Alle Hinweise gelesen</button>
        )}
        <button onClick={() => laden()} className="px-2.5 py-1 text-xs rounded border border-[#1f1f1f] text-gray-500 hover:text-gray-300">Aktualisieren</button>
      </div>
      <p className="text-xs text-gray-500 -mt-2">Bestätigungen, Vorgänge für dich, fällige Aufgaben und neue Hinweise — das Dringendste zuerst.</p>

      <div className="flex flex-wrap gap-1.5">
        <button onClick={() => setFilter(null)} className={clsx('text-xs px-2.5 py-1 rounded-full border', filter === null ? 'bg-blue-500/15 border-blue-500/40 text-blue-300' : 'border-[#2a2a2a] text-gray-400 hover:text-gray-200')}>Alle ({alle.length})</button>
        {ARTEN.filter(a => anzahl(a) > 0 || filter === a).map(a => (
          <button key={a} onClick={() => setFilter(a)} className={clsx('text-xs px-2.5 py-1 rounded-full border', filter === a ? 'bg-blue-500/15 border-blue-500/40 text-blue-300' : 'border-[#2a2a2a] text-gray-400 hover:text-gray-200')}>{ART_NAME[a]} ({anzahl(a)})</button>
        ))}
      </div>

      {fehler && <div className="text-xs text-amber-400/90">Teilweise nicht geladen: {fehler}</div>}
      {meldung && (
        <div className="flex items-start gap-2 text-xs text-gray-300 bg-[#141414] border border-[#1f1f1f] rounded px-3 py-2">
          <span className="flex-1 whitespace-pre-wrap">{meldung}</span>
          <button onClick={() => setMeldung(null)} className="text-gray-500 hover:text-gray-300">✕</button>
        </div>
      )}

      {!geladen ? (
        <div className="text-gray-500 text-sm">Laden…</div>
      ) : sichtbar.length === 0 ? (
        <div className="text-gray-500 text-sm py-8">Nichts offen — alles erledigt. 🎉</div>
      ) : (
        <div className="space-y-2">{sichtbar.map(zeile)}</div>
      )}
    </div>
  );
}
