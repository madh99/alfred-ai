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
  /^zpool (status|list|iostat|get|history|events)( [-\w.@:/]+)*$/, // v1542 events
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
  // v1542 (Owner 22.10. „F1–F4“) — Diagnose wie im Realfall 21.10. (NVMe in zfs-nvme002): Spalten, Geräte nach ID, Speicherinhalt
  /^lsblk( -[a-zA-Z]+| (-o|--output) [A-Za-z,:-]+)*( \/dev\/[\w/.:-]+)?$/,
  /^smartctl( -[aHiAxj]+| --(all|health|info|xall|json))+ \/dev\/([a-z0-9]+|disk\/by-(id|path|uuid)\/[\w.:-]+)$/,
  /^smartctl --scan(-open)?$/,
  /^nvme (list|(smart-log|error-log|id-ctrl) \/dev\/nvme\d+(n\d+)?)$/,
  /^ls( -[lahdR1]+)* \/dev\/disk(\/by-(id|uuid|path|label|partuuid))?\/?[\w.:*-]*$/,
  /^lspci( -[vnkt]+)*$/,
  /^pvesm list [\w.-]+( --content (backup|images|iso|vztmpl|rootdir|snippets)| --vmid \d{1,9})*$/,
  /^(qm|pct) listsnapshot \d{1,9}$/,
  // v1545 (Owner 22.10. „docker-lesebefehle aufnehmen“) — Docker-Host (z. B. Home Assistant neben anderen Containern). Volles
  // `docker inspect` und `docker compose config` zeigen Umgebungsvariablen (oft Passwörter) → nur mit Bestätigung; gezielt mit --format ja.
  /^docker (ps|container ls)( -a| --all| -q| -s| --size| --no-trunc| --format "(table )?(\{\{\.(ID|Image|Names|Status|State|Ports|RunningFor|CreatedAt|Size|Networks|Mounts)\}\}[ :,/=|-]*)+")*$/,
  /^docker logs( --tail \d{1,5}| -n \d{1,5}| -t| --timestamps| --since (\d{1,4}[smhd]|\d{4}-\d{2}-\d{2}(T\d{2}:\d{2}(:\d{2})?)?)| --until (\d{1,4}[smhd]|\d{4}-\d{2}-\d{2}(T\d{2}:\d{2}(:\d{2})?)?))* [\w.-]+$/,
  /^docker stats --no-stream( --no-trunc| --format "(table )?(\{\{\.(Name|ID|Container|CPUPerc|MemUsage|MemPerc|NetIO|BlockIO|PIDs)\}\}[ :,/=|-]*)+")*( [\w.-]+)*$/,
  // v1546 (Sicherheitsprüfung) — feste Feldliste statt Sperre auf „Env“: {{json .Config}} oder {{json .}} enthielten die Umgebung trotzdem
  /^docker inspect --format "(\{\{(json )?\.(Name|Id|Created|RestartCount|Image|Platform|Driver|Mounts|State(\.\w+)*|NetworkSettings(\.(IPAddress|Ports|Networks|Gateway|MacAddress))?|HostConfig\.(RestartPolicy(\.\w+)?|NetworkMode|Memory|NanoCpus)|Config\.(Image|Hostname|User|WorkingDir))\}\}[ :,/=|-]*)+" [\w.:/-]+( [\w.:/-]+)*$/,
  /^docker (images|image ls)( -a| --all| --digests| --no-trunc)*$/,
  /^docker (network|volume) ls$/,
  /^docker system df( -v)?$/,
  /^docker (version|info)$/,
  /^docker (top|port) [\w.-]+$/,
  /^docker compose ls( -a| --all)?$/,
  /^docker compose -p [\w-]+ (ps|top|images)( -a| --all)?$/,
  /^sensors$/,
  /^ip( -[a-z0-9]+)* (a|addr|address|r|route|link|neigh)( show)?( [\w.-]+)?$/,
  /^cat \/proc\/(mdstat|meminfo|loadavg|cpuinfo|version|pressure\/(cpu|memory|io))$/,
  /^top -b(n| -n) ?1$/,
  /^ps( aux| -ef| axu)$/,
  /^dmesg( -T| --ctime)?( -l (err|warn|crit|alert|emerg)(,(err|warn|crit|alert|emerg))*)?$/,
  // v1541 (Sicherheitsprüfung) — Zeitangaben nur im festen Format: ein freies „--since x --rotate“ lief sonst ungefragt als root
  /^journalctl( (-n \d{1,5}|-u [\w@.-]+|-p (err|warning|crit|alert|emerg|\d)|-b( -?\d)?|--(since|until) ("\d{4}-\d{2}-\d{2}( \d{2}:\d{2}(:\d{2})?)?"|\d{4}-\d{2}-\d{2}|today|yesterday|-\d{1,4}(min|h|d))|--no-pager|-k|-o (short|short-iso|cat)))+$/,
  /^systemctl (status [\w@.-]+( --no-pager)?|is-active [\w@.-]+|is-failed [\w@.-]+|--failed( --no-pager)?|list-units( --type=\w+)?( --state=\w+)?( --no-pager)?)$/,
  /^apt list --upgradable$/,
  /^last -n \d{1,3}$/,
  // v1549 (S1) — Netz-Diagnose außerhalb des Käfigs (der hat kein Netz): nur GET/HEAD, ping/dig mit Grenzen
  // v1551 (Sicherheitsprüfung, SSRF) — ohne Rückfrage nur an den Host selbst, ohne Query-String und ohne Weiterleitung (-L)
  /^curl( -[sSIkv]+| -m \d{1,3}| --max-time \d{1,3}| -o \/dev\/null| -w "%\{(http_code|time_total|time_connect|remote_ip)\}( %\{(http_code|time_total|time_connect|remote_ip)\})*")* https?:\/\/(localhost|127\.0\.0\.1|\[::1\])(:\d{1,5})?(\/[\w./%-]*)?$/,
  /^ping -c [1-9]( -W \d{1,2})? [\w.:-]+$/,
  /^(dig|nslookup|host)( [\w.:@+-]+){1,3}$/,
  /^ss( -[tulnpaxs]+)+$/,
  // I1 Bestandsaufnahme (Spec Infrastruktur-Vorhaben) — Betriebssystem und genau die Compose-Zuordnung (nur diese zwei Labels)
  /^cat \/etc\/(os-release|hostname|debian_version|redhat-release|issue)$/,
  /^docker inspect --format '\{\{\.Name\}\},\{\{index \.Config\.Labels "com\.docker\.compose\.project"\}\},\{\{index \.Config\.Labels "com\.docker\.compose\.service"\}\}'( [\w.-]+)+$/,
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

