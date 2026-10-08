import readline from 'node:readline';

/**
 * v1303 — Oberfläche der Sitzung (Spec §8 Punkt 3, Owner-Freigabe 08.10.). Die Sitzungslogik (Chat, Sprache, Bestätigungen,
 * Satellit) spricht nur noch mit dieser Schnittstelle; dahinter steht entweder die bisherige readline-Ausgabe
 * (Rückfall für Skripte, Tests, Terminals ohne Rohmodus, `--einfach`) oder die Ink-Oberfläche (`sitzung-ink.tsx`).
 */
export type Taste = 'strg+t' | 'ja' | 'nein' | 'lage' | 'ende' | 'hoeren' | 'einstellungen'; // v1307 hoeren = Strg+G, v1309 einstellungen = Strg+E

/** v1309 — Einstellungen für die Oberfläche: Liste lesen, Befehl anwenden (derselbe Weg wie /einstellungen und alfred einstellungen). */
export interface EinstellungenAnbindung {
  liste: () => import('./satellit-einstellungen.js').Einstellung[];
  befehl: (zeile: string) => string;
}

export interface SitzungStatus {
  geraet: string; version: string; server: string;
  satellit: string; verbunden?: boolean;
  offen: number; modus: 'bereit' | 'antwort' | 'aufnahme'; tier?: string; stimme: boolean; hoeren: boolean;
  /** v1305 — offene Bestätigungen fürs Feld der Ink-Oberfläche (Reihenfolge wie /offen). */
  offenListe?: Array<{ id: string; text: string; quelle?: string; seit?: string }>;
  /** v1310 — Version des Satelliten (IPC) und ob sie neuer ist als die Sitzung; Beginn der laufenden Antwort. */
  satellitVersion?: string; neuer?: boolean; antwortSeit?: number;
}

export interface Oberflaeche {
  /** Zeile(n) in den Verlauf. */
  drucke(text: string): void;
  /** Einzeilige, überschreibbare Meldung („… denkt", Hör-Zwischenstand); leer löscht sie. */
  fluechtig(text: string): void;
  /** Streaming: erstes Stück eröffnet die Antwort mit Kopfzeile. */
  antwortDelta(text: string): void;
  /** Werkzeug oder Denken zwischendurch: bisherigen Teil als abgeschlossen behandeln. */
  antwortNeuerAnlauf(): void;
  /** Antwort abschließen; `text` nur, wenn der Endtext vom gezeigten abweicht (oder nichts gezeigt wurde); `zeilen` = Anhänge u. Ä. */
  antwortEnde(text: string | undefined, zeilen?: string[]): void;
  status(s: Partial<SitzungStatus>): void;
  prompt(label?: string): void;
  aufEingabe(cb: (zeile: string) => void): void;
  /** v1306 — `nr` nennt die gewählte Bestätigung (1-basiert, Reihenfolge wie /offen); ohne nr gilt die jüngste. */
  aufTaste(cb: (t: Taste, nr?: number) => void): void;
  /** v1309 — Einstellungsbild (Ink: Strg+E); readline zeigt die Liste über /einstellungen. */
  einstellungen?(a: EinstellungenAnbindung): void;
  schliessen(): void;
}

function zeit(): string { return new Date().toLocaleTimeString('de-AT', { hour: '2-digit', minute: '2-digit' }); }

/** Die bisherige Ausgabe (v1232–v1302), unverändert im Verhalten. */
export class ReadlineOberflaeche implements Oberflaeche {
  private readonly rl: readline.Interface;
  private gezeigt = '';
  private modus: SitzungStatus['modus'] = 'bereit';
  private tasteCb?: (t: Taste, nr?: number) => void;
  constructor(private readonly out: NodeJS.WriteStream = process.stdout, inp: NodeJS.ReadStream = process.stdin) {
    this.rl = readline.createInterface({ input: inp, output: out, prompt: 'Du: ' });
    readline.emitKeypressEvents(inp, this.rl);
    inp.on('keypress', (_ch: string, key: { ctrl?: boolean; name?: string } | undefined) => {
      if (key?.ctrl && key.name === 't') this.tasteCb?.('strg+t');
      if (key?.ctrl && key.name === 'g') this.tasteCb?.('hoeren'); // v1307
      if (key?.ctrl && key.name === 'e') this.tasteCb?.('einstellungen'); // v1309
    });
  }
  private loescheZeile(): void { readline.clearLine(this.out, 0); readline.cursorTo(this.out, 0); }
  drucke(text: string): void { this.loescheZeile(); this.out.write(text + '\n'); if (this.modus === 'bereit') this.rl.prompt(true); }
  fluechtig(text: string): void { this.loescheZeile(); if (text) this.out.write(text); }
  antwortDelta(text: string): void {
    if (!this.gezeigt) { this.loescheZeile(); this.out.write(`\nAlfred (${zeit()}): `); }
    this.out.write(text); this.gezeigt += text;
  }
  antwortNeuerAnlauf(): void { if (this.gezeigt) this.out.write('\n'); this.gezeigt = ''; }
  antwortEnde(text: string | undefined, zeilen: string[] = []): void {
    if (this.gezeigt && text === undefined) this.out.write('\n');
    else { if (this.gezeigt) this.out.write('\n'); this.loescheZeile(); this.out.write(`\nAlfred (${zeit()}): ${text ?? ''}\n`); }
    for (const z of zeilen) this.out.write(z + '\n');
    this.out.write('\n');
    this.gezeigt = '';
  }
  status(s: Partial<SitzungStatus>): void { if (s.modus) this.modus = s.modus; }
  prompt(label?: string): void { if (label !== undefined) this.rl.setPrompt(label); this.rl.prompt(true); }
  aufEingabe(cb: (zeile: string) => void): void { this.rl.on('line', cb); }
  aufTaste(cb: (t: Taste, nr?: number) => void): void { this.tasteCb = cb; this.rl.on('close', () => cb('ende')); }
  schliessen(): void { this.rl.close(); }
}
