import { describe, expect, it } from 'vitest';
import { stabileReihe, WERKZEUG_RUHE_MS } from './message-pipeline.js';

const m = (...n: string[]) => n.map(name => ({ name }));
const namen = (x: Array<{ name: string }>) => x.map(y => y.name);

describe('v1724 K1b — Werkzeugliste eines Gesprächs nur erweitern', () => {
  const zul = m('infrastruktur', 'fernzugriff', 'proxmox', 'calculator', 'shell', 'weather', 'unifi');
  it('erste Nachricht: Auswahl unverändert', () => {
    expect(namen(stabileReihe(undefined, m('infrastruktur', 'fernzugriff'), zul, 0))).toEqual(['infrastruktur', 'fernzugriff']);
  });
  it('Folgenachricht: bisherige Reihenfolge bleibt, Neues hinten, nichts fällt weg', () => {
    const vorher = { namen: ['infrastruktur', 'fernzugriff', 'proxmox'], zuletzt: 1000 };
    const r = stabileReihe(vorher, m('calculator', 'infrastruktur', 'unifi'), zul, 2000);
    expect(namen(r)).toEqual(['infrastruktur', 'fernzugriff', 'proxmox', 'calculator', 'unifi']);
  });
  it('nicht mehr zulässige Werkzeuge (Rolle) fallen heraus', () => {
    const vorher = { namen: ['infrastruktur', 'shell', 'proxmox'], zuletzt: 1000 };
    const ohneShell = zul.filter(z => z.name !== 'shell');
    expect(namen(stabileReihe(vorher, m('infrastruktur'), ohneShell, 2000))).toEqual(['infrastruktur', 'proxmox']);
  });
  it('nach langer Ruhe beginnt die Reihe neu', () => {
    const vorher = { namen: ['infrastruktur', 'proxmox', 'unifi'], zuletzt: 0 };
    expect(namen(stabileReihe(vorher, m('weather'), zul, WERKZEUG_RUHE_MS + 1))).toEqual(['weather']);
  });
});
