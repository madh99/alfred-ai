/**
 * Owner 23./24.11. — linux_sql aktualisieren: SQL-Server-Update (CU) auf einem Knoten, rollierend per Change.
 * Microsoft (Operate AG on Linux, „Upgrade availability group“): Knoten vorher aus der Pacemaker-Überwachung nehmen, mssql-server UND
 * mssql-server-ha auf dieselbe Version heben, danach wieder aufnehmen; Sekundäre zuerst, der Primär erst nach dem Failover.
 *
 * Phase 1 (prüfen, nichts geändert): Anmeldung als alfred_admin, installierte Versionen, kein Downgrade/kein gleicher Build, Ziel in der
 * Paketquelle, bei Pacemaker: Knoten im Standby und keine aktive ag_cluster-Instanz mehr (wie sa_kennwort_setzen — ein Dienststopp
 * mitten in einer Pacemaker-Aktion kann Fencing auslösen). Nur so ist der Knoten nie Primär.
 * Phase 2: Paketinstallation mssql-server=<v> [mssql-server-ha=<v>] mit --allow-change-held-packages, danach wieder hold (auch bei Fehler).
 * Selbstprüfung: Dienst aktiv + aktiviert, Anmeldung (Skript-Upgrade-Modus bis 10 min), ProductVersion = Ziel, beide Pakete in der
 * Zielversion gehalten, mssql.conf unverändert (TLS-Pfad #979, forceencryption). Kein Rückweg — ein Downgrade ist kein Weg zurück;
 * Absicherung über die Reihenfolge (Sekundär zuerst) und die Sicherung vor dem Change.
 */
import { registriereLinuxBaustein } from '../fernzugriff/linux-bausteine.js';
import { LINUX_SQL_BAUSTEINE, SQL_HILFE, SA_LESEN, SQL2025_CU1_BUILD, sqlKopf, shQ } from './linux-sql.js';
import { PY_HA_KNOTEN_LAGE } from './linux-ha-standby.js';
import { HA_AG_RESSOURCE } from './linux-ha.js';

export interface SqlUpdateParameter { version: string }

/** fester Grund für rueckweg.keiner (change-schritte OHNE_RUECKWEG_NUR_MIT_GRUND, Text gleich) */
export const SQL_UPDATE_OHNE_RUECKWEG = 'CU nicht zurücknehmbar (Downgrade nicht unterstützt) — Absicherung: Standby, Sekundär zuerst, Primär erst nach dem Failover, Synchronisierung je Knoten geprüft';

const SQL_VERSION = /^17\.0\.(\d{4})\.\d{1,3}-\d{1,3}$/;

export function pruefeSqlUpdate(p: { version?: unknown }): string | undefined {
  const m = typeof p.version === 'string' ? SQL_VERSION.exec(p.version) : null;
  if (!m) return 'version: Paketversion wie 17.0.5065.9-3 erwartet (apt-Version mit Revision)';
  if (Number(m[1]) < SQL2025_CU1_BUILD) return `version: erst ab CU1 (Build ≥ 17.0.${SQL2025_CU1_BUILD})`;
  return undefined;
}

const MSSQL_CONF = '/var/opt/mssql/mssql.conf';

