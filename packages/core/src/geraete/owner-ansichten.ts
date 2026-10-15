/**
 * v1353 — native Ansichten der Desktop-App (Owner-Freigabe 11.10., A1/A3/A4): Aufgaben & Erinnerungen, Gedächtnis,
 * Vorgänge mit Entscheidung. Nur Geräte des Owners (prüft der Aufrufer über geraetGehoertOwner); hier zusätzlich je
 * Eintrag, dass er dem Owner gehört — die Web-Routen (API-Token) prüfen das bei Memories/Reminders nicht, das
 * Gerätetoken soll aber nie fremde Einträge ändern können.
 */

import { befundSchluesselAus, nieStummschaltbar, regelText, REGEL_VORSCHLAG_AB, STUMM_TAGE, STUMM_STANDARD_TAGE } from '../vorgaenge/regeln.js';

/** v1362 — Spec „Entscheiden statt Abhaken" (E1) */
export type ErgebnisArtZ = 'behoben' | 'entschieden' | 'kein_problem' | 'anders';
const ERGEBNIS_ARTEN_Z: readonly ErgebnisArtZ[] = ['behoben', 'entschieden', 'kein_problem', 'anders'];
export interface RegelLike { id: string; quelle: string; gegenstand: string; titel: string; wirkung: 'stumm' | 'immer_fragen'; bis?: string; begruendung?: string; herkunft: 'owner' | 'alfred'; status: string; erstellt: string }
export interface RegelZeile { id: string; text: string; wirkung: string; bis?: string; begruendung?: string; herkunft: string; status: string; abgelaufen: boolean; erstellt: string }
export interface RegelnDeps {
  liste(): Promise<RegelLike[]>;
  anlegen(e: { quelle: string; gegenstand: string; titel: string; wirkung: 'stumm' | 'immer_fragen'; bis?: string; begruendung?: string; herkunft: 'owner' | 'alfred'; vorgangId?: string }): Promise<RegelLike>;
  vorschlagen(e: { quelle: string; gegenstand: string; titel: string; wirkung: 'stumm' | 'immer_fragen'; bis?: string; begruendung?: string; herkunft: 'owner' | 'alfred'; vorgangId?: string }): Promise<RegelLike | null>;
  setzeStatus(id: string, status: 'aktiv' | 'abgelehnt' | 'widerrufen', bis?: string): Promise<RegelLike | null>;
  hole(id: string): Promise<RegelLike | null>;
}

export interface AufgabeZeile { id: string; titel: string; beschreibung?: string; prioritaet: string; faellig?: string; liste: string; erledigt: boolean }
export interface ErinnerungZeile { id: string; text: string; zeit: string }
export interface GedaechtnisZeile { id: string; schluessel: string; text: string; typ: string; quelle: string; geaendert: string }

/** Interne Buchführung, kein „Wissen über den Owner": zugestellte Insights (feedback) und KG-Verknüpfungen (connection). */
export const GEDAECHTNIS_INTERN = new Set(['feedback', 'connection']);
const PRIORITAETEN = new Set(['low', 'normal', 'high', 'urgent']);

interface TodoLike { id: string; userId: string; list: string; title: string; description?: string; priority: string; dueDate?: string; completed: boolean }
interface ReminderLike { id: string; userId: string; message: string; triggerAt: string; fired: boolean }
interface MemoryRow { id: string; user_id: string; key: string; value: string; type: string; source: string; updated_at: string }

export interface BefundLike { id: string; quelle: string; gegenstand: string; titel: string; detail?: string; entstanden: string; zuletztGesehen: string; erledigtAm?: string; gesehenAnzahl: number; vorgangId?: string }
export interface BefundZeile { id: string; quelle: string; regel?: string; titel: string; detail?: string; entstanden: string; zuletzt: string; erledigt?: string; anzahl: number; vorgang: boolean }

