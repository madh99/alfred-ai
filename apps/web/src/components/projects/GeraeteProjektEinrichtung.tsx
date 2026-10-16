'use client';

import { useState } from 'react';
import type { AlfredClient, EinrichtungStand } from '@/lib/alfred-client';

/**
 * v1487 — Einrichtung eines Geräte-Projekts im Web (wie App 1.37.0, Server v1486): Repository, Prüfbefehle, Merge Requests,
 * Projektregeln, Protokoll. Der Stand kommt aus den vorhandenen Einstellungen; „passt so“ hält einen Schritt bewusst, wie er ist.
 * Nichts davon hält einen Lauf auf; eine Kostengrenze gehört nicht dazu (Owner 16.10.).
 */
interface Props {
  client: AlfredClient;
  projektId: string;
  einrichtung?: EinrichtungStand;
  onReload: () => void;
}

const WO: Partial<Record<EinrichtungStand['schritte'][number]['schritt'], string>> = {
  repo: 'Neu anlegen oder eintragen: unten bei Deploy → Remote.',
  regeln: 'Einzeln festlegen: unten bei den Projektregeln.',
};

const knopf = 'px-2 py-0.5 text-[11px] rounded border disabled:opacity-40';
const haupt = `${knopf} border-blue-500/40 text-blue-300 hover:bg-blue-500/10`;
const neben = `${knopf} border-[#2a2a2a] text-gray-300 hover:bg-[#222]`;

export function GeraeteProjektEinrichtung({ client, projektId, einrichtung, onReload }: Props) {
  const [busy, setBusy] = useState(false);
  const [meldung, setMeldung] = useState<{ ok: boolean; text: string } | null>(null);
  const [vorschlag, setVorschlag] = useState<{ befehle: string[]; quelle?: string } | null>(null);
  if (!einrichtung?.schritte.length) return null;
  if (einrichtung.erledigt === einrichtung.gesamt && !vorschlag) return null;

  async function los(f: () => Promise<{ success: boolean; display?: string; error?: string }>, neuLaden = true) {
    setBusy(true); setMeldung(null);
    const r = await f().catch((e: Error) => ({ success: false, error: e.message, display: undefined }));
    setBusy(false);
    setMeldung(r.success ? (r.display ? { ok: true, text: r.display } : null) : { ok: false, text: r.error ?? 'Fehler' });
    if (r.success && neuLaden) onReload();
    return r;
  }
  const passtSo = (schritt: string) => los(() => client.geraetProjektEinrichtung(projektId, `ok:${schritt}`));
  async function vorschlagHolen() {
    const r = await los(() => client.geraetProjektEinrichtung(projektId, 'pruefung_vorschlag'), false) as Awaited<ReturnType<AlfredClient['geraetProjektEinrichtung']>>;
    if (!r.success || !r.data) return;
    if (!r.data.befehle.length) { setMeldung({ ok: false, text: `Kein Vorschlag: ${r.data.hinweise.join('; ')}` }); return; }
    setVorschlag({ befehle: r.data.befehle, quelle: r.data.quelle });
  }
  async function uebernehmen() {
    if (!vorschlag) return;
    const r = await los(() => client.geraetProjektEinrichtung(projektId, 'pruefung_setzen', vorschlag.befehle));
    if (r.success) setVorschlag(null);
  }

  function knoepfe(schritt: string) {
    switch (schritt) {
      case 'repo': return <button disabled={busy} onClick={() => passtSo('repo')} className={neben}>Keins (nur lokal)</button>;
      case 'pruefung': return <><button disabled={busy} onClick={vorschlagHolen} className={haupt}>Vorschlag holen</button><button disabled={busy} onClick={() => passtSo('pruefung')} className={neben}>Keine</button></>;
      case 'mr': return <><button disabled={busy} onClick={() => los(() => client.geraetProjektMergeRequests(projektId, true))} className={haupt}>An</button><button disabled={busy} onClick={() => los(() => client.geraetProjektMergeRequests(projektId, false))} className={neben}>Aus</button></>;
      case 'regeln': return <button disabled={busy} onClick={() => passtSo('regeln')} className={neben}>Keine eigenen</button>;
      case 'protokoll': return <><button disabled={busy} onClick={() => los(() => client.geraetProjektProtokoll(projektId, true))} className={haupt}>An</button><button disabled={busy} onClick={() => los(() => client.geraetProjektProtokoll(projektId, false))} className={neben}>Aus</button></>;
    }
    return null;
  }

  return (
    <div className="bg-[#1a1a1a] border border-blue-500/30 rounded p-3 space-y-2 text-xs">
      <div>
        <div className="text-gray-100 font-medium">Einrichtung {einrichtung.erledigt}/{einrichtung.gesamt}</div>
        <div className="text-gray-500">Alles ist optional — Läufe starten auch ohne. Was du so lässt, markiert die Wahl als erledigt.</div>
      </div>
      {einrichtung.schritte.map(s => (
        <div key={s.schritt} className="flex gap-2">
          <span className={s.erledigt ? 'text-blue-300' : 'text-gray-600'}>{s.erledigt ? '✔' : '○'}</span>
          <div className="flex-1 space-y-1">
            <div className="text-gray-200">{s.titel}</div>
            <div className="text-gray-500 break-all">{s.stand}</div>
            {!s.erledigt && WO[s.schritt] && <div className="text-gray-500">{WO[s.schritt]}</div>}
            {!s.erledigt && <div className="flex flex-wrap gap-2">{knoepfe(s.schritt)}</div>}
            {s.schritt === 'pruefung' && vorschlag && (
              <div className="space-y-1 pt-1">
                <div className="text-gray-400">Vorschlag{vorschlag.quelle ? ` aus ${vorschlag.quelle}` : ''}:</div>
                {vorschlag.befehle.map(b => <div key={b} className="font-mono text-gray-200">{b}</div>)}
                <button disabled={busy} onClick={uebernehmen} className={`${knopf} border-emerald-500/40 text-emerald-300 hover:bg-emerald-500/10`}>Übernehmen</button>
              </div>
            )}
          </div>
        </div>
      ))}
      {meldung && <div className={meldung.ok ? 'text-emerald-300' : 'text-red-300'}>{meldung.text}</div>}
    </div>
  );
}
