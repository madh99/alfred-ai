/**
 * I8e Folge-Etappe (Spec docs/specs/2026-11-22-i8e-alfred-logins-sa.md §7.3, Notfallweg-Beweis N2) — linux_ha knoten_standby:
 * den Pacemaker-Knoten DES ZUGANGS (hostname -s) in Standby setzen bzw. zurückholen. Fail-closed vor jeder Änderung: crm_mon lesbar,
 * Quorum, alle Knoten online; bei an=true muss ein Primär erkennbar sein (Rolle Promoted oder Master) und darf nicht dieser Knoten
 * sein. Selbstprüfung (bis 120 s): standby-Attribut des Knotens UND (bei an=true) keine aktive ag_cluster-Instanz mehr auf ihm —
 * erst dann darf linux_sql sa_kennwort_setzen den Dienst stoppen (Review I2: ein Stopp mitten in der stop-Aktion kann Fencing auslösen).
 * Rückweg: knoten_standby mit an umgekehrt.
 */
import { registriereLinuxBaustein } from '../fernzugriff/linux-bausteine.js';
import { LINUX_HA_BAUSTEINE, HA_AG_RESSOURCE } from './linux-ha.js';
import { sqlKopf, shQ } from './linux-sql.js';

export function pruefeKnotenStandby(p: { an?: unknown; warte_ag?: unknown; warteAg?: unknown }): string | undefined {
  if (typeof p.an !== 'boolean') return 'an: true (Knoten in Standby) oder false (zurückholen)';
  const w = p.warte_ag ?? p.warteAg;
  if (w !== undefined && typeof w !== 'boolean') return 'warte_ag: nur true oder false (Wahrheitswert)';
  return undefined;
}

/**
 * crm_mon-XML → „<online> <gesamt> <quorum 0/1> <standby dieses Knotens: true/false/-> <Primär-Knoten oder -> <aktive Instanzen der
 * Ressource auf diesem Knoten>“. Primär = Rolle Promoted oder (ältere Pacemaker) Master; aktiv = Instanz mit node-Kind dieses Knotens,
 * Rolle nicht Stopped und active nicht false. Auch von linux_sql sa_kennwort_setzen genutzt.
 */
export const PY_HA_KNOTEN_LAGE = [
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
  'akt = 0',
  'for e in r.iter("resource"):',
  '    if e.get("id") != res:',
  '        continue',
  '    n = e.find("node")',
  '    name = n.get("name") if n is not None else None',
  '    if e.get("role") in ("Promoted", "Master") and name:',
  '        prom = name',
  '    if name == ich and e.get("role") != "Stopped" and e.get("active") != "false":',
  '        akt += 1',
  'print(online, len(knoten), q, st, prom, akt)',
].join('\n');