export interface OwnerAnsichtenDeps {
  owner: string;
  todos: {
    list(userId: string, list?: string, includeCompleted?: boolean): Promise<TodoLike[]>;
    add(userId: string, title: string, opts?: { list?: string; description?: string; priority?: string; dueDate?: string }): Promise<TodoLike>;
    getByIdForUser(id: string, userId: string): Promise<TodoLike | undefined>;
    update(id: string, userId: string, patch: { title?: string; priority?: any; dueDate?: string | null }): Promise<TodoLike | null>;
    complete(id: string): Promise<boolean>;
    uncomplete(id: string): Promise<boolean>;
  };
  erinnerungen: { getByUser(userId: string): Promise<ReminderLike[]>; getById(id: string): Promise<ReminderLike | undefined>; cancel(id: string): Promise<boolean> };
  db: { query(sql: string, params: unknown[]): Promise<unknown[]>; execute(sql: string, params: unknown[]): Promise<{ changes: number }> };
  vorgangEntscheiden(userId: string, id: string, status: 'erledigt' | 'verworfen', notiz?: string): Promise<{ titel: string } | null>;
  /** v1362 — Abschluss mit Ergebnis (Vorgang holen, abschließen, Zahl der „kein Problem" je Schlüssel) und Regeln */
  vorgangHolen?: (userId: string, id: string) => Promise<{ titel: string; dedupeKey?: string; status: string } | null>;
  vorgangAbschliessen?: (userId: string, id: string, e: { art: ErgebnisArtZ; ursache?: string; massnahme?: string; entscheidung?: string; text?: string }) => Promise<{ titel: string; ergebnis?: string } | null>;
  keinProblemAnzahl?: (userId: string, dedupeKey: string) => Promise<number>;
  regeln?: RegelnDeps;
  /** v1359 — Befunde (Schicht 3) des Owners: offene und kürzlich erledigte */
  befunde?: () => Promise<{ offen: BefundLike[]; erledigt: BefundLike[] }>;
  /** v1401 — Geräte-Projekte für die App-Ansicht „Projekte" (Liste, Detail mit Läufen, Stand vom Gerät, Weiterarbeiten) */
  /** v1429 R4a — Beobachter-Regeln (Liste mit Stand, Anlegen, An/Aus/Löschen) */
  beobachter?: { liste: () => Promise<unknown>; anlegen: (b: Record<string, unknown>) => Promise<{ success: boolean; display?: string; error?: string; data?: unknown }>; aendern: (id: string, b: Record<string, unknown>) => Promise<{ success: boolean; display?: string; error?: string; data?: unknown }> };
  projekte?: {
    liste: () => Promise<unknown[]>;
    detail: (id: string) => Promise<unknown | null>;
    stand: (id: string) => Promise<{ success: boolean; display?: string; error?: string }>;
    weiter: (id: string, text: string) => Promise<{ success: boolean; display?: string; error?: string }>;
    /** v1403 — offene Frage eines Laufs freigeben/ablehnen */
    entscheiden?: (id: string, lauf: string, entscheidung: string) => Promise<{ success: boolean; display?: string; error?: string }>;
    /** v1415 — angehaltenen Lauf fortsetzen */
    fortsetzen?: (id: string, lauf: string) => Promise<{ success: boolean; display?: string; error?: string }>;
    /** v1417 G1 — Änderungen eines Etappen-Commits */
    diff?: (id: string, commit: string, datei?: string) => Promise<{ success: boolean; display?: string; error?: string }>;
    /** v1404 — Frage zum Projekt (Claude Code nur lesend) */
    frage?: (id: string, text: string) => Promise<{ success: boolean; display?: string; error?: string }>;
    /** v1425 — Schalter „Protokoll im Projekt“ (Aufträge und Berichte mit committen) */
    protokoll?: (id: string, an: boolean) => Promise<{ success: boolean; display?: string; error?: string }>;
    /** v1455 — Schalter „Merge Requests“ (Etappen über Branch und MR) */
    mergeRequests?: (id: string, an: boolean) => Promise<{ success: boolean; display?: string; error?: string }>;
    /** v1457 — endgültig löschen: stellt nur die Owner-Bestätigung */
    loeschen?: (id: string) => Promise<{ success: boolean; display?: string; error?: string }>;
    /** v1458 — Schalter „automatisch zusammenführen“ */
    mrAuto?: (id: string, an: boolean) => Promise<{ success: boolean; display?: string; error?: string }>;
    /** v1426 — Konventionen ändern (Teil-Änderung, Felder siehe projekt/konventionen.ts) */
    konventionen?: (id: string, aenderung: unknown) => Promise<{ success: boolean; display?: string; error?: string }>;
    /** v1439 — Deploy: aktion ziel | ziel_entfernen | deploy | rollback (Ziel, Deploy und Rollback mit Bestätigung) */
    deploy?: (id: string, aktion: string, felder: Record<string, unknown>) => Promise<{ success: boolean; display?: string; error?: string }>;
    /** v1443 B15 — Umgebungen (ENV je Stufe): liste | setzen | loeschen | kopieren | erkennen; Werte nur maskiert */
    umgebung?: (id: string, aktion: string, felder: Record<string, unknown>) => Promise<{ success: boolean; display?: string; error?: string; data?: unknown }>;
  };
  jetzt?: () => Date;
  /** Jede Änderung aus der App ins Server-Log (Beweis, Schicht-4-Signal). */
  protokoll?: (was: string, daten: Record<string, unknown>) => void;
}

