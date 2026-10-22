import { describe, it, expect } from 'vitest';
import { InfrastrukturSkill, BESTAND_QUELLEN } from './infrastruktur-skill.js';
import type { SkillContext } from '@alfred/types';

// I1 — Skill infrastruktur.bestand: Discovery der Quellen, Bericht, Ablage als CMDB-Dokument; nur der Owner
describe('I1 InfrastrukturSkill', () => {
  it('bestand: entdeckt die Quellen, baut den Bericht, legt ihn ab und meldet Auffälligkeiten', async () => {
    const entdeckt: string[][] = []; let gespeichert = '';
    const s = new InfrastrukturSkill({
      istOwner: (c) => c.userId === 'owner',
      entdecke: async (q) => { entdeckt.push(q); return q.map(x => `${x}: 1 Assets, 0 Relationen`); },
      hosts: () => [{ zugang: 'dockerhost', host: '192.168.1.211', dateisysteme: [], dienste: ['docker'], ports: [], container: [{ name: 'noah', image: 'x', zustand: 'running', status: 'Up (unhealthy)', gesundheit: 'unhealthy', ports: '', netze: [], mounts: [] }], compose: [], volumes: [], fehler: [] }],
      vms: async () => [{ name: 'docker-host', typ: 'vm', status: 'active', vmid: 120 }],
      proxy: async () => [], netze: async () => [],
      backups: async () => ({ jeVm: {}, ohne: [{ vmid: 120, name: 'docker-host' }], unerreichbar: [] }),
      speichereBericht: async (_t, m) => { gespeichert = m; return 'doc-1'; },
    });
    const r = await s.execute({ action: 'bestand' }, { userId: 'owner' } as SkillContext);
    expect(r.success).toBe(true);
    expect(entdeckt[0]).toEqual(BESTAND_QUELLEN);
    expect(gespeichert).toContain('# Bestandsbericht');
    expect(gespeichert).toContain('## Discovery');
    expect(r.display).toContain('Container noah ist unhealthy');
    expect(r.display).toContain('VM/CT 120 (docker-host) hat keine Sicherung');
    expect(r.display).toContain('doc-1');
    expect((await s.execute({ action: 'bestand' }, { userId: 'fremd' } as SkillContext)).success).toBe(false);
  });
});
