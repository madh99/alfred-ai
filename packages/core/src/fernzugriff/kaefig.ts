/**
 * v1549 (Owner 22.10. „S1–S4 wie empfohlen umsetzen inkl d“, Teil S1/S2) — Lese-Käfig und Geheimnis-Sperre.
 *
 * Bisher lief ohne Rückfrage nur, was auf einer festen Liste stand (Proxmox, ZFS, Docker, Systemgrundlagen); jede andere lesende
 * Analyse (Konfigdateien, Logs unter /var/log, find, du, ss …) fragte den Owner. Jetzt läuft ein unbekannter Befehl ohne Rückfrage in
 * einem Käfig auf dem Host (systemd-run): Dateisystem schreibgeschützt, als Benutzer des Zugangs mit nur dem Recht „alles lesen“
 * (CAP_DAC_READ_SEARCH), ohne Unix-Sockets (kein Docker, kein D-Bus → kein Dienst-Neustart), ohne Netz, ohne neue Rechte, mit Zeit-,
 * Speicher- und Prozessgrenze. Was schreiben will, scheitert technisch. Der Käfig wird je Zugang mit echten Schreibversuchen geprüft,
 * bevor er gilt (Selbsttest), und lässt sich je Zugang abschalten.
 *
 * S2: Befehle, die Geheimnisse berühren (Passwort-Hashes, private Schlüssel, .env, Zertifikatsschlüssel …), laufen nie ohne Rückfrage —
 * auch nicht im Käfig, denn die Ausgabe ginge an das Modell.
 */