const aufgabe = (t: TodoLike): AufgabeZeile => ({ id: t.id, titel: t.title, beschreibung: t.description || undefined, prioritaet: t.priority, faellig: t.dueDate || undefined, liste: t.list, erledigt: !!t.completed });

/** Fälligkeit aus der App: ISO-Zeitpunkt oder leer (= entfernen). Alles andere ist ein Fehler. */
export function faelligkeit(v: unknown): string | null | undefined {
  if (v === undefined) return undefined;
  if (v === null || v === '') return null;
  if (typeof v !== 'string' || Number.isNaN(Date.parse(v))) throw new Error('faellig: ISO-Zeitpunkt oder leer');
  return new Date(v).toISOString();
}

export class OwnerAnsichten {
  constructor(private readonly d: OwnerAnsichtenDeps) {}

  /** Offene Aufgaben (fällige zuerst, dann nach Priorität) und kommende Erinnerungen. */
  async aufgaben(): Promise<{ aufgaben: AufgabeZeile[]; erinnerungen: ErinnerungZeile[] }> {
    const rang = (p: string) => ({ urgent: 0, high: 1, normal: 2, low: 3 } as Record<string, number>)[p] ?? 2;
    const offen = (await this.d.todos.list(this.d.owner, undefined, false)).map(aufgabe);
    offen.sort((a, b) => (a.faellig ? 0 : 1) - (b.faellig ? 0 : 1) || (a.faellig ?? '').localeCompare(b.faellig ?? '') || rang(a.prioritaet) - rang(b.prioritaet));
    const erinnerungen = (await this.d.erinnerungen.getByUser(this.d.owner)).filter(r => !r.fired).map(r => ({ id: r.id, text: r.message, zeit: r.triggerAt }));
    return { aufgaben: offen.slice(0, 300), erinnerungen: erinnerungen.slice(0, 200) };
  }

  async aufgabeNeu(e: { titel?: unknown; faellig?: unknown; prioritaet?: unknown; liste?: unknown }): Promise<AufgabeZeile> {
    const titel = typeof e.titel === 'string' ? e.titel.trim().slice(0, 300) : '';
    if (!titel) throw new Error('titel fehlt');
    const prioritaet = typeof e.prioritaet === 'string' && PRIORITAETEN.has(e.prioritaet) ? e.prioritaet : undefined;
    const liste = typeof e.liste === 'string' && e.liste.trim() ? e.liste.trim().slice(0, 60) : undefined;
    const t = await this.d.todos.add(this.d.owner, titel, { priority: prioritaet, dueDate: faelligkeit(e.faellig) ?? undefined, list: liste });
    this.d.protokoll?.('Aufgabe angelegt', { id: t.id, faellig: t.dueDate ?? null });
    return aufgabe(t);
  }

