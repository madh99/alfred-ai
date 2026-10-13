/**
 * v1429 R4a — Beobachter-Regeln: reine Regeln ohne Modell (Prüfen der Eingabe, Nutzlast fürs Gerät, Texte für Treffer und
 * Lebenszeichen). Spec Jarvis „R4 Beobachter am Satelliten" B1–B3, B7; Owner-Entscheidungen 13.10.
 */

export type Quelle = 'ordner' | 'benachrichtigung' | 'outlook' | 'build';
export type Wirkung = 'hinweis' | 'vorgang' | 'aufgabe' | 'projekt';
export const WIRKUNGEN: readonly Wirkung[] = ['hinweis', 'vorgang', 'aufgabe', 'projekt'];
export const ORDNER_ARTEN = ['neu', 'geaendert', 'geloescht'] as const;

export interface RegelLike {
  id: string; geraetId: string; geraet: string; name: string; quelle: Quelle; filter: Record<string, unknown>;
  wirkung: Wirkung; auftrag?: string; skills?: string[]; projektId?: string; aktiv: boolean; treffer?: number; letzterTreffer?: string;
}

export interface Treffer { regel: string; quelle: string; art: string; schluessel: string; zeit: string; kopf: Record<string, unknown> }

/** Eingabe aus Gespräch/App/Web prüfen. Gerät per Name oder ID aus den Owner-Geräten. */
export function regelPruefen(roh: Record<string, unknown>, geraete: Array<{ id: string; name: string }>, projekte: Array<{ id: string; name: string }> = []):
  { ok: true; regel: Omit<RegelLike, 'id' | 'treffer' | 'letzterTreffer'> } | { ok: false; fehler: string } {
  const gName = String(roh.geraet ?? roh.geraetId ?? '').trim().toLowerCase();
  const g = geraete.find(x => x.id === gName || x.name.toLowerCase() === gName) ?? (geraete.length === 1 && !gName ? geraete[0] : undefined);
  if (!g) return { ok: false, fehler: `Gerät fehlt oder unbekannt (${geraete.map(x => x.name).join(', ') || 'keine Geräte'})` };
  const quelle = String(roh.quelle ?? 'ordner') as Quelle;
  if (quelle !== 'ordner') return { ok: false, fehler: `Quelle „${quelle}" kommt mit R4b — jetzt: ordner` };
  const f = (roh.filter && typeof roh.filter === 'object' ? roh.filter : roh) as Record<string, unknown>;
  const pfad = String(f.pfad ?? f.ordner ?? '').trim();
  if (!pfad || !/^([a-zA-Z]:[\\/]|\/|~)/.test(pfad)) return { ok: false, fehler: 'pfad fehlt (absoluter Ordner auf dem Gerät, z. B. C:\\Users\\madh\\Downloads oder /home/madh/Downloads)' };
  const ereignisse = (Array.isArray(f.ereignisse) ? f.ereignisse : typeof f.ereignisse === 'string' ? f.ereignisse.split(/[,\s]+/) : ['neu'])
    .map(x => String(x).trim().toLowerCase().replace('geändert', 'geaendert').replace('gelöscht', 'geloescht'))
    .filter((x): x is typeof ORDNER_ARTEN[number] => (ORDNER_ARTEN as readonly string[]).includes(x));
  const wirkung = String(roh.wirkung ?? 'hinweis') as Wirkung;
  if (!WIRKUNGEN.includes(wirkung)) return { ok: false, fehler: `wirkung muss ${WIRKUNGEN.join(', ')} sein` };
  const auftrag = typeof roh.auftrag === 'string' && roh.auftrag.trim() ? roh.auftrag.trim().slice(0, 2000) : undefined;
  if ((wirkung === 'aufgabe' || wirkung === 'projekt') && !auftrag) return { ok: false, fehler: `Für „${wirkung}" fehlt der Auftrag (was Alfred tun soll)` };
  let projektId: string | undefined;
  if (wirkung === 'projekt') {
    const pn = String(roh.projekt ?? roh.projektId ?? '').trim().toLowerCase();
    const teil = pn ? projekte.filter(x => x.name.toLowerCase().includes(pn)) : [];
    const p = projekte.find(x => x.id === pn || x.name.toLowerCase() === pn || (pn.length >= 8 && x.id.startsWith(pn))) ?? (teil.length === 1 ? teil[0] : undefined); // eindeutiger Teilname
    if (!p) return { ok: false, fehler: `Projekt fehlt oder unbekannt (${projekte.map(x => x.name).join(', ') || 'keine Projekte'})` };
    projektId = p.id;
  }
  const muster = typeof f.muster === 'string' && f.muster.trim() ? f.muster.trim().slice(0, 200) : undefined;
  const name = String(roh.name ?? '').trim().slice(0, 80) || `${muster ?? 'Dateien'} in ${pfad.split(/[\\/]/).filter(Boolean).pop() ?? pfad}`;
  const skills = Array.isArray(roh.skills) ? roh.skills.map(String).slice(0, 12) : undefined;
  return {
    ok: true,
    regel: {
      geraetId: g.id, geraet: g.name, name, quelle, wirkung, aktiv: roh.aktiv !== false,
      filter: { pfad, ...(muster ? { muster } : {}), ereignisse: ereignisse.length ? ereignisse : ['neu'], ...(f.unterordner === true ? { unterordner: true } : {}) },
      ...(auftrag ? { auftrag } : {}), ...(skills?.length ? { skills } : {}), ...(projektId ? { projektId } : {}),
    },
  };
}

