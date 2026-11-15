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
  // I1 (Realfall 22.10.: Compose-Abfrage mit dem Containernamen „vaultwarden“ abgewiesen) — nur Pfade, nicht bloße Namen
  { muster: /\/[^\s'"]*(vaultwarden|bitwarden)|\/(secrets?|credentials?)(\/|\b)/i, grund: 'Passwort-Tresor oder Geheimnis-Ordner' },
  { muster: /\/proc\/(\d+|self)\/environ\b|(^|[;&|]\s*)(printenv|env)\s*($|[;&|])|\bdocker\s+(inspect(?!\s+--format)|compose\s+config|exec)\b/, grund: 'Umgebungsvariablen' },
  { muster: /\b(mysqldump|pg_dump|pg_dumpall|mongodump)\b/, grund: 'Datenbank-Inhalt' },
];

/**
 * v1665 — Realfall 25.10. (10fb035c Schritt 1): Prüfungen wie `ls …/vault2510-export` oder `test ! -e …/backup.key` zeigen nur, ob es eine
 * Datei gibt — nie ihren Inhalt — und scheiterten trotzdem an der Geheimnis-Sperre. Reine Metadaten-Befehle (ls, test/[ -e/-f/-d/-s/-L/-r ],
 * stat -c, auch mit && oder ; verkettet) dürfen Geheimnis-Pfade nennen; alles, was Inhalte liest (cat, grep, Skripte …), bleibt gesperrt.
 */
const PFAD = String.raw`[\w./@+:-]+`;
// v1666 — Sicherheitsprüfung zu v1665: nur Leerzeichen/Tab als Trenner (\s passte auch auf Zeilenumbrüche: „ls /x⏎cat /opt/app/.env“
// galt sonst als reiner ls-Befehl und umging die Geheimnis-Sperre)
const L = '[ \\t]+';
const METADATEN = [
  new RegExp(String.raw`^ls(${L}-[A-Za-z1]+)*(${L}--)?(${L}${PFAD})+$`),
  new RegExp(String.raw`^(test|\[)${L}(!${L})?-[edfsLrx]${L}${PFAD}(${L}\])?$`),
  // v1667 — Sicherheitsprüfung: nur einfach zitierte Formate aus einer festen Liste (in "…" würde die Shell $(…) ausführen)
  new RegExp(String.raw`^stat(${L}-c${L}'(%[FsnaUGYyzXWAhim]|[ :|\/.,_-])+')?(${L}--)?(${L}${PFAD})+$`),
];
export function nurMetadaten(befehl: string): boolean {
  if (/[\r\n\0]/.test(befehl)) return false; // nie mehrzeilig
  const teile = befehl.trim().split(/[ \t]*(?:&&|;)[ \t]*/).filter(Boolean);
  // Nur einfach zitierte Teile (expandieren nie) vor der Prüfung auf Shell-Zeichen entfernen; doppelte Anführungszeichen sind gar nicht erlaubt
  return teile.length > 0 && teile.length <= 20 && teile.every(t => METADATEN.some(r => r.test(t)) && !/[$`|&<>(){}*?\\"]/.test(t.replace(/'[^'\n]*'/g, '')));
}

export function geheimnisGrund(befehl: string): string | undefined {
  for (const g of GEHEIMNISSE) if (g.muster.test(befehl)) return g.grund;
  return undefined;
}

/** Eigenschaften der Käfig-Einheit (systemd.exec/systemd.resource-control). */
/**
 * v1632 — Stufen des Käfigs (Realfall 24.10., Rocky/Alma/Fedora mit SELinux):
 * - lesen „voll“: CAP_DAC_READ_SEARCH (root-Dateien lesbar), Geheimnis-Pfade per InaccessiblePaths ausgeblendet.
 *   SELinux verweigert das Überdecken von shadow_t-Dateien (/etc/shadow, /etc/gshadow) → die Einheit startet dann gar nicht (226/NAMESPACE).
 * - lesen „eingeschraenkt“: keine Fähigkeiten — root-Dateien (auch /etc/shadow, Rechte 000) sind schon über die Rechte unlesbar;
 *   die übrigen Geheimnis-Pfade bleiben zusätzlich ausgeblendet.
 * - ausgabe „pipe“ (--pipe) oder „datei“: Fedora 44 lehnt das Weiterreichen der Ein-/Ausgabe an systemd ab („Connection reset by
 *   peer“) → Ausgabe in eine root-eigene Datei unter /run, danach lesen und löschen.
 */
export interface KaefigModus { lesen: 'voll' | 'eingeschraenkt'; ausgabe: 'pipe' | 'datei' }
export const KAEFIG_STUFEN: KaefigModus[] = [
  { lesen: 'voll', ausgabe: 'pipe' }, { lesen: 'eingeschraenkt', ausgabe: 'pipe' },
  { lesen: 'voll', ausgabe: 'datei' }, { lesen: 'eingeschraenkt', ausgabe: 'datei' },
];
/** Dateien, die SELinux (Typ shadow_t) nicht überdecken lässt — ohne Fähigkeiten ohnehin unlesbar */
const SHADOW_PFADE = new Set(['/etc/shadow', '/etc/shadow-', '/etc/gshadow', '/etc/gshadow-', '/etc/security/opasswd']);

export function kaefigEigenschaften(benutzer: string, sekunden: number, modus: KaefigModus = KAEFIG_STUFEN[0]!): string[] {
  const voll = modus.lesen === 'voll';
  return [
    `User=${benutzer}`,
    ...(voll ? ['AmbientCapabilities=CAP_DAC_READ_SEARCH', 'CapabilityBoundingSet=CAP_DAC_READ_SEARCH'] : ['CapabilityBoundingSet=']),
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
    // v1551 (Sicherheitsprüfung) — Geheimnis-Pfade im Käfig unsichtbar, unabhängig davon, wie der Befehl sie anspricht
    // (`cat /etc/sha""dow`, `f=/etc/shadow; cat $f`, find -exec …). „-“ = fehlende Pfade ignorieren.
    `InaccessiblePaths=${GEHEIM_PFADE.filter(p => voll || !SHADOW_PFADE.has(p)).map(p => `-${p}`).join(' ')}`,
  ];
}

/** v1551 — Standardorte von Geheimnissen, im Käfig unsichtbar. Was hier fehlt (z. B. .env unter /opt), fängt die Schwärzung der Ausgabe. */
export const GEHEIM_PFADE = [
  '/etc/shadow', '/etc/shadow-', '/etc/gshadow', '/etc/gshadow-', '/etc/security/opasswd',
  '/etc/ssh/ssh_host_rsa_key', '/etc/ssh/ssh_host_ecdsa_key', '/etc/ssh/ssh_host_ed25519_key', '/etc/ssh/ssh_host_dsa_key',
  '/etc/ssl/private', '/etc/pve/priv', '/etc/letsencrypt/archive', '/etc/letsencrypt/keys',
  '/root/.ssh', '/root/.gnupg', '/root/.pgpass', '/root/.my.cnf', '/root/.netrc', '/root/.git-credentials', '/root/.docker',
  '/var/lib/vaultwarden', '/opt/vaultwarden',
];

/** Namen von Geheimnis-Feldern (Schlüssel/Variablen); gemeinsam für Schwärzung nach Text und nach Schlüssel. */
// PWD/PW nur als eigenständiger Namensteil (DB_PWD, mysql_pw, PW) — nicht in cwd, pwdLastSet, upward.
export const GEHEIM_NAME = /(?:PASS(?:WORD|WD)?|SECRET|TOKEN|API[_-]?KEY|PRIVATE[_-]?KEY|CREDENTIALS?|AUTH[_-]?KEY|SALT|(?<![A-Za-z])PWD?(?![A-Za-z]))/i;

const GESCHWAERZT = '[geschwärzt]';
/** `PWD=/home/madh` ist das Arbeitsverzeichnis der Shell, kein Geheimnis. */
const istPwdPfad = (schluessel: string, wert: string) => /^PWD$/i.test(schluessel) && wert.startsWith('/');
/** Schlüssel ohne Schalter-Striche, Anführungszeichen und `export`. */
const nurName = (s: string) => s.replace(/^\s*(?:export\s+)?/i, '').replace(/^["'-]+|["']+$/g, '');

// Schlüssel nach Trennzeichen (Leerzeichen ; , & ? { ( [ : | " '; „:“ für grep-Ausgaben datei:key=wert), optional in Anführungszeichen, dann = oder :
const MITTE_SCHLUESSEL = /(?<=^|[\s;,&?{([:|"'])(["']?)(?<k>[A-Za-z0-9_.-]+)\1\s*[=:]\s*/gm;
// Wert: in Anführungszeichen (Leerzeichen erlaubt) oder bis zum nächsten Trennzeichen; mindestens 4 Zeichen
const MITTE_WERT = /(?!["']?\[geschwärzt\])(?:"([^"\n]{4,})"|'([^'\n]{4,})'|([^\s'"#;,&]{4,}))/y;
// Schalter: --name WERT / -Name WERT (Leerzeichen-getrennt; --name=WERT fängt MITTE_SCHLUESSEL)
const SCHALTER_SCHLUESSEL = /(?<=^|[\s"'(])(?<k>--?[A-Za-z][A-Za-z0-9_-]*)[^\S\n]+/gm;
const SCHALTER_WERT = /(?!-|["']?\[geschwärzt\])(?:"([^"\n]+)"|'([^'\n]+)'|([^\s'"]+))/y;

/**
 * Schwärzt den Wert hinter jedem Schlüssel, dessen Name GEHEIM_NAME trifft. Nicht-geheime Schlüssel verbrauchen ihren Wert
 * NICHT — sonst verschluckte `conn: password='…'` den geheimen Schlüssel im Wert. Linear: Startpunkte nur nach Trennzeichen,
 * der Wert wird per Sticky-Regex genau an einer Stelle geprüft.
 */
function schwaerzeNachSchluessel(t: string, schluessel: RegExp, wert: RegExp): { text: string; anzahl: number } {
  let aus = '', pos = 0, anzahl = 0;
  schluessel.lastIndex = 0;
  for (let m = schluessel.exec(t); m; m = schluessel.exec(t)) {
    const k = nurName(m.groups!.k!);
    if (!GEHEIM_NAME.test(k)) continue;
    const ende = m.index + m[0].length;
    wert.lastIndex = ende;
    const v = wert.exec(t);
    if (!v) continue;
    const w = v[1] ?? v[2] ?? v[3] ?? '';
    if (istPwdPfad(k, w)) continue;
    const z = v[1] !== undefined ? '"' : v[2] !== undefined ? "'" : '';
    aus += `${t.slice(pos, ende)}${z}${GESCHWAERZT}${z}`;
    pos = ende + v[0].length;
    schluessel.lastIndex = pos;
    anzahl++;
  }
  return { text: aus + t.slice(pos), anzahl };
}

/**
 * v1551 — Geheimnisse in einer Ausgabe schwärzen, bevor sie das Modell sieht — egal, auf welchem Weg sie gelesen wurden.
 * Private Schlüssel, Passwort-Hashes, KEY=Wert-Paare mit Geheimnis-Namen, Zugangsdaten in URLs, Bearer-/Basic-Kopfzeilen.
 * Dokumente-Vorhaben (15.11.) — auch mitten in der Zeile (Verbindungszeichenfolgen, JSON, Query-Parameter, set -x),
 * Kommandozeilen-Schalter (--password, -Password, sshpass -p, mysql -p…). Jede Regex ist linear: der Schlüssel wird als
 * ganzer Lauf gelesen und erst im Rückruf gegen GEHEIM_NAME geprüft (keine verschachtelten Quantoren).
 * Nur mehr schwärzen, nie weniger: bereits Geschwärztes wird übersprungen, damit `anzahl` nicht doppelt zählt.
 */
export function schwaerze(text: string): { text: string; anzahl: number } {
  let anzahl = 0, n = 0;
  const zaehle = (ersatz: string) => () => { anzahl++; return ersatz; };
  let t = text.replace(/-----BEGIN [A-Z0-9 ]*PRIVATE KEY-----[\s\S]*?(-----END [A-Z0-9 ]*PRIVATE KEY-----|$)/g, zaehle('[privater Schlüssel geschwärzt]'));
  t = t.replace(/\$(1|2[abxy]?|5|6|7|y|gy|apr1)\$[^\s:]{8,}/g, zaehle('[Passwort-Hash geschwärzt]')); // v1602 apr1 (htpasswd, z. B. Proxy-Labels)
  // KEY=Wert am Zeilenanfang (wie v1551, Wert darf ; , & enthalten); Schlüssel als ganzer Lauf, Namensprüfung im Rückruf
  t = t.replace(/^([^\S\n]*(?:export\s+)?)([A-Za-z0-9_.-]+)(\s*[=:]\s*)(['"]?)([^\s'"#]{4,})\4/gim, (m, a: string, k: string, s: string, q: string, w: string) => {
    if (!GEHEIM_NAME.test(k) || istPwdPfad(k, w)) return m;
    anzahl++; return `${a}${k}${s}${q}${GESCHWAERZT}${q}`;
  });
  // KEY=Wert / KEY: Wert / "key": "Wert" auch mitten in der Zeile nach Trennzeichen; Werte in Anführungszeichen dürfen Leerzeichen enthalten
  ({ text: t, anzahl: n } = schwaerzeNachSchluessel(t, MITTE_SCHLUESSEL, MITTE_WERT)); anzahl += n;
  // Kommandozeilen-Schalter mit Leerzeichen: --password X, --token X, -Password X (PowerShell); eindeutiger Schalter → keine Mindestlänge
  ({ text: t, anzahl: n } = schwaerzeNachSchluessel(t, SCHALTER_SCHLUESSEL, SCHALTER_WERT)); anzahl += n;
  t = t.replace(/\b(sshpass[^\S\n]+-p[^\S\n]*)(?!\[geschwärzt\])(\S+)/g, (_m, a: string) => { anzahl++; return `${a}${GESCHWAERZT}`; });
  // mysql/mariadb: Passwort direkt am Schalter (-pX); nur in Zeilen, die den Client aufrufen (zeilenweise → linear)
  t = t.replace(/^[^\n]*\b(?:mysql|mariadb)[^\n]*/gm, zeile => zeile.replace(/(?<=\s)(-p)(?!\[geschwärzt\])(\S+)/g, (_m, a: string) => { anzahl++; return `${a}${GESCHWAERZT}`; }));
  t = t.replace(/(?<![a-z0-9+.-])([a-z][a-z0-9+.-]*:\/\/[^:\s/@]+:)([^@\s/]{3,})@/gi, (_m, a: string) => { anzahl++; return `${a}[geschwärzt]@`; });
  t = t.replace(/\b(Bearer\s+)[A-Za-z0-9._~+/-]{16,}=*/gi, (_m, a: string) => { anzahl++; return `${a}[geschwärzt]`; });
  t = t.replace(/\b(Authorization:[^\S\n]*Basic[^\S\n]+)[A-Za-z0-9+/]{4,}=*/gi, (_m, a: string) => { anzahl++; return `${a}[geschwärzt]`; });
  return { text: t, anzahl };
}

const shQuote = (s: string) => `'${s.replace(/'/g, `'\\''`)}'`;

/** Kompletter Befehl für ssh: als root (sudo -n) eine Käfig-Einheit starten, die den Befehl in sh -c ausführt. */
export function kaefigBefehl(befehl: string, benutzer: string, sekunden: number, modus: KaefigModus = KAEFIG_STUFEN[0]!): string {
  const props = kaefigEigenschaften(benutzer, sekunden, modus).map(p => `-p ${shQuote(p)}`).join(' ');
  if (modus.ausgabe === 'pipe') return `sudo -n systemd-run --quiet --pipe --wait --collect --service-type=exec ${props} -- /bin/sh -c ${shQuote(befehl)}`;
  // Ausgabe über eine root-eigene Datei (mktemp: 0600); systemd öffnet sie außerhalb des Käfigs. Exit-Code der Einheit bleibt erhalten.
  return `f=$(sudo -n mktemp -p /run alfred-kaefig.XXXXXXXX) || exit 125; sudo -n systemd-run --quiet --wait --collect --service-type=exec -p "StandardOutput=truncate:$f" -p "StandardError=append:$f" ${props} -- /bin/sh -c ${shQuote(befehl)}; rc=$?; sudo -n cat -- "$f"; sudo -n rm -f -- "$f"; exit $rc`;
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
  // v1551 — Lesen geschützter Dateien muss gehen (/etc/sudoers: nur root), Geheimnis-Pfade müssen unsichtbar sein
  // v1552 — auf INHALT prüfen: InaccessiblePaths legt einen leeren Platzhalter (Rechte 000) darüber, den CAP_DAC_READ_SEARCH öffnen darf;
  // „öffnen klappt“ hieß deshalb fälschlich „lesbar“ (Realfall 22.10. pve: Käfig vorsichtshalber gesperrt)
  'if [ -n "$(head -c 1 /etc/sudoers 2>/dev/null)" ]; then echo PROBE_LESEN_OK; fi',
  // v1632 — Stufe „eingeschraenkt“: öffentliche Dateien müssen lesbar sein
  'if [ -n "$(head -c 1 /etc/os-release 2>/dev/null)" ]; then echo PROBE_OEFFENTLICH_OK; fi',
  'if [ -n "$(head -c 1 /etc/shadow 2>/dev/null)" ]; then echo PROBE_GEHEIMNIS /etc/shadow; fi',
  'echo PROBE_ENDE',
].join('; ');

export type KaefigStatus = 'ungeprueft' | 'aktiv' | 'fehlt' | 'aus';

export function werteSelbsttest(ausgabe: string, code: number, modus: KaefigModus = KAEFIG_STUFEN[0]!): { ok: boolean; grund: string } {
  if (!ausgabe.includes('PROBE_ENDE')) return { ok: false, grund: code === 0 ? 'Selbsttest unvollständig' : `systemd-run nicht nutzbar (Exit ${code})` };
  const verstoesse = ausgabe.split(/\r?\n/).filter(z => /^PROBE_(SCHREIBEN|KILL|DOCKER|DBUS|NETZ|GEHEIMNIS)/.test(z.trim())).map(z => z.trim().replace(/^PROBE_/, ''));
  if (verstoesse.length) return { ok: false, grund: `Käfig hält nicht: ${verstoesse.join(', ')}` };
  if (modus.lesen === 'eingeschraenkt') {
    if (!ausgabe.includes('PROBE_OEFFENTLICH_OK')) return { ok: false, grund: 'im Käfig ist nicht einmal Lesen öffentlicher Dateien möglich' };
    return { ok: true, grund: `eingeschränkt: schreibgeschützt, kein Kill/Docker/D-Bus/Netz, ohne Leserecht für root-Dateien (SELinux erlaubt kein Ausblenden)${modus.ausgabe === 'datei' ? ', Ausgabe über Datei' : ''}` };
  }
  if (!ausgabe.includes('PROBE_LESEN_OK')) return { ok: false, grund: 'im Käfig ist Lesen geschützter Dateien nicht möglich' };
  return { ok: true, grund: `schreibgeschützt, kein Kill/Docker/D-Bus/Netz, Geheimnis-Pfade unsichtbar, Lesen ok${modus.ausgabe === 'datei' ? ', Ausgabe über Datei' : ''}` };
}

/** Typische Meldungen, wenn ein Befehl im Käfig an seine Grenzen stößt (für einen verständlichen Hinweis). */
export function kaefigGrenze(stderr: string): boolean {
  return /Read-only file system|Operation not permitted|Permission denied|Cannot connect to the Docker daemon|Failed to connect to bus|Network is unreachable|Address family not supported/i.test(stderr);
}
