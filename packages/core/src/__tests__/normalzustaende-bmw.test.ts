import { describe, it, expect } from 'vitest';
import { deuteBmw, verschmelzeSnapshots, letzteBewegung, type BmwSnapshot, type BmwVerlaufPunkt } from '../normalzustaende/bmw.js';

// Jarvis Schicht 1, Quelle BMW — gegen die Realdaten vom 05.10.2026 (bmw_telematic_log).

const f = (value: string | number, timestamp?: string) => ({ value: String(value), unit: '', timestamp });

const MQTT_0310: BmwSnapshot = {
  source: 'mqtt', createdAt: '2026-10-03T14:28:38.114Z',
  data: {
    'vehicle.vehicle.travelledDistance': f(63995, '2026-10-03T14:28:32Z'),
    'vehicle.drivetrain.batteryManagement.header': f(56, '2026-10-03T14:28:32Z'),
    'vehicle.drivetrain.lastRemainingRange': f(230, '2026-10-03T14:28:32Z'),
    'vehicle.cabin.door.status': f('SECURED', '2026-10-03T14:28:32Z'),
    'vehicle.body.chargingPort.status': f('DISCONNECTED', '2026-10-03T14:28:32Z'),
    'vehicle.drivetrain.electricEngine.charging.status': f('NOCHARGING', '2026-10-03T14:28:32Z'),
    'vehicle.chassis.axle.row1.wheel.left.tire.pressure': f(260), 'vehicle.chassis.axle.row1.wheel.left.tire.pressureTarget': f(250),
    'vehicle.chassis.axle.row1.wheel.right.tire.pressure': f(250), 'vehicle.chassis.axle.row1.wheel.right.tire.pressureTarget': f(250),
    'vehicle.cabin.window.row1.driver.status': f('CLOSED'), 'vehicle.body.trunk.isOpen': f('false'),
  },
};
const REST_0510: BmwSnapshot = {
  source: 'rest', createdAt: '2026-10-05T00:00:25.110Z',
  data: {
    'vehicle.vehicle.travelledDistance': f(64093, '2026-10-04T16:28:04.000Z'),
    'vehicle.drivetrain.batteryManagement.header': f(30, '2026-10-04T16:28:04.000Z'),
    'vehicle.drivetrain.electricEngine.remainingElectricRange': f(138, '2026-10-04T16:28:04.000Z'),
    'vehicle.powertrain.electric.battery.stateOfCharge.target': f(80),
    'vehicle.drivetrain.electricEngine.charging.status': f('NOCHARGING', '2026-10-04T16:28:04.000Z'),
  },
};
// REST-Verlauf: 04.10. bis 09:30 UTC 63995, ab 18:00 UTC 64093
const VERLAUF_0410: BmwVerlaufPunkt[] = [
  { createdAt: '2026-10-04T04:00:02Z', km: 63995, kmZeit: '2026-10-03T14:28:32Z' },
  { createdAt: '2026-10-04T09:30:26Z', km: 63995, kmZeit: '2026-10-03T14:28:32Z' },
  { createdAt: '2026-10-04T18:00:40Z', km: 64093, kmZeit: '2026-10-04T16:28:04Z' },
  { createdAt: '2026-10-04T23:30:10Z', km: 64093, kmZeit: '2026-10-04T16:28:04Z' },
];
const NOW = new Date('2026-10-05T00:25:00Z');

describe('verschmelzeSnapshots', () => {
  it('Realfall: je Feld gewinnt der jüngere Zeitstempel — SoC 30 (REST) statt 56 (altes MQTT)', () => {
    const m = verschmelzeSnapshots(MQTT_0310, REST_0510);
    expect(m['vehicle.drivetrain.batteryManagement.header'].value).toBe('30');
    expect(m['vehicle.drivetrain.batteryManagement.header'].quelle).toBe('rest');
    expect(m['vehicle.vehicle.travelledDistance'].value).toBe('64093');
    // Felder, die nur MQTT kennt, bleiben erhalten
    expect(m['vehicle.cabin.door.status'].value).toBe('SECURED');
  });
});

describe('letzteBewegung', () => {
  it('Ende der letzten Fahrt = Fahrzeugzeit des ersten Punkts mit neuem Stand', () => {
    expect(letzteBewegung(VERLAUF_0410)).toEqual({ ende: '2026-10-04T16:28:04Z', von: 63995, bis: 64093 });
  });
  it('ohne Bewegung: keineBewegungSeit = ältester Punkt', () => {
    expect(letzteBewegung([{ createdAt: '2026-10-01T00:00:00Z', km: 5 }, { createdAt: '2026-10-02T00:00:00Z', km: 5 }])).toEqual({ keineBewegungSeit: '2026-10-01T00:00:00Z' });
  });
});

