import { describe, it, expect } from 'vitest';
import type { SkillContext } from '@alfred/types';
import { GitlabSkill } from './gitlab-skill.js';
import { zielReferenz, holReferenz, hochladenBefehl, holenBefehl, ausgabeWert, lokaleReferenz } from '../fernzugriff/registry.js';

const owner = { userId: 'owner' } as SkillContext;

describe('v1658 GitLab-Skill (nur lesend)', () => {
  it('projekte und registry mit Tags und Digest; nur der Owner', async () => {
    const aufrufe: string[] = [];
    const s = new GitlabSkill({
      istOwner: c => c.userId === 'owner',
      api: async (p) => {
        aufrufe.push(p);
        if (p.startsWith('/projects?')) return [{ id: 1, path_with_namespace: 'madh/noahhabel-landingpage', container_registry_image_prefix: 'registry.lokalkraft.at/madh/noahhabel-landingpage', default_branch: 'main', last_activity_at: '2026-09-01T10:00:00Z' }];
        if (p.endsWith('/registry/repositories?tags_count=true&per_page=50')) return [{ id: 7, path: 'madh/noahhabel-landingpage/backend', location: 'registry.lokalkraft.at/madh/noahhabel-landingpage/backend' }];
        if (p.endsWith('/tags?per_page=50')) return [{ name: 'migration-20261025' }];
        return { name: 'migration-20261025', digest: `sha256:${'a'.repeat(64)}`, created_at: '2026-10-25T12:00:00Z', total_size: 52428800 };
      },
    });
    const p = await s.execute({ action: 'projekte' }, owner);
    expect(p.display).toContain('registry.lokalkraft.at/madh/noahhabel-landingpage');
    const r = await s.execute({ action: 'registry', projekt: 'madh/noahhabel-landingpage' }, owner);
    expect(r.success).toBe(true);
    expect(r.display).toContain(`migration-20261025 · sha256:${'a'.repeat(64)}`);
    expect(aufrufe).toContain('/projects/madh%2Fnoahhabel-landingpage/registry/repositories/7/tags/migration-20261025');
    expect((await s.execute({ action: 'registry', projekt: '../x' }, owner)).success).toBe(false);
    expect((await s.execute({ action: 'projekte' }, { userId: 'fremd' } as SkillContext)).success).toBe(false);
  });
});

describe('v1658 Registry-Befehle', () => {
  const reg = { server: 'registry.lokalkraft.at', benutzer: 'madh', token: 'GEHEIM' };
  it('Referenzen: Ziel nur in der eigenen Registry mit Tag, Holen nur mit Digest', () => {
    expect(zielReferenz(reg.server, 'registry.lokalkraft.at/madh/noahhabel-landingpage/backend:migration-20261025')).toEqual({ pfad: 'madh/noahhabel-landingpage/backend', tag: 'migration-20261025' });
    expect('fehler' in zielReferenz(reg.server, 'docker.io/madh/x:1')).toBe(true);
    expect('fehler' in zielReferenz(reg.server, 'registry.lokalkraft.at/madh/x')).toBe(true);
    expect('fehler' in zielReferenz(reg.server, "registry.lokalkraft.at/madh/x;rm -rf /:1")).toBe(true);
    expect(holReferenz(reg.server, `registry.lokalkraft.at/madh/x@sha256:${'b'.repeat(64)}`)).toEqual({ pfad: 'madh/x', digest: `sha256:${'b'.repeat(64)}` });
    expect('fehler' in holReferenz(reg.server, 'registry.lokalkraft.at/madh/x:latest')).toBe(true);
    expect(lokaleReferenz('noah-landingpage-backend:latest')).toBe(true);
    expect(lokaleReferenz('x; curl evil')).toBe(false);
  });

  it('der Token steht nie im Befehl; Anmeldung über stdin in temporärer Konfiguration', () => {
    const h = hochladenBefehl(reg, 'noah-landingpage-backend:latest', 'registry.lokalkraft.at/madh/noahhabel-landingpage/backend:migration-20261025');
    const g = holenBefehl(reg, `registry.lokalkraft.at/madh/x@sha256:${'b'.repeat(64)}`, `sha256:${'b'.repeat(64)}`);
    for (const b of [h, g]) {
      expect(b).not.toContain('GEHEIM');
      expect(b).toContain('--password-stdin');
      expect(b).toContain('export DOCKER_CONFIG="$d"');
      expect(b).toContain('trap \'rm -rf "$d"\' EXIT');
    }
    expect(ausgabeWert(`pushed\nDIGEST=sha256:${'c'.repeat(64)}\n`, 'DIGEST')).toBe(`sha256:${'c'.repeat(64)}`);
    expect(ausgabeWert('DIGEST=\n', 'DIGEST')).toBeUndefined();
  });
});
