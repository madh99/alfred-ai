/**
 * v1250 — Echtzeit-Sprache, Schritt 1: Satzende-Erkennung auf einem PCM-Strom (16 Bit, mono).
 *
 * Weder Mistral Realtime noch OpenAI liefern Start/Stopp der Sprache — das Satzende erkennen wir selbst,
 * rein und deterministisch: Lautstärke (RMS) je Rahmen gegen einen mitlaufenden Grundpegel.
 * Drei laute Rahmen beginnen eine Äußerung, `endeMs` Ruhe beenden sie. Zu kurze Äußerungen werden verworfen,
 * zu lange hart beendet. Stille wird nie weitergegeben — bezahlt wird später nur Sprache.
 */
export interface SatzendeOptionen {
  rate?: number;        // Abtastrate, Standard 16000
  rahmenMs?: number;    // Rahmenlänge, Standard 20 ms
  startRahmen?: number; // laute Rahmen in Folge bis „Sprache beginnt", Standard 3
  endeMs?: number;      // Ruhe bis „Sprache endet", Standard 700 ms
  minDauerMs?: number;  // kürzere Äußerungen verwerfen, Standard 400 ms
  maxDauerMs?: number;  // längere hart beenden, Standard 20000 ms
  faktor?: number;      // Schwelle = Grundpegel × Faktor, Standard 3
  mindestSchwelle?: number; // absolute Untergrenze der Schwelle (RMS), Standard 350
  vorlaufRahmen?: number;   // Rahmen vor dem Start mitnehmen (Anlaut), Standard 5
}

export type SatzendeEreignis =
  | { art: 'start' }
  | { art: 'ende'; audio: Buffer; dauerMs: number }
  | { art: 'verworfen'; dauerMs: number };

export function rms16(rahmen: Buffer): number {
  const n = Math.floor(rahmen.length / 2);
  if (n === 0) return 0;
  let summe = 0;
  for (let i = 0; i < n; i++) { const v = rahmen.readInt16LE(i * 2); summe += v * v; }
  return Math.sqrt(summe / n);
}

export class SatzendeErkenner {
  private readonly o: Required<SatzendeOptionen>;
  private readonly rahmenBytes: number;
  private rest = Buffer.alloc(0);
  private grundpegel = 200;
  private aktiv = false;
  private lauteFolge = 0;
  private stilleMs = 0;
  private dauerMs = 0;
  private teile: Buffer[] = [];
  private vorlauf: Buffer[] = [];

  constructor(opts: SatzendeOptionen = {}) {
    this.o = { rate: 16000, rahmenMs: 20, startRahmen: 3, endeMs: 700, minDauerMs: 400, maxDauerMs: 20_000, faktor: 3, mindestSchwelle: 350, vorlaufRahmen: 5, ...opts };
    this.rahmenBytes = Math.floor(this.o.rate * this.o.rahmenMs / 1000) * 2;
  }

  get schwelle(): number { return Math.max(this.o.mindestSchwelle, this.grundpegel * this.o.faktor); }
  get spricht(): boolean { return this.aktiv; }

  /** PCM-Bytes hineinschieben; liefert die dabei entstandenen Ereignisse. */
  schiebe(pcm: Buffer): SatzendeEreignis[] {
    const ereignisse: SatzendeEreignis[] = [];
    let daten = this.rest.length ? Buffer.concat([this.rest, pcm]) : pcm;
    while (daten.length >= this.rahmenBytes) {
      const rahmen = daten.subarray(0, this.rahmenBytes);
      daten = daten.subarray(this.rahmenBytes);
      this.verarbeite(Buffer.from(rahmen), ereignisse);
    }
    this.rest = Buffer.from(daten);
    return ereignisse;
  }

  /** Strom zu Ende (Mikrofon aus): laufende Äußerung abschließen. */
  schliesse(): SatzendeEreignis[] {
    const e: SatzendeEreignis[] = [];
    if (this.aktiv) this.beende(e);
    return e;
  }

  private verarbeite(rahmen: Buffer, e: SatzendeEreignis[]): void {
    const pegel = rms16(rahmen);
    const laut = pegel >= this.schwelle;
    if (!this.aktiv) {
      if (laut) {
        this.lauteFolge += 1;
        this.vorlauf.push(rahmen);
        if (this.lauteFolge >= this.o.startRahmen) {
          this.aktiv = true; this.stilleMs = 0; this.dauerMs = this.vorlauf.length * this.o.rahmenMs;
          this.teile = [...this.vorlauf]; this.vorlauf = [];
          e.push({ art: 'start' });
        }
      } else {
        this.lauteFolge = 0;
        // Grundpegel nur aus Ruhe lernen, träge
        this.grundpegel = this.grundpegel * 0.95 + pegel * 0.05;
        this.vorlauf.push(rahmen);
        if (this.vorlauf.length > this.o.vorlaufRahmen) this.vorlauf.shift();
      }
      return;
    }
    this.teile.push(rahmen);
    this.dauerMs += this.o.rahmenMs;
    this.stilleMs = laut ? 0 : this.stilleMs + this.o.rahmenMs;
    if (this.stilleMs >= this.o.endeMs || this.dauerMs >= this.o.maxDauerMs) this.beende(e);
  }

  private beende(e: SatzendeEreignis[]): void {
    const audio = Buffer.concat(this.teile);
    const gesprochenMs = Math.max(0, this.dauerMs - this.stilleMs);
    this.aktiv = false; this.lauteFolge = 0; this.teile = []; this.vorlauf = []; this.stilleMs = 0; this.dauerMs = 0;
    if (gesprochenMs < this.o.minDauerMs) e.push({ art: 'verworfen', dauerMs: gesprochenMs });
    else e.push({ art: 'ende', audio, dauerMs: gesprochenMs });
  }
}

/** PCM 16 Bit mono → WAV (für die Transkription per Datei-Upload). */
export function pcm16ZuWav(pcm: Buffer, rate = 16000): Buffer {
  const kopf = Buffer.alloc(44);
  kopf.write('RIFF', 0); kopf.writeUInt32LE(36 + pcm.length, 4); kopf.write('WAVE', 8);
  kopf.write('fmt ', 12); kopf.writeUInt32LE(16, 16); kopf.writeUInt16LE(1, 20); kopf.writeUInt16LE(1, 22);
  kopf.writeUInt32LE(rate, 24); kopf.writeUInt32LE(rate * 2, 28); kopf.writeUInt16LE(2, 32); kopf.writeUInt16LE(16, 34);
  kopf.write('data', 36); kopf.writeUInt32LE(pcm.length, 40);
  return Buffer.concat([kopf, pcm]);
}
