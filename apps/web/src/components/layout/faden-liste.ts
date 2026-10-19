// v1497 — Gesprächsfäden in der Seitenleiste ordnen (wie die App, lib/faden_liste.dart).
// Owner 18.10.: nicht alle Fäden sichtbar (nur 12 inkl. Hauptgespräch), anheften und archivieren fehlten.
// v1499 (D1) — Projekte mit ihren Fäden getrennt von den Gesprächen (Owner 19.10., App-Spec §11).

export interface FadenEintrag { faden: string | null; titel: string; zeit: string; anzahl: number; archiv?: string; angeheftet?: boolean; archiviert?: boolean; projekt?: { id: string; name: string } }
export interface ProjektKurz { id: string; name: string; aktualisiert?: string }
export interface ProjektGruppe { id: string; name: string; faeden: FadenEintrag[]; weitere: number }

export const SICHTBARE_FAEDEN = 12;
export const SICHTBARE_PROJEKT_FAEDEN = 5;

export interface FadenGruppen {
  haupt?: FadenEintrag;
  projekte: ProjektGruppe[];
  angeheftet: FadenEintrag[];
  gespraeche: FadenEintrag[];
  weitere: number;
  archiviert: FadenEintrag[];
  filterSinnvoll: boolean;
}

export function fadenTitel(f: FadenEintrag): string {
  return f.titel?.trim() || `Gespräch ${f.faden ?? ''}`.trim();
}

export const istProjektFaden = (f: FadenEintrag): boolean => (f.faden ?? '').startsWith('projekt-');

export function fadenGruppen(faeden: FadenEintrag[], opts: { alle?: boolean; filter?: string; ausgeblendet?: Set<string>; projekte?: ProjektKurz[]; offeneProjekte?: Set<string> } = {}): FadenGruppen {
  const f = (opts.filter ?? '').trim().toLowerCase();
  const passt = (x: FadenEintrag) => !f || fadenTitel(x).toLowerCase().includes(f);
  const eigene = faeden.filter(x => x.faden && !x.archiv && !opts.ausgeblendet?.has(x.faden));
  const aktiv = eigene.filter(x => !x.archiviert);

  const namen = new Map<string, string>();
  for (const p of opts.projekte ?? []) if (!namen.has(p.id)) namen.set(p.id, p.name);
  for (const x of aktiv) if (x.projekt && !namen.has(x.projekt.id)) namen.set(x.projekt.id, x.projekt.name);
  const projekte: ProjektGruppe[] = [];
  for (const [id, name] of namen) {
    const namePasst = !!f && name.toLowerCase().includes(f);
    const alle = aktiv.filter(x => x.projekt?.id === id && (namePasst || passt(x)))
      .sort((a, b) => Number(istProjektFaden(b)) - Number(istProjektFaden(a)));
    if (f && !namePasst && alle.length === 0) continue;
    const zeigen = opts.offeneProjekte?.has(id) || f ? alle : alle.slice(0, SICHTBARE_PROJEKT_FAEDEN);
    projekte.push({ id, name, faeden: zeigen, weitere: alle.length - zeigen.length });
  }

  const ohneProjekt = aktiv.filter(x => !x.projekt);
  const normal = ohneProjekt.filter(x => !x.angeheftet && passt(x));
  const zeigen = opts.alle || f ? normal : normal.slice(0, SICHTBARE_FAEDEN);
  return {
    haupt: faeden.find(x => x.faden === null && !x.archiv),
    projekte,
    angeheftet: ohneProjekt.filter(x => x.angeheftet && passt(x)),
    gespraeche: zeigen,
    weitere: normal.length - zeigen.length,
    archiviert: eigene.filter(x => x.archiviert && passt(x)),
    filterSinnvoll: ohneProjekt.length > SICHTBARE_FAEDEN,
  };
}
