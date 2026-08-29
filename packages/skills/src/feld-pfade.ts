/**
 * v1147 — M1/M2: Feld-Pfade aus Skill-Ergebnisdaten einsammeln.
 *
 * Watches scheiterten still, weil das LLM beim Anlegen ein `condition_field`
 * riet, das in den echten Skill-Daten nie existierte (39 von 40 Watches hatten
 * `last_value = "null"` und triggerten NIE). Diese Helfer machen die
 * tatsächlich verfügbaren Felder sichtbar — beim Anlegen (Probe) und im
 * Reparatur-Pfad der Engine.
 */

/** Wert an einem Punkt-Pfad lesen (Arrays: Index oder `length`). */
export function extrahiereFeldPfad(data: unknown, pfad: string): unknown {
  let aktuell: unknown = data;
  for (const teil of pfad.split('.')) {
    if (aktuell == null) return undefined;
    if (Array.isArray(aktuell)) {
      if (teil === 'length') { aktuell = aktuell.length; continue; }
      const idx = parseInt(teil, 10);
      if (isNaN(idx)) return undefined;
      aktuell = aktuell[idx];
      continue;
    }
    if (typeof aktuell === 'object') {
      aktuell = (aktuell as Record<string, unknown>)[teil];
      continue;
    }
    return undefined;
  }
  return aktuell;
}

/** Alle Feld-Pfade bis Tiefe `maxTiefe` einsammeln (Arrays → `0.` + `length`). */
export function sammleFeldPfade(data: unknown, maxTiefe = 3): string[] {
  const pfade: string[] = [];
  const laufe = (wert: unknown, prefix: string, tiefe: number): void => {
    if (wert == null || tiefe > maxTiefe || pfade.length >= 120) return;
    if (Array.isArray(wert)) {
      pfade.push(`${prefix}length`);
      if (wert.length > 0) laufe(wert[0], `${prefix}0.`, tiefe + 1);
      return;
    }
    if (typeof wert !== 'object') return;
    for (const [k, v] of Object.entries(wert as Record<string, unknown>)) {
      if (v == null || typeof v !== 'object') pfade.push(`${prefix}${k}`);
      else {
        pfade.push(`${prefix}${k}`);
        laufe(v, `${prefix}${k}.`, tiefe + 1);
      }
      if (pfade.length >= 120) return;
    }
  };
  laufe(data, '', 0);
  return pfade;
}