/** Pfade und Befehle mit Geheimnissen — Treffer → nur mit Bestätigung. Bewusst breit; eine solche Liste ist nie vollständig. */
const GEHEIMNISSE: Array<{ muster: RegExp; grund: string }> = [
  { muster: /\/etc\/g?shadow\b|\/etc\/security\/opasswd/, grund: 'Passwort-Hashes' },
  { muster: /\bid_(rsa|dsa|ecdsa|ed25519)(?!\.pub)\b|\/\.ssh\/(?!(authorized_keys|known_hosts|config)\b)[^\s'"]*|ssh_host_\w+_key(?!\.pub)\b/, grund: 'private SSH-Schlüssel' },
  { muster: /\.(key|p12|pfx|jks|keystore|kdbx)\b|\/etc\/ssl\/private|\/etc\/letsencrypt\/(archive|live)\/[^\s]*privkey/, grund: 'Schlüssel-/Zertifikatsdateien' },
  { muster: /(^|[\s/'"=])\.env(\.[\w-]+)?\b|\benv_file\b/, grund: '.env-Dateien' },
  { muster: /\/etc\/pve\/priv\b|\/etc\/pve\/.*\.(key|pem)\b|\/root\/\.(pgpass|my\.cnf|netrc|git-credentials|docker\/config\.json)|\/home\/[^/\s]+\/\.(pgpass|my\.cnf|netrc|git-credentials|docker\/config\.json)|\.htpasswd\b|wp-config\.php\b/, grund: 'Zugangsdaten-Dateien' },
  { muster: /vaultwarden|bitwarden|\/(secrets?|credentials?)(\/|\b)/i, grund: 'Passwort-Tresor oder Geheimnis-Ordner' },
  { muster: /\/proc\/(\d+|self)\/environ\b|(^|[;&|]\s*)(printenv|env)\s*($|[;&|])|\bdocker\s+(inspect(?!\s+--format)|compose\s+config|exec)\b/, grund: 'Umgebungsvariablen' },
  { muster: /\b(mysqldump|pg_dump|pg_dumpall|mongodump)\b/, grund: 'Datenbank-Inhalt' },
];

export function geheimnisGrund(befehl: string): string | undefined {
  for (const g of GEHEIMNISSE) if (g.muster.test(befehl)) return g.grund;
  return undefined;
}

/** Eigenschaften der Käfig-Einheit (systemd.exec/systemd.resource-control). */
export function kaefigEigenschaften(benutzer: string, sekunden: number): string[] {
  return [
    `User=${benutzer}`,
    'AmbientCapabilities=CAP_DAC_READ_SEARCH',
    'CapabilityBoundingSet=CAP_DAC_READ_SEARCH',
    'NoNewPrivileges=yes',
    'ProtectSystem=strict',
    'ProtectHome=read-only',
    'PrivateTmp=yes',
    'PrivateDevices=yes',
    'ProtectKernelTunables=yes',
    'ProtectKernelModules=yes',
    'ProtectControlGroups=yes',
    'ProtectClock=yes',
    'RestrictSUIDSGID=yes',
    'RestrictNamespaces=yes',
    'LockPersonality=yes',
    'RestrictAddressFamilies=AF_NETLINK AF_INET AF_INET6',
    'IPAddressDeny=any',
    `RuntimeMaxSec=${Math.max(5, Math.min(900, Math.floor(sekunden)))}`,
    'MemoryMax=1G',
    'TasksMax=64',
    'WorkingDirectory=/',
  ];
}

const shQuote = (s: string) => `'${s.replace(/'/g, `'\\''`)}'`;

/** Kompletter Befehl für ssh: als root (sudo -n) eine Käfig-Einheit starten, die den Befehl in sh -c ausführt. */
export function kaefigBefehl(befehl: string, benutzer: string, sekunden: number): string {
  const props = kaefigEigenschaften(benutzer, sekunden).map(p => `-p ${shQuote(p)}`).join(' ');
  return `sudo -n systemd-run --quiet --pipe --wait --collect --service-type=exec ${props} -- /bin/sh -c ${shQuote(befehl)}`;
}

/**
 * Selbsttest im Käfig: echte Schreib-, Kill-, Docker-, D-Bus- und Netzversuche müssen scheitern, Lesen muss gehen. Jede Zeile
 * PROBE_<X> außer LESEN_OK/ENDE bedeutet: der Käfig hält hier nicht.
 */
export const KAEFIG_SELBSTTEST = [
  // v1550 — dauerhafte Pfade; /tmp und /var/tmp sind im Käfig privat (PrivateTmp) und werden verworfen (Realfall 22.10. pve: der
  // erste Selbsttest wertete /var/tmp fälschlich als Lücke und schaltete den Käfig nicht frei — richtig vorsichtig, aber unnötig)
  'for z in /etc /root /var/log /var/lib /usr /home; do if touch "$z/.alfred-kaefig-probe" 2>/dev/null; then echo "PROBE_SCHREIBEN $z"; rm -f "$z/.alfred-kaefig-probe"; fi; done',
  'if kill -0 1 2>/dev/null; then echo PROBE_KILL; fi',
  'if command -v docker >/dev/null 2>&1 && docker info >/dev/null 2>&1; then echo PROBE_DOCKER; fi',
  'if command -v systemctl >/dev/null 2>&1 && systemctl show -p Version >/dev/null 2>&1; then echo PROBE_DBUS; fi',
  'if command -v bash >/dev/null 2>&1 && timeout 3 bash -c "exec 3<>/dev/tcp/1.1.1.1/53" 2>/dev/null; then echo PROBE_NETZ; fi',
  'if head -c 1 /etc/shadow >/dev/null 2>&1; then echo PROBE_LESEN_OK; fi',
  'echo PROBE_ENDE',
].join('; ');

export type KaefigStatus = 'ungeprueft' | 'aktiv' | 'fehlt' | 'aus';

export function werteSelbsttest(ausgabe: string, code: number): { ok: boolean; grund: string } {
  if (!ausgabe.includes('PROBE_ENDE')) return { ok: false, grund: code === 0 ? 'Selbsttest unvollständig' : `systemd-run nicht nutzbar (Exit ${code})` };
  const verstoesse = ausgabe.split(/\r?\n/).filter(z => /^PROBE_(SCHREIBEN|KILL|DOCKER|DBUS|NETZ)/.test(z.trim())).map(z => z.trim().replace(/^PROBE_/, ''));
  if (verstoesse.length) return { ok: false, grund: `Käfig hält nicht: ${verstoesse.join(', ')}` };
  if (!ausgabe.includes('PROBE_LESEN_OK')) return { ok: false, grund: 'im Käfig ist Lesen geschützter Dateien nicht möglich' };
  return { ok: true, grund: 'schreibgeschützt, kein Kill/Docker/D-Bus/Netz, Lesen ok' };
}

/** Typische Meldungen, wenn ein Befehl im Käfig an seine Grenzen stößt (für einen verständlichen Hinweis). */
export function kaefigGrenze(stderr: string): boolean {
  return /Read-only file system|Operation not permitted|Permission denied|Cannot connect to the Docker daemon|Failed to connect to bus|Network is unreachable|Address family not supported/i.test(stderr);
}
