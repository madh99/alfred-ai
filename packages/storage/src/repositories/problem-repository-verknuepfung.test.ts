import { describe, expect, it } from 'vitest';
import { ProblemRepository } from './problem-repository.js';

// v1876 — Realfall 16.11.: Pattern-Sweep legte seit 22.10. alle 30 min ein neues Problem für dieselben
// Incidents an (2731 Dubletten). createProblem schrieb die Incident-IDs nur ins Problem; linkIncident
// sah sie dort schon und kehrte zurück, bevor problem_id am Incident gesetzt war → detectPatterns
// (problem_id IS NULL) fand dieselben Incidents beim nächsten Lauf wieder.
function repo() {
  const problems = new Map<string, Record<string, unknown>>();
  const incidentProblem = new Map<string, string | null>([['i1', null], ['i2', null], ['0a097789-7203-41ab-841b-1f06a75e93c8', null], ['946d08e0-9c02-40b0-847a-26c05849692f', null]]);
  const db = {
    queryOne: async (sql: string, p: unknown[]) => {
      if (sql.includes('FROM cmdb_incidents')) return incidentProblem.has(String(p[0])) ? { id: String(p[0]) } : undefined;
      if (sql.includes('LIKE')) return [...problems.values()].find(x => String(x.id).startsWith(String(p[0]).replace('%', '')));
      return problems.get(String(p[0]));
    },
    query: async (sql: string, p: unknown[]) => (sql.includes('FROM cmdb_incidents WHERE id LIKE')
      ? [...incidentProblem.keys()].filter(i => i.startsWith(String(p[0]).replace('%', ''))).map(id => ({ id }))
      : []),
    execute: async (sql: string, p: unknown[]) => {
      if (sql.includes('INSERT INTO cmdb_problems')) {
        problems.set(String(p[0]), { id: p[0], user_id: p[1], title: p[2], status: 'logged', priority: p[4], linked_incident_ids: p[6], affected_asset_ids: p[7], affected_service_ids: p[8], detected_at: p[12], created_at: p[13], updated_at: p[14] });
      } else if (sql.includes('SET problem_id = NULL')) {
        if (incidentProblem.has(String(p[0]))) incidentProblem.set(String(p[0]), null);
      } else if (sql.includes('UPDATE cmdb_incidents SET problem_id')) {
        const inc = String(p[1]);
        if (incidentProblem.has(inc)) incidentProblem.set(inc, p[0] as string | null);
      } else if (sql.includes('UPDATE cmdb_problems SET linked_incident_ids')) {
        const z = problems.get(String(p[2]));
        if (z) z.linked_incident_ids = p[0];
      }
      return { changes: 1 };
    },
  };
  return { r: new ProblemRepository(db as never), incidentProblem };
}

describe('Problem ↔ Incident-Verknüpfung', () => {
  it('createProblem mit Incidents setzt problem_id an jedem Incident', async () => {
    const { r, incidentProblem } = repo();
    const p = await r.createProblem('u', { title: 't', linkedIncidentIds: ['i1', 'i2'] });
    expect(incidentProblem.get('i1')).toBe(p.id);
    expect(incidentProblem.get('i2')).toBe(p.id);
  });

  it('linkIncident setzt problem_id auch, wenn der Incident im Problem schon steht', async () => {
    const { r, incidentProblem } = repo();
    const p = await r.createProblem('u', { title: 't', linkedIncidentIds: ['i1'] });
    incidentProblem.set('i1', null); // Altbestand: im Problem gelistet, am Incident leer
    await r.linkIncident('u', p.id, 'i1');
    expect(incidentProblem.get('i1')).toBe(p.id);
  });

  // Realfall 19.11.2026: Alfred übergab Kurz-IDs; das Problem wurde per Präfix gefunden, die UPDATEs liefen mit der Kurz-ID ins Leere
  it('unlinkIncident mit Kurz-IDs trennt wirklich (volle IDs im UPDATE) und setzt problem_id am Incident zurück', async () => {
    const { r, incidentProblem } = repo();
    const p = await r.createProblem('u', { title: 't', linkedIncidentIds: ['0a097789-7203-41ab-841b-1f06a75e93c8', '946d08e0-9c02-40b0-847a-26c05849692f'] });
    const nachher = await r.unlinkIncident('u', p.id.slice(0, 8), '0a097789');
    expect(nachher?.linkedIncidentIds).toEqual(['946d08e0-9c02-40b0-847a-26c05849692f']);
    expect(incidentProblem.get('0a097789-7203-41ab-841b-1f06a75e93c8')).toBeNull();
  });

  it('unlinkIncident: nicht verknüpfter Incident → Fehler statt stiller Erfolg', async () => {
    const { r } = repo();
    const p = await r.createProblem('u', { title: 't', linkedIncidentIds: ['i1'] });
    await expect(r.unlinkIncident('u', p.id, '946d08e0')).rejects.toThrow('nicht mit Problem');
  });

  it('linkIncident mit Kurz-IDs speichert die volle Incident-ID; unbekannte ID → Fehler', async () => {
    const { r, incidentProblem } = repo();
    const p = await r.createProblem('u', { title: 't' });
    const nachher = await r.linkIncident('u', p.id.slice(0, 8), '946d08e0');
    expect(nachher?.linkedIncidentIds).toEqual(['946d08e0-9c02-40b0-847a-26c05849692f']);
    expect(incidentProblem.get('946d08e0-9c02-40b0-847a-26c05849692f')).toBe(p.id);
    await expect(r.linkIncident('u', p.id, 'deadbeef')).rejects.toThrow('nicht gefunden');
  });
});
