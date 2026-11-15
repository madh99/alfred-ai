import type { Block, Dokument } from './modell.js';

function zelle(s: string): string {
  return s.replace(/\\/g, '\\\\').replace(/\|/g, '\\|').replace(/\r\n|\r|\n/g, ' ');
}

/** Zaun länger als jede Backtick-Folge im Inhalt (mindestens drei). */
function zaun(text: string): string {
  const laengste = Math.max(0, ...(text.match(/`+/g) ?? []).map((m) => m.length));
  return '`'.repeat(Math.max(3, laengste + 1));
}

function blockMd(b: Block): string {
  switch (b.art) {
    case 'absatz':
      return b.text;
    case 'liste':
      return b.punkte.map((p) => `- ${p}`).join('\n');
    case 'tabelle': {
      const kopf = `| ${b.kopf.map(zelle).join(' | ')} |`;
      const trenn = `| ${b.kopf.map(() => '---').join(' | ')} |`;
      const zeilen = b.zeilen.map((z) => `| ${z.map(zelle).join(' | ')} |`);
      return [kopf, trenn, ...zeilen].join('\n');
    }
    case 'code': {
      const z = zaun(b.text);
      return `${z}\n${b.text}\n${z}`;
    }
    case 'mermaid': {
      const z = zaun(b.text);
      return `${z}mermaid\n${b.text}\n${z}`;
    }
    case 'nichtBelegt': {
      const [erste, ...rest] = b.grund.split(/\r\n|\r|\n/);
      return [`> **Nicht belegt:** ${erste}`, ...rest.map((z) => (z === '' ? '>' : `> ${z}`))].join('\n');
    }
    case 'frei':
      return b.text && b.text.trim() ? b.text : '_(nicht ausgefüllt)_';
  }
}

export function alsMarkdown(d: Dokument): string {
  const k = d.kopf;
  const teile: string[] = [];
  teile.push(`# ${k.titel}`);
  const kopf = [`- Dokumentart: ${k.art} (Version ${k.artVersion})`, `- Instanz: ${k.ordner}`, `- Erzeugt: ${k.erzeugt}`];
  if (k.quellen.length > 0) {
    kopf.push('- Datenstand:');
    for (const q of k.quellen) {
      kopf.push(`  - ${q.quelle}: ${q.stand}${q.fehler ? ` (Fehler: ${q.fehler})` : ''}`);
    }
  }
  if (k.verweise.length > 0) {
    kopf.push('- Verweise:');
    for (const v of k.verweise) kopf.push(`  - ${v}`);
  }
  teile.push(kopf.join('\n'));
  for (const kap of d.kapitel) {
    teile.push(`## ${kap.nr}. ${kap.titel}`);
    for (const b of kap.bloecke) teile.push(blockMd(b));
  }
  return teile.join('\n\n') + '\n';
}
