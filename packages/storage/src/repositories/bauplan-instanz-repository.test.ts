import { describe, it, expect, afterEach } from 'vitest';
import path from 'node:path';
import os from 'node:os';
import fs from 'node:fs';
import type { Database } from '../database.js';

let hasBetterSqlite3 = true;
try {
  const BetterSqlite3 = (await import('better-sqlite3')).default;
  const testDb = new BetterSqlite3(':memory:');
  testDb.close();
} catch {
  hasBetterSqlite3 = false;
}

describe.skipIf(!hasBetterSqlite3)('BauplanInstanzRepository und Dokumentstruktur', () => {
  let dbPath: string;
  let db: Database;

  afterEach(async () => {
    try { await db?.close(); } catch { /* ignore */ }
    if (dbPath && fs.existsSync(dbPath)) {
      for (const s of ['', '-wal', '-shm']) { try { fs.unlinkSync(dbPath + s); } catch { /* ignore */ } }
    }
  });

  async function setup() {
    const { Database } = await import('../database.js');
    const { BauplanInstanzRepository } = await import('./bauplan-instanz-repository.js');
    const { CmdbRepository } = await import('./cmdb-repository.js');
    dbPath = path.join(os.tmpdir(), `alfred-test-bauplan-${Date.now()}-${Math.random().toString(36).slice(2)}.db`);
    db = Database.createSync(dbPath);
    return { repo: new BauplanInstanzRepository(db.getAdapter()), cmdb: new CmdbRepository(db.getAdapter()) };
  }

  const ids = ['2cfde1a2-0000', '7335dfeb-0000', '288c3716-0000'];

  it('legt eine Instanz an und findet sie per Name mit Change-Reihenfolge', async () => {
    const { repo } = await setup();
    const neu = await repo.anlegen('u1', { name: 'pki-lab-2026-11-15', dokumentart: 'testprotokoll', changeIds: ids });
    expect(neu.status).toBe('aktiv');
    const g = await repo.finde('u1', 'pki-lab-2026-11-15');
    expect(g?.changeIds).toEqual(ids);
    expect(g?.dokumentart).toBe('testprotokoll');
  });

  it('findet per id und listet', async () => {
    const { repo } = await setup();
    const neu = await repo.anlegen('u1', { name: 'a', dokumentart: 'betrieb', changeIds: ['x'] });
    expect((await repo.finde('u1', neu.id))?.name).toBe('a');
    expect(await repo.finde('u2', neu.id)).toBeUndefined();
    expect((await repo.liste('u1')).map(i => i.name)).toEqual(['a']);
  });

  it('wirft bei doppeltem Namen', async () => {
    const { repo } = await setup();
    await repo.anlegen('u1', { name: 'dup', dokumentart: 'betrieb', changeIds: ['x'] });
    await expect(repo.anlegen('u1', { name: 'dup', dokumentart: 'betrieb', changeIds: ['y'] })).rejects.toThrow();
  });

  it('speichert die Dokumentstruktur und lange Inhalte vollständig', async () => {
    const { cmdb } = await setup();
    const inhalt = 'x'.repeat(120_000);
    const d = await cmdb.saveDocument('u1', { docType: 'testprotokoll', title: 't', content: inhalt, struktur: '{"a":1}' });
    const g = await cmdb.getDocumentById('u1', d.id);
    expect(g?.struktur).toBe('{"a":1}');
    expect(g?.content.length).toBe(120_000);
  });
});
