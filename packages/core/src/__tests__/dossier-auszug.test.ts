import { describe, it, expect } from 'vitest';
import { dossierThemaFuer, dossierAuszug } from '../interessen/dossier-auszug.js';

// v1377 — I2: echte Themen nach der Bereinigung (12.10.)
const themen = [
  { id: 'k', name: 'Kryptowährungen & Blockchain', keywords: ['Bitcoin', 'Ethereum', 'Solana', 'Avalanche', 'BTC', 'ETH', 'SOL', 'AVAX'] },
  { id: 'e', name: 'E-Mobilität, Wallbox & bidirektionales Laden', keywords: ['Wallbox', 'V2G', 'V2H', 'bidirektionales Laden', 'Elektromobilität'] },
  { id: 's', name: 'Strompreise & dynamische Tarife (aWATTar)', keywords: ['aWATTar', 'Strompreis', 'dynamische Stromtarife', 'Spotmarkt'] },
  { id: 'f', name: 'Fußball Österreich (Vereine & Ligen)', keywords: ['KSV 1980 Kapfenberg', 'SV Altlengbach', 'Ligabetrieb'] },
  { id: 'a', name: 'Abonnierte Feeds', keywords: [] },
];

describe('dossierThemaFuer', () => {
  it('Frage nach Neuigkeiten passt zum richtigen Thema', () => {
    expect(dossierThemaFuer('Was gibt es Neues zu Bitcoin?', themen)?.id).toBe('k');
    expect(dossierThemaFuer('Gibt es was Neues bei bidirektionalem Laden mit der Wallbox?', themen)?.id).toBe('e');
    expect(dossierThemaFuer('Wie entwickeln sich die Strompreise bei aWATTar?', themen)?.id).toBe('s');
    expect(dossierThemaFuer('Wie hat KSV 1980 Kapfenberg gespielt?', themen)?.id).toBe('f');
  });
  it('Alltagsfragen ohne Bezug → kein Dossier', () => {
    expect(dossierThemaFuer('Wie spät ist es?', themen)).toBeNull();
    expect(dossierThemaFuer('Erinnere mich morgen an den Müll', themen)).toBeNull();
    expect(dossierThemaFuer('Schick mir die neuen Feeds', themen)).toBeNull();
  });
});

describe('dossierAuszug', () => {
  it('kurz bleibt ganz; lang wird am Satzende gekürzt', () => {
    expect(dossierAuszug('Kurz.')).toBe('Kurz.');
    const lang = Array.from({ length: 40 }, (_, i) => `Satz ${i} über Bitcoin und Märkte.`).join(' ');
    const a = dossierAuszug(lang);
    expect(a.length).toBeLessThanOrEqual(602);
    expect(a.endsWith('. …')).toBe(true);
  });
});
