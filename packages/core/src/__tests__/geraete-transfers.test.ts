import { describe, it, expect } from 'vitest';
import os from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { mkdtempSync } from 'node:fs';
import { Transfers, TransferOffsetFehler, TRANSFER_TTL_MS } from '../geraete/transfers.js';
import { TRANSFER_BLOCK_BYTES } from '../geraete/protokoll.js';

// v1249 — Dateitransfer Stufe 2: Blöcke, Offset, Prüfsumme, Wiederaufnahme, Ablauf.
const sha = (b: Buffer) => createHash('sha256').update(b).digest('hex');

describe('Transfers', () => {
  it('Upload in Blöcken mit Wiederaufnahme und Prüfsumme', () => {
    const t = new Transfers(mkdtempSync(path.join(os.tmpdir(), 'alfred-transfer-')));
    const daten = Buffer.alloc(10_000, 7);
    const { id, blockGroesse } = t.starteUpload('g1', '../böse/name.bin', daten.length, sha(daten));
    expect(blockGroesse).toBe(TRANSFER_BLOCK_BYTES);
    expect(t.schreibeBlock(id, 0, daten.subarray(0, 4000), 'g1').empfangen).toBe(4000);
    // Wiederholung desselben Blocks (Netzabbruch): Offset passt nicht → Aufrufer liest „weiter bei"
    let fehler: unknown;
    try { t.schreibeBlock(id, 0, daten.subarray(0, 4000), 'g1'); } catch (e) { fehler = e; }
    expect(fehler).toBeInstanceOf(TransferOffsetFehler);
    expect((fehler as TransferOffsetFehler).empfangen).toBe(4000);
    expect(t.status(id).empfangen).toBe(4000);
    expect(() => t.schreibeBlock(id, 4000, daten.subarray(4000), 'g2')).toThrow(/anderen Gerät/);
    expect(() => t.schliesseUpload(id)).toThrow(/unvollständig/);
    t.schreibeBlock(id, 4000, daten.subarray(4000), 'g1');
    const f = t.schliesseUpload(id, 'g1');
    expect(f.name).toBe('name.bin');
    expect(f.data.equals(daten)).toBe(true);
    expect(t.anzahl()).toBe(0);
  });
  it('falsche Prüfsumme wird abgewiesen; Download liest Blöcke; abgelaufene Einträge verschwinden', () => {
    let jetzt = 1_000_000;
    const t = new Transfers(mkdtempSync(path.join(os.tmpdir(), 'alfred-transfer-')), () => jetzt);
    const daten = Buffer.from('hallo welt');
    const { id } = t.starteUpload('g', 'a.txt', daten.length, sha(Buffer.from('anders')));
    t.schreibeBlock(id, 0, daten);
    expect(() => t.schliesseUpload(id)).toThrow(/Prüfsumme/);
    const d = t.bereitstellen('g', 'b.bin', Buffer.alloc(9_000, 1));
    expect(t.leseBlock(d.id, 0, 4_000).length).toBe(4_000);
    expect(t.leseBlock(d.id, 8_000, 4_000).length).toBe(1_000);
    expect(() => t.leseBlock(d.id, 9_000, 10)).toThrow(/außerhalb/);
    jetzt += TRANSFER_TTL_MS + 1;
    t.starteUpload('g', 'c', 1, sha(Buffer.from('x'))); // löst Aufräumen aus
    expect(() => t.status(d.id)).toThrow(/unbekannt/);
    expect(() => t.starteUpload('g', 'x', 60 * 1024 * 1024, sha(daten))).toThrow(/zu groß/);
  });
});
