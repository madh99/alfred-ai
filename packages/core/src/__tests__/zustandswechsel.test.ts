import { describe, it, expect, vi } from 'vitest';
import { ZustandsWechselErkenner, WeltmodellBeobachter, baueMiniPassPrompt, gateObjekteAus, type WeltmodellEreignis } from '../ereignisse/zustandswechsel.js';
import { bmwAuffaellig } from '../normalzustaende/bmw-lade.js';

const log = () => ({ info: vi.fn(), warn: vi.fn(), debug: vi.fn(), error: vi.fn(), child: vi.fn() }) as never;

describe('ZustandsWechselErkenner', () => {
  it('erster Lauf = Baseline (kein Ereignis); danach neu/weg; unverändert = kein Ereignis', () => {
    const e = new ZustandsWechselErkenner();
    expect(e.vergleiche('sensorbatterien', ['sensorbatterie:terrasse:leer'])).toBeUndefined();
    expect(e.vergleiche('sensorbatterien', ['sensorbatterie:terrasse:leer'])).toBeUndefined();
    expect(e.vergleiche('sensorbatterien', ['sensorbatterie:terrasse:leer', 'sensorbatterie:garage:niedrig']))
      .toEqual({ quelle: 'sensorbatterien', neu: ['sensorbatterie:garage:niedrig'], weg: [] });
    expect(e.vergleiche('sensorbatterien', ['sensorbatterie:garage:niedrig']))
      .toEqual({ quelle: 'sensorbatterien', neu: [], weg: ['sensorbatterie:terrasse:leer'] });
  });
});

describe('WeltmodellBeobachter', () => {
  it('meldet nur NEUE Auffälligkeiten als Ereignis mit Ausschnitt und Gate-Objekten', async () => {
    const melde = vi.fn(async (_e: WeltmodellEreignis) => undefined);
    const b = new WeltmodellBeobachter(log(), melde);
    await b.beobachte('bmw', { zeilen: ['**Datenlage:** MQTT still ↳ NORMAL'], auffaellig: [] });          // Baseline
    await b.beobachte('bmw', { zeilen: ['**Datenlage:** MQTT still ↳ NORMAL'], auffaellig: [] });          // unverändert
    expect(melde).not.toHaveBeenCalled();
    await b.beobachte('bmw', { zeilen: ['**Datenlage:** ⚠️ MQTT-Stream lieferte NICHTS …'], auffaellig: ['mqtt-stream-fehlt'] });
    expect(melde).toHaveBeenCalledTimes(1);
    const e = melde.mock.calls[0][0];
    expect(e.objekte.sort()).toEqual(['mqtt', 'mqtt-stream-fehlt']);
    expect(e.beschreibung).toMatch(/Neu auffällig in bmw: mqtt-stream-fehlt/);
    expect(e.ausschnitt).toHaveLength(1);
    // Verschwinden ist ein Wechsel, aber kein Mini-Pass
    await b.beobachte('bmw', { zeilen: [], auffaellig: [] });
    expect(melde).toHaveBeenCalledTimes(1);
  });
  it('undefined-Deutung wird ignoriert', async () => {
    const b = new WeltmodellBeobachter(log(), vi.fn(async () => undefined));
    expect(await b.beobachte('x', undefined)).toBeUndefined();
  });
});

describe('gateObjekteAus / bmwAuffaellig', () => {
  it('leitet Gate-Objekte ab', () => {
    expect(gateObjekteAus(['mqtt-stream-fehlt', 'mikrotik:r1/ether8:neu-down', 'hausbatterie:niedrig', 'sensorbatterie:x:leer']).sort()).toEqual(['mikrotik', 'mqtt', 'victron']);
  });
  it('bmwAuffaellig aus dem Zustand', () => {
    const z = { steht: true, streamVerdacht: true, restAusgefallen: false, laedt: false, angesteckt: false, offen: ['trunk'], reifenAbweichung: [], verriegelt: false, soc: 15 } as never;
    expect(bmwAuffaellig({ zeilen: [], zustand: z }).sort()).toEqual(['fahrzeug-offen', 'fahrzeug-soc-niedrig', 'fahrzeug-unverriegelt', 'mqtt-stream-fehlt']);
  });
});

describe('baueMiniPassPrompt', () => {
  it('enthält nur Ausschnitt, Ereignis, Datum, Korrekturen und die KEINE_INSIGHTS-Regel', () => {
    const p = baueMiniPassPrompt({ beschreibung: 'Neu auffällig in bmw: mqtt-stream-fehlt', quelle: 'bmw', ausschnitt: ['**Datenlage:** ⚠️ …'], datum: 'Montag, 05.10.2026 10:30', korrekturen: ['MQTT-Datenalter bei stehendem Fahrzeug ist normal'] });
    expect(p).toContain('ZUSTANDSWECHSEL');
    expect(p).toContain('- **Datenlage:** ⚠️ …');
    expect(p).toContain('USER-KORREKTUREN');
    expect(p).toContain('KEINE_INSIGHTS');
    expect(p).not.toContain('Kalender');
  });
});
