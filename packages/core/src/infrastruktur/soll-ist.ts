/**
 * Spec Infrastruktur-Vorhaben, I4b Teil 5 (4b „Soll/Ist“) — die angenommene Zielarchitektur ist der Soll-Zustand; der Abgleich
 * zeigt ohne Modell, was davon schon Ist ist: VM vorhanden (Knoten, Größe), geplantes Netz vorhanden, Dienste auf dem neuen Host,
 * Proxy-Einträge auf die neue Adresse. Ergebnis: Fortschritt und Abweichungen je Gruppe.
 */
import type { Architektur, ArchitekturGruppe } from './architektur.js';
import { hostPorts } from './architektur.js';
import type { HostBestand } from './sammler.js';
import type { NetzEintrag, ProxyEintrag } from './bericht.js';

export interface IstVm { assetId: string; name: string; node?: string; status: string; ip?: string; cpus?: number; ramBytes?: number }
export interface SollIstEingabe {
  architektur: Architektur;
  vms: IstVm[];
  zugaenge: Array<{ name: string; host: string }>;
  hosts: HostBestand[];
  netze: NetzEintrag[];
  proxy: ProxyEintrag[];
  /** Fernzugänge der Quell-Hosts des Vorhabens (z. B. dockerhost) */
  quellHosts: string[];
}
export interface SollIstPunkt { ok: boolean; text: string }
export interface SollIstGruppe { name: string; ziel: ArchitekturGruppe['ziel']; punkte: SollIstPunkt[] }
export interface SollIstErgebnis { gruppen: SollIstGruppe[]; erfuellt: number; gesamt: number; abweichungen: string[] }

const GB = 1024 ** 3;
const hatEinheit = (h: HostBestand | undefined, einheit: string) => !!h?.container.some(c => (c.composeProjekt === einheit || c.name === einheit) && c.zustand === 'running');

