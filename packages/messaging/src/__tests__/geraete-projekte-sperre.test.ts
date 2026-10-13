import { describe, it, expect } from 'vitest';
import { HttpAdapter } from '../adapters/http.js';

// v1399 — Geräte-Projekte: Routen, die auf dem Server im Projektordner arbeiten, sind gesperrt
describe('Web-API: Geräte-Projekte', () => {
  const a = new HttpAdapter(0, '127.0.0.1');
  a.setGeraeteProjektIds(new Set(['geraet-1']));
  it('Server-Arbeit im Ordner gesperrt, Projekt-Daten erlaubt', () => {
    for (const r of ['repo-status', 'commits', 'deploy', 'review', 'update-deps', 'work-on-items', 'move', 'docs', 'health-check'])
      expect(a.geraeteProjektGesperrt(`/api/projects/geraet-1/${r}`), r).toBe(true);
    for (const r of ['chat-history', 'open-items', 'decisions', 'health-log', 'work-stats', 'geraet', 'environments'] /* v1443 B15 — Umgebungen sind Daten am Server */)
      expect(a.geraeteProjektGesperrt(`/api/projects/geraet-1/${r}`), r).toBe(false);
    expect(a.geraeteProjektGesperrt('/api/projects/geraet-1')).toBe(false); // Projekt selbst (lesen, umbenennen, archivieren)
  });
  it('Server-Projekte unverändert', () => {
    expect(a.geraeteProjektGesperrt('/api/projects/server-1/repo-status')).toBe(false);
    expect(a.geraeteProjektGesperrt('/api/projects/wizard/create')).toBe(false);
  });
});
