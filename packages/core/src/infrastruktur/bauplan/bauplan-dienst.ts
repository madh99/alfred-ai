/**
 * Spec Bauplan- und Dokument-Vorlagen §5.5/§5.7/§7b/§8.4 — Dienst der Bauplan-Vorlagen: speichern (voll validiert, neue Version),
 * Owner-Freigabe (Button, nur der Hash der Einmal-Freigabe in der DB, an den Abdruck gebunden), Widerruf, Anwenden.
 *
 * Anwenden erzeugt nie Ausführung ohne Freigabe: es legt normale Changes über den bestehenden Planungsweg an und stellt EINE
 * normale Freigabe-Frage für das ganze Paket. Vor jedem Anwenden läuft die volle Validierung erneut; scheitert sie, wird die
 * Vorlage gesperrt (Status ueberpruefen) und der Owner benachrichtigt.
 */
import { createHash, randomUUID } from 'node:crypto';
import type { BauplanVorlageZeile, BauplanVorlageStatus } from '@alfred/storage';
import { aktionsArt, type Pruefung } from '../change-schritte.js';
import { abdruck, type BauplanChange, type BauplanVorlage } from './schema.js';
import { loeseParameter, setzeEin, setzeEinPruefung } from './parameter.js';
import { pruefeVorlage } from './validierung.js';

export interface BauplanDeps {
  repo: {
    speichere(u: string, d: { key: string; json: string; abdruck: string; abgeleitetAus?: string }): Promise<BauplanVorlageZeile>;
    finde(u: string, key: string, version?: number): Promise<BauplanVorlageZeile | undefined>;
    liste(u: string): Promise<BauplanVorlageZeile[]>;
    setze(u: string, id: string, d: Partial<Pick<BauplanVorlageZeile, 'status' | 'frageHash' | 'frageBis' | 'freigegebenAt' | 'widerrufenAt' | 'grund'>>): Promise<void>;
  };
  instanzen: {
    anlegen(u: string, d: { name: string; dokumentart: 'testprotokoll' | 'betrieb'; changeIds: string[]; parameter?: string; vorlageKey?: string; vorlageVersion?: number }): Promise<{ id: string; name: string }>;
    finde(u: string, name: string): Promise<unknown>;
  };
  /** Probe: Change-Validator ohne Speichern (ChangePlanung.pruefeNur) */
  pruefeNur(u: string, roh: unknown[]): Promise<string[]>;
  /** Normales Change-Paket planen (ChangePlanung.planen) */
  planen(u: string, roh: unknown[]): Promise<{ ok: true; ids: string[] } | { ok: false; fehler: string[] }>;
  /** EINE normale Freigabe-Frage für alle Changes des Pakets (ChangePlanung.freigabeAnfragen) */
  freigabeAnfragen(u: string, ids: string[], zusatz?: string): Promise<{ ok: true; text: string } | { ok: false; fehler: string[] }>;
  /** Lesende Live-Prüfung einer Annahme (Motor.pruefe) */
  pruefe(p: Pruefung): Promise<{ ok: boolean; text: string }>;
  /** Button-Frage an den Owner (Bestätigungs-Queue, skill bauplan) */
  frage(text: string, params: Record<string, unknown>): Promise<boolean | void>;
  melde(u: string, text: string): Promise<void>;
  /** Fix-Runde 1 — nie gestarteten Change verwerfen (ITSM verwerfen → cancelled mit Grund), für den Abbruch nach planen */
  verwerfen(u: string, id: string, grund: string): Promise<void>;
  jetzt?: () => number;
  protokoll?: (msg: string, daten: Record<string, unknown>) => void;
}

const GUELTIG_MS = 24 * 3_600_000;
const hash = (n: string) => createHash('sha256').update(n).digest('hex');
/** Wie dokumente-skill INSTANZ_NAME: Buchstaben, Ziffern, _ . - (≤ 80), nicht nur Punkte */
const INSTANZ_NAME = /^(?!\.+$)[\w.-]{1,80}$/;
/** §7b/§8.4 — Kategorien, die die Freigabe-Frage ausdrücklich nennt */
const NETZ_FIREWALL = /network|zone|firewall|policy/i;
/** Löschungen: Einordnung des Change-Validators (destroy, purge, wipe, prune …) und zusätzlich jedes delete/remove/löschen im Namen */
const LOESCHEN = /delete|loeschen|löschen|remove/i;
const istLoeschung = (skill: string, aktion: string): boolean => aktionsArt(skill, aktion) === 'loeschen' || LOESCHEN.test(aktion);
/** Eindeutigkeit (user_id, name) der Instanzen verletzt — PG 23505 bzw. SQLite UNIQUE constraint */
const EINDEUTIG_VERLETZT = /duplicate key|unique constraint|23505|SQLITE_CONSTRAINT/i;

