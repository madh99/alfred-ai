import { describe, it, expect } from 'vitest';
import { UniFiSkill } from '../built-in/unifi.js';

// Bauplan V4 (nach V4): Vorab-Kontrolle „Netz überschneidet sich mit keinem vorhandenen Netz“ — liest nur rest/networkconf
function welt(netze: Array<Record<string, unknown>> | Error) {
  const s = new UniFiSkill({ baseUrl: 'https://udm', apiKey: 'k', verifyTls: false } as never);
  const aufrufe: Array<{ m: string; p: string }> = [];
  (s as unknown as { request: (m: string, p: string) => Promise<unknown> }).request = async (m, p) => {
    aufrufe.push({ m, p });
    if (netze instanceof Error) throw netze;
    if (m === 'GET' && p === 'rest/networkconf') return netze.map(n => ({ ...n }));
    throw new Error(`unerwartet ${m} ${p}`);
  };
  return { s, aufrufe };
}
const NETZE = [
  { _id: 'n1', name: 'Default', ip_subnet: '192.168.1.1/24' },
  { _id: 'n2', name: 'Keller', ip_subnet: '10.203.28.1/28' },
  { _id: 'n3', name: 'Gast', ip_subnet: '192.168.3.2/24' },
  { _id: 'n4', name: 'WAN', purpose: 'wan' },
];
const pruefe = (w: ReturnType<typeof welt>, subnet: unknown) => w.s.execute({ action: 'subnet_pruefen', subnet }, {} as never);

describe('unifi subnet_pruefen', () => {
  it('kein Überlapp → erste Zeile genau FREI, data.frei true, nur GET', async () => {
    const w = welt(NETZE);
    const r = await pruefe(w, '10.203.29.0/27');
    expect(r.success).toBe(true);
    expect(r.display!.split('\n')[0]).toBe('FREI');
    expect(r.data).toEqual({ frei: true, ueberlappt: [] });
    expect(w.aufrufe).toEqual([{ m: 'GET', p: 'rest/networkconf' }]);
  });

  it('/24 enthält vorhandenes /28 → BELEGT mit Name und ip_subnet, success true', async () => {
    const r = await pruefe(welt(NETZE), '10.203.28.0/24');
    expect(r.success).toBe(true);
    expect(r.display!.split('\n')[0]).toBe('BELEGT: Keller (10.203.28.1/28)');
    expect(r.display).not.toMatch(/^FREI/m);
    expect(r.data).toEqual({ frei: false, ueberlappt: [{ name: 'Keller', ip_subnet: '10.203.28.1/28' }] });
  });

  it('/28 liegt in vorhandenem /24 (Gateway .2) → BELEGT', async () => {
    const r = await pruefe(welt(NETZE), '192.168.3.16/28');
    expect(r.success).toBe(true);
    expect(r.display!.split('\n')[0]).toBe('BELEGT: Gast (192.168.3.2/24)');
    expect((r.data as { frei: boolean }).frei).toBe(false);
  });

  it('Nachbarnetz direkt dahinter überschneidet nicht; mehrere Überlappungen je eine Zeile', async () => {
    expect((await pruefe(welt(NETZE), '10.203.28.16/28')).display!.split('\n')[0]).toBe('FREI');
    const r = await pruefe(welt([...NETZE, { _id: 'n5', name: 'Labor', ip_subnet: '10.203.28.17/28' }]), '10.203.28.0/27');
    expect(r.display!.split('\n').slice(0, 2)).toEqual(['BELEGT: Keller (10.203.28.1/28)', 'BELEGT: Labor (10.203.28.17/28)']);
    expect((r.data as { ueberlappt: unknown[] }).ueberlappt).toHaveLength(2);
  });

  it('ungültige Eingabe → success false, ohne Abfrage', async () => {
    for (const x of [undefined, '', '10.203.29.1/27', '10.203.29.0', '10.203.29.0/33', '10.203.29.0/7', '300.1.1.0/24', 'a.b.c.d/24', ' 10.203.29.0/27x', '10.203.29.0/27,10.0.0.0/8', 27]) {
      const w = welt(NETZE);
      const r = await pruefe(w, x);
      expect(r.success, String(x)).toBe(false);
      expect(r.error, String(x)).toMatch(/subnet/);
      expect(w.aufrufe).toEqual([]);
    }
  });

  it('Netzliste nicht lesbar → success false; unlesbares ip_subnet → success false statt still FREI', async () => {
    const r = await pruefe(welt(new Error('HTTP 401')), '10.203.29.0/27');
    expect(r.success).toBe(false);
    expect(r.error).toContain('HTTP 401');
    const kaputt = await pruefe(welt([...NETZE, { _id: 'x', name: 'Kaputt', ip_subnet: 'unsinn' }]), '10.203.29.0/27');
    expect(kaputt.success).toBe(false);
    expect(kaputt.error).toContain('Kaputt');
  });

  it('steht im Aktions-Enum und im Eingabeschema', () => {
    const s = welt(NETZE).s;
    const props = (s.metadata.inputSchema as { properties: Record<string, { enum?: string[]; description?: string }> }).properties;
    expect(props.action!.enum).toContain('subnet_pruefen');
    expect(props.subnet!.description).toContain('subnet_pruefen');
  });
});
