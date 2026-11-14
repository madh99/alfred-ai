import { describe, it, expect } from 'vitest';
import { ProxmoxSkill, GAST_EINGABE_MAX } from './proxmox.js';

// v1860 — Realfall 14.11. ba47581f Schritt 12: input-data > 65 536 Zeichen → HTTP 400; große Eingaben als Dateiteile
describe('gastPowershell: große Eingaben', () => {
  function welt() {
    const px = new ProxmoxSkill({ baseUrl: 'https://pve:8006', tokenId: 't', tokenSecret: 's' } as never);
    const a = px as unknown as Record<string, unknown>;
    const posts: Array<{ p: string; b: Record<string, unknown> }> = [];
    a.getAllVms = async () => [{ vmid: 156, name: 'pkirestore01', node: 'pve', type: 'qemu' }];
    a.post = async (p: string, b: Record<string, unknown>) => { posts.push({ p, b }); return p.endsWith('/agent/exec') ? { pid: posts.length } : null; };
    a.get = async () => ({ exited: 1, exitcode: 0, 'out-data': 'ok' });
    return { px, posts };
  }
  it('kleine Eingabe weiter über input-data', async () => {
    const { px, posts } = welt();
    await px.gastPowershell(156, 'pkirestore01', 'Write-Output 1', '{"a":1}', 10_000);
    const ex = posts.filter(x => x.p.endsWith('/agent/exec'));
    expect(ex).toHaveLength(1);
    expect(ex[0]!.b['input-data']).toBe('{"a":1}');
  });
  it('große Eingabe: Teile ≤ 61 440 Zeichen, Startskript ohne input-data, Inhalt verlustfrei und nur ASCII', async () => {
    const { px, posts } = welt();
    const gross = JSON.stringify({ kennwort: 'Pä$$wort€', base64: 'A'.repeat(GAST_EINGABE_MAX + 100_000) });
    await px.gastPowershell(156, 'pkirestore01', 'Write-Output 1', gross, 10_000);
    const teile = posts.filter(x => String(x.b.file ?? '').endsWith('.part'));
    expect(teile.length).toBeGreaterThan(3);
    expect(teile.every(t => String(t.b.content).length <= 61_440)).toBe(true);
    const zusammen = Buffer.concat(teile.map(t => Buffer.from(String(t.b.content), 'base64'))).toString('utf8');
    expect(/^[\x00-\x7f]*$/.test(zusammen)).toBe(true);
    expect(JSON.parse(zusammen)).toEqual(JSON.parse(gross));
    const skripte = posts.filter(x => /alfred-[st]-[0-9a-f]{16}\.ps1$/.test(String(x.b.file ?? '')));
    expect(skripte).toHaveLength(2);
    const start = Buffer.from(String(skripte[1]!.b.content), 'base64').toString('utf8');
    expect(start).toContain("& powershell.exe -NoProfile -NonInteractive -File 'C:\\Windows\\Temp\\alfred-s-");
    expect(start).toContain('Remove-Item -LiteralPath $t -Force');
    const ex = posts.filter(x => x.p.endsWith('/agent/exec'));
    expect(ex).toHaveLength(1);
    expect(ex[0]!.b['input-data']).toBeUndefined();
    expect(String((ex[0]!.b.command as string[]).at(-1))).toMatch(/alfred-t-[0-9a-f]{16}\.ps1$/);
  });
});
