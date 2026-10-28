/**
 * v1704 (K1c, Spec 2026-10-27-kosten-infra-planung) — ausdrückliche Cache-Haltepunkte für die OpenAI-Responses-API (GPT-5.6 und neuer).
 *
 * Befund 28.10.: Im Standardmodus („implicit“) setzt OpenAI den Haltepunkt ans Ende der letzten Nachricht. Eine neue Nachricht stimmt
 * dort nie überein — die erste Runde las selbst bei 47 000 gleichen Zeichen Systemprompt und gleichen Werkzeugen 0 Token aus dem Cache.
 * Lösung laut OpenAI-Hilfe: wiederverwendbarer Entwicklertext als `input_text`-Block mit `prompt_cache_breakpoint` (top-level
 * `instructions` kann keinen Haltepunkt tragen) und `prompt_cache_options.mode = 'explicit'`.
 *
 * Haltepunkte (höchstens 4 je Anfrage): vor „## Available tools“ (alles davor ist fest), vor dem ersten wechselnden Abschnitt, am Ende
 * der neuen Nutzernachricht (damit die Folgerunden weiter treffen). Inhalt und Reihenfolge für das Modell bleiben gleich.
 */

/** Abschnitte, ab denen der Systemprompt je Nachricht wechselt (prompt-builder: laufende Sitzungen, Fehlermuster, Weltmodell …) */
export const WECHSELNDE_ABSCHNITTE = [
  '\n\n### Currently running project-agent sessions',
  '\n\n### No project-agent sessions are currently running',
  '\n\n## Known skill-failure patterns',
  '\n\n## Weltmodell',
  '\n\n## Beobachtete Interessen-Themen',
  '\n\n## User profile',
  '\n\n## Current date & time',
];
const WERKZEUGE = '\n\n## Available tools';

/** Systemprompt in bis zu drei Teile: fest | Werkzeugliste & Hinweise | wechselnd. Leere Teile entfallen. */
export function cacheTeile(system: string): string[] {
  const w = system.indexOf(WERKZEUGE);
  const ab = w > 0 ? w : 0;
  const wechsel = WECHSELNDE_ABSCHNITTE.map(m => system.indexOf(m, ab)).filter(i => i > ab).sort((a, b) => a - b)[0];
  const grenzen = [...(w > 0 ? [w] : []), ...(wechsel !== undefined ? [wechsel] : [])];
  const teile: string[] = [];
  let start = 0;
  for (const g of grenzen) { teile.push(system.slice(start, g)); start = g; }
  teile.push(system.slice(start));
  return teile.filter(t => t.length > 0);
}

const HALT = { mode: 'explicit' } as const;

/** Entwickler-Nachricht mit Haltepunkten nach jedem Teil außer dem letzten (der letzte wechselt, ein Haltepunkt dort lohnt nicht) */
export function entwicklerNachricht(system: string): Record<string, unknown> {
  const teile = cacheTeile(system);
  return {
    role: 'developer',
    content: teile.map((text, i) => ({ type: 'input_text', text, ...(i < teile.length - 1 || teile.length === 1 ? { prompt_cache_breakpoint: HALT } : {}) })),
  };
}

/** Haltepunkt ans Ende der letzten Nutzernachricht (für die Folgerunden derselben Nachricht) */
export function markiereLetzteNachricht(items: Array<Record<string, unknown>>): Array<Record<string, unknown>> {
  for (let i = items.length - 1; i >= 0; i--) {
    const it = items[i]!;
    if (it.role !== 'user') continue;
    const inhalt = typeof it.content === 'string' ? [{ type: 'input_text', text: it.content }] : Array.isArray(it.content) ? [...(it.content as Array<Record<string, unknown>>)] : [];
    if (!inhalt.length) return items;
    inhalt[inhalt.length - 1] = { ...inhalt[inhalt.length - 1]!, prompt_cache_breakpoint: HALT };
    const kopie = [...items]; kopie[i] = { ...it, content: inhalt };
    return kopie;
  }
  return items;
}

/** Ausdrückliche Haltepunkte nur für Modelle, die sie kennen (GPT-5.6 und neuer); Schalter ALFRED_OPENAI_CACHE_HALTEPUNKTE=aus */
export function haltepunkteAktiv(model: string, env: Record<string, string | undefined> = process.env): boolean {
  if (/^(aus|off|0|false|nein)$/i.test(env.ALFRED_OPENAI_CACHE_HALTEPUNKTE ?? '')) return false;
  return /^gpt-(5\.([6-9]|\d{2,})|[6-9]|\d{2,})/i.test(model);
}