export function sollIst(e: SollIstEingabe): SollIstErgebnis {
  const gruppen: SollIstGruppe[] = [];
  const quellen = e.hosts.filter(h => e.quellHosts.includes(h.zugang));
  const hostNachZugang = new Map(e.hosts.map(h => [h.zugang, h]));
  for (const g of e.architektur.gruppen) {
    const punkte: SollIstPunkt[] = [];
    if (g.ziel === 'vm' || g.ziel === 'lxc') {
      const vm = e.vms.find(v => v.name.toLowerCase() === (g.vmName ?? '').toLowerCase() && v.status === 'active');
      if (!vm) punkte.push({ ok: false, text: `${g.ziel.toUpperCase()} ${g.vmName} fehlt noch (geplant auf ${g.knoten})` });
      else {
        punkte.push({ ok: !g.knoten || vm.node === g.knoten, text: `${g.ziel.toUpperCase()} ${g.vmName} läuft${vm.node ? ` auf ${vm.node}` : ''}${g.knoten && vm.node && vm.node !== g.knoten ? ` — geplant war ${g.knoten}` : ''}` });
        if (g.vcpu && vm.cpus) punkte.push({ ok: vm.cpus === g.vcpu, text: `vCPU ${vm.cpus}${vm.cpus === g.vcpu ? '' : ` — geplant ${g.vcpu}`}` });
        if (g.ramGb && vm.ramBytes) { const ist = Math.round((vm.ramBytes / GB) * 10) / 10; punkte.push({ ok: Math.abs(ist - g.ramGb) < 0.6, text: `RAM ${ist} GB${Math.abs(ist - g.ramGb) < 0.6 ? '' : ` — geplant ${g.ramGb} GB`}` }); }
      }
      const netz = e.architektur.netze.find(n => n.name.toLowerCase() === (g.netz ?? '').toLowerCase());
      if (netz?.neu && netz.vlan !== undefined) {
        const da = e.netze.some(n => Number(n.vlan) === netz.vlan);
        punkte.push({ ok: da, text: `Netz ${netz.name} (VLAN ${netz.vlan}, ${netz.geraet}) ${da ? 'vorhanden' : 'fehlt noch'}` });
      }
      const zielHost = vm?.ip ? e.zugaenge.find(z => z.host === vm.ip) : undefined;
      const neu = zielHost ? hostNachZugang.get(zielHost.name) : undefined;
      for (const einheit of g.einheiten.filter(x => !e.quellHosts.includes(x))) {
        const dort = hatEinheit(neu, einheit);
        const nochAlt = quellen.find(h => hatEinheit(h, einheit));
        punkte.push({ ok: dort && !nochAlt, text: dort ? `${einheit} läuft auf ${g.vmName}${nochAlt ? ` — läuft zusätzlich noch auf ${nochAlt.zugang}` : ''}` : `${einheit} ${nochAlt ? `noch auf ${nochAlt.zugang}` : 'nirgends laufend gefunden'}${vm && !zielHost ? ` (kein Fernzugang für ${g.vmName})` : ''}` });
        // Proxy-Einträge, die über die Ports dieser Einheit noch auf einen Quell-Host zeigen
        const ports = new Set([...(neu?.container ?? []), ...quellen.flatMap(h => h.container)].filter(c => c.composeProjekt === einheit || c.name === einheit).flatMap(c => hostPorts(c.ports)));
        for (const q of quellen) for (const p of e.proxy.filter(x => x.forwardHost === q.host && ports.has(x.forwardPort))) punkte.push({ ok: false, text: `Proxy ${p.domains[0]} zeigt noch auf ${q.zugang} (${p.forwardHost}:${p.forwardPort})` });
      }
      if (vm?.ip) for (const p of e.proxy.filter(x => x.forwardHost === vm.ip)) punkte.push({ ok: true, text: `Proxy ${p.domains[0]} → ${g.vmName}` });
    } else if (g.ziel === 'bleibt') {
      // „bleibt“ heißt: bleibt, wie es ist — auch absichtlich gestoppte Container (Realfall 22.10.: keycloak/ioBroker gestoppt erhalten)
      for (const einheit of g.einheiten.filter(x => !e.quellHosts.includes(x))) {
        const c = quellen.flatMap(h => h.container).filter(x => x.composeProjekt === einheit || x.name === einheit);
        const laeuft = c.some(x => x.zustand === 'running');
        punkte.push({ ok: c.length > 0, text: `${einheit} ${!c.length ? 'ist am bisherigen Ort nicht mehr vorhanden' : laeuft ? 'läuft wie geplant weiter' : 'bleibt wie geplant (gestoppt)'}` });
      }
    } else if (g.ziel === 'stilllegen') {
      for (const einheit of g.einheiten) {
        const laeuft = quellen.some(h => hatEinheit(h, einheit)) || e.vms.some(v => v.name === einheit && v.status === 'active');
        punkte.push({ ok: !laeuft, text: `${einheit} ${laeuft ? 'läuft noch (Stilllegung frühestens 7 Tage nach der Migration, eigener Change)' : 'stillgelegt'}` });
      }
    }
    gruppen.push({ name: g.name, ziel: g.ziel, punkte });
  }
  const alle = gruppen.flatMap(g => g.punkte);
  return { gruppen, erfuellt: alle.filter(p => p.ok).length, gesamt: alle.length, abweichungen: gruppen.flatMap(g => g.punkte.filter(p => !p.ok).map(p => `${g.name}: ${p.text}`)) };
}

export function sollIstText(titel: string, r: SollIstErgebnis): string {
  const z = [`## Soll/Ist: ${titel}`, '', `**Fortschritt:** ${r.erfuellt} von ${r.gesamt} Punkten erfüllt${r.gesamt ? ` (${Math.round((r.erfuellt / r.gesamt) * 100)} %)` : ''}`, ''];
  for (const g of r.gruppen) z.push(`### ${g.name} (${g.ziel})`, ...g.punkte.map(p => `- ${p.ok ? '✓' : '·'} ${p.text}`), '');
  return z.join('\n');
}

/** Geplante CMDB-Assets einer angenommenen Architektur (Status planned, Quelle infrastruktur). */
export function geplanteAssets(vorhabenId: string, a: Architektur): Array<{ name: string; assetType: 'vm' | 'lxc'; sourceId: string; attributes: Record<string, unknown> }> {
  return a.gruppen.filter(g => (g.ziel === 'vm' || g.ziel === 'lxc') && g.vmName).map(g => ({
    name: g.vmName!, assetType: g.ziel as 'vm' | 'lxc', sourceId: `vorhaben:${vorhabenId}:${g.vmName}`,
    attributes: { vorhabenId, gruppe: g.name, knoten: g.knoten, vcpu: g.vcpu, ramGb: g.ramGb, diskGb: g.diskGb, speicher: g.speicher, distribution: g.distribution, netz: g.netz, einheiten: g.einheiten },
  }));
}
