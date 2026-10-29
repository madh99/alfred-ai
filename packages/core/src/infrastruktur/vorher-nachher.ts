/**
 * S2 (Spec 2026-10-27-standard-changes-eingangskontrolle §4.3) — generischer Vorher-/Nachher-Vergleich als Change-Schritte, abgeleitet
 * aus den I9-Schritten 3/8 (Realfall 29.10., fünf VMs ohne Befund), aber ohne feste Namen: Was laufen muss, erhebt der Lauf selbst.
 *
 * Vorher: laufende Container (Name, Image-ID, Neustart-Regel, Health), lauschende Ports, laufende aktivierte Dienste, Boot-ID, Kernel.
 * Nachher (bis zu `warteS` Sekunden): dieselben Container laufen mit derselben Image-ID und Neustart-Regel; vorher gesunde sind wieder
 * gesund; alle vorher lauschenden Ports und laufenden aktivierten Dienste sind wieder da. Vorher schon Ungesundes ist kein Fehler,
 * steht aber im Bericht. Nach einem Neustart werden Container ohne Neustart-Regel einmal gestartet (wie I9).
 */
export const VERGLEICH_MARKER = { vorher: 'S2_VORHER_OK', nachher: 'S2_NACHHER_OK' } as const;
const PFAD = /^\/var\/lib\/alfred-wartung\/[a-z0-9_-]{3,60}$/;

/** Arbeitsverzeichnis eines Laufs (nur unter /var/lib/alfred-wartung) */
export function wartungsVerzeichnis(tag: string): string {
  const p = `/var/lib/alfred-wartung/${tag.toLowerCase().replace(/[^a-z0-9_-]/g, '-')}`;
  if (!PFAD.test(p)) throw new Error(`ungültiges Wartungsverzeichnis ${p}`);
  return p;
}

const GEMEINSAM = `import json,pathlib as p,subprocess as s,time
def out(a):return s.run(a,text=True,capture_output=True,check=True).stdout
def container():
 namen=out(['docker','ps','--format','{{.Names}}']).split() if s.run(['systemctl','is-active','--quiet','docker']).returncode==0 else []
 r={}
 for n in namen:
  v=out(['docker','inspect','--format','{{.Id}} {{.Image}} {{.HostConfig.RestartPolicy.Name}} {{with index .State "Health"}}{{.Status}}{{else}}none{{end}}',n]).split()
  r[n]={'id':v[0],'image':v[1],'neustart':v[2] if len(v)>2 else '','health':v[3] if len(v)>3 else 'none'}
 return r
def ports():
 return sorted({l.split()[0]+'/'+l.split()[4].rsplit(':',1)[1] for l in out(['ss','-H','-lntu']).splitlines() if len(l.split())>4})
def dienste():
 an={l.split()[0] for l in out(['systemctl','list-unit-files','--type=service','--state=enabled','--no-legend','--plain']).splitlines() if l.strip()}
 laufend={l.split()[0] for l in out(['systemctl','list-units','--type=service','--state=running','--no-legend','--plain']).splitlines() if l.strip()}
 return sorted(an&laufend)
`;

/** Python-Skript für den Schritt „Vorher erheben“ (als root, schreibt <d>/vorher.json) */
export function vorherSkript(verzeichnis: string): string {
  if (!PFAD.test(verzeichnis)) throw new Error('verzeichnis');
  return `python3 - <<'PY'
${GEMEINSAM}d=p.Path('${verzeichnis}');d.mkdir(mode=0o700,parents=True,exist_ok=True)
z={'container':container(),'ports':ports(),'dienste':dienste(),'boot':p.Path('/proc/sys/kernel/random/boot_id').read_text().strip(),'kernel':out(['uname','-r']).strip()}
(d/'vorher.json').write_text(json.dumps(z,indent=1))
print('${VERGLEICH_MARKER.vorher}',len(z['container']),'Container',len(z['ports']),'Ports',len(z['dienste']),'Dienste')
(d/'vorher.ok').write_text('${VERGLEICH_MARKER.vorher}\\n')
PY`;
}

