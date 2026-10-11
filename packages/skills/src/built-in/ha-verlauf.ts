/**
 * v1357 — Verlaufsauswertung für Home Assistant (Vorschlag 3, Punkt 8).
 *
 * Analyse 11.10.: Fragen wie „welche Lichter waren länger an als sonst" ließen das Modell aus Rohverläufen selbst rechnen —
 * Unteragenten schrieben dafür 41–48k Tokens Jinja-Templates, Haiku verrechnete sich und verwechselte UTC mit Ortszeit,
 * lange Verläufe wurden von der Pipeline in der Mitte gekürzt. Hier rechnet der Code: Dauer je Zustand und Tag (Ortszeit),
 * Schaltungen, längste Phasen, kurze Aussetzer, Messwert-Statistik, Vergleichszeitraum, Ursachen aus dem Logbuch.
 * Reine Funktionen ohne Netz — jedes Modell der Fallback-Kette bekommt dieselben Zahlen.
 */

export interface HaZustand { state: string; last_changed: string }
export interface Fenster { von: number; bis: number }
export interface Phase { zustand: string; von: number; bis: number }

/** Kürzere „nicht verfügbar"-Phasen gelten als Aussetzer: der vorige Zustand läuft weiter. */
export const AUSSETZER_MS = 5 * 60_000;
const UNVERFUEGBAR = new Set(['unavailable', 'unknown']);
const TAG_MS = 86_400_000;

export interface Phasen { phasen: Phase[]; aussetzer: number; datenAb: number; ersteAenderung?: number }

/** Zustandsreihe → lückenlose Phasen im Fenster; kurze Aussetzer überbrückt. */
export function phasenAus(reihe: HaZustand[], fenster: Fenster, aussetzerMs = AUSSETZER_MS): Phasen {
  const punkte = reihe
    .map(r => ({ z: String(r.state), t: Date.parse(r.last_changed) }))
    .filter(p => Number.isFinite(p.t))
    .sort((a, b) => a.t - b.t);
  // Erster Eintrag nach Fensterbeginn → vorher keine Daten (Aufbewahrung des Recorders)
  const datenAb = punkte.length > 0 && punkte[0].t > fenster.von + 60_000 ? punkte[0].t : fenster.von;
  const roh: Array<Phase & { echt: number; davor?: string }> = [];
  for (let i = 0; i < punkte.length; i++) {
    const von = Math.max(punkte[i].t, fenster.von);
    const bis = Math.min(i + 1 < punkte.length ? punkte[i + 1].t : fenster.bis, fenster.bis);
    if (bis > von) roh.push({ zustand: punkte[i].z, von, bis, echt: punkte[i].t, davor: i > 0 ? punkte[i - 1].z : undefined });
  }
  const phasen: Phase[] = [];
  let aussetzer = 0;
  for (const p of roh) {
    // Dauer ab dem echten Beginn — ein vor dem Fenster begonnener Ausfall ist kein Aussetzer
    const kurz = UNVERFUEGBAR.has(p.zustand) && p.bis - p.echt < aussetzerMs;
    const letzte = phasen[phasen.length - 1];
    if (kurz && letzte && !UNVERFUEGBAR.has(letzte.zustand)) { letzte.bis = p.bis; aussetzer++; continue; }
    // Aussetzer genau am Fensterbeginn: der Zustand davor läuft weiter
    if (kurz && !letzte && p.davor !== undefined && !UNVERFUEGBAR.has(p.davor)) { phasen.push({ zustand: p.davor, von: p.von, bis: p.bis }); aussetzer++; continue; }
    if (letzte && letzte.zustand === p.zustand && letzte.bis === p.von) { letzte.bis = p.bis; continue; }
    phasen.push({ zustand: p.zustand, von: p.von, bis: p.bis });
  }
  const ersteAenderung = punkte.length > 0 ? punkte[0].t : undefined;
  return { phasen, aussetzer, datenAb, ersteAenderung };
}

// ── Ortszeit ────────────────────────────────────────────────

