/**
 * Skill dokumentation — Dokument-Vorlagen V1: Abnahme- und Testprotokolle deterministisch aus Change-Läufen, gespeichert in der CMDB
 * (Markdown + Struktur), als PDF/DOCX mit geschwärzten Rohläufen und Prüfanleitung zugestellt und abgelegt (lokal und auf pve2).
 * Führt nichts auf Fremdsystemen aus außer der Ablage-Kopie auf pve2 über den Fernzugang.
 */
import { createHash } from 'node:crypto';
import { Skill } from '@alfred/skills';
import type { CmdbChangeRequest, CmdbDocType, CmdbDocument, CmdbLinkedEntityType, SkillContext, SkillMetadata, SkillResult, SkillResultAttachment } from '@alfred/types';
import { DOKU_ARTEN, pruefeDokument } from './arten.js';
import { baueAbnahme, baueTestprotokoll } from './builder.js';
import { alsMarkdown } from './markdown.js';
import { alsPdf } from './pdf.js';
import { alsDocx } from './docx.js';
import { findeChange, verlaufVon, type DokuQuellen } from './sammler.js';
import { lege, pruefeAblageNamen, PVE2_WURZEL, type AblageDeps } from './ablage.js';
import { schwaerze } from '../../fernzugriff/kaefig.js';
import type { DokuArtKey, Dokument } from './modell.js';
import type { VerlaufEintrag } from '../change-lauf.js';

/** CMDB kürzt still bei 500 000 Zeichen — ein gekürztes Dokument wird nie gespeichert. */
export const MAX_INHALT = 500_000;
const INSTANZ_NAME = /^(?!\.+$)[\w.-]{1,80}$/;
const MAX_CHANGES = 20;

export interface BauplanInstanzDaten { id: string; name: string; dokumentart: 'testprotokoll' | 'betrieb'; changeIds: string[]; status: string; createdAt: string }

export interface DokumenteDeps {
  owner: () => string | undefined;
  istOwner: (ctx: SkillContext) => boolean;
  quellen: DokuQuellen;
  cmdb: {
    saveDocument(userId: string, doc: { docType: CmdbDocType; title: string; content: string; linkedEntityType?: CmdbLinkedEntityType; linkedEntityId?: string; generatedBy?: string; struktur?: string }): Promise<CmdbDocument>;
    getDocumentById(userId: string, id: string): Promise<CmdbDocument | null>;
  };
  instanzen: {
    anlegen(userId: string, d: { name: string; dokumentart: 'testprotokoll' | 'betrieb'; changeIds: string[] }): Promise<BauplanInstanzDaten>;
    finde(userId: string, idOderName: string): Promise<BauplanInstanzDaten | undefined>;
  };
  ablage: AblageDeps;
  datenOrdner: string;
  jetzt?: () => string;
  protokoll?: (msg: string, daten: Record<string, unknown>) => void;
}

export interface Erzeugt {
  doc: CmdbDocument;
  dokument: Dokument;
  attachments: SkillResultAttachment[];
  display: string;
}

type Freitext = Record<string, string | undefined>;

/** Freitexte gegen die Grenzen der Dokumentart (vor jedem Lesen/Schreiben). */
function pruefeFreitext(art: DokuArtKey, f: Freitext): string | undefined {
  for (const k of DOKU_ARTEN[art].kapitel) {
    if (!k.frei) continue;
    const t = f[k.frei.feld];
    if (t !== undefined && t.length > k.frei.max) return `${k.frei.feld} zu lang: ${t.length} Zeichen, höchstens ${k.frei.max} erlaubt`;
  }
  return undefined;
}

/**
 * Prüfung eines gespeicherten Dokuments für den Export: Struktur ja, aber eine ältere, bekannte Version der Dokumentart wird nicht
 * abgewiesen (ein gespeichertes Protokoll bleibt exportierbar, wenn die Vorlage später eine neue Version bekommt). Heute gibt es je Art
 * nur Version 1, deshalb wird gegen die aktuelle Kapiteldefinition geprüft. Kommt eine Version 2 hinzu, muss DOKU_ARTEN die früheren
 * Kapiteldefinitionen behalten und hier die der gespeicherten Version verwenden. Unbekannte (neuere) oder ungültige Versionen → Fehler.
 */
