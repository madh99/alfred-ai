import { describe, it, expect } from 'vitest';
import path from 'node:path';
import { heim, heimInParams } from './satellit-pfad.js';

describe('Tilde im Pfad (v1303)', () => {
  const home = process.platform === 'win32' ? 'C:\\Users\\test' : '/home/test';
  it('löst ~ und ~/… auf, lässt andere Pfade in Ruhe', () => {
    expect(heim('~', home)).toBe(home);
    expect(heim('~/Downloads', home)).toBe(path.join(home, 'Downloads'));
    expect(heim('~\\Documents\\a.xlsx', home)).toBe(path.join(home, 'Documents', 'a.xlsx'));
    expect(heim('~nutzer/x', home)).toBe('~nutzer/x');
    expect(heim('/tmp/x', home)).toBe('/tmp/x');
    expect(heim('', home)).toBe('');
  });
  it('heimInParams: path, pfad, datei, cwd — nur Strings mit Tilde', () => {
    const p: Record<string, unknown> = { path: '~/Downloads', pfad: '~', datei: 'C:/x.xlsx', cwd: '~/Documents', text: '~/nicht', n: 5 };
    heimInParams(p, home);
    expect(p.path).toBe(path.join(home, 'Downloads'));
    expect(p.pfad).toBe(home);
    expect(p.datei).toBe('C:/x.xlsx');
    expect(p.cwd).toBe(path.join(home, 'Documents'));
    expect(p.text).toBe('~/nicht');
    expect(p.n).toBe(5);
  });
});
