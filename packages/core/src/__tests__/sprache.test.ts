import { describe, it, expect } from 'vitest';
import { sprachfassung, istSprachnachricht, SPRACHFASSUNG_MAX_ZEICHEN } from '../interaktion/sprache.js';

// v1202 — Jarvis Interaktion: gesprochene Antwort auf Sprachnachricht, knapp und ohne Markdown.
describe('sprachfassung', () => {
  it('entfernt Markdown, Listen, Links und Emojis und macht Sätze daraus', () => {
    const t = sprachfassung('**Heute:**\n- 🔋 Batterie Terrasse 0 %\n- Termin um 14:00 ([Kalender](https://x.y/z))\n\nMehr unter https://example.org/a `code`');
    expect(t).toContain('Batterie Terrasse 0 %');
    expect(t).toContain('Termin um 14:00 (Kalender)');
    expect(t).toContain('Link im Chat');
    expect(t).not.toMatch(/[*`#\[\]]|https?:|🔋|\n/);
  });
  it('kürzt lange Antworten an einer Satzgrenze und verweist auf den Chat', () => {
    const lang = Array.from({ length: 40 }, (_, i) => `Satz Nummer ${i + 1} mit etwas Inhalt.`).join(' ');
    const t = sprachfassung(lang);
    expect(t.length).toBeLessThanOrEqual(SPRACHFASSUNG_MAX_ZEICHEN + 20);
    expect(t.endsWith('Mehr dazu im Chat.')).toBe(true);
    expect(t).toMatch(/Inhalt\. Mehr dazu im Chat\.$/);
  });
  it('kurze Texte bleiben unverändert', () => {
    expect(sprachfassung('Alles ruhig, keine Meldungen.')).toBe('Alles ruhig, keine Meldungen.');
  });
});

describe('istSprachnachricht', () => {
  it('erkennt Audio-Anlagen', () => {
    expect(istSprachnachricht([{ type: 'audio' }])).toBe(true);
    expect(istSprachnachricht([{ type: 'image' }])).toBe(false);
    expect(istSprachnachricht(undefined)).toBe(false);
  });
});
