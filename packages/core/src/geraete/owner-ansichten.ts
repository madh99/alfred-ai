/**
 * v1353 — native Ansichten der Desktop-App (Owner-Freigabe 11.10., A1/A3/A4): Aufgaben & Erinnerungen, Gedächtnis,
 * Vorgänge mit Entscheidung. Nur Geräte des Owners (prüft der Aufrufer über geraetGehoertOwner); hier zusätzlich je
 * Eintrag, dass er dem Owner gehört — die Web-Routen (API-Token) prüfen das bei Memories/Reminders nicht, das
 * Gerätetoken soll aber nie fremde Einträge ändern können.
 */

export interface AufgabeZeile { id: string; titel: string; beschreibung?: string; prioritaet: string; faellig?: string; liste: string; erledigt: boolean }
export interface ErinnerungZeile { id: string; text: string; zeit: string }
export interface GedaechtnisZeile { id: string; schluessel: string; text: string; typ: string; quelle: string; geaendert: string }

/** Interne Buchführung, kein „Wissen über den Owner": zugestellte Insights (feedback) und KG-Verknüpfungen (connection). */
export const GEDAECHTNIS_INTERN = new Set(['feedback', 'connection']);
const PRIORITAETEN = new Set(['low', 'normal', 'high', 'urgent']);

interface TodoLike { id: string; userId: string; list: string; title: string; description?: string; priority: string; dueDate?: string; completed: boolean }
interface ReminderLike { id: string; userId: string; message: string; triggerAt: string; fired: boolean }
interface MemoryRow { id: string; user_id: string; key: string; value: string; type: string; source: string; updated_at: string }

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

  async vorgangEntscheiden(id: string, status: unknown, notiz: unknown): Promise<{ titel: string } | null> {
    if (status !== 'erledigt' && status !== 'verworfen') throw new Error('status: erledigt | verworfen');
    const n = typeof notiz === 'string' && notiz.trim() ? notiz.trim().slice(0, 500) : undefined;
    const v = await this.d.vorgangEntscheiden(this.d.owner, id, status, n);
    if (v) this.d.protokoll?.('Vorgang entschieden', { id, status, titel: v.titel.slice(0, 80) });
    return v;
  }
}
