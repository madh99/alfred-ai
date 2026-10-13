import { describe, it, expect } from 'vitest';
import os from 'node:os';
import path from 'node:path';
import { mkdtempSync, writeFileSync, mkdirSync, rmSync } from 'node:fs';
import { musterPasst, istTemporaer, Buendler, BeobachterVerwaltung, type Beobachtung } from './satellit-beobachter.js';

const warte = (ms: number) => new Promise(r => setTimeout(r, ms));

describe('v1429 R4a — Beobachter am Satelliten', () => {
  it('Muster und temporäre Dateien', () => {
    expect(musterPasst('*.pdf, Rechnung*', 'Rechnung-Oktober.PDF')).toBe(true);
    expect(musterPasst('*.pdf', 'bild.png')).toBe(false);
    expect(musterPasst('', 'alles.txt')).toBe(true);
    expect(istTemporaer('~$bericht.docx')).toBe(true);
    expect(istTemporaer('film.mp4.crdownload')).toBe(true);
    expect(istTemporaer('rechnung.pdf')).toBe(false);
  });

  it('Bündeln und drosseln: Überlauf als Sammel-Ereignis', () => {
    const raus: Beobachtung[][] = [];
    const b = new Buendler((e) => raus.push(e), { maxProMinute: 3, jetzt: () => 1_000_000 });
    for (let i = 0; i < 5; i++) b.push({ regel: 'r1', quelle: 'ordner', art: 'neu', schluessel: `k${i}`, zeit: '', kopf: { name: `d${i}` } });
    b.leere(); b.stop();
    expect(raus).toHaveLength(1);
    expect(raus[0]!.filter(e => e.art === 'neu')).toHaveLength(3);
    expect(raus[0]!.find(e => e.art === 'sammel')?.kopf.anzahl).toBe(2);
  });

  it('neue Datei im freigegebenen Ordner wird gemeldet (stabil, mit Muster); Bestand und Fremdes nicht', async () => {
    const dir = mkdtempSync(path.join(os.tmpdir(), 'alfred-beob-'));
    writeFileSync(path.join(dir, 'alt.pdf'), 'x');
    const raus: Beobachtung[] = [];
    const v = new BeobachterVerwaltung({ senden: (e) => raus.push(...e), erlaubt: (p) => p.startsWith(dir), veto: () => false, stabilMs: 120, intervallMs: 50 });
    v.setze([{ id: 'r1', quelle: 'ordner', pfad: dir, muster: '*.pdf', ereignisse: ['neu'] }]);
    expect(v.stand()[0]!.zustand).toBe('laeuft');
    await warte(100);
    writeFileSync(path.join(dir, 'rechnung.pdf'), 'inhalt');
    writeFileSync(path.join(dir, 'notiz.txt'), 'nicht gemeint');
    await warte(1200);
    v.stopAlle();
    expect(raus.map(r => r.kopf.name)).toEqual(['rechnung.pdf']);
    expect(raus[0]!.kopf).not.toHaveProperty('inhalt');
    rmSync(dir, { recursive: true, force: true });
  });

  it('nicht freigegebener Ordner und lokales Veto', () => {
    const v = new BeobachterVerwaltung({ senden: () => undefined, erlaubt: () => false, veto: () => false });
    v.setze([{ id: 'r1', quelle: 'ordner', pfad: '/geheim', ereignisse: ['neu'] }]);
    expect(v.stand()[0]).toMatchObject({ zustand: 'gestoert' });
    const aus = new BeobachterVerwaltung({ senden: () => undefined, erlaubt: () => true, veto: () => true });
    aus.setze([{ id: 'r2', quelle: 'ordner', pfad: os.tmpdir() }]);
    expect(aus.stand()[0]).toMatchObject({ zustand: 'aus', grund: 'am Gerät abgeschaltet' });
  });

  it('fehlender Ordner = gestört, nicht still', () => {
    const d = path.join(os.tmpdir(), `alfred-fehlt-${Date.now()}`);
    mkdirSync(d); rmSync(d, { recursive: true });
    const v = new BeobachterVerwaltung({ senden: () => undefined, erlaubt: () => true, veto: () => false });
    v.setze([{ id: 'r1', quelle: 'ordner', pfad: d }]);
    expect(v.stand()[0]).toMatchObject({ zustand: 'gestoert', grund: 'Ordner fehlt' });
  });
});

