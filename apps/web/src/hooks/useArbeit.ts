'use client';

/**
 * v1975 — Owner 28.11.: „warum sieht man weder in der App noch im Web, was Alfred gerade macht?“
 * Was Alfred gerade macht: laufende Anfragen der Owner-Gespräche (aus jedem Kanal) und Changes in Arbeit.
 * Ein gemeinsamer Abruf für alle Komponenten (Seitenleiste, Chat): alle 4 s, solange etwas läuft, sonst alle 15 s;
 * im Hintergrund-Tab pausiert. Nicht-Owner (403) und alte Server (404) bekommen still eine leere Liste.
 */
import { useEffect, useState } from 'react';
import { useConfig } from '@/context/ConfigContext';

export interface LaufendeAnfrage {
  arbeit: string; faden: string | null; von: string; kanal: string; frage: string; seit: string;
  status?: string; modell?: string; kostenUsd?: number; runde?: number; zuletzt: string;
}
export interface LaufenderChange {
  id: string; titel: string; phase: string; schritt: number; schritte: number;
  schrittTitel?: string; schrittSeit?: string; zeitlimitS?: number; start?: string; grund?: string; aktiv: boolean;
}
export interface ArbeitStand { anfragen: LaufendeAnfrage[]; changes: LaufenderChange[] }

const LEER: ArbeitStand = { anfragen: [], changes: [] };
let stand: ArbeitStand = LEER;
const hoerer = new Set<(s: ArbeitStand) => void>();
let timer: ReturnType<typeof setTimeout> | undefined;
let abrufer: (() => Promise<ArbeitStand | null>) | undefined;

async function takt(): Promise<void> {
  timer = undefined;
  if (!abrufer || hoerer.size === 0) return;
  if (typeof document === 'undefined' || !document.hidden) {
    const neu = await abrufer().catch(() => null);
    if (neu) { stand = neu; for (const h of hoerer) h(stand); }
  }
  if (hoerer.size > 0) timer = setTimeout(takt, stand.anfragen.length || stand.changes.some(c => c.phase === 'laeuft') ? 4_000 : 15_000);
}

export function useArbeit(): ArbeitStand {
  const { client } = useConfig();
  const [s, setS] = useState<ArbeitStand>(stand);
  useEffect(() => {
    if (!client) return;
    abrufer = () => client.fetchArbeit();
    hoerer.add(setS);
    if (!timer) void takt();
    return () => { hoerer.delete(setS); if (hoerer.size === 0 && timer) { clearTimeout(timer); timer = undefined; } };
  }, [client]);
  return s;
}

export function dauerText(ms: number): string {
  const s = Math.max(0, Math.round(ms / 1000));
  if (s < 60) return `${s} s`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m} min`;
  return `${Math.floor(m / 60)} h ${m % 60} min`;
}

const uhr = (iso: string) => new Date(iso).toLocaleTimeString('de-AT', { hour: '2-digit', minute: '2-digit' });

/** „seit 11:27 (6 min) · gpt-6.2-sol · 1,27 $ · Runde 4“ */
export function anfrageMeta(a: LaufendeAnfrage, jetzt = Date.now()): string {
  return [
    `seit ${uhr(a.seit)} (${dauerText(jetzt - Date.parse(a.seit))})`,
    a.modell,
    typeof a.kostenUsd === 'number' ? `${a.kostenUsd.toFixed(2).replace('.', ',')} $` : undefined,
    typeof a.runde === 'number' ? `Runde ${a.runde}` : undefined,
  ].filter(Boolean).join(' · ');
}

/** „Schritt 12/15 · seit 22 s (Limit 2 min) · läuft“ */
export function changeMeta(c: LaufenderChange, jetzt = Date.now()): string {
  const teile = [`Schritt ${c.schritt}/${c.schritte}`];
  if (c.schrittSeit) teile.push(`seit ${dauerText(jetzt - Date.parse(c.schrittSeit))}${typeof c.zeitlimitS === 'number' ? ` (Limit ${dauerText(c.zeitlimitS * 1000)})` : ''}`);
  teile.push(c.phase === 'laeuft' ? (c.aktiv ? 'läuft' : 'wartet') : c.phase === 'angehalten' ? 'angehalten' : c.phase === 'wartet_owner' ? 'wartet auf dich' : c.phase);
  return teile.join(' · ');
}