export function pruefeGespeichert(dok: Dokument): string[] {
  const art = DOKU_ARTEN[dok.kopf.art];
  if (!art) return [`Unbekannte Dokumentart: ${String(dok.kopf.art)}`];
  const v = dok.kopf.artVersion;
  if (!Number.isInteger(v) || v < 1 || v > art.version) return [`Version der Dokumentart ${String(v)} unbekannt (bekannt: 1–${art.version})`];
  return pruefeDokument({ ...dok, kopf: { ...dok.kopf, artVersion: art.version } });
}

/** vor dem Start verworfen (status cancelled ohne Laufbeginn) — läuft nie, beendet also auch keine Serie */
const vorStartVerworfen = (x: CmdbChangeRequest) => x.status === 'cancelled' && !(x.lauf as { start?: string } | undefined)?.start;

/** Standard-Serie: c und rekursiv alle Vorgänger (abhaengigVon) vom Typ standard, Vorgänger zuerst; jedes Glied einmal (Zyklen enden). */
function serieVon(c: CmdbChangeRequest, alle: Map<string, CmdbChangeRequest>): CmdbChangeRequest[] {
  const serie: CmdbChangeRequest[] = []; const gesehen = new Set<string>();
  const besuche = (x: CmdbChangeRequest) => {
    if (gesehen.has(x.id)) return;
    gesehen.add(x.id);
    for (const id of x.abhaengigVon ?? []) { const v = alle.get(id); if (v?.type === 'standard') besuche(v); }
    serie.push(x);
  };
  besuche(c);
  return serie;
}

const text = (v: unknown): string | undefined => (typeof v === 'string' && v.trim() ? v.trim() : undefined);
const sha = (b: Buffer) => createHash('sha256').update(b).digest('hex');

/** Gemeinsamer Kern für Skill und Change-Ende (Task 7): erzeugen, speichern, exportieren, ablegen. */
export class DokumenteDienst {
  constructor(readonly d: DokumenteDeps) {}

  private jetzt(): string { return this.d.jetzt ? this.d.jetzt() : new Date().toISOString(); }

  private async verlauf(o: string, changes: CmdbChangeRequest[]): Promise<Map<string, { eintraege: VerlaufEintrag[]; quelle: string; abgeschnitten?: boolean }>> {
    const m = new Map<string, { eintraege: VerlaufEintrag[]; quelle: string; abgeschnitten?: boolean }>();
    for (const c of changes) m.set(c.id, await verlaufVon(this.d.quellen, o, c));
    return m;
  }

