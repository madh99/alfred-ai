/**
 * v928 — Insight-Aktionen mit User-Eingaben.
 *
 * Ein Insight kann in `sourceData` deklarieren, welche Eingaben seine Aktion
 * braucht (`inputFields`) und wie der Button heißen soll (`actionLabel`) —
 * ohne Schema-Migration. Die actionParams enthalten `{{key}}`-Platzhalter,
 * die beim Ausführen mit den User-Eingaben gefüllt werden.
 *
 * Beispiel (KG-Gap Geburtstag):
 *   sourceData.actionLabel = 'Geburtstag eintragen'
 *   sourceData.inputFields = [{ key: 'birthday', label: 'Geburtsdatum', type: 'date' }]
 *   actionParams = { action: 'save', key: 'geburtstag_hannah', value: 'Hannahs Geburtstag ist {{birthday}}' }
 */

export interface InsightInputField {
  key: string;
  label: string;
  type: 'date' | 'text' | 'number';
}

/** Liest inputFields aus sourceData (tolerant gegen fremde/kaputte Formate). */
export function extractInputFields(sourceData: Record<string, unknown> | undefined): InsightInputField[] {
  const raw = sourceData?.inputFields;
  if (!Array.isArray(raw)) return [];
  const fields: InsightInputField[] = [];
  for (const f of raw) {
    if (!f || typeof f !== 'object') continue;
    const key = (f as Record<string, unknown>).key;
    const label = (f as Record<string, unknown>).label;
    const type = (f as Record<string, unknown>).type;
    if (typeof key !== 'string' || key.length === 0) continue;
    fields.push({
      key,
      label: typeof label === 'string' && label.length > 0 ? label : key,
      type: type === 'date' || type === 'number' ? type : 'text',
    });
  }
  return fields;
}

export type ApplyInputsResult =
  | { ok: true; params: Record<string, unknown> }
  | { ok: false; missing: string[] };

/**
 * Validiert die User-Eingaben gegen die deklarierten Felder und füllt
 * `{{key}}`-Platzhalter in allen String-Werten der actionParams (rekursiv).
 * Fehlen deklarierte Eingaben → Fehler mit Liste (UI zeigt „Eingabe erforderlich").
 * Nicht deklarierte params werden ignoriert (kein Injection-Kanal).
 */
export function applyActionInputs(
  actionParams: Record<string, unknown>,
  inputFields: InsightInputField[],
  inputs: Record<string, unknown> | undefined,
): ApplyInputsResult {
  if (inputFields.length === 0) return { ok: true, params: actionParams };

  const provided = inputs ?? {};
  const values: Record<string, string> = {};
  const missing: string[] = [];
  for (const field of inputFields) {
    const v = provided[field.key];
    const s = v === undefined || v === null ? '' : String(v).trim();
    if (s.length === 0) { missing.push(field.key); continue; }
    values[field.key] = s;
  }
  if (missing.length > 0) return { ok: false, missing };

  const substitute = (val: unknown): unknown => {
    if (typeof val === 'string') {
      return val.replace(/\{\{\s*([a-zA-Z0-9_-]+)\s*\}\}/g, (m, key: string) => values[key] ?? m);
    }
    if (Array.isArray(val)) return val.map(substitute);
    if (val && typeof val === 'object') {
      const out: Record<string, unknown> = {};
      for (const [k, v] of Object.entries(val as Record<string, unknown>)) out[k] = substitute(v);
      return out;
    }
    return val;
  };

  return { ok: true, params: substitute(actionParams) as Record<string, unknown> };
}
