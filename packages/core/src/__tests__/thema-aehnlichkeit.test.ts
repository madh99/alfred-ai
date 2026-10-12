import { describe, it, expect } from 'vitest';
import { aehnlichesThema } from '../interessen/thema-aehnlichkeit.js';

// v1366 — echte Themen vom 12.10. (Interest-Detector legte täglich Umformulierungen neu an)
const bestand = [
  { id: 'k', name: 'Kryptowährungen & Blockchain', keywords: ['Bitcoin', 'Ethereum', 'Solana', 'Avalanche', 'BTC', 'ETH', 'SOL', 'AVAX'] },
  { id: 'v', name: 'Entwicklungen im Bereich Vehicle-to-Grid (V2G) und bidirektionales Laden', keywords: ['V2G', 'bidirektionales Laden', 'Wallbox', 'Akku laden/entladen', 'Elektromobilität'] },
  { id: 's', name: 'Strommarkt & Energiepreise (aWATTar)', keywords: ['aWATTar', 'Strompreis', 'Energierechnung', 'dynamische Strompreise'] },
  { id: 'p', name: 'Dezentrale Energiemärkte & Peer-to-Peer-Energiehandel', keywords: ['P2P-Energiehandel', 'Blockchain-Energiemarkt', 'Lokale Energiegemeinschaften'] },
  { id: 'f', name: 'Fussball Transfers', keywords: ['Transfer', 'Wechsel', 'Ablöse', 'Leihe'] },
];

describe('aehnlichesThema', () => {
  it('erkennt die täglichen Umformulierungen', () => {
    expect(aehnlichesThema('Markttrends und technologische Fortschritte bei Krypto-Assets mit Fokus auf Infrastruktur', ['BTC', 'ETH', 'AVAX', 'Blockchain-Infrastruktur'], bestand)?.thema.id).toBe('k');
    expect(aehnlichesThema('Markttrends und technologische Fortschritte bei bidirektionalen Ladelösungen (V2G/V2H)', ['bidirektionales Laden', 'V2G', 'V2H', 'Wallbox'], bestand)?.thema.id).toBe('v');
    expect(aehnlichesThema('Marktentwicklungen und regulatorische Änderungen bei dynamischen Stromtarifen', ['dynamische Stromtarife', 'aWATTar', 'Spotmarkt-Handel', 'Strompreis'], bestand)?.thema.id).toBe('s');
    expect(aehnlichesThema('Entwicklungen im Bereich dezentrale Energiemärkte und Peer-to-Peer-Energiehandel', ['Peer-to-Peer-Energiehandel', 'Blockchain'], bestand)?.thema.id).toBe('p');
  });

  it('eigenständige Themen bleiben neu', () => {
    expect(aehnlichesThema('Schulferien & Kinderbetreuung Planung', ['Sommercamp', 'Schulferien', 'Kinderbetreuung'], bestand)).toBeNull();
    expect(aehnlichesThema('Prisma ORM & Database Migrations', ['Prisma', 'Datenbankmigrationen'], bestand)).toBeNull();
    expect(aehnlichesThema('Fussball Europa', ['Fußball', 'Europa', 'Nationalmannschaft', 'Transfer', 'Champions League'], bestand)).toBeNull();
    expect(aehnlichesThema('Batteriespeicher & Stromspeichertechnologien', ['Heimspeicher', 'LiFePO4', 'Speicherkapazität'], bestand)).toBeNull();
  });
});
