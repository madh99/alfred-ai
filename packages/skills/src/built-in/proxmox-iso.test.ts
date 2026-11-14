import { describe, it, expect } from 'vitest';
import { ProxmoxSkill } from './proxmox.js';

// v1865 — PKI-Lab: SQL-ISO als CD einlegen/auswerfen; nie eine Platte anfassen
function welt(cfg: Record<string, string>, pending: Array<{ key: string; value?: unknown; pending?: unknown; delete?: number }>, nachher?: Array<{ key: string; value?: unknown; pending?: unknown; delete?: number }>) {
  const px = new ProxmoxSkill({ baseUrl: 'https://pve:8006', tokenId: 't', tokenSecret: 's' } as never);
  const a = px as unknown as Record<string, unknown>;
  const posts: Array<{ p: string; b: Record<string, unknown> }> = [];
  let geschrieben = false;
  a.getAllVms = async () => [{ vmid: 157, name: 'labsrv01', node: 'pve', type: 'qemu' }];
  a.get = async (p: string) => {
    if (p.includes('/storage/local/content')) return [{ volid: 'local:iso/SQLServer2025-x64-ENU-EntDev.iso' }];
    if (p.endsWith('/config')) return cfg;
    if (p.endsWith('/pending')) return geschrieben && nachher ? nachher : pending;
    return null;
  };
  a.post = async (p: string, b: Record<string, unknown>) => { posts.push({ p, b }); geschrieben = true; return 'UPID:x'; };
  a.aufgabeOderFehler = async () => undefined;
  return { px, posts };
}
const ctx = { ausChange: true } as never;
const ISO = 'local:iso/SQLServer2025-x64-ENU-EntDev.iso';

describe('v1865 attach_iso / detach_iso', () => {
  it('nur in Changes', async () => {
    const { px } = welt({}, []);
    expect((await px.execute({ action: 'attach_iso', vmid: 157, volid: ISO }, {} as never)).success).toBe(false);
  });
  it('legt ein; an laufender VM ohne Laufwerk: ausstehend → „wirksam erst nach reboot_vm“', async () => {
    const { px, posts } = welt({}, [], [{ key: 'ide2', pending: `${ISO},media=cdrom` }]);
    const r = await px.execute({ action: 'attach_iso', vmid: 157, volid: ISO }, ctx);
    expect(r.display, String(r.error)).toContain('ISO_ATTACHED');
    expect(r.display).toContain('wirksam erst nach reboot_vm');
    expect(posts[0]!.b).toEqual({ ide2: `${ISO},media=cdrom` });
  });
  it('fremdes Volume, unbekanntes ISO und eine Platte im Laufwerk werden abgewiesen', async () => {
    expect((await welt({}, []).px.execute({ action: 'attach_iso', vmid: 157, volid: 'local:iso/gibtsnicht.iso' }, ctx)).error).toContain('liegt nicht im Speicher');
    expect((await welt({}, []).px.execute({ action: 'attach_iso', vmid: 157, volid: 'data2-pve:vm-157-disk-1' }, ctx)).error).toContain('volid');
    const platte = welt({ ide2: 'data2-pve:vm-157-disk-2,size=10G' }, []);
    expect((await platte.px.execute({ action: 'attach_iso', vmid: 157, volid: ISO }, ctx)).error).toContain('kein CD-Laufwerk');
    expect(platte.posts).toHaveLength(0);
  });
  it('wirft aus — nur ein CD-Laufwerk; fehlt es, „schon weg“', async () => {
    const cd = welt({}, [{ key: 'ide2', value: `${ISO},media=cdrom` }], []);
    const r = await cd.px.execute({ action: 'detach_iso', vmid: 157 }, ctx);
    expect(r.display, String(r.error)).toContain('ISO_DETACHED');
    expect(cd.posts[0]!.b).toEqual({ delete: 'ide2' });
    const platte = welt({}, [{ key: 'ide2', value: 'data2-pve:vm-157-disk-2,size=10G' }]);
    expect((await platte.px.execute({ action: 'detach_iso', vmid: 157 }, ctx)).error).toContain('kein CD-Laufwerk');
    expect(platte.posts).toHaveLength(0);
    expect((await welt({}, []).px.execute({ action: 'detach_iso', vmid: 157 }, ctx)).display).toContain('schon weg');
  });
});
