/**
 * v1506 D5 — Kontomenü der App (Owner 19.10.): Kosten heute/Woche/Monat, Herkunft, teuerstes Modell, Code-Agenten und
 * Tagesbudget nur als Anzeige (keine Grenze, keine Warnung). Kein Guthaben.
 * v1508 — Code-Agenten getrennt (Owner 19.10.: „trennen in Claude Code und Codex und eventuell Mistral“): Herkunft
 * `agent:<name>`; Claude-Code-Läufe auf Geräten tragen als Modell `gerät:<Name>` (Kosten je Gerät).
 */

/** chat | hintergrund | aufgabe | agent:<name> | sonstiges */
export type Herkunft = string;
const REIHENFOLGE = ['chat', 'hintergrund', 'aufgabe'];
/** Agenten, die immer in der Liste stehen (auch mit 0) */
export const BEKANNTE_AGENTEN = ['claude-code', 'codex', 'mistral-vibe'];

export interface KontoQuelle {
  tagesSchluessel(now?: Date): string;
  summeJeModell(von: string, bis: string): Promise<Array<{ model: string; calls: number; costUsd: number }>>;
  summeJeZweck(von: string, bis: string): Promise<Array<{ zweck: string; calls: number; costUsd: number }>>;
  summeJeZweckUndModell(von: string, bis: string): Promise<Array<{ zweck: string; model: string; calls: number; costUsd: number }>>;
}

export interface KontoKosten {
  /** LLM-Kosten (wie die Kostenauswertung) plus Code-Agenten */
  heute: number; woche: number; monat: number;
  llm: { heute: number; woche: number; monat: number };
  agenten: Array<{ agent: string; heute: number; woche: number; monat: number }>;
  tagesbudgetUsd?: number;
  herkunftHeute: Array<{ herkunft: Herkunft; kosten: number; aufrufe: number }>;
  herkunftMonat: Array<{ herkunft: Herkunft; kosten: number; aufrufe: number }>;
  /** teuerste Hintergrund-Jobs im Monat */
  hintergrundMonat: Array<{ job: string; kosten: number }>;
  teuerstesModell?: { modell: string; kosten: number };
  /** Claude-Code-Kosten je Gerät im Monat (Name → USD) */
  geraeteMonat: Record<string, number>;
  zeitraum: { heute: string; wocheVon: string; monatVon: string };
}

/** Wochenbeginn (Montag) und Monatsbeginn zum lokalen Tag „YYYY-MM-DD“. */
export function zeitraeume(heute: string): { wocheVon: string; monatVon: string } {
  const [j, m, t] = heute.split('-').map(Number);
  const d = new Date(Date.UTC(j!, m! - 1, t!));
  const wochentag = (d.getUTCDay() + 6) % 7; // Montag = 0
  const montag = new Date(d.getTime() - wochentag * 86_400_000);
  return { wocheVon: montag.toISOString().slice(0, 10), monatVon: `${heute.slice(0, 7)}-01` };
}

/** Agent eines Zwecks (`agent:codex` → codex; v1506 schrieb noch `claude-code`), sonst undefined. */
export function agentVon(zweck: string): string | undefined {
  if (zweck === 'claude-code') return 'claude-code';
  return zweck.startsWith('agent:') ? zweck.slice('agent:'.length) || undefined : undefined;
}

export function herkunftVon(zweck: string): Herkunft {
  if (zweck.startsWith('hintergrund')) return 'hintergrund';
  const a = agentVon(zweck);
  if (a) return `agent:${a}`;
  return REIHENFOLGE.includes(zweck) ? zweck : 'sonstiges';
}

const runde = (n: number) => Math.round(n * 10_000) / 10_000;

function rang(h: string): number {
  const i = REIHENFOLGE.indexOf(h);
  if (i >= 0) return i;
  if (h.startsWith('agent:')) { const a = BEKANNTE_AGENTEN.indexOf(h.slice(6)); return 10 + (a >= 0 ? a : 9); }
  return 99; // sonstiges zuletzt
}

