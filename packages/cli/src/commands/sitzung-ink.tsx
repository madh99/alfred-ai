import React, { useEffect, useState } from 'react';
import { render, Box, Text, Static, useInput, usePaste, useStdout, type Instance } from 'ink';
import type { Oberflaeche, SitzungStatus, Taste, EinstellungenAnbindung } from './sitzung-oberflaeche.js';
import type { Einstellung } from './satellit-einstellungen.js';

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

/** v1309 — Zustand des Einstellungsbilds (Strg+E). */
interface EinstellungenSicht { offen: boolean; liste: Einstellung[]; auswahl: number; modus: 'liste' | 'eintraege' | 'text'; eintrag: number; text: Eingabe; zweck: 'wort' | 'neu' | ''; meldung: string }
const SICHT_ZU: EinstellungenSicht = { offen: false, liste: [], auswahl: 0, modus: 'liste', eintrag: 0, text: { text: '', cursor: 0 }, zweck: '', meldung: '' };

/** Eintrag „pfad (lesen)" → Befehl zum Umschalten bzw. Entfernen. Rein, testbar. */
export function eintragBefehl(schluessel: string, eintrag: string, aktion: 'umschalten' | 'entfernen'): string | undefined {
  if (schluessel === 'freigabe') {
    const m = /^(.*) \((lesen|schreiben)\)$/.exec(eintrag);
    if (!m) return undefined;
    return `freigabe ${m[1]} ${aktion === 'entfernen' ? 'keins' : (m[2] === 'lesen' ? 'schreiben' : 'lesen')}`;
  }
  if (schluessel === 'fenster-sperre' || schluessel === 'foto-sperre') return aktion === 'entfernen' ? `${schluessel} - ${eintrag}` : undefined;
  return undefined;
}

