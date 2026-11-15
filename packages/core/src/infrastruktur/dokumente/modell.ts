// Dokumentmodell: feste Dokumentarten, deterministisch aus Daten erzeugt (keine DB, kein I/O).

export type DokuArtKey = 'abnahme' | 'testprotokoll' | 'betrieb';

export type Block =
  | { art: 'absatz'; text: string }
  | { art: 'liste'; punkte: string[] }
  | { art: 'tabelle'; kopf: string[]; zeilen: string[][] }
  | { art: 'code'; text: string }
  | { art: 'mermaid'; text: string }
  | { art: 'nichtBelegt'; grund: string }
  | { art: 'frei'; feld: string; text?: string };

export interface Kapitel {
  nr: number;
  id: string;
  titel: string;
  bloecke: Block[];
}

export interface DokuKopf {
  art: DokuArtKey;
  artVersion: number;
  titel: string;
  ordner: string;
  erzeugt: string;
  quellen: Array<{ quelle: string; stand: string; fehler?: string }>;
  verweise: string[];
}

export interface Anhang {
  name: string;
  mime: string;
  inhalt: string;
}

export interface Dokument {
  kopf: DokuKopf;
  kapitel: Kapitel[];
  anhaenge: Anhang[];
}
