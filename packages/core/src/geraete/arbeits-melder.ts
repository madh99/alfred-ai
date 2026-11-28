/**
 * v1354 — „Alfred arbeitet" auf allen Geräten des Owners (Owner 11.10.: schreibt er in Telegram und Alfred arbeitet,
 * sah die App nichts, bis die Antwort fertig war). Für jede Anfrage in einem Owner-Gespräch (Hauptgespräch oder Faden)
 * gehen kurze Ereignisse an die Geräte: start (mit Frage), status (gedrosselt), ende. Die Statustexte sind dieselben, die
 * der anfragende Kanal bekommt (onProgress der Pipeline). Die Arbeits-ID erlaubt Owner-Geräten den Abbruch genau dieser
 * Anfrage (`POST /api/geraete/abbrechen {arbeit}`).
 *
 * v1975 — Owner 28.11. („sehr mühsam, wenn man nicht weiß, womit er beschäftigt ist und seit wann“): Beginn (`seit`),
 * Modell, bisherige Kosten und Runde der Werkzeugschleife reisen mit jedem Status mit.
 */

export interface ArbeitsMeta {
  modell?: string;
  kostenUsd?: number;
  runde?: number;
}

export interface ArbeitsEreignis extends ArbeitsMeta {
  arbeit: string;
  faden: string | null;
  von: { platform: string; chatId: string };
  phase: 'start' | 'status' | 'ende';
  text?: string;
  frage?: string;
  /** v1975 — Beginn der Anfrage (ISO), bei jedem Ereignis */
  seit?: string;
}

type Fortschritt = string | { kind: string; text: string };

export interface ArbeitsMelder {
  start(frage: string): void;
  status(p: Fortschritt): void;
  /** v1975 — Modell/Kosten/Runde nach jedem Modellaufruf; geht mit dem nächsten (gedrosselten) Status raus */
  meta(m: ArbeitsMeta): void;
  ende(): void;
}

/**
 * Melder für eine Anfrage. Status: nur echte Texte (keine Antwort-Deltas), nur bei Änderung, höchstens alle `abstandMs`.
 * Ein Status, der in die Sperrzeit fällt, wird nachgereicht, wenn sie abläuft (sonst bliebe ein veralteter Text stehen).
 * Neue Meta-Werte lösen einen Status mit dem bisherigen Text aus (gleiche Drosselung).
 * Nach `ende` geht nichts mehr raus; `ende` kommt genau einmal. Fehler beim Melden schlucken (Komfort, nie die Anfrage stören).
 */
export function arbeitsMelder(
  basis: Omit<ArbeitsEreignis, 'phase' | 'text' | 'frage' | 'seit' | keyof ArbeitsMeta>,
  melde: (e: ArbeitsEreignis) => void,
  opts: { abstandMs?: number; jetzt?: () => number; spaeter?: (fn: () => void, ms: number) => unknown; abbrechenSpaeter?: (h: unknown) => void } = {},
): ArbeitsMelder {
  const abstand = opts.abstandMs ?? 2000;
  const jetzt = opts.jetzt ?? Date.now;
  const spaeter = opts.spaeter ?? ((fn, ms) => setTimeout(fn, ms));
  const abbrechen = opts.abbrechenSpaeter ?? ((h) => clearTimeout(h as ReturnType<typeof setTimeout>));
  const seit = new Date(jetzt()).toISOString();
  let fertig = false;
  let zuletzt = -Infinity;
  let gesendet = '';
  let text = '';
  let meta: ArbeitsMeta = {};
  let metaGesendet = '';
  let wartet = false;
  let timer: unknown;
  const metaSchluessel = () => JSON.stringify(meta);
  const sende = (e: Pick<ArbeitsEreignis, 'phase'> & Partial<ArbeitsEreignis>) => { try { melde({ ...basis, seit, ...e } as ArbeitsEreignis); } catch { /* Komfort */ } };
  const jetztSenden = () => {
    zuletzt = jetzt(); gesendet = text; metaGesendet = metaSchluessel(); wartet = false;
    sende({ phase: 'status', ...(text ? { text } : {}), ...meta });
  };
  const anstossen = () => {
    if (fertig || (text === gesendet && metaSchluessel() === metaGesendet)) return;
    const rest = abstand - (jetzt() - zuletzt);
    if (rest <= 0) { jetztSenden(); return; }
    if (wartet) return;
    wartet = true;
    timer = spaeter(() => { timer = undefined; wartet = false; if (!fertig && (text !== gesendet || metaSchluessel() !== metaGesendet)) jetztSenden(); }, rest);
  };
  return {
    start(frage) { if (!fertig) sende({ phase: 'start', frage: frage.slice(0, 2000) }); },
    status(p) {
      if (fertig) return;
      const t = (typeof p === 'string' ? p : p.kind === 'delta' ? '' : p.text ?? '').trim().slice(0, 160);
      if (!t) return;
      text = t;
      anstossen();
    },
    meta(m) {
      if (fertig) return;
      meta = {
        ...meta,
        ...(m.modell ? { modell: m.modell.slice(0, 80) } : {}),
        ...(typeof m.kostenUsd === 'number' && Number.isFinite(m.kostenUsd) ? { kostenUsd: Math.round(m.kostenUsd * 10000) / 10000 } : {}),
        ...(typeof m.runde === 'number' ? { runde: m.runde } : {}),
      };
      anstossen();
    },
    ende() {
      if (fertig) return;
      fertig = true;
      if (timer !== undefined) abbrechen(timer);
      sende({ phase: 'ende', ...meta });
    },
  };
}
