import React, { useEffect, useState } from 'react';
import { render, Box, Text, Static, useInput, type Instance } from 'ink';
import type { Oberflaeche, SitzungStatus, Taste } from './sitzung-oberflaeche.js';

/**
 * v1303 — Ink-Oberfläche der Sitzung (Spec §8 Punkt 3): Verlauf (scrollt mit dem Terminal), laufende Antwort, flüchtige
 * Zeile, Statuszeile (Gerät, Version, Satellit, offene Bestätigungen, Modellstufe, Stimme, Zuhören) und Eingabezeile.
 * Tasten: Enter sendet · Strg+T spricht · Alt+J / Alt+N beantworten die jüngste Bestätigung · Strg+L zeigt die Lage ·
 * Strg+Q beendet. (Die Spec nannte j/n/l/q als Einzeltasten — das kollidiert mit dem Tippen von Nachrichten wie
 * „ja, mach das" oder „lies …", darum Alt bzw. Strg.)
 */
interface Zustand {
  verlauf: { id: number; text: string }[];
  antwort: string; antwortKopf: string;
  fluechtig: string;
  status: SitzungStatus;
  label: string;
}

class Speicher {
  z: Zustand;
  private hoerer = new Set<() => void>();
  private naechsteId = 1;
  constructor(status: SitzungStatus) { this.z = { verlauf: [], antwort: '', antwortKopf: '', fluechtig: '', status, label: 'Du: ' }; }
  on(cb: () => void): () => void { this.hoerer.add(cb); return () => this.hoerer.delete(cb); }
  aendere(f: (z: Zustand) => void): void { f(this.z); this.z = { ...this.z }; for (const h of this.hoerer) h(); }
  zeile(text: string): void { this.aendere(z => { z.verlauf = [...z.verlauf, ...text.split('\n').map(t => ({ id: this.naechsteId++, text: t }))]; }); }
}

function zeit(): string { return new Date().toLocaleTimeString('de-AT', { hour: '2-digit', minute: '2-digit' }); }

function Sitzung({ speicher, aufEingabe, aufTaste }: { speicher: Speicher; aufEingabe: (z: string) => void; aufTaste: (t: Taste) => void }) {
  const [z, setZ] = useState(speicher.z);
  const [eingabe, setEingabe] = useState('');
  useEffect(() => speicher.on(() => setZ(speicher.z)), [speicher]);
  useInput((input, key) => {
    if (key.ctrl && input === 't') { aufTaste('strg+t'); return; }
    if (key.ctrl && input === 'l') { aufTaste('lage'); return; }
    if (key.ctrl && (input === 'q' || input === 'd')) { aufTaste('ende'); return; }
    if (key.meta && (input === 'j' || input === 'J')) { aufTaste('ja'); return; }
    if (key.meta && (input === 'n' || input === 'N')) { aufTaste('nein'); return; }
    if (key.return) { const t = eingabe; setEingabe(''); aufEingabe(t); return; }
    if (key.backspace || key.delete) { setEingabe(e => e.slice(0, -1)); return; }
    if (key.escape) { setEingabe(''); return; }
    if (key.ctrl || key.meta || key.upArrow || key.downArrow || key.leftArrow || key.rightArrow || key.tab || key.pageDown || key.pageUp) return;
    if (input) setEingabe(e => e + input);
  });
  const s = z.status;
  const statusText = [
    `${s.geraet} ${s.version}`,
    `Satellit: ${s.satellit}${s.verbunden === undefined ? '' : s.verbunden ? ' ●' : ' ○'}`,
    `Bestätigungen: ${s.offen}`,
    `Stufe: ${s.tier ?? 'auto'}`,
    s.stimme ? '🔊' : '', s.hoeren ? '🎧' : '',
    s.modus === 'antwort' ? '… antwortet' : s.modus === 'aufnahme' ? '● Aufnahme' : '',
  ].filter(Boolean).join(' · ');
  return (
    <Box flexDirection="column">
      <Static items={z.verlauf}>{(item) => <Text key={item.id}>{item.text}</Text>}</Static>
      {z.antwort ? <Box flexDirection="column" marginTop={1}><Text color="cyan">{z.antwortKopf}</Text><Text>{z.antwort}</Text></Box> : null}
      {z.fluechtig ? <Text dimColor>{z.fluechtig}</Text> : null}
      <Box borderStyle="single" borderColor="gray" paddingX={1} marginTop={1} flexDirection="column">
        <Text dimColor>{statusText}</Text>
        <Text>{z.label}{eingabe}<Text inverse> </Text></Text>
      </Box>
      <Text dimColor>Enter sendet · Strg+T sprechen · Alt+J/Alt+N jüngste Bestätigung · Strg+L Lage · Strg+Q Ende</Text>
    </Box>
  );
}

export interface InkOptionen { stdout?: NodeJS.WriteStream; stdin?: NodeJS.ReadStream; debug?: boolean }

export class InkOberflaeche implements Oberflaeche {
  private readonly speicher: Speicher;
  private instanz?: Instance;
  private eingabeCb: (z: string) => void = () => undefined;
  private tasteCb: (t: Taste) => void = () => undefined;
  constructor(status: SitzungStatus, private readonly opts: InkOptionen = {}) { this.speicher = new Speicher(status); }
  start(): void {
    this.instanz = render(
      <Sitzung speicher={this.speicher} aufEingabe={(z) => this.eingabeCb(z)} aufTaste={(t) => this.tasteCb(t)} />,
      { stdout: this.opts.stdout ?? process.stdout, stdin: this.opts.stdin ?? process.stdin, debug: this.opts.debug ?? false, exitOnCtrlC: false, patchConsole: false },
    );
  }
  drucke(text: string): void { this.speicher.zeile(text); }
  fluechtig(text: string): void { this.speicher.aendere(z => { z.fluechtig = text; }); }
  antwortDelta(text: string): void {
    this.speicher.aendere(z => { if (!z.antwort) { z.antwortKopf = `Alfred (${zeit()}):`; z.fluechtig = ''; } z.antwort += text; });
  }
  antwortNeuerAnlauf(): void {
    const z = this.speicher.z;
    if (z.antwort) { this.speicher.zeile(`${z.antwortKopf} ${z.antwort}`); this.speicher.aendere(y => { y.antwort = ''; }); }
  }
  antwortEnde(text: string | undefined, zeilen: string[] = []): void {
    const z = this.speicher.z;
    const fertig = text !== undefined ? text : z.antwort;
    this.speicher.zeile(`\nAlfred (${zeit()}): ${fertig}`);
    for (const y of zeilen) this.speicher.zeile(y);
    this.speicher.aendere(y => { y.antwort = ''; y.antwortKopf = ''; y.fluechtig = ''; });
  }
  status(s: Partial<SitzungStatus>): void { this.speicher.aendere(z => { z.status = { ...z.status, ...s }; }); }
  prompt(label?: string): void { if (label !== undefined) this.speicher.aendere(z => { z.label = label; }); }
  aufEingabe(cb: (zeile: string) => void): void { this.eingabeCb = cb; }
  aufTaste(cb: (t: Taste) => void): void { this.tasteCb = cb; }
  schliessen(): void { try { this.instanz?.unmount(); } catch { /* */ } }
}

/** Ink nur mit echtem Terminal (Rohmodus); sonst readline. */
export function inkMoeglich(): boolean {
  return !!process.stdin.isTTY && !!process.stdout.isTTY && typeof (process.stdin as { setRawMode?: unknown }).setRawMode === 'function';
}
