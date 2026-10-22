/**
 * Spec Infrastruktur-Vorhaben, I4b Teil 1 (Owner 22.10.2026, 5b-7/5b-12) — Wartungsfenster, Sperrzeiten, Benachrichtigungsregeln.
 * Reine Zeitlogik ohne I/O: Gilt ein Eintrag für einen Change, liegt ein Zeitpunkt in einem Fenster/einer Sperre, wann darf ein
 * Change frühestens starten, welche Benachrichtigungen sind fällig. Zeiten der Regeln in Europe/Vienna.
 */

export type KalenderArt = 'fenster' | 'sperre';
export interface Geltung { global?: boolean; assetIds?: string[]; serviceIds?: string[] }
export type KalenderRegel =
  | { art: 'einmalig'; von: string; bis: string }                                   // ISO-Zeitpunkte
  | { art: 'woechentlich'; tage: number[]; von: string; bis: string };             // 0=So … 6=Sa, „HH:MM“ (bis < von → über Mitternacht)
export interface KalenderEintrag { id: string; art: KalenderArt; name: string; geltung: Geltung; regel: KalenderRegel; aktiv: boolean; notiz?: string }

export type Zeitpunkt = '24h_vorher' | '1h_vorher' | 'start' | 'ende' | 'stoerung';
export type Kanal = 'push' | 'telegram' | 'email' | 'homeassistant';
export interface Empfaenger { art: 'owner' | 'nutzer' | 'kontakt'; userId?: string; name?: string; email?: string; haDienst?: string; /** beim Anlegen aus dem Alfred-Benutzer aufgelöst */ telegramId?: string }
export interface BenachrichtigungsRegel { id: string; name: string; geltung: Geltung; empfaenger: Empfaenger[]; kanaele: Kanal[]; zeitpunkte: Zeitpunkt[]; aktiv: boolean }

export const ZEITPUNKTE: readonly Zeitpunkt[] = ['24h_vorher', '1h_vorher', 'start', 'ende', 'stoerung'];
export const KANAELE: readonly Kanal[] = ['push', 'telegram', 'email', 'homeassistant'];
const ZONE = 'Europe/Vienna';
const MIN = 60_000;

/** Wochentag (0=So) und Minute des Tages in Wien. */
export function wienZeit(t: number): { tag: number; minute: number; datum: string } {
  const f = new Intl.DateTimeFormat('en-GB', { timeZone: ZONE, weekday: 'short', hour: '2-digit', minute: '2-digit', year: 'numeric', month: '2-digit', day: '2-digit', hourCycle: 'h23' });
  const teile = Object.fromEntries(f.formatToParts(new Date(t)).map(p => [p.type, p.value]));
  const tag = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'].indexOf(teile.weekday!);
  return { tag, minute: Number(teile.hour) * 60 + Number(teile.minute), datum: `${teile.year}-${teile.month}-${teile.day}` };
}
const hhmm = (s: string): number | undefined => { const m = /^([01]\d|2[0-3]):([0-5]\d)$/.exec(s.trim()); return m ? Number(m[1]) * 60 + Number(m[2]) : undefined; };

/** Prüft eine Regel auf Gültigkeit; liefert Fehlertext oder undefined. */
export function regelFehler(r: unknown): string | undefined {
  const x = (r ?? {}) as Record<string, unknown>;
  if (x.art === 'einmalig') {
    const von = Date.parse(String(x.von ?? '')), bis = Date.parse(String(x.bis ?? ''));
    if (Number.isNaN(von) || Number.isNaN(bis)) return 'einmalig braucht von und bis als Zeitpunkt (ISO)';
    if (bis <= von) return 'bis muss nach von liegen';
    if (bis - von > 31 * 24 * 60 * MIN) return 'einmalig höchstens 31 Tage';
    return undefined;
  }
  if (x.art === 'woechentlich') {
    const tage = Array.isArray(x.tage) ? x.tage : [];
    if (!tage.length || tage.some(t => !Number.isInteger(t) || (t as number) < 0 || (t as number) > 6)) return 'tage: Liste von 0 (So) bis 6 (Sa)';
    if (hhmm(String(x.von ?? '')) === undefined || hhmm(String(x.bis ?? '')) === undefined) return 'von/bis als HH:MM';
    if (x.von === x.bis) return 'von und bis dürfen nicht gleich sein';
    return undefined;
  }
  return 'art muss einmalig oder woechentlich sein';
}

/** Liegt t in der Regel? Wöchentlich über Mitternacht zählt zum Starttag. */
export function inRegel(r: KalenderRegel, t: number): boolean {
  if (r.art === 'einmalig') return t >= Date.parse(r.von) && t < Date.parse(r.bis);
  const { tag, minute } = wienZeit(t);
  const von = hhmm(r.von)!, bis = hhmm(r.bis)!;
  if (von < bis) return r.tage.includes(tag) && minute >= von && minute < bis;
  // über Mitternacht: Starttag ab „von“ oder Folgetag bis „bis“
  return (r.tage.includes(tag) && minute >= von) || (r.tage.includes((tag + 6) % 7) && minute < bis);
}

/** Ende des Abschnitts, in dem t liegt (Minutenraster, höchstens 8 Tage voraus). */
export function abschnittsEnde(r: KalenderRegel, t: number): number {
  if (r.art === 'einmalig') return Date.parse(r.bis);
  let x = Math.floor(t / MIN) * MIN;
  const grenze = t + 8 * 24 * 60 * MIN;
  while (x < grenze && inRegel(r, x)) x += MIN;
  return x;
}

