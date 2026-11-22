/**
 * I8e Folge-Etappe (Spec docs/specs/2026-11-22-i8e-alfred-logins-sa.md §7.3, Notfallweg-Beweis N2) — linux_ha knoten_standby:
 * den Pacemaker-Knoten DES ZUGANGS (hostname -s) in Standby setzen bzw. zurückholen. Fail-closed vor jeder Änderung: crm_mon lesbar,
 * Quorum, alle Knoten online; Standby nie für den Knoten mit der Promoted-Instanz von ag_cluster (Primär). Selbstprüfung: das
 * standby-Attribut des Knotens in crm_mon (bis 60 s warten). Rückweg: knoten_standby mit an umgekehrt.
 */
import { registriereLinuxBaustein } from '../fernzugriff/linux-bausteine.js';
import { LINUX_HA_BAUSTEINE, HA_AG_RESSOURCE } from './linux-ha.js';
import { sqlKopf, shQ } from './linux-sql.js';

export function pruefeKnotenStandby(p: { an?: unknown }): string | undefined {
  return typeof p.an === 'boolean' ? undefined : 'an: true (Knoten in Standby) oder false (zurückholen)';
}

/** crm_mon-XML → „<online> <gesamt> <quorum 0/1> <standby dieses Knotens: true/false/-> <Promoted-Knoten oder ->“ */
const PY_LAGE = [
  'import sys, xml.etree.ElementTree as ET',
  'ich, res = sys.argv[1], sys.argv[2]',
  'try:',
  '    r = ET.fromstring(sys.stdin.read())',
  'except Exception:',
  '    print("unlesbar"); sys.exit(0)',
  'knoten = list(r.iter("node"))',
  'knoten = [k for k in knoten if k.get("name") and k.get("online") is not None]',
  'online = sum(1 for k in knoten if k.get("online") == "true")',
  'dc = r.find("./summary/current_dc")',
  'q = 1 if dc is not None and dc.get("with_quorum") == "true" else 0',
  'st = next((k.get("standby") for k in knoten if k.get("name") == ich), "-")',
  'prom = "-"',
  'for e in r.iter("resource"):',
  '    if e.get("id") == res and e.get("role") == "Promoted":',
  '        n = e.find("node")',
  '        if n is not None and n.get("name"):',
  '            prom = n.get("name")',
  'print(online, len(knoten), q, st, prom)',
].join('\n');

export function knotenStandbySkript(p: { an: boolean }): string {
  const f = pruefeKnotenStandby(p); if (f) throw new Error(f);
  const soll = p.an ? 'true' : 'false';
  return [
    ...sqlKopf(LINUX_HA_BAUSTEINE.knotenStandby, { an: p.an }, 'ALFRED-HA'),
    `PY_LAGE=${shQ(PY_LAGE)}`,
    `AG_RES=${shQ(HA_AG_RESSOURCE)}`,
    '# ALFRED-ABLAUF',
    'K=$(hostname -s)',
    '[[ "$K" =~ ^[a-z0-9][a-z0-9-]{0,62}$ ]] || abbruch "Knotenname ungültig ($K) — nichts geändert"',
    'lage() { local x; x=$(crm_mon -1 --output-as=xml 2>/dev/null) || abbruch "crm_mon nicht lesbar — nichts geändert"; read -r ON GES Q ST PROM <<<"$(python3 -c "$PY_LAGE" "$K" "$AG_RES" <<<"$x")"; [ -n "${PROM:-}" ] || abbruch "crm_mon nicht auswertbar — nichts geändert"; }',
    'lage',
    '[ "$Q" = 1 ] || abbruch "Cluster ohne Quorum — nichts geändert"',
    '[ "$ON" = "$GES" ] && [ "$GES" -ge 3 ] || abbruch "nicht alle Knoten online ($ON/$GES) — nichts geändert"',
    '[ "$ST" != - ] || abbruch "Knoten $K nicht im Cluster — nichts geändert"',
    ...(p.an ? ['[ "$PROM" != "$K" ] || abbruch "$K ist Primär (Promoted $AG_RES) — Standby nur für Sekundär oder Konfig-Knoten; zuerst Failover; nichts geändert"'] : []),
    `if [ "$ST" = ${soll} ]; then ergebnis "{\\"zustand\\":\\"schon\\",\\"knoten\\":\\"$K\\",\\"standby\\":${soll}}"; exit 0; fi`,
    `pcs node ${p.an ? 'standby' : 'unstandby'} "$K" >/dev/null 2>&1 || abbruch "pcs node ${p.an ? 'standby' : 'unstandby'} $K fehlgeschlagen"`,
    'for i in $(seq 1 30); do lage; [ "$ST" = ' + soll + ' ] && break; sleep 2; done',
    `[ "$ST" = ${soll} ] || abbruch "Standby von $K nicht bestätigt (crm_mon standby=$ST, Soll ${soll})"`,
    `ergebnis "{\\"zustand\\":\\"geaendert\\",\\"knoten\\":\\"$K\\",\\"standby\\":${soll}}"`,
  ].join('\n');
}

registriereLinuxBaustein<{ an: boolean }>(LINUX_HA_BAUSTEINE.knotenStandby, knotenStandbySkript);
