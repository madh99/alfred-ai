/**
 * v1506 D5 — Kontomenü der App (Owner 19.10.): Kosten heute/Woche/Monat, Herkunft, teuerstes Modell, Claude Code und
 * Tagesbudget nur als Anzeige (keine Grenze, keine Warnung). Kein Guthaben.
 */

export type Herkunft = 'chat' | 'hintergrund' | 'aufgabe' | 'claude-code' | 'sonstiges';
const HERKUNFT: Herkunft[] = ['chat', 'hintergrund', 'aufgabe', 'claude-code', 'sonstiges'];

export interface KontoQuelle {
  tagesSchluessel(now?: Date): string;
  summeJeModell(von: string, bis: string): Promise<Array<{ model: string; calls: number; costUsd: number }>>;
  summeJeZweck(von: string, bis: string): Promise<Array<{ zweck: string; calls: number; costUsd: number }>>;
}

export interface KontoKosten {
  /** LLM-Kosten (wie die Kostenauswertung) plus Claude Code */
  heute: number; woche: number; monat: number;
  llm: { heute: number; woche: number; monat: number };
  claudeCode: { heute: number; woche: number; monat: number };
  tagesbudgetUsd?: number;
  herkunftHeute: Array<{ herkunft: Herkunft; kosten: number; aufrufe: number }>;
  herkunftMonat: Array<{ herkunft: Herkunft; kosten: number; aufrufe: number }>;
  /** teuerste Hintergrund-Jobs im Monat */
  hintergrundMonat: Array<{ job: string; kosten: number }>;
  teuerstesModell?: { modell: string; kosten: number };
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

export function herkunftVon(zweck: string): Herkunft {
  if (zweck.startsWith('hintergrund')) return 'hintergrund';
  return (HERKUNFT as string[]).includes(zweck) ? zweck as Herkunft : 'sonstiges';
}

const runde = (n: number) => Math.round(n * 10_000) / 10_000;

function gruppiere(zeilen: Array<{ zweck: string; calls: number; costUsd: number }>): KontoKosten['herkunftHeute'] {
  const m = new Map<Herkunft, { kosten: number; aufrufe: number }>();
  for (const z of zeilen) {
    const h = herkunftVon(z.zweck);
    const e = m.get(h) ?? { kosten: 0, aufrufe: 0 };
    e.kosten += z.costUsd; e.aufrufe += z.calls; m.set(h, e);
  }
  return HERKUNFT.filter(h => m.has(h)).map(h => ({ herkunft: h, kosten: runde(m.get(h)!.kosten), aufrufe: m.get(h)!.aufrufe }));
}

export async function kontoKosten(q: KontoQuelle, o: { now?: Date; tagesbudgetUsd?: number } = {}): Promise<KontoKosten> {
  const heute = q.tagesSchluessel(o.now);
  const { wocheVon, monatVon } = zeitraeume(heute);
  const summe = (z: Array<{ costUsd: number }>) => z.reduce((a, b) => a + b.costUsd, 0);
  const [mHeute, mWoche, mMonat, zHeute, zWoche, zMonat] = await Promise.all([
    q.summeJeModell(heute, heute), q.summeJeModell(wocheVon, heute), q.summeJeModell(monatVon, heute),
    q.summeJeZweck(heute, heute), q.summeJeZweck(wocheVon, heute), q.summeJeZweck(monatVon, heute),
  ]);
  const cc = (z: Array<{ zweck: string; costUsd: number }>) => summe(z.filter(x => x.zweck === 'claude-code'));
  const llm = { heute: runde(summe(mHeute)), woche: runde(summe(mWoche)), monat: runde(summe(mMonat)) };
  const claudeCode = { heute: runde(cc(zHeute)), woche: runde(cc(zWoche)), monat: runde(cc(zMonat)) };
  const teuerst = [...mMonat].sort((a, b) => b.costUsd - a.costUsd)[0];
  return {
    heute: runde(llm.heute + claudeCode.heute), woche: runde(llm.woche + claudeCode.woche), monat: runde(llm.monat + claudeCode.monat),
    llm, claudeCode,
    ...(o.tagesbudgetUsd ? { tagesbudgetUsd: o.tagesbudgetUsd } : {}),
    herkunftHeute: gruppiere(zHeute),
    herkunftMonat: gruppiere(zMonat),
    hintergrundMonat: zMonat.filter(z => z.zweck.startsWith('hintergrund:')).sort((a, b) => b.costUsd - a.costUsd).slice(0, 5)
      .map(z => ({ job: z.zweck.slice('hintergrund:'.length), kosten: runde(z.costUsd) })),
    ...(teuerst && teuerst.costUsd > 0 ? { teuerstesModell: { modell: teuerst.model, kosten: runde(teuerst.costUsd) } } : {}),
    zeitraum: { heute, wocheVon, monatVon },
  };
}
