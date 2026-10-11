/**
 * v1354 — „Alfred arbeitet" auf allen Geräten des Owners (Owner 11.10.: schreibt er in Telegram und Alfred arbeitet,
 * sah die App nichts, bis die Antwort fertig war). Für jede Anfrage in einem Owner-Gespräch (Hauptgespräch oder Faden)
 * gehen kurze Ereignisse an die Geräte: start (mit Frage), status (gedrosselt), ende. Die Statustexte sind dieselben, die
 * der anfragende Kanal bekommt (onProgress der Pipeline). Die Arbeits-ID erlaubt Owner-Geräten den Abbruch genau dieser
 * Anfrage (`POST /api/geraete/abbrechen {arbeit}`).
 */

export interface ArbeitsEreignis {
  arbeit: string;
  faden: string | null;
  von: { platform: string; chatId: string };
  phase: 'start' | 'status' | 'ende';
  text?: string;
  frage?: string;
}

type Fortschritt = string | { kind: string; text: string };

export interface ArbeitsMelder {
  start(frage: string): void;
  status(p: Fortschritt): void;
  ende(): void;
}

/**
 * Melder für eine Anfrage. Status: nur echte Texte (keine Antwort-Deltas), nur bei Änderung, höchstens alle `abstandMs`.
 * Ein Status, der in die Sperrzeit fällt, wird nachgereicht, wenn sie abläuft (sonst bliebe ein veralteter Text stehen).
 * Nach `ende` geht nichts mehr raus; `ende` kommt genau einmal. Fehler beim Melden schlucken (Komfort, nie die Anfrage stören).
 */
export function arbeitsMelder(
  basis: Omit<ArbeitsEreignis, 'phase' | 'text' | 'frage'>,
  melde: (e: ArbeitsEreignis) => void,
  opts: { abstandMs?: number; jetzt?: () => number; spaeter?: (fn: () => void, ms: number) => unknown; abbrechenSpaeter?: (h: unknown) => void } = {},
): ArbeitsMelder {
  const abstand = opts.abstandMs ?? 2000;
  const jetzt = opts.jetzt ?? Date.now;
  const spaeter = opts.spaeter ?? ((fn, ms) => setTimeout(fn, ms));
  const abbrechen = opts.abbrechenSpaeter ?? ((h) => clearTimeout(h as ReturnType<typeof setTimeout>));
  let fertig = false;
  let zuletzt = -Infinity;
  let gesendet = '';
  let wartend: string | undefined;
  let timer: unknown;
  const sende = (e: Omit<ArbeitsEreignis, keyof typeof basis>) => { try { melde({ ...basis, ...e } as ArbeitsEreignis); } catch { /* Komfort */ } };
  const statusSenden = (text: string) => { zuletzt = jetzt(); gesendet = text; wartend = undefined; sende({ phase: 'status', text }); };
  return {
    start(frage) { if (!fertig) sende({ phase: 'start', frage: frage.slice(0, 2000) }); },
    status(p) {
      if (fertig) return;
      const text = (typeof p === 'string' ? p : p.kind === 'delta' ? '' : p.text ?? '').trim().slice(0, 160);
      if (!text || text === gesendet) return;
      const rest = abstand - (jetzt() - zuletzt);
      if (rest <= 0) { statusSenden(text); return; }
      const ersteWartende = wartend === undefined;
      wartend = text;
      if (ersteWartende) timer = spaeter(() => { timer = undefined; if (!fertig && wartend !== undefined && wartend !== gesendet) statusSenden(wartend); }, rest);
    },
    ende() {
      if (fertig) return;
      fertig = true;
      if (timer !== undefined) abbrechen(timer);
      sende({ phase: 'ende' });
    },
  };
}