  /** erledigt an/aus, verschieben (faellig), umbenennen, Priorität. null = nicht gefunden oder nicht vom Owner. */
  async aufgabeAendern(id: string, e: { erledigt?: unknown; faellig?: unknown; titel?: unknown; prioritaet?: unknown }): Promise<AufgabeZeile | null> {
    const vorher = await this.d.todos.getByIdForUser(id, this.d.owner);
    if (!vorher) return null;
    const patch: { title?: string; priority?: string; dueDate?: string | null } = {};
    if (typeof e.titel === 'string' && e.titel.trim()) patch.title = e.titel.trim().slice(0, 300);
    if (typeof e.prioritaet === 'string' && PRIORITAETEN.has(e.prioritaet)) patch.priority = e.prioritaet;
    const f = faelligkeit(e.faellig);
    if (f !== undefined) patch.dueDate = f;
    if (Object.keys(patch).length) await this.d.todos.update(id, this.d.owner, patch);
    if (e.erledigt === true && !vorher.completed) await this.d.todos.complete(id);
    if (e.erledigt === false && vorher.completed) await this.d.todos.uncomplete(id);
    const nach = await this.d.todos.getByIdForUser(id, this.d.owner);
    this.d.protokoll?.('Aufgabe geändert', { id, felder: [...Object.keys(patch), ...(typeof e.erledigt === 'boolean' ? ['erledigt=' + e.erledigt] : [])] });
    return nach ? aufgabe(nach) : null;
  }

  async erinnerungLoeschen(id: string): Promise<boolean> {
    const r = await this.d.erinnerungen.getById(id);
    if (!r || r.userId !== this.d.owner || r.fired) return false;
    const ok = await this.d.erinnerungen.cancel(id);
    if (ok) this.d.protokoll?.('Erinnerung gelöscht', { id });
    return ok;
  }

  /** Was Alfred über den Owner weiß. Ohne typ: alles außer interner Buchführung. q: alle Wörter in Schlüssel oder Text. */
  async gedaechtnis(opts: { typ?: string; q?: string } = {}): Promise<{ eintraege: GedaechtnisZeile[]; typen: Record<string, number> }> {
    const rows = await this.d.db.query('SELECT id, user_id, key, value, type, source, updated_at FROM memories WHERE user_id = ? ORDER BY updated_at DESC', [this.d.owner]) as MemoryRow[];
    const typen: Record<string, number> = {};
    for (const r of rows) typen[r.type] = (typen[r.type] ?? 0) + 1;
    const woerter = (opts.q ?? '').toLowerCase().split(/\s+/).filter(Boolean);
    const eintraege = rows
      .filter(r => opts.typ ? r.type === opts.typ : !GEDAECHTNIS_INTERN.has(r.type))
      .filter(r => woerter.every(w => `${r.key} ${r.value}`.toLowerCase().includes(w)))
      .slice(0, 400)
      .map(r => ({ id: r.id, schluessel: r.key, text: r.value, typ: r.type, quelle: r.source, geaendert: String(r.updated_at) }));
    return { eintraege, typen };
  }

  /** Owner korrigiert einen Eintrag: Text ersetzen, Quelle „manual", volle Sicherheit. */
  async gedaechtnisAendern(id: string, text: unknown): Promise<boolean> {
    const t = typeof text === 'string' ? text.trim() : '';
    if (!t || t.length > 4000) throw new Error('text: 1–4000 Zeichen');
    const r = await this.d.db.execute("UPDATE memories SET value = ?, source = 'manual', confidence = 1, updated_at = ? WHERE id = ? AND user_id = ?", [t, (this.d.jetzt?.() ?? new Date()).toISOString(), id, this.d.owner]);
    if (r.changes > 0) this.d.protokoll?.('Gedächtnis korrigiert', { id, zeichen: t.length });
    return r.changes > 0;
  }

  async gedaechtnisLoeschen(id: string): Promise<boolean> {
    const r = await this.d.db.execute('DELETE FROM memories WHERE id = ? AND user_id = ?', [id, this.d.owner]);
    if (r.changes > 0) this.d.protokoll?.('Gedächtnis gelöscht', { id });
    return r.changes > 0;
  }

