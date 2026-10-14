import { describe, it, expect, vi } from 'vitest';
import { ConfirmationQueue } from '../confirmation-queue.js';

// v1450 — Realfall 14.10. 22:27: Neustart freigegeben, der Befehl meldete Fehler (Prüfung zu früh), danach kam nichts mehr.
describe('v1450 Fortsetzung auch nach einer fehlgeschlagenen Freigabe', () => {
  for (const fall of [{ name: 'Fehlschlag → Fortsetzung mit Fehler', ok: false }, { name: 'Erfolg → Fortsetzung wie bisher', ok: true }]) {
    it(fall.name, async () => {
      const pending = { id: 'k1', chatId: 'c1', platform: 'telegram', source: 'geraet', sourceId: 's', description: 'App neu starten', skillName: 'geraet_ubuntu_vm', skillParams: { action: 'shell' }, status: 'pending', createdAt: new Date().toISOString(), expiresAt: new Date(Date.now() + 3_600_000).toISOString() };
      const repo = { getById: vi.fn().mockResolvedValue(pending), getByIdAnyStatus: vi.fn(), findPending: vi.fn().mockResolvedValue([pending]), findPendingBySentMessageId: vi.fn(), resolve: vi.fn().mockResolvedValue(undefined) };
      const adapter = { sendMessage: vi.fn().mockResolvedValue('m'), sendPhoto: vi.fn(), sendFile: vi.fn() };
      const ergebnis = fall.ok ? { success: true, display: 'neu gestartet' } : { success: false, error: 'Befehl endete mit Exit-Code 7\n--- Ausgabe (Ende) ---\nPort 3000 belegt durch node' };
      const q = new ConfirmationQueue(repo as never, { get: () => ({ metadata: { name: 'geraet_ubuntu_vm' } }) } as never, { execute: vi.fn().mockResolvedValue(ergebnis) } as never, new Map([['telegram', adapter]]) as never, { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() } as never);
      const nach = vi.fn().mockResolvedValue(true);
      q.setNachAusfuehrung(nach);
      await q.checkForConfirmation('c1', 'telegram', 'confirm:k1:approve', { userId: 'u', chatId: 'c1', platform: 'telegram' } as never);
      expect(nach).toHaveBeenCalledTimes(1);
      expect(nach.mock.calls[0]![1]).toMatchObject(fall.ok ? { success: true } : { success: false, error: expect.stringContaining('Port 3000 belegt') });
      if (!fall.ok) expect(adapter.sendMessage.mock.calls.some(c => String(c[1]).includes('Aktion fehlgeschlagen'))).toBe(true);
    });
  }
});

// v1454 — Realfall 15.10.: „Nein“ auf der Bestätigungsseite erreichte das Geräte-Projekt nicht (Plan blieb „wartet auf dich“).
describe('v1454 Ablehnung und Ablauf erreichen den Auftraggeber', () => {
  const bau = () => {
    const pending = { id: 'k2', chatId: 'c1', platform: 'telegram', source: 'geraet', sourceId: 'projekt-sat-1-1', description: 'Projekt starten?', skillName: 'project_agent', skillParams: { action: 'satellit_antwort', task_id: 'sat-1', freigabe: 'n1' }, status: 'pending', createdAt: new Date().toISOString(), expiresAt: new Date(Date.now() + 3_600_000).toISOString() };
    const repo = { getById: vi.fn().mockResolvedValue(pending), getByIdAnyStatus: vi.fn(), findPending: vi.fn().mockResolvedValue([pending]), findPendingBySentMessageId: vi.fn(), resolve: vi.fn().mockResolvedValue(undefined), expireOld: vi.fn().mockResolvedValue([pending]) };
    const adapter = { sendMessage: vi.fn().mockResolvedValue('m'), sendPhoto: vi.fn(), sendFile: vi.fn() };
    const execute = vi.fn();
    const q = new ConfirmationQueue(repo as never, { get: () => ({ metadata: { name: 'project_agent' } }) } as never, { execute } as never, new Map([['telegram', adapter]]) as never, { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() } as never);
    const ohne = vi.fn().mockResolvedValue(undefined);
    q.setNachOhneAusfuehrung(ohne);
    return { q, ohne, execute };
  };
  it('Nein → abgelehnt, ohne Ausführung', async () => {
    const { q, ohne, execute } = bau();
    await q.checkForConfirmation('c1', 'telegram', 'confirm:k2:reject', { userId: 'u', chatId: 'c1', platform: 'telegram' } as never);
    await new Promise(r => setTimeout(r, 5));
    expect(execute).not.toHaveBeenCalled();
    expect(ohne).toHaveBeenCalledTimes(1);
    expect(ohne.mock.calls[0]![0]).toMatchObject({ skillName: 'project_agent', skillParams: { task_id: 'sat-1', freigabe: 'n1' } });
    expect(ohne.mock.calls[0]![1]).toBe('abgelehnt');
  });
  it('abgelaufen → abgelaufen', async () => {
    const { q, ohne } = bau();
    await (q as unknown as { expireTick: () => Promise<void> }).expireTick();
    await new Promise(r => setTimeout(r, 5));
    expect(ohne).toHaveBeenCalledTimes(1);
    expect(ohne.mock.calls[0]![1]).toBe('abgelaufen');
  });
});
