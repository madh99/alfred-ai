'use client';

/**
 * Phase 5 H1 (Spec Geräte §20.4/§20.5 Punkt 6) — Seite „Geräte“: gekoppelte Geräte und Kopplung eines neuen Geräts.
 *
 * Der Kopplungscode gilt 5 Minuten und einmal. Der QR enthält {server, code, fingerabdruck}; die Handy-App vergleicht den
 * Fingerabdruck beim Verbinden selbst. Er steht zusätzlich als Text da, damit man ihn bei Eingabe von Hand vergleichen kann.
 * Nur für den Owner (Server antwortet sonst 403).
 */
import { useEffect, useState, useCallback } from 'react';
import QRCode from 'qrcode';
import { useConfig } from '@/context/ConfigContext';
import type { GeraetDto, Kopplungscode } from '@/lib/alfred-client';

function alter(iso?: string): string {
  if (!iso) return '—';
  const min = Math.round((Date.now() - Date.parse(iso)) / 60_000);
  if (min < 1) return 'gerade eben';
  if (min < 60) return `vor ${min} min`;
  const h = Math.round(min / 60);
  return h < 48 ? `vor ${h} h` : `vor ${Math.round(h / 24)} Tagen`;
}

/** Wie die App (fingerabdruckKurz): die ersten 4 Blöcke zu je 4 Zeichen. */
function kurz(fp: string): string { return fp.slice(0, 16).replace(/(.{4})(?=.)/g, '$1 '); }

