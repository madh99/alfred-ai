import { describe, it, expect } from 'vitest';
import { stripGoalPrefix } from './project-agent-skill.js';

describe('stripGoalPrefix', () => {
  it('strips "Starte einen NEUEN Projekt-Agent-Lauf für"', () => {
    const input = 'Starte einen NEUEN Projekt-Agent-Lauf für Alpbyte Games unter /home/madh/projects/alpbyte-games.';
    expect(stripGoalPrefix(input)).toBe('Alpbyte Games unter /home/madh/projects/alpbyte-games.');
  });

  it('strips quoted project name in prefix', () => {
    const input = 'Starte einen NEUEN Projekt-Agent-Lauf für "Alpbyte Games" unter /root/alpbyte-games.';
    expect(stripGoalPrefix(input)).toMatch(/^Alpbyte Games/);
  });

  it('strips "Bitte starte"', () => {
    expect(stripGoalPrefix('Bitte starte ein Projekt zur DSGVO-Doku.')).toBe('ein Projekt zur DSGVO-Doku.');
  });

  it('strips multiple layered prefixes', () => {
    const input = 'Bitte Starte einen NEUEN Projekt-Agent-Lauf für "MyApp" mit Next.js.';
    expect(stripGoalPrefix(input)).toMatch(/MyApp/);
    expect(stripGoalPrefix(input)).not.toMatch(/Starte/i);
    expect(stripGoalPrefix(input)).not.toMatch(/Bitte/i);
  });

  it('leaves goals without boilerplate untouched', () => {
    const original = 'Erstelle eine Landing-Page für das neue Produkt mit Next.js und Tailwind.';
    expect(stripGoalPrefix(original)).toBe(original);
  });

  it('strips "Erstelle ein neues Projekt für"', () => {
    expect(stripGoalPrefix('Erstelle ein neues Projekt für eine Game-Webapp.'))
      .toBe('eine Game-Webapp.');
  });

  it('strips "Bitte" even when alone in front of a continuation', () => {
    expect(stripGoalPrefix('Bitte starte ein Projekt')).toBe('ein Projekt');
  });

  it('returns original when stripping would leave empty string', () => {
    // Pure boilerplate ohne Inhalt → bleibt unverändert
    expect(stripGoalPrefix('Bitte')).toBe('Bitte');
  });

  it('handles trim and surrounding whitespace', () => {
    expect(stripGoalPrefix('   Bitte starte ein Projekt   ')).toBe('ein Projekt');
  });
});
