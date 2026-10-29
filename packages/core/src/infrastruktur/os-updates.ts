/**
 * S4 (Spec 2026-10-27-standard-changes-eingangskontrolle) — Vorlage „Betriebssystem-Updates (Updates v2)“, abgeleitet aus den
 * I9-Changes (Realfall 29.10.: fünf Docker-VMs, je 8/8 Schritte, kein Befund). Ohne feste Namen, Daten oder Container: das Zeitfenster
 * gilt jede Nacht, Container/Ports/Dienste erhebt S2 selbst. Docker-Pakete werden für die Dauer gesperrt (kein Docker-Wechsel nebenbei).
 */
import { vorherNachherSchritte, wartungsVerzeichnis } from './vorher-nachher.js';

/** Zeitfenster „HH:MM-HH:MM“ (Wien); Start nur im Fenster, Neustart bis 15 min vor dessen Ende */
export function fensterAus(text: string | undefined): { von: string; bis: string } | { fehler: string } {
  const m = /^([01]\d|2[0-3]):([0-5]\d)-([01]\d|2[0-3]):([0-5]\d)$/.exec((text ?? '00:30-02:45').trim());
  if (!m) return { fehler: 'fenster als HH:MM-HH:MM, z. B. 00:30-02:45' };
  const von = `${m[1]}:${m[2]}`, bis = `${m[3]}:${m[4]}`;
  if (bis <= von) return { fehler: 'fenster muss am selben Tag enden' };
  return { von, bis };
}
const minus = (hhmm: string, min: number) => { const [h, m] = hhmm.split(':').map(Number); const t = Math.max(0, h! * 60 + m! - min); return `${String(Math.floor(t / 60)).padStart(2, '0')}:${String(t % 60).padStart(2, '0')}`; };

const fensterPruefung = (von: string, bis: string, marker: string) =>
  `python3 -c "import datetime;from zoneinfo import ZoneInfo;n=datetime.datetime.now(ZoneInfo('Europe/Vienna')).strftime('%H:%M');assert '${von}'<=n<'${bis}','ausserhalb des Wartungsfensters ${von}-${bis}: '+n;print('${marker}',n)"`;

export function upgradeSkript(d: string, startBis: string): string {
  return `set -eu
umask 077
export DEBIAN_FRONTEND=noninteractive NEEDRESTART_MODE=l UCF_FORCE_CONFFOLD=1
python3 - <<'PY'
import subprocess as s,pathlib as p,json,datetime,apt
from zoneinfo import ZoneInfo
n=datetime.datetime.now(ZoneInfo('Europe/Vienna'));assert n.strftime('%H:%M')<'${startBis}','zu spaet fuer das Upgrade: '+n.strftime('%H:%M')
def out(a):return s.check_output(a,text=True)
d=p.Path('${d}');assert (d/'vorher.ok').exists(),'Vorher-Erhebung fehlt'
s.run(['apt-get','-o','APT::Update::Error-Mode=any','-o','Acquire::http::Timeout=30','-o','Acquire::https::Timeout=30','update'],check=True,timeout=240)
c=apt.Cache();v={x.name:x.installed.version for x in c if x.is_installed and x.name.startswith(('docker','containerd','moby','runc','crun'))};(d/'docker-versionen').write_text(json.dumps(v))
alt=set(out(['apt-mark','showhold']).split());neu=sorted(set(v)-alt)
try:
 if neu:s.run(['apt-mark','hold']+neu,check=True)
 sim=out(['apt-get','-s','--no-remove','upgrade']);(d/'simulation').write_text(sim)
 assert not any(l.split()[1].split(':')[0] in v for l in sim.splitlines() if l.startswith(('Inst ','Remv '))),'Simulation wuerde Docker-Pakete aendern'
 pakete=[l.split()[1] for l in sim.splitlines() if l.startswith('Inst ')];print('UPDATES',len(pakete),' '.join(pakete[:40]),flush=True)
 s.run(['apt-get','-y','--no-remove','-o','Dpkg::Options::=--force-confdef','-o','Dpkg::Options::=--force-confold','-o','DPkg::Lock::Timeout=60','upgrade'],check=True,timeout=1200)
finally:
 if neu:s.run(['apt-mark','unhold']+neu,check=True)
c=apt.Cache();assert all(c[x].installed.version==z for x,z in v.items()),'Docker-Pakete haben sich geaendert';assert not out(['dpkg','--audit']).strip(),'dpkg --audit nicht leer'
(d/'upgrade.ok').write_text('OSUPD_UPGRADE_OK\\n')
PY`;
}

export function neustartSkript(d: string, rebootBis: string, unit: string): string {
  return `python3 - <<'PY'
import pathlib as p,datetime,subprocess as s
from zoneinfo import ZoneInfo
d=p.Path('${d}');assert (d/'upgrade.ok').exists()
if p.Path('/var/run/reboot-required').exists():
 n=datetime.datetime.now(ZoneInfo('Europe/Vienna'));assert n.strftime('%H:%M')<'${rebootBis}','zu spaet fuer einen Neustart: '+n.strftime('%H:%M')
 (d/'neustart').write_text(n.isoformat());s.run(['systemd-run','--unit=${unit}','--on-active=90s','/usr/bin/systemctl','reboot'],check=True);print('NEUSTART in 90 s')
else:print('kein Neustart noetig')
(d/'entscheidung.ok').write_text('OSUPD_NEUSTART_ENTSCHIEDEN\\n')
PY`;
}

