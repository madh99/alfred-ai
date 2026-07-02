import { describe, it, expect, afterEach } from 'vitest';
import path from 'node:path';
import os from 'node:os';
import fs from 'node:fs';
import type { Database } from '../database.js';

/**
 * v921 — kg_entities.layer: CMDB-Sync (source='cmdb') landet im Infra-Layer,
 * alles andere im persönlichen Graph. getFullGraph filtert per Layer;
 * Promote-only (infra wird nie zurückgestuft).
 */

let hasBetterSqlite3 = true;
try {
  const BetterSqlite3 = (await import('better-sqlite3')).default;
  const testDb = new BetterSqlite3(':memory:');
  testDb.close();
} catch {
  hasBetterSqlite3 = false;
}

describe.skipIf(!hasBetterSqlite3)('v921 KG Layer', () => {
  let dbPath: string;
  let db: Database;

  afterEach(async () => {
    try { await db?.close(); } catch { /* ignore */ }
    if (dbPath && fs.existsSync(dbPath)) {
      try { fs.unlinkSync(dbPath); } catch { /* ignore */ }
      try { fs.unlinkSync(dbPath + '-wal'); } catch { /* ignore */ }
      try { fs.unlinkSync(dbPath + '-shm'); } catch { /* ignore */ }
    }
  });

  async function setup() {
    const { Database } = await import('../database.js');
    const { KnowledgeGraphRepository } = await import('./knowledge-graph-repository.js');
    dbPath = path.join(os.tmpdir(), `alfred-test-kglayer-${Date.now()}.db`);
    db = Database.createSync(dbPath);
    return new KnowledgeGraphRepository(db.getAdapter());
  }

  it('cmdb-Source → layer=infra, andere Sources → personal', async () => {
    const repo = await setup();
    const infra = await repo.upsertEntity('u1', 'proxmox-node-1', 'server', {}, 'cmdb');
    const person = await repo.upsertEntity('u1', 'Franz Müller', 'person', {}, 'memories');
    expect(infra.layer).toBe('infra');
    expect(person.layer).toBe('personal');
  });

  it('getFullGraph filtert nach Layer (personal ohne CMDB-Infra)', async () => {
    const repo = await setup();
    await repo.upsertEntity('u1', 'switch-01', 'network_device', {}, 'cmdb');
    await repo.upsertEntity('u1', 'Anna', 'person', {}, 'chat');

    const personal = await repo.getFullGraph('u1', 'personal');
    expect(personal.entities.map(e => e.name)).toEqual(['Anna']);

    const infra = await repo.getFullGraph('u1', 'infra');
    expect(infra.entities.map(e => e.name)).toEqual(['switch-01']);

    const all = await repo.getFullGraph('u1');
    expect(all.entities.length).toBe(2);
  });

  it('Layer-Filter schränkt Relations auf geladene Entities ein', async () => {
    const repo = await setup();
    const sw = await repo.upsertEntity('u1', 'switch-01', 'network_device', {}, 'cmdb');
    const anna = await repo.upsertEntity('u1', 'Anna', 'person', {}, 'chat');
    const ben = await repo.upsertEntity('u1', 'Ben', 'person', {}, 'chat');
    await repo.upsertRelation('u1', anna.id, ben.id, 'knows', undefined, 'chat');
    await repo.upsertRelation('u1', anna.id, sw.id, 'manages', undefined, 'chat');

    const personal = await repo.getFullGraph('u1', 'personal');
    // Anna→Ben bleibt; Anna→switch fällt raus (Target im Infra-Layer)
    expect(personal.relations.length).toBe(1);
    expect(personal.relations[0].relationType).toBe('knows');
  });

  it('Promote-only: personal-Entity wird durch cmdb-Sync zu infra, nie zurück', async () => {
    const repo = await setup();
    // Erst im Chat erwähnt → personal
    const first = await repo.upsertEntity('u1', 'Home Assistant', 'service', {}, 'chat');
    expect(first.layer).toBe('personal');
    // Dann vom CMDB-Sync erfasst → promote zu infra
    const promoted = await repo.upsertEntity('u1', 'Home Assistant', 'service', {}, 'cmdb');
    expect(promoted.layer).toBe('infra');
    // Erneute Chat-Erwähnung stuft NICHT zurück
    const again = await repo.upsertEntity('u1', 'Home Assistant', 'service', {}, 'chat');
    expect(again.layer).toBe('infra');
  });
});
