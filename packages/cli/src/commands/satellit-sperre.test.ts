import { describe, it, expect } from 'vitest';
import os from 'node:os';
import path from 'node:path';
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import { schreibenderImVerzeichnis, gleichesVerzeichnis, auftragStarten, auftraegeOrdner } from './satellit-auftrag.js';

/** v1512 P1 — Satellit: kein zweiter schreibender Claude-Code-Auftrag im selben Verzeichnis; Fragen und andere Verzeichnisse frei. */
describe('v1512 Verzeichnis-Sperre am Satelliten', () => {
  const meta = (home: string, id: string, projekt: string, o: { nurLesen?: boolean; pid?: number; status?: string; frage?: boolean } = {}) => {
    const d = path.join(auftraegeOrdner(home), id);
    mkdirSync(d, { recursive: true });
    writeFileSync(path.join(d, 'meta.json'), JSON.stringify({ id, titel: `T ${id}`, projekt, start: new Date().toISOString(), pid: o.pid ?? process.pid, status: o.status ?? 'laeuft', befehl: 'claude', auftragDatei: o.frage ? path.join(d, 'FRAGE.md') : path.join(projekt, 'AUFTRAG.md'), ...(o.nurLesen ? { nurLesen: true } : {}) }));
  };

  it('erkennt laufende schreibende Aufträge, nicht Fragen, beendete oder tote', () => {
    const home = mkdtempSync(path.join(os.tmpdir(), 'sperre-'));
    const proj = path.join(home, 'projekt');
    meta(home, '20261019120000-frag', proj, { nurLesen: true });
    meta(home, '20261019120001-alt', proj, { frage: true }); // ältere Frage ohne Feld
    meta(home, '20261019120002-ende', proj, { status: 'fertig' });
    meta(home, '20261019120003-tot', proj, { pid: 999_999_999 });
    meta(home, '20261019120004-andr', path.join(home, 'anderes'));
    expect(schreibenderImVerzeichnis(proj, home)).toBeUndefined();
    meta(home, '20261019120005-bau', proj + path.sep);
    expect(schreibenderImVerzeichnis(proj, home)?.id).toBe('20261019120005-bau');
    expect(schreibenderImVerzeichnis(path.join(home, 'drittes'), home)).toBeUndefined();
  });

  it('gleiches Verzeichnis trotz Trenner am Ende', () => {
    expect(gleichesVerzeichnis('/a/b/', '/a/b')).toBe(true);
    expect(gleichesVerzeichnis('/a/b', '/a/c')).toBe(false);
  });

  it('auftragStarten lehnt den zweiten schreibenden Auftrag ab — bevor irgendetwas angelegt wird', () => {
    const home = mkdtempSync(path.join(os.tmpdir(), 'sperre2-'));
    const proj = path.join(home, 'projekt');
    mkdirSync(proj);
    meta(home, '20261019120010-bau', proj);
    expect(() => auftragStarten({ projekt: proj, auftrag: 'zweiter', home, claude: process.execPath })).toThrow(/läuft schon der Claude-Code-Auftrag 20261019120010-bau/);
  });
});
