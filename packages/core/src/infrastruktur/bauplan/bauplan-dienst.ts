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
import type { CmdbChangeRequest } from '@alfred/types';
import { aktionsArt, type Pruefung } from '../change-schritte.js';
import { planAusChange } from '../change-planung.js';
import type { ChangeLauf } from '../change-lauf.js';
import { findeChange, type DokuQuellen } from '../dokumente/sammler.js';
import {
  baueEntwurf, findeEntscheidungen, findeKandidaten, findeVerweise, standVon,
  type AuswahlEintrag, type Entscheid, type Entscheidungspunkt, type ErsetztesWort, type FestEintrag, type SammelEintrag, type Fundstelle, type Kandidat, type QuellChange, type Verweis,
} from './ableiten.js';
import { abdruck, GRENZEN, type BauplanChange, type BauplanVorlage } from './schema.js';
import { loeseParameter, setzeEin, setzeEinPruefung } from './parameter.js';
import { pruefeVorlage } from './validierung.js';

export interface BauplanDeps {
  repo: {
    speichere(u: string, d: { key: string; json: string; abdruck: string; abgeleitetAus?: string; ableitung?: string }): Promise<BauplanVorlageZeile>;
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
  /** V4 — gespeicherte Changes für das Ableiten (ITSM-Liste wie bei den Dokument-Vorlagen; findeChange: ID oder eindeutiger Anfang) */
  ableitenQuellen?: Pick<DokuQuellen, 'changes'>;
  /** V4 — CMDB-Name eines betroffenen Assets (für die betroffen-Bereinigung des Entwurfs) */
  assetName?: (u: string, id: string) => Promise<string | undefined>;
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
  async speichern(o: string, roh: unknown, abgeleitetAus?: string, ableitung?: string): Promise<{ ok: true; zeile: BauplanVorlageZeile; hinweise: string[] } | { ok: false; fehler: string[] }> {
    const r = await pruefeVorlage(roh, { probe: this.probe(o) });
    if (!r.vorlage) return { ok: false, fehler: r.fehler.length ? r.fehler : ['Vorlage ungültig'] };
    const v = r.vorlage;
    const zeile = await this.d.repo.speichere(o, { key: v.key, json: JSON.stringify(v), abdruck: abdruck(v), ...(abgeleitetAus ? { abgeleitetAus } : {}), ...(ableitung ? { ableitung } : {}) });
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
      ...reihenfolgeZeilen(v.changes, v.annahmen.length),
      ...[heikleZeile(v.changes)].filter((x): x is string => !!x),
      ...ableitungZeilen(z.ableitung, z.abgeleitetAus),
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
    const zusatz = [
      `📐 Bauplan ${key} v${z.version}, Instanz ${name}`,
      ...schrittZeilen(plaene, annahmen.length, ersteWurzel(eingesetzt)),
      ...reihenfolgeZeilen(eingesetzt, annahmen.length),
      ...[heikleZeile(eingesetzt)].filter((x): x is string => !!x),
      ...wertVerweise(plaene),
    ].join('\n');
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

  /**
   * V4 (§5.6) — gewählte Changes laden: ID oder eindeutiger Anfang, nur completed mit Lauf, höchstens GRENZEN.changes; Reihenfolge nach
   * abhaengigVon (gleichrangig nach Anlage, dann ID — unabhängig von der Eingabe-Reihenfolge, damit Kandidaten-Nummern stabil bleiben);
   * Vorgänger außerhalb der Auswahl oder Zyklus → Fehler. Schlüssel c1…cn in dieser Reihenfolge.
   */
  private async ladeQuellen(o: string, refs: unknown): Promise<{ ok: true; q: QuellChange[] } | { ok: false; fehler: string[] }> {
    const quelle = this.d.ableitenQuellen;
    const assetName = this.d.assetName;
    if (!quelle || !assetName) return { ok: false, fehler: ['Ableiten nicht verfügbar: keine Change-Quelle verdrahtet'] };
    const liste = (Array.isArray(refs) ? refs : []).filter((x): x is string => typeof x === 'string').map(x => x.trim()).filter(Boolean);
    if (!liste.length) return { ok: false, fehler: ['changes: mindestens eine Change-ID (oder ihren eindeutigen Anfang) angeben'] };
    if (liste.length > GRENZEN.changes) return { ok: false, fehler: [`changes: höchstens ${GRENZEN.changes} Changes je Ableitung (erhalten ${liste.length})`] };
    const fehler: string[] = [];
    const gefunden: CmdbChangeRequest[] = [];
    // M3 — die Change-Liste nur einmal je Ableitung laden (findeChange fragt sonst je Eintrag neu)
    let geladen: ReturnType<typeof quelle.changes> | undefined;
    const einmal: Pick<DokuQuellen, 'changes'> = { changes: (u) => (geladen ??= quelle.changes(u)) };
    for (const ref of liste) {
      const c = await findeChange(einmal, o, ref);
      if (typeof c === 'string') { fehler.push(c); continue; }
      const wer = `Change ${c.id} („${c.title.slice(0, 80)}“)`;
      if (gefunden.some(g => g.id === c.id)) { fehler.push(`${wer} ist doppelt angegeben („${ref}“)`); continue; }
      if (c.status !== 'completed') fehler.push(`${wer}: Status ${c.status} — ableiten nur aus abgeschlossenen (completed) Changes`);
      const lauf = c.lauf as ChangeLauf | undefined;
      if (!lauf || !Array.isArray(lauf.ergebnisse)) fehler.push(`${wer}: ohne Lauf — ableiten nur aus ausgeführten Changes`);
      gefunden.push(c);
    }
    if (fehler.length) return { ok: false, fehler };
    const ids = new Set(gefunden.map(c => c.id));
    for (const c of gefunden) for (const a of c.abhaengigVon ?? [])
      if (!ids.has(a)) fehler.push(`Change ${c.id} („${c.title.slice(0, 80)}“): Vorgänger ${a} liegt nicht in der Auswahl — mitwählen oder diesen Change weglassen`);
    if (fehler.length) return { ok: false, fehler };
    const sortiert: CmdbChangeRequest[] = [];
    const fertig = new Set<string>();
    const rest = [...gefunden];
    while (rest.length) {
      const bereit = rest.filter(c => (c.abhaengigVon ?? []).every(a => fertig.has(a)))
        .sort((a, b) => String(a.createdAt ?? '').localeCompare(String(b.createdAt ?? '')) || a.id.localeCompare(b.id));
      if (!bereit.length) return { ok: false, fehler: [`Zyklus in abhaengigVon zwischen ${rest.map(c => c.id).join(', ')} — so nicht ableitbar`] };
      const n = bereit[0]!;
      sortiert.push(n); fertig.add(n.id); rest.splice(rest.indexOf(n), 1);
    }
    const q: QuellChange[] = [];
    for (const [i, c] of sortiert.entries()) {
      const betroffenNamen: Record<string, string> = {};
      for (const a of c.affectedAssetIds ?? []) {
        // M2 — Lesefehler nie still übergehen: ohne Namen fiele die betroffen-Bereinigung unbemerkt aus
        let n: string | undefined;
        try { n = await assetName(o, a); } catch (e) { fehler.push(`Asset ${a}: Name nicht lesbar (${(e as Error).message}) — betroffen von Change ${c.id} nicht prüfbar`); continue; }
        if (n) betroffenNamen[a] = n;
      }
      // nur nr/ok/daten — Ausgaben, Fehlertexte und Prüfungsausgaben gehören nicht in die Ableitung
      const ergebnisse = (c.lauf as ChangeLauf).ergebnisse.map(e => ({
        nr: e.nr, ok: e.ok === true, ...(e.daten && typeof e.daten === 'object' && !Array.isArray(e.daten) ? { daten: e.daten as Record<string, unknown> } : {}),
      }));
      q.push({ id: c.id, schluessel: `c${i + 1}`, plan: planAusChange(c), ergebnisse, betroffenNamen });
    }
    if (fehler.length) return { ok: false, fehler };
    return { ok: true, q };
  }

  /**
   * V4 — Vorschlag (nur lesend): Kandidaten mit allen Fundstellen, Entscheidungspunkte (Teilvorkommen, feste IDs, angelegte Werte)
   * mit ids, Verweise, Hinweise und der Stand (I3), an den erzeugen gebunden ist. Speichert nichts.
   */
  async ableitenVorschlag(o: string, changeRefs: string[]): Promise<{ ok: true; text: string; stand: string; kandidaten: Kandidat[]; verweise: Verweis[]; entscheidungen: Entscheidungspunkt[]; hinweise: string[] } | { ok: false; fehler: string[] }> {
    const l = await this.ladeQuellen(o, changeRefs);
    if (!l.ok) return l;
    const kandidaten = findeKandidaten(l.q);
    const v = findeVerweise(l.q);
    const entscheidungen = findeEntscheidungen(l.q);
    const stand = standVon(l.q);
    const hinweise = [...v.hinweise, ...kandidatenHinweise(kandidaten)];
    this.d.protokoll?.('V4 Bauplan-Ableitung Vorschlag', { changes: l.q.map(c => c.id), kandidaten: kandidaten.length, verweise: v.verweise.length, entscheidungen: entscheidungen.length, stand });
    return { ok: true, text: vorschlagText(l.q, kandidaten, v.verweise, entscheidungen, hinweise, stand), stand, kandidaten, verweise: v.verweise, entscheidungen, hinweise };
  }

  /**
   * V4 — Entwurf erzeugen: Auswahl (Kandidaten-Nr → Parametername oder {name, wert}), Entscheidungen (id → ersetzen|fest) und der
   * Stand aus dem Vorschlag (I3: weicht er ab, haben sich Changes oder Nummern verschoben → Fehler) → baueEntwurf → speichern (volle
   * V3-Validierung inkl. Probe, Status entwurf, abgeleitetAus = volle IDs, ableitung = bewusst feste Stellen für die Freigabe-Frage).
   * Jeder Fehler kommt unverändert zurück; dann ist nichts gespeichert.
   */
  async ableitenErzeugen(
    o: string, changeRefs: string[], auswahl: Record<string, AuswahlEintrag>,
    kopf: { key: string; titel: string; zweck: string; dokumentart: 'testprotokoll' | 'betrieb' }, entscheid: Entscheid = {}, stand?: string,
  ): Promise<{ ok: true; text: string } | { ok: false; fehler: string[] }> {
    if (!auswahl || typeof auswahl !== 'object' || !Object.keys(auswahl).length) return { ok: false, fehler: ['auswahl: mindestens einen Kandidaten wählen (Nr → Parametername)'] };
    if (typeof stand !== 'string' || !stand.trim()) return { ok: false, fehler: ['stand: den Stand aus dem Vorschlag angeben (bauplan_ableiten modus vorschlag) — er bindet Kandidaten-Nummern und Entscheidungs-ids'] };
    const l = await this.ladeQuellen(o, changeRefs);
    if (!l.ok) return l;
    const aktuell = standVon(l.q);
    if (stand.trim() !== aktuell) return { ok: false, fehler: [`Stand ${stand.trim()} passt nicht zum aktuellen Stand ${aktuell} — Changes, Kandidaten oder Entscheidungspunkte haben sich seit dem Vorschlag geändert: Vorschlag neu holen`] };
    const e = baueEntwurf(l.q, auswahl, kopf, entscheid);
    if (!e.vorlage) return { ok: false, fehler: e.fehler.length ? e.fehler : ['Entwurf ungültig'] };
    const abgeleitetAus = l.q.map(c => c.id).join(',');
    // M5 — vorhandener Key: die neue Version ersetzt nach ihrer Freigabe die bisherige
    const vorher = await this.d.repo.finde(o, kopf.key);
    const frei = vorher ? await this.freigegebeneVersion(o, kopf.key) : undefined;
    const ersetzt = !vorher ? undefined : frei
      ? `neue Version von ${kopf.key}, ersetzt nach Freigabe v${frei.version} (freigegeben)${frei.version !== vorher.version ? `; neueste bisher v${vorher.version} (${vorher.status})` : ''}`
      : `neue Version von ${kopf.key}, ersetzt nach Freigabe v${vorher.version} (${vorher.status}, nicht freigegeben)`;
    const ableitung: AbleitungInfo = {
      quellen: l.q.map(c => c.id), fest: e.fest,
      hinweise: e.hinweise.filter(h => !h.startsWith('bewusst fest') && !h.startsWith('keine automatische Vorab-Kontrolle')),
      ohneAnnahme: e.ohneAnnahme, ...(ersetzt ? { ersetzt } : {}), ...(e.sammel.length ? { sammel: e.sammel } : {}), ...(e.ersetzt.length ? { woerter: e.ersetzt } : {}),
    };
    const s = await this.speichern(o, e.vorlage, abgeleitetAus, JSON.stringify(ableitung));
    if (!s.ok) return s;
    const v = e.vorlage;
    this.d.protokoll?.('V4 Bauplan-Entwurf abgeleitet', { key: v.key, version: s.zeile.version, abdruck: s.zeile.abdruck, abgeleitetAus, fest: e.fest.length, stand });
    const hinweise = [...e.hinweise, ...s.hinweise];
    const zeilen = [
      `✅ Bauplan-Entwurf ${v.key} v${s.zeile.version} gespeichert — Status ${s.zeile.status}, Abdruck ${s.zeile.abdruck.slice(0, 12)}`,
      ...(ersetzt ? [`ℹ️ ${ersetzt}`] : []),
      `Abgeleitet aus: ${l.q.map(c => `${c.schluessel} = ${kurzId(c.id)}`).join(', ')}`,
      `Parameter:`,
      ...v.parameter.map(p => `- ${p.name} (${p.typ}${p.ableitung ? `, abgeleitet: ${p.ableitung.funktion}${p.ableitung.n !== undefined ? ` ${p.ableitung.n}` : ''} von ${p.ableitung.von}` : ''}, Beispiel ${String(p.beispiel ?? '–')}) — ${p.beschreibung}`),
      ...(e.ersetzt.length ? ['Ersetzte Teilvorkommen:', ...e.ersetzt.map(w => `- ${w.wort} → ${w.nach} (${w.anzahl} Stelle${w.anzahl === 1 ? '' : 'n'})`)] : []),
      ...(e.fest.length ? [`Bewusst fest: ${e.fest.length} Stelle${e.fest.length === 1 ? '' : 'n'} (stehen in der Freigabe-Frage)`] : []),
      ...(v.annahmen.length ? ['Eingangskontrolle (automatisch erzeugt):', ...v.annahmen.map(a => `- ${a.id}: ${a.text}`)] : ['Eingangskontrolle: keine automatisch erzeugt']),
      ...(hinweise.length ? ['Hinweise:', ...hinweise.map(h => `- ${h}`)] : []),
      '',
      `Freigabe nur über bauplan_freigabe_anfragen (key ${v.key}); angewendet wird erst danach auf ausdrücklichen Auftrag.`,
    ];
    return { ok: true, text: zeilen.join('\n') };
  }
}

const kurzId = (id: string) => id.slice(0, 8);
const ortText = (f: Fundstelle) => (f.schritt === 0 ? `${kurzId(f.change)} Titel` : `${kurzId(f.change)} S${f.schritt} ${f.pfad}`);
const zelle = (x: unknown) => String(x).replace(/\|/g, '\\|');

/**
 * V4 — Hinweise zur Auswahl: gleicher Wert in mehreren Kandidaten (pve als zugang und node → auf denselben Parameter legen; M-b);
 * Rechnername und FQDN sind getrennte Kandidaten (labsrv01 / labsrv01.pkilab.test → beide wählen oder beide fest).
 */
export function kandidatenHinweise(k: Kandidat[]): string[] {
  const h: string[] = [];
  const nachWert = new Map<string, Kandidat[]>();
  for (const c of k) { const l = nachWert.get(String(c.wert)) ?? []; l.push(c); nachWert.set(String(c.wert), l); }
  for (const [w, l] of nachWert) if (l.length > 1) h.push(`gleicher Wert ${w} in mehreren Kandidaten (${l.map(c => `#${c.nr} ${c.typ}`).join(', ')}) — auf denselben Parameter legen oder Stellen fest`);
  const namen = k.filter(c => c.typ === 'name');
  for (const n of namen) {
    const w = String(n.wert).toLowerCase();
    if (w.includes('.')) continue;
    for (const f of namen) {
      const fw = String(f.wert);
      if (fw.includes('.') && fw.split('.')[0]!.toLowerCase() === w) h.push(`${String(n.wert)} und ${fw} getrennt — beide wählen oder beide fest (Kandidaten ${n.nr} und ${f.nr})`);
    }
  }
  return h;
}

/**
 * Kurzfassung der Entscheidungen ganz oben im Vorschlag (die Ausgabe wird beim Modell gekürzt): Sammel-Schlüssel je Kategorie
 * mit Anzahl, Teilvorkommen je Kandidaten-Wert, Aufruf mit stand. Einzelheiten je id folgen weiter unten.
 */
function entscheidungenKurz(k: Kandidat[], punkte: Entscheidungspunkt[], stand: string): string[] {
  const z = ['Entscheidungen kurz — Sammel-Schlüssel in entscheid (einzelne ids gehen vor; alle übrigen offenen Punkte fest: {"fest:*": "fest"}):'];
  // Teilvorkommen je Wort: teil:wort|<wert>|<wort> (ersetzen|fest); teil:wert|<wert> nur „fest“ (pve als node und Name: ein Schlüssel deckt beide)
  const jeWort = new Map<string, number>();
  for (const c of k) for (const t of c.teilvorkommen) if (!t.tresor) { const key = `teil:wort|${String(c.wert)}|${t.token}`; jeWort.set(key, (jeWort.get(key) ?? 0) + 1); }
  const teil = [...jeWort].map(([key, n]) => `${key} (${n})`);
  if (teil.length) z.push(`- Teilvorkommen gewählter Kandidaten — „ersetzen“ nur je Wort (teil:wort|<wert>|<wort>), „fest“ auch für alle Wörter eines Werts (teil:wert|<wert>): ${teil.slice(0, 25).join(', ')}${teil.length > 25 ? `, … (+${teil.length - 25}, Einzelheiten unten)` : ''}`);
  const zahl = (f: (p: Entscheidungspunkt) => boolean) => punkte.filter(f).length;
  z.push(`- anlage:* = „fest“ — ${zahl(p => p.art === 'anlage' && p.netz === undefined)} vom Paket angelegte Werte (gewählte entfallen; Adressen in Netz-Kandidaten: ${zahl(p => p.art === 'anlage' && p.netz !== undefined)})`);
  z.push(`- veraendert:* = „fest“ — ${zahl(p => p.art === 'veraendert')} veränderte vorhandene Objekte`);
  z.push(`- tresor:* = „fest“ — ${zahl(p => p.art === 'tresor')} bestehende Tresor-Einträge`);
  z.push(`- fest:* = „fest“ — alle übrigen offenen Punkte, auch ${zahl(p => p.art === 'id')} feste IDs`);
  z.push(`Aufruf: bauplan_ableiten modus erzeugen, stand "${stand}", auswahl {Nr: Name}, entscheid {…}, key, titel, zweck, dokumentart. Fehlende Entscheidungen meldet erzeugen kompakt mit Sammel-Schlüsseln.`);
  return z;
}

/** M-d — alle Fundstellen eines Kandidaten; mehr als 40 gruppiert nach Change und Schritt */
function fundstellenText(f: Fundstelle[]): string {
  if (f.length <= 40) return f.map(ortText).join(', ');
  const gruppen = new Map<string, string[]>();
  for (const x of f) {
    const g = x.schritt === 0 ? `${kurzId(x.change)} Titel` : `${kurzId(x.change)} S${x.schritt}`;
    const l = gruppen.get(g) ?? []; if (x.schritt !== 0) l.push(x.pfad); gruppen.set(g, l);
  }
  return [...gruppen].map(([g, l]) => (l.length ? `${g} (${l.join(', ')})` : g)).join('; ');
}

/**
 * V4 — Anzeige des Vorschlags: Reihenfolge, Stand, Kandidaten-Tabelle mit allen Fundstellen (M-d), Entscheidungspunkte mit ids
 * (Teilvorkommen je Change/Schritt/Wort, feste IDs, angelegte Werte, Adressen in Netz-Kandidaten), Verweise, Hinweise.
 */
function vorschlagText(q: QuellChange[], k: Kandidat[], verweise: Verweis[], punkte: Entscheidungspunkt[], hinweise: string[], stand: string): string {
  const z: string[] = [
    `📐 Bauplan ableiten — Vorschlag aus ${q.length} Change${q.length === 1 ? '' : 's'} (nichts gespeichert), Stand ${stand}`,
    ...entscheidungenKurz(k, punkte, stand),
    '',
    'Reihenfolge:', ...q.map(c => `- ${c.schluessel} = ${c.id} („${String(c.plan.titel).slice(0, 80)}“)`),
    '',
    `Kandidaten (${k.length}):`,
    '| Nr | Typ | Wert | Vorschlag | Fundstellen |',
    '|---|---|---|---|---|',
    ...k.map(c => `| ${c.nr} | ${c.typ} | ${zelle(c.wert)} | ${zelle(c.vorschlag)} | ${c.fundstellen.length} |`),
    '',
    'Fundstellen je Kandidat (dort wird ersetzt, wenn der Kandidat gewählt ist):',
    ...k.map(c => `- #${c.nr} ${String(c.wert)}: ${fundstellenText(c.fundstellen)}`),
  ];
  const teil = k.filter(c => c.teilvorkommen.length);
  if (teil.length) {
    z.push('', 'Teilvorkommen (Wert als Teil eines Worts) — wird ein Kandidat gewählt, braucht jede seiner ids eine Entscheidung: „ersetzen“ oder „fest“; gleiches Wort im selben Schritt gleich entscheiden:');
    for (const c of teil) {
      const gruppen = new Map<string, Kandidat['teilvorkommen']>();
      for (const t of c.teilvorkommen) { const g = `${t.change}|${t.schritt}|${t.token}`; const l = gruppen.get(g) ?? []; l.push(t); gruppen.set(g, l); }
      z.push(`#${c.nr} ${c.typ} ${String(c.wert)}:`);
      for (const l of gruppen.values()) {
        const t0 = l[0]!;
        const pfade = [...new Set(l.map(t => t.pfad))].join(', ');
        const wo = `${kurzId(t0.change)} Schritt ${t0.schritt} „${t0.token}“ (${pfade})`;
        if (l.some(t => t.tresor)) z.push(`- ${wo}: gesperrt (Tresor) — Teil des Tresor-Namens ${l.find(t => t.tresor)!.tresor}; diesen Wert nicht wählen (nie ersetzbar)`);
        else z.push(`- ${wo}: ${l.map(t => t.id).join(', ')}`);
      }
    }
  }
  const ids = punkte.filter(p => p.art === 'id');
  if (ids.length) {
    z.push('', 'Feste IDs der Original-Instanz (kein Verweis möglich) — immer nötig, nur „fest“ (oder den erzeugenden Change mitwählen):');
    for (const p of ids) z.push(`- ${p.id}: ${p.wert} in ${p.orte.map(ortText).join(', ')} — ${p.grund}`);
  }
  const anlage = punkte.filter(p => p.art === 'anlage' && p.netz === undefined);
  if (anlage.length) {
    z.push('', 'Vom Paket angelegt — solange der Wert nicht als Parameter gewählt ist, zielen diese Stellen auf die Original-Instanz: je id „fest“ oder den Kandidaten wählen:');
    for (const p of anlage) z.push(`- ${p.id}${p.kandidat ? ` (Kandidat #${p.kandidat})` : ' (kein Kandidat — nur „fest“)'}: ${p.grund}; ${p.orte.length} Stelle${p.orte.length === 1 ? '' : 'n'}${p.orte.length ? `: ${fundstellenText(p.orte)}` : ''}`);
  }
  const veraendert = punkte.filter(p => p.art === 'veraendert');
  if (veraendert.length) {
    z.push('', 'Verändert vorhandene Objekte (nicht vom Paket angelegt) — solange der Wert nicht als Parameter gewählt ist, träfe jede Anwendung wieder dasselbe Objekt: je id „fest“ oder den Kandidaten wählen. Knoten, Speicher, UniFi-Geräte/Ports und Backup-Jobs (node, storage, device, switch_port, job_id, job) zählen als Träger der Aktion nicht dazu:');
    for (const p of veraendert) z.push(`- ${p.id}${p.kandidat ? ` (Kandidat #${p.kandidat})` : ' (kein Kandidat — nur „fest“)'}: ${p.grund}; ${p.orte.length} Stelle${p.orte.length === 1 ? '' : 'n'}${p.orte.length ? `: ${fundstellenText(p.orte)}` : ''}`);
  }
  const tresor = punkte.filter(p => p.art === 'tresor');
  if (tresor.length) {
    z.push('', 'Verwendet bestehende Tresor-Einträge — sonst nutzt jede Anwendung still das Geheimnis der Original-Instanz: je id „fest“ (bewusst denselben Eintrag) oder den Namen als Parameter wählen (Name, nie Wert; im {{geheim:…}}-Platzhalter nur „fest“):');
    for (const p of tresor) z.push(`- ${p.id}${p.kandidat ? ` (Kandidat #${p.kandidat})` : ' (nur „fest“)'}: ${p.grund}; ${p.orte.length} Stelle${p.orte.length === 1 ? '' : 'n'}${p.orte.length ? `: ${fundstellenText(p.orte)}` : ''}`);
  }
  const netz = punkte.filter(p => p.art === 'anlage' && p.netz !== undefined);
  if (netz.length) {
    z.push('', 'Adressen in Netz-Kandidaten — nötig, wenn das Netz gewählt und die Adresse nicht gewählt ist (dann „fest“); gewählte Adressen folgen dem Netz automatisch:');
    for (const p of netz) z.push(`- ${p.id}${p.kandidat ? ` (Kandidat #${p.kandidat})` : ''}: ${p.grund}`);
  }
  if (verweise.length) {
    z.push('', 'Verweise über Change-Grenzen (automatisch, im Lauf erzeugte IDs):');
    for (const v of verweise) z.push(`- ${kurzId(v.change)} Schritt ${v.schritt} ${v.pfad} ← ${kurzId(v.quelle.change)} Schritt ${v.quelle.schritt}.${v.quelle.feld}${v.art === 'praefix' ? ' (ID-Anfang → volle ID)' : ''}`);
  }
  if (hinweise.length) z.push('', 'Hinweise:', ...hinweise.map(h => `- ${h}`));
  z.push('', `Erzeugen: bauplan_ableiten mit modus erzeugen, denselben changes, stand "${stand}", auswahl {Nr: Parametername} (gleicher Wert darf auf denselben Namen), entscheid {id: "ersetzen"|"fest"} für jedes Teilvorkommen der gewählten Kandidaten, jede feste ID, jeden angelegten und jedes veränderte vorhandene Objekt, das nicht gewählt ist, key, titel, zweck, dokumentart (testprotokoll|betrieb). Fehlende Entscheidungen nennt erzeugen auf einmal. Der Entwurf braucht danach die Owner-Freigabe; bewusst feste Stellen stehen in der Freigabe-Frage.`);
  return z.join('\n');
}

/** I2 — Begleitinformation einer Ableitung (Spalte ableitung): nur beim Speichern gesetzt, nicht Teil des Abdrucks */
interface AbleitungInfo { quellen: string[]; fest: FestEintrag[]; hinweise: string[]; ohneAnnahme: string[]; ersetzt?: string; sammel?: SammelEintrag[]; woerter?: ErsetztesWort[] }

/** Sammel-Entscheidung in Worten — für Anzeige und Freigabe-Frage */
function sammelZeile(s: SammelEintrag): string {
  const was = s.schluessel === 'fest:*' ? 'alle offenen Punkte fest'
    : s.schluessel === 'anlage:*' ? 'alle vom Paket angelegten Werte fest'
      : s.schluessel === 'veraendert:*' ? 'alle veränderten vorhandenen Objekte fest'
        : s.schluessel === 'tresor:*' ? 'alle bestehenden Tresor-Einträge fest'
          : s.schluessel.startsWith('teil:wort|') ? (() => { const [w, ...t] = s.schluessel.slice('teil:wort|'.length).split('|'); return `alle Teilvorkommen von ${w} im Wort ${t.join('|')}`; })()
            : `alle Teilvorkommen von ${s.schluessel.slice('teil:wert|'.length)}`;
  const arten = Object.entries(s.arten ?? {});
  const genauer = s.schluessel === 'fest:*' && arten.length ? `: ${arten.map(([a, n]) => `${a} ${n}`).join(', ')}` : '';
  return `Sammel-Entscheidung ${s.schluessel} = ${s.entscheidung}: ${was} (${s.anzahl}${genauer})`;
}
const JE_KATEGORIE = 15;
const mehr = (n: number): string[] => (n > JE_KATEGORIE ? [`  … und ${n - JE_KATEGORIE} weitere`] : []);

/** I2 — Block der Freigabe-Frage: Quellen, bewusst feste Stellen je Kategorie (die ersten 15 wörtlich), ohne Vorab-Kontrolle, Ersetzt */
function ableitungZeilen(roh: string | undefined, abgeleitetAus: string | undefined): string[] {
  if (!roh) return abgeleitetAus ? [`Abgeleitet aus: ${abgeleitetAus.split(',').map(kurzId).join(', ')}`] : [];
  let a: AbleitungInfo;
  try { a = JSON.parse(roh) as AbleitungInfo; } catch { return ['⚠️ Ableitung: Begleitinformation nicht lesbar — Vorlage vor der Freigabe ansehen (bauplan_zeigen)']; }
  const fest = Array.isArray(a.fest) ? a.fest : [];
  const z: string[] = [`Abgeleitet aus: ${(a.quellen ?? []).map(kurzId).join(', ')}`];
  if (a.ersetzt) z.push(`ℹ️ ${a.ersetzt}`);
  // Sammel-Entscheidungen ausdrücklich — die Einzelliste folgt wie bisher
  for (const s of Array.isArray(a.sammel) ? a.sammel : []) z.push(sammelZeile(s));
  // jedes ersetzte Wort ausdrücklich (fest gebliebene Wörter stehen in der fest-Liste)
  const woerter = Array.isArray(a.woerter) ? a.woerter : [];
  if (woerter.length) z.push(`Ersetzte Teilvorkommen (${woerter.length} ${woerter.length === 1 ? 'Wort' : 'Wörter'}):`, ...woerter.slice(0, JE_KATEGORIE).map(w => `- ${w.wort} → ${w.nach} (${w.anzahl} Stelle${w.anzahl === 1 ? '' : 'n'})`), ...mehr(woerter.length));
  if (fest.length) {
    z.push(`⚠️ Bewusst fest (${fest.length} Stelle${fest.length === 1 ? '' : 'n'}) — bleiben wie in den Quell-Changes und zielen damit auf dieselben Objekte:`);
    // je Wert eine Zeile; Tresor-Namen, in denen der feste Wert außerdem steckt, in derselben Zeile (Restpunkt)
    for (const [art, titel] of [['anlage', 'Vom Paket angelegt, nicht als Parameter'], ['veraendert', 'Verändert vorhandene Objekte (nicht vom Paket angelegt, nicht als Parameter'], ['tresor', 'Verwendet bestehende Tresor-Einträge (dasselbe Geheimnis wie die Original-Instanz']] as const) {
      const werte = new Map<string, FestEintrag[]>();
      for (const f of fest.filter(x => x.art === art)) { const l = werte.get(f.id) ?? []; l.push(f); werte.set(f.id, l); }
      if (!werte.size) continue;
      const anzahl = `${werte.size} Wert${werte.size === 1 ? '' : 'e'}`;
      z.push(art === 'anlage' ? `${titel} (${anzahl}):` : `${titel}; ${anzahl}):`);
      for (const l of [...werte.values()].slice(0, JE_KATEGORIE)) {
        const orte = l.map(f => `${f.change8} S${f.schritt} ${f.pfad}`);
        const tresor = l.find(f => f.tresor)?.tresor;
        z.push(`- ${l[0]!.wort}: ${l.length} Stelle${l.length === 1 ? '' : 'n'} (${orte.slice(0, 6).join(', ')}${orte.length > 6 ? ', …' : ''})${tresor ? ` — steckt auch im Tresor-Namen ${tresor}` : ''}`);
      }
      z.push(...mehr(werte.size));
    }
    for (const [art, titel] of [['id', 'Feste IDs der Original-Instanz'], ['teil', 'Teilvorkommen']] as const) {
      const l = fest.filter(f => f.art === art);
      if (!l.length) continue;
      z.push(`${titel} (${l.length}):`, ...l.slice(0, JE_KATEGORIE).map(f => `- ${f.wort} in ${f.change8} S${f.schritt} ${f.pfad}`), ...mehr(l.length));
    }
  }
  const ohne = Array.isArray(a.ohneAnnahme) ? a.ohneAnnahme : [];
  if (ohne.length) z.push(`Ohne automatische Vorab-Kontrolle (${ohne.length}): ${ohne.slice(0, JE_KATEGORIE).join(', ')}${ohne.length > JE_KATEGORIE ? ` … und ${ohne.length - JE_KATEGORIE} weitere` : ''}`);
  const h = Array.isArray(a.hinweise) ? a.hinweise : [];
  if (h.length) z.push(`Hinweise der Ableitung (${h.length}):`, ...h.slice(0, JE_KATEGORIE).map(x => `- ${x}`), ...mehr(h.length));
  return z;
}

/** Erster Change ohne abhaengigVon (Vorlagen-Reihenfolge) — trägt die Eingangskontrolle */
const ersteWurzel = (changes: BauplanChange[]): string | undefined => changes.find(c => c.abhaengigVon.length === 0)?.schluessel;

/**
 * Final-Welle P1 — mit Eingangskontrolle startet jede weitere Wurzel erst nach der ersten (abhaengigVon [erste]), damit die
 * Annahmen nachweislich vor jedem anderen Change laufen. Liefert „<schluessel> startet nach <erste> (Eingangskontrolle)“.
 */
function reihenfolgeZeilen(changes: BauplanChange[], annahmen: number): string[] {
  const erster = ersteWurzel(changes);
  if (!annahmen || !erster) return [];
  return changes.filter(c => c.schluessel !== erster && c.abhaengigVon.length === 0).map(c => `${c.schluessel} startet nach ${erster} (Eingangskontrolle)`);
}

/** M4 — Schrittzahl je Change im Paket, inkl. vorangestellter Eingangskontrolle */
function schrittZeilen(plaene: Array<Record<string, unknown>>, annahmen: number, erster: string | undefined): string[] {
  return ['Schritte je Change:', ...plaene.map(p => {
    const n = (p.schritte as unknown[]).length;
    return `- ${String(p.schluessel)}: ${n} Schritte${annahmen && p.schluessel === erster ? ` (davon ${annahmen} Eingangskontrolle)` : ''}`;
  })];
}

/** Plan-Form wie die Probe, Annahmen als erste Schritte des ersten Change ohne abhaengigVon, Verweise verschoben, kapitel entfernt. */
function baueplaene(changes: BauplanChange[], annahmen: Array<{ text: string; pruefung: Pruefung }>, praefix: string): Array<Record<string, unknown>> {
  const n = annahmen.length;
  // Fix-Runde 1 (I-2) — Eingangskontrolle nur am ERSTEN Change ohne Abhängigkeit (Vorlagen-Reihenfolge)
  const erster = ersteWurzel(changes);
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
      // P1 — weitere Wurzeln hängen an der ersten, damit die Eingangskontrolle zuerst läuft
      abhaengigVon: n && erster && c.schluessel !== erster && c.abhaengigVon.length === 0 ? [erster] : [...c.abhaengigVon], betroffen: [...(c.betroffen ?? [])],
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
