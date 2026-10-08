import React, { useEffect, useState } from 'react';
import { render, Box, Text, Static, useInput, usePaste, useStdout, type Instance } from 'ink';
import type { Oberflaeche, SitzungStatus, Taste } from './sitzung-oberflaeche.js';

/**
 * v1303 — Ink-Oberfläche der Sitzung (Spec §8 Punkt 3): Verlauf (scrollt mit dem Terminal), laufende Antwort, flüchtige
 * Zeile, Statuszeile (Gerät, Version, Satellit, offene Bestätigungen, Modellstufe, Stimme, Zuhören) und Eingabezeile.
 * Tasten: Enter sendet · Strg+T spricht · Alt+J / Alt+N beantworten die jüngste Bestätigung · Strg+L zeigt die Lage ·
 * Strg+Q beendet. (Die Spec nannte j/n/l/q als Einzeltasten — das kollidiert mit dem Tippen von Nachrichten wie
 * „ja, mach das" oder „lies …", darum Alt bzw. Strg.)
 * v1305 (Owner „ok 1-4"): Eingabe mit Cursor (←/→, Pos1/Ende, Strg+A/E, Strg+W Wort, Strg+U Zeile), Verlauf ↑/↓,
 * Einfügen aus der Zwischenablage, mehrzeilig mit Alt+Enter (Shift+Enter, wo das Terminal es meldet); Feld mit offenen
 * Bestätigungen (jüngste hervorgehoben, Alter, Quelle); Antworten mit Fettdruck, Code und Aufzählungen; Zeitstempel
 * an Satelliten- und Bestätigungszeilen; Spinner während der Antwort; schmale Terminals ohne Hinweiszeile.
 */
interface Zustand {
  verlauf: { id: number; text: string; zeit?: string }[];
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
  zeile(text: string): void {
    const stempel = /^[⚙🔔✓✅❌]/u.test(text.trimStart()) ? zeit() : undefined;
    this.aendere(z => { z.verlauf = [...z.verlauf, ...text.split('\n').map((t, i) => ({ id: this.naechsteId++, text: t, zeit: i === 0 ? stempel : undefined }))]; });
  }
}

function zeit(): string { return new Date().toLocaleTimeString('de-AT', { hour: '2-digit', minute: '2-digit' }); }

/** v1305 — Alter einer Bestätigung in Worten („vor 2 min"). */
export function alterText(seit: string | undefined, jetzt = Date.now()): string {
  if (!seit) return '';
  const s = Math.max(0, Math.round((jetzt - Date.parse(seit)) / 1000));
  if (!Number.isFinite(s)) return '';
  if (s < 60) return `vor ${s} s`;
  if (s < 3600) return `vor ${Math.round(s / 60)} min`;
  return `vor ${Math.round(s / 3600)} h`;
}

