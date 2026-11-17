import { describe, it, expect } from 'vitest';
import { inhaltAlsText } from './openai.js';

// Realfall 17.11. (v1890/v1891): Fallback mistral-large-latest liefert message.content als Liste von Bausteinen
// (OpenAI-kompatibel, z. B. [{type:'thinking',…},{type:'text',text:'…'}]) — redactSecrets/trim scheiterten mit
// „e.replace is not a function“, jede Antwort im Notbetrieb ging verloren.
describe('inhaltAlsText — Antwortinhalt immer als Text', () => {
  it('Text bleibt Text', () => {
    expect(inhaltAlsText('Hallo')).toBe('Hallo');
  });
  it('null/undefined → leer', () => {
    expect(inhaltAlsText(null)).toBe('');
    expect(inhaltAlsText(undefined)).toBe('');
  });
  it('Liste: nur Text-Bausteine, in Reihenfolge, Denk-Bausteine fallen weg', () => {
    expect(inhaltAlsText([
      { type: 'thinking', thinking: [{ type: 'text', text: 'intern' }] },
      { type: 'text', text: 'Teil 1. ' },
      { type: 'reference', reference_ids: [1] },
      { type: 'text', text: 'Teil 2.' },
    ])).toBe('Teil 1. Teil 2.');
  });
  it('Liste ohne Text-Bausteine → leer, nie „[object Object]“', () => {
    expect(inhaltAlsText([{ type: 'thinking', thinking: [] }])).toBe('');
  });
  it('unbekannte Formen → leer statt Absturz', () => {
    expect(inhaltAlsText({ foo: 1 })).toBe('');
    expect(inhaltAlsText(42)).toBe('');
  });
});
