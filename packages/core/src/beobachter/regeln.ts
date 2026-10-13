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
export function regelPruefen(roh: Record<string, unknown>, geraete: Array<{ id: string; name: string }>, projekte: Array<{ id: string; name: string; geraetId?: string; pfad?: string; pruefBefehle?: string[] }> = []):
  { ok: true; regel: Omit<RegelLike, 'id' | 'treffer' | 'letzterTreffer'> } | { ok: false; fehler: string } {
  // v1431 — Build-Wache: das Gerät ergibt sich aus dem Projekt
  const projektVon = (pn: string) => { const t = pn ? projekte.filter(x => x.name.toLowerCase().includes(pn)) : []; return projekte.find(x => x.id === pn || x.name.toLowerCase() === pn || (pn.length >= 8 && x.id.startsWith(pn))) ?? (t.length === 1 ? t[0] : undefined); };
  const buildProjekt = String(roh.quelle ?? '') === 'build' ? projektVon(String(roh.projekt ?? roh.projektId ?? '').trim().toLowerCase()) : undefined;
  const gName = String(roh.geraet ?? roh.geraetId ?? buildProjekt?.geraetId ?? '').trim().toLowerCase();
  const g = geraete.find(x => x.id === gName || x.name.toLowerCase() === gName) ?? (geraete.length === 1 && !gName ? geraete[0] : undefined);
  if (!g) return { ok: false, fehler: `Gerät fehlt oder unbekannt (${geraete.map(x => x.name).join(', ') || 'keine Geräte'})` };
  const quelle = String(roh.quelle ?? 'ordner') as Quelle;
  if (!['ordner', 'benachrichtigung', 'outlook', 'build'].includes(quelle)) return { ok: false, fehler: `Quelle „${quelle}" gibt es nicht (ordner, benachrichtigung, outlook, build)` };
  const f = (roh.filter && typeof roh.filter === 'object' ? roh.filter : roh) as Record<string, unknown>;
  // v1430 R4b — Benachrichtigungen (Apps, optional Titel) und Outlook (Absender/Betreff)
  const text = (v: unknown, max = 120) => (typeof v === 'string' && v.trim() ? v.trim().slice(0, max) : undefined);
  let filter: Record<string, unknown>;
  let pfad = '';
  if (quelle === 'benachrichtigung') {
    const apps = (Array.isArray(f.apps) ? f.apps : typeof f.apps === 'string' ? f.apps.split(/[,;]/) : typeof f.app === 'string' ? [f.app] : []).map(x => String(x).trim()).filter(Boolean).slice(0, 10);
    if (!apps.length) return { ok: false, fehler: 'apps fehlt (welche Apps, z. B. WhatsApp, Teams) — ohne App-Liste verlässt keine Benachrichtigung das Gerät' };
    filter = { apps, ...(text(f.titel) ? { titel: text(f.titel) } : {}) };
  } else if (quelle === 'build') {
    if (!buildProjekt) return { ok: false, fehler: `projekt fehlt oder unbekannt (Build-Wache gilt für ein Geräte-Projekt: ${projekte.map(x => x.name).join(', ') || 'keine Projekte'})` };
    if (!buildProjekt.pruefBefehle?.length) return { ok: false, fehler: `${buildProjekt.name} hat keine Prüfbefehle — die Build-Wache führt nur die freigegebenen Prüfbefehle des Projekts aus` };
    const iv = Number(f.intervallMin ?? f.intervall ?? 60);
    filter = { projektId: buildProjekt.id, pfad: buildProjekt.pfad, befehle: buildProjekt.pruefBefehle, intervallMin: Number.isFinite(iv) ? Math.max(15, Math.min(1440, Math.round(iv))) : 60 };
  } else if (quelle === 'outlook') {
    filter = { ...(text(f.absender) ? { absender: text(f.absender) } : {}), ...(text(f.betreff) ? { betreff: text(f.betreff) } : {}) };
  } else {
    pfad = String(f.pfad ?? f.ordner ?? '').trim();
    if (!pfad || !/^([a-zA-Z]:[\\/]|\/|~)/.test(pfad)) return { ok: false, fehler: 'pfad fehlt (absoluter Ordner auf dem Gerät, z. B. C:\\Users\\madh\\Downloads oder /home/madh/Downloads)' };
    filter = {};
  }
  const ereignisse = (Array.isArray(f.ereignisse) ? f.ereignisse : typeof f.ereignisse === 'string' ? f.ereignisse.split(/[,\s]+/) : ['neu'])
    .map(x => String(x).trim().toLowerCase().replace('geändert', 'geaendert').replace('gelöscht', 'geloescht'))
    .filter((x): x is typeof ORDNER_ARTEN[number] => (ORDNER_ARTEN as readonly string[]).includes(x));
  const wirkung = String(roh.wirkung ?? 'hinweis') as Wirkung;
  if (!WIRKUNGEN.includes(wirkung)) return { ok: false, fehler: `wirkung muss ${WIRKUNGEN.join(', ')} sein` };
  const auftrag = typeof roh.auftrag === 'string' && roh.auftrag.trim() ? roh.auftrag.trim().slice(0, 2000) : undefined;
  if ((wirkung === 'aufgabe' || wirkung === 'projekt') && !auftrag) return { ok: false, fehler: `Für „${wirkung}" fehlt der Auftrag (was Alfred tun soll)` };
  let projektId: string | undefined;
  if (wirkung === 'projekt' && buildProjekt) projektId = buildProjekt.id; // Build-Wache: Fix-Lauf im selben Projekt
  else if (wirkung === 'projekt') {
    const pn = String(roh.projekt ?? roh.projektId ?? '').trim().toLowerCase();
    const teil = pn ? projekte.filter(x => x.name.toLowerCase().includes(pn)) : [];
    const p = projekte.find(x => x.id === pn || x.name.toLowerCase() === pn || (pn.length >= 8 && x.id.startsWith(pn))) ?? (teil.length === 1 ? teil[0] : undefined); // eindeutiger Teilname
    if (!p) return { ok: false, fehler: `Projekt fehlt oder unbekannt (${projekte.map(x => x.name).join(', ') || 'keine Projekte'})` };
    projektId = p.id;
  }
  const muster = typeof f.muster === 'string' && f.muster.trim() ? f.muster.trim().slice(0, 200) : undefined;
  const name = String(roh.name ?? '').trim().slice(0, 80) || (quelle === 'build' ? `Build-Wache ${buildProjekt?.name ?? ''}` : quelle === 'benachrichtigung' ? `Benachrichtigungen ${(filter.apps as string[]).join(', ')}` : quelle === 'outlook' ? `Outlook${filter.absender ? ` von ${String(filter.absender)}` : ''}${filter.betreff ? ` „${String(filter.betreff)}"` : ''}` : `${muster ?? 'Dateien'} in ${pfad.split(/[\\/]/).filter(Boolean).pop() ?? pfad}`);
  const skills = Array.isArray(roh.skills) ? roh.skills.map(String).slice(0, 12) : undefined;
  return {
    ok: true,
    regel: {
      geraetId: g.id, geraet: g.name, name, quelle, wirkung, aktiv: roh.aktiv !== false,
      filter: quelle === 'ordner' ? { pfad, ...(muster ? { muster } : {}), ereignisse: ereignisse.length ? ereignisse : ['neu'], ...(f.unterordner === true ? { unterordner: true } : {}) } : filter,
      ...(auftrag ? { auftrag } : {}), ...(skills?.length ? { skills } : {}), ...(projektId ? { projektId } : {}),
    },
  };
}

/** Nutzlast für `beobachten` an das Gerät: nur aktive Regeln, nur was der Beobachter braucht. */
export function geraetNutzlast(regeln: RegelLike[]): Array<Record<string, unknown>> {
  return regeln.filter(r => r.aktiv).map(r => r.quelle === 'ordner'
    ? { id: r.id, quelle: 'ordner', pfad: r.filter.pfad, ...(r.filter.muster ? { muster: r.filter.muster } : {}), ereignisse: r.filter.ereignisse ?? ['neu'], ...(r.filter.unterordner ? { unterordner: true } : {}) }
    : { id: r.id, quelle: r.quelle, ...r.filter }); // v1430 benachrichtigung/outlook
}

const ART_TEXT: Record<string, string> = { neu: 'Neue Datei', geaendert: 'Datei geändert', geloescht: 'Datei gelöscht', sammel: 'Viele Änderungen' };
const groesse = (b: unknown) => { const n = Number(b); if (!Number.isFinite(n)) return ''; return n < 1024 ? `${n} B` : n < 1048576 ? `${(n / 1024).toFixed(0)} KB` : `${(n / 1048576).toFixed(1)} MB`; };

/** Ein Satz für Hinweis, Vorgangstitel und Bestätigung — nur Kopfdaten. */
export function trefferText(r: RegelLike, t: Treffer): string {
  if (r.quelle === 'benachrichtigung') return `Benachrichtigung auf ${r.geraet}: ${String(t.kopf.app ?? '')}${t.kopf.titel ? ` — ${String(t.kopf.titel)}` : ''} (Regel „${r.name}")`;
  if (r.quelle === 'build') return t.art === 'gruen' ? `Build-Wache „${r.name}" auf ${r.geraet}: Prüfbefehle wieder grün` : `Build-Wache „${r.name}" auf ${r.geraet}: Prüfbefehle rot (${((t.kopf.befehle as string[] | undefined) ?? []).join(' ; ')})${t.kopf.auszug ? `\n${String(t.kopf.auszug).slice(-300)}` : ''}`;
  if (r.quelle === 'outlook') return `Neue Mail in Outlook auf ${r.geraet}: ${String(t.kopf.von ?? '')} — „${String(t.kopf.betreff ?? '')}"${Number(t.kopf.anhaenge ?? 0) > 0 ? ` (${Number(t.kopf.anhaenge)} Anhang/Anhänge)` : ''} (Regel „${r.name}")`;
  const ordner = String(r.filter.pfad ?? '');
  if (t.art === 'sammel') return `${ART_TEXT.sammel} in ${ordner} auf ${r.geraet}: ${Number(t.kopf.anzahl ?? 0)} weitere (Regel „${r.name}")`;
  const g = groesse(t.kopf.groesse);
  return `${ART_TEXT[t.art] ?? t.art} auf ${r.geraet}: ${String(t.kopf.relativ ?? t.kopf.name ?? '')}${g ? ` (${g})` : ''} in ${ordner} — Regel „${r.name}"`;
}

/** Auslöser-Text für eine Aufgabe (geplante Aufgabe mit fester Werkzeugliste, wie Mail-Regeln v1211). */
export function aufgabeText(r: RegelLike, t: Treffer, skillName: string): string {
  if (r.quelle === 'outlook') return `Auslöser: ${trefferText(r, t)}.\nDie Mail liegt in Outlook auf dem Gerät ${r.geraet} — ganze Mail lesen: Werkzeug ${skillName}, Aktion outlook_mails mit id=${String(t.kopf.id ?? '')}.`;
  if (r.quelle === 'benachrichtigung') return `Auslöser: ${trefferText(r, t)}.`;
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
