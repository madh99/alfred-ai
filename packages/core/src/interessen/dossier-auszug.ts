/**
 * v1377 — Interessen als Wissen, I2 (Owner-Freigabe 12.10.): passt eine Frage zu einem beobachteten Thema, kommt ein kurzer
 * Auszug aus dessen Dossier (Stand-Datum) in den Gesprächskontext — Alfred antwortet aus dem gesammelten Wissen statt nur den
 * Themennamen zu kennen und erst ein Werkzeug zu suchen. Zuordnung ohne Modell: Stichwörter des Themas zählen doppelt,
 * bedeutungstragende Namenswörter einfach; nötig sind mindestens 2 Punkte. Liest nur (Content-Studio unberührt).
 */
import { bedeutungsWoerter } from './thema-aehnlichkeit.js';

export const DOSSIER_AUSZUG_MAX = 600;

export function dossierThemaFuer<T extends { name: string; keywords: string[] }>(text: string, themen: T[]): T | null {
  const t = ` ${text.toLowerCase()} `;
  const enthaelt = (w: string) => new RegExp(`(^|[^\\p{L}\\p{N}])${w.toLowerCase().replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}($|[^\\p{L}\\p{N}])`, 'u').test(t);
  let best: { thema: T; punkte: number } | null = null;
  for (const th of themen) {
    const kw = th.keywords.map(k => k.trim()).filter(k => k.length >= 3);
    const punkte = kw.filter(enthaelt).length * 2 + [...bedeutungsWoerter(th.name)].filter(w => w.length >= 4 && enthaelt(w)).length;
    if (punkte >= 2 && (!best || punkte > best.punkte)) best = { thema: th, punkte };
  }
  return best?.thema ?? null;
}

export function dossierAuszug(summary: string, max = DOSSIER_AUSZUG_MAX): string {
  const s = summary.replace(/\s+\n/g, '\n').trim();
  if (s.length <= max) return s;
  const schnitt = s.slice(0, max);
  const ende = Math.max(schnitt.lastIndexOf('. '), schnitt.lastIndexOf('\n'));
  return `${(ende > max * 0.5 ? schnitt.slice(0, ende + 1) : schnitt).trimEnd()} …`;
}
