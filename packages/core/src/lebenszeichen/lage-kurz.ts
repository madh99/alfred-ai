/**
 * v1540 (Owner 21.10. „Widget vollumfänglich alle Größen und live bei rot mitmachen“) — die Lage in Kurzform für Widget und
 * Live-Aktivität. Dieselbe Ampel wie die App (lib/kacheln.dart gesamtZustand): rot bei gestörtem Modell (ohne Embeddings) oder
 * offener Wächter-Meldung, gelb bei offenen Befunden, sonst grün. Reine Regeln ohne Modell.
 */
export type LageAmpel = 'ok' | 'warn' | 'bad';

export interface LageKurz {
  ampel: LageAmpel;
  /** „Alles ruhig“, „3 Befunde“, „1 Modell gestört · 2 Wächter-Meldungen“ — ohne Namen und Werte (geht auch per Push) */
  text: string;
  stand: string;
  lageStand: string | null;
  /** erste Zeilen des Lagetexts („Stichwort: Text“) */
  zeilen: Array<{ stichwort?: string; text: string }>;
  braucht: number;
  bestaetigungen: number;
  geraete: { online: number; gesamt: number };
  kosten: { heute: number | null; budget: number | null };
  modelleGestoert: number;
  waechter: number;
  befunde: Array<{ id: string; titel: string; quelle: string; seit: string }>;
  befundeGesamt: number;
  /** erster Vorgang, der den Owner braucht (für „Später“ im großen Widget) */
  vorgang: { id: string; titel: string } | null;
}

interface PulsLike { tier?: string; gestoertSeit?: string | null }
interface BefundLike { id: string; titel: string; quelle: string; entstanden: string }
interface VorgangLike { id: string; titel: string; status?: string; besitzer?: string }

function lageZeilen(text: string): Array<{ stichwort?: string; text: string }> {
  const aus: Array<{ stichwort?: string; text: string }> = [];
  for (const roh of text.split('\n')) {
    const z = roh.trim();
    if (!z || z.startsWith('###') || z.startsWith('Hinweis: Das ist der belegte Stand')) continue;
    const i = z.indexOf(': ');
    aus.push(i > 0 && i <= 40 ? { stichwort: z.slice(0, i), text: z.slice(i + 2) } : { text: z });
  }
  return aus;
}

export function lageKurz(lz: Record<string, unknown>, vorgaengeOffen: VorgangLike[], bestaetigungen: number, jetzt = new Date()): LageKurz {
  const puls = ((lz.puls as PulsLike[] | undefined) ?? []).filter(p => p.tier !== 'embeddings');
  const gestoert = puls.filter(p => p.gestoertSeit).length;
  const waechter = ((lz.offen as unknown[] | undefined) ?? []).length;
  const offen = (((lz.befunde as { offen?: BefundLike[] } | null)?.offen) ?? []);
  const ampel: LageAmpel = gestoert > 0 || waechter > 0 ? 'bad' : offen.length > 0 ? 'warn' : 'ok';
  const text = ampel === 'bad'
    ? [gestoert > 0 ? `${gestoert} Modell${gestoert === 1 ? '' : 'e'} gestört` : '', waechter > 0 ? `${waechter} Wächter-Meldung${waechter === 1 ? '' : 'en'}` : ''].filter(Boolean).join(' · ')
    : ampel === 'warn' ? `${offen.length} Befund${offen.length === 1 ? '' : 'e'}` : 'Alles ruhig';
  const geraete = ((lz.geraete as Array<{ status?: string; online?: boolean }> | undefined) ?? []).filter(g => g.status !== 'widerrufen');
  const kosten = lz.kosten as { heuteUsd?: number; budgetUsd?: number } | null | undefined;
  const lage = lz.lage as { stand?: string; text?: string } | null | undefined;
  const wartet = vorgaengeOffen.filter(v => v.status === 'wartet' || v.besitzer === 'user');
  return {
    ampel, text, stand: jetzt.toISOString(), lageStand: lage?.stand ?? null,
    zeilen: lageZeilen(lage?.text ?? '').slice(0, 6),
    braucht: wartet.length, bestaetigungen,
    geraete: { online: geraete.filter(g => g.online === true).length, gesamt: geraete.length },
    kosten: { heute: typeof kosten?.heuteUsd === 'number' ? kosten.heuteUsd : null, budget: typeof kosten?.budgetUsd === 'number' ? kosten.budgetUsd : null },
    modelleGestoert: gestoert, waechter,
    befunde: [...offen].sort((a, b) => b.entstanden.localeCompare(a.entstanden)).slice(0, 5).map(b => ({ id: b.id, titel: b.titel, quelle: b.quelle, seit: b.entstanden })),
    befundeGesamt: offen.length,
    vorgang: wartet[0] ? { id: wartet[0].id, titel: wartet[0].titel } : null,
  };
}
