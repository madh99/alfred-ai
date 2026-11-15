import PDFDocument from 'pdfkit';
import type { Block, Dokument } from './modell.js';

/** Ersetzt Zeichen, die die eingebauten PDF-Schriften (WinAnsi/Latin-1) nicht darstellen. */
export function winAnsi(t: string): string {
  const fest: Record<string, string> = {
    '✅': '[OK]',
    '❌': '[FEHLER]',
    '„': '"',
    '“': '"',
    '”': '"',
    '‚': "'",
    '‘': "'",
    '’': "'",
    '–': '-',
    '—': '-',
    '…': '...',
    '→': '->',
  };
  let aus = '';
  for (const z of t.normalize('NFC')) {
    const ersatz = fest[z];
    if (ersatz !== undefined) {
      aus += ersatz;
      continue;
    }
    const cp = z.codePointAt(0) ?? 0;
    // Steuerzeichen außer Zeilenumbruch/Tab und alles über Latin-1 wird zu '?'
    if (z === '\n' || z === '\t' || (cp >= 32 && cp <= 255 && !(cp >= 127 && cp < 160))) aus += z;
    else if (z === '\r') aus += '';
    else aus += '?';
  }
  return aus;
}

const RAND = 50;
const BREITE = 595.28 - 2 * RAND;
const ZELLE_MAX = 60;

function kuerzen(s: string): string {
  const eine = s.replace(/\r\n|\r|\n/g, ' ');
  return eine.length > ZELLE_MAX ? `${eine.slice(0, ZELLE_MAX - 3)}...` : eine;
}

export async function alsPdf(d: Dokument): Promise<Buffer> {
  const k = d.kopf;
  const doc = new PDFDocument({ size: 'A4', margin: RAND, bufferPages: true });
  const teile: Buffer[] = [];
  doc.on('data', (c: Buffer) => teile.push(c));
  const fertig = new Promise<Buffer>((ok, fehler) => {
    doc.on('end', () => ok(Buffer.concat(teile)));
    doc.on('error', fehler);
  });

  const text = (t: string, font = 'Helvetica', groesse = 10, extra: Record<string, unknown> = {}) => {
    doc.font(font).fontSize(groesse).text(winAnsi(t), RAND, doc.y, { width: BREITE, ...extra });
  };
  const code = (t: string) => text(t === '' ? ' ' : t, 'Courier', 8);

  const block = (b: Block): void => {
    switch (b.art) {
      case 'absatz':
        text(b.text);
        break;
      case 'liste':
        for (const p of b.punkte) text(`- ${p}`);
        break;
      case 'tabelle': {
        if (b.kopf.length === 0) {
          text('(Tabelle ohne Spalten)');
          break;
        }
        code([b.kopf, ...b.zeilen].map((z) => z.map(kuerzen).join(' | ')).join('\n'));
        break;
      }
      case 'code':
        code(b.text);
        break;
      case 'mermaid':
        code(b.text);
        break;
      case 'nichtBelegt':
        text(`Nicht belegt: ${b.grund}`, 'Helvetica-Bold');
        break;
      case 'frei':
        text(b.text && b.text.trim() ? b.text : '(nicht ausgefüllt)');
        break;
    }
    doc.moveDown(0.6);
  };

  text(k.titel, 'Helvetica-Bold', 18);
  doc.moveDown(0.4);
  text(`Dokumentart: ${k.art} (Version ${k.artVersion})`);
  text(`Instanz: ${k.ordner}`);
  text(`Erzeugt: ${k.erzeugt}`);
  if (k.quellen.length > 0) {
    text('Datenstand:');
    for (const q of k.quellen) text(`  - ${q.quelle}: ${q.stand}${q.fehler ? ` (Fehler: ${q.fehler})` : ''}`);
  }
  if (k.verweise.length > 0) {
    text('Verweise:');
    for (const v of k.verweise) text(`  - ${v}`);
  }
  doc.moveDown();
  for (const kap of d.kapitel) {
    text(`${kap.nr}. ${kap.titel}`, 'Helvetica-Bold', 14);
    doc.moveDown(0.3);
    for (const b of kap.bloecke) block(b);
  }

  // Kopfzeile je Seite erst am Ende, damit die Seitennummern stimmen
  const bereich = doc.bufferedPageRange();
  const titel = winAnsi(k.titel).replace(/\s+/g, ' ').slice(0, 90);
  for (let i = 0; i < bereich.count; i++) {
    doc.switchToPage(bereich.start + i);
    doc
      .font('Helvetica')
      .fontSize(8)
      .text(`${titel} - Seite ${i + 1}`, RAND, 25, { width: BREITE, lineBreak: false });
  }
  doc.flushPages();
  doc.end();
  return fertig;
}
