import { describe, it, expect, vi } from 'vitest';
import { ConfirmationQueue } from '../confirmation-queue.js';
import { GeraetSkill } from '../geraete/geraet-skill.js';

describe('v1490 Geräte-Skill merkt den Auftrag unter der Sitzung der Anfrage', () => {
  const bau = () => {
    const gemerkt: Array<{ id: string; h: { chatId: string; platform: string } }> = [];
    const s = new GeraetSkill({
      geraetId: 'g', name: 'PC-madh', skillName: 'geraet_pc_madh',
      manifest: { plattform: 'windows', aktionen: [{ name: 'auftrag_starten', beschreibung: 'x', autonomie: 'bestaetigen', parameter: { projekt: { type: 'string' }, auftrag: { type: 'string' } } }] },
      pruefeFreigabe: () => true,
      vorhaben: { anlegen: () => undefined, aktiviere: () => undefined, deckt: () => undefined },
      sendeAktion: async () => ({ success: true, data: { id: '20261016200148-ahs3' } }),
      merkeAuftrag: (id: string, h: { chatId: string; platform: string }) => { gemerkt.push({ id, h }); },
      bestaetigung: async () => true,
    } as never);
    return { s, gemerkt };
  };
  it('nach Freigabe in Telegram: Sitzung der App-Anfrage', async () => {
    const { s, gemerkt } = bau();
    await s.execute({ action: 'auftrag_starten', projekt: 'C:\\x', auftrag: 'a', freigabe: 'n' }, { userId: 'u', chatId: '5060785419', platform: 'telegram', herkunftNachFreigabe: { chatId: 'sitzung:7d9f6a58:mvbc29c0', platform: 'api' } } as never);
    expect(gemerkt).toEqual([{ id: '20261016200148-ahs3', h: expect.objectContaining({ chatId: 'sitzung:7d9f6a58:mvbc29c0', platform: 'api' }) }]);
  });
  it('ohne Freigabe-Herkunft: der eigene Chat wie bisher', async () => {
    const { s, gemerkt } = bau();
    await s.execute({ action: 'auftrag_starten', projekt: 'C:\\x', auftrag: 'a', freigabe: 'n' }, { userId: 'u', chatId: '5060785419', platform: 'telegram' } as never);
    expect(gemerkt[0]!.h).toMatchObject({ chatId: '5060785419', platform: 'telegram' });
  });
});

// v1490 — Realfall 16.10. 22:01: Claude-Code-Auftrag aus dem App-Faden, „Ja“ in Telegram → das Auftragsende kam nur in Telegram an
describe('v1490 Herkunft der Anfrage geht mit in die Ausführung nach der Freigabe', () => {
  const bau = () => {
    const pending = { id: 'k1', chatId: '5060785419', platform: 'telegram', source: 'geraet', sourceId: 's', description: 'Auftrag starten', skillName: 'geraet_pc_madh', skillParams: { action: 'auftrag_starten' }, status: 'pending', createdAt: new Date().toISOString(), expiresAt: new Date(Date.now() + 3_600_000).toISOString() };
    const repo = { getById: vi.fn().mockResolvedValue(pending), getByIdAnyStatus: vi.fn(), findPending: vi.fn().mockResolvedValue([pending]), findPendingBySentMessageId: vi.fn(), resolve: vi.fn().mockResolvedValue(undefined) };
    const adapter = { sendMessage: vi.fn().mockResolvedValue('m'), sendPhoto: vi.fn(), sendFile: vi.fn() };
    const execute = vi.fn().mockResolvedValue({ success: true, data: { id: 'a1' } });
    const q = new ConfirmationQueue(repo as never, { get: () => ({ metadata: { name: 'geraet_pc_madh' } }) } as never, { execute } as never, new Map([['telegram', adapter]]) as never, { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() } as never);
    return { q, execute };
  };
  it('mit gemerkter Herkunft: Kontext trägt herkunftNachFreigabe', async () => {
    const { q, execute } = bau();
    (q as unknown as { herkuenfte: Map<string, unknown> }).herkuenfte.set('k1', { chatId: 'sitzung:7d9f6a58:mvbc29c0', platform: 'api', userId: 'u-app' });
    await q.checkForConfirmation('5060785419', 'telegram', 'confirm:k1:approve', { userId: 'u', chatId: '5060785419', platform: 'telegram' } as never);
    expect(execute).toHaveBeenCalledTimes(1);
    expect(execute.mock.calls[0]![2]).toMatchObject({ chatId: '5060785419', platform: 'telegram', herkunftNachFreigabe: { chatId: 'sitzung:7d9f6a58:mvbc29c0', platform: 'api' } });
  });
  it('ohne Herkunft (Anfrage kam aus demselben Chat): Kontext unverändert', async () => {
    const { q, execute } = bau();
    await q.checkForConfirmation('5060785419', 'telegram', 'confirm:k1:approve', { userId: 'u', chatId: '5060785419', platform: 'telegram' } as never);
    expect(execute.mock.calls[0]![2].herkunftNachFreigabe).toBeUndefined();
  });
});

// v1491 — Realfall 16.10. 22:15: Ordner als `cwd` statt `projekt` → Satellit: „projekt fehlt“
describe('v1491 Projektordner unter anderem Namen', () => {
  it('cwd wird projekt (vor Bestätigung und Ausführung); eigenes pfad und fremde Aktionen bleiben', async () => {
    const { projektParameterAngleichen } = await import('../geraete/geraet-skill.js');
    const a: Record<string, unknown> = { cwd: '/home/madh/claudecode/probe-1490', auftrag: 'x' };
    projektParameterAngleichen(a, { projekt: { type: 'string' }, auftrag: { type: 'string' } });
    expect(a).toEqual({ projekt: '/home/madh/claudecode/probe-1490', auftrag: 'x' });
    const b: Record<string, unknown> = { projekt: '/p', ordner: '/q' };
    projektParameterAngleichen(b, { projekt: { type: 'string' } });
    expect(b.projekt).toBe('/p');
    const c: Record<string, unknown> = { pfad: 'src/a.ts' };
    projektParameterAngleichen(c, { projekt: { type: 'string' }, pfad: { type: 'string' } });
    expect(c).toEqual({ pfad: 'src/a.ts' });
    const d: Record<string, unknown> = { cwd: '/x' };
    projektParameterAngleichen(d, { befehl: { type: 'string' } });
    expect(d).toEqual({ cwd: '/x' });
  });
});