const formatierer = new Map<string, Intl.DateTimeFormat>();
function teile(t: number, tz: string): { y: number; m: number; d: number; h: number; mi: number; s: number } {
  let f = formatierer.get(tz);
  if (!f) {
    f = new Intl.DateTimeFormat('en-CA', { timeZone: tz, year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit', hourCycle: 'h23' });
    formatierer.set(tz, f);
  }
  const o: Record<string, number> = {};
  for (const p of f.formatToParts(new Date(t))) if (p.type !== 'literal') o[p.type] = Number(p.value);
  return { y: o.year, m: o.month, d: o.day, h: o.hour, mi: o.minute, s: o.second };
}
function versatz(t: number, tz: string): number {
  const p = teile(t, tz);
  return Date.UTC(p.y, p.m - 1, p.d, p.h, p.mi, p.s) - Math.floor(t / 1000) * 1000;
}
/** Nächste Mitternacht (Ortszeit) nach t — Sommer-/Winterzeit-fest. */
export function naechsteMitternacht(t: number, tz: string): number {
  const p = teile(t, tz);
  const ziel = Date.UTC(p.y, p.m - 1, p.d + 1);
  const erst = ziel - versatz(ziel, tz);
  return ziel - versatz(erst, tz);
}
export function tagSchluessel(t: number, tz: string): string {
  const p = teile(t, tz);
  return `${p.y}-${String(p.m).padStart(2, '0')}-${String(p.d).padStart(2, '0')}`;
}
const zwei = (n: number) => String(n).padStart(2, '0');
/** „09.10. 01:48" (kurz) bzw. „09.10.2026 01:48:05" (lang) in Ortszeit. */
export function zeitText(t: number, tz: string, lang = false): string {
  const p = teile(t, tz);
  return lang
    ? `${zwei(p.d)}.${zwei(p.m)}.${p.y} ${zwei(p.h)}:${zwei(p.mi)}:${zwei(p.s)}`
    : `${zwei(p.d)}.${zwei(p.m)}. ${zwei(p.h)}:${zwei(p.mi)}`;
}

// ── Auswertung ──────────────────────────────────────────────

export interface ZustandsWerte {
  art: 'zustand';
  dauer: Record<string, number>;
  /** Phasen, die im Fenster begonnen haben (Schaltungen), je Zustand */
  wechsel: Record<string, number>;
  laengste: Record<string, Phase>;
  /** Dauer „on" je Ortstag (nur wenn „on" vorkommt) */
  tage?: Array<{ tag: string; an: number }>;
  einschaltZeiten: number[];
}
export interface MessWerte {
  art: 'messwert';
  min: number; max: number; mittel: number;
  letzter: number;
  unveraendertSeit: number;
  unverfuegbar: number;
}
export interface Auswertung {
  fenster: Fenster;
  datenAb: number;
  aussetzer: number;
  /** Zeit „nicht verfügbar" (nach Überbrückung kurzer Aussetzer) */
  unverfuegbar: number;
  werte: ZustandsWerte | MessWerte;
}

const istZahl = (s: string) => s.trim() !== '' && Number.isFinite(Number(s.replace(',', '.')));

export function werteAus(reihe: HaZustand[], fenster: Fenster, tz: string, aussetzerMs = AUSSETZER_MS): Auswertung {
  const { phasen, aussetzer, datenAb, ersteAenderung } = phasenAus(reihe, fenster, aussetzerMs);
  const unverfuegbar = phasen.filter(p => UNVERFUEGBAR.has(p.zustand)).reduce((s, p) => s + (p.bis - p.von), 0);
  const gueltig = phasen.filter(p => !UNVERFUEGBAR.has(p.zustand));

  if (gueltig.length > 0 && gueltig.every(p => istZahl(p.zustand))) {
    const zahl = (p: Phase) => Number(p.zustand.replace(',', '.'));
    let summe = 0, dauer = 0, min = Infinity, max = -Infinity;
    for (const p of gueltig) { const w = zahl(p); summe += w * (p.bis - p.von); dauer += p.bis - p.von; min = Math.min(min, w); max = Math.max(max, w); }
    // unverändert seit: Beginn der letzten Phase mit anderem Wert als die davor (Aussetzer dazwischen zählen nicht)
    let j = gueltig.length - 1;
    while (j > 0 && zahl(gueltig[j - 1]) === zahl(gueltig[j])) j--;
    const seit = j === 0 && ersteAenderung !== undefined ? Math.min(ersteAenderung, gueltig[0].von) : gueltig[j].von;
    return {
      fenster, datenAb, aussetzer, unverfuegbar,
      werte: { art: 'messwert', min, max, mittel: dauer > 0 ? summe / dauer : zahl(gueltig[0]), letzter: zahl(gueltig[gueltig.length - 1]), unveraendertSeit: seit, unverfuegbar },
    };
  }

  const werte: ZustandsWerte = { art: 'zustand', dauer: {}, wechsel: {}, laengste: {}, einschaltZeiten: [] };
  for (const p of phasen) {
    werte.dauer[p.zustand] = (werte.dauer[p.zustand] ?? 0) + (p.bis - p.von);
    if (p.von > fenster.von) werte.wechsel[p.zustand] = (werte.wechsel[p.zustand] ?? 0) + 1;
    const l = werte.laengste[p.zustand];
    if (!l || p.bis - p.von > l.bis - l.von) werte.laengste[p.zustand] = p;
    if (p.zustand === 'on' && p.von > fenster.von) werte.einschaltZeiten.push(p.von);
  }
  if (werte.dauer.on !== undefined || phasen.some(p => p.zustand === 'off')) {
    const tage = new Map<string, number>();
    for (let t = datenAb; t < fenster.bis; t = naechsteMitternacht(t, tz)) tage.set(tagSchluessel(t, tz), 0);
    for (const p of phasen) {
      if (p.zustand !== 'on') continue;
      let a = p.von;
      while (a < p.bis) {
        const e = Math.min(p.bis, naechsteMitternacht(a, tz));
        const k = tagSchluessel(a, tz);
        tage.set(k, (tage.get(k) ?? 0) + (e - a));
        a = e;
      }
    }
    werte.tage = [...tage.entries()].map(([tag, an]) => ({ tag, an }));
  }
  return { fenster, datenAb, aussetzer, unverfuegbar, werte };
}

// ── Ursachen aus dem Logbuch ────────────────────────────────

export interface LogbuchEintrag {
  entity_id?: string; state?: string; when?: string;
  context_event_type?: string; context_name?: string; context_source?: string; context_entity_id?: string;
  context_user_id?: string; context_domain?: string;
}
export interface Ursache { text: string; anzahl: number; automation?: string }

/** Ursache je Einschaltung: Logbuch-Eintrag „on" zum selben Zeitpunkt (±3 s). */
export function ursachenAus(einschaltZeiten: number[], logbuch: LogbuchEintrag[]): Ursache[] {
  const an = logbuch
    .filter(e => e.state === 'on' && e.when)
    .map(e => ({ t: Date.parse(String(e.when)), e }))
    .filter(x => Number.isFinite(x.t));
  const zaehler = new Map<string, Ursache>();
  for (const t of einschaltZeiten) {
    const treffer = an.find(x => Math.abs(x.t - t) <= 3000)?.e;
    let text: string; let automation: string | undefined;
    if (treffer?.context_event_type === 'automation_triggered' || treffer?.context_domain === 'automation') {
      text = `Automation „${treffer.context_name ?? treffer.context_entity_id ?? '?'}"${treffer.context_source ? ` (${treffer.context_source})` : ''}`;
      automation = treffer.context_entity_id;
    } else if (treffer?.context_domain === 'script') {
      text = `Skript „${treffer.context_name ?? treffer.context_entity_id ?? '?'}"`;
    } else if (treffer?.context_user_id) {
      text = 'Person (App/Oberfläche)';
    } else {
      text = 'ohne Kontext (Taster/Gerät selbst)';
    }
    const u = zaehler.get(text) ?? { text, anzahl: 0, automation };
    u.anzahl++;
    zaehler.set(text, u);
  }
  return [...zaehler.values()].sort((a, b) => b.anzahl - a.anzahl);
}

// ── Darstellung ─────────────────────────────────────────────

export interface EntitaetsBericht {
  entityId: string;
  name?: string;
  /** device_class aus Home Assistant (z. B. occupancy, motion) */
  klasse?: string;
  einheit?: string;
  jetzt?: { state: string; lastChanged?: string; lastReported?: string };
  aktuell: Auswertung;
  vergleich?: Auswertung;
  ursachen?: Ursache[];
  automationen?: Array<{ entityId: string; name?: string; state?: string; lastTriggered?: string }>;
}

const std = (ms: number) => (ms / 3_600_000).toLocaleString('de-AT', { maximumFractionDigits: 1, minimumFractionDigits: 1 });
const zahlText = (n: number) => n.toLocaleString('de-AT', { maximumFractionDigits: 2 });
const tage = (a: Auswertung) => Math.max((a.fenster.bis - a.datenAb) / TAG_MS, 1 / 24);
export const anJeTag = (a: Auswertung) => a.werte.art === 'zustand' ? (a.werte.dauer.on ?? 0) / tage(a) : 0;

/** Melder, bei denen „nie an" im Zeitraum ein Ausfall sein kann (Tür/Fenster dürfen tagelang zu sein). */
const BEWEGUNG = new Set(['occupancy', 'motion', 'presence', 'moving']);
const AUSSETZER_JE_TAG = 5;

/** Kennzeichen „auffällig" — feste Regeln, in der Ausgabe genannt. */
export function auffaelligkeiten(b: EntitaetsBericht, jetzt: number): string[] {
  const out: string[] = [];
  const a = b.aktuell;
  const fensterLaenge = a.fenster.bis - a.datenAb;
  if (fensterLaenge > 0 && a.unverfuegbar / fensterLaenge >= 0.1) out.push(`${Math.round(a.unverfuegbar / fensterLaenge * 100)} % nicht verfügbar`);
  if (fensterLaenge >= TAG_MS && a.aussetzer / (fensterLaenge / TAG_MS) >= AUSSETZER_JE_TAG) out.push(`Verbindung instabil (${zahlText(a.aussetzer / (fensterLaenge / TAG_MS))} kurze Aussetzer/Tag)`);
  if (a.werte.art === 'zustand') {
    const l = a.werte.laengste.on;
    if (l && l.bis - l.von >= 12 * 3_600_000) out.push(`an am Stück ${std(l.bis - l.von)} h`);
    if (b.vergleich?.werte.art === 'zustand') {
      const x = anJeTag(a), y = anJeTag(b.vergleich);
      if (Math.abs(x - y) >= 0.5 * 3_600_000 && (y === 0 || x / y >= 1.5 || x / y <= 0.67)) out.push(`an ${std(x)} statt ${std(y)} h/Tag`);
    }
    // Neustarts von Home Assistant setzen Melder kurz auf „unbekannt" — maßgeblich ist, ob je „an" gemeldet wurde
    if (b.klasse && BEWEGUNG.has(b.klasse) && !a.werte.dauer.on && fensterLaenge >= TAG_MS) out.push('Melder im ganzen Zeitraum nie ausgelöst (stumm)');
  } else if (jetzt - a.werte.unveraendertSeit >= TAG_MS) {
    out.push(`Wert unverändert seit ${std(jetzt - a.werte.unveraendertSeit)} h`);
  }
  return out;
}

export const AUFFAELLIG_REGELN = 'auffällig = ≥ 10 % nicht verfügbar · ≥ 5 kurze Aussetzer/Tag · an am Stück ≥ 12 h · an/Tag Faktor ≥ 1,5 oder ≤ 0,67 (mind. 0,5 h Unterschied) · Bewegungs-/Belegungsmelder nie ausgelöst · Messwert ≥ 24 h unverändert';

function zustandText(z: string): string {
  return ({ on: 'an', off: 'aus', unavailable: 'nicht verfügbar', unknown: 'unbekannt' } as Record<string, string>)[z] ?? z;
}

export function berichtDetail(b: EntitaetsBericht, tz: string, jetzt: number): string[] {
  const a = b.aktuell;
  const z: string[] = [`### ${b.name ?? b.entityId} (\`${b.entityId}\`)`];
  if (a.datenAb > a.fenster.von) z.push(`Daten erst ab ${zeitText(a.datenAb, tz)} (davor kein Eintrag im Verlauf)`);
  if (a.werte.art === 'messwert') {
    const w = a.werte; const e = b.einheit ? ` ${b.einheit}` : '';
    z.push(`Min ${zahlText(w.min)}${e} · Max ${zahlText(w.max)}${e} · Mittel ${zahlText(w.mittel)}${e}` +
      (b.vergleich?.werte.art === 'messwert' ? ` · Vergleich Mittel ${zahlText(b.vergleich.werte.mittel)}${e}` : ''));
    z.push(`letzter Wert ${zahlText(w.letzter)}${e}, unverändert seit ${zeitText(w.unveraendertSeit, tz)}` +
      (b.jetzt?.lastReported ? ` · letzte Meldung des Sensors ${zeitText(Date.parse(b.jetzt.lastReported), tz)}` : ''));
  } else {
    const w = a.werte; const v = b.vergleich?.werte.art === 'zustand' ? b.vergleich : undefined;
    if (w.dauer.on !== undefined || w.tage) {
      let zeile = `an ${std(w.dauer.on ?? 0)} h (${std(anJeTag(a))} h/Tag)`;
      if (v) {
        const x = anJeTag(a), y = anJeTag(v);
        zeile += ` · Vergleich ${std(y)} h/Tag` + (y > 0 ? ` · Faktor ${zahlText(x / y)}` : '');
      }
      z.push(zeile);
      const vw = v?.werte as ZustandsWerte | undefined;
      z.push(`Einschaltungen ${w.wechsel.on ?? 0}` + (vw ? ` (Vergleich ${vw.wechsel.on ?? 0})` : '') +
        (w.laengste.on ? ` · längste Phase an ${std(w.laengste.on.bis - w.laengste.on.von)} h (${zeitText(w.laengste.on.von, tz)} – ${zeitText(w.laengste.on.bis, tz)})` : ''));
      if (w.tage && w.tage.length > 0 && w.tage.length <= 14) z.push(`je Tag an (h): ${w.tage.map(t => `${t.tag.slice(8, 10)}.${t.tag.slice(5, 7)}. ${std(t.an)}`).join(' · ')}`);
    } else {
      z.push(Object.entries(w.dauer).sort((x, y) => y[1] - x[1]).map(([k, d]) => `${zustandText(k)} ${std(d)} h (${w.wechsel[k] ?? 0}×)`).join(' · '));
    }
  }
  if (a.unverfuegbar > 0 || a.aussetzer > 0) {
    z.push(`nicht verfügbar ${std(a.unverfuegbar)} h` + (a.aussetzer > 0 ? ` · ${a.aussetzer} kurze Aussetzer (< ${AUSSETZER_MS / 60_000} min) überbrückt` : ''));
  }
  if (b.ursachen && b.ursachen.length > 0) z.push(`Ursachen der Einschaltungen: ${b.ursachen.map(u => `${u.anzahl}× ${u.text}`).join(' · ')}`);
  for (const au of b.automationen ?? []) {
    z.push(`Automation ${au.name ?? au.entityId}: ${au.state === 'off' ? 'DEAKTIVIERT' : 'aktiv'}` + (au.lastTriggered ? `, zuletzt ausgelöst ${zeitText(Date.parse(au.lastTriggered), tz)}` : ''));
  }
  if (b.jetzt) z.push(`jetzt: ${zustandText(b.jetzt.state)}` + (b.jetzt.lastChanged ? ` seit ${zeitText(Date.parse(b.jetzt.lastChanged), tz)}` : ''));
  const auff = auffaelligkeiten(b, jetzt);
  if (auff.length > 0) z.push(`**auffällig:** ${auff.join(' · ')}`);
  return z;
}

/** Gesamtausgabe: bis 6 Entitäten ausführlich, sonst Übersicht (geänderte zuerst) + Details der Auffälligen. */
export function berichtText(berichte: EntitaetsBericht[], opt: { tz: string; jetzt: number; aktuell: Fenster; vergleich?: Fenster; nichtAusgewertet?: number }): string {
  const { tz, jetzt } = opt;
  const kopf = [
    `## Verlaufsauswertung (${berichte.length} Entitäten)`,
    `Zeitraum ${zeitText(opt.aktuell.von, tz)} – ${zeitText(opt.aktuell.bis, tz)}` + (opt.vergleich ? ` · Vergleich ${zeitText(opt.vergleich.von, tz)} – ${zeitText(opt.vergleich.bis, tz)}` : '') + ` · Zeiten ${tz}`,
    `Regeln: ${AUFFAELLIG_REGELN}. Werte sind im Code berechnet — nicht nachrechnen.`,
  ];
  if (opt.nichtAusgewertet) kopf.push(`Hinweis: ${opt.nichtAusgewertet} weitere Entitäten nicht ausgewertet — enger filtern (entities/area/domain/match).`);
  if (berichte.length <= 6) return [...kopf, '', ...berichte.flatMap(b => [...berichtDetail(b, tz, jetzt), ''])].join('\n');

  const geaendert = (b: EntitaetsBericht) => b.aktuell.werte.art === 'messwert' || Object.keys(b.aktuell.werte.wechsel).length > 0 || (b.aktuell.werte.dauer.on ?? 0) > 0;
  const gewicht = (b: EntitaetsBericht) => auffaelligkeiten(b, jetzt).length * 1e9 + anJeTag(b.aktuell);
  const aktiv = berichte.filter(geaendert).sort((x, y) => gewicht(y) - gewicht(x));
  const ruhig = berichte.filter(b => !geaendert(b));
  const z = [...kopf, ''];
  const zustaende = aktiv.filter(b => b.aktuell.werte.art === 'zustand');
  if (zustaende.length > 0) {
    z.push('| Entität | an h/Tag | Vergleich h/Tag | Schaltungen | längste an | n.v. h | jetzt |', '|---|---|---|---|---|---|---|');
    for (const b of zustaende.slice(0, 25)) {
      const w = b.aktuell.werte as ZustandsWerte;
      const v = b.vergleich && b.vergleich.werte.art === 'zustand' ? std(anJeTag(b.vergleich)) : '-';
      const l = w.laengste.on ? std(w.laengste.on.bis - w.laengste.on.von) : '-';
      z.push(`| ${b.name ?? b.entityId} (\`${b.entityId}\`) | ${std(anJeTag(b.aktuell))} | ${v} | ${w.wechsel.on ?? Object.values(w.wechsel).reduce((s, n) => s + n, 0)} | ${l} | ${std(b.aktuell.unverfuegbar)} | ${zustandText(b.jetzt?.state ?? '-')} |`);
    }
    if (zustaende.length > 25) z.push(`… ${zustaende.length - 25} weitere mit Änderungen`);
    z.push('');
  }
  const mess = aktiv.filter(b => b.aktuell.werte.art === 'messwert');
  if (mess.length > 0) {
    z.push('| Entität | Mittel | Min–Max | unverändert seit |', '|---|---|---|---|');
    for (const b of mess.slice(0, 25)) {
      const w = b.aktuell.werte as MessWerte; const e = b.einheit ? ` ${b.einheit}` : '';
      z.push(`| ${b.name ?? b.entityId} (\`${b.entityId}\`) | ${zahlText(w.mittel)}${e} | ${zahlText(w.min)}–${zahlText(w.max)} | ${zeitText(w.unveraendertSeit, tz)} |`);
    }
    if (mess.length > 25) z.push(`… ${mess.length - 25} weitere Messwerte`);
    z.push('');
  }
  if (ruhig.length > 0) {
    const jeZustand = new Map<string, number>();
    for (const b of ruhig) { const s = zustandText(b.jetzt?.state ?? Object.keys((b.aktuell.werte as ZustandsWerte).dauer)[0] ?? '?'); jeZustand.set(s, (jeZustand.get(s) ?? 0) + 1); }
    z.push(`${ruhig.length} ohne jede Änderung im Zeitraum (${[...jeZustand.entries()].map(([s, n]) => `${n}× ${s}`).join(', ')}).`, '');
  }
  // dauerhaft nicht verfügbare stehen oben gezählt — Details nur für die mit echtem Verlauf
  const dauerhaftWeg = (b: EntitaetsBericht) => b.aktuell.unverfuegbar >= 0.99 * (b.aktuell.fenster.bis - b.aktuell.datenAb);
  const details = berichte.filter(b => !dauerhaftWeg(b) && auffaelligkeiten(b, jetzt).length > 0).sort((x, y) => gewicht(y) - gewicht(x)).slice(0, 5);
  if (details.length > 0) z.push('Details der Auffälligsten:', '', ...details.flatMap(b => [...berichtDetail(b, tz, jetzt), '']));
  return z.join('\n');
}
