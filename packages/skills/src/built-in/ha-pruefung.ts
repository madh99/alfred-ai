/**
 * v1359 — Haus-Check: Home Assistant nach festen Regeln prüfen (Spec „Home-Assistant-Prüfung nach Best Practice", H1/H2).
 *
 * Owner 12.10.: Alfred soll die Umgebung als Ganzes prüfen (Automationen sinnvoll? was fehlt?). Erster Schritt
 * beobachtend: nur Befunde mit festem Schlüssel, keine Vorgänge, keine Änderungen an Home Assistant. Gesammelt wird
 * ohne Modell; jede Regel nennt ihre Grenze und einen Hinweis. Reine Funktionen — das Laden steckt im Skill.
 *
 * Regeln (Owner-Entscheidung 12.10.):
 *  A1 Automation verweist auf fehlende Entität/Gerät
 *  A2 aktiv, aber seit über 30 Tagen nicht ausgelöst (Alarm, Rauch, Wasser ausgenommen — Stille ist dort normal)
 *  A3 seit über 30 Tagen deaktiviert (eigene Beobachtung; Home Assistant hält nur ~10 Tage Verlauf)
 *  B1 seit über 7 Tagen nicht verfügbar (aus dem Verlauf, weil ein HA-Neustart last_changed zurücksetzt), je Gerät
 *  B2 Bewegungs-/Belegungsmelder 7 Tage nie ausgelöst; Temperatur/Luftfeuchte ≥ 48 h unverändert
 *  B3 Verbindung instabil (≥ 5 kurze Aussetzer pro Tag)
 * Ausgenommen: EMS/Batterie/Pool (eigene Logik), Netzwerkgeräte-LEDs, Diagnose (Taster, Updates), Batteriestände
 * (Quelle „sensorbatterien" meldet sie bereits).
 */
import type { AutoZuordnung, HaZuordnung } from './ha-zuordnung.js';
import { zeitText } from './ha-verlauf.js';

export type Regel = 'A1' | 'A2' | 'A3' | 'B1' | 'B2' | 'B3';
export interface PruefBefund { gegenstand: string; regel: Regel; titel: string; detail: string }

export const GRENZEN = { nichtAusgeloestTage: 30, deaktiviertTage: 30, nichtVerfuegbarTage: 7, eingefrorenStunden: 48, aussetzerJeTag: 5 } as const;

export const REGEL_TEXT: Record<Regel, string> = {
  A1: 'Automation verweist auf fehlende Entität oder fehlendes Gerät',
  A2: `Automation aktiv, aber seit über ${GRENZEN.nichtAusgeloestTage} Tagen nicht ausgelöst`,
  A3: `Automation seit über ${GRENZEN.deaktiviertTage} Tagen deaktiviert`,
  B1: `Gerät seit über ${GRENZEN.nichtVerfuegbarTage} Tagen nicht verfügbar`,
  B2: 'Melder oder Messwert meldet nichts mehr',
  B3: `Verbindung instabil (≥ ${GRENZEN.aussetzerJeTag} kurze Aussetzer pro Tag)`,
};

const HINWEIS: Record<Regel, string> = {
  A1: 'Gerät getauscht oder entfernt? Automation auf das neue Gerät umstellen oder löschen.',
  A2: 'Auslöser prüfen (Melder stumm, Gerät weg?) — oder ist die Automation überflüssig?',
  A3: 'Bewusst behalten oder aufräumen?',
  B1: 'Gerät offline oder entfernt? Wieder verbinden oder in Home Assistant entfernen.',
  B2: 'Gerät prüfen (Batterie, Funkverbindung, Kopplung) — ein Gehtest zeigt, ob der Melder noch reagiert.',
  B3: 'Funk-/WLAN-Empfang am Gerät prüfen (Abstand, Repeater, Kanal).',
};

