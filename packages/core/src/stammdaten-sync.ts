import type { Logger } from 'pino';
import type { KnowledgeGraphRepository, MemoryRepository } from '@alfred/storage';
import { normalisierePersonenName, provEintrag, darfUeberschreiben, type ProvEintrag } from './wissens-schema.js';
import { INTERNAL_MEMORY_KEY_PREFIXES } from './knowledge-graph.js';

/**
 * v1146 — S3: Der deterministische Stammdaten-Sync — das bisher FEHLENDE
 * konstruktive Stück des Gehirns. Deine expliziten Aussagen (hochkonfidente
 * Memories) sind die Wahrheit des Systems, aber nur der ratende LLM-Pfad
 * übersetzte sie je in den Graph — den haben wir zu Recht entmachtet, ohne
 * Ersatz. Jetzt übersetzt CODE: „Nichte Emma, geboren 12.03.2020" wird zur
 * Person „Emma" (Beziehung: Nichte, birthdate gesetzt, Herkunft am Attribut)
 * — und der Vorausschau-Radar kennt ihren Geburtstag ab dem nächsten Lauf.
 * Das LLM darf weiterhin vorschlagen; schreiben tut es hier nicht.
 */

export interface PersonenFakt {
  vorname: string;
  beziehung?: string;
  birthdate?: string;       // ISO yyyy-mm-dd
  fullName?: string;
  quelle: string;           // memory:<key>
  konfidenz: number;
}

function parseDatum(roh: string): string | null {
  let m = roh.match(/(\d{4})-(\d{2})-(\d{2})/);
  if (m) return `${m[1]}-${m[2]}-${m[3]}`;
  m = roh.match(/(\d{1,2})\.(\d{1,2})\.(\d{4})/);
  if (m) return `${m[3]}-${m[2].padStart(2, '0')}-${m[1].padStart(2, '0')}`;
  return null;
}

/**
 * Personen-Fakten aus Memories extrahieren — reine Funktion, testbar.
 * Regeln (bewusst eng — lieber weniger, dafür sicher):
 *  1. „[Rolle] Name, geboren <Datum>"  → Vorname + Beziehung + birthdate
 *  2. Key `*_full_name` → fullName (Person via Vornamen des Werts)
 *  3. „Name ist meine/mein <Beziehung>" → Beziehung
 */
export function extrahierePersonenFakten(
  memories: Array<{ key: string; value: string; confidence: number }>,
  minKonfidenz = 0.9,
): PersonenFakt[] {
  const fakten = new Map<string, PersonenFakt>();
  const hole = (vorname: string, quelle: string, konfidenz: number): PersonenFakt => {
    const k = vorname.toLowerCase();
    let f = fakten.get(k);
    if (!f) { f = { vorname, quelle, konfidenz }; fakten.set(k, f); }
    return f;
  };

  for (const m of memories) {
    if (m.confidence < minKonfidenz) continue;
    if (INTERNAL_MEMORY_KEY_PREFIXES.test(m.key)) continue;

    // Regel 2: *_full_name → „Lena Habel"
    if (/_full_name$/.test(m.key)) {
      const voll = m.value.trim();
      const wm = voll.match(/^([A-ZÄÖÜ][\wäöüß-]+)(\s+[A-ZÄÖÜ][\wäöüß-]+)+$/);
      if (wm) {
        const f = hole(wm[1], `memory:${m.key}`, m.confidence);
        f.fullName = voll;
      }
      continue;
    }

    // Regel 1: „[Rolle] Name, geboren <Datum>" (auch mitten im Text)
    const geb = m.value.match(/([A-ZÄÖÜ][\wäöüß-]+(?:\s+[A-ZÄÖÜ][\wäöüß-]+)?)\s*,?\s*geboren(?:\s+am)?\s+([\d.\-]+)/);
    if (geb) {
      const datum = parseDatum(geb[2]);
      if (datum) {
        const phrase = geb[1].trim();
        const norm = normalisierePersonenName(phrase);
        const vorname = norm ? norm.name.split(/\s+/)[0] : phrase.split(/\s+/)[0];
        const f = hole(vorname, `memory:${m.key}`, m.confidence);
        f.birthdate = datum;
        if (norm?.beziehung && !f.beziehung) f.beziehung = norm.beziehung;
        if (!norm && phrase.split(/\s+/).length > 1) f.fullName = f.fullName ?? phrase;
      }
    }

    // Regel 3: „Name ist meine/mein Beziehung"
    const bez = m.value.match(/([A-ZÄÖÜ][\wäöüß-]+)\s+ist\s+mein[e]?\s+([A-Za-zÄÖÜäöüß]+)/);
    if (bez) {
      const norm = normalisierePersonenName(`${bez[2]} ${bez[1]}`);
      if (norm) {
        const f = hole(norm.name, `memory:${m.key}`, m.confidence);
        if (!f.beziehung) f.beziehung = norm.beziehung;
      }
    }
  }
  return [...fakten.values()];
}

