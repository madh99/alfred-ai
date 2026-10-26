import { describe, it, expect } from 'vitest';
import { NginxProxyManagerSkill } from '../built-in/nginx-proxy-manager.js';

// v1687 — Realfall 26.10. (Matrix J Schritt 21): create_host nach Zeitüberschreitung wiederholbar, kein zweiter Host
function welt(hosts: Array<Record<string, unknown>>) {
  const s = new NginxProxyManagerSkill({ baseUrl: 'https://npm', email: 'a@b', password: 'x' } as never);
  const aufrufe: Array<{ m: string; p: string; b?: Record<string, unknown>; t?: number }> = [];
  (s as unknown as { npmFetch: (p: string, o?: RequestInit, t?: number) => Promise<unknown> }).npmFetch = async (p, o, t) => {
    const m = o?.method ?? 'GET';
    aufrufe.push({ m, p, ...(o?.body ? { b: JSON.parse(String(o.body)) } : {}), ...(t ? { t } : {}) });
    if (m === 'GET' && p === '/nginx/proxy-hosts') return hosts;
    if (m === 'GET' && p.startsWith('/nginx/proxy-hosts/')) return { ...hosts.find(h => `/nginx/proxy-hosts/${h.id}` === p), owner: {}, certificate: {} };
    if (m === 'PUT') return {};
    if (m === 'POST') return { id: 99, domain_names: [(JSON.parse(String(o!.body)) as { domain_names: string[] }).domain_names[0]] };
    throw new Error(`unerwartet ${m} ${p}`);
  };
  return { s, aufrufe };
}

describe('v1687 NPM create_host wiederholbar', () => {
  it('vorhandener Host mit gleichem Ziel: übernehmen, ssl_forced/http2 nachziehen, kein POST', async () => {
    const w = welt([{ id: 52, domain_names: ['rtc.3033.at'], forward_host: '10.203.27.2', forward_port: 7880, certificate_id: 76, ssl_forced: 0, http2_support: 0, allow_websocket_upgrade: 1 }]);
    const r = await w.s.execute({ action: 'create_host', domain: 'rtc.3033.at', target_host: '10.203.27.2', target_port: 7880, ssl: true, force_ssl: true }, {} as never);
    expect(r.success).toBe(true);
    expect((r.data as { id: number }).id).toBe(52);
    expect(w.aufrufe.some(a => a.m === 'POST')).toBe(false);
    const put = w.aufrufe.find(a => a.m === 'PUT')!;
    expect(put.b).toMatchObject({ ssl_forced: 1, http2_support: 1, certificate_id: 76 });
    expect(put.b).not.toHaveProperty('owner');
  });
  it('anderes Ziel: abweisen; neuer Host: POST mit langem Zeitlimit', async () => {
    const w = welt([{ id: 52, domain_names: ['rtc.3033.at'], forward_host: '10.0.0.1', forward_port: 80 }]);
    expect((await w.s.execute({ action: 'create_host', domain: 'rtc.3033.at', target_host: '10.203.27.2', target_port: 7880 }, {} as never)).success).toBe(false);
    const n = await w.s.execute({ action: 'create_host', domain: 'neu.3033.at', target_host: '10.203.27.2', target_port: 8090 }, {} as never);
    expect(n.success).toBe(true);
    expect(w.aufrufe.find(a => a.m === 'POST')!.t).toBe(180_000);
  });
});