  /** v1359 — Befunde für die App: offen (älteste zuerst) und in den letzten 7 Tagen erledigt; Regel aus dem Schlüssel (Haus-Check „A1:…"). */
  /** v1429 R4a — Beobachter */
  async beobachter(): Promise<unknown> { return this.d.beobachter ? this.d.beobachter.liste() : { regeln: [], geraete: [], projekte: [] }; }
  async beobachterAnlegen(b: unknown): Promise<{ success: boolean; display?: string; error?: string; data?: unknown }> {
    if (!this.d.beobachter || !b || typeof b !== 'object') return { success: false, error: 'Beobachter nicht verfügbar' };
    this.d.protokoll?.('Beobachter angelegt', {});
    return this.d.beobachter.anlegen(b as Record<string, unknown>);
  }
  async beobachterAendern(id: string, b: unknown): Promise<{ success: boolean; display?: string; error?: string; data?: unknown }> {
    if (!this.d.beobachter || !b || typeof b !== 'object') return { success: false, error: 'Beobachter nicht verfügbar' };
    this.d.protokoll?.('Beobachter geändert', { id, aktion: (b as { aktion?: unknown }).aktion });
    return this.d.beobachter.aendern(id, b as Record<string, unknown>);
  }

  /** v1401 — Geräte-Projekte (nur Owner-Geräte; Weiterarbeiten plant und fragt den Owner wie im Gespräch) */
  async projekte(): Promise<{ projekte: unknown[] }> { return { projekte: this.d.projekte ? await this.d.projekte.liste() : [] }; }
  async projekt(id: string): Promise<unknown | null> { return this.d.projekte ? this.d.projekte.detail(id) : null; }
  async projektAktion(id: string, aktion: unknown, text: unknown, lauf?: unknown, extra?: { konventionen?: unknown; deploy?: unknown }): Promise<{ success: boolean; display?: string; error?: string }> {
    if (!this.d.projekte) return { success: false, error: 'Projekte nicht verfügbar' };
    // v1443 B15 — Umgebungen aus der App (nur bekannte Felder; Werte kommen nie unmaskiert zurück)
    if (typeof aktion === 'string' && /^env_(liste|setzen|loeschen|kopieren|erkennen)$/.test(aktion)) {
      if (!this.d.projekte.umgebung) return { success: false, error: 'Umgebungen nicht verfügbar' };
      const roh = (extra?.deploy && typeof extra.deploy === 'object' ? extra.deploy : {}) as Record<string, unknown>;
      const felder = Object.fromEntries(['stage', 'key', 'value', 'von', 'nach'].filter(k => typeof roh[k] === 'string').map(k => [k, roh[k]]));
      if (aktion !== 'env_liste') this.d.protokoll?.('Projekt Umgebung', { projekt: id, aktion, stage: felder.stage, key: felder.key });
      return this.d.projekte.umgebung(id, aktion.slice(4), felder);
    }
    // v1439 — Deploy aus der App; nur bekannte Felder, nie eine Bestätigungs-Kennung
    if (aktion === 'deploy_ziel' || aktion === 'deploy_ziel_entfernen' || aktion === 'deploy' || aktion === 'rollback' || aktion === 'hochstufen' || aktion === 'remote' || aktion === 'dev') { // v1460 dev
      if (!this.d.projekte.deploy) return { success: false, error: 'Deploy nicht verfügbar' };
      const roh = (extra?.deploy && typeof extra.deploy === 'object' ? extra.deploy : {}) as Record<string, unknown>;
      const felder = Object.fromEntries(['host', 'user', 'process_manager', 'runtime', 'app_port', 'branch', 'env_stage', 'stufe', 'auto_dev', 'name', 'von', 'nach', 'repo', 'anlegen', 'entfernen', 'dev_aktion', 'start', 'port', 'pruefung', 'kein_dienst', 'art', 'mit_claude', 'test_ordner', 'test_port', 'test_zweig', 'einrichten'].filter(k => roh[k] !== undefined && roh[k] !== '').map(k => [k, roh[k]]));
      this.d.protokoll?.('Projekt Deploy', { projekt: id, aktion });
      return this.d.projekte.deploy(id, aktion === 'deploy_ziel' ? 'ziel' : aktion === 'deploy_ziel_entfernen' ? 'ziel_entfernen' : aktion, felder);
    }
    if (aktion === 'stand') return this.d.projekte.stand(id);
    if (aktion === 'freigeben' || aktion === 'ablehnen') {
      if (!this.d.projekte.entscheiden || typeof lauf !== 'string' || !lauf) return { success: false, error: 'lauf fehlt' };
      this.d.protokoll?.('Projekt entschieden', { projekt: id, lauf, aktion });
      return this.d.projekte.entscheiden(id, lauf, aktion);
    }
    if (aktion === 'diff') { // v1417 G1 — nur lesend; commit kommt als „lauf", Datei als „text"
      if (!this.d.projekte.diff || typeof lauf !== 'string' || !lauf) return { success: false, error: 'commit fehlt' };
      return this.d.projekte.diff(id, lauf, typeof text === 'string' && text ? text : undefined);
    }
    if (aktion === 'fortsetzen') { // v1415
      if (!this.d.projekte.fortsetzen || typeof lauf !== 'string' || !lauf) return { success: false, error: 'lauf fehlt' };
      this.d.protokoll?.('Projekt fortsetzen', { projekt: id, lauf });
      return this.d.projekte.fortsetzen(id, lauf);
    }
    if (aktion === 'konventionen') { // v1426
      if (!this.d.projekte.konventionen || !extra?.konventionen || typeof extra.konventionen !== 'object') return { success: false, error: 'konventionen fehlt' };
      this.d.protokoll?.('Projekt Konventionen', { projekt: id });
      return this.d.projekte.konventionen(id, extra.konventionen);
    }
    if (aktion === 'protokoll') { // v1425 — text „an“ oder „aus“
      if (!this.d.projekte.protokoll || (text !== 'an' && text !== 'aus')) return { success: false, error: 'text muss an oder aus sein' };
      this.d.protokoll?.('Projekt Protokoll', { projekt: id, an: text === 'an' });
      return this.d.projekte.protokoll(id, text === 'an');
    }
    if (aktion === 'loeschen') { // v1457 — stellt nur die Bestätigung; gelöscht wird erst nach dem Ja
      if (!this.d.projekte.loeschen) return { success: false, error: 'nicht verfügbar' };
      this.d.protokoll?.('Projekt löschen angefragt', { projekt: id });
      return this.d.projekte.loeschen(id);
    }
    if (aktion === 'mr_auto') { // v1458 — text „an“ oder „aus“
      if (!this.d.projekte.mrAuto || (text !== 'an' && text !== 'aus')) return { success: false, error: 'text muss an oder aus sein' };
      this.d.protokoll?.('Projekt automatisch zusammenführen', { projekt: id, an: text === 'an' });
      return this.d.projekte.mrAuto(id, text === 'an');
    }
    if (aktion === 'merge_requests') { // v1455 — text „an“ oder „aus“
      if (!this.d.projekte.mergeRequests || (text !== 'an' && text !== 'aus')) return { success: false, error: 'text muss an oder aus sein' };
      this.d.protokoll?.('Projekt Merge Requests', { projekt: id, an: text === 'an' });
      return this.d.projekte.mergeRequests(id, text === 'an');
    }
    if (aktion === 'frage') {
      const f = typeof text === 'string' ? text.trim().slice(0, 4000) : '';
      if (!f || !this.d.projekte.frage) return { success: false, error: 'text fehlt (die Frage)' };
      this.d.protokoll?.('Projekt Frage', { projekt: id, laenge: f.length });
      return this.d.projekte.frage(id, f);
    }
    if (aktion !== 'weiter') return { success: false, error: 'aktion muss stand, weiter, frage, fortsetzen, diff, protokoll, merge_requests, mr_auto, loeschen, konventionen, freigeben oder ablehnen sein' };
    const t = typeof text === 'string' ? text.trim().slice(0, 4000) : '';
    if (!t) return { success: false, error: 'text fehlt (was soll als Nächstes passieren?)' };
    this.d.protokoll?.('Projekt weiter', { projekt: id, laenge: t.length });
    return this.d.projekte.weiter(id, t);
  }

