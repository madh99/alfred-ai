import { ladeKonfig, speichereKonfig, type GeraetKonfig } from './pair.js';
import { dienstStatus } from './satellit-dienst.js';
import { getVersion } from '../version.js';
import { verbindeIpc, type IpcClient } from './satellit-ipc.js';
import { einstellungen, wendeAn, trenneBefehl, einstellungenText, EINSTELLUNGEN_HILFE } from './satellit-einstellungen.js';
import type { EinstellungenAnbindung } from './sitzung-oberflaeche.js';

/**
 * v1309 — Einstellungen anwenden: in geraet.json speichern und den laufenden Satelliten per IPC neu laden lassen.
 * Ein Weg für Sitzung (Ink-Bild, /einstellungen) und `alfred einstellungen`.
 */
export function einstellungenAnbindung(k: GeraetKonfig, ipc: () => IpcClient | undefined, dienst: () => string): EinstellungenAnbindung {
  return {
    liste: () => einstellungen(k, { version: getVersion(), dienst: dienst() }),
    befehl: (zeile) => {
      const { befehl, arg } = trenneBefehl(zeile);
      if (!befehl || befehl === 'hilfe' || befehl === '?') return EINSTELLUNGEN_HILFE.join('\n');
      const r = wendeAn(k, befehl, arg);
      if (!r.ok) return r.text;
      speichereKonfig(k);
      try { ipc()?.sende({ typ: 'befehl', befehl: 'neuladen' }); } catch { /* Satellit liest beim nächsten Start */ }
      return `✓ ${r.text}`;
    },
  };
}

/** `alfred einstellungen` — ohne Argumente anzeigen, sonst einen Befehl anwenden. */
export async function einstellungenCommand(args: string[]): Promise<void> {
  const k = ladeKonfig();
  if (!k) { console.error('Nicht gekoppelt. Zuerst: alfred pair --server https://host:3420 --code <Code>'); process.exit(1); }
  let ipc: IpcClient | undefined;
  try { ipc = await verbindeIpc(() => undefined, undefined, undefined, 1000); } catch { ipc = undefined; }
  const a = einstellungenAnbindung(k, () => ipc, () => dienstStatus());
  if (args.length === 0) {
    console.log(einstellungenText(a.liste()));
    console.log('\nÄndern: alfred einstellungen <befehl> …');
    console.log(EINSTELLUNGEN_HILFE.map(z => '  ' + z).join('\n'));
  } else {
    console.log(a.befehl(args.join(' ')));
  }
  setTimeout(() => { ipc?.close(); process.exit(0); }, 150); // Neuladen-Befehl noch zustellen
}
