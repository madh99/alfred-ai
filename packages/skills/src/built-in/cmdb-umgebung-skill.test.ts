import { describe, it, expect } from 'vitest';
import { CmdbSkill } from './cmdb.js';

/** Owner 22.11. K2/K3/K4 — Umgebung im CMDB-Skill: Sperre für lab/test/development, offene Liste, Setzen, Abgleich reicht weiter. */
function aufbau() {
  const assets = [
    { id: 'aaaaaaaa-1', name: 'dc01', assetType: 'vm', status: 'active', sourceSkill: 'proxmox' },
    { id: 'bbbbbbbb-2', name: 'restoretest-web', assetType: 'vm', status: 'active', sourceSkill: 'proxmox' },
    { id: 'cccccccc-3', name: 'git-server', assetType: 'vm', status: 'active', sourceSkill: 'proxmox', environment: 'production' },
    { id: 'dddddddd-4', name: 'sensor.temp', assetType: 'iot_device', status: 'active', sourceSkill: 'homeassistant' },
  ] as Array<Record<string, unknown>>;
  const upserts: Array<Record<string, unknown>> = [];
  const repo = {
    listAssets: async () => assets,
    updateAsset: async (_u: string, id: string, d: Record<string, unknown>) => { const a = assets.find(x => x.id === id)!; Object.assign(a, d); return a; },
    upsertAsset: async (_u: string, a: Record<string, unknown>) => { upserts.push(a); return { id: 'neu', ...a }; },
    logChange: async () => undefined,
    markStaleAssets: async () => 0,
    getAssetBySource: async () => null,
  };
  const skill = new CmdbSkill(repo as never);
  return { skill, assets, upserts };
}
const ctx = { userId: 'u', masterUserId: 'u' } as never;

describe('Owner 22.11. — Umgebung im CMDB-Skill', () => {
  it('lab/test/development setzt der Skill nie (add_asset, update_asset, umgebung_setzen)', async () => {
    const { skill } = aufbau();
    for (const input of [
      { action: 'add_asset', name: 'x', asset_type: 'vm', environment: 'lab' },
      { action: 'update_asset', asset_id: 'aaaaaaaa-1', environment: 'Test' },
      { action: 'umgebung_setzen', asset_ids: ['aaaaaaaa-1'], environment: 'development' },
    ]) {
      const r = await skill.execute(input, ctx);
      expect(r.success).toBe(false);
      expect(r.error).toContain('setzt nur der Owner');
    }
  });
  it('umgebung_offen: nur aktive Server/VMs/LXC ohne Umgebung, mit Vorschlag', async () => {
    const { skill } = aufbau();
    const r = await skill.execute({ action: 'umgebung_offen' }, ctx);
    expect((r.data as Array<{ name: string; vorschlag: string }>).map(o => `${o.name}=${o.vorschlag}`)).toEqual(['dc01=production', 'restoretest-web=test']);
  });
  it('umgebung_setzen: production per ID-Präfix', async () => {
    const { skill, assets } = aufbau();
    const r = await skill.execute({ action: 'umgebung_setzen', asset_ids: ['aaaaaaaa'], environment: 'production' }, ctx);
    expect(r.success).toBe(true);
    expect(assets[0]!.environment).toBe('production');
  });
  it('Abgleich reicht die Umgebung der Quelle weiter (K2), ohne Umgebung bleibt das Feld weg; Rückruf nach dem Abgleich (K4)', async () => {
    const { skill, upserts } = aufbau();
    let gemeldet = 0;
    skill.setNachAbgleichCallback(async () => { gemeldet++; });
    skill.registerDiscoverySource('proxmox', async () => ({ assets: [
      { name: 'lab01', assetType: 'vm', sourceSkill: 'proxmox', sourceId: 'pve:1', environment: 'lab' },
      { name: 'dc01', assetType: 'vm', sourceSkill: 'proxmox', sourceId: 'pve:2' },
    ] as never, relations: [] }));
    await skill.execute({ action: 'discover_source', source: 'proxmox' }, ctx);
    expect(upserts[0]!.environment).toBe('lab');
    expect('environment' in upserts[1]!).toBe(false);
    expect(gemeldet).toBe(1);
  });
});