type Ergebnis<T = object> = ({ ok: true; text: string } & T) | { ok: false; fehler: string[] };

/** Schritt-Aktionen der Kategorien Netz/Firewall/Löschung (auch Rückwege), je einmal */
export function heikleAktionen(changes: BauplanChange[]): string[] {
  const treffer = new Set<string>();
  const pruefe = (skill: unknown, aktion: unknown, zusatz = '') => {
    if (typeof skill !== 'string' || typeof aktion !== 'string') return;
    const sa = `${skill}.${aktion}`;
    if (NETZ_FIREWALL.test(sa) || istLoeschung(skill, aktion)) treffer.add(`${sa}${zusatz}`);
  };
  for (const c of changes) for (const s of c.schritte) {
    pruefe(s.skill, s.aktion);
    const r = s.rueckweg as { skill?: unknown; aktion?: unknown } | undefined;
    if (r && typeof r === 'object') pruefe(r.skill, r.aktion, ' (Rückweg)');
  }
  return [...treffer];
}

const heikleZeile = (changes: BauplanChange[]): string | undefined => {
  const h = heikleAktionen(changes);
  return h.length ? `⚠️ Enthält Netz/Firewall/Löschung: ${h.join(', ')}` : undefined;
};

const STATUS_TEXT: Record<BauplanVorlageStatus, string> = {
  entwurf: 'entwurf (noch nicht freigegeben)',
  angefragt: 'angefragt (Freigabe-Frage offen)',
  freigegeben: 'freigegeben',
  widerrufen: 'widerrufen',
  ueberpruefen: 'ueberpruefen (gesperrt, neue Freigabe nötig)',
};

export class BauplanDienst {
  constructor(readonly d: BauplanDeps) {}
  private jetzt() { return this.d.jetzt?.() ?? Date.now(); }
  private probe(o: string) { return (roh: unknown[]) => this.d.pruefeNur(o, roh); }

  /** Volle Validierung; bei Erfolg neue Version (entwurf). Fehler → nichts gespeichert. */
  async speichern(o: string, roh: unknown, abgeleitetAus?: string): Promise<{ ok: true; zeile: BauplanVorlageZeile; hinweise: string[] } | { ok: false; fehler: string[] }> {
    const r = await pruefeVorlage(roh, { probe: this.probe(o) });
    if (!r.vorlage) return { ok: false, fehler: r.fehler.length ? r.fehler : ['Vorlage ungültig'] };
    const v = r.vorlage;
    const zeile = await this.d.repo.speichere(o, { key: v.key, json: JSON.stringify(v), abdruck: abdruck(v), ...(abgeleitetAus ? { abgeleitetAus } : {}) });
    this.d.protokoll?.('V3 Bauplan-Vorlage gespeichert', { key: v.key, version: zeile.version, abdruck: zeile.abdruck });
    return { ok: true, zeile, hinweise: r.hinweise };
  }

  /** Gespeicherte Version erneut voll prüfen: JSON lesbar, Validierung inkl. Probe, Abdruck unverändert. */
  private async revalidiere(o: string, z: BauplanVorlageZeile): Promise<{ vorlage: BauplanVorlage } | { fehler: string[] }> {
    let roh: unknown;
    try { roh = JSON.parse(z.json); } catch { return { fehler: ['gespeichertes JSON ist nicht lesbar'] }; }
    const r = await pruefeVorlage(roh, { probe: this.probe(o) });
    if (!r.vorlage) return { fehler: r.fehler.length ? r.fehler : ['Vorlage ungültig'] };
    if (abdruck(r.vorlage) !== z.abdruck) return { fehler: ['Abdruck des gespeicherten JSON passt nicht zum gespeicherten Abdruck'] };
    return { vorlage: r.vorlage };
  }

  private async freigegebeneVersion(o: string, key: string): Promise<BauplanVorlageZeile | undefined> {
    return (await this.d.repo.liste(o)).filter(z => z.key === key && z.status === 'freigegeben').sort((a, b) => b.version - a.version)[0];
  }