  /** PDF, DOCX und die Anhänge der Struktur (Rohläufe, PRUEFUNG.txt) — Bytes exakt wie im Modell (UTF-8, ohne BOM). */
  async dateien(dok: Dokument, version: number): Promise<SkillResultAttachment[]> {
    const basis = `${dok.kopf.art}-${dok.kopf.ordner.replace(/^change-/, '')}-v${version}`;
    return [
      { fileName: `${basis}.pdf`, mimeType: 'application/pdf', data: await alsPdf(dok) },
      { fileName: `${basis}.docx`, mimeType: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document', data: await alsDocx(dok) },
      ...dok.anhaenge.map(a => ({ fileName: a.name, mimeType: a.mime, data: Buffer.from(a.inhalt, 'utf8') })),
    ];
  }

  private async ablegen(dok: Dokument, version: number, dateien: SkillResultAttachment[]): Promise<{ lokal: string; pve2: { ok: boolean; fehler?: string } }> {
    return lege(dok, version, dateien.map(x => ({ name: x.fileName, inhalt: x.data })), this.d.ablage, this.d.datenOrdner);
  }

  private anzeige(doc: CmdbDocument, dok: Dokument, dateien: SkillResultAttachment[], a: { lokal: string; pve2: { ok: boolean; fehler?: string } }, wort: string): string {
    const summen = dateien.filter(x => x.fileName.startsWith('rohlauf-')).map(x => `${x.fileName} ${sha(x.data)}`);
    return [
      `✅ ${dok.kopf.titel} — Version ${doc.version} ${wort} (Dokument ${doc.id})`,
      `Prüfsummen (SHA-256): ${summen.length ? summen.join(', ') : 'keine (kein Lauf)'}`,
      `Lokal: ${a.lokal}`,
      a.pve2.ok ? `pve2: ok (${PVE2_WURZEL}/${dok.kopf.ordner}/v${doc.version})` : `pve2: fehlgeschlagen (${a.pve2.fehler ?? 'unbekannt'}) — lokale Ablage bleibt`,
      `Dateien: ${dateien.map(x => x.fileName).join(', ')}`,
    ].join('\n');
  }

  /** speichert (nie gekürzt), rendert und legt ab */
  async speichere(o: string, dok: Dokument, link: { typ: CmdbLinkedEntityType; id: string }): Promise<Erzeugt> {
    const md = alsMarkdown(dok);
    if (md.length > MAX_INHALT) throw new Error(`Dokument zu groß: ${md.length} Zeichen Markdown, höchstens ${MAX_INHALT} — nicht gespeichert`);
    // Namen vor dem Speichern prüfen: ein gespeichertes Dokument ohne Ablage soll es nicht geben
    const f = pruefeAblageNamen(dok.kopf.ordner, dok.anhaenge.map(a => a.name));
    if (f) throw new Error(f);
    // Speichern (Version) und Ablage (Ordner v<n>) je (Art, Bezug) nacheinander: ein manueller Aufruf und der Hook am Change-Ende
    // dürfen nicht dieselbe Version bekommen und denselben Ordner überschreiben
    return this.seriell(`${o}|${dok.kopf.art}|${link.id}`, async () => {
      const doc = await this.d.cmdb.saveDocument(o, {
        docType: dok.kopf.art, title: dok.kopf.titel, content: md, struktur: JSON.stringify(dok),
        linkedEntityType: link.typ, linkedEntityId: link.id, generatedBy: `vorlage:${dok.kopf.art}@${dok.kopf.artVersion}`,
      });
      const dateien = await this.dateien(dok, doc.version);
      const a = await this.ablegen(dok, doc.version, dateien);
      this.d.protokoll?.('Dokument erzeugt', { docId: doc.id, art: dok.kopf.art, version: doc.version, ordner: dok.kopf.ordner, lokal: a.lokal, pve2: a.pve2.ok, pve2Fehler: a.pve2.fehler });
      return { doc, dokument: dok, attachments: dateien, display: this.anzeige(doc, dok, dateien, a, 'gespeichert') };
    });
  }

  /** In-Prozess-Kette je Schlüssel; ein Fehler bricht die Kette nicht ab. Einträge verschwinden, sobald die Kette leer ist. */
  private readonly ketten = new Map<string, Promise<unknown>>();
  private seriell<T>(schluessel: string, f: () => Promise<T>): Promise<T> {
    const vorher = this.ketten.get(schluessel) ?? Promise.resolve();
    const lauf = vorher.then(f, f);
    const ende = lauf.then(() => undefined, () => undefined);
    this.ketten.set(schluessel, ende);
    void ende.then(() => { if (this.ketten.get(schluessel) === ende) this.ketten.delete(schluessel); });
    return lauf;
  }

  async abnahme(o: string, c: CmdbChangeRequest, frei: { zweck?: string; abweichungen?: string }): Promise<Erzeugt> {
    const f = pruefeFreitext('abnahme', frei);
    if (f) throw new Error(f);
    const dok = baueAbnahme([c], await this.verlauf(o, [c]), frei, this.jetzt());
    return this.speichere(o, dok, { typ: 'change_request', id: c.id });
  }

  /**
   * V2 — Abnahmeprotokoll nach dem Ende eines Changes (Hook des Change-Motors); liefert die Zeile für die Abschlussmeldung, wirft nie.
   * normal/emergency: Abnahme für den neu geladenen Change (gespeicherter Lauf). standard: kein Einzelprotokoll — erst wenn das letzte
   * Glied einer Serie endet (kein anderer Standard-Change hängt von ihm ab), ein Sammelprotokoll über die Serie; mittlere Glieder → Hinweiszeile.
   */
  async abnahmeNachEnde(o: string, c: CmdbChangeRequest): Promise<string | undefined> {
    try {
      let q: Awaited<ReturnType<DokuQuellen['changes']>> | undefined;
      try { q = await this.d.quellen.changes(o); } catch (err) {
        // normal/emergency brauchen die Liste nur zum Neuladen: der Motor übergibt den gerade gespeicherten Stand
        if (c.type === 'standard') throw err;
        this.d.protokoll?.('Abnahme nach Change-Ende: Change-Liste nicht ladbar, Stand des Motors verwendet', { changeId: c.id, fehler: (err as Error)?.message });
      }
      const alle = new Map((q?.changes ?? []).map(x => [x.id, x]));
      // nicht in der Liste (Grenze): der vom Motor übergebene, gerade gespeicherte Stand
      const frisch = alle.get(c.id) ?? c;
      if (frisch.type !== 'standard' || !q) return this.zeileNachEnde('Abnahmeprotokoll erstellt', await this.abnahme(o, frisch, {}));
      // ohne vollständige Liste ist weder „letztes Glied“ noch die Serie belegt — nie raten
      if (q.abgeschnitten) throw new Error('die Change-Liste hat die Abfragegrenze erreicht — Serie und Nachfolger nicht sicher bestimmbar');
      const nachfolger = q.changes.find(x => x.id !== frisch.id && x.type === 'standard' && (x.abhaengigVon ?? []).includes(frisch.id) && !vorStartVerworfen(x));
      if (nachfolger) return `Sammelprotokoll folgt mit dem letzten Glied der Serie (${nachfolger.id.slice(0, 8)})`;
      const serie = serieVon(frisch, alle);
      const dok = baueAbnahme(serie, await this.verlauf(o, serie), {}, this.jetzt());
      const e = await this.speichere(o, dok, { typ: 'change_request', id: frisch.id });
      return this.zeileNachEnde(serie.length > 1 ? 'Sammelprotokoll erstellt' : 'Abnahmeprotokoll erstellt', e);
    } catch (err) {
      const grund = schwaerze((err as Error)?.message ?? String(err)).text.slice(0, 300);
      this.d.protokoll?.('Abnahmeprotokoll nach Change-Ende nicht erstellt', { changeId: c.id, fehler: grund });
      return `Abnahmeprotokoll nicht erstellt: ${grund}`;
    }
  }

  private zeileNachEnde(wort: string, e: Erzeugt): string {
    const pve2 = e.display.split('\n').find(z => z.startsWith('pve2: fehlgeschlagen'));
    return `${wort}: ${e.dokument.kopf.titel} — Version ${e.doc.version}, Dokument ${e.doc.id}${pve2 ? `; ${pve2}` : ''}`;
  }

  async testprotokoll(o: string, instanz: string, frei: { zweck?: string; befunde_produktion?: string }): Promise<Erzeugt> {
    const f = pruefeFreitext('testprotokoll', frei);
    if (f) throw new Error(f);
    const i = await this.d.instanzen.finde(o, instanz);
    if (!i) throw new Error(`Bauplan-Instanz „${instanz}“ nicht gefunden — zuerst instanz_anlegen`);
    if (i.dokumentart !== 'testprotokoll') throw new Error(`Instanz „${i.name}“ ist für ${i.dokumentart}, nicht für ein Testprotokoll`);
    const q = await this.d.quellen.changes(o);
    const alle = new Map(q.changes.map(c => [c.id, c]));
    const changes = i.changeIds.map(id => alle.get(id));
    const fehlt = i.changeIds.filter((_, k) => !changes[k]);
    if (fehlt.length) {
      throw new Error(q.abgeschnitten
        ? `Changes der Instanz nicht in der geladenen Liste: ${fehlt.join(', ')} — die Change-Liste hat die Abfragegrenze erreicht, sie können trotzdem existieren`
        : `Changes der Instanz nicht gefunden: ${fehlt.join(', ')}`);
    }
    const cs = changes as CmdbChangeRequest[];
    const dok = baueTestprotokoll(i.name, cs, await this.verlauf(o, cs), frei, this.jetzt());
    return this.speichere(o, dok, { typ: 'bauplan_instanz', id: i.id });
  }

  async instanzAnlegen(o: string, name: string, refs: string[]): Promise<BauplanInstanzDaten> {
    if (!INSTANZ_NAME.test(name)) throw new Error('name: nur Buchstaben, Ziffern, _ . - (höchstens 80 Zeichen)');
    if (!refs.length || refs.length > MAX_CHANGES) throw new Error(`changes: 1 bis ${MAX_CHANGES} Change-IDs`);
    if (await this.d.instanzen.finde(o, name)) throw new Error(`Bauplan-Instanz „${name}“ gibt es schon`);
    const ids: string[] = [];
    for (const r of refs) {
      const c = await findeChange(this.d.quellen, o, r);
      if (typeof c === 'string') throw new Error(c);
      if (ids.includes(c.id)) throw new Error(`Change ${c.id.slice(0, 8)} doppelt angegeben`);
      ids.push(c.id);
    }
    return this.d.instanzen.anlegen(o, { name, dokumentart: 'testprotokoll', changeIds: ids });
  }

  /** Export aus der gespeicherten Struktur (nie aus dem Markdown); legt erneut ab. */
  async exportiere(o: string, docId: string): Promise<Erzeugt> {
    const doc = await this.d.cmdb.getDocumentById(o, docId);
    if (!doc) throw new Error(`Dokument ${docId} nicht gefunden`);
    if (!doc.struktur) throw new Error(`Dokument ${docId} hat keine Struktur (nicht aus einer Vorlage erzeugt) — kein Export möglich`);
    let dok: Dokument;
    try { dok = JSON.parse(doc.struktur) as Dokument; } catch { throw new Error(`Struktur von Dokument ${docId} ist kein gültiges JSON`); }
    if (!dok?.kopf || !Array.isArray(dok.kapitel) || !Array.isArray(dok.anhaenge)) throw new Error(`Struktur von Dokument ${docId} ist unvollständig`);
    const m = pruefeGespeichert(dok);
    if (m.length) throw new Error(`Struktur von Dokument ${docId} ungültig: ${m.join('; ')}`);
    // gleiche Kette wie beim Erzeugen: ein Export darf den Ordner v<n> nicht gleichzeitig mit einer Erzeugung beschreiben
    return this.seriell(`${o}|${doc.docType}|${doc.linkedEntityId ?? ''}`, async () => {
      const dateien = await this.dateien(dok, doc.version);
      const a = await this.ablegen(dok, doc.version, dateien);
      this.d.protokoll?.('Dokument exportiert', { docId: doc.id, version: doc.version, lokal: a.lokal, pve2: a.pve2.ok, pve2Fehler: a.pve2.fehler });
      return { doc, dokument: dok, attachments: dateien, display: this.anzeige(doc, dok, dateien, a, 'exportiert') };
    });
  }
}

const AKTIONEN = ['abnahme_erzeugen', 'instanz_anlegen', 'testprotokoll_erzeugen', 'dokument_exportieren'] as const;

export class DokumentationSkill extends Skill {
  readonly metadata: SkillMetadata = {
    name: 'dokumentation',
    category: 'infrastructure',
    description:
      'Dokument-Vorlagen: Abnahme- und Testprotokolle deterministisch aus den Läufen der Changes (geschwärzt, mit Prüfsumme), gespeichert in der CMDB, '
      + 'als PDF, DOCX, Rohlauf-JSON und PRUEFUNG.txt zugestellt und abgelegt (data/dokumente/… und Kopie auf pve2 /srv/alfred-dokumente/…). '
      + 'abnahme_erzeugen (change = ID oder eindeutiges Präfix; optional zweck ≤ 600, abweichungen ≤ 600 Zeichen) — Change-Abnahmeprotokoll. '
      + 'instanz_anlegen (name [A-Za-z0-9_.-], dokumentart testprotokoll, changes = Change-IDs in Reihenfolge Aufbau … Abbau) — bündelt Changes für ein Testprotokoll. '
      + 'testprotokoll_erzeugen (instanz = Name oder ID; optional zweck ≤ 600, befunde_produktion ≤ 1200) — Lab-/Testprotokoll über alle Changes der Instanz. '
      + 'dokument_exportieren (doc_id) — gespeichertes Vorlagen-Dokument erneut als Dateien (aus der Struktur) zustellen und ablegen. '
      + 'Freitexte nur mit Belegen füllen oder leer lassen; alles andere entsteht aus den Daten.',
    riskLevel: 'read',
    version: '1.0.0',
    inputSchema: {
      type: 'object',
      properties: {
        action: { type: 'string', enum: [...AKTIONEN] },
        change: { type: 'string', description: 'abnahme_erzeugen: Change-ID oder eindeutiges Präfix' },
        zweck: { type: 'string', description: 'Freitext Zweck (≤ 600 Zeichen)' },
        abweichungen: { type: 'string', description: 'abnahme_erzeugen: Abweichungen und offene Punkte (≤ 600 Zeichen)' },
        name: { type: 'string', description: 'instanz_anlegen: Name der Bauplan-Instanz (z. B. pki-lab-2026-11-15)' },
        dokumentart: { type: 'string', enum: ['testprotokoll'] },
        changes: { type: 'array', items: { type: 'string' }, description: 'instanz_anlegen: Change-IDs in Reihenfolge' },
        instanz: { type: 'string', description: 'testprotokoll_erzeugen: Name oder ID der Instanz' },
        befunde_produktion: { type: 'string', description: 'testprotokoll_erzeugen: Befunde für die Produktion (≤ 1200 Zeichen)' },
        doc_id: { type: 'string', description: 'dokument_exportieren: ID des CMDB-Dokuments' },
      },
      required: ['action'],
    },
  };

