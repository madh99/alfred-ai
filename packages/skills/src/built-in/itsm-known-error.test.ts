import { describe, it, expect, vi } from 'vitest';
import { ItsmSkill } from './itsm.js';
import type { ItsmRepository, CmdbRepository, ProblemRepository } from '@alfred/storage';
import type { SkillContext } from '@alfred/types';

/**
 * v923 — Known-Error-Wissenskreislauf (zed/AER-Vorfall auf pve als Auslöser):
 *  A — close_incident mit resolution legt automatisch einen Known-Error an
 *      (Dedup: bei bestehendem Match wird nur verlinkt).
 *  C — search_history findet geschlossene Incidents anhand von Stichworten
 *      und zeigt die dokumentierte Lösung.
 */

const ctx: SkillContext = {
  userId: 'u1', chatId: 'c1', platform: 'api', conversationId: 'conv1', masterUserId: 'u1',
} as unknown as SkillContext;

const ZED_INCIDENT = {
  id: 'inc-zed-1', title: 'Proxmox pve: /var/log/syslog 84GB durch zed/NVMe AER — local 99.98%',
  status: 'closed', severity: 'high',
  resolution: 'Logflut gestoppt: zed-Loglevel reduziert, AER-Meldungen ratenlimitiert, syslog rotiert/truncated. NVMe zfs-nvme002 (Fanxiang S501) prüfen/tauschen.',
  rootCause: 'ZFS zed Events + Kernel PCIe AER/NVMe I/O-Fehler fluteten /var/log/syslog',
  createdAt: '2026-05-21T10:00:00Z', affectedAssetIds: [], affectedServiceIds: [],
};

function makeSkill(overrides?: { problems?: any[]; incidents?: any[]; changes?: any[] }) {
  const createdProblems: any[] = [];
  const itsmRepo = {
    closeIncident: vi.fn(async () => ({ ...ZED_INCIDENT })),
    listIncidents: vi.fn(async () => overrides?.incidents ?? [ZED_INCIDENT]),
    listChangeRequests: vi.fn(async () => overrides?.changes ?? []),
  } as unknown as ItsmRepository;
  const problemRepo = {
    listProblems: vi.fn(async () => overrides?.problems ?? []),
    createProblem: vi.fn(async (_uid: string, data: any) => { const p = { id: 'prob-new-1', ...data }; createdProblems.push(p); return p; }),
    updateProblem: vi.fn(async () => ({})),
    linkIncident: vi.fn(async () => ({})),
  } as unknown as ProblemRepository;
  const skill = new ItsmSkill(itsmRepo, {} as CmdbRepository, problemRepo);
  return { skill, itsmRepo, problemRepo, createdProblems };
}

describe('v923 A — Auto-Known-Error beim close_incident', () => {
  it('legt bei dokumentierter resolution automatisch einen Known-Error an', async () => {
    const { skill, problemRepo } = makeSkill();
    const r = await skill.execute({ action: 'close_incident', incident_id: 'inc-zed-1', resolution: ZED_INCIDENT.resolution }, ctx);
    expect(r.success).toBe(true);
    expect(problemRepo.createProblem).toHaveBeenCalledTimes(1);
    const createArgs = (problemRepo.createProblem as any).mock.calls[0][1];
    expect(createArgs.workaround).toContain('zed-Loglevel');
    expect(createArgs.linkedIncidentIds).toEqual(['inc-zed-1']);
    // is_known_error wird via updateProblem gesetzt
    const updArgs = (problemRepo.updateProblem as any).mock.calls[0][2];
    expect(updArgs.isKnownError).toBe(true);
    expect(r.display).toContain('Known-Error angelegt');
  });

  it('dedupliziert: bestehender Known-Error mit Keyword-Match → nur verlinken', async () => {
    const { skill, problemRepo } = makeSkill({
      problems: [{ id: 'prob-old-1', title: 'Proxmox pve syslog Logflut zed NVMe', isKnownError: true, workaround: 'siehe alt' }],
    });
    const r = await skill.execute({ action: 'close_incident', incident_id: 'inc-zed-1', resolution: ZED_INCIDENT.resolution }, ctx);
    expect(r.success).toBe(true);
    expect(problemRepo.createProblem).not.toHaveBeenCalled();
    expect(problemRepo.linkIncident).toHaveBeenCalledWith('u1', 'prob-old-1', 'inc-zed-1');
    expect(r.display).toContain('existiert bereits');
  });

  it('ohne substanzielle resolution kein Known-Error', async () => {
    const { skill, itsmRepo, problemRepo } = makeSkill();
    (itsmRepo.closeIncident as any).mockResolvedValueOnce({ ...ZED_INCIDENT, resolution: 'ok' });
    const r = await skill.execute({ action: 'close_incident', incident_id: 'inc-zed-1', resolution: 'ok' }, ctx);
    expect(r.success).toBe(true);
    expect(problemRepo.createProblem).not.toHaveBeenCalled();
  });
});

describe('v923 C — search_history', () => {
  it('findet den zed/AER-Vorfall per Stichworten und zeigt die Lösung', async () => {
    const { skill } = makeSkill();
    const r = await skill.execute({ action: 'search_history', query: 'syslog voll zed nvme' }, ctx);
    expect(r.success).toBe(true);
    expect((r.data as any).hits.length).toBe(1);
    expect(r.display).toContain('Damalige Lösung');
    expect(r.display).toContain('zed-Loglevel');
  });

  it('keine Treffer → sagt explizit „neues Problem"', async () => {
    const { skill } = makeSkill({ incidents: [], changes: [], problems: [] });
    const r = await skill.execute({ action: 'search_history', query: 'kafka consumer lag' }, ctx);
    expect(r.success).toBe(true);
    expect(r.display).toContain('neues Problem');
  });

  it('query erforderlich', async () => {
    const { skill } = makeSkill();
    const r = await skill.execute({ action: 'search_history' }, ctx);
    expect(r.success).toBe(false);
  });
});
