/**
 * v1360 — Prüfung von Reasoning-Hinweisen vor der Zustellung (Owner 12.10.: „Hinweise reparieren").
 *
 * Realfall 11.10.: Die Meldung „Claude-API-Zugang deaktiviert" kam neunmal (14:00–22:31), jedes Mal anders formuliert;
 * das inhaltliche Gate (v1142) erkennt dasselbe Thema nur bei Jaccard ≥ 0,5 oder bei Objekten einer festen Liste —
 * „Anthropic" stand nicht darauf. Dazu wurden Vorreden des Modells („Hier sind die Insights …", „Ich habe die
 * Vorab-Analyse durchgesehen …") und einmal die rohe JSON-Antwort als Hinweis zugestellt.
 *
 * Deterministisch, ohne Modell — gilt für jedes Modell der Fallback-Kette.
 */

/**
 * v1361 — Darf ein Hinweis dieser Kategorie eine ausführbare Aktion („Ausführen") tragen?
 *
 * Reasoning-Hinweise nicht: Jede Aktion eines Reasoning-Passes wird ohnehin behandelt (entscheideAusfuehrung —
 * `auto` führt Alfred selbst aus, `bestaetigen` landet in den Bestätigungen, `nie` wird blockiert). Ein Knopf am
 * Hinweis wäre ein Duplikat oder umginge Bestätigung bzw. Sperre. Dazu hing bisher die ERSTE Aktion des Passes an
 * JEDEM Hinweis des Passes (Realfall 11.10.: DDNSS-Hinweis → Erinnerung zu Anthropic, Domain-Hinweis → UniFi-Liste).
 * Andere Kategorien mit gezielter eigener Aktion (z. B. Interessen-Vorschlag „Thema anlegen") bleiben.
 */
export function hinweisAktionErlaubt(kategorie: string | undefined): boolean {
  return kategorie !== 'reasoning';
}

/** Wörter ohne Unterscheidungskraft (häufig in jedem Hinweis). */
const STOPP = new Set(('aber alle allen auch beim bitte dann dass dein deine deinen deiner dem den der des die dies diese dieser diesem durch '
  + 'eine einem einen einer eines erst etwa gibt habe haben hast hat hier ihre immer jetzt kann keine liegt mehr mit nach nicht noch nur oder '
  + 'ohne sein seit sich sind sowie über unter vom von vor wegen weil weiter wenn werden wieder wird wurde zum zur zwei drei vier bereits laut '
  + 'prüfen prüfe handlungsbedarf dringend hoch normal hinweis hinweise insights insight frist heute morgen aktuell melden meldet gemeldet '
  + 'entität entitäten neu neue neuen verfügbar nicht-verfügbar unavailable status zustand gerät geräte home assistant owner bitte klären').split(' '));

export function inhaltsWoerter(s: string): Set<string> {
  return new Set(s.toLowerCase().replace(/\*\*/g, ' ').replace(/[^a-zäöüß0-9\s-]/g, ' ').split(/[\s-]+/)
    .filter(w => w.length >= 4 && !/^\d+$/.test(w) && !STOPP.has(w)));
}

/**
 * Anker: was ein Thema eindeutig macht — Datum, Uhrzeit, Prozentwert, Domain, Hex-Kennung, Eigenname in Groß- oder
 * Binnenmajuskel (DDNSS, UniFi). Wiederholungen beziehen sich auf dieselbe Mail oder Kennzahl → dieselben Anker.
 */
export function ankerAus(s: string): Set<string> {
  const a = new Set<string>();
  for (const m of s.matchAll(/\b(\d{1,2})\.(\d{1,2})\.(?!\d)/g)) a.add(`d:${+m[1]!}.${+m[2]!}`);
  for (const m of s.matchAll(/\b(\d{1,2}):(\d{2})\b/g)) a.add(`t:${+m[1]!}:${m[2]}`);
  for (const m of s.matchAll(/\b(\d{1,3}(?:[.,]\d+)?)\s?%/g)) a.add(`p:${m[1]!.replace(',', '.')}`);
  for (const m of s.matchAll(/\b([a-z0-9-]+\.(?:com|at|de|net|org|io|eu|ch|it))\b/gi)) a.add(`h:${m[1]!.toLowerCase()}`);
  for (const m of s.matchAll(/\b([A-Z]{3,}[A-Za-z0-9]*|[A-Z][a-z]+[A-Z][A-Za-z]*)\b/g)) {
    if (!/^(ACTIONS?|HIGH|NORMAL|URGENT|LOW|ERLEDIGT|KEINE_INSIGHTS)$/.test(m[1]!)) a.add(`n:${m[1]!.toLowerCase()}`);
  }
  for (const m of s.matchAll(/\b[0-9A-F]{8,}\b/g)) a.add(`x:${m[0]}`);
  return a;
}