  constructor(private readonly dienst: DokumenteDienst) { super(); }

  async execute(input: Record<string, unknown>, context: SkillContext): Promise<SkillResult> {
    const action = String(input.action ?? '');
    if (!(AKTIONEN as readonly string[]).includes(action)) return { success: false, error: `Unbekannte Aktion ${action}` };
    if (!this.dienst.d.istOwner(context)) return { success: false, error: 'Nur für den Owner.' };
    const o = this.dienst.d.owner();
    if (!o) return { success: false, error: 'Kein Owner bekannt.' };
    const erg = (e: Erzeugt): SkillResult => ({
      success: true,
      data: { docId: e.doc.id, version: e.doc.version, art: e.dokument.kopf.art, titel: e.dokument.kopf.titel, dateien: e.attachments.map(a => a.fileName) },
      display: e.display,
      attachments: e.attachments,
    });
    try {
      switch (action) {
        case 'abnahme_erzeugen': {
          const ref = text(input.change);
          if (!ref) return { success: false, error: 'change: Change-ID angeben' };
          const frei = { zweck: text(input.zweck), abweichungen: text(input.abweichungen) };
          const f = pruefeFreitext('abnahme', frei);
          if (f) return { success: false, error: f };
          const c = await findeChange(this.dienst.d.quellen, o, ref);
          if (typeof c === 'string') return { success: false, error: c };
          return erg(await this.dienst.abnahme(o, c, frei));
        }
        case 'instanz_anlegen': {
          if (input.dokumentart !== undefined && input.dokumentart !== 'testprotokoll') return { success: false, error: 'dokumentart: nur testprotokoll' };
          const refs = Array.isArray(input.changes) ? input.changes.map(x => String(x).trim()).filter(Boolean) : [];
          const i = await this.dienst.instanzAnlegen(o, String(input.name ?? '').trim(), refs);
          return { success: true, data: i, display: `✅ Bauplan-Instanz „${i.name}“ (${i.id}) für ein Testprotokoll mit ${i.changeIds.length} Changes: ${i.changeIds.map(x => x.slice(0, 8)).join(', ')}` };
        }
        case 'testprotokoll_erzeugen': {
          const instanz = text(input.instanz);
          if (!instanz) return { success: false, error: 'instanz: Name oder ID angeben' };
          return erg(await this.dienst.testprotokoll(o, instanz, { zweck: text(input.zweck), befunde_produktion: text(input.befunde_produktion) }));
        }
        case 'dokument_exportieren': {
          const id = text(input.doc_id);
          if (!id) return { success: false, error: 'doc_id angeben' };
          return erg(await this.dienst.exportiere(o, id));
        }
      }
      return { success: false, error: `Unbekannte Aktion ${action}` };
    } catch (err) {
      return { success: false, error: (err as Error).message };
    }
  }
}
