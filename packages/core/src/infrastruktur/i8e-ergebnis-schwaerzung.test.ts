import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { schwaerze } from '../fernzugriff/kaefig.js';

/**
 * Ruling R26 (Live-Change L2, computerkonto_vorbereiten SQLLNX02): die Transport-Schwärzung (fernzugriff → schwaerze, auf jede
 * Skriptausgabe angewandt) hielt den Ergebnis-Schlüssel „kennwortGesetzt“ für ein Geheimnis und ersetzte den Wert samt Komma →
 * ungültiges JSON, Schritt gescheitert. Hier: jeder Feldname, den die Bausteine dieser Etappe in ihre Ergebniszeile schreiben,
 * übersteht schwaerze unverändert (als String-, Wahrheits- und Zahlenwert), und die Zeile bleibt gültiges JSON.
 */
const QUELLEN = ['windows-ad-linux.ts', 'windows-ad.ts', 'windows-sqltls-linux.ts', 'linux-sql-ad.ts', 'linux-sql-tls.ts'];

/** Feldnamen aus dem Quelltext: PowerShell [ordered]@{ … } / [pscustomobject]@{ … }, bash \"name\": … und Python-Ergebnisse r["name"] */
function feldnamen(text: string): Set<string> {
  const namen = new Set<string>();
  for (const m of text.matchAll(/\[(?:ordered|pscustomobject)\]@\{([^}]*)\}/g)) for (const k of m[1]!.matchAll(/(?:^|[;{\s])([A-Za-z][A-Za-z0-9_]*)\s*=(?!=)/g)) namen.add(k[1]!);
  for (const m of text.matchAll(/\\"([A-Za-z][A-Za-z0-9_]*)\\":/g)) namen.add(m[1]!);
  for (const m of text.matchAll(/\br\["([A-Za-z][A-Za-z0-9_]*)"\]\s*=/g)) namen.add(m[1]!);
  // Python-Wörterbücher in json.dumps({"name": …})
  for (const m of text.matchAll(/[{,]\s*"([A-Za-z][A-Za-z0-9_]*)": /g)) namen.add(m[1]!);
  return namen;
}

describe('R26 — Ergebnisfelder der Etappe-3-Bausteine überstehen die Transport-Schwärzung', () => {
  const alle = new Map<string, string>();
  for (const q of QUELLEN) for (const n of feldnamen(readFileSync(new URL(`./${q}`, import.meta.url), 'utf8'))) if (!alle.has(n)) alle.set(n, q);

  it('Feldnamen gefunden (Stichprobe aus jedem Baustein)', () => {
    for (const n of ['zustand', 'einmalBereit', 'ohneAnmeldung', 'inOu', 'kvno', 'keytabNeu', 'salz', 'aenderungen', 'thumbprint'])
      expect(alle.has(n), n).toBe(true);
    expect(alle.has('kennwortGesetzt')).toBe(false);
    expect(alle.size).toBeGreaterThan(40);
  });

  it('jede Ergebniszeile bleibt unverändert und gültiges JSON (String-, Wahrheits-, Zahlen- und Listenwerte)', () => {
    const geschwaerzt: string[] = [];
    for (const [i, wert] of (['wert-abcd-1234', true, 4711, ['a-1', 'b-2']] as const).entries()) {
      const obj = Object.fromEntries([...alle.keys()].map(k => [k, wert]));
      const zeile = `irgendwas\nALFRED-AD ${JSON.stringify({ zustand: 'angelegt', ...obj, ende: i })}\n`;
      const aus = schwaerze(zeile).text;
      if (aus !== zeile) {
        // jedes Feld einzeln, damit der Fehler das Feld nennt
        for (const k of alle.keys()) {
          const z = `ALFRED-AD ${JSON.stringify({ zustand: 'x', [k]: wert, danach: true })}`;
          if (schwaerze(z).text !== z) geschwaerzt.push(`${k} (${alle.get(k)}, Wert ${JSON.stringify(wert)})`);
        }
      }
      const json = JSON.parse(aus.split('\n')[1]!.slice('ALFRED-AD '.length)) as Record<string, unknown>;
      expect(Object.keys(json).sort()).toEqual(['zustand', ...alle.keys(), 'ende'].filter((k, j, a) => a.indexOf(k) === j).sort());
    }
    expect([...new Set(geschwaerzt)]).toEqual([]);
  });

  it('Gegenprobe: ein Schlüssel mit Kennwort im Namen wird geschwärzt (Prüfung greift)', () => {
    const z = 'ALFRED-AD {"zustand":"angelegt","kennwortGesetzt":true,"ohneAnmeldung":true}';
    expect(schwaerze(z).text).not.toBe(z);
  });
});
