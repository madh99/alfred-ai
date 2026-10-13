import { describe, it, expect } from 'vitest';
import { objektTreffer, objektWechsel, vorgangSignatur, type HinweisObjekt } from '../insights/objekt-hinweis.js';
import { istMetaText } from '../insights/hinweis-pruefung.js';
import { ZustellProtokoll } from '../zustellung/protokoll.js';
import { mkdtempSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const o = (titel: string, text = '', frist?: string): HinweisObjekt => ({ art: 'vorgang', id: titel.slice(0, 8), titel, text, signatur: 'offen|owner entscheidet|user', frist });
const VORGAENGE = [
  o('Proxmox-Replikation schlägt fehl'),
  o('Erinnerung: Domains noahhabel.com/.at bei easyname verlängern (Frist 18.10. 10:00)'),
  o('Fenster von Lena prüfen: Laut Analyse seit 12:01 offen, Lena ist abwesend'),
  o('Office-VM (windows): getrennt seit 3 h 42 min'),
  o('Temp Terrasse Batterie: 0 % leer → Batterie tauschen'),
];

describe('v1428 Objekt-Hinweise (V1)', () => {
  it('Realfälle 12./13.10. finden ihren Vorgang', () => {
    expect(objektTreffer('2. **Proxmox-Replikation 103-1 / 107-1:** Beide Jobs (Schedule */30) sind fehlgeschlagen.', VORGAENGE)?.objekt.titel).toBe('Proxmox-Replikation schlägt fehl');
    expect(objektTreffer('- **Domains noahhabel.com/.at bei easyname verlängern** – Frist 18.10., 10:00. Jetzt im easyname-Konto verlängern.', VORGAENGE)?.objekt.titel).toContain('noahhabel');
    expect(objektTreffer('2. **Fenster von Lena seit 12:01 offen, Lena abwesend** — Schließen bzw. Kontaktsensor-Status prüfen.', VORGAENGE)?.objekt.titel).toContain('Lena');
    expect(objektTreffer('3. **Temp Terrasse Batterie bei 0 %** — Batterie tauschen', VORGAENGE)?.objekt.titel).toContain('Terrasse');
  });

  it('fremde Themen bleiben frei (Strompreis, Geburtstag, anderes Ereignis zum Gerät)', () => {
    expect(objektTreffer('Strompreise für morgen (14.10.) liegen vor: günstigstes Fenster 02:00–05:00.', VORGAENGE)).toBeNull();
    expect(objektTreffer('Morgen hat Alexandra Geburtstag.', VORGAENGE)).toBeNull();
    expect(objektTreffer('Office-VM wieder verbunden.', VORGAENGE)).toBeNull(); // nur 1 gemeinsames Titelwort → neuer Stand wird zugestellt
  });

  it('Zustandswechsel: neu, geändert, Frist < 24 h — sonst nicht', () => {
    const jetzt = Date.parse('2026-10-17T12:00:00Z');
    const v = o('X Y', '', '2026-10-18T08:00:00Z');
    expect(objektWechsel(v, undefined, jetzt)).toBe('neu');
    expect(objektWechsel(v, { signatur: v.signatur }, Date.parse('2026-10-14T12:00:00Z'))).toBeNull();
    expect(objektWechsel(v, { signatur: v.signatur }, jetzt)).toBe('frist');
    expect(objektWechsel(v, { signatur: v.signatur, frist: true }, jetzt)).toBeNull();
    expect(objektWechsel(v, { signatur: 'wartet|x|user' }, jetzt)).toBe('geaendert');
    expect(vorgangSignatur({ status: 'offen', naechsterSchritt: ' Owner entscheidet ', besitzer: 'user' })).toBe('offen|owner entscheidet|user');
  });

  it('Erzählung des Modells (Realfälle 13.10.) ist kein Hinweis', () => {
    expect(istMetaText('Ausgelassen habe ich unter anderem die Wallbox-, Shelly-, Hausbatterie- und pinkribbons-Themen.')).toBe(true);
    expect(istMetaText('Die beiden Vorab-Auffälligkeiten (Proxmox-Replikation und Domain-Verlängerung) habe ich nachgeprüft.')).toBe(true);
    expect(istMetaText('Proxmox-Replikation 103-1 schlägt seit 08:00 fehl.')).toBe(false);
  });

  it('Zähler „Nicht zugestellt" übersteht einen Neustart', () => {
    const datei = path.join(mkdtempSync(path.join(os.tmpdir(), 'alfred-zp-')), 'zp.json');
    const a = new ZustellProtokoll(); a.dauerhaft(datei); a.merke('wiederholung', 3);
    const b = new ZustellProtokoll(); b.merke('vorrede'); b.dauerhaft(datei);
    expect(b.zaehlung24h()).toEqual({ wiederholung: 3, vorrede: 1 });
  });
});