/** v1305 — Markdown-Stücke einer Zeile: **fett**, `code`, Aufzählung, Überschrift. Rein, testbar. */
export type Stueck = { text: string; fett?: boolean; code?: boolean };
export function markdownZeile(zeile: string): { stuecke: Stueck[]; art: 'text' | 'punkt' | 'ueberschrift' } {
  let art: 'text' | 'punkt' | 'ueberschrift' = 'text';
  let rest = zeile;
  const u = /^(#{1,6})\s+(.*)$/.exec(rest);
  if (u) { art = 'ueberschrift'; rest = u[2]!; }
  const p = /^(\s*)([-*•]|\d+[.)])\s+(.*)$/.exec(rest);
  if (!u && p) { art = 'punkt'; rest = `${p[1]}• ${p[3]}`; }
  const stuecke: Stueck[] = [];
  const re = /(\*\*([^*]+)\*\*|`([^`]+)`)/g;
  let i = 0; let m: RegExpExecArray | null;
  while ((m = re.exec(rest))) {
    if (m.index > i) stuecke.push({ text: rest.slice(i, m.index) });
    if (m[2] !== undefined) stuecke.push({ text: m[2], fett: true }); else stuecke.push({ text: m[3]!, code: true });
    i = m.index + m[0].length;
  }
  if (i < rest.length) stuecke.push({ text: rest.slice(i) });
  if (art === 'ueberschrift') for (const s of stuecke) s.fett = true;
  return { stuecke, art };
}

function Markiert({ text }: { text: string }) {
  const { stuecke, art } = markdownZeile(text);
  return (
    <Text underline={art === 'ueberschrift'}>
      {stuecke.map((s, i) => <Text key={i} bold={s.fett} color={s.code ? 'yellow' : undefined}>{s.text}</Text>)}
    </Text>
  );
}

/** v1305 — Eingabe mit Cursor und Verlauf. Rein, testbar. */
export interface Eingabe { text: string; cursor: number }
export function eingabeTaste(e: Eingabe, input: string, key: { leftArrow?: boolean; rightArrow?: boolean; home?: boolean; end?: boolean; backspace?: boolean; delete?: boolean; ctrl?: boolean; meta?: boolean; return?: boolean; shift?: boolean }): Eingabe {
  const { text, cursor } = e;
  if (key.leftArrow) return { text, cursor: Math.max(0, cursor - 1) };
  if (key.rightArrow) return { text, cursor: Math.min(text.length, cursor + 1) };
  if (key.home || (key.ctrl && input === 'a')) return { text, cursor: 0 };
  if (key.end || (key.ctrl && input === 'e')) return { text, cursor: text.length };
  if (key.ctrl && input === 'u') return { text: text.slice(cursor), cursor: 0 };
  if (key.ctrl && input === 'w') { const vor = text.slice(0, cursor).replace(/\S+\s*$/, ''); return { text: vor + text.slice(cursor), cursor: vor.length }; }
  if (key.backspace || (key.delete && !key.meta && input === '')) { if (cursor === 0) return e; return { text: text.slice(0, cursor - 1) + text.slice(cursor), cursor: cursor - 1 }; }
  // v1306 — neue Zeile: Strg+N (überall), Alt+Enter/Shift+Enter nur dort, wo das Terminal sie durchreicht (Windows Terminal
  // nimmt Alt+Enter für Vollbild, Terminal.app schickt für Option+Return nur \r) — Owner-Befund 08.10.
  if ((key.return && (key.meta || key.shift)) || (key.ctrl && input === 'n')) return { text: text.slice(0, cursor) + '\n' + text.slice(cursor), cursor: cursor + 1 };
  if (key.ctrl || key.meta || !input) return e;
  return { text: text.slice(0, cursor) + input + text.slice(cursor), cursor: cursor + input.length };
}

const SPINNER = ['⠋', '⠙', '⠹', '⠸', '⠼', '⠴', '⠦', '⠧', '⠇', '⠏'];

function Sitzung({ speicher, aufEingabe, aufTaste }: { speicher: Speicher; aufEingabe: (z: string) => void; aufTaste: (t: Taste, nr?: number) => void }) {
  const [z, setZ] = useState(speicher.z);
  const [e, setE] = useState<Eingabe>({ text: '', cursor: 0 });
  const [verlaufEingaben, setVerlaufEingaben] = useState<string[]>([]);
  const [verlaufPos, setVerlaufPos] = useState(-1);
  const [tick, setTick] = useState(0);
  // v1306 — Feld der Bestätigungen: Strg+B blendet ein/aus und nimmt den Fokus; im Fokus ↑/↓ wählen, Enter/J freigeben, N ablehnen, Esc zurück
  const [feldSichtbar, setFeldSichtbar] = useState(true);
  const [feldFokus, setFeldFokus] = useState(false);
  const [auswahl, setAuswahl] = useState(0);
  const stdout = useStdout().stdout as unknown as NodeJS.WriteStream | undefined; // Breite und 'resize' nur am echten Terminal
  const [spalten, setSpalten] = useState(stdout?.columns ?? 80);
  useEffect(() => speicher.on(() => setZ(speicher.z)), [speicher]);
  useEffect(() => {
    const t = setInterval(() => setTick(x => x + 1), 1000); // Spinner und Alter der Bestätigungen
    const aufGroesse = () => setSpalten(stdout?.columns ?? 80);
    stdout?.on?.('resize', aufGroesse);
    return () => { clearInterval(t); stdout?.off?.('resize', aufGroesse); };
  }, [stdout]);
  usePaste((text) => { setE(x => ({ text: x.text.slice(0, x.cursor) + text + x.text.slice(x.cursor), cursor: x.cursor + text.length })); });
  useInput((input, key) => {
    if (key.ctrl && input === 't') { aufTaste('strg+t'); return; }
    if (key.ctrl && input === 'l') { aufTaste('lage'); return; }
    if (key.ctrl && input === 'g') { aufTaste('hoeren'); return; } // v1307 — Zuhören an/aus (Strg+H wäre die Rücktaste)
    if (key.ctrl && (input === 'q' || input === 'd')) { aufTaste('ende'); return; }
    if (key.meta && (input === 'j' || input === 'J')) { aufTaste('ja'); return; }
    if (key.meta && (input === 'n' || input === 'N')) { aufTaste('nein'); return; }
    const anzahl = z.status.offenListe?.length ?? 0;
    if (key.ctrl && input === 'b') {
      if (!feldSichtbar) { setFeldSichtbar(true); setFeldFokus(anzahl > 0); setAuswahl(Math.max(0, anzahl - 1)); }
      else if (!feldFokus && anzahl > 0) { setFeldFokus(true); setAuswahl(Math.max(0, anzahl - 1)); }
      else { setFeldSichtbar(false); setFeldFokus(false); }
      return;
    }
    if (feldFokus) {
      const nr = Math.min(auswahl, Math.max(0, anzahl - 1));
      if (key.escape) { setFeldFokus(false); return; }
      if (key.upArrow) { setAuswahl(Math.max(0, nr - 1)); return; }
      if (key.downArrow) { setAuswahl(Math.min(Math.max(0, anzahl - 1), nr + 1)); return; }
      if (anzahl && (key.return || input === 'j' || input === 'J')) { aufTaste('ja', nr + 1); return; }
      if (anzahl && (input === 'n' || input === 'N' || key.backspace || key.delete)) { aufTaste('nein', nr + 1); return; }
      return; // im Fokus geht nichts in die Eingabe
    }
    if (key.escape) { setE({ text: '', cursor: 0 }); setVerlaufPos(-1); return; }
    if (key.upArrow || key.downArrow) {
      if (!verlaufEingaben.length) return;
      const pos = key.upArrow ? Math.min(verlaufEingaben.length - 1, verlaufPos + 1) : Math.max(-1, verlaufPos - 1);
      setVerlaufPos(pos);
      const t = pos < 0 ? '' : verlaufEingaben[verlaufEingaben.length - 1 - pos]!;
      setE({ text: t, cursor: t.length });
      return;
    }
    if (key.return && !key.meta && !key.shift) {
      // v1306 — Zeile endet mit „\": Zeilenumbruch statt Senden (geht in jedem Terminal)
      if (e.text.endsWith('\\')) { setE({ text: e.text.slice(0, -1) + '\n', cursor: e.text.length }); return; }
      const t = e.text; setE({ text: '', cursor: 0 }); setVerlaufPos(-1);
      if (t.trim()) setVerlaufEingaben(v => [...v.slice(-99), t]);
      aufEingabe(t); return;
    }
    if (key.tab || key.pageDown || key.pageUp) return;
    setE(x => eingabeTaste(x, input, key));
  });
  const s = z.status;
  const spinner = s.modus === 'antwort' ? SPINNER[tick % SPINNER.length] + ' antwortet' : s.modus === 'aufnahme' ? '● Aufnahme' : '';
  const statusText = [
    `${s.geraet} ${s.version}`,
    `Satellit: ${s.satellit}${s.verbunden === undefined ? '' : s.verbunden ? ' ●' : ' ○'}`,
    `Bestätigungen: ${s.offen}`,
    `Stufe: ${s.tier ?? 'auto'}`,
    s.stimme ? '🔊' : '', s.hoeren ? '🎧' : '', spinner,
  ].filter(Boolean).join(' · ');
  const offene = s.offenListe ?? [];
  const jetzt = Date.now();
  return (
    <Box flexDirection="column">
      <Static items={z.verlauf}>{(item) => (
        <Box key={item.id}>{item.zeit ? <Text dimColor>{item.zeit} </Text> : null}<Markiert text={item.text} /></Box>
      )}</Static>
      {z.antwort ? <Box flexDirection="column" marginTop={1}><Text color="cyan">{z.antwortKopf}</Text>{z.antwort.split('\n').map((l, i) => <Markiert key={i} text={l} />)}</Box> : null}
      {z.fluechtig ? <Text dimColor>{z.fluechtig}</Text> : null}
      {offene.length && feldSichtbar ? (
        <Box flexDirection="column" borderStyle="round" borderColor={feldFokus ? 'green' : 'yellow'} paddingX={1} marginTop={1}>
          <Text color={feldFokus ? 'green' : 'yellow'} bold>Offene Bestätigungen ({offene.length}) — {feldFokus ? '↑/↓ wählen · Enter/J freigeben · N ablehnen · Esc zurück' : 'Strg+B wählen/ausblenden · /ja n · /nein n · Alt+J/Alt+N = jüngste'}</Text>
          {offene.map((b, i) => {
            const gewaehlt = feldFokus && i === Math.min(auswahl, offene.length - 1);
            return (
              <Text key={b.id} bold={i === offene.length - 1} inverse={gewaehlt}>{gewaehlt ? '▶ ' : '  '}[{i + 1}] {b.quelle === 'geraet' ? '(Gerät) ' : ''}{b.text.slice(0, Math.max(20, spalten - 26))}{alterText(b.seit, jetzt) ? <Text dimColor> {alterText(b.seit, jetzt)}</Text> : null}</Text>
            );
          })}
        </Box>
      ) : null}
      <Box borderStyle="single" borderColor="gray" paddingX={1} marginTop={1} flexDirection="column">
        <Text dimColor wrap="wrap">{statusText}</Text>
        <Text>{z.label}{e.text.slice(0, e.cursor)}<Text inverse>{e.text.charAt(e.cursor) || ' '}</Text>{e.text.slice(e.cursor + 1)}</Text>
      </Box>
      {spalten >= 70 ? <Text dimColor>Enter sendet · Strg+N oder \ am Zeilenende = neue Zeile · ↑/↓ Verlauf · Strg+T sprechen · Strg+G zuhören · Strg+B Bestätigungen · Strg+L Lage · Strg+Q Ende</Text> : null}
    </Box>
  );
}

export interface InkOptionen { stdout?: NodeJS.WriteStream; stdin?: NodeJS.ReadStream; debug?: boolean }

export class InkOberflaeche implements Oberflaeche {
  private readonly speicher: Speicher;
  private instanz?: Instance;
  private eingabeCb: (z: string) => void = () => undefined;
  private tasteCb: (t: Taste, nr?: number) => void = () => undefined;
  constructor(status: SitzungStatus, private readonly opts: InkOptionen = {}) { this.speicher = new Speicher(status); }
  start(): void {
    this.instanz = render(
      <Sitzung speicher={this.speicher} aufEingabe={(z) => this.eingabeCb(z)} aufTaste={(t, nr) => this.tasteCb(t, nr)} />,
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
  aufTaste(cb: (t: Taste, nr?: number) => void): void { this.tasteCb = cb; }
  schliessen(): void { try { this.instanz?.unmount(); } catch { /* */ } }
}

/** Ink nur mit echtem Terminal (Rohmodus); sonst readline. */
export function inkMoeglich(): boolean {
  return !!process.stdin.isTTY && !!process.stdout.isTTY && typeof (process.stdin as { setRawMode?: unknown }).setRawMode === 'function';
}
