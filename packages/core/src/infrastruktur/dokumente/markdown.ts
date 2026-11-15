import type { Block, Dokument } from './modell.js';

function zelle(s: string): string {
  return s.replace(/\|/g, '\\|').replace(/\r?\n/g, ' ');
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
    case 'code':
      return '```\n' + b.text + '\n```';
    case 'mermaid':
      return '```mermaid\n' + b.text + '\n```';
    case 'nichtBelegt':
      return `> **Nicht belegt:** ${b.grund}`;
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
