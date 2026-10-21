/**
 * v1480 — Reagieren auf Vorgänge in der App (Owner 16.10.: „man hat nirgends die Möglichkeit, auf alle offenen Vorgänge zu reagieren“).
 * Ein Vorgang trägt im Ausführungsgedächtnis die Aktion, die Alfred vorgeschlagen hat (Skill + Parameter). Alfred-Vorgänge mit
 * „ausführen“ blieben offen, weil der Denk-Durchlauf dieselbe Aktion stündlich neu vorschlug, ohne sie auszuführen; „wartet“-Vorgänge
 * hingen an Bestätigungen, die nach drei Stunden abliefen. Der Klick des Owners in der App ist die Bestätigung: ausgeführt wird
 * genau die zuletzt vorgeschlagene Aktion. Reine Regeln ohne Modell.
 */

export interface SchrittLike { art: string; skill?: string; aktion?: string; params?: Record<string, unknown>; beschreibung: string; zeit: string; ergebnis?: string }

export type Vorschlag =
  | { ausfuehrbar: true; skill: string; aktion?: string; params: Record<string, unknown>; beschreibung: string; zeit: string }
  | { ausfuehrbar: false; grund: string; skill?: string; beschreibung?: string };

const VORSCHLAG_ARTEN = new Set(['vorgeschlagen', 'zur_bestaetigung', 'fehlgeschlagen']);
/** Platzhalter, die das Modell statt eines echten Werts eingesetzt hat („<id-aus-liste>“, „{incident_id}“). */
const PLATZHALTER = /<[^<>\n]{2,40}>|\{\{?[a-z_]{2,30}\}?\}/i;

/** Ein Skill, soweit die Prüfung ihn braucht: sein Eingabe-Schema und optional eine eigene Prüfung je Aktion. */
export interface PruefbarerSkill { metadata: { inputSchema: Record<string, unknown> }; pruefeEingabe?(input: Record<string, unknown>): string | undefined }

/**
 * v1537 (Owner 21.10. „A+B+C“, Teil B) — Parameter eines Vorschlags gegen das Schema des Skills prüfen, bevor „Ausführen“ angeboten
 * wird: Pflichtfelder, erlaubte Aktion, Zahlen; dazu die Prüfung des Skills selbst (z. B. Proxmox: VM-Nummer oder -Name nötig).
 * Liefert den Grund oder undefined. Reine Regeln ohne Modell.
 */
export function eingabeFehler(skill: PruefbarerSkill, params: Record<string, unknown>): string | undefined {
  const schema = skill.metadata.inputSchema as { properties?: Record<string, { type?: string; enum?: unknown[] }>; required?: string[] };
  const props = schema.properties ?? {};
  for (const f of schema.required ?? []) {
    const w = params[f];
    if (w === undefined || w === null || (typeof w === 'string' && !w.trim())) return `Pflichtfeld „${f}“ fehlt`;
  }
  for (const [k, w] of Object.entries(params)) {
    const def = props[k];
    if (!def || w === undefined || w === null) continue;
    if (def.enum && !def.enum.includes(w)) return `„${k}“ hat einen unbekannten Wert (${String(w).slice(0, 40)})`;
    if ((def.type === 'number' || def.type === 'integer') && typeof w !== 'number' && !(typeof w === 'string' && /^-?\d+(\.\d+)?$/.test(w.trim()))) {
      if (!skill.pruefeEingabe) return `„${k}“ muss eine Zahl sein`; // ein Skill mit eigener Prüfung darf Namen statt Nummern auflösen
    }
  }
  try { return skill.pruefeEingabe?.(params); } catch (err) { return (err as Error).message.slice(0, 200); }
}

/** Fehlermeldungen, die auf falsche oder fehlende Parameter deuten (nach einer Korrektur der Prüfung darf neu versucht werden). */
const PARAMETER_FEHLER = /missing required|required (field|parameter)|pflichtfeld|fehlt|invalid|ungültig|must be|muss/i;
/** „vom Owner ausgeführt (App): “ stapelte sich bei jedem Klick (Realfall 21.10.: viermal). */
const OWNER_VORSILBE = /^(vom Owner ausgeführt \(App\): )+/;