describe('v1430 R4b — Benachrichtigungen und Outlook', () => {
  it('Benachrichtigungen: erster Lauf nur Bestand, danach nur Apps der Regel, nur App + Titel', async () => {
    let liste = [{ app: 'WhatsApp', zeit: '1', titel: 'Alt', text: 'geheim' }];
    const raus: Beobachtung[] = [];
    const v = new BeobachterVerwaltung({ senden: (e) => raus.push(...e), erlaubt: () => true, veto: () => false, intervallMs: 10, benachrichtigungen: async () => liste, abfrageMs: { benachrichtigung: 30 } });
    v.setze([{ id: 'b1', quelle: 'benachrichtigung', apps: ['whatsapp'] }]);
    await warte(20);
    liste = [...liste, { app: 'WhatsApp', zeit: '2', titel: 'Neu von Lena', text: 'geheim' }, { app: 'Teams', zeit: '3', titel: 'Fremd', text: 'x' }];
    await warte(120);
    v.stopAlle();
    expect(raus.map(r => r.kopf.titel)).toEqual(['Neu von Lena']);
    expect(raus[0]!.kopf).not.toHaveProperty('text');
  });

  it('Outlook: Filter Absender/Betreff, Konten im Stand, Lesefehler = gestört', async () => {
    let mails = [{ id: 'm1', datum: 'd', von: 'Bank <info@bank.at>', betreff: 'Kontoauszug', anhaenge: 1 }];
    const raus: Beobachtung[] = [];
    const v = new BeobachterVerwaltung({ senden: (e) => raus.push(...e), erlaubt: () => true, veto: () => false, intervallMs: 10, outlook: async () => mails, outlookKonten: async () => ['md@firma.at'], abfrageMs: { outlook: 30 } });
    v.setze([{ id: 'o1', quelle: 'outlook', absender: 'bank' }]);
    await warte(20);
    mails = [{ id: 'm3', datum: 'd', von: 'Newsletter <n@x.at>', betreff: 'Angebot', anhaenge: 0 }, { id: 'm2', datum: 'd', von: 'Bank <info@bank.at>', betreff: 'Neue Rechnung', anhaenge: 1 }, ...mails];
    await warte(120);
    expect(raus.map(r => r.kopf.betreff)).toEqual(['Neue Rechnung']);
    expect(v.stand()[0]).toMatchObject({ zustand: 'laeuft', konten: ['md@firma.at'] });
    v.stopAlle();
    const kaputt = new BeobachterVerwaltung({ senden: () => undefined, erlaubt: () => true, veto: () => false, outlook: async () => { throw new Error('80080005 Integritätsstufe'); }, abfrageMs: { outlook: 1000 } });
    kaputt.setze([{ id: 'o2', quelle: 'outlook' }]);
    await warte(20);
    expect(kaputt.stand()[0]).toMatchObject({ zustand: 'gestoert', grund: '80080005 Integritätsstufe' });
    kaputt.stopAlle();
  });

  it('ohne Quelle (Linux, kein Outlook): gestört mit Grund statt still', () => {
    const v = new BeobachterVerwaltung({ senden: () => undefined, erlaubt: () => true, veto: () => false });
    v.setze([{ id: 'b', quelle: 'benachrichtigung', apps: ['x'] }, { id: 'o', quelle: 'outlook' }]);
    expect(v.stand().map(s => s.zustand)).toEqual(['gestoert', 'gestoert']);
  });
});

describe('v1431 R4c — Build-Wache', () => {
  it('meldet nur Wechsel (erst rot, dann grün), pausiert bei laufendem Auftrag', async () => {
    const { BuildWache } = await import('./satellit-beobachter.js');
    const ergebnisse = [true, false, false, true];
    let i = 0; let beschaeftigt = false;
    const raus: Beobachtung[] = [];
    const w = new BuildWache({ id: 'w1', quelle: 'build', pfad: '/p', befehle: ['npm test'] }, { pruefen: async () => ({ ok: ergebnisse[i++] ?? true, text: 'FAIL x.test.js' }), beschaeftigt: () => beschaeftigt, melde: (b) => raus.push(b), intervallMs: 1_000_000 });
    for (let n = 0; n < 4; n++) await w.runde();
    expect(raus.map(r => r.art)).toEqual(['rot', 'gruen']);
    expect(raus[0]!.kopf).toMatchObject({ pfad: '/p', befehle: ['npm test'], auszug: 'FAIL x.test.js' });
    beschaeftigt = true;
    await w.runde();
    expect(w.stand.grund).toBe('pausiert: Auftrag läuft im Projekt');
    expect(i).toBe(4);
  });
});
