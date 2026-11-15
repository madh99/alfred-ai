import { Document, HeadingLevel, Packer, Paragraph, Table, TableCell, TableRow, TextRun, WidthType } from 'docx';
import type { Block, Dokument } from './modell.js';

/** Behält nur Zeichen der XML-1.0-Produktion Char (Word meldet die Datei sonst als beschädigt); verwaiste Surrogate entfallen. */
function sauber(t: string): string {
  let aus = '';
  for (const z of t) {
    const c = z.codePointAt(0) ?? 0;
    const ok =
      c === 0x9 ||
      c === 0xa ||
      c === 0xd ||
      (c >= 0x20 && c <= 0xd7ff) ||
      (c >= 0xe000 && c <= 0xfffd) ||
      (c >= 0x10000 && c <= 0x10ffff);
    if (ok) aus += z;
  }
  return aus;
}

const CODE_SCHRIFT = 'Courier New';
const CODE_GROESSE = 16; // halbe Punkt: 8 pt

function codeAbsaetze(t: string): Paragraph[] {
  return t.split(/\r\n|\r|\n/).map(
    (z) => new Paragraph({ children: [new TextRun({ text: sauber(z), font: CODE_SCHRIFT, size: CODE_GROESSE })] }),
  );
}

function absatz(t: string, fett = false): Paragraph[] {
  return t
    .split(/\r\n|\r|\n/)
    .map((z) => new Paragraph({ children: [new TextRun({ text: sauber(z), bold: fett })], spacing: { after: 80 } }));
}

function zeile(zellen: string[], fett: boolean): TableRow {
  return new TableRow({
    tableHeader: fett,
    children: zellen.map(
      (z) =>
        new TableCell({
          children: [new Paragraph({ children: [new TextRun({ text: sauber(z), bold: fett, size: 18 })] })],
        }),
    ),
  });
}

function blockDocx(b: Block): Array<Paragraph | Table> {
  switch (b.art) {
    case 'absatz':
      return absatz(b.text);
    case 'liste':
      return b.punkte.map((p) => new Paragraph({ text: sauber(p), bullet: { level: 0 } }));
    case 'tabelle':
      if (b.kopf.length === 0) return absatz('(Tabelle ohne Spalten)');
      return [
        new Table({
          width: { size: 100, type: WidthType.PERCENTAGE },
          columnWidths: b.kopf.map(() => Math.floor(9026 / b.kopf.length)),
          rows: [zeile(b.kopf, true), ...b.zeilen.map((z) => zeile(z, false))],
        }),
        new Paragraph({ text: '' }),
      ];
    case 'code':
    case 'mermaid':
      return codeAbsaetze(b.text);
    case 'nichtBelegt':
      return absatz(`Nicht belegt: ${b.grund}`, true);
    case 'frei':
      return absatz(b.text && b.text.trim() ? b.text : '(nicht ausgefüllt)');
  }
}

export async function alsDocx(d: Dokument): Promise<Buffer> {
  const k = d.kopf;
  const kinder: Array<Paragraph | Table> = [new Paragraph({ text: sauber(k.titel), heading: HeadingLevel.HEADING_1 })];
  kinder.push(...absatz(`Dokumentart: ${k.art} (Version ${k.artVersion})`));
  kinder.push(...absatz(`Instanz: ${k.ordner}`));
  kinder.push(...absatz(`Erzeugt: ${k.erzeugt}`));
  if (k.quellen.length > 0) {
    kinder.push(...absatz('Datenstand:'));
    for (const q of k.quellen) {
      kinder.push(new Paragraph({ text: sauber(`${q.quelle}: ${q.stand}${q.fehler ? ` (Fehler: ${q.fehler})` : ''}`), bullet: { level: 0 } }));
    }
  }
  if (k.verweise.length > 0) {
    kinder.push(...absatz('Verweise:'));
    for (const v of k.verweise) kinder.push(new Paragraph({ text: sauber(v), bullet: { level: 0 } }));
  }
  for (const kap of d.kapitel) {
    kinder.push(new Paragraph({ text: sauber(`${kap.nr}. ${kap.titel}`), heading: HeadingLevel.HEADING_2 }));
    for (const b of kap.bloecke) kinder.push(...blockDocx(b));
  }
  const doc = new Document({ sections: [{ children: kinder }] });
  return Buffer.from(await Packer.toBuffer(doc));
}