const UPDATE_KOERPER = `export DEBIAN_FRONTEND=noninteractive
paket_status() { dpkg-query -W -f='\${Status}|\${Version}' "$1" 2>/dev/null || true; }
paket_version() { paket_status "$1" | awk -F'|' '$1 ~ / ok installed$/ { print $2 }'; }
gehalten() { [ "$(paket_status "$1" | cut -d'|' -f1)" = "hold ok installed" ]; }
build() { sed -nE 's/^17\\.0\\.([0-9]{4})\\..*$/\\1/p' <<<"$1"; }
[ "$SQL_LOGIN" = alfred_admin ] || abbruch "aktualisieren nur als alfred_admin — nichts geändert"
IV=$(paket_version mssql-server)
[ -n "$IV" ] || abbruch "mssql-server ist nicht installiert — nichts geändert (Neuinstallation: installieren)"
HV=$(paket_version mssql-server-ha)
PAKETE=(mssql-server); [ -z "$HV" ] || PAKETE+=(mssql-server-ha)
K=$(hostname -s)
if [ "$IV" = "$V" ] && { [ -z "$HV" ] || [ "$HV" = "$V" ]; }; then
  Z=schon
else
  # ── Phase 1: prüfen — bis hierhin wird nichts geändert ──
  IB=$(build "$IV"); SB=$(build "$V")
  [ -n "$IB" ] || abbruch "installierte Version $IV nicht lesbar — nichts geändert"
  if [ "$IV" != "$V" ]; then [ "$SB" -gt "$IB" ] || abbruch "Ziel $V ist nicht neuer als installiert $IV — kein Downgrade, nichts geändert"; fi
  [ -z "$HV" ] || [ "$HV" = "$IV" ] || [ "$HV" = "$V" ] || abbruch "mssql-server-ha $HV weicht von mssql-server $IV ab — nichts geändert"
  bereit || abbruch "SQL Server antwortet nicht als alfred_admin — nichts geändert"
  if [ -n "$HV" ] || command -v crm_mon >/dev/null 2>&1; then
    command -v crm_mon >/dev/null 2>&1 || abbruch "mssql-server-ha installiert, aber crm_mon fehlt — Standby nicht belegbar; nichts geändert"
    x=$(crm_mon -1 --output-as=xml 2>/dev/null) || abbruch "crm_mon nicht lesbar — Standby von $K nicht belegt; nichts geändert"
    read -r _ _ _ ST _ AKT <<<"$(python3 -c "$PY_LAGE" "$K" "$AG_RES" <<<"$x")"
    [ "\${ST:-}" = true ] || abbruch "Knoten $K nicht im Standby (\${ST:-unlesbar}) — zuerst linux_ha knoten_standby an=true; nichts geändert"
    [ "\${AKT:-}" = 0 ] || abbruch "$AG_RES auf $K noch aktiv (\${AKT:-unlesbar}) — Standby nicht abgeschlossen; nichts geändert"
  fi
  [ -f "$MSSQL_CONF" ] || abbruch "$MSSQL_CONF fehlt — nichts geändert"
  H0=$(sha256sum "$MSSQL_CONF" | cut -d' ' -f1)
  ALFRED_TMP=$(mktemp -d /run/alfred-sql.XXXXXX)
  apt-get -o DPkg::Lock::Timeout=300 update -q >"$ALFRED_TMP/apt.log" 2>&1 || abbruch "apt-get update fehlgeschlagen: $(kurz "$(cat "$ALFRED_TMP/apt.log")") — nichts geändert"
  for pk in "\${PAKETE[@]}"; do
    vs=$(apt-cache madison "$pk" | awk -F'|' '{ gsub(/ /, "", $2); print $2 }')
    grep -qxF "$V" <<<"$vs" || abbruch "$pk=$V ist in der Paketquelle nicht verfügbar — nichts geändert"
  done
  # ── Phase 2: aktualisieren ──
  ZIELE=(); for pk in "\${PAKETE[@]}"; do ZIELE+=("$pk=$V"); done
  BEGONNEN=1
  if ! NEEDRESTART_MODE=l NEEDRESTART_SUSPEND=1 ACCEPT_EULA=Y apt-get -o DPkg::Lock::Timeout=300 install -y -q --no-install-recommends --allow-change-held-packages -o Dpkg::Options::=--force-confold "\${ZIELE[@]}" >"$ALFRED_TMP/apt.log" 2>&1; then
    abbruch "apt-get install fehlgeschlagen: $(kurz "$(cat "$ALFRED_TMP/apt.log")") — installiert jetzt: mssql-server $(paket_version mssql-server)"
  fi
  apt-mark -o DPkg::Lock::Timeout=300 hold "\${PAKETE[@]}" >/dev/null
  systemctl is-active --quiet mssql-server || systemctl start mssql-server || abbruch "mssql-server startet nach dem Update nicht: $(kurz "$(journalctl -u mssql-server -n 6 --no-pager 2>&1 || true)")"
  H1=$(sha256sum "$MSSQL_CONF" | cut -d' ' -f1)
  [ "$H1" = "$H0" ] || abbruch "$MSSQL_CONF wurde beim Update verändert — Einstellungen (TLS-Pfad, forceencryption) prüfen"
  Z=geaendert
fi
# ── Selbstprüfung ──
systemctl is-active --quiet mssql-server || abbruch "mssql-server ist nicht aktiv"
systemctl is-enabled --quiet mssql-server || abbruch "mssql-server ist nicht aktiviert"
# nach einem CU läuft der Skript-Upgrade-Modus (bis zu einigen Minuten) — bereit wartet je 120 s
ok=0; for i in 1 2 3 4 5; do if bereit; then ok=1; break; fi; done
[ "$ok" = 1 ] || abbruch "SQL Server antwortet nach dem Update nicht als alfred_admin (10 min)"
z=$(alfred_zeile "$(sql "SET NOCOUNT ON; SELECT N'ALFRED|' + CAST(SERVERPROPERTY('ProductVersion') AS nvarchar(40))")")
IFS='|' read -r _ PV <<<"$z"
[ "$PV" = "\${V%-*}" ] || abbruch "SQL Server meldet Version '$PV', erwartet \${V%-*}"
for pk in "\${PAKETE[@]}"; do
  [ "$(paket_version "$pk")" = "$V" ] || abbruch "$pk ist in Version '$(paket_version "$pk")', erwartet $V"
  gehalten "$pk" || abbruch "$pk ist nicht gehalten (hold) — automatische Updates wären möglich"
done
HA_JSON=null; [ -z "$HV" ] || HA_JSON="\\"$V\\""
ergebnis "{\\"zustand\\":\\"$Z\\",\\"knoten\\":\\"$K\\",\\"von\\":\\"$IV\\",\\"version\\":\\"$PV\\",\\"paket\\":\\"$V\\",\\"ha\\":$HA_JSON}"`;