/**
 * Beziehungs-Wort → KG-Relation (Richtung relativ zum User). Kinder werden
 * parent_of-Kinder, Eltern parent_of-Eltern, Partner spouse, alles andere
 * 'family' mit der Beziehung als Kontext (der Stammdaten-Block rendert daraus
 * die Rolle).
 */
export function beziehungZuRelation(beziehung: string): { typ: string; richtung: 'user_zu_person' | 'person_zu_user' } {
  const b = beziehung.toLowerCase();
  if (/sohn|tochter|stiefsohn|stieftochter|enkel/.test(b)) return { typ: 'parent_of', richtung: 'user_zu_person' };
  if (/mutter|vater|großmutter|großvater/.test(b)) return { typ: 'parent_of', richtung: 'person_zu_user' };
  if (/ehefrau|ehemann|partner/.test(b)) return { typ: 'spouse', richtung: 'user_zu_person' };
  return { typ: 'family', richtung: 'user_zu_person' };
}

export class StammdatenSync {
  constructor(
    private readonly kgRepo: KnowledgeGraphRepository,
    private readonly memoryRepo: MemoryRepository,
    private readonly logger: Logger,
  ) {}

  /** Fakten in den Graph übertragen: Person finden/anlegen, Attribute mit Herkunft setzen. */
  async run(userId: string): Promise<{ gesetzt: number; angelegt: number }> {
    let gesetzt = 0; let angelegt = 0;
    try {
      const memories = (await this.memoryRepo.listAll(userId))
        .map(m => ({ key: m.key, value: m.value, confidence: m.confidence }));
      const fakten = extrahierePersonenFakten(memories);
      if (fakten.length === 0) return { gesetzt, angelegt };

      const personen = await this.kgRepo.getEntitiesByType(userId, 'person');
      const findePerson = (vorname: string) => {
        const v = vorname.toLowerCase();
        return personen.find(p => {
          if (p.name === 'User') return false;
          const a = (p.attributes ?? {}) as Record<string, unknown>;
          const kandidaten = [p.name, String(a.fullName ?? ''), ...(Array.isArray(a.alias) ? a.alias.map(String) : [])];
          return kandidaten.some(k => k.toLowerCase() === v || k.toLowerCase().split(/\s+/)[0] === v
            || k.toLowerCase().split(/\s+/).slice(-2).join(' ').startsWith(v));
        });
      };

      for (const f of fakten) {
        let person = findePerson(f.vorname);
        if (!person && f.beziehung) {
          // Konstruktiver Pfad: neue Person aus expliziter Beziehungs-Aussage —
          // mit richtigem NAMEN (kein Rollen-Präfix) und Herkunft am Attribut.
          const name = f.fullName ?? f.vorname;
          person = await this.kgRepo.upsertEntity(userId, name, 'person', {
            relation_to_user: f.beziehung,
            ...(f.fullName ? { fullName: f.fullName } : {}),
            _prov: { relation_to_user: provEintrag(f.quelle, f.konfidenz) },
          }, 'memories');
          personen.push(person);
          angelegt++;
          this.logger.info({ name, beziehung: f.beziehung }, 'v1146 Stammdaten-Sync: Person angelegt');
        }
        if (!person) continue;

        const attrs = { ...((person.attributes ?? {}) as Record<string, unknown>) };
        const prov = { ...((attrs._prov ?? {}) as Record<string, ProvEintrag>) };
        let geaendert = false;
        const setze = (key: string, wert: unknown) => {
          if (wert === undefined || attrs[key] === wert) return;
          if (!darfUeberschreiben(prov[key], f.quelle)) return;
          attrs[key] = wert;
          prov[key] = provEintrag(f.quelle, f.konfidenz);
          geaendert = true;
        };
        setze('birthdate', f.birthdate);
        setze('fullName', f.fullName);
        setze('relation_to_user', f.beziehung);
        if (geaendert) {
          attrs._prov = prov;
          await this.kgRepo.setEntityAttributes(person.id, attrs);
          gesetzt++;
        }

        // Beziehungs-RELATION zum User anlegen (idempotent) — ohne sie
        // erscheint die Person nie im Familien-Block des Chat-Kontexts.
        if (f.beziehung) {
          const user = personen.find(p => p.name === 'User');
          if (user) {
            const rel = beziehungZuRelation(f.beziehung);
            const [von, zu] = rel.richtung === 'user_zu_person' ? [user.id, person.id] : [person.id, user.id];
            await this.kgRepo.upsertRelation(userId, von, zu, rel.typ as never, f.beziehung.toLowerCase(), 'memories')
              .catch(() => { /* Relation best-effort */ });
          }
        }
      }
      if (gesetzt > 0 || angelegt > 0) {
        this.logger.info({ gesetzt, angelegt }, 'v1146 Stammdaten-Sync abgeschlossen');
      }
    } catch (err) {
      this.logger.debug({ err }, 'v1146 Stammdaten-Sync fehlgeschlagen');
    }
    return { gesetzt, angelegt };
  }
}