export function GeraetePage() {
  const { client } = useConfig();
  const [geraete, setGeraete] = useState<GeraetDto[] | null>(null);
  const [fehler, setFehler] = useState<string | null>(null);
  const [kopplung, setKopplung] = useState<Kopplungscode | null>(null);
  const [qrBild, setQrBild] = useState<string | null>(null);
  const [rest, setRest] = useState(0);

  const laden = useCallback(async () => {
    try {
      const g = await client.fetchGeraete();
      setGeraete(g);
      setFehler(g ? null : 'Geräte nicht verfügbar (nur für den Owner)');
    } catch (err) { setFehler((err as Error).message); }
  }, [client]);

  useEffect(() => { laden(); const t = setInterval(laden, 30_000); return () => clearInterval(t); }, [laden]);

  // Restzeit des Codes; nach Ablauf verschwindet der QR
  useEffect(() => {
    if (!kopplung) return;
    const t = setInterval(() => {
      const r = Math.max(0, Math.round((Date.parse(kopplung.gueltigBis) - Date.now()) / 1000));
      setRest(r);
      if (r === 0) { setKopplung(null); setQrBild(null); laden(); }
    }, 1000);
    return () => clearInterval(t);
  }, [kopplung, laden]);

  const codeErzeugen = async () => {
    setFehler(null);
    try {
      const k = await client.geraetKopplungscode();
      setKopplung(k);
      setRest(Math.round((Date.parse(k.gueltigBis) - Date.now()) / 1000));
      setQrBild(k.qr ? await QRCode.toDataURL(k.qr, { margin: 1, width: 240, errorCorrectionLevel: 'M' }) : null);
    } catch (err) { setFehler((err as Error).message); }
  };

  const widerrufen = async (g: GeraetDto) => {
    if (!window.confirm(`„${g.name}“ entkoppeln? Das Gerät muss danach neu gekoppelt werden.`)) return;
    if (!(await client.geraetWiderrufen(g.id))) setFehler('Entkoppeln fehlgeschlagen');
    laden();
  };

  const aktive = (geraete ?? []).filter(g => g.status === 'aktiv');

  return (
    <div className="p-6 max-w-5xl mx-auto space-y-6">
      <div className="flex items-center justify-between">
        <h1 className="text-xl font-semibold text-gray-200">📱 Geräte</h1>
        <button onClick={laden} className="px-2.5 py-1 text-xs rounded border border-[#1f1f1f] text-gray-500 hover:text-gray-300">Aktualisieren</button>
      </div>
      {fehler && <div className="text-red-400 text-sm">Fehler: {fehler}</div>}

      <section className="bg-[#111111] border border-[#1f1f1f] rounded-xl p-4">
        <div className="flex items-center justify-between">
          <h2 className="text-sm font-semibold text-gray-300">Neues Gerät koppeln</h2>
          {!kopplung && <button onClick={codeErzeugen} className="px-3 py-1.5 text-xs rounded bg-blue-600 hover:bg-blue-500 text-white">Kopplungscode erzeugen</button>}
        </div>
        {!kopplung && <p className="mt-2 text-xs text-gray-500">Für die Alfred-App auf dem Handy: QR mit der App scannen. Desktop (PC, Mac, Linux): Code erzeugen, dann den angezeigten Befehl im Terminal ausführen — er prüft den Schlüssel des Servers selbst.</p>}
        {kopplung && (
          <div className="mt-3 flex flex-wrap gap-6 items-start">
            {qrBild && <img src={qrBild} alt="Kopplungs-QR" width={240} height={240} className="rounded bg-white p-1" />}
            <div className="space-y-2 text-sm text-gray-300">
              <div><span className="text-gray-500 text-xs block">Code</span><span className="font-mono text-2xl tracking-widest">{kopplung.code}</span></div>
              <div><span className="text-gray-500 text-xs block">Server</span><span className="font-mono">{kopplung.server}</span></div>
              {kopplung.fingerabdruck && <div><span className="text-gray-500 text-xs block">Schlüssel des Servers (zum Vergleich in der App)</span><span className="font-mono text-lg">{kurz(kopplung.fingerabdruck)}</span></div>}
              {/* v1533 — fertiger Befehl fürs Desktop-Koppeln: mit --insecure (selbst signiertes Zertifikat) und dem erwarteten Schlüssel */}
              <div><span className="text-gray-500 text-xs block">Desktop: im Terminal ausführen</span>
                <code className="block font-mono text-xs bg-black/40 rounded px-2 py-1 select-all break-all">{`alfred pair --server ${kopplung.server} --code ${kopplung.code} --insecure${kopplung.fingerabdruck ? ` --schluessel ${kopplung.fingerabdruck}` : ''}`}</code>
              </div>
              <div className="text-xs text-gray-500">gültig noch {Math.floor(rest / 60)}:{String(rest % 60).padStart(2, '0')} min, nur einmal verwendbar</div>
              <button onClick={() => { setKopplung(null); setQrBild(null); }} className="px-2.5 py-1 text-xs rounded border border-[#1f1f1f] text-gray-500 hover:text-gray-300">Schließen</button>
            </div>
          </div>
        )}
      </section>

      <section className="bg-[#111111] border border-[#1f1f1f] rounded-xl p-4">
        <h2 className="text-sm font-semibold text-gray-300 mb-3">Gekoppelte Geräte ({aktive.length})</h2>
        {geraete === null && !fehler && <div className="text-gray-500 text-sm">Laden…</div>}
        <div className="divide-y divide-[#1f1f1f]">
          {aktive.map(g => (
            <div key={g.id} className="py-2 flex items-center gap-3 text-sm">
              <span className={`inline-block w-2 h-2 rounded-full ${g.online ? 'bg-emerald-500' : 'bg-gray-600'}`} />
              <span className="text-gray-200 font-medium">{g.name}</span>
              <span className="text-xs text-gray-500">{g.plattform}{g.manifest?.satellitVersion ? ` · ${g.manifest.satellitVersion}` : ''}</span>
              <span className="ml-auto text-xs text-gray-500">{g.online ? `verbunden ${alter(g.verbundenSeit)}` : `zuletzt ${alter(g.zuletztGesehen)}`}</span>
              <button onClick={() => widerrufen(g)} className="px-2 py-0.5 text-xs rounded border border-[#1f1f1f] text-gray-500 hover:text-red-300">Entkoppeln</button>
            </div>
          ))}
        </div>
      </section>
    </div>
  );
}