/** Ausnahmen laut Owner: EMS/Batterie/Pool haben eigene Logik und Spec. */
const AUSNAHME_AUTOMATION = /emhass|\bems\b|\bess\b|minsoc|akku|batterie-pflege|batterie-wirkungsgrad|ladefenster|pool/i;
const AUSNAHME_ENTITAET = /emhass|victron|(^|[._])ems[._]|(^|[._])ess[._]|pool|minsoc|ladefenster/i;
/** Diagnose und Netzwerk-LEDs — kein Hausbefund. */
const DIAGNOSE = /(^light\..*_led(_\d+)?$)|reboot|neu_starten|firmware|_restart$|_identify$/i;
/** Wiedergabe-Sitzungen (Emby/Jellyfin/Plex) entstehen je Nutzung und verschwinden danach — kein Gerät. */
const SITZUNGEN = /^media_player\.(emby|jellyfin|plex)_/i;
const OHNE_BEFUND_DOMAINS = new Set(['button', 'input_button', 'event', 'update', 'scene', 'image', 'camera', 'tts', 'conversation', 'notify', 'todo', 'stt', 'wake_word', 'automation', 'script', 'zone', 'sun', 'weather']);
/** A2: Stille ist hier der Normalfall. */
const SELTEN_NAME = /alarm|feuer|rauch|brand|wasser|leck|notfall|einbruch|sabotage|wächter|waechter/i;
const SELTEN_KLASSE = new Set(['smoke', 'carbon_monoxide', 'gas', 'moisture', 'safety', 'tamper', 'problem']);
const BEWEGUNG = new Set(['occupancy', 'motion', 'presence', 'moving']);
const SCHWANKEND = new Set(['temperature', 'humidity']);

export interface EntitaetZustand { state: string; lastChanged?: string; deviceClass?: string; name?: string }

export interface PruefEingabe {
  jetzt: number;
  tz: string;
  zuordnung: HaZuordnung;
  zustaende: Map<string, EntitaetZustand>;
  /** Raum/Gerätename je Entität */
  bereiche: Map<string, { raum?: string; geraet?: string }>;
  /** Automation → erstmals deaktiviert gesehen (eigene Beobachtung) */
  deaktiviertSeit: Record<string, string>;
  /** Beginn der eigenen Beobachtung deaktivierter Automationen */
  beobachtetSeit: string;
  /** B1: Entität → durchgehend nicht verfügbar im ganzen Prüffenster (aus dem Verlauf) */
  langNichtVerfuegbar: Set<string>;
  /** B2: Bewegungsmelder → im Fenster nie „an" (aus dem Verlauf) */
  nieAusgeloest: Set<string>;
  /** B3: Entität → kurze Aussetzer pro Tag (aus dem Verlauf) */
  aussetzerJeTag: Map<string, number>;
}

export const istAusgenommen = (entityId: string, name = '') =>
  OHNE_BEFUND_DOMAINS.has(entityId.split('.')[0]) || SITZUNGEN.test(entityId) || AUSNAHME_ENTITAET.test(entityId) || AUSNAHME_ENTITAET.test(name) || DIAGNOSE.test(entityId);
const automationAusgenommen = (a: AutoZuordnung) => AUSNAHME_AUTOMATION.test(a.name) || AUSNAHME_AUTOMATION.test(a.entityId);

const TAG = 86_400_000;
const zahl = (n: number) => n.toLocaleString('de-AT', { maximumFractionDigits: 1 });