/** Ausführbare Aktion eines Vorgangs aus seinen Schritten (beliebige Reihenfolge); ohne Skill → nicht ausführbar. */
export function ausfuehrbarerVorschlag(schritte: SchrittLike[], skillVorhanden: (name: string) => boolean, skillFuer?: (name: string) => PruefbarerSkill | undefined): Vorschlag | undefined {
  const sortiert = [...schritte].filter(s => VORSCHLAG_ARTEN.has(s.art) && s.skill && s.params).sort((a, b) => b.zeit.localeCompare(a.zeit));
  const kandidat = sortiert[0];
  if (!kandidat) return undefined;
  const skill = kandidat.skill!;
  // v1537 — Beschreibung aus dem letzten echten Vorschlag, ohne gestapelte Vorsilben
  const vorschlag = sortiert.find(s => s.art !== 'fehlgeschlagen') ?? kandidat;
  const beschreibung = vorschlag.beschreibung.replace(OWNER_VORSILBE, '');
  if (!skillVorhanden(skill)) return { ausfuehrbar: false, grund: `Werkzeug ${skill} gibt es nicht mehr`, skill, beschreibung };
  let text = '';
  try { text = JSON.stringify(kandidat.params); } catch { return { ausfuehrbar: false, grund: 'Parameter nicht lesbar', skill, beschreibung }; }
  if (PLATZHALTER.test(text)) return { ausfuehrbar: false, grund: 'Vorschlag enthält einen Platzhalter statt eines Werts', skill, beschreibung };
  const pruefbar = skillFuer?.(skill);
  const fehler = pruefbar ? eingabeFehler(pruefbar, kandidat.params!) : undefined;
  if (fehler) return { ausfuehrbar: false, grund: `Vorschlag unvollständig: ${fehler}`, skill, beschreibung };
  // v1537 Teil C — dieselbe Aktion mit denselben Parametern ist seit dem letzten Vorschlag schon fehlgeschlagen: nicht wiederholen.
  // Ausnahme: der Fehler betraf die Parameter und die (inzwischen verbesserte) Prüfung lässt sie jetzt durch.
  if (kandidat.art === 'fehlgeschlagen') {
    const grund = kandidat.ergebnis ?? 'unbekannter Fehler';
    const erneutErlaubt = !!pruefbar && PARAMETER_FEHLER.test(grund) && vorschlag !== kandidat && JSON.stringify(vorschlag.params) === text
      && sortiert.filter(s => s.art === 'fehlgeschlagen' && s.zeit > vorschlag.zeit).every(s => PARAMETER_FEHLER.test(s.ergebnis ?? ''));
    if (!erneutErlaubt) {
      return { ausfuehrbar: false, grund: `Gleiche Aktion schlug zuletzt fehl: ${grund.slice(0, 200)}`, skill, beschreibung };
    }
  }
  return { ausfuehrbar: true, skill, aktion: kandidat.aktion ?? (typeof kandidat.params!.action === 'string' ? kandidat.params!.action as string : undefined), params: kandidat.params!, beschreibung, zeit: kandidat.zeit };
}

/** Kurzfassung der Aktion für die Anzeige vor dem Ausführen („reminder · set · message=…“). */
export function vorschlagKurz(v: Vorschlag): string {
  if (!v.ausfuehrbar) return v.skill ? `${v.skill} — ${v.grund}` : v.grund;
  const teile = Object.entries(v.params).filter(([k]) => k !== 'action').slice(0, 4).map(([k, w]) => `${k}=${typeof w === 'string' ? w.slice(0, 120) : JSON.stringify(w)?.slice(0, 80)}`);
  return [v.skill, v.aktion, ...teile].filter(Boolean).join(' · ');
}

/** „Später“: erlaubte Rückstellungen (Stunden) — morgen früh wird vom Aufrufer berechnet. */
export const SPAETER_STUNDEN = [3, 24, 72, 168] as const;
