import { describe, it, expect } from 'vitest';
import { updateWeiterWarten, UPDATE_START, UPDATE_GRENZEN, type UpdateZaehler } from './satellit-update.js';

/** v1516 — Realfall 19.10.: langes Warten auf den Claude-Code-Auftrag verbrauchte die Grenze für Aktionen → Update aufgegeben. */
describe('v1516 Update-Wartezähler je Grund', () => {
  it('Auftrags-Warten verbraucht die Grenze für Aktionen nicht', () => {
    let z: UpdateZaehler = { ...UPDATE_START };
    for (let i = 0; i < 69; i++) z = updateWeiterWarten(z, 'auftrag')!; // eine Stunde und mehr auf den Auftrag gewartet
    expect(z).toEqual({ aktion: 0, auftrag: 69, nichtBereit: 0 });
    expect(updateWeiterWarten(z, 'aktion')).toEqual({ aktion: 1, auftrag: 69, nichtBereit: 0 }); // vorher: aufgegeben
    expect(updateWeiterWarten(z, 'nichtBereit')).toBeDefined();
  });

  it('jede Grenze gilt für ihren Grund', () => {
    expect(updateWeiterWarten({ ...UPDATE_START, aktion: UPDATE_GRENZEN.aktion }, 'aktion')).toBeUndefined();
    expect(updateWeiterWarten({ ...UPDATE_START, auftrag: UPDATE_GRENZEN.auftrag }, 'auftrag')).toBeUndefined();
    expect(updateWeiterWarten({ ...UPDATE_START, nichtBereit: UPDATE_GRENZEN.nichtBereit }, 'nichtBereit')).toBeUndefined();
  });
});
