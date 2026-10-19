import { describe, it, expect } from 'vitest';
import os from 'node:os';
import path from 'node:path';
import { GeraeteGateway } from './gateway.js';

/** Phase 5 H1 (Spec Geräte §20.5 Punkt 1) — ein Gerät ohne Aktionen (Handy-App) bekommt keinen Skill im Gehirn. */
describe('GeraeteGateway — Skill je Gerät', () => {
  function aufbau() {
    const registriert: string[] = [];
    const skillRegistry = {
      has: (n: string) => registriert.includes(n),
      register: (s: { metadata: { name: string } }) => { registriert.push(s.metadata.name); },
      unregister: (n: string) => { registriert.splice(registriert.indexOf(n), 1); },
    };
    const logger = { info: () => {}, warn: () => {}, error: () => {}, debug: () => {} };
    const gw = new GeraeteGateway({ logger, repo: {}, skillRegistry, serverVersion: 't', ownerUserId: () => 'o', transferOrdner: path.join(os.tmpdir(), 'alfred-test-transfers') } as never);
    const verbindung = (name: string, aktionen: unknown[]) => ({
      eintrag: { id: `id-${name}`, userId: 'o', name, plattform: aktionen.length ? 'windows' : 'ios', manifest: { protokoll: 1, plattform: 'ios', hostname: name, satellitVersion: 'x', aktionen, sinne: [] }, scopes: [], status: 'aktiv', erstellt: '' },
      ws: {}, skillName: `geraet_${name}`, zuletztPuls: 0, verbundenSeit: '', offen: new Map(),
    });
    const registriere = (v: unknown) => (gw as unknown as { registriereSkill(v: unknown): void }).registriereSkill(v);
    return { registriert, registriere, verbindung };
  }

  it('Handy ohne Aktionen: kein geraet_<name>-Skill; Desktop mit Aktionen: Skill wie bisher', () => {
    const { registriert, registriere, verbindung } = aufbau();
    registriere(verbindung('iphone', []));
    expect(registriert).toEqual([]);
    registriere(verbindung('pc', [{ name: 'notiz', beschreibung: 'x', risiko: 'lesen', params: {} }]));
    expect(registriert).toEqual(['geraet_pc']);
  });
});