/** Python-Skript für den Schritt „Nachher vergleichen“ (als root; Marker nur ohne Abweichung) */
export function nachherSkript(verzeichnis: string, warteS = 300): string {
  if (!PFAD.test(verzeichnis)) throw new Error('verzeichnis');
  const w = Math.max(30, Math.min(900, Math.round(warteS)));
  return `python3 - <<'PY'
${GEMEINSAM}d=p.Path('${verzeichnis}');v=json.loads((d/'vorher.json').read_text())
neu=p.Path('/proc/sys/kernel/random/boot_id').read_text().strip()!=v['boot']
if neu:
 time.sleep(20)
 laufend=out(['docker','ps','--format','{{.Names}}']).split() if s.run(['systemctl','is-active','--quiet','docker']).returncode==0 else []
 for n,c in v['container'].items():
  if n not in laufend and c['neustart'] in ('no',''):s.run(['docker','start',n])
ende=time.monotonic()+${w}
while True:
 c=container();po=set(ports());di=set(dienste());fehler=[];hinweise=[]
 for n,a in v['container'].items():
  b=c.get(n)
  if not b:fehler.append('Container fehlt: '+n);continue
  if b['image']!=a['image']:fehler.append('Image geändert: '+n)
  if b['neustart']!=a['neustart']:fehler.append('Neustart-Regel geändert: '+n)
  if a['health']=='healthy' and b['health']!='healthy':fehler.append('nicht mehr gesund: '+n+' ('+b['health']+')')
  if a['health'] not in ('healthy','none'):hinweise.append('schon vorher '+a['health']+': '+n)
 for x in v['ports']:
  if x not in po:fehler.append('Port lauscht nicht mehr: '+x)
 for x in v['dienste']:
  if x not in di:fehler.append('Dienst läuft nicht mehr: '+x)
 if not fehler or time.monotonic()>ende:break
 time.sleep(10)
bericht={'neustart':neu,'kernel':out(['uname','-r']).strip(),'fehler':fehler,'hinweise':hinweise,'container':len(c),'neu':sorted(set(c)-set(v['container']))}
(d/'nachher.json').write_text(json.dumps(bericht,indent=1));print(json.dumps(bericht,ensure_ascii=False))
assert not fehler,'; '.join(fehler)
(d/'nachher.ok').write_text('${VERGLEICH_MARKER.nachher}\\n')
PY`;
}

/** Die zwei Schritte für einen Plan (Rückweg des Nachher-Schritts gibt die Vorlage vor) */
export function vorherNachherSchritte(zugang: string, verzeichnis: string, rueckweg: Record<string, unknown>, warteS = 300): { vorher: Record<string, unknown>; nachher: Record<string, unknown> } {
  return {
    vorher: { titel: 'Vorher erheben: Container, Ports, Dienste', art: 'aktion', skill: 'fernzugriff', aktion: 'ausfuehren', parameter: { name: zugang, als_root: true, befehl: vorherSkript(verzeichnis), timeout_s: 120 }, pruefung: { typ: 'befehl', zugang, befehl: `cat ${verzeichnis}/vorher.ok`, erwartet: VERGLEICH_MARKER.vorher }, rueckweg, zeitlimitS: 180 },
    nachher: { titel: 'Nachher vergleichen: dieselben Container, Ports und Dienste', art: 'aktion', skill: 'fernzugriff', aktion: 'ausfuehren', parameter: { name: zugang, als_root: true, befehl: nachherSkript(verzeichnis, warteS), timeout_s: warteS + 120 }, pruefung: { typ: 'befehl', zugang, befehl: `cat ${verzeichnis}/nachher.ok`, erwartet: VERGLEICH_MARKER.nachher }, rueckweg, zeitlimitS: warteS + 180 },
  };
}
