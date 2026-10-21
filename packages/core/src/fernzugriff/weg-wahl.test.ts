import { describe, it, expect } from 'vitest';
import { fachskillHinweis, fernzugangHinweis, namenMuster, wegErfahrungen } from './weg-wahl.js';

// v1550 (S4) — Skill oder SSH bewusst wählen
describe('v1550 Weg-Wahl', () => {
  it('(a) Host-Namen der Fernzugänge als ganze Wörter', () => {
    const m = namenMuster(['pve', 'pve1', 'pve3', 'dockerhost', 'docker-host', 'x'])!; // Zugangs- und CMDB-Namen
    for (const t of ['pve3 hat Probleme', 'was ist mit dem Dockerhost los?', 'Auf PVE läuft was komisch', 'docker-host prüfen']) expect(m.test(t), t).toBe(true);
    for (const t of ['pvestatd ist gut', 'npve2', 'mein Haus']) expect(m.test(t), t).toBe(false);
    expect(namenMuster([])).toBeUndefined();
  });
  it('(c) Hinweise in beide Richtungen', () => {
    expect(fachskillHinweis('pve', ['proxmox', 'unbekannt'])).toContain('Proxmox-Skill: VM-/Container-Status clusterweit');
    expect(fachskillHinweis('nas', ['unbekannt'])).toBeUndefined();
    expect(fernzugangHinweis(['pve', 'dockerhost'])).toContain('Fernzugang: pve, dockerhost');
    expect(fernzugangHinweis([])).toBeUndefined();
  });
  it('(d) Fachskill versagt, SSH liefert → Erfahrung; umgekehrt ebenso', () => {
    const e = wegErfahrungen([
      { name: 'proxmox', input: { action: 'vm_status', vm: 'git-server' }, isError: true, inhalt: 'Proxmox API 500' },
      { name: 'fernzugriff', input: { action: 'lesen', name: 'pve', befehl: 'qm config 101' }, isError: false, inhalt: 'memory: 4096' },
    ], 'Warum braucht der git-server so viel RAM?');
    expect(e).toHaveLength(1);
    expect(e[0]!.key).toBe('weg:proxmox.vm_status→fernzugriff:qm');
    expect(e[0]!.text).toContain('half proxmox.vm_status nicht (Proxmox API 500); fernzugriff lesen `qm config 101` auf pve lieferte');
    const r = wegErfahrungen([
      { name: 'fernzugriff', input: { action: 'lesen', name: 'dockerhost', befehl: 'cat /config/home-assistant.log' }, isError: true, inhalt: 'Exit 1: No such file or directory' },
      { name: 'homeassistant', input: { action: 'history' }, isError: false, inhalt: '12 Zustandswechsel' },
    ], 'Wann ging das Licht an?');
    expect(r[0]!.key).toBe('weg:fernzugriff.lesen→homeassistant.history');
  });
  it('(d) keine Erfahrung bei Rückfrage, Geheimnis, gleichem Weg oder ohne Erfolg', () => {
    expect(wegErfahrungen([
      { name: 'fernzugriff', input: { action: 'lesen', name: 'pve', befehl: 'cat .env' }, isError: true, inhalt: '„cat .env“ berührt .env-Dateien — das läuft nur mit Bestätigung des Owners' },
      { name: 'proxmox', input: { action: 'list_vms' }, isError: false, inhalt: '| 101 | git-server |' },
    ], 'x')).toHaveLength(0);
    expect(wegErfahrungen([
      { name: 'proxmox', input: { action: 'vm_status' }, isError: true, inhalt: 'Fehler' },
      { name: 'proxmox', input: { action: 'list_vms' }, isError: false, inhalt: 'ok' },
    ], 'x')).toHaveLength(0);
    expect(wegErfahrungen([
      { name: 'proxmox', input: { action: 'vm_status' }, isError: true, inhalt: 'Fehler' },
      { name: 'fernzugriff', input: { action: 'ausfuehren', name: 'pve', befehl: 'qm start 1' }, isError: false, inhalt: 'Zur Bestätigung an den Owner gestellt' },
    ], 'x')).toHaveLength(0);
  });
});
