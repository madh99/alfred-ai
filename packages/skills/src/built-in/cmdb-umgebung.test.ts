import { describe, it, expect } from 'vitest';
import { umgebungAusTags, umgebungsVorschlag } from './cmdb-umgebung.js';

describe('Owner 22.11. K2 — Umgebung aus Proxmox-Tags', () => {
  it('bekannte Tags, Groß-/Kleinschreibung, Trenner', () => {
    expect(umgebungAusTags('prod;web')).toBe('production');
    expect(umgebungAusTags('Lab')).toBe('lab');
    expect(umgebungAusTags('web, dev')).toBe('development');
    expect(umgebungAusTags('test')).toBe('test');
  });
  it('kein Umgebungs-Tag → undefined (gepflegter Wert bleibt)', () => {
    expect(umgebungAusTags(undefined)).toBeUndefined();
    expect(umgebungAusTags('')).toBeUndefined();
    expect(umgebungAusTags('web;docker')).toBeUndefined();
  });
  it('widersprüchlich → production (fail-closed)', () => {
    expect(umgebungAusTags('lab;prod')).toBe('production');
  });
});

describe('Owner 22.11. K3 — Vorschlag aus dem Namen', () => {
  it('eindeutige Namensteile', () => {
    expect(umgebungsVorschlag('restoretest-docker-web-01')).toBe('test');
    expect(umgebungsVorschlag('probe-win25b')).toBe('test');
    expect(umgebungsVorschlag('cstest01')).toBe('test');
    expect(umgebungsVorschlag('test-ubuntu')).toBe('test');
    expect(umgebungsVorschlag('docker-dev-01')).toBe('development');
    expect(umgebungsVorschlag('famapp-dev-01')).toBe('development');
    expect(umgebungsVorschlag('Win11-Dev')).toBe('development');
    expect(umgebungsVorschlag('pki-lab-ca01')).toBe('lab');
  });
  it('alles andere production (fail-closed)', () => {
    for (const n of ['dc01', 'sqllnx01', 'famapp-prod-01', 'pfsensePROD', 'alfred1', 'git-server', 'devices-gw', 'latest-db']) expect(umgebungsVorschlag(n)).toBe('production');
  });
});