export function knotenStandbySkript(p: { an: boolean; warteAg?: boolean }): string {
  const f = pruefeKnotenStandby(p); if (f) throw new Error(f);
  const soll = p.an ? 'true' : 'false';
  // 23.11. (Entwurf 2f31b31d): warteAg nur beim Zurückholen — erst Erfolg, wenn die ag_cluster-Instanz auf dem Knoten wieder aktiv ist
  const warte = !p.an && p.warteAg === true;
  const agFeld = warte ? ',\\"agAktiv\\":true' : '';
  return [
    ...sqlKopf(LINUX_HA_BAUSTEINE.knotenStandby, { an: p.an }, 'ALFRED-HA'),
    `PY_LAGE=${shQ(PY_HA_KNOTEN_LAGE)}`,
    `AG_RES=${shQ(HA_AG_RESSOURCE)}`,
    '# ALFRED-ABLAUF',
    "NG=' — nichts geändert'",
    'K=$(hostname -s)',
    '[[ "$K" =~ ^[a-z0-9][a-z0-9-]{0,62}$ ]] || abbruch "Knotenname ungültig ($K)$NG"',
    'lage() { local x; x=$(crm_mon -1 --output-as=xml 2>/dev/null) || abbruch "crm_mon nicht lesbar$NG"; read -r ON GES Q ST PROM AKT <<<"$(python3 -c "$PY_LAGE" "$K" "$AG_RES" <<<"$x")"; [ -n "${AKT:-}" ] || abbruch "crm_mon nicht auswertbar$NG"; }',
    'lage',
    '[ "$Q" = 1 ] || abbruch "Cluster ohne Quorum$NG"',
    '[ "$ON" = "$GES" ] && [ "$GES" -ge 3 ] || abbruch "nicht alle Knoten online ($ON/$GES)$NG"',
    '[ "$ST" != - ] || abbruch "Knoten $K nicht im Cluster$NG"',
    ...(p.an ? [
      '[ "$PROM" != - ] || abbruch "kein Primär von $AG_RES erkennbar (Promoted/Master) — Standby nur mit belegtem Primär$NG"',
      '[ "$PROM" != "$K" ] || abbruch "$K ist Primär (Promoted $AG_RES) — Standby nur für Sekundär oder Konfig-Knoten; zuerst Failover$NG"',
    ] : []),
    p.an
      ? `if [ "$ST" = true ] && [ "$AKT" = 0 ]; then ergebnis "{\\"zustand\\":\\"schon\\",\\"knoten\\":\\"$K\\",\\"standby\\":true}"; exit 0; fi`
      : warte
        ? `if [ "$ST" = false ] && [ "$AKT" != 0 ]; then ergebnis "{\\"zustand\\":\\"schon\\",\\"knoten\\":\\"$K\\",\\"standby\\":false${agFeld}}"; exit 0; fi`
        : `if [ "$ST" = false ]; then ergebnis "{\\"zustand\\":\\"schon\\",\\"knoten\\":\\"$K\\",\\"standby\\":false}"; exit 0; fi`,
    ...(warte ? ['if [ "$ST" = true ]; then'] : []),
    `pcs node ${p.an ? 'standby' : 'unstandby'} "$K" >/dev/null 2>&1 || abbruch "pcs node ${p.an ? 'standby' : 'unstandby'} $K fehlgeschlagen"`,
    // ab hier kann sich etwas geändert haben
    "NG=''",
    p.an
      ? 'for i in $(seq 1 60); do lage; [ "$ST" = true ] && [ "$AKT" = 0 ] && break; sleep 2; done'
      : 'for i in $(seq 1 60); do lage; [ "$ST" = false ] && break; sleep 2; done',
    ...(warte ? ['fi', "NG=''"] : []),
    `[ "$ST" = ${soll} ] || abbruch "Standby von $K nicht bestätigt (crm_mon standby=$ST, Soll ${soll})"`,
    ...(warte ? [
      // Instanz wieder aktiv (Unpromoted/Promoted) — bis 300 s; sonst Abbruch (Knoten arbeitet nicht wieder mit)
      'for i in $(seq 1 150); do lage; [ "$AKT" != 0 ] && break; sleep 2; done',
      '[ "$AKT" != 0 ] || abbruch "$AG_RES auf $K nicht wieder aktiv (300 s nach Standby aus) — Knoten arbeitet nicht mit"',
    ] : []),
    ...(p.an ? ['[ "$AKT" = 0 ] || abbruch "$AG_RES auf $K noch aktiv ($AKT Instanz) — Standby gesetzt, Ressource nach 120 s nicht gestoppt; Dienst nicht anfassen"'] : []),
    `ergebnis "{\\"zustand\\":\\"geaendert\\",\\"knoten\\":\\"$K\\",\\"standby\\":${soll}${agFeld}}"`,
  ].join('\n');
}

registriereLinuxBaustein<{ an: boolean; warteAg?: boolean }>(LINUX_HA_BAUSTEINE.knotenStandby, knotenStandbySkript);