export function pruefe(e: PruefEingabe): PruefBefund[] {
  const out: PruefBefund[] = [];
  const name = (id: string) => e.zustaende.get(id)?.name ?? id;
  const raum = (id: string) => e.bereiche.get(id)?.raum;
  const mitRaum = (id: string) => (raum(id) ? `${name(id)} (${raum(id)})` : name(id));

  for (const a of e.zuordnung.automationen) {
    if (automationAusgenommen(a)) continue;
    // A1 — fehlende Verweise
    if (a.fehlend.length > 0) {
      out.push({
        gegenstand: `A1:${a.entityId}`, regel: 'A1',
        titel: `Automation „${a.name}" verweist auf Fehlendes: ${a.fehlend.slice(0, 3).join(', ')}${a.fehlend.length > 3 ? ' …' : ''}`,
        detail: `${REGEL_TEXT.A1}. ${a.aktiv ? 'Die Automation ist aktiv.' : 'Die Automation ist deaktiviert.'} ${HINWEIS.A1}`,
      });
    }
    // A2 — lange nicht ausgelöst
    if (a.aktiv && !a.ohneKonfig) {
      const zuletzt = a.letzteAusloesung ? Date.parse(a.letzteAusloesung) : NaN;
      const lange = !Number.isFinite(zuletzt) || e.jetzt - zuletzt > GRENZEN.nichtAusgeloestTage * TAG;
      const selten = SELTEN_NAME.test(a.name) || a.ausloeser.some((t) => SELTEN_KLASSE.has(e.zustaende.get(t)?.deviceClass ?? ''));
      // reine Zeit-Trigger ohne Entität (z. B. Checkpoints) sind ohne Auslöser-Entität nicht bewertbar
      if (lange && !selten && a.ausloeser.length > 0) {
        const ausl = a.ausloeser.slice(0, 2).map((t) => {
          const z = e.zustaende.get(t);
          const zust = !z ? 'fehlt' : z.state === 'unavailable' ? 'nicht verfügbar' : e.nieAusgeloest.has(t) ? '7 Tage nie ausgelöst' : z.state;
          return `${mitRaum(t)}: ${zust}`;
        });
        out.push({
          gegenstand: `A2:${a.entityId}`, regel: 'A2',
          titel: `Automation „${a.name}" ${Number.isFinite(zuletzt) ? `zuletzt ausgelöst ${zeitText(zuletzt, e.tz)}` : 'nie ausgelöst'}`,
          detail: `${REGEL_TEXT.A2}. Auslöser: ${ausl.join(' · ')}. ${HINWEIS.A2}`,
        });
      }
    }
    // A3 — lange deaktiviert (nur belegbar über die eigene Beobachtung)
    if (!a.aktiv) {
      const seit = e.deaktiviertSeit[a.entityId] ? Date.parse(e.deaktiviertSeit[a.entityId]!) : NaN;
      if (Number.isFinite(seit) && e.jetzt - seit > GRENZEN.deaktiviertTage * TAG) {
        out.push({
          gegenstand: `A3:${a.entityId}`, regel: 'A3',
          titel: `Automation „${a.name}" seit mindestens ${zeitText(seit, e.tz).slice(0, 6)} deaktiviert`,
          detail: `${REGEL_TEXT.A3}. ${HINWEIS.A3}`,
        });
      }
    }
  }

  // B1 — je Gerät gebündelt (ein offline Gerät hat oft 5–10 Entitäten)
  const jeGeraet = new Map<string, string[]>();
  for (const id of e.langNichtVerfuegbar) {
    if (istAusgenommen(id, name(id))) continue;
    const g = e.bereiche.get(id)?.geraet ?? id;
    if (!jeGeraet.has(g)) jeGeraet.set(g, []);
    jeGeraet.get(g)!.push(id);
  }
  for (const [g, ids] of jeGeraet) {
    const r = raum(ids[0]!);
    out.push({
      gegenstand: `B1:${g}`, regel: 'B1',
      titel: `${g}${r ? ` (${r})` : ''}: ${ids.length === 1 ? name(ids[0]!) : `${ids.length} Entitäten`} seit über ${GRENZEN.nichtVerfuegbarTage} Tagen nicht verfügbar`,
      detail: `${REGEL_TEXT.B1}. Betroffen: ${ids.slice(0, 5).join(', ')}${ids.length > 5 ? ` … (+${ids.length - 5})` : ''}. ${HINWEIS.B1}`,
    });
  }

  // B2 — stumme Melder, eingefrorene Messwerte
  for (const id of e.nieAusgeloest) {
    if (istAusgenommen(id, name(id)) || e.langNichtVerfuegbar.has(id)) continue;
    const nutzer = e.zuordnung.automationen.filter((a) => a.ausloeser.includes(id) && a.aktiv).map((a) => `„${a.name}"`);
    out.push({
      gegenstand: `B2:${id}`, regel: 'B2',
      titel: `Melder ${mitRaum(id)}: in ${GRENZEN.nichtVerfuegbarTage} Tagen nie ausgelöst`,
      detail: `${REGEL_TEXT.B2}.${nutzer.length ? ` Davon abhängig: ${nutzer.slice(0, 4).join(', ')}.` : ''} ${HINWEIS.B2}`,
    });
  }
  for (const [id, z] of e.zustaende) {
    if (!SCHWANKEND.has(z.deviceClass ?? '') || !/^sensor\./.test(id) || istAusgenommen(id, z.name)) continue;
    if (z.state === 'unavailable' || z.state === 'unknown' || !z.lastChanged) continue;
    const alter = e.jetzt - Date.parse(z.lastChanged);
    if (!(alter >= GRENZEN.eingefrorenStunden * 3_600_000)) continue;
    out.push({
      gegenstand: `B2:${id}`, regel: 'B2',
      titel: `${mitRaum(id)}: Wert ${z.state} seit ${zahl(alter / 3_600_000)} h unverändert`,
      detail: `${REGEL_TEXT.B2} (${z.deviceClass === 'temperature' ? 'Temperatur' : 'Luftfeuchte'} schwankt normalerweise; Frist zählt nach einem Neustart von Home Assistant neu). ${HINWEIS.B2}`,
    });
  }

  // B3 — instabile Verbindung
  for (const [id, n] of e.aussetzerJeTag) {
    if (n < GRENZEN.aussetzerJeTag || istAusgenommen(id, name(id))) continue;
    out.push({
      gegenstand: `B3:${id}`, regel: 'B3',
      titel: `${mitRaum(id)}: ${zahl(n)} kurze Verbindungsaussetzer pro Tag`,
      detail: `${REGEL_TEXT.B3}. ${HINWEIS.B3}`,
    });
  }
  return out;
}