  async befunde(): Promise<{ offen: BefundZeile[]; erledigt: BefundZeile[] }> {
    if (!this.d.befunde) return { offen: [], erledigt: [] };
    const b = await this.d.befunde();
    const zeile = (x: BefundLike): BefundZeile => ({
      id: x.id, quelle: x.quelle, regel: /^[A-Z]\d:/.test(x.gegenstand) ? x.gegenstand.slice(0, 2) : undefined, titel: x.titel, detail: x.detail,
      entstanden: x.entstanden, zuletzt: x.zuletztGesehen, erledigt: x.erledigtAm, anzahl: x.gesehenAnzahl, vorgang: !!x.vorgangId,
    });
    return { offen: b.offen.map(zeile), erledigt: b.erledigt.map(zeile) };
  }

  /**
   * v1362 — Abschluss mit Ergebnis („Was war es?") und, bei Befund-Vorgängen, „Und künftig?" (Regel). Prüft zuerst,
   * dann schließt es ab: eine Regel „nicht mehr melden" für Sicherheitsbefunde wird abgelehnt, bevor etwas passiert.
   * Ohne gewählte Regel und ab dem dritten „kein Problem" zum selben Befund legt Alfred einen Regelvorschlag an.
   */
  async vorgangAbschliessen(id: string, body: Record<string, unknown>): Promise<{ titel: string; ergebnis?: string; regel?: string; vorschlag?: string } | null> {
    if (!this.d.vorgangHolen || !this.d.vorgangAbschliessen) throw new Error('Abschluss nicht verfügbar');
    const e = (body.ergebnis ?? {}) as Record<string, unknown>;
    const art = e.art as ErgebnisArtZ;
    if (!ERGEBNIS_ARTEN_Z.includes(art)) throw new Error('ergebnis.art: behoben | entschieden | kein_problem | anders');
    const feld = (k: string) => (typeof e[k] === 'string' && (e[k] as string).trim() ? (e[k] as string).trim().slice(0, 500) : undefined);
    const k = (body.kuenftig ?? {}) as Record<string, unknown>;
    const kuenftig = (k.art ?? 'wie_heute') as string;
    if (!['wie_heute', 'stumm', 'immer_fragen'].includes(kuenftig)) throw new Error('kuenftig.art: wie_heute | stumm | immer_fragen');
    const tage = k.tage === undefined ? STUMM_STANDARD_TAGE : Number(k.tage);
    if (kuenftig === 'stumm' && !(STUMM_TAGE as readonly number[]).includes(tage)) throw new Error(`kuenftig.tage: ${STUMM_TAGE.join(' | ')}`);

    const v = await this.d.vorgangHolen(this.d.owner, id);
    if (!v) return null;
    const schluessel = befundSchluesselAus(v.dedupeKey);
    if (kuenftig !== 'wie_heute' && !schluessel) throw new Error('Regeln gibt es nur für Vorgänge aus einem Befund');
    if (kuenftig === 'stumm' && schluessel && nieStummschaltbar(schluessel)) throw new Error('Dieser Befund ist nicht stummschaltbar (Sicherheit bzw. Alfreds eigener Zustand)');
    if (kuenftig !== 'wie_heute' && !this.d.regeln) throw new Error('Regeln nicht verfügbar');

    const fertig = await this.d.vorgangAbschliessen(this.d.owner, id, { art, ursache: feld('ursache'), massnahme: feld('massnahme'), entscheidung: feld('entscheidung'), text: feld('text') });
    if (!fertig) return null;
    const jetzt = this.d.jetzt?.() ?? new Date();
    let regel: string | undefined; let vorschlag: string | undefined;
    if (schluessel && this.d.regeln && kuenftig !== 'wie_heute') {
      const rg = await this.d.regeln.anlegen({
        ...schluessel, titel: v.titel, wirkung: kuenftig as 'stumm' | 'immer_fragen', herkunft: 'owner', vorgangId: id,
        bis: kuenftig === 'stumm' ? new Date(jetzt.getTime() + tage * 86_400_000).toISOString() : undefined,
        begruendung: fertig.ergebnis,
      });
      regel = regelText(rg, jetzt);
      this.d.protokoll?.('Regel angelegt', { id: rg.id, regel, befund: `${schluessel.quelle}/${schluessel.gegenstand}` });
    } else if (schluessel && this.d.regeln && art === 'kein_problem' && this.d.keinProblemAnzahl && v.dedupeKey) {
      const n = await this.d.keinProblemAnzahl(this.d.owner, v.dedupeKey);
      if (n >= REGEL_VORSCHLAG_AB && !nieStummschaltbar(schluessel)) {
        const rg = await this.d.regeln.vorschlagen({
          ...schluessel, titel: v.titel, wirkung: 'stumm', herkunft: 'alfred', vorgangId: id,
          bis: new Date(jetzt.getTime() + STUMM_STANDARD_TAGE * 86_400_000).toISOString(),
          begruendung: `${n}× als „kein Problem" abgeschlossen`,
        });
        if (rg) { vorschlag = regelText(rg, jetzt); this.d.protokoll?.('Regel vorgeschlagen', { id: rg.id, vorschlag, anzahl: n }); }
      }
    }
    this.d.protokoll?.('Vorgang abgeschlossen', { id, art, kuenftig, titel: fertig.titel.slice(0, 80), ergebnis: fertig.ergebnis?.slice(0, 160) });
    return { titel: fertig.titel, ergebnis: fertig.ergebnis, regel, vorschlag };
  }

