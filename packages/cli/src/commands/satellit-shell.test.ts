import { describe, it, expect } from 'vitest';
import os from 'node:os';
import path from 'node:path';
import { mkdtempSync } from 'node:fs';
import { fuehreAus } from './satellit.js';

describe('v1450 shell: Ausgabe auch bei Exit-Code ≠ 0', () => {
  it('liefert Exit-Code und die letzten Zeilen von stdout/stderr statt nur „Command failed: <Befehl>“', async () => {
    const d = mkdtempSync(path.join(os.tmpdir(), 'v1450-'));
    const befehl = process.platform === 'win32'
      ? "Write-Output '--- Startprotokoll ---'; Write-Output 'Server laeuft auf Port 3000'; [Console]::Error.WriteLine('curl: (7) Failed to connect'); exit 7"
      : "echo '--- Startprotokoll ---'; echo 'Server laeuft auf Port 3000'; echo 'curl: (7) Failed to connect' >&2; exit 7";
    const r = await fuehreAus({ name: 'Test', freigegebeneVerzeichnisse: [d] } as never, 'shell', { command: befehl, cwd: d });
    expect(r.success).toBe(false);
    expect(r.error).toContain('Befehl endete mit Exit-Code 7');
    expect(r.error).toContain('Server laeuft auf Port 3000');
    expect(r.error).toContain('Failed to connect');
    expect(r.error).not.toContain('Command failed');
  });
});
