import { describe, it, expect } from 'vitest';
import { konventionsZeilen, konventionsBlock, konventionenAendern, konventionenText, changelogAuftrag, changelogPflicht, REGELN_MAX } from '../konventionen.js';

describe('v1426 Projekt-Konventionen', () => {
  it('Zeilen wie der Server-Agent seit v663a, plus eigene Regeln', () => {
    const z = konventionsZeilen({ changelog: { autoUpdate: true }, commits: { convention: 'conventional', scopePolicy: 'required' }, regeln: ['Commits auf Deutsch', '  '] });
    expect(z[0]).toBe('- CHANGELOG.md pflegen (Format: keepachangelog). Trage eine Zeile unter "## [Unreleased]" ein die diese Phase beschreibt (z.B. "### Added/Changed/Fixed").');
    expect(z[1]).toContain('Conventional Commits Format');
    expect(z[1]).toContain('mit Scope');
    expect(z[2]).toBe('- Commits auf Deutsch');
    expect(z).toHaveLength(3);
    expect(konventionsZeilen(undefined)).toEqual([]);
    expect(konventionsBlock({})).toBe('');
    expect(konventionsBlock({ readme: { autoUpdate: true } })).toContain('Projektregeln des Owners');
  });

  it('Ändern: Schalter, Optionen, Regeln hinzufügen/entfernen, fremde Felder und Werte ignoriert', () => {
    let k = konventionenAendern(undefined, { changelog: true, readme: { autoUpdate: true, template: 'minimal' }, commits: { convention: 'conventional', scopePolicy: 'quatsch' }, branching: { strategy: 'gitflow' }, boese: 1 });
    expect(k).toEqual({ changelog: { autoUpdate: true }, readme: { autoUpdate: true, template: 'minimal' }, commits: { convention: 'conventional' } });
    k = konventionenAendern(k, { regel: 'Commits auf Deutsch' });
    k = konventionenAendern(k, { regel: 'Keine neuen Abhängigkeiten ohne Rückfrage' });
    k = konventionenAendern(k, { regel: 'Commits auf Deutsch' }); // Dublette
    expect(k.regeln).toEqual(['Commits auf Deutsch', 'Keine neuen Abhängigkeiten ohne Rückfrage']);
    expect(konventionenAendern(k, { regelEntfernen: 1 }).regeln).toEqual(['Keine neuen Abhängigkeiten ohne Rückfrage']);
    expect(konventionenAendern(k, { regelEntfernen: 'commits auf deutsch' }).regeln).toEqual(['Keine neuen Abhängigkeiten ohne Rückfrage']);
    expect(konventionenAendern(k, { regeln: [] }).regeln).toBeUndefined();
    expect(konventionenAendern({}, { regeln: Array.from({ length: 20 }, (_, i) => `R${i}`) }).regeln).toHaveLength(REGELN_MAX);
    expect(konventionenAendern({ branching: { strategy: 'gitflow' } }, { changelog: false }).branching).toEqual({ strategy: 'gitflow' }); // Bestehendes bleibt
    expect(changelogPflicht(k)).toBe(true);
  });

  it('Anzeige und Changelog-Auftrag', () => {
    expect(konventionenText({ changelog: { autoUpdate: true }, regeln: ['A'] })).toContain('CHANGELOG an (keepachangelog)');
    expect(konventionenText(undefined)).toContain('Keine eigenen Regeln');
    const a = changelogAuftrag({ nr: 2, etappe: 'SPAR', zusammenfassung: 'echte Angebote' });
    expect(a).toContain('Ändere NUR CHANGELOG.md');
    expect(a).toContain('docs(changelog): Etappe 2 nachgetragen');
    expect(a).not.toMatch(/^Etappe \d+:/m);
  });
});
