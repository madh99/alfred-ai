/**
 * v1543 (Owner 22.10. „F1–F4 wie empfohlen“, Teil F4) — feste Regel „Wiederherstellbarkeit“. Realfall 21.10.: zpool status zeigte
 * dauerhafte Datenfehler in vm-106-disk-1 und Snapshots von VM 100/115; Alfred empfahl „aktuellere Sicherungen suchen“, fragte aber
 * weder Commvault noch die übrigen Backup-Speicher. Jetzt: Nennt die Ausgabe von zpool status dauerhafte Fehler in VM-Volumes, prüft
 * der Fernzugriff von sich aus alle Sicherungsquellen dieser VMs und hängt das Ergebnis an — unabhängig davon, was das Modell tut.
 */

export interface BackupEintrag { speicher: string; volid: string; zeit: string; groesse?: number; geprueft?: string }
export interface Wiederherstellbarkeit {
  vmid: number;
  name?: string;
  backups: BackupEintrag[];
  unerreichbar: Array<{ speicher: string; grund: string }>;
  speicher: string[];
  /** null = Commvault nicht eingerichtet oder VM dort unbekannt; fehler = Abfrage gescheitert */
  commvault: { status: string; letzte?: string } | null | { fehler: string };
  fehler?: string;
}

/** VM- und Container-IDs aus dem Abschnitt „Permanent errors“ von `zpool status -v` (vm-106-disk-1, subvol-115-disk-0, base-…). */
export function betroffeneVmids(ausgabe: string): number[] {
  const i = ausgabe.search(/permanent errors/i);
  if (i < 0) return [];
  const ids = new Set<number>();
  for (const m of ausgabe.slice(i).matchAll(/\b(?:vm|subvol|base)-(\d{1,9})-(?:disk|state|cloudinit)/g)) ids.add(Number(m[1]));
  return [...ids].sort((a, b) => a - b).slice(0, 20);
}

const ALT_TAGE = 7;

function datum(iso: string): string {
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? iso : d.toLocaleDateString('de-AT', { day: '2-digit', month: '2-digit', year: 'numeric', timeZone: 'Europe/Vienna' });
}

export function wiederherstellbarkeitText(liste: Wiederherstellbarkeit[], jetzt = new Date()): string {
  const zeilen = ['### Wiederherstellbarkeit (automatisch geprüft)', ''];
  for (const w of liste) {
    const kopf = `**VM ${w.vmid}${w.name ? ` (${w.name})` : ''}**`;
    if (w.fehler) { zeilen.push(`- ${kopf}: Prüfung nicht möglich — ${w.fehler}`); continue; }
    const neueste = w.backups[0];
    const teile: string[] = [];
    if (neueste) {
      const tage = Math.floor((jetzt.getTime() - Date.parse(neueste.zeit)) / 86_400_000);
      teile.push(`neueste Proxmox-Sicherung ${datum(neueste.zeit)} auf ${neueste.speicher} (vor ${tage} Tagen${tage > ALT_TAGE ? ' ⚠️ veraltet' : ''})${neueste.geprueft ? `, Prüfung: ${neueste.geprueft}` : ''}; insgesamt ${w.backups.length}`);
    } else {
      teile.push(`⚠️ keine Proxmox-Sicherung auf ${w.speicher.length} Backup-Speicher(n)`);
    }
    if (w.commvault === null) teile.push('Commvault: nicht gefunden');
    else if ('fehler' in w.commvault) teile.push(`Commvault: Abfrage fehlgeschlagen (${w.commvault.fehler})`);
    else teile.push(`Commvault: ${w.commvault.status}${w.commvault.letzte ? `, letzte Sicherung ${datum(w.commvault.letzte)}` : ''}`);
    if (w.unerreichbar.length) teile.push(`nicht geprüft: ${w.unerreichbar.map(u => `${u.speicher} (${u.grund})`).join(', ')}`);
    zeilen.push(`- ${kopf}: ${teile.join(' · ')}`);
  }
  const ohne = liste.filter(w => !w.fehler && !w.backups.length && (w.commvault === null || 'fehler' in w.commvault || !w.commvault.letzte));
  if (ohne.length) zeilen.push('', `⚠️ Ohne nachgewiesene Sicherung: ${ohne.map(w => `VM ${w.vmid}`).join(', ')} — vor jedem Eingriff zuerst lesbare Daten sichern.`);
  return zeilen.join('\n');
}

/** Commvault-Eintrag einer VM aus `virtual_machines` (Name ohne Groß/Klein); letzte Sicherung aus dem ersten passenden Zeitfeld. */
export function commvaultFuerVm(vms: Array<Record<string, unknown>>, name: string | undefined): { status: string; letzte?: string } | null {
  if (!name) return null;
  const n = name.toLowerCase();
  const vm = vms.find(v => [v.name, v.vmName, v.displayName].some(x => typeof x === 'string' && x.toLowerCase() === n));
  if (!vm) return null;
  const status = String(vm.vmStatus ?? vm.protectionStatus ?? 'unbekannt');
  let letzte: string | undefined;
  for (const [k, w] of Object.entries(vm)) {
    if (!/last.*(backup|job)|backup.*time/i.test(k)) continue;
    const roh = typeof w === 'object' && w !== null ? (w as Record<string, unknown>).time ?? (w as Record<string, unknown>).startTime : w;
    const zahl = typeof roh === 'number' ? roh : typeof roh === 'string' && /^\d+$/.test(roh) ? Number(roh) : undefined;
    const d = zahl !== undefined ? new Date(zahl < 1e12 ? zahl * 1000 : zahl) : typeof roh === 'string' ? new Date(roh) : undefined;
    if (d && !Number.isNaN(d.getTime()) && d.getTime() > 0) { letzte = d.toISOString(); break; }
  }
  return { status, letzte };
}