/** Nutzlast für `beobachten` an das Gerät: nur aktive Regeln, nur was der Beobachter braucht. */
export function geraetNutzlast(regeln: RegelLike[]): Array<Record<string, unknown>> {
  return regeln.filter(r => r.aktiv && r.quelle === 'ordner').map(r => ({ id: r.id, quelle: 'ordner', pfad: r.filter.pfad, ...(r.filter.muster ? { muster: r.filter.muster } : {}), ereignisse: r.filter.ereignisse ?? ['neu'], ...(r.filter.unterordner ? { unterordner: true } : {}) }));
}

const ART_TEXT: Record<string, string> = { neu: 'Neue Datei', geaendert: 'Datei geändert', geloescht: 'Datei gelöscht', sammel: 'Viele Änderungen' };
const groesse = (b: unknown) => { const n = Number(b); if (!Number.isFinite(n)) return ''; return n < 1024 ? `${n} B` : n < 1048576 ? `${(n / 1024).toFixed(0)} KB` : `${(n / 1048576).toFixed(1)} MB`; };

/** Ein Satz für Hinweis, Vorgangstitel und Bestätigung — nur Kopfdaten. */
export function trefferText(r: RegelLike, t: Treffer): string {
  const ordner = String(r.filter.pfad ?? '');
  if (t.art === 'sammel') return `${ART_TEXT.sammel} in ${ordner} auf ${r.geraet}: ${Number(t.kopf.anzahl ?? 0)} weitere (Regel „${r.name}")`;
  const g = groesse(t.kopf.groesse);
  return `${ART_TEXT[t.art] ?? t.art} auf ${r.geraet}: ${String(t.kopf.relativ ?? t.kopf.name ?? '')}${g ? ` (${g})` : ''} in ${ordner} — Regel „${r.name}"`;
}

/** Auslöser-Text für eine Aufgabe (geplante Aufgabe mit fester Werkzeugliste, wie Mail-Regeln v1211). */
export function aufgabeText(r: RegelLike, t: Treffer, skillName: string): string {
  const voll = `${String(r.filter.pfad ?? '').replace(/[\\/]+$/, '')}/${String(t.kopf.relativ ?? t.kopf.name ?? '')}`;
  return `Auslöser: ${trefferText(r, t)}.\nDie Datei liegt auf dem Gerät ${r.geraet} unter ${voll} — Zugriff über das Werkzeug ${skillName} (Aktion datei_holen holt sie zum Lesen auf den Server).`;
}

/** Standard-Werkzeuge einer Aufgabe: Gerät + Merken/Aufgaben/Erinnerungen. */
export function standardSkills(geraetSkill: string): string[] { return [geraetSkill, 'todo', 'reminder', 'memory', 'note']; }

/** Lebenszeichen: Befunde für gestörte Beobachter (Quelle „beobachter"), nur für aktive Regeln auf verbundenen Geräten. */
export function waechterBefunde(regeln: RegelLike[], geraete: Array<{ id: string; name: string; online: boolean; beobachter?: Array<{ regel: string; zustand: string; grund?: string }>; sinneZeit?: string }>, jetzt = Date.now()):
  Array<{ gegenstand: string; titel: string; detail?: string }> {
  const aus: Array<{ gegenstand: string; titel: string; detail?: string }> = [];
  for (const r of regeln.filter(x => x.aktiv)) {
    const g = geraete.find(x => x.id === r.geraetId);
    if (!g?.online) continue; // offline meldet die Geräte-Quelle
    const frisch = g.sinneZeit ? jetzt - Date.parse(g.sinneZeit) < 5 * 60_000 : false;
    if (!frisch) continue;
    const st = g.beobachter?.find(b => b.regel === r.id);
    if (!g.beobachter) aus.push({ gegenstand: `${r.geraetId}:${r.id}`, titel: `Beobachter „${r.name}" auf ${r.geraet}: Satellit kennt noch keine Beobachter (Update nötig)` });
    else if (!st) aus.push({ gegenstand: `${r.geraetId}:${r.id}`, titel: `Beobachter „${r.name}" auf ${r.geraet} läuft nicht` });
    else if (st.zustand === 'gestoert') aus.push({ gegenstand: `${r.geraetId}:${r.id}`, titel: `Beobachter „${r.name}" auf ${r.geraet} gestört: ${st.grund ?? 'unbekannt'}` });
  }
  return aus;
}