/** Schritte der Vorlage für einen Host (VM bekannt) */
export function osUpdateSchritte(z: string, vm: { vmid: number; node: string }, snap: string, fenster: { von: string; bis: string }, tag: string): Array<Record<string, unknown>> {
  const d = wartungsVerzeichnis(tag);
  const startBis = minus(fenster.bis, 45), rebootBis = minus(fenster.bis, 30);
  const rueck = { skill: 'proxmox', aktion: 'rollback_snapshot', parameter: { vmid: vm.vmid, node: vm.node, name: snap } };
  const vn = vorherNachherSchritte(z, d, rueck, 300);
  return [
    { titel: `Startprüfung: Wartungsfenster ${fenster.von}–${startBis}`, art: 'aktion', skill: 'fernzugriff', aktion: 'lesen', parameter: { name: z, befehl: fensterPruefung(fenster.von, startBis, 'OSUPD_FENSTER_OK') } },
    { titel: `Snapshot ${snap}`, art: 'aktion', skill: 'proxmox', aktion: 'create_snapshot', parameter: { vmid: vm.vmid, node: vm.node, name: snap, description: 'Alfred Standard-Change Betriebssystem-Updates, haltbar 7 Tage' }, pruefung: { typ: 'skill', skill: 'proxmox', aktion: 'list_snapshots', parameter: { vmid: vm.vmid, node: vm.node }, erwartet: snap }, rueckweg: { skill: 'proxmox', aktion: 'delete_snapshot', parameter: { vmid: vm.vmid, node: vm.node, name: snap } } },
    vn.vorher,
    { titel: 'Paketlisten und Upgrade (Docker-Pakete gesperrt, Simulation vorher)', art: 'aktion', skill: 'fernzugriff', aktion: 'ausfuehren', parameter: { name: z, als_root: true, befehl: upgradeSkript(d, startBis), timeout_s: 1500 }, pruefung: { typ: 'befehl', zugang: z, befehl: `cat ${d}/upgrade.ok`, erwartet: 'OSUPD_UPGRADE_OK' }, rueckweg: rueck, zeitlimitS: 1600 },
    { titel: `Neustart nur bei reboot-required (bis ${rebootBis})`, art: 'aktion', skill: 'fernzugriff', aktion: 'ausfuehren', parameter: { name: z, als_root: true, befehl: neustartSkript(d, rebootBis, `alfred-osupd-${tag.replace(/[^a-z0-9-]/g, '-')}`), timeout_s: 60 }, pruefung: { typ: 'befehl', zugang: z, befehl: `cat ${d}/entscheidung.ok`, erwartet: 'OSUPD_NEUSTART_ENTSCHIEDEN' }, rueckweg: rueck, zeitlimitS: 300 },
    { titel: 'Anlaufzeit', art: 'warten', sekunden: 180, zeitlimitS: 600 },
    { titel: 'VM läuft', art: 'warten', pruefung: { typ: 'skill', skill: 'proxmox', aktion: 'vm_status', parameter: { vmid: vm.vmid, node: vm.node }, erwartet: 'running' }, zeitlimitS: 300 },
    { titel: 'Gast-Agent antwortet', art: 'warten', pruefung: { typ: 'skill', skill: 'proxmox', aktion: 'agent_status', parameter: { vmid: vm.vmid, node: vm.node } }, zeitlimitS: 300 },
    vn.nachher,
  ];
}

/** S4 — Beginn der kommenden Nacht (morgen HH:MM Wien) als ISO mit Zeitzonen-Versatz, z. B. 2026-11-05T00:30:00+01:00 */
export function naechsteNacht(jetzt: Date, um = '00:30'): string {
  const morgen = new Date(jetzt.getTime() + 86_400_000);
  const tag = new Intl.DateTimeFormat('en-CA', { timeZone: 'Europe/Vienna', year: 'numeric', month: '2-digit', day: '2-digit' }).format(morgen);
  // Versatz des Ziels selbst bestimmen (Sommer-/Winterzeit): erst grob, dann mit dem Versatz an diesem Zeitpunkt
  const versatz = (d: Date) => { const t = new Intl.DateTimeFormat('en-US', { timeZone: 'Europe/Vienna', timeZoneName: 'shortOffset' }).formatToParts(d).find(x => x.type === 'timeZoneName')?.value ?? 'GMT+1'; const m = /GMT([+-])(\d{1,2})(?::(\d{2}))?/.exec(t); return m ? `${m[1]}${m[2]!.padStart(2, '0')}:${m[3] ?? '00'}` : '+01:00'; };
  const grob = new Date(`${tag}T${um}:00+01:00`);
  return `${tag}T${um}:00${versatz(grob)}`;
}
