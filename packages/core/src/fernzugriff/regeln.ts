import { createHash } from 'node:crypto';

/**
 * v1539 (Owner 21.10. „ssh über cmdb plus skill fernzugriff, benutzer alfred mit sudo-rechten, er soll auch etwas machen können“).
 * Feste Regeln ohne Modell: welcher Befehl ist reines Lesen (läuft ohne Rückfrage), welcher ist nie erlaubt, alles andere braucht
 * die Bestätigung des Owners. Dazu der Host-Schlüssel: beim ersten Kontakt gelesen, vom Owner bestätigt, danach fest (Pinning).
 */

export type Befehlsklasse = 'lesen' | 'bestaetigen' | 'nie';

/** Zeichen, mit denen ein Befehl mehr als ein Befehl wird (Verkettung, Umleitung, Ersetzung) — dann nie „lesen“. */
const STEUERZEICHEN = /[;&|`<>\\\n\r]|\$[({A-Za-z_]/;

/** Lesende Befehle (ganzer Befehl, nach Normalisierung). Bewusst ohne cat/less beliebiger Dateien (Geheimnisse in /etc/pve). */
const LESE_BEFEHLE: RegExp[] = [
  /^zpool (status|list|iostat|get|history)( [-\w.@:/]+)*$/,
  /^zpool status$/,
  /^zfs (list|get)( [-\w.@:/,=]+)*$/,
  /^pvecm (status|nodes)$/,
  /^pvesm status( [-\w]+)*$/,
  /^pveversion( -v| --verbose)?$/,
  /^pvesh get \/[\w/.-]+( --output-format (json|text|yaml))?$/,
  /^ha-manager status$/,
  /^(qm|pct) list$/,
  /^(qm|pct) (status|config|pending) \d{1,9}$/,
  /^pveceph status$/,
  /^ceph (status|health( detail)?|df|osd (tree|df))$/,
  /^df( -[hHTi]+)*( [\w/.-]+)*$/,
  /^free( -[hmgb])*$/,
  /^(uptime|hostname|whoami|id|date|nproc)$/,
  /^uname( -[a-z]+)*$/,
  /^lsblk( -[a-zA-Z]+)*$/,
  /^smartctl -[aHiAx] \/dev\/[a-z0-9]+$/,
  /^sensors$/,
  /^ip( -[a-z0-9]+)* (a|addr|address|r|route|link|neigh)( show)?( [\w.-]+)?$/,
  /^cat \/proc\/(mdstat|meminfo|loadavg|cpuinfo|version|pressure\/(cpu|memory|io))$/,
  /^top -b(n| -n) ?1$/,
  /^ps( aux| -ef| axu)$/,
  /^dmesg( -T| --ctime)?( -l (err|warn|crit|alert|emerg)(,(err|warn|crit|alert|emerg))*)?$/,
  /^journalctl( (-n \d{1,5}|-u [\w@.-]+|-p (err|warning|crit|alert|emerg|\d)|-b( -?\d)?|--since "?[\w :.-]+"?|--until "?[\w :.-]+"?|--no-pager|-k|-o (short|short-iso|cat)))+$/,
  /^systemctl (status [\w@.-]+( --no-pager)?|is-active [\w@.-]+|is-failed [\w@.-]+|--failed( --no-pager)?|list-units( --type=\w+)?( --state=\w+)?( --no-pager)?)$/,
  /^apt list --upgradable$/,
  /^last -n \d{1,3}$/,
];

/** Nie erlaubt, auch nicht mit Bestätigung: macht Datenträger, Pools oder das System unwiederbringlich kaputt. */
const NIE_BEFEHLE: RegExp[] = [
  /\bmkfs(\.\w+)?\b/,
  /\bwipefs\b/,
  /\bdd\b[^\n]*\bof=\/dev\//,
  /\brm\s+(-[a-zA-Z]*\s+)*(\/|\/\*|~|\/(etc|boot|usr|var|root|bin|sbin|lib)\/?)(\s|$)/,
  /\bzpool\s+(destroy|labelclear)\b/,
  /\bzfs\s+destroy\b[^\n]*-r/,
  /\bsgdisk\b[^\n]*(--zap|-Z\b)/,
  />\s*\/dev\/(sd|nvme|hd|vd)/,
  /:\(\)\s*\{/,
  /\bchmod\s+-R\s+777\s+\/(\s|$)/,
  /\bpvecm\s+delnode\b/,
];

export function normalisiereBefehl(befehl: string): string {
  return befehl.trim().replace(/^sudo\s+(-n\s+)?/, '').replace(/\s+/g, ' ');
}

export function befehlsklasse(befehl: string): Befehlsklasse {
  const b = normalisiereBefehl(befehl);
  if (!b) return 'nie';
  if (NIE_BEFEHLE.some(r => r.test(b))) return 'nie';
  if (STEUERZEICHEN.test(b)) return 'bestaetigen';
  return LESE_BEFEHLE.some(r => r.test(b)) ? 'lesen' : 'bestaetigen';
}

/** Befehl, wie er per ssh läuft: als root über sudo -n (kein Passwort-Prompt), komplexe Befehle in sh -c. */
export function fernBefehl(befehl: string, alsRoot: boolean): string {
  const b = normalisiereBefehl(befehl);
  if (!alsRoot) return b;
  if (!STEUERZEICHEN.test(b)) return `sudo -n ${b}`;
  return `sudo -n sh -c '${b.replace(/'/g, `'\\''`)}'`;
}

