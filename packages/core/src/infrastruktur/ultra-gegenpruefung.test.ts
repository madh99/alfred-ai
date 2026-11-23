import { describe, it, expect } from 'vitest';
import { leseBefunde, gegenpruefungNoetig, vermerkText, gegenpruefungFrage, gegenpruefungAusloeser, istProduktiv } from './ultra-gegenpruefung.js';

describe('Spec Stufe ultra U2.2 — Gegenprüfung (reine Teile)', () => {
  it('nur Risiko high und critical (O1)', () => {
    expect(gegenpruefungNoetig('high')).toBe(true);
    expect(gegenpruefungNoetig('critical')).toBe(true);
    expect(gegenpruefungNoetig('medium')).toBe(false);
    expect(gegenpruefungNoetig('low')).toBe(false);
    expect(gegenpruefungNoetig(undefined)).toBe(false);
  });

  it('liest JSON auch im Code-Block, verwirft zu kurze Befunde, begrenzt auf 8', () => {
    const viele = Array.from({ length: 12 }, (_, i) => ({ bezug: `Schritt ${i + 1}`, text: `Mangel Nummer ${i + 1} mit Folge` }));
    expect(leseBefunde('```json\n' + JSON.stringify({ befunde: viele }) + '\n```')).toHaveLength(8);
    expect(leseBefunde('{"befunde":[{"bezug":"Schritt 3","text":"kurz"},{"text":"Rückweg fehlt für das Anlegen der VM"}]}'))
      .toEqual([{ bezug: 'gesamt', text: 'Rückweg fehlt für das Anlegen der VM' }]);
    expect(leseBefunde('{"befunde":[]}')).toEqual([]);
  });

  it('unlesbar → undefined (fail-closed)', () => {
    expect(leseBefunde('Der Plan sieht gut aus.')).toBeUndefined();
    expect(leseBefunde('{"ergebnis": "ok"}')).toBeUndefined();
    expect(leseBefunde('{kaputt')).toBeUndefined();
  });

  it('Vermerk und Frage', () => {
    expect(vermerkText({ fingerabdruck: 'x', befunde: 0, zeit: '' })).toBe('Von ultra gegengeprüft: keine Befunde.');
    expect(vermerkText({ fingerabdruck: 'x', befunde: 2, zeit: '' })).toContain('2 Befunde');
    expect(gegenpruefungFrage({ id: 'abcdef1234', title: 'T', riskLevel: 'high' }, { schritte: [] })).toContain('Change abcdef12 „T“ (Risiko high)');
  });
});

describe('Owner 22.11. G1/K1 — feste Auslöser der Gegenprüfung', () => {
  const aendern = (skill: string, aktion: string) => ({ art: 'aktion', skill, aktion, parameter: {} });
  const A = [{ id: 'dc', name: 'dc01' }, { id: 'lab', name: 'lab01', environment: 'lab' }, { id: 'web', name: 'web01', environment: 'production' }, { id: 'tst', name: 'tst01', environment: 'test' }];
  it('K1: produktiv ist alles außer ausdrücklich lab/test/development', () => {
    expect(istProduktiv(undefined)).toBe(true);
    expect(istProduktiv('production')).toBe(true);
    expect(istProduktiv('staging')).toBe(true);
    expect(istProduktiv('Lab')).toBe(false);
    expect(istProduktiv('development')).toBe(false);
  });
  it('Risiko high/critical wie bisher', () => {
    expect(gegenpruefungAusloeser({ riskLevel: 'high', schritte: [] }, A)).toBe('Risiko high');
  });
  it('kritischer Skill, ändernd, nicht eingeordnetes Asset → Auslöser', () => {
    expect(gegenpruefungAusloeser({ riskLevel: 'low', schritte: [aendern('windows_ad', 'benutzer_anlegen')], affectedAssetIds: ['dc'] }, A))
      .toBe('ändernder Schritt windows_ad.benutzer_anlegen an dc01 (produktiv)');
  });
  it('ohne betroffene Assets fail-closed; unbekannte ID zählt als produktiv', () => {
    expect(gegenpruefungAusloeser({ riskLevel: 'medium', schritte: [aendern('unifi', 'netz_anlegen')] }, A)).toContain('Ziel ohne Asset-Angabe');
    expect(gegenpruefungAusloeser({ riskLevel: 'low', schritte: [aendern('sql_server', 'ag_anlegen')], affectedAssetIds: ['xyz12345abc'] }, A)).toContain('xyz12345 (produktiv)');
  });
  it('lesende Schritte, pki_lab und reine Lab/Test-Ziele lösen nicht aus', () => {
    expect(gegenpruefungAusloeser({ riskLevel: 'low', schritte: [aendern('windows_ad', 'status')], affectedAssetIds: ['dc'] }, A)).toBeUndefined();
    expect(gegenpruefungAusloeser({ riskLevel: 'low', schritte: [aendern('pki_lab', 'ca_installieren')], affectedAssetIds: ['dc'] }, A)).toBeUndefined();
    expect(gegenpruefungAusloeser({ riskLevel: 'low', schritte: [aendern('proxmox', 'set_vm_config')], affectedAssetIds: ['lab', 'tst'] }, A)).toBeUndefined();
  });
  it('nicht kritischer Skill nur an ausdrücklich produktivem Asset', () => {
    expect(gegenpruefungAusloeser({ riskLevel: 'low', schritte: [aendern('fernzugriff', 'ausfuehren')], affectedAssetIds: ['dc'] }, A)).toBeUndefined();
    expect(gegenpruefungAusloeser({ riskLevel: 'low', schritte: [aendern('fernzugriff', 'ausfuehren')], affectedAssetIds: ['web', 'lab'] }, A))
      .toBe('ändernder Schritt fernzugriff.ausfuehren an web01 (production)');
  });
  it('G2: Anlass im Vermerk', () => {
    expect(vermerkText({ fingerabdruck: 'x', befunde: 0, zeit: '', grund: 'Risiko high' })).toBe('Von ultra gegengeprüft (Anlass: Risiko high): keine Befunde.');
  });
});

describe('v1934 — Antwortlimit der Gegenprüfung', () => {
  it('Realfall 23.11. (29b2f140): 16.000 Tokens gingen ganz ins Thinking — Limit jetzt 48.000', async () => {
    const m = await import('./ultra-gegenpruefung.js') as { GEGENPRUEFUNG_MAX_TOKENS?: number };
    expect(m.GEGENPRUEFUNG_MAX_TOKENS).toBe(48_000);
  });
});