  /** Freigabe-Frage für die höchste Version (Button; in der DB nur der Hash der Einmal-Freigabe, 24 h gültig). */
  async freigabeAnfragen(o: string, key: string): Promise<Ergebnis> {
    const z = await this.d.repo.finde(o, key);
    if (!z) return { ok: false, fehler: [`Bauplan-Vorlage „${key}“ gibt es nicht`] };
    if (z.status === 'freigegeben') return { ok: false, fehler: [`${key} Version ${z.version} ist schon freigegeben`] };
    const g = await this.revalidiere(o, z);
    if ('fehler' in g) return { ok: false, fehler: [`${key} Version ${z.version} besteht die Prüfung nicht — erst korrigiert als neue Version speichern: ${g.fehler.slice(0, 8).join('; ')}`] };
    const v = g.vorlage;
    const nonce = randomUUID();
    await this.d.repo.setze(o, z.id, { status: 'angefragt', frageHash: hash(nonce), frageBis: new Date(this.jetzt() + GUELTIG_MS).toISOString() });
    const zeilen = [
      `📐 Bauplan-Vorlage freigeben: ${v.titel} (${v.key} v${z.version})`,
      '',
      `Zweck: ${v.zweck}`,
      `Dokumentart: ${v.dokumentart}`,
      `Parameter:${v.parameter.length ? '' : ' keine'}`,
      ...v.parameter.map(p => `- ${p.name} (${p.typ}, ${p.pflicht ? 'Pflicht' : 'optional'}${p.ableitung ? `, abgeleitet: ${p.ableitung.funktion} von ${p.ableitung.von}` : ''}) — ${p.beschreibung}`),
      ...(v.annahmen.length ? ['Eingangskontrolle (vor dem Anlegen und als erster Schritt):', ...v.annahmen.map(a => `- ${a.text}`)] : []),
      'Changes:',
      ...v.changes.map(c => `- ${c.schluessel}: ${c.titel} — ${c.schritte.length} Schritte, Risiko ${c.risiko}${c.abhaengigVon.length ? `, nach ${c.abhaengigVon.join(', ')}` : ''}`),
      ...[heikleZeile(v.changes)].filter((x): x is string => !!x),
      `Abdruck: ${z.abdruck.slice(0, 12)}`,
      '',
      `Angewendet wird nur auf ausdrücklichen Auftrag; jede Anwendung braucht die normale Change-Freigabe. Jede Änderung der Vorlage ist eine neue Version mit neuer Freigabe. Widerruf jederzeit („Bauplan ${v.key} widerrufen“).`,
    ];
    const ok = await this.d.frage(zeilen.join('\n'), { action: 'bauplan_freigeben', key: v.key, version: z.version, freigabe: nonce });
    this.d.protokoll?.('V3 Bauplan-Vorlage Freigabe angefragt', { key, version: z.version, frage: ok !== false });
    if (ok === false) return { ok: false, fehler: ['Freigabe-Frage konnte nicht gestellt werden'] };
    return { ok: true, text: `Freigabe-Frage zu ${v.titel} (${key} v${z.version}) gestellt — der Owner bestätigt in der App oder in Telegram.` };
  }

  /** Nach dem Owner-Ja: Status angefragt, Hash, Ablauf, Abdruck unverändert, neueste Version → freigegeben (einmal verwendbar). */
  async freigebenNachJa(o: string, key: string, version: number, nonce: unknown): Promise<{ ok: boolean; text: string }> {
    const keine = { ok: false, text: 'Keine gültige Freigabe — Bauplan-Vorlagen gibt nur der Owner über die Freigabe-Frage frei.' };
    if (typeof nonce !== 'string' || !nonce || !Number.isInteger(version)) return keine;
    const z = await this.d.repo.finde(o, key, version);
    if (!z || z.status !== 'angefragt' || z.frageHash !== hash(nonce) || !z.frageBis || Date.parse(z.frageBis) < this.jetzt()) return keine;
    const neueste = await this.d.repo.finde(o, key);
    if (!neueste || neueste.version !== z.version) return { ok: false, text: `Version ${z.version} ist nicht mehr die neueste (${neueste?.version}) — Freigabe der neuen Version anfragen.` };
    let stimmt = false;
    try { stimmt = abdruck(JSON.parse(z.json) as BauplanVorlage) === z.abdruck; } catch { stimmt = false; }
    if (!stimmt) return { ok: false, text: 'Vorlage seit der Frage verändert (Abdruck passt nicht) — nicht freigegeben.' };
    await this.d.repo.setze(o, z.id, { status: 'freigegeben', frageHash: '', frageBis: '', freigegebenAt: new Date(this.jetzt()).toISOString(), grund: '' });
    this.d.protokoll?.('V3 Bauplan-Vorlage freigegeben', { key, version: z.version, abdruck: z.abdruck });
    return { ok: true, text: `Bauplan-Vorlage ${key} v${z.version} ist freigegeben (Abdruck ${z.abdruck.slice(0, 12)}).` };
  }

