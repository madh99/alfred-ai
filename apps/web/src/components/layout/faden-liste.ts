// v1497 — Gesprächsfäden in der Seitenleiste ordnen (wie die App 1.41.0, lib/faden_liste.dart).
// Owner 18.10.: nicht alle Fäden sichtbar (nur 12 inkl. Hauptgespräch), anheften und archivieren fehlten.

export interface FadenEintrag { faden: string | null; titel: string; zeit: string; anzahl: number; archiv?: string; angeheftet?: boolean; archiviert?: boolean }

export const SICHTBARE_FAEDEN = 12;

export interface FadenGruppen {
  haupt?: FadenEintrag;
  angeheftet: FadenEintrag[];
  gespraeche: FadenEintrag[];
  weitere: number;
  archiviert: FadenEintrag[];
  filterSinnvoll: boolean;
}

export function fadenTitel(f: FadenEintrag): string {
  return f.titel?.trim() || `Gespräch ${f.faden ?? ''}`.trim();
}

export function fadenGruppen(faeden: FadenEintrag[], opts: { alle?: boolean; filter?: string; ausgeblendet?: Set<string> } = {}): FadenGruppen {
  const f = (opts.filter ?? '').trim().toLowerCase();
  const passt = (x: FadenEintrag) => !f || fadenTitel(x).toLowerCase().includes(f);
  const eigene = faeden.filter(x => x.faden && !x.archiv && !opts.ausgeblendet?.has(x.faden));
  const aktiv = eigene.filter(x => !x.archiviert);
  const normal = aktiv.filter(x => !x.angeheftet && passt(x));
  const zeigen = opts.alle || f ? normal : normal.slice(0, SICHTBARE_FAEDEN);
  return {
    haupt: faeden.find(x => x.faden === null && !x.archiv),
    angeheftet: aktiv.filter(x => x.angeheftet && passt(x)),
    gespraeche: zeigen,
    weitere: normal.length - zeigen.length,
    archiviert: eigene.filter(x => x.archiviert && passt(x)),
    filterSinnvoll: aktiv.length > SICHTBARE_FAEDEN,
  };
}
