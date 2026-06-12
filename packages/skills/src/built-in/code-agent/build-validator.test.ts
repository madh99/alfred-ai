import { describe, it, expect } from 'vitest';
import { validateBuild } from './build-validator.js';

/**
 * v877.1 — Timeout-Sichtbarkeit + Header-Erhalt bei Tail-Kürzung.
 * Hintergrund (Vorfall 12.06.): Testsuite 307s bei 300s-Limit → SIGTERM,
 * Output grün, "exit 124" ohne Erklärung, Header weggekürzt → Fix-Agent
 * suchte einen Bug, den es nie gab.
 */
describe('validateBuild (v877.1)', () => {
  it('passing command yields passed=true with header line', async () => {
    const r = await validateBuild(process.cwd(), ['node -e "console.log(42)"'], []);
    expect(r.passed).toBe(true);
    expect(r.combinedOutput).toContain('(exit 0');
    expect(r.combinedOutput).not.toContain('TIMEOUT');
  });

  it('failing command yields passed=false and stops the chain', async () => {
    const r = await validateBuild(process.cwd(), ['node -e "process.exit(3)"', 'node -e "console.log(7)"'], []);
    expect(r.passed).toBe(false);
    expect(r.commands).toHaveLength(1);
    expect(r.combinedOutput).toContain('(exit 3');
  });

  it('timed-out command is explicitly marked as TIMEOUT (not just exit 124)', async () => {
    // 3s-Child bei 800ms-Limit: killed-Flag wird bei 800ms gesetzt; unter Windows
    // (cmd.exe als Shell-Zwischenprozess) überlebt das Node-Enkelkind den SIGTERM
    // und hält die Pipes — close feuert erst wenn es selbst endet (~3s, statt 30s).
    const r = await validateBuild(process.cwd(), ['node -e "setTimeout(function(){},3000)"'], [], 800);
    expect(r.passed).toBe(false);
    expect(r.commands[0].timedOut).toBe(true);
    expect(r.combinedOutput).toContain('TIMEOUT');
    expect(r.combinedOutput).toContain('kein Code-Fehler');
  }, 15_000);

  it('command overview survives tail truncation (headers visible despite 8k cut)', async () => {
    // >8k Output erzeugen, dann fehlschlagen: Header der Übersicht muss trotz Kürzung da sein
    const big = `node -e "for(let i=0;i<900;i++)console.log('zeile-'+i+'-xxxxxxxxxxxxxxxxxxxxxxxxxxxxxx')"`;
    const r = await validateBuild(process.cwd(), [big, 'node -e "process.exit(2)"'], []);
    expect(r.passed).toBe(false);
    expect(r.combinedOutput).toContain('## Command-Übersicht');
    expect(r.combinedOutput).toContain('(exit 2');
    expect(r.combinedOutput).toContain('[...truncated...]');
  }, 15_000);
});
