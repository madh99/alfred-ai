import { describe, expect, it } from 'vitest';
import { readdirSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

// Realfall L3 2c28c7d2 (20.11.): apt-get install im AD-Beitritt auf sqllnx02 ließ needrestart mssql-server ungeplant neu starten;
// der Primär stürzte dabei ab (SQL-Server-ASSERT), Pacemaker übernahm ~30 s. Jeder apt-get-install-Aufruf der Bausteine muss
// needrestart unterdrücken — Neustarts laufen nur rollierend und geplant über den Change.
const ORDNER = dirname(fileURLToPath(import.meta.url));

describe('apt-get install ohne needrestart-Neustarts', () => {
  const quellen = readdirSync(ORDNER).filter(d => d.endsWith('.ts') && !d.endsWith('.test.ts') && !d.endsWith('.testhilfe.ts'));

  it('findet die bekannten Installationsstellen', () => {
    const mitInstall = quellen.filter(d => /apt-get [^\n]*install /.test(readFileSync(join(ORDNER, d), 'utf8')));
    expect(mitInstall).toEqual(expect.arrayContaining(['linux-sql-ad.ts', 'linux-ha.ts', 'linux-sql.ts', 'linux-sql-sicherung.ts']));
  });

  it.each(quellen)('%s: jede apt-get-install-Zeile setzt NEEDRESTART_MODE=l und NEEDRESTART_SUSPEND=1 (oder exportiert sie)', datei => {
    const text = readFileSync(join(ORDNER, datei), 'utf8');
    const exportiert = /export [^\n]*NEEDRESTART_MODE=l/.test(text);
    const zeilen = text.split('\n').filter(z => /apt-get [^\n]*install /.test(z) && !/abbruch "apt-get install/.test(z.trimStart().slice(0, 40)));
    for (const z of zeilen) {
      if (exportiert) continue;
      expect(z, z.trim()).toMatch(/NEEDRESTART_MODE=l NEEDRESTART_SUSPEND=1 (ACCEPT_EULA=Y )?apt-get /);
    }
  });
});