/** v1541 — Optionen, die etwas verändern oder fremde Dateien lesen; mit ihnen ist kein Befehl „lesen“, egal was das Muster erlaubt. */
const VERAENDERNDE_OPTIONEN = /(^| )(--vacuum[\w-]*|--rotate|--flush|--sync|--relinquish-var|--setup-keys|--file|--directory|--root|--merge|-D|-M|--output-fields|--update-catalog|--force|-f)( |=|$)/;

/** v1542 — Zeichen, die nie in einem Lese-Befehl vorkommen dürfen (Umleitung, Ersetzung, Fortsetzung, Hintergrund). */
const HARTE_ZEICHEN = /[`<>\\\n\r]|\$[({A-Za-z_]/;

/** v1542 — Filter, die hinter einer Pipe stehen dürfen: lesen nur ihre Eingabe, schreiben nichts, starten nichts. */
const FILTER: RegExp[] = [
  /^e?grep( -[a-eg-zA-Z]+)*( -e)? ("[^"]*"|'[^']*'|[\w.:/@=-]+)$/,
  /^(head|tail)( -n ?\+?\d{1,5}| -\d{1,5}| -c ?\+?\d{1,7})?$/, // v1548 (K3) — auch „ab Zeile N“ (-n +N)
  /^wc( -[lwcm]+)?$/,
  /^sort( -[nrhuV]+| -k ?[\d,]+)*$/,
  /^uniq( -[cdu]+)?$/,
  /^cut( -d ?('.'|"."|[^\s'"])| -[fc] ?[\d,-]+)+$/,
];

function einzelBefehl(b: string): Befehlsklasse {
  if (VERAENDERNDE_OPTIONEN.test(b)) return 'bestaetigen';
  return LESE_BEFEHLE.some(r => r.test(b)) ? 'lesen' : 'bestaetigen';
}

export function befehlsklasse(befehl: string): Befehlsklasse {
  // v1548 (K2, Realfall 22.10. 01:09) — nur für die Einordnung: `\t` (Tabulator in Docker-Formatvorlagen) wie ein Leerzeichen, und
  // '…' ohne $, Backtick und Backslash wie "…" (in einfachen Anführungszeichen ersetzt die Shell nichts). Ausgeführt wird unverändert.
  const b = normalisiereBefehl(befehl.replace(/\\t/g, ' ').replace(/'([^'"$`\\]*)'/g, '"$1"'));
  if (!b) return 'nie';
  if (NIE_BEFEHLE.some(r => r.test(b))) return 'nie';
  if (!STEUERZEICHEN.test(b)) return einzelBefehl(b);
  // v1542 (F2) — Ketten mit ; oder && sind „lesen“, wenn JEDER Teil liest; Pipes nur zu FILTER. Alles Übrige (||, einzelnes &,
  // Umleitung, Ersetzung) braucht die Bestätigung. Ein ; oder | in Anführungszeichen zerfällt beim Teilen und fällt damit durch.
  if (HARTE_ZEICHEN.test(b) || b.includes('||')) return 'bestaetigen';
  const ohneUnd = b.replace(/&&/g, ';');
  if (ohneUnd.includes('&')) return 'bestaetigen';
  const segmente = ohneUnd.split(';').map(s => s.trim());
  if (segmente.some(s => !s)) return segmente.filter(Boolean).length && segmente[segmente.length - 1] === '' && segmente.slice(0, -1).every(Boolean) ? pruefeSegmente(segmente.slice(0, -1)) : 'bestaetigen';
  return pruefeSegmente(segmente);
}