  /** v1362 — Regeln für die App: Vorschläge von Alfred und aktive Regeln (abgelaufene markiert). */
  async regeln(): Promise<{ vorschlaege: RegelZeile[]; aktiv: RegelZeile[] }> {
    if (!this.d.regeln) return { vorschlaege: [], aktiv: [] };
    const jetzt = this.d.jetzt?.() ?? new Date();
    const zeile = (x: RegelLike): RegelZeile => ({
      id: x.id, text: regelText(x, jetzt), wirkung: x.wirkung, bis: x.bis, begruendung: x.begruendung, herkunft: x.herkunft, status: x.status,
      abgelaufen: !!x.bis && Date.parse(x.bis) <= jetzt.getTime(), erstellt: x.erstellt,
    });
    const l = await this.d.regeln.liste();
    return { vorschlaege: l.filter(x => x.status === 'vorgeschlagen').map(zeile), aktiv: l.filter(x => x.status === 'aktiv').map(zeile) };
  }

  /** v1362 — Vorschlag übernehmen (Frist läuft ab jetzt) oder ablehnen; aktive Regel widerrufen. */
  async regelAendern(id: string, aktion: unknown): Promise<{ text: string } | null> {
    if (!this.d.regeln) throw new Error('Regeln nicht verfügbar');
    const r = await this.d.regeln.hole(id);
    if (!r) return null;
    const jetzt = this.d.jetzt?.() ?? new Date();
    let neu: RegelLike | null;
    if (aktion === 'uebernehmen' && r.status === 'vorgeschlagen') {
      const bis = r.wirkung === 'stumm' ? new Date(jetzt.getTime() + STUMM_STANDARD_TAGE * 86_400_000).toISOString() : undefined;
      neu = await this.d.regeln.setzeStatus(id, 'aktiv', bis);
    } else if (aktion === 'ablehnen' && r.status === 'vorgeschlagen') {
      neu = await this.d.regeln.setzeStatus(id, 'abgelehnt');
    } else if (aktion === 'widerrufen' && r.status === 'aktiv') {
      neu = await this.d.regeln.setzeStatus(id, 'widerrufen');
    } else throw new Error('aktion: uebernehmen | ablehnen (Vorschlag) · widerrufen (aktive Regel)');
    if (!neu) return null;
    const text = regelText(neu, jetzt);
    this.d.protokoll?.(`Regel ${aktion}`, { id, text });
    return { text };
  }

  async vorgangEntscheiden(id: string, status: unknown, notiz: unknown): Promise<{ titel: string } | null> {
    if (status !== 'erledigt' && status !== 'verworfen') throw new Error('status: erledigt | verworfen');
    const n = typeof notiz === 'string' && notiz.trim() ? notiz.trim().slice(0, 500) : undefined;
    const v = await this.d.vorgangEntscheiden(this.d.owner, id, status, n);
    if (v) this.d.protokoll?.('Vorgang entschieden', { id, status, titel: v.titel.slice(0, 80) });
    return v;
  }
}
