import { describe, it, expect } from 'vitest';
import { mkdtempSync, writeFileSync, readFileSync, rmSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import os from 'node:os';
import path from 'node:path';
import { STARTER_JS, WMI_START_BEFEHL, wmiStartUmgebung } from './satellit-auftrag.js';

// v1478 — Starter für Aufträge außerhalb des Satelliten (Windows-WMI-Start): Ausgabe ins Protokoll, Exit-Code in exit.json
describe('v1478 Auftrags-Starter', () => {
  it('leitet Ausgabe ins Protokoll und schreibt den Exit-Code', () => {
    const d = mkdtempSync(path.join(os.tmpdir(), 'v1478-'));
    try {
      const start = path.join(d, 'start.json');
      writeFileSync(path.join(d, 'starter.cjs'), STARTER_JS);
      writeFileSync(start, JSON.stringify({ befehl: process.execPath, args: ['-e', "console.log('hallo ' + process.env.PROBE_V); process.exit(3)"], cwd: d, log: path.join(d, 'log.txt'), env: { PROBE_V: '1478' }, exitDatei: path.join(d, 'exit.json') }));
      execFileSync(process.execPath, [path.join(d, 'starter.cjs'), start]);
      expect(readFileSync(path.join(d, 'log.txt'), 'utf8')).toContain('hallo 1478');
      expect(JSON.parse(readFileSync(path.join(d, 'exit.json'), 'utf8'))).toEqual({ exit: 3 });
    } finally { rmSync(d, { recursive: true, force: true }); }
  });

  it('nicht startbarer Befehl: Fehler im Protokoll, exit null', () => {
    const d = mkdtempSync(path.join(os.tmpdir(), 'v1478-'));
    try {
      const start = path.join(d, 'start.json');
      writeFileSync(path.join(d, 'starter.cjs'), STARTER_JS);
      writeFileSync(start, JSON.stringify({ befehl: path.join(d, 'gibt-es-nicht.exe'), args: [], cwd: d, log: path.join(d, 'log.txt'), env: {}, exitDatei: path.join(d, 'exit.json') }));
      try { execFileSync(process.execPath, [path.join(d, 'starter.cjs'), start]); } catch { /* Exit 1 erwartet */ }
      expect(readFileSync(path.join(d, 'log.txt'), 'utf8')).toContain('Start fehlgeschlagen');
      expect(JSON.parse(readFileSync(path.join(d, 'exit.json'), 'utf8')).exit).toBeNull();
    } finally { rmSync(d, { recursive: true, force: true }); }
  });

  it('v1479 WMI-Befehl ist fest: Werte nur über Umgebungsvariablen, nie eingebettet', () => {
    const boese = "C:\\Users\\x\u2019; Remove-Item C:\\ -Recurse; \u2019";
    const e = wmiStartUmgebung('"C:\\node.exe" "C:\\a\\starter.cjs"', boese);
    expect(e.ALFRED_WMI_VERZEICHNIS).toBe(boese);
    expect(WMI_START_BEFEHL).not.toContain('Remove-Item');
    expect(WMI_START_BEFEHL).toContain('CommandLine=$env:ALFRED_WMI_KOMMANDOZEILE');
    expect(WMI_START_BEFEHL).toContain('CurrentDirectory=$env:ALFRED_WMI_VERZEICHNIS');
    expect(WMI_START_BEFEHL).toContain('ShowWindow=[uint16]0');
  });
});
