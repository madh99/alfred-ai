import { describe, it, expect } from 'vitest';
import { CommvaultSkill } from '../built-in/commvault.js';

// v1612 — Owner 23.10.: „Commvault meldet alles ok, obwohl der Server (bewusst) abgeschaltet ist“
function skill(antwort: (pfad: string) => unknown) {
  const s = new CommvaultSkill({ apiUrl: 'https://cv', username: 'u', password: 'p' } as never);
  (s as unknown as { api: (m: string, p: string) => Promise<unknown> }).api = async (_m, p) => antwort(p);
  return s;
}
const aus = () => { throw new Error('fetch failed'); };

describe('Commvault: abgeschalteter Server ist kein „alles ok“', () => {
  it('status: alle Abfragen scheitern → success false mit „nicht erreichbar“', async () => {
    const r = await skill(aus).execute({ action: 'status' }, {} as never);
    expect(r.success).toBe(false);
    expect(r.error).toMatch(/Commvault nicht erreichbar.*fetch failed/);
  });

  it('Lagebild: Jobs nicht lesbar → „nicht erreichbar, Backup-Stand unbekannt“ statt „Alle Backups OK“', async () => {
    const t = await skill(aus).buildReasoningContext();
    expect(t).toMatch(/nicht erreichbar.*Backup-Stand unbekannt/);
    expect(t).not.toContain('Alle Backups OK');
  });

  it('erreichbar ohne Jobs bleibt „Alle Backups OK“', async () => {
    const t = await skill(p => (p.startsWith('/Job') ? { jobs: [] } : {})).buildReasoningContext();
    expect(t).toBe('Alle Backups OK');
  });
});