const schnitt = (x: Set<string>, y: Set<string>) => { let n = 0; for (const v of x) if (y.has(v)) n++; return n; };

export interface Wiederholung { gegen: string; anker: number; ueberlappung: number }

/**
 * Ist `neu` dasselbe Thema wie ein bereits zugestellter Hinweis? Gemeinsame Anker UND Wortüberlappung (relativ zum
 * kürzeren Text). Kalibriert an 103 echten Hinweisen (14.09.–11.10.): erkennt die Serien (Anthropic 9×, Power
 * Platform, Agent-Autonomie, DDNSS, noahhabel), ohne verschiedene Geräte oder Feed-Artikel zusammenzulegen.
 */
export function istThemenWiederholung(neu: string, frueher: string[]): Wiederholung | null {
  const an = ankerAus(neu), wn = inhaltsWoerter(neu);
  if (wn.size === 0) return null;
  let best: Wiederholung | null = null;
  for (const f of frueher) {
    const af = ankerAus(f), wf = inhaltsWoerter(f);
    if (wf.size === 0) continue;
    const a = schnitt(an, af);
    const ue = schnitt(wn, wf) / Math.min(wn.size, wf.size);
    const treffer = (a >= 2 && ue >= 0.35) || (a >= 3 && ue >= 0.25);
    if (treffer && (!best || ue > best.ueberlappung)) best = { gegen: f, anker: a, ueberlappung: ue };
  }
  return best;
}

const PUNKT = /^\s*(?:[-*•]|\d+[.)])\s+/;

/** Aufzählungspunkte eines Textes (je Punkt samt Folgezeilen); ohne Aufzählung der ganze Text. */
export function punkteAus(text: string): string[] {
  const zeilen = text.split('\n');
  const punkte: string[] = [];
  for (const z of zeilen) {
    if (PUNKT.test(z) || punkte.length === 0) punkte.push(z);
    else punkte[punkte.length - 1] += `\n${z}`;
  }
  return punkte.map(p => p.trim()).filter(Boolean);
}

/**
 * Wiederholte Punkte aus einem Hinweis entfernen — je Aufzählungspunkt, nicht je Text: Sammelhinweise nennen Neues und
 * Bekanntes nebeneinander (Realfall: „36 PV-Entitäten … git-server RAM 95,7 %"); verglichen wird auch gegen die einzelnen
 * Punkte früherer Hinweise. Rückgabe: verbleibender Text (null = alles schon bekannt) und die entfernten Punkte.
 */
export function entferneWiederholungen(neu: string, frueher: string[]): { text: string | null; entfernt: Array<{ punkt: string; w: Wiederholung }> } {
  const fruehereTeile = frueher.flatMap(f => punkteAus(f));
  const punkte = punkteAus(neu);
  const bleiben: string[] = [];
  const entfernt: Array<{ punkt: string; w: Wiederholung }> = [];
  for (const p of punkte) {
    // Kopfzeile eines Sammelhinweises („Offene Punkte:") bleibt nur, wenn Inhalt folgt
    if (!PUNKT.test(p) && punkte.length > 1 && istMetaText(p)) continue;
    const w = istThemenWiederholung(p, fruehereTeile);
    if (w) entfernt.push({ punkt: p, w }); else bleiben.push(p);
  }
  return { text: bleiben.length ? bleiben.join('\n') : null, entfernt };
}

/**
 * Vorrede oder Selbstauskunft des Modells statt eines Hinweises — Realfälle 11.10.: „Hier sind die Insights für heute …",
 * „Insights (Handlungsbedarf zuerst …):", „Die drei Vorab-Auffälligkeiten sind:", „Ich habe die Vorab-Analyse … durchgesehen",
 * „Die Systemvorgaben sind umfangreich …", „Hinweis: Die Insight-Tracking-Liste zeigt …", „**Aktionen:**", „**Insights**".
 */
