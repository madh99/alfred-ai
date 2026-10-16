/**
 * v1480 — Reagieren auf Vorgänge in der App (Owner 16.10.: „man hat nirgends die Möglichkeit, auf alle offenen Vorgänge zu reagieren“).
 * Ein Vorgang trägt im Ausführungsgedächtnis die Aktion, die Alfred vorgeschlagen hat (Skill + Parameter). Alfred-Vorgänge mit
 * „ausführen“ blieben offen, weil der Denk-Durchlauf dieselbe Aktion stündlich neu vorschlug, ohne sie auszuführen; „wartet“-Vorgänge
 * hingen an Bestätigungen, die nach drei Stunden abliefen. Der Klick des Owners in der App ist die Bestätigung: ausgeführt wird
 * genau die zuletzt vorgeschlagene Aktion. Reine Regeln ohne Modell.
 */

export interface SchrittLike { art: string; skill?: string; aktion?: string; params?: Record<string, unknown>; beschreibung: string; zeit: string }

export type Vorschlag =
  | { ausfuehrbar: true; skill: string; aktion?: string; params: Record<string, unknown>; beschreibung: string; zeit: string }
  | { ausfuehrbar: false; grund: string; skill?: string; beschreibung?: string };

const VORSCHLAG_ARTEN = new Set(['vorgeschlagen', 'zur_bestaetigung', 'fehlgeschlagen']);
/** Platzhalter, die das Modell statt eines echten Werts eingesetzt hat („<id-aus-liste>“, „{incident_id}“). */
const PLATZHALTER = /<[^<>\n]{2,40}>|\{\{?[a-z_]{2,30}\}?\}/i;

/** Ausführbare Aktion eines Vorgangs aus seinen Schritten (beliebige Reihenfolge); ohne Skill → nicht ausführbar. */
export function ausfuehrbarerVorschlag(schritte: SchrittLike[], skillVorhanden: (name: string) => boolean): Vorschlag | undefined {
  const kandidat = [...schritte].filter(s => VORSCHLAG_ARTEN.has(s.art) && s.skill && s.params).sort((a, b) => b.zeit.localeCompare(a.zeit))[0];
  if (!kandidat) return undefined;
  const skill = kandidat.skill!;
  if (!skillVorhanden(skill)) return { ausfuehrbar: false, grund: `Werkzeug ${skill} gibt es nicht mehr`, skill, beschreibung: kandidat.beschreibung };
  let text = '';
  try { text = JSON.stringify(kandidat.params); } catch { return { ausfuehrbar: false, grund: 'Parameter nicht lesbar', skill, beschreibung: kandidat.beschreibung }; }
  if (PLATZHALTER.test(text)) return { ausfuehrbar: false, grund: 'Vorschlag enthält einen Platzhalter statt eines Werts', skill, beschreibung: kandidat.beschreibung };
  return { ausfuehrbar: true, skill, aktion: kandidat.aktion ?? (typeof kandidat.params!.action === 'string' ? kandidat.params!.action as string : undefined), params: kandidat.params!, beschreibung: kandidat.beschreibung, zeit: kandidat.zeit };
}

/** Kurzfassung der Aktion für die Anzeige vor dem Ausführen („reminder · set · message=…“). */
export function vorschlagKurz(v: Vorschlag): string {
  if (!v.ausfuehrbar) return v.skill ? `${v.skill} — ${v.grund}` : v.grund;
  const teile = Object.entries(v.params).filter(([k]) => k !== 'action').slice(0, 4).map(([k, w]) => `${k}=${typeof w === 'string' ? w.slice(0, 120) : JSON.stringify(w)?.slice(0, 80)}`);
  return [v.skill, v.aktion, ...teile].filter(Boolean).join(' · ');
}

/** „Später“: erlaubte Rückstellungen (Stunden) — morgen früh wird vom Aufrufer berechnet. */
export const SPAETER_STUNDEN = [3, 24, 72, 168] as const;
