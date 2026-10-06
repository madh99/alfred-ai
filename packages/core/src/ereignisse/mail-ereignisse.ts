/**
 * v1211 — Jarvis Schicht 2: Mail-Ereignisquelle.
 *
 * Realfall: Der aWATTar-Rechnungscheck lief viermal täglich als Chat-Aufgabe mit allen
 * 81 Werkzeugen (67.000 bis 103.000 Tokens je Aufruf), weil es keine Ereignisquelle für
 * den Posteingang gab. Sechs E-Mail-Watches hatten nie ausgelöst (Gmail-Operatoren in
 * einem Microsoft-Postfach). Jetzt: eine geplante Aufgabe vom Typ `mail` beschreibt
 * deterministisch, welche Post sie auslöst (Konto, Absender, Betreff). Der Job
 * `mail-ereignisse` prüft alle 10 Minuten den Posteingang; eine neue passende Nachricht
 * startet die Aufgabe genau einmal, mit dem Verweis auf diese Nachricht und nur den
 * Werkzeugen, die die Aufgabe braucht.
 */

export interface MailRegel {
  /** E-Mail-Konto (Name wie in der Skill-Konfiguration, z. B. "outlook"). Fehlt es, gilt das Standardkonto. */
  account?: string;
  /** Teilstring im Absender (Groß-/Kleinschreibung egal). */
  from?: string;
  /** Teilstring im Betreff (Groß-/Kleinschreibung egal). */
  subject?: string;
  /** Werkzeuge, die der Aufgabe beim Auslösen zur Verfügung stehen. */
  skills?: string[];
}

export const MAIL_STANDARD_SKILLS = ['email', 'memory', 'calculator'];
export const GESEHEN_MAX = 200;

/** Schedule-Wert einer `mail`-Aufgabe: JSON mit account/from/subject/skills. Mindestens from oder subject. */
export function parseMailRegel(scheduleValue: string): MailRegel | null {
  let roh: unknown;
  try { roh = JSON.parse(scheduleValue); } catch { return null; }
  if (!roh || typeof roh !== 'object' || Array.isArray(roh)) return null;
  const r = roh as Record<string, unknown>;
  const text = (v: unknown) => (typeof v === 'string' && v.trim() ? v.trim() : undefined);
  const regel: MailRegel = { account: text(r.account), from: text(r.from), subject: text(r.subject) };
  if (!regel.from && !regel.subject) return null;
  if (Array.isArray(r.skills)) {
    const skills = r.skills.filter((s): s is string => typeof s === 'string' && s.trim().length > 0).map(s => s.trim());
    if (skills.length > 0) regel.skills = skills;
  }
  return regel;
}

export interface MailKurz { id: string; from: string; subject: string; date: string | Date; }

/** Passt eine Nachricht zur Regel? Absender und Betreff als Teilstring, ohne Groß-/Kleinschreibung. */
export function passtZuRegel(m: MailKurz, regel: MailRegel): boolean {
  if (regel.from && !m.from.toLowerCase().includes(regel.from.toLowerCase())) return false;
  if (regel.subject && !m.subject.toLowerCase().includes(regel.subject.toLowerCase())) return false;
  return true;
}

/** Neue, noch nicht gesehene Nachrichten — älteste zuerst, damit die Reihenfolge der Auslösung stimmt. */
export function neueMails(mails: MailKurz[], regel: MailRegel, gesehen: ReadonlySet<string>): MailKurz[] {
  return mails
    .filter(m => !gesehen.has(m.id) && passtZuRegel(m, regel))
    .sort((a, b) => new Date(a.date).getTime() - new Date(b.date).getTime());
}

/** Gesehen-Liste begrenzen: die jüngsten GESEHEN_MAX Einträge bleiben. */
export function begrenzeGesehen(ids: string[], max = GESEHEN_MAX): string[] {
  return ids.length <= max ? ids : ids.slice(ids.length - max);
}

/** Auslöser-Text, der der Aufgabe mitgegeben wird. */
export function ausloeserText(m: MailKurz, account: string | undefined): string {
  const konto = account ? ` im Konto "${account}"` : '';
  const datum = new Date(m.date).toISOString();
  const kontoParam = account ? ` und account="${account}"` : '';
  return `Auslöser: neue E-Mail${konto} — Betreff "${m.subject}", Absender ${m.from}, eingegangen ${datum}, messageId ${m.id}. `
    + `Verarbeite GENAU diese Nachricht (action="read" bzw. action="attachment" mit dieser messageId${kontoParam}); nicht erneut suchen.`;
}