function gruppiere(zeilen: Array<{ zweck: string; calls: number; costUsd: number }>): KontoKosten['herkunftHeute'] {
  const m = new Map<Herkunft, { kosten: number; aufrufe: number }>();
  for (const z of zeilen) {
    const h = herkunftVon(z.zweck);
    const e = m.get(h) ?? { kosten: 0, aufrufe: 0 };
    e.kosten += z.costUsd; e.aufrufe += z.calls; m.set(h, e);
  }
  return [...m.keys()].sort((a, b) => rang(a) - rang(b) || a.localeCompare(b)).map(h => ({ herkunft: h, kosten: runde(m.get(h)!.kosten), aufrufe: m.get(h)!.aufrufe }));
}

function jeAgent(zeilen: Array<{ zweck: string; costUsd: number }>): Map<string, number> {
  const m = new Map<string, number>();
  for (const z of zeilen) { const a = agentVon(z.zweck); if (a) m.set(a, (m.get(a) ?? 0) + z.costUsd); }
  return m;
}

export async function kontoKosten(q: KontoQuelle, o: { now?: Date; tagesbudgetUsd?: number } = {}): Promise<KontoKosten> {
  const heute = q.tagesSchluessel(o.now);
  const { wocheVon, monatVon } = zeitraeume(heute);
  const summe = (z: Array<{ costUsd: number }>) => z.reduce((a, b) => a + b.costUsd, 0);
  const [mHeute, mWoche, mMonat, zHeute, zWoche, zMonat, zmMonat] = await Promise.all([
    q.summeJeModell(heute, heute), q.summeJeModell(wocheVon, heute), q.summeJeModell(monatVon, heute),
    q.summeJeZweck(heute, heute), q.summeJeZweck(wocheVon, heute), q.summeJeZweck(monatVon, heute),
    q.summeJeZweckUndModell(monatVon, heute),
  ]);
  const llm = { heute: runde(summe(mHeute)), woche: runde(summe(mWoche)), monat: runde(summe(mMonat)) };
  const [aH, aW, aM] = [jeAgent(zHeute), jeAgent(zWoche), jeAgent(zMonat)];
  const namen = [...new Set([...BEKANNTE_AGENTEN, ...aM.keys(), ...aW.keys(), ...aH.keys()])];
  const agenten = namen.map(a => ({ agent: a, heute: runde(aH.get(a) ?? 0), woche: runde(aW.get(a) ?? 0), monat: runde(aM.get(a) ?? 0) }));
  const agentSumme = (k: 'heute' | 'woche' | 'monat') => agenten.reduce((s, a) => s + a[k], 0);
  const geraeteMonat: Record<string, number> = {};
  for (const z of zmMonat) {
    if (agentVon(z.zweck) && z.model.startsWith('gerät:')) { const n = z.model.slice('gerät:'.length); geraeteMonat[n] = runde((geraeteMonat[n] ?? 0) + z.costUsd); }
  }
  const teuerst = [...mMonat].sort((a, b) => b.costUsd - a.costUsd)[0];
  return {
    heute: runde(llm.heute + agentSumme('heute')), woche: runde(llm.woche + agentSumme('woche')), monat: runde(llm.monat + agentSumme('monat')),
    llm, agenten,
    ...(o.tagesbudgetUsd ? { tagesbudgetUsd: o.tagesbudgetUsd } : {}),
    herkunftHeute: gruppiere(zHeute),
    herkunftMonat: gruppiere(zMonat),
    hintergrundMonat: zMonat.filter(z => z.zweck.startsWith('hintergrund:')).sort((a, b) => b.costUsd - a.costUsd).slice(0, 5)
      .map(z => ({ job: z.zweck.slice('hintergrund:'.length), kosten: runde(z.costUsd) })),
    ...(teuerst && teuerst.costUsd > 0 ? { teuerstesModell: { modell: teuerst.model, kosten: runde(teuerst.costUsd) } } : {}),
    geraeteMonat,
    zeitraum: { heute, wocheVon, monatVon },
  };
}