/** Ergebnis { zustand schon|geaendert, knoten, von, version (ProductVersion), paket, ha (mssql-server-ha-Version oder null) }. Zeit: LINUX_SQL_ZEIT_MS.aktualisieren */
export function sqlUpdateSkript(p: SqlUpdateParameter): string {
  const f = pruefeSqlUpdate(p); if (f) throw new Error(f);
  return [
    ...sqlKopf(LINUX_SQL_BAUSTEINE.aktualisieren, { version: p.version }),
    ...SQL_HILFE,
    `V=${shQ(p.version)}`,
    `MSSQL_CONF=${shQ(MSSQL_CONF)}`,
    `PY_LAGE=${shQ(PY_HA_KNOTEN_LAGE)}`,
    `AG_RES=${shQ(HA_AG_RESSOURCE)}`,
    // nach einem Abbruch mitten im Update: Pakete wieder halten, Dienst wieder starten (läuft in der Falle des Kopfs)
    'BEGONNEN=0',
    'alfred_aufraeumen() { if [ "$BEGONNEN" = 1 ]; then apt-mark hold "${PAKETE[@]}" >/dev/null 2>&1 || true; systemctl is-active --quiet mssql-server || systemctl start mssql-server || true; fi; }',
    ...SA_LESEN,
    UPDATE_KOERPER,
  ].join('\n');
}

registriereLinuxBaustein<SqlUpdateParameter>(LINUX_SQL_BAUSTEINE.aktualisieren, sqlUpdateSkript);
