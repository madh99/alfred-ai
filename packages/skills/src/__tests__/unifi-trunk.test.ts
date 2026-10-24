import { describe, it, expect, beforeAll } from 'vitest';
import { UniFiSkill, UNIFI_ZEITEN } from '../built-in/unifi.js';

// v1642 — Realfall 24.10. (c89eb974): der Controller schloss das neue Netz auf custom-Ports mit Verzug aus und überschrieb so frische Freigaben
beforeAll(() => { UNIFI_ZEITEN.verteilungMs = 50; UNIFI_ZEITEN.abstandMs = 1; UNIFI_ZEITEN.nachlesenMs = 1; });

function welt(o: { controllerUeberschreibt?: number; verteiltNach?: number } = {}) {
  const s = new UniFiSkill({ baseUrl: 'https://udm', apiKey: 'k', verifyTls: false } as never);
  const netze = [{ _id: 'n825', name: 'Docker-Betrieb', vlan: 825 }];
  const geraet = { _id: 'd1', name: 'US XG 16', mac: 'aa', port_overrides: [{ port_idx: 9, tagged_vlan_mgmt: 'custom', excluded_networkconf_ids: ['n825'] as string[] }] };
  let lesen = 0; let puts = 0; let ueberschreiben = o.controllerUeberschreibt ?? 0;
  (s as unknown as { request: (m: string, p: string, b?: unknown) => Promise<unknown> }).request = async (m, p, b) => {
    if (p === 'rest/networkconf' && m === 'GET') return netze;
    if (p === 'rest/networkconf' && m === 'POST') { netze.push({ _id: 'nNeu', name: 'Neu', vlan: 830 }); return [{ _id: 'nNeu' }]; }
    if (p === 'stat/device') {
      lesen++;
      // Verteilung eines neuen Netzes: erst nach einigen Lesungen trägt der Controller es in die Ausschlüsse ein
      if (o.verteiltNach !== undefined && lesen >= o.verteiltNach && !geraet.port_overrides[0]!.excluded_networkconf_ids.includes('nNeu')) geraet.port_overrides[0]!.excluded_networkconf_ids.push('nNeu');
      // Controller überschreibt eine frische Freigabe (einmalig bzw. n-mal) — erst beim Nachlesen sichtbar
      if (puts > 0 && ueberschreiben > 0 && lesen >= 3) { ueberschreiben--; geraet.port_overrides[0]!.excluded_networkconf_ids = [...new Set([...geraet.port_overrides[0]!.excluded_networkconf_ids, 'n825'])]; }
      return [JSON.parse(JSON.stringify(geraet))];
    }
    if (p === 'rest/device/d1' && m === 'PUT') { puts++; geraet.port_overrides = JSON.parse(JSON.stringify((b as { port_overrides: typeof geraet.port_overrides }).port_overrides)); return {}; }
    throw new Error(`unerwartet ${m} ${p}`);
  };
  return { s, puts: () => puts };
}
const imChange = { ausChange: true } as never;

describe('v1642 UniFi-Trunk gegen verzögerte Controller-Verteilung', () => {
  it('Freigabe hält → ein Schreiben, Erfolg', async () => {
    const w = welt();
    const r = await w.s.execute({ action: 'allow_network_on_port', device: 'US XG 16', switch_port: 9, network_name: 'Docker-Betrieb' }, imChange);
    expect(r.success, r.error).toBe(true);
    expect(w.puts()).toBe(1);
  });
  it('Controller überschreibt einmal → erneut gesetzt, Erfolg', async () => {
    const w = welt({ controllerUeberschreibt: 1 });
    const r = await w.s.execute({ action: 'allow_network_on_port', device: 'US XG 16', switch_port: 9, network_name: 'Docker-Betrieb' }, imChange);
    expect(r.success, r.error).toBe(true);
    expect(w.puts()).toBe(2);
  });
  it('Controller überschreibt dauerhaft → Fehlschlag statt falschem Erfolg', async () => {
    const w = welt({ controllerUeberschreibt: 99 });
    const r = await w.s.execute({ action: 'allow_network_on_port', device: 'US XG 16', switch_port: 9, network_name: 'Docker-Betrieb' }, imChange);
    expect(r.success).toBe(false);
    expect(r.error).toMatch(/wieder überschrieben/);
  });
});