export function istMetaText(text: string): boolean {
  const t = text.replace(/\*\*/g, '').replace(/^[\s#>\-*•]+/, '').trim();
  if (t.length === 0) return true;
  const erste = t.split('\n')[0]!.trim();
  // reine Überschrift: eine Zeile, endet auf Doppelpunkt oder ist nur ein Abschnittswort
  if (!t.includes('\n') && (/:\s*$/.test(erste) && erste.length <= 140)) return true;
  if (/^(insights?|aktionen|actions?|hinweise?|zusammenfassung)\s*:?\s*$/i.test(erste)) return true;
  // Selbstauskunft über die Arbeit statt Inhalt
  if (/^(hier (sind|ist) (die|meine|deine)\b|ich (habe|erstelle|prüfe|nenne|gehe|liste|fasse|beginne)\b|die (system)?vorgaben\b|die (drei |zwei |vier )?vorab-(auffälligkeiten|analyse)\b|die vorab-analyse\b|die lage nach dem ereignis\b|die zustandsänderung betrifft\b|es gibt keine zeile mit\b|keine (neuen )?insights\b|weitere punkte wie\b)/i.test(erste)) return true;
  if (/^hinweis:\s*die insight-tracking-liste\b/i.test(erste)) return true;
  // v1365 — Realfälle 12.10. nach v1360: „Nicht als Insight übernommen: …", „Die Hausbatterie-Meldung … habe ich bewusst
  // weggelassen …", „Insights sind nicht immer leicht … deshalb hier meine Auswertung …:", „Keine Artikel im RSS-Feed passen …"
  if (/^(nicht als insight (übernommen|gemeldet)|insights sind\b|keine\b.{0,60}\b(rss|feeds?|artikel|treffer)\b)/i.test(erste)) return true;
  if (META_SATZ.test(ersterSatz(erste))) return true;
  return false;
}

/** v1365 — Selbstauskunft über Weggelassenes oder die eigene Auswertung, irgendwo im ersten Satz. */
const META_SATZ = /\b(habe ich (bewusst |daher |deshalb )?(weggelassen|ausgelassen|nicht (aufgenommen|gemeldet|übernommen))|lasse (ich )?(diesen punkt|das|sie|ihn) (daher |deshalb )?weg|hier (ist |folgt )?meine auswertung)\b/i;

function ersterSatz(zeile: string): string {
  const m = /^(.+?[.;!?])(\s|$)/.exec(zeile);
  return (m ? m[1]! : zeile).trim();
}

/**
 * v1365 — Leerlauf-Vorsatz vor echtem Inhalt (Realfall 12.10. 08:00: „Keine passenden RSS-Treffer mit klarem Bezug zu deinem
 * Profil in diesem Lauf. (Hinweis: Die Studenten-Demo am 13.10. mit gesperrtem Wiener Ring …)"): den Vorsatz entfernen, den Inhalt
 * behalten. Ohne genug Inhalt danach bleibt der Text unverändert — dann verwirft ihn istMetaText.
 */
export function ohneMetaVorsatz(text: string): string {
  const t = text.trim().replace(/\*\*/g, '').replace(/^[\s#>\-*•]+/, '');
  const satz = ersterSatz(t.split('\n')[0]!);
  if (!istMetaText(satz)) return text;
  const rest = t.slice(satz.length).trim().replace(/^\(\s*(hinweis|aber|jedoch)\s*:\s*/i, '').replace(/\)\s*$/, '').trim();
  return rest.length >= 40 && !istMetaText(rest) ? rest : text;
}

/**
 * Rohe JSON-Antwort statt Text (Realfall 11.10. 19:00: „{ "insights": [ { "type": …, "text": "Anthropic …" } ] }").
 * Ist sie lesbar, werden die Texte gerettet; sonst `[]` (nie rohes JSON zustellen).
 * Rückgabe `null`: kein JSON — der Text bleibt, wie er ist.
 */
export function texteAusJson(text: string): string[] | null {
  const t = text.replace(/```[a-z]*\s*/gi, '').replace(/```/g, '').trim();
  if (!/^[[{]/.test(t)) return null;
  let j: unknown;
  try { j = JSON.parse(t); } catch { return []; }
  const liste = Array.isArray(j) ? j : (j && typeof j === 'object' ? (Object.values(j as Record<string, unknown>).find(Array.isArray) as unknown[] | undefined) ?? [j] : []);
  const out: string[] = [];
  for (const x of liste) {
    if (typeof x === 'string' && x.trim()) { out.push(x.trim()); continue; }
    if (x && typeof x === 'object') {
      const o = x as Record<string, unknown>;
      const s = [o.title, o.titel, o.text, o.summary, o.body, o.message].find(v => typeof v === 'string' && v.trim()) as string | undefined;
      if (s) out.push(s.trim());
    }
  }
  return out;
}