function pruefeSegmente(segmente: string[]): Befehlsklasse {
  for (const seg of segmente) {
    const stufen = seg.split('|').map(s => s.trim());
    if (stufen.some(s => !s)) return 'bestaetigen';
    if (einzelBefehl(normalisiereBefehl(stufen[0]!)) !== 'lesen') return 'bestaetigen';
    if (!stufen.slice(1).every(f => FILTER.some(r => r.test(f)))) return 'bestaetigen';
  }
  return 'lesen';
}

/** v1542 (F3) — lange Ausgaben kürzen, aber Anfang UND Ende behalten (Fehler und Zusammenfassungen stehen oft am Ende). */
export function kuerzeMitte(text: string, max: number): string {
  if (text.length <= max) return text;
  const kopf = Math.floor(max * 0.7), ende = Math.floor(max * 0.25);
  const a = text.slice(0, kopf), z = text.slice(text.length - ende);
  const aZeile = a.lastIndexOf('\n') > kopf * 0.8 ? a.slice(0, a.lastIndexOf('\n')) : a;
  const zZeile = z.indexOf('\n') >= 0 && z.indexOf('\n') < ende * 0.2 ? z.slice(z.indexOf('\n') + 1) : z;
  return `${aZeile}\n… (${text.length - aZeile.length - zZeile.length} Zeichen in der Mitte ausgelassen) …\n${zZeile}`;
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