// ── Host-Schlüssel ──────────────────────────────────────────────────────────────────────────────────────────────

export interface HostSchluessel { typ: string; schluessel: string; fingerabdruck: string }

/** SHA256-Fingerabdruck wie `ssh-keygen -lf` (Base64 ohne Auffüllung). */
export function fingerabdruck(schluesselBase64: string): string {
  return 'SHA256:' + createHash('sha256').update(Buffer.from(schluesselBase64, 'base64')).digest('base64').replace(/=+$/, '');
}

/** Ausgabe von `ssh-keyscan` → Schlüssel (Kommentarzeilen und fremde Hosts ignoriert). */
export function leseKeyscan(ausgabe: string): HostSchluessel[] {
  const out: HostSchluessel[] = [];
  for (const zeile of ausgabe.split(/\r?\n/)) {
    const t = zeile.trim();
    if (!t || t.startsWith('#')) continue;
    const [, typ, schluessel] = t.split(/\s+/);
    if (!typ || !schluessel || !/^(ssh-ed25519|ecdsa-sha2-nistp\d+|ssh-rsa|sk-ssh-ed25519@openssh\.com)$/.test(typ) || !/^[A-Za-z0-9+/=]+$/.test(schluessel)) continue;
    if (!out.some(x => x.schluessel === schluessel)) out.push({ typ, schluessel, fingerabdruck: fingerabdruck(schluessel) });
  }
  return out;
}

/** Zeilen für eine eigene known_hosts-Datei (Port ≠ 22 in eckigen Klammern). */
export function knownHostsZeilen(host: string, port: number, schluessel: HostSchluessel[]): string {
  const name = port === 22 ? host : `[${host}]:${port}`;
  return schluessel.map(s => `${name} ${s.typ} ${s.schluessel}`).join('\n') + '\n';
}

/** Gültiger Host (Name oder IPv4/IPv6) — nichts, was ssh als Option lesen könnte. */
export function gueltigerHost(host: string): boolean {
  return /^(?!-)[A-Za-z0-9.-]{1,253}$/.test(host) || /^[0-9a-fA-F:]{2,39}$/.test(host);
}

export function gueltigerBenutzer(benutzer: string): boolean {
  return /^[a-z_][a-z0-9_-]{0,31}$/.test(benutzer);
}

/**
 * Anleitung für den Owner: Benutzer auf dem Host anlegen und Alfreds öffentlichen Schlüssel eintragen. Die sudo-Regel richtet
 * der Owner selbst ein (bewusst nicht von Alfred erzeugt); `pruefen` meldet danach, ob sudo ohne Passwort geht.
 */
export function einrichtungsBefehle(oeffentlicherSchluessel: string, benutzer = 'alfred'): string {
  return [
    `# als root auf dem Host ausführen`,
    `id ${benutzer} >/dev/null 2>&1 || useradd -m -s /bin/bash ${benutzer}`,
    `install -d -m 700 -o ${benutzer} -g ${benutzer} /home/${benutzer}/.ssh`,
    `echo '${oeffentlicherSchluessel.trim()}' >> /home/${benutzer}/.ssh/authorized_keys`,
    `chown ${benutzer}:${benutzer} /home/${benutzer}/.ssh/authorized_keys && chmod 600 /home/${benutzer}/.ssh/authorized_keys`,
    `# danach die sudo-Regel für ${benutzer} nach eigener Wahl in /etc/sudoers.d/ anlegen (mit visudo prüfen)`,
  ].join('\n');
}