/** Text für die Aktion `review` (Chat) — gruppiert nach Regel, ohne Abgleich. */
export function pruefText(befunde: PruefBefund[], e: { tz: string; jetzt: number; deaktiviert: number; beobachtetSeit: string; hinweise: string[] }): string {
  const z = [`## Haus-Check (${zeitText(e.jetzt, e.tz)}) — ${befunde.length} Punkte`, 'Beobachtungsphase: nur Befunde, keine Änderungen an Home Assistant. Regeln und Grenzen fest im Code.', ''];
  for (const r of ['A1', 'A2', 'A3', 'B1', 'B2', 'B3'] as Regel[]) {
    const teil = befunde.filter((b) => b.regel === r);
    if (teil.length === 0) continue;
    z.push(`### ${r} — ${REGEL_TEXT[r]} (${teil.length})`);
    for (const b of teil.slice(0, 25)) z.push(`- ${b.titel}`);
    if (teil.length > 25) z.push(`- … ${teil.length - 25} weitere`);
    z.push(`Hinweis: ${HINWEIS[r]}`, '');
  }
  if (!befunde.some((b) => b.regel === 'A3') && e.deaktiviert > 0) {
    z.push(`${e.deaktiviert} deaktivierte Automationen — ihre Dauer beobachtet Alfred seit ${zeitText(Date.parse(e.beobachtetSeit), e.tz)}; ab ${GRENZEN.deaktiviertTage} Tagen erscheinen sie unter A3.`);
  }
  for (const h of e.hinweise) z.push(h);
  z.push('', 'Ausgenommen: EMS/Batterie/Pool, Netzwerk-LEDs, Diagnose-Entitäten, Batteriestände (meldet „sensorbatterien"); Alarm-, Rauch- und Wasser-Automationen bei A2.');
  return z.join('\n');
}

/** Ein Satz für Telegram nach einem Lauf. */
export function pruefSatz(r: { neu: number; offen: number; erledigt: number }): string {
  const teile = [`${r.neu} neu`, `${r.offen} offen`, ...(r.erledigt ? [`${r.erledigt} erledigt`] : [])];
  return `🏠 Haus-Check: ${teile.join(', ')} — Details in der App unter „Befunde" › Haus-Check.`;
}
