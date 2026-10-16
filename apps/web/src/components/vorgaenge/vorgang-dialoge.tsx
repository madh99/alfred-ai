'use client';

/**
 * v1487 — Dialoge der Vorgänge wie in der App (vorgaenge.dart): Detail mit „Was war es?" / „Und künftig?",
 * Bestätigung vor „Ausführen", Menü „Später". Reine Anzeige + Aufrufe über den AlfredClient.
 */
import { useEffect, useRef, useState } from 'react';
import clsx from 'clsx';
import type { AlfredClient, VorgangDto, VorgangSchrittDto, VorgangErgebnisEingabe } from '@/lib/alfred-client';

export type Meldung = (text: string) => void;

export function datum(iso?: string | null): string {
  if (!iso) return '';
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '';
  return `${d.getDate()}.${d.getMonth() + 1}. ${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
}

/** Zurückgestellt bis (Date) oder null, wenn nicht oder nicht mehr zurückgestellt. */
export function zurueckBis(v: VorgangDto, jetzt = Date.now()): Date | null {
  if (!v.zurueckBis) return null;
  const b = new Date(v.zurueckBis);
  return !Number.isNaN(b.getTime()) && b.getTime() > jetzt ? b : null;
}

export const ERGEBNIS_ARTEN: Record<VorgangErgebnisEingabe['art'], string> = { behoben: 'Behoben', entschieden: 'Entschieden', kein_problem: 'Kein Problem', anders: 'Anders' };
type Kuenftig = 'wie_heute' | 'stumm' | 'immer_fragen';

/** „Und künftig?" — Vorauswahl wie App: ab dem dritten „kein Problem" (dieses Mal mitgezählt) „nicht mehr melden". */
function kuenftigVorauswahl(art: string | null, v: VorgangDto): Kuenftig {
  return v.befund != null && !v.nieStumm && art === 'kein_problem' && (v.keinProblemBisher ?? 0) >= 2 ? 'stumm' : 'wie_heute';
}

export const SPAETER_WAHL: { key: string; label: string; w: { stunden?: number; bis?: 'morgen' | 'zurueck' } }[] = [
  { key: '3', label: 'In 3 Stunden', w: { stunden: 3 } },
  { key: 'morgen', label: 'Morgen früh', w: { bis: 'morgen' } },
  { key: '72', label: 'In 3 Tagen', w: { stunden: 72 } },
  { key: '168', label: 'In einer Woche', w: { stunden: 168 } },
];

export const chatLink = (v: VorgangDto) => `/alfred/chat/?draft=${encodeURIComponent(`Wie steht es um „${v.titel}“?`)}`;

export const knopf = 'px-2.5 py-1 text-xs rounded border disabled:opacity-40';
export const knopfNeutral = clsx(knopf, 'border-[#2a2a2a] text-gray-300 hover:bg-white/5');
export const knopfPrimaer = clsx(knopf, 'border-sky-500/40 text-sky-300 hover:bg-sky-500/10');
export const knopfAusfuehren = clsx(knopf, 'border-emerald-500/40 text-emerald-300 hover:bg-emerald-500/10');

export function Modal({ children, onClose, breit }: { children: React.ReactNode; onClose: () => void; breit?: boolean }) {
  useEffect(() => {
    const esc = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose(); };
    window.addEventListener('keydown', esc);
    return () => window.removeEventListener('keydown', esc);
  }, [onClose]);
  return (
    <div className="fixed inset-0 bg-black/60 z-50 flex items-center justify-center p-4" onMouseDown={e => { if (e.target === e.currentTarget) onClose(); }}>
      <div className={clsx('bg-[#111111] border border-[#1f1f1f] rounded-xl p-5 w-full max-h-[90vh] overflow-y-auto', breit ? 'max-w-2xl' : 'max-w-lg')}>{children}</div>
    </div>
  );
}

/** Menü „Später" (zurückstellen, ohne Frist und Status zu ändern). */
export function SpaeterMenue({ client, v, meldung, onFertig, disabled }: { client: AlfredClient; v: VorgangDto; meldung: Meldung; onFertig: () => void; disabled?: boolean }) {
  const [offen, setOffen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!offen) return;
    const zu = (e: MouseEvent) => { if (ref.current && !ref.current.contains(e.target as Node)) setOffen(false); };
    document.addEventListener('mousedown', zu);
    return () => document.removeEventListener('mousedown', zu);
  }, [offen]);
  const waehle = async (w: (typeof SPAETER_WAHL)[number]) => {
    setOffen(false);
    try {
      await client.vorgangSpaeter(v.id, w.w);
      meldung(`⏰ Zurückgestellt: ${v.titel} (${w.label})`);
      onFertig();
    } catch (err) {
      meldung(`⏰ Nicht zurückgestellt: ${(err as Error).message}`);
    }
  };
  return (
    <div ref={ref} className="relative inline-block">
      <button disabled={disabled} onClick={() => setOffen(o => !o)} className={knopfNeutral} title="Später: zurückstellen">⏰ Später ▾</button>
      {offen && (
        <div className="absolute z-40 mt-1 left-0 min-w-[10rem] bg-[#161616] border border-[#2a2a2a] rounded-lg shadow-lg py-1">
          {SPAETER_WAHL.map(w => (
            <button key={w.key} onClick={() => waehle(w)} className="block w-full text-left px-3 py-1.5 text-xs text-gray-300 hover:bg-white/5">{w.label}</button>
          ))}
        </div>
      )}
    </div>
  );
}

/** Bestätigung vor „Ausführen": zeigt genau die Aktion, die Alfred ausführt. */
export function AusfuehrenDialog({ client, v, meldung, onClose, onFertig }: { client: AlfredClient; v: VorgangDto; meldung: Meldung; onClose: () => void; onFertig: () => void }) {
  const [sendet, setSendet] = useState(false);
  const ausfuehren = async () => {
    setSendet(true);
    try {
      const r = await client.vorgangAusfuehren(v.id);
      meldung(r.erfolg ? `▶️ Ausgeführt: ${v.titel} — ${r.text ?? ''}` : `⚠️ Ausführen fehlgeschlagen: ${v.titel} — ${r.text ?? ''}`);
      onFertig();
    } catch (err) {
      meldung(`⚠️ Nicht ausgeführt: ${(err as Error).message}`);
      setSendet(false);
    }
  };
  return (
    <Modal onClose={sendet ? () => {} : onClose}>
      <h3 className="text-sm font-semibold text-gray-200 mb-1">Vorschlag ausführen?</h3>
      <div className="text-sm text-gray-300 mb-3">{v.titel}</div>
      <div className="text-xs text-gray-500 mb-1">Alfred führt genau diese Aktion aus:</div>
      <pre className="text-xs text-gray-200 bg-[#0a0a0a] border border-[#1f1f1f] rounded-lg p-3 whitespace-pre-wrap break-words font-mono select-text">{v.vorschlag?.text ?? ''}</pre>
      <div className="flex justify-end gap-2 mt-4">
        <button disabled={sendet} onClick={onClose} className={knopfNeutral}>Abbrechen</button>
        <button disabled={sendet} onClick={ausfuehren} className={knopfAusfuehren}>{sendet ? 'Führt aus…' : '▶ Ausführen'}</button>
      </div>
    </Modal>
  );
}

function Feld({ name, wert }: { name: string; wert?: string | null }) {
  if (!wert || !wert.trim()) return null;
  return (
    <div className="mb-2">
      <div className="text-[11px] text-gray-500">{name}</div>
      <div className="text-sm text-gray-200 whitespace-pre-wrap break-words select-text">{wert}</div>
    </div>
  );
}

function Wahl({ aktiv, onClick, disabled, children, title }: { aktiv: boolean; onClick: () => void; disabled?: boolean; children: React.ReactNode; title?: string }) {
  return (
    <button type="button" title={title} disabled={disabled} onClick={onClick}
      className={clsx('px-2.5 py-1 text-xs rounded-full border disabled:opacity-40 disabled:cursor-not-allowed',
        aktiv ? 'border-sky-500/60 bg-sky-500/15 text-sky-200' : 'border-[#2a2a2a] text-gray-400 hover:text-gray-200')}>
      {children}
    </button>
  );
}

/** Detail eines Vorgangs mit Abschluss („Was war es?" / „Und künftig?"), Später, Ausführen, Nachfragen. */
export function VorgangDetail({ client, v, schritte, meldung, onClose, onFertig, onAusfuehren }: {
  client: AlfredClient; v: VorgangDto; schritte: VorgangSchrittDto[]; meldung: Meldung;
  onClose: () => void; onFertig: () => void; onAusfuehren: (v: VorgangDto) => void;
}) {
  const offen = v.status !== 'erledigt' && v.status !== 'verworfen';
  const befund = v.befund != null;
  const nieStumm = v.nieStumm === true;
  const keinProblemBisher = v.keinProblemBisher ?? 0;
  const [art, setArt] = useState<VorgangErgebnisEingabe['art'] | null>(null);
  const [kuenftig, setKuenftig] = useState<Kuenftig>('wie_heute');
  const [tage, setTage] = useState<7 | 30 | 90>(30);
  const [ursache, setUrsache] = useState('');
  const [massnahme, setMassnahme] = useState('');
  const [entscheidung, setEntscheidung] = useState('');
  const [text, setText] = useState('');
  const [sendet, setSendet] = useState(false);

  const eigene = schritte.filter(s => s.vorgangId === v.id).sort((a, b) => b.zeit.localeCompare(a.zeit)).slice(0, 8);
  const vorschlagAktiv = kuenftig === 'stumm' && art === 'kein_problem' && keinProblemBisher >= 2;

  const waehleArt = (a: VorgangErgebnisEingabe['art']) => { setArt(a); setKuenftig(kuenftigVorauswahl(a, v)); };

  const abschliessen = async () => {
    if (!art) return;
    setSendet(true);
    const t = (s: string) => (s.trim() ? s.trim() : undefined);
    try {
      const r = await client.vorgangAbschliessen(v.id, {
        ergebnis: { art, ursache: t(ursache), massnahme: t(massnahme), entscheidung: t(entscheidung), text: t(text) },
        kuenftig: kuenftig === 'stumm' ? { art: kuenftig, tage } : { art: kuenftig },
      });
      const zusatz = [r.regel ? `Regel: ${r.regel}` : '', r.vorschlag ? `Alfred schlägt vor: ${r.vorschlag} (Befunde › Regeln)` : ''].filter(Boolean).join(' · ');
      meldung(`📋 Abgeschlossen: ${v.titel} — ${ERGEBNIS_ARTEN[art]}${zusatz ? ` · ${zusatz}` : ''}`);
      onFertig();
    } catch (err) {
      meldung(`📋 Nicht abgeschlossen: ${(err as Error).message}`);
      setSendet(false);
    }
  };

  const eingabe = (wert: string, setzen: (s: string) => void, label: string) => (
    <input value={wert} onChange={e => setzen(e.target.value)} disabled={sendet} maxLength={500} placeholder={label}
      className="mt-2 w-full bg-[#0a0a0a] border border-[#2a2a2a] rounded-lg px-3 py-1.5 text-sm text-gray-200 placeholder:text-gray-600 focus:outline-none focus:border-sky-500/50" />
  );

  return (
    <Modal onClose={sendet ? () => {} : onClose} breit>
      <h3 className="text-base font-semibold text-gray-200 mb-1">{v.titel || 'Vorgang'}</h3>
      <div className="text-xs text-gray-500 mb-3">
        {[v.status, v.besitzer === 'user' ? 'bei dir' : 'bei Alfred', v.quelle, v.erstellt ? `seit ${datum(v.erstellt)}` : ''].filter(Boolean).join(' · ')}
      </div>
      <Feld name="Ziel" wert={v.ziel} />
      <Feld name="Nächster Schritt" wert={v.naechsterSchritt} />
      <Feld name="Frist" wert={v.frist ? datum(v.frist) : undefined} />
      <Feld name="Warum?" wert={v.begruendung} />
      <Feld name="Ergebnis" wert={v.ergebnis} />
      {v.vorschlag && (
        <div className="mb-2">
          <div className="text-[11px] text-gray-500">{v.vorschlag.ausfuehrbar ? 'Vorgeschlagene Aktion' : 'Vorgeschlagene Aktion (nicht ausführbar)'}</div>
          <div className="text-xs text-gray-200 font-mono whitespace-pre-wrap break-words select-text">{v.vorschlag.text}</div>
          {!v.vorschlag.ausfuehrbar && v.vorschlag.grund && <div className="text-[11px] text-gray-500 mt-0.5">Warum nicht: {v.vorschlag.grund}</div>}
        </div>
      )}
      {eigene.length > 0 && (
        <div className="mb-3">
          <div className="text-[11px] text-gray-500 mb-1">Letzte Schritte</div>
          {eigene.map(s => (
            <div key={s.id} className="text-xs text-gray-300 line-clamp-3 mb-1">
              {datum(s.zeit)} · {s.art} — {s.beschreibung}{s.ergebnis ? ` → ${s.ergebnis}` : ''}
            </div>
          ))}
        </div>
      )}

      {offen && (
        <div className="border-t border-[#1f1f1f] pt-3 mt-2">
          <div className="text-sm font-semibold text-gray-300 mb-2">Was war es?</div>
          <div className="flex flex-wrap gap-1.5">
            {(Object.keys(ERGEBNIS_ARTEN) as VorgangErgebnisEingabe['art'][]).map(a => (
              <Wahl key={a} aktiv={art === a} disabled={sendet} onClick={() => waehleArt(a)}>{ERGEBNIS_ARTEN[a]}</Wahl>
            ))}
          </div>
          {art === 'behoben' && <>{eingabe(ursache, setUrsache, 'Ursache')}{eingabe(massnahme, setMassnahme, 'Maßnahme — was wurde getan?')}</>}
          {art === 'entschieden' && eingabe(entscheidung, setEntscheidung, 'Was wurde entschieden?')}
          {art === 'kein_problem' && eingabe(text, setText, 'Warum ist es kein Problem?')}
          {art === 'anders' && eingabe(text, setText, 'Was war es?')}

          {art && befund && (
            <div className="mt-4">
              <div className="text-sm font-semibold text-gray-300 mb-2">Und künftig, wenn dieser Befund wieder auftritt?</div>
              <div className="flex flex-wrap items-center gap-1.5">
                <Wahl aktiv={kuenftig === 'wie_heute'} disabled={sendet} onClick={() => setKuenftig('wie_heute')}>Wie heute</Wahl>
                <Wahl aktiv={kuenftig === 'stumm'} disabled={sendet || nieStumm} onClick={() => setKuenftig('stumm')}
                  title={nieStumm ? 'Sicherheitsbefunde und Alfreds eigener Zustand lassen sich nicht stummschalten' : 'Kein neuer Vorgang zu diesem Befund — der Befund bleibt unter „Befunde" sichtbar'}>
                  Nicht mehr melden
                </Wahl>
                {kuenftig === 'stumm' && (
                  <select value={tage} disabled={sendet} onChange={e => setTage(Number(e.target.value) as 7 | 30 | 90)}
                    className="bg-[#0a0a0a] border border-[#2a2a2a] rounded px-2 py-1 text-xs text-gray-200">
                    <option value={7}>7 Tage</option><option value={30}>30 Tage</option><option value={90}>90 Tage</option>
                  </select>
                )}
                <Wahl aktiv={kuenftig === 'immer_fragen'} disabled={sendet} onClick={() => setKuenftig('immer_fragen')}>Jedes Mal fragen</Wahl>
              </div>
              {nieStumm && <div className="text-[11px] text-gray-500 mt-1">„Nicht mehr melden“ gibt es hier nicht: Sicherheitsbefunde und Alfreds eigener Zustand lassen sich nicht stummschalten.</div>}
              {vorschlagAktiv && <div className="text-xs text-sky-300 mt-1.5">Alfreds Vorschlag: Dieser Befund war schon {keinProblemBisher}× „kein Problem“.</div>}
            </div>
          )}
        </div>
      )}

      <div className="flex flex-wrap items-center justify-end gap-2 mt-5">
        <a href={chatLink(v)} className={clsx(knopfNeutral, sendet && 'pointer-events-none opacity-40')}>↩ Nachfragen</a>
        {offen && <SpaeterMenue client={client} v={v} meldung={meldung} onFertig={onFertig} disabled={sendet} />}
        {offen && v.vorschlag?.ausfuehrbar && <button disabled={sendet} onClick={() => onAusfuehren(v)} className={knopfAusfuehren}>▶ Ausführen…</button>}
        <button disabled={sendet} onClick={onClose} className={knopfNeutral}>{offen ? 'Abbrechen' : 'Schließen'}</button>
        {offen && <button disabled={sendet || !art} onClick={abschliessen} className={knopfPrimaer}>{sendet ? 'Schließt ab…' : '✓ Abschließen'}</button>}
      </div>
    </Modal>
  );
}