/** Gilt der Eintrag für einen Change (global oder Überschneidung bei Assets/Services)? */
export function giltFuer(g: Geltung, assetIds: string[], serviceIds: string[] = []): boolean {
  if (g.global) return true;
  return (g.assetIds ?? []).some(a => assetIds.includes(a)) || (g.serviceIds ?? []).some(s => serviceIds.includes(s));
}

export interface StartPruefung { erlaubt: boolean; grund: string; naechsterStart?: number }

/**
 * Darf ein Change zum Zeitpunkt t starten?
 * - Sperrzeiten blockieren (außer Notfall-Changes).
 * - Gibt es für den Change geltende Wartungsfenster, muss t in einem liegen und bis zu dessen Ende genug Zeit sein
 *   (erwartete Ausfallzeit, mindestens 15 min). Ohne geltende Fenster: jederzeit (Owner pflegt Fenster nach Bedarf).
 * - Notfall-Changes ignorieren Fenster und Sperren.
 */
export function startPruefen(c: { notfall: boolean; assetIds: string[]; serviceIds?: string[]; ausfallMinuten?: number }, eintraege: KalenderEintrag[], t: number): StartPruefung {
  if (c.notfall) return { erlaubt: true, grund: 'Notfall-Change' };
  const geltend = eintraege.filter(e => e.aktiv && giltFuer(e.geltung, c.assetIds, c.serviceIds));
  const sperre = geltend.find(e => e.art === 'sperre' && inRegel(e.regel, t));
  const fenster = geltend.filter(e => e.art === 'fenster');
  const bedarf = Math.max(15, c.ausfallMinuten ?? 0) * MIN;
  if (!sperre && !fenster.length) return { erlaubt: true, grund: 'kein Wartungsfenster festgelegt' };
  if (!sperre) {
    const offen = fenster.find(e => inRegel(e.regel, t) && abschnittsEnde(e.regel, t) - t >= bedarf);
    if (offen) return { erlaubt: true, grund: `im Wartungsfenster „${offen.name}“` };
  }
  return { erlaubt: false, grund: sperre ? `Sperrzeit „${sperre.name}“` : 'außerhalb der Wartungsfenster', ...(naechsterStartZeit(c, geltend, t, bedarf) !== undefined ? { naechsterStart: naechsterStartZeit(c, geltend, t, bedarf)! } : {}) };
}

/** Frühester Zeitpunkt (Viertelstunden-Raster, höchstens 35 Tage voraus), an dem der Change starten dürfte. */
function naechsterStartZeit(_c: unknown, geltend: KalenderEintrag[], t: number, bedarf: number): number | undefined {
  const fenster = geltend.filter(e => e.art === 'fenster');
  const sperren = geltend.filter(e => e.art === 'sperre');
  const schritt = 15 * MIN;
  for (let x = Math.ceil(t / schritt) * schritt; x < t + 35 * 24 * 60 * MIN; x += schritt) {
    if (sperren.some(s => inRegel(s.regel, x))) continue;
    if (!fenster.length) return x;
    if (fenster.some(f => inRegel(f.regel, x) && abschnittsEnde(f.regel, x) - x >= bedarf)) return x;
  }
  return undefined;
}

/** Fällige Benachrichtigungen für einen Change (bereits gesendete Schlüssel werden übersprungen). */
export function faelligeBenachrichtigungen(c: { id: string; assetIds: string[]; serviceIds?: string[]; startGeplant?: number }, regeln: BenachrichtigungsRegel[], t: number, gesendet: Set<string>): Array<{ regel: BenachrichtigungsRegel; zeitpunkt: Zeitpunkt; schluessel: string }> {
  const aus: Array<{ regel: BenachrichtigungsRegel; zeitpunkt: Zeitpunkt; schluessel: string }> = [];
  if (c.startGeplant === undefined) return aus;
  for (const r of regeln.filter(x => x.aktiv && giltFuer(x.geltung, c.assetIds, c.serviceIds))) {
    for (const z of r.zeitpunkte) {
      const vorlauf = z === '24h_vorher' ? 24 * 60 * MIN : z === '1h_vorher' ? 60 * MIN : undefined;
      if (vorlauf === undefined) continue;
      const k = `${r.id}:${z}:${c.startGeplant}`;
      // fällig im Zeitraum [Start − Vorlauf, Start); verspätet nachgeholt, aber nie nach dem Start
      if (!gesendet.has(k) && t >= c.startGeplant - vorlauf && t < c.startGeplant) aus.push({ regel: r, zeitpunkt: z, schluessel: k });
    }
  }
  return aus;
}

/** Regeln, die bei einem Ereignis (Start, Ende, Störung) greifen. */
export function regelnFuerEreignis(c: { assetIds: string[]; serviceIds?: string[] }, regeln: BenachrichtigungsRegel[], z: 'start' | 'ende' | 'stoerung'): BenachrichtigungsRegel[] {
  return regeln.filter(r => r.aktiv && r.zeitpunkte.includes(z) && giltFuer(r.geltung, c.assetIds, c.serviceIds));
}

export function regelText(r: KalenderRegel): string {
  if (r.art === 'einmalig') return `${new Date(r.von).toLocaleString('de-AT', { timeZone: ZONE, dateStyle: 'short', timeStyle: 'short' })} – ${new Date(r.bis).toLocaleString('de-AT', { timeZone: ZONE, dateStyle: 'short', timeStyle: 'short' })}`;
  const namen = ['So', 'Mo', 'Di', 'Mi', 'Do', 'Fr', 'Sa'];
  return `${[...r.tage].sort().map(t => namen[t]).join(', ')} ${r.von}–${r.bis}${hhmm(r.bis)! < hhmm(r.von)! ? ' (über Mitternacht)' : ''}`;
}