  async widerrufen(o: string, key: string): Promise<Ergebnis> {
    const z = await this.freigegebeneVersion(o, key);
    if (!z) return { ok: false, fehler: [`Keine freigegebene Version von „${key}“`] };
    await this.d.repo.setze(o, z.id, { status: 'widerrufen', widerrufenAt: new Date(this.jetzt()).toISOString() });
    this.d.protokoll?.('V3 Bauplan-Vorlage widerrufen', { key, version: z.version });
    return { ok: true, text: `Bauplan-Vorlage ${key} v${z.version} widerrufen — sie lässt sich nicht mehr anwenden.` };
  }

  /** Höchste Version muss freigegeben sein; Text nennt sonst Status und ggf. die ältere freigegebene Version. */
  private async anwendbar(o: string, key: string): Promise<{ z: BauplanVorlageZeile } | { fehler: string }> {
    const z = await this.d.repo.finde(o, key);
    if (!z) return { fehler: `Bauplan-Vorlage „${key}“ gibt es nicht` };
    if (z.status === 'freigegeben') return { z };
    const frei = await this.freigegebeneVersion(o, key);
    const aelter = frei && frei.version !== z.version ? ` Version ${frei.version} ist freigegeben, gilt aber nicht mehr, weil Version ${z.version} die neueste ist.` : '';
    return { fehler: `${key}: neueste Version ${z.version} hat Status ${STATUS_TEXT[z.status] ?? z.status} — anwenden geht nur mit der freigegebenen neuesten Version (bauplan_freigabe_anfragen).${aelter}` };
  }