function Sitzung({ speicher, aufEingabe, aufTaste, anbindung }: { speicher: Speicher; aufEingabe: (z: string) => void; aufTaste: (t: Taste, nr?: number) => void; anbindung: () => EinstellungenAnbindung | undefined }) {
  const [sicht, setSicht] = useState<EinstellungenSicht>(SICHT_ZU);
  const oeffneEinstellungen = () => { const a = anbindung(); if (!a) return; setSicht({ ...SICHT_ZU, offen: true, liste: a.liste() }); };
  const wende = (befehl: string, s: EinstellungenSicht): EinstellungenSicht => {
    const a = anbindung(); if (!a) return s;
    const meldung = a.befehl(befehl);
    return { ...s, liste: a.liste(), meldung, modus: s.modus === 'text' ? (s.zweck === 'wort' ? 'liste' : 'eintraege') : s.modus, zweck: '' };
  };
  const einstellungTaste = (input: string, key: Parameters<Parameters<typeof useInput>[0]>[1]): void => {
    const s = sicht;
    const e = s.liste[s.auswahl];
    if (s.modus === 'text') {
      if (key.escape) { setSicht({ ...s, modus: s.zweck === 'wort' ? 'liste' : 'eintraege', zweck: '' }); return; }
      if (key.return) {
        const t = s.text.text.trim();
        if (!t || !e) { setSicht({ ...s, modus: s.zweck === 'wort' ? 'liste' : 'eintraege', zweck: '' }); return; }
        const befehl = s.zweck === 'wort' ? `wort ${t}` : e.schluessel === 'freigabe' ? `freigabe ${t} lesen` : `${e.schluessel} + ${t}`;
        setSicht(wende(befehl, { ...s, text: { text: '', cursor: 0 } })); return;
      }
      setSicht({ ...s, text: eingabeTaste(s.text, input, key) }); return;
    }
    if (s.modus === 'eintraege') {
      const eintraege = e?.eintraege ?? [];
      const i = Math.min(s.eintrag, Math.max(0, eintraege.length - 1));
      if (key.escape) { setSicht({ ...s, modus: 'liste' }); return; }
      if (key.upArrow) { setSicht({ ...s, eintrag: Math.max(0, i - 1) }); return; }
      if (key.downArrow) { setSicht({ ...s, eintrag: Math.min(Math.max(0, eintraege.length - 1), i + 1) }); return; }
      if (input === '+') { setSicht({ ...s, modus: 'text', zweck: 'neu', text: { text: '', cursor: 0 } }); return; }
      if (e && eintraege[i] && (key.delete || key.backspace || input === '-')) { const b = eintragBefehl(e.schluessel, eintraege[i]!, 'entfernen'); if (b) setSicht(wende(b, { ...s, eintrag: Math.max(0, i - 1) })); return; }
      if (e && eintraege[i] && key.return) { const b = eintragBefehl(e.schluessel, eintraege[i]!, 'umschalten'); if (b) setSicht(wende(b, s)); return; }
      return;
    }
    if (key.escape) { setSicht(SICHT_ZU); return; }
    if (key.upArrow) { setSicht({ ...s, auswahl: Math.max(0, s.auswahl - 1), meldung: '' }); return; }
    if (key.downArrow) { setSicht({ ...s, auswahl: Math.min(s.liste.length - 1, s.auswahl + 1), meldung: '' }); return; }
    if (key.return && e) {
      if (e.art === 'schalter') { setSicht(wende(e.schluessel === 'oberflaeche' ? `oberflaeche ${e.wert === 'ink' ? 'einfach' : 'ink'}` : `sinne-fenster ${e.wert === 'an' ? 'aus' : 'an'}`, s)); return; }
      if (e.art === 'text') { setSicht({ ...s, modus: 'text', zweck: 'wort', text: { text: e.wert, cursor: e.wert.length } }); return; }
      if (e.art === 'liste') { setSicht({ ...s, modus: 'eintraege', eintrag: 0 }); return; }
    }
  };
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
    const t = setInterval(() => setTick(x => x + 1), 250); // Spinner, Antwortdauer, Alter der Bestätigungen
    const aufGroesse = () => setSpalten(stdout?.columns ?? 80);
    stdout?.on?.('resize', aufGroesse);
    return () => { clearInterval(t); stdout?.off?.('resize', aufGroesse); };
  }, [stdout]);
  usePaste((text) => { setE(x => ({ text: x.text.slice(0, x.cursor) + text + x.text.slice(x.cursor), cursor: x.cursor + text.length })); });
  useInput((input, key) => {
    if (key.ctrl && input === 't') { aufTaste('strg+t'); return; }
    if (key.ctrl && input === 'l') { aufTaste('lage'); return; }
    if (key.ctrl && input === 'g') { aufTaste('hoeren'); return; } // v1307 — Zuhören an/aus (Strg+H wäre die Rücktaste)
    if (key.ctrl && input === 'e') { if (sicht.offen) setSicht(SICHT_ZU); else oeffneEinstellungen(); return; } // v1309
    if (sicht.offen && !(key.ctrl && (input === 'q' || input === 'd'))) { einstellungTaste(input, key); return; }
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
  const offene = s.offenListe ?? [];
  const jetzt = Date.now();
  // v1310 — Leiste wie im Terminal des Owners: links knapp das Gerät, rechts Abzeichen nur für das, was gerade zählt
  const links = [`${s.geraet} ${s.version}`, `Satellit: ${s.satellitVersion ?? s.satellit}${s.verbunden === undefined ? '' : s.verbunden ? ' ●' : ' ○'}`, s.tier ? `Stufe ${s.tier}` : ''].filter(Boolean).join(' · ');
  const feldZeigt = feldSichtbar && offene.length > 0;
  const abzeichen: Array<{ text: string; farbe: string }> = [];
  if (s.offen > 0 && !feldZeigt) abzeichen.push({ text: `🔔 ${s.offen} ${s.offen === 1 ? 'Bestätigung' : 'Bestätigungen'} · Strg+B`, farbe: 'yellow' });
  if (s.neuer && s.satellitVersion) abzeichen.push({ text: `⬆ Satellit ${s.satellitVersion} · Sitzung neu starten`, farbe: 'green' });
  if (s.modus === 'antwort') abzeichen.push({ text: `${SPINNER[tick % SPINNER.length]} antwortet${s.antwortSeit ? ` ${Math.round((jetzt - s.antwortSeit) / 1000)} s` : ''}`, farbe: 'cyan' });
  if (s.modus === 'aufnahme') abzeichen.push({ text: '● Aufnahme · Strg+T stoppt', farbe: 'red' });
  if (s.hoeren) abzeichen.push({ text: '🎧 hört zu', farbe: 'magenta' });
  if (s.stimme) abzeichen.push({ text: '🔊 liest vor', farbe: 'blue' });
  const prompt = z.label === 'Du: ' ? '> ' : z.label;
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
      {sicht.offen ? (
        <Box flexDirection="column" borderStyle="round" borderColor="magenta" paddingX={1} marginTop={1}>
          <Text color="magenta" bold>Einstellungen — {sicht.modus === 'liste' ? '↑/↓ wählen · Enter öffnen/umschalten · Esc oder Strg+E schließen' : sicht.modus === 'eintraege' ? '↑/↓ wählen · Enter lesen↔schreiben · Entf/- entfernen · + hinzufügen · Esc zurück' : 'Text eingeben · Enter übernehmen · Esc abbrechen'}</Text>
          {sicht.liste.map((e, i) => (
            <Box key={e.schluessel} flexDirection="column">
              <Text inverse={sicht.modus === 'liste' && i === sicht.auswahl} dimColor={e.art === 'info'}>{sicht.modus === 'liste' && i === sicht.auswahl ? '▶ ' : '  '}{e.titel}: {e.wert}{e.hinweis && i === sicht.auswahl ? <Text dimColor>  ({e.hinweis})</Text> : null}</Text>
              {i === sicht.auswahl && sicht.modus === 'eintraege' ? (e.eintraege?.length ? e.eintraege.map((x, j) => <Text key={x} inverse={j === Math.min(sicht.eintrag, e.eintraege!.length - 1)}>{'     '}{x}</Text>) : <Text dimColor>{'     '}(leer — + fügt hinzu)</Text>) : null}
              {i === sicht.auswahl && sicht.modus === 'text' ? <Text>{'     '}{sicht.zweck === 'wort' ? 'Wort: ' : 'Neu: '}{sicht.text.text.slice(0, sicht.text.cursor)}<Text inverse>{sicht.text.text.charAt(sicht.text.cursor) || ' '}</Text>{sicht.text.text.slice(sicht.text.cursor + 1)}</Text> : null}
            </Box>
          ))}
          {sicht.meldung ? <Text color="green">{sicht.meldung}</Text> : null}
        </Box>
      ) : null}
      {/* v1311 — wie die Vorlagen des Owners: Linie, Eingabe, Linie, darunter die Fußzeile mit Status links und Abzeichen rechts */}
      <Text dimColor>{'─'.repeat(Math.max(10, spalten))}</Text>
      <Text>{prompt}{e.text.slice(0, e.cursor)}<Text inverse>{e.text.charAt(e.cursor) || ' '}</Text>{e.text.slice(e.cursor + 1)}</Text>
      <Text dimColor>{'─'.repeat(Math.max(10, spalten))}</Text>
      <Box width={spalten} justifyContent="space-between">
        <Text dimColor>{links}</Text>
        <Box>{abzeichen.map((a, i) => <Text key={i} color={a.farbe}>{i ? '  ' : ''}{a.text}</Text>)}</Box>
      </Box>
      {spalten >= 90 ? <Text dimColor>Enter sendet · Strg+N oder \ = neue Zeile · ↑/↓ Verlauf · Strg+T sprechen · Strg+G zuhören · Strg+B Bestätigungen · Strg+E Einstellungen · Strg+L Lage · Strg+Q Ende</Text> : null}
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
      <Sitzung speicher={this.speicher} aufEingabe={(z) => this.eingabeCb(z)} aufTaste={(t, nr) => this.tasteCb(t, nr)} anbindung={() => this.anbindung} />,
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
  private anbindung?: EinstellungenAnbindung;
  einstellungen(a: EinstellungenAnbindung): void { this.anbindung = a; } // v1309
  schliessen(): void { try { this.instanz?.unmount(); } catch { /* */ } }
}

/** Ink nur mit echtem Terminal (Rohmodus); sonst readline. */
export function inkMoeglich(): boolean {
  return !!process.stdin.isTTY && !!process.stdout.isTTY && typeof (process.stdin as { setRawMode?: unknown }).setRawMode === 'function';
}