describe('deuteBmw', () => {
  it('Realfall 05.10.: Fahrzeug fuhr NACH der letzten MQTT-Meldung → Stream-Verdacht statt „Daten alt"', () => {
    const d = deuteBmw({ mqtt: MQTT_0310, rest: REST_0510, verlauf: VERLAUF_0410, now: NOW })!;
    expect(d.zustand.streamVerdacht).toBe(true);
    expect(d.zustand.steht).toBe(true);
    expect(d.zustand.soc).toBe(30);
    expect(d.zustand.letzteFahrtKm).toEqual({ von: 63995, bis: 64093 });
    const text = d.zeilen.join('\n');
    expect(text).toMatch(/MQTT-Stream lieferte NICHTS, obwohl das Fahrzeug .* gefahren ist/);
    expect(text).toMatch(/bmw-streaming prüfen/);
    expect(text).toMatch(/Ladestand \(SoC\):\*\* 30 % \(Ladeziel 80 %\)/);
    // KG-Extraktor-Kompatibilität (knowledge-graph.ts extractFromVehicle)
    expect(text.match(/(?:Battery|Akku|SoC)\)?[*:\s]*(\d+)\s*%/i)?.[1]).toBe('30');
    expect(text.match(/(?:Range|Reichweite)\)?[*:\s]*(\d+)\s*km/i)?.[1]).toBe('138');
    expect(/(?:charging|lädt|connected|verbunden)/i.test(text)).toBe(false);
    expect(text).toMatch(/REST-Abruf aktuell/);
    expect(text).not.toMatch(/Daten \d+ Min alt/);
  });

  it('Realfall MQTT-Korrektur: Fahrzeug steht seit Tagen, MQTT 3 Tage still → NORMAL, nichts zu melden', () => {
    const rest: BmwSnapshot = { ...REST_0510, data: { ...REST_0510.data, 'vehicle.vehicle.travelledDistance': f(64093, '2026-10-01T10:00:00Z') } };
    const mqtt: BmwSnapshot = { ...MQTT_0310, createdAt: '2026-10-01T10:05:00Z', data: { ...MQTT_0310.data, 'vehicle.vehicle.travelledDistance': f(64093, '2026-10-01T10:00:00Z') } };
    const verlauf: BmwVerlaufPunkt[] = [
      { createdAt: '2026-10-02T00:00:00Z', km: 64093 }, { createdAt: '2026-10-03T00:00:00Z', km: 64093 }, { createdAt: '2026-10-04T00:00:00Z', km: 64093 },
    ];
    const d = deuteBmw({ mqtt, rest, verlauf, now: new Date('2026-10-04T12:00:00Z') })!;
    expect(d.zustand.streamVerdacht).toBe(false);
    const text = d.zeilen.join('\n');
    expect(text).toMatch(/MQTT-Stream still seit .* NORMAL: der Stream sendet nur bei aktivem Fahrzeug/);
    expect(text).toMatch(/steht ohne Bewegung mindestens seit/);
    expect(text).not.toMatch(/⚠️/);
  });

  it('REST-Abruf > 90 min alt → ausgefallen; unverriegelt im Stand > 60 min → Warnung; Reifendruck-Abweichung', () => {
    const rest: BmwSnapshot = {
      source: 'rest', createdAt: '2026-10-04T20:00:00Z',
      data: {
        'vehicle.vehicle.travelledDistance': f(64093, '2026-10-04T16:28:04Z'),
        'vehicle.access.centralLocking.isLocked': f('false', '2026-10-04T16:28:04Z'),
        'vehicle.chassis.axle.row2.wheel.left.tire.pressure': f(200, '2026-10-04T16:28:04Z'),
        'vehicle.chassis.axle.row2.wheel.left.tire.pressureTarget': f(250),
      },
    };
    const d = deuteBmw({ rest, verlauf: VERLAUF_0410, now: NOW })!;
    expect(d.zustand.restAusgefallen).toBe(true);
    expect(d.zustand.verriegelt).toBe(false);
    const text = d.zeilen.join('\n');
    expect(text).toMatch(/⚠️ REST-Abruf ausgefallen: letzter vor 4 h/);
    expect(text).toMatch(/⚠️ UNVERRIEGELT seit/);
    expect(text).toMatch(/Reifendruck abweichend: row2 left: 200 statt 250/);
    expect(text).toMatch(/kein MQTT-Stream-Snapshot/);
  });

  it('fährt gerade: Fahrtende jünger als ein REST-Takt', () => {
    const rest: BmwSnapshot = { source: 'rest', createdAt: '2026-10-05T00:20:00Z', data: { 'vehicle.vehicle.travelledDistance': f(64120, '2026-10-05T00:18:00Z') } };
    const d = deuteBmw({ rest, verlauf: VERLAUF_0410, now: NOW })!;
    expect(d.zustand.steht).toBe(false);
    expect(d.zeilen[0]).toMatch(/fährt gerade/);
  });

  it('v1176 Stream-Zustand: getrennt mit geplantem Reconnect = NORMAL; getrennt ohne Reconnect = ⚠️ (Realfall 04.10.)', () => {
    const basis = { mqtt: MQTT_0310, rest: REST_0510, verlauf: VERLAUF_0410, now: NOW };
    const geplant = deuteBmw({ ...basis, stream: { enabled: true, aktiv: false, reconnectFaelligAt: '2026-10-05T00:26:00Z' } })!;
    expect(geplant.zeilen.join('\n')).toMatch(/Stream-Verbindung getrennt, Reconnect .* ↳ NORMAL/);
    expect(geplant.zustand.streamGetrennt).toBeUndefined();
    const haengt = deuteBmw({ ...basis, stream: { enabled: true, aktiv: false, letzterFehler: 'Keepalive timeout' } })!;
    expect(haengt.zeilen.join('\n')).toMatch(/⚠️ Stream-Verbindung getrennt OHNE geplanten Reconnect \(letzter Fehler: Keepalive timeout\) → Wächter startet neu/);
    expect(haengt.zustand.streamGetrennt).toBe(true);
    const aktiv = deuteBmw({ ...basis, stream: { enabled: true, aktiv: true, letzteDatenAt: '2026-10-03T14:28:38Z' } })!;
    expect(aktiv.zeilen.join('\n')).toMatch(/Stream-Verbindung aktiv \(letzte Daten 03\.10\./);
  });

  it('ohne Snapshots: undefined', () => {
    expect(deuteBmw({ verlauf: [], now: NOW })).toBeUndefined();
  });
});