  /**
   * Anwenden (§5.7): freigegeben → volle Validierung erneut → Parameter → Annahmen live → einsetzen, Annahmen als erste Schritte
   * (Verweise verschoben) → normale Changes planen → Instanz → EINE Freigabe-Frage. Bis zum Planen entsteht bei jedem Fehler nichts.
   */
  async anwenden(o: string, key: string, eingabe: Record<string, unknown>, instanzName: string): Promise<Ergebnis<{ ids: string[]; instanzId?: string }>> {
    const name = instanzName.trim();
    if (!INSTANZ_NAME.test(name)) return { ok: false, fehler: ['instanz: nur Buchstaben, Ziffern, _ . - (höchstens 80 Zeichen)'] };
    if (/^(change|serie)-/i.test(name)) return { ok: false, fehler: ['instanz: darf nicht mit change- oder serie- beginnen (Ordner der Abnahmeprotokolle)'] };
    if (await this.d.instanzen.finde(o, name)) return { ok: false, fehler: [`Bauplan-Instanz „${name}“ gibt es schon — anderen Namen wählen`] };

    const a = await this.anwendbar(o, key);
    if ('fehler' in a) return { ok: false, fehler: [a.fehler] };
    const z = a.z;

    const g = await this.revalidiere(o, z);
    if ('fehler' in g) {
      const grund = g.fehler.slice(0, 10).join('; ').slice(0, 2000);
      await this.d.repo.setze(o, z.id, { status: 'ueberpruefen', grund });
      this.d.protokoll?.('V3 Bauplan-Vorlage gesperrt', { key, version: z.version, grund });
      await this.d.melde(o, `📐 Bauplan-Vorlage ${key} v${z.version} gesperrt (überprüfen): die erneute Prüfung beim Anwenden scheitert — ${grund}. Es wurden keine Changes angelegt. Erst korrigieren (neue Version) und neu freigeben.`).catch(() => undefined);
      return { ok: false, fehler: [`${key} v${z.version} besteht die erneute Prüfung nicht — Status ueberpruefen, keine Changes: ${grund}`] };
    }
    const v = g.vorlage;

    const p = loeseParameter(v, eingabe);
    if (p.fehler.length) return { ok: false, fehler: p.fehler };
    const werte = p.werte;

    // Annahmen live (Platzhalter {{param.*}} vorher eingesetzt)
    const annahmen: Array<{ text: string; pruefung: Pruefung }> = [];
    try { for (const an of v.annahmen) annahmen.push({ text: an.text, pruefung: setzeEinPruefung(an.pruefung, werte) }); }
    catch (e) { return { ok: false, fehler: [(e as Error).message] }; }
    const abw: string[] = [];
    for (const an of annahmen) {
      const r = await this.d.pruefe(an.pruefung).catch((err: Error) => ({ ok: false, text: err.message }));
      if (!r.ok) abw.push(`${an.text}: ${String(r.text).slice(0, 160)}`);
    }
    if (abw.length) {
      this.d.protokoll?.('V3 Bauplan Eingangskontrolle abweichend', { key, version: z.version, abweichungen: abw });
      return { ok: false, fehler: [`Eingangskontrolle weicht ab — keine Changes angelegt: ${abw.join('; ')}`] };
    }

    let eingesetzt: BauplanChange[];
    try { eingesetzt = setzeEin(v, werte); } catch (e) { return { ok: false, fehler: [(e as Error).message] }; }
    const plaene = baueplaene(eingesetzt, annahmen, `Bauplan ${key} v${z.version} (${name}): `);

    const r = await this.d.planen(o, plaene);
    if (!r.ok) return { ok: false, fehler: r.fehler };
    // Fix-Runde 1 — kein halber Stand: scheitert Instanz oder Freigabe-Frage, werden alle eben angelegten Changes verworfen
    let instanzId: string | undefined;
    try {
      const i = await this.d.instanzen.anlegen(o, { name, dokumentart: v.dokumentart, changeIds: r.ids, vorlageKey: key, vorlageVersion: z.version, parameter: JSON.stringify(werte) });
      instanzId = i.id;
    } catch (e) {
      const m = (e as Error).message;
      return this.abbrechen(o, key, z.version, r.ids, EINDEUTIG_VERLETZT.test(m) ? `Instanzname schon vergeben („${name}“)` : `Instanz nicht angelegt: ${m}`);
    }
    const zusatz = [`📐 Bauplan ${key} v${z.version}, Instanz ${name}`, ...[heikleZeile(eingesetzt)].filter((x): x is string => !!x), ...wertVerweise(plaene)].join('\n');
    const f = await this.d.freigabeAnfragen(o, r.ids, zusatz).catch((e: Error) => ({ ok: false as const, fehler: [e.message] }));
    if (!f.ok) return this.abbrechen(o, key, z.version, r.ids, `Freigabe-Frage nicht gestellt: ${f.fehler.join('; ')}`, instanzId);
    this.d.protokoll?.('V3 Bauplan angewendet', { key, version: z.version, instanz: name, ids: r.ids });
    const kopf = `Bauplan ${key} v${z.version} angewendet: ${r.ids.length} Changes (${r.ids.map(x => x.slice(0, 8)).join(', ')}), Instanz „${name}“.`;
    return { ok: true, ids: r.ids, ...(instanzId ? { instanzId } : {}), text: `${kopf} ${f.text}` };
  }

  /** Nach planen gescheitert: alle neuen Changes verwerfen (cancelled mit Grund), Owner melden, ok:false mit Grund und IDs. */
  private async abbrechen(o: string, key: string, version: number, ids: string[], grund: string, instanzId?: string): Promise<{ ok: false; fehler: string[] }> {
    const nicht: string[] = [];
    for (const id of ids) await this.d.verwerfen(o, id, `Bauplan-Anwendung abgebrochen: ${grund}`).catch((e: Error) => { nicht.push(`${id.slice(0, 8)} (${e.message})`); });
    const kurz = ids.map(x => x.slice(0, 8)).join(', ');
    this.d.protokoll?.('V3 Bauplan-Anwendung abgebrochen', { key, version, grund, ids, nichtVerworfen: nicht, instanzId });
    const text = `Bauplan ${key} v${version}: Anwendung abgebrochen — ${grund}. Verworfen: ${kurz}${nicht.length ? `; NICHT verworfen: ${nicht.join(', ')}` : ''}${instanzId ? ` (Instanz ${instanzId} bleibt ohne laufende Changes stehen)` : ''}.`;
    await this.d.melde(o, `📐 ${text}`).catch(() => undefined);
    return { ok: false, fehler: [text] };
  }

