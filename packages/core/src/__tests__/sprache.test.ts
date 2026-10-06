import { describe, it, expect } from 'vitest';
import { sprachfassung, istSprachnachricht, SPRACHFASSUNG_MAX_ZEICHEN , sprachBloecke, schneideSaetze } from '../interaktion/sprache.js';

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

// v1247 — Streaming-Sprache Stufe 1: Blöcke aus ganzen Sätzen
describe('sprachBloecke', () => {
  it('bündelt Sätze zu Blöcken ab 90 Zeichen, höchstens 6, ohne Satz zu zerschneiden', () => {
    const text = 'Dein PC ist aktiv. Die letzte Eingabe liegt unter einer Minute zurück. Im Vordergrund ist der Browser. Der Akku ist voll. Die CPU liegt bei zwölf Prozent, die GPU bei drei. Alles ruhig.';
    const b = sprachBloecke(text);
    expect(b.length).toBeGreaterThanOrEqual(2);
    expect(b.join(' ')).toBe(text);
    for (const x of b.slice(0, -1)) expect(x.length).toBeGreaterThanOrEqual(90);
    expect(b.every(x => /[.!?]$/.test(x))).toBe(true);
  });
  it('kurzer Text = ein Block; Markdown wird entfernt; leer bleibt leer', () => {
    expect(sprachBloecke('**Kurz.**')).toEqual(['Kurz.']);
    expect(sprachBloecke('')).toEqual([]);
    expect(sprachBloecke('a. '.repeat(100), 20, 3)).toHaveLength(3);
  });
});

// v1248 — Streaming-Sprache Stufe 2: Sätze aus dem wachsenden Puffer
describe('schneideSaetze', () => {
  it('schneidet fertige Sätze ab, bündelt bis min, lässt den unfertigen Rest', () => {
    const r = schneideSaetze('Dein PC ist aktiv. Die letzte Eingabe liegt unter einer Minute zurück. Im Vordergrund ist der Bro', 60);
    expect(r.bloecke).toEqual(['Dein PC ist aktiv. Die letzte Eingabe liegt unter einer Minute zurück.']);
    expect(r.rest).toBe('Im Vordergrund ist der Bro');
  });
  it('Zahlen und Abkürzungen trennen nicht; ohne Satzende kein Block', () => {
    expect(schneideSaetze('Der Wert ist 3.5 Prozent, z. B. heute. Und weiter', 10)).toEqual({ bloecke: ['Der Wert ist 3.5 Prozent, z. B. heute.'], rest: 'Und weiter' });
    expect(schneideSaetze('Noch kein Satzende', 10)).toEqual({ bloecke: [], rest: 'Noch kein Satzende' });
    expect(schneideSaetze('Kurz. ', 60)).toEqual({ bloecke: [], rest: 'Kurz. ' });
  });
});
