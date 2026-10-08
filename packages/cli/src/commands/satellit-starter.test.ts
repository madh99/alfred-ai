import { describe, it, expect } from 'vitest';
import os from 'node:os';
import path from 'node:path';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { schreibeStarter, ergaenzePath, starterAufrufWindows, starterAufrufUnix } from './satellit-starter.js';

describe('alfred-Starter in ~/.alfred/bin (v1304)', () => {
  it('schreibt Starter-JS und Aufruf je Plattform', () => {
    const d = mkdtempSync(path.join(os.tmpdir(), 'alfred-starter-'));
    const win = schreibeStarter(path.join(d, 'w'), 'C:\\node\\node.exe', 'win32');
    expect(win.map(p => path.basename(p))).toEqual(['alfred-start.js', 'alfred.cmd']);
    expect(readFileSync(win[1]!, 'utf8')).toContain('"%ALFRED_NODE%" "%~dp0alfred-start.js" %*');
    const unix = schreibeStarter(path.join(d, 'u'), '/usr/local/bin/node', 'darwin');
    expect(unix.map(p => path.basename(p))).toEqual(['alfred-start.js', 'alfred']);
    expect(readFileSync(unix[1]!, 'utf8')).toContain('exec "$N" "$(dirname "$0")/alfred-start.js" "$@"');
    expect(starterAufrufWindows('n').startsWith('@echo off')).toBe(true);
    expect(starterAufrufUnix('n').startsWith('#!/bin/sh')).toBe(true);
  });

  it('alfred-start.js führt die Version aus aktuell.json aus und reicht Argumente durch; bei gescheiterter Probe die vorige', () => {
    const home = mkdtempSync(path.join(os.tmpdir(), 'alfred-home-'));
    const bundle = (v: string) => path.join(home, '.alfred', 'cli', v, 'node_modules', '@madh-io', 'alfred-ai', 'bundle');
    for (const v of ['0.19.0-jarvis.1303', '0.19.0-jarvis.1304']) { mkdirSync(bundle(v), { recursive: true }); writeFileSync(path.join(bundle(v), 'index.js'), `console.log(JSON.stringify({ v: '${v}', args: process.argv.slice(2) }));`); }
    const cliDir = path.join(home, '.alfred', 'cli');
    writeFileSync(path.join(cliDir, 'aktuell.json'), JSON.stringify({ version: '0.19.0-jarvis.1304', einstieg: path.join(bundle('0.19.0-jarvis.1304'), 'index.js'), vorige: '0.19.0-jarvis.1303', bestaetigt: true }));
    const [js] = schreibeStarter(path.join(home, '.alfred', 'bin'), process.execPath, process.platform);
    const env = { ...process.env, HOME: home, USERPROFILE: home };
    const r1 = spawnSync(process.execPath, [js!, 'sitzung', '--einfach'], { env, encoding: 'utf8' });
    expect(JSON.parse(r1.stdout.trim())).toEqual({ v: '0.19.0-jarvis.1304', args: ['sitzung', '--einfach'] });
    writeFileSync(path.join(cliDir, 'aktuell.json'), JSON.stringify({ version: '0.19.0-jarvis.1304', einstieg: path.join(bundle('0.19.0-jarvis.1304'), 'index.js'), vorige: '0.19.0-jarvis.1303', gescheitert: true }));
    const r2 = spawnSync(process.execPath, [js!, 'x'], { env, encoding: 'utf8' });
    expect(JSON.parse(r2.stdout.trim()).v).toBe('0.19.0-jarvis.1303');
  });

  it('ergaenzePath (unix): Zeile einmal in die erste Datei, nie doppelt', () => {
    const home = mkdtempSync(path.join(os.tmpdir(), 'alfred-path-'));
    expect(ergaenzePath(path.join(home, '.alfred', 'bin'), 'linux', home)).toContain('.bashrc');
    expect(existsSync(path.join(home, '.bashrc'))).toBe(true);
    expect(ergaenzePath(path.join(home, '.alfred', 'bin'), 'linux', home)).toBe('PATH-Zeile schon vorhanden');
    expect((readFileSync(path.join(home, '.bashrc'), 'utf8').match(/alfred\/bin/g) ?? []).length).toBe(1);
  });
});