  /** Übersicht: je Key neueste Version mit Status, ggf. ältere freigegebene. */
  async liste(o: string): Promise<Array<{ key: string; titel: string; version: number; status: BauplanVorlageStatus; freigegebeneVersion?: number }>> {
    const alle = await this.d.repo.liste(o);
    const keys = [...new Set(alle.map(z => z.key))].sort();
    return keys.map(k => {
      const l = alle.filter(z => z.key === k).sort((a, b) => b.version - a.version);
      const n = l[0]!;
      const frei = l.find(z => z.status === 'freigegeben');
      let titel = k;
      try { titel = String((JSON.parse(n.json) as { titel?: unknown }).titel ?? k); } catch { /* bleibt key */ }
      return { key: k, titel, version: n.version, status: n.status, ...(frei && frei.version !== n.version ? { freigegebeneVersion: frei.version } : {}) };
    });
  }

  zeigen(o: string, key: string, version?: number): Promise<BauplanVorlageZeile | undefined> { return this.d.repo.finde(o, key, version); }
}

/** Plan-Form wie die Probe, Annahmen als erste Schritte des ersten Change ohne abhaengigVon, Verweise verschoben, kapitel entfernt. */
function baueplaene(changes: BauplanChange[], annahmen: Array<{ text: string; pruefung: Pruefung }>, praefix: string): Array<Record<string, unknown>> {
  const n = annahmen.length;
  // Fix-Runde 1 (I-2) — Eingangskontrolle nur am ERSTEN Change ohne Abhängigkeit (Vorlagen-Reihenfolge)
  const erster = changes.find(c => c.abhaengigVon.length === 0)?.schluessel;
  return changes.map(c => {
    let schritte: Array<Record<string, unknown>> = c.schritte.map(s => { const { kapitel: _k, ...rest } = s; return rest; });
    if (n && erster) {
      let json = JSON.stringify(schritte);
      if (c.schluessel === erster) json = json.replace(/\{\{(\s*)schritt(\d+)\./g, (_m, ws: string, z: string) => `{{${ws}schritt${Number(z) + n}.`);
      else json = json.replace(new RegExp(`\\{\\{(\\s*)change:${erster}\\.schritt(\\d+)\\.`, 'g'), (_m, ws: string, z: string) => `{{${ws}change:${erster}.schritt${Number(z) + n}.`);
      schritte = JSON.parse(json) as Array<Record<string, unknown>>;
      if (c.schluessel === erster) {
        schritte = [...annahmen.map(a => ({ titel: `Eingangskontrolle: ${a.text}`, art: 'pruefung', pruefung: a.pruefung, beiFehler: 'anhalten' })), ...schritte];
        schritte = schritte.map((s, i) => ({ ...s, nr: i + 1 }));
      }
    }
    return {
      schluessel: c.schluessel, titel: c.titel, begruendung: `${praefix}${c.begruendung}`, typ: c.typ, risiko: c.risiko,
      ...(c.ausfallMinuten !== undefined ? { ausfallMinuten: c.ausfallMinuten } : {}),
      ...(c.ohneSicherungGrund !== undefined ? { ohneSicherungGrund: c.ohneSicherungGrund } : {}),
      ...(c.zweck !== undefined ? { zweck: c.zweck } : {}),
      abhaengigVon: [...c.abhaengigVon], betroffen: [...(c.betroffen ?? [])],
      schritte,
    };
  });
}

/** M-2/N-3 — jeder Wert über Change-Grenzen sichtbar: „Wert <feld> aus Change <schluessel> Schritt N (<skill>.<aktion>)“ */
function wertVerweise(plaene: Array<Record<string, unknown>>): string[] {
  const zeilen = new Set<string>();
  const schritteVon = new Map(plaene.map(p => [String(p.schluessel), p.schritte as Array<Record<string, unknown>>]));
  for (const m of JSON.stringify(plaene.map(p => p.schritte)).matchAll(/\{\{\s*change:([a-z][a-z0-9_]{0,20})\.schritt(\d+)\.([a-zA-Z_][\w.]*)\s*\}\}/g)) {
    const s = schritteVon.get(m[1]!)?.[Number(m[2]) - 1];
    const sa = s && typeof s.skill === 'string' ? `${s.skill}.${String(s.aktion ?? '?')}` : String(s?.art ?? '?');
    zeilen.add(`Wert ${m[3]} aus Change ${m[1]} Schritt ${m[2]} (${sa})`);
  }
  return zeilen.size ? ['Werte über Change-Grenzen:', ...[...zeilen].map(z => `- ${z}`)] : [];
}
