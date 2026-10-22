import { Skill } from '@alfred/skills';
import type { SkillMetadata, SkillContext, SkillResult } from '@alfred/types';
import { bestandsbericht, type BackupStand, type NetzEintrag, type ProxyEintrag, type VmEintrag } from './bericht.js';
import type { HostBestand } from './sammler.js';

/**
 * Spec Infrastruktur-Vorhaben, I1 (Owner 22.10.2026 „I1 wie vorgeschlagen umsetzen“) — Skill `infrastruktur`, Aktion `bestand`:
 * Bestandsaufnahme nur lesend. Aktualisiert die CMDB aus den Quellen (Fernzugriff-Sammler, Proxmox, NPM, UniFi, pfSense, MikroTik),
 * liest Sicherungen aller VMs, erstellt den Bestandsbericht mit festen Regeln für Auffälligkeiten und legt ihn als CMDB-Dokument ab.
 * Nichts wird verändert außer CMDB-Einträgen und dem Bericht.
 */
export interface InfrastrukturDeps {
  istOwner: (ctx: SkillContext) => boolean;
  /** CMDB-Quellen der Reihe nach entdecken; liefert je Quelle eine Zeile (Assets/Relationen oder Fehler) */
  entdecke: (quellen: string[]) => Promise<string[]>;
  /** Host-Bestände der letzten Fernzugriff-Discovery */
  hosts: () => HostBestand[];
  vms: () => Promise<VmEintrag[]>;
  proxy: () => Promise<ProxyEintrag[]>;
  netze: () => Promise<NetzEintrag[]>;
  backups?: () => Promise<BackupStand | undefined>;
  speichereBericht: (titel: string, markdown: string) => Promise<string>;
  protokoll?: (msg: string, daten: Record<string, unknown>) => void;
}

export const BESTAND_QUELLEN = ['fernzugriff', 'proxmox', 'nginx_proxy_manager', 'unifi', 'pfsense', 'mikrotik'];

export class InfrastrukturSkill extends Skill {
  readonly metadata: SkillMetadata = {
    name: 'infrastruktur',
    category: 'infrastructure',
    description:
      'Infrastruktur-Vorhaben (Spec 2026-10-22). bestand: vollständige Bestandsaufnahme NUR LESEND — aktualisiert die CMDB aus Fernzugriff (Hosts: OS, Ressourcen, Updates, Dienste, Ports, Container, Compose, Volumes), Proxmox, NPM, UniFi, pfSense, MikroTik, liest die Sicherungen aller VMs und erstellt den Bestandsbericht mit Auffälligkeiten (als CMDB-Dokument). '
      + 'Für Fragen wie „was läuft wo“, „Bestandsaufnahme“, „Analyse des dockerhost/Clusters“, „Grundlage für eine neue Architektur“. Ändert nichts an der Infrastruktur.',
    riskLevel: 'read',
    version: '1.0.0',
    timeoutMs: 15 * 60_000,
    inputSchema: {
      type: 'object',
      properties: {
        action: { type: 'string', enum: ['bestand'], description: 'bestand' },
        quellen: { type: 'array', items: { type: 'string' }, description: `optional: nur diese CMDB-Quellen (Standard: ${BESTAND_QUELLEN.join(', ')})` },
      },
      required: ['action'],
    },
  };

  constructor(private readonly deps: InfrastrukturDeps) { super(); }

  async execute(input: Record<string, unknown>, context: SkillContext): Promise<SkillResult> {
    if (!this.deps.istOwner(context)) return { success: false, error: 'Nur für den Owner.' };
    if (input.action !== 'bestand') return { success: false, error: 'Unbekannte Aktion (bestand)' };
    const start = Date.now();
    const quellen = Array.isArray(input.quellen) && input.quellen.length ? input.quellen.filter((q): q is string => typeof q === 'string' && BESTAND_QUELLEN.includes(q)) : BESTAND_QUELLEN;
    const discovery = await this.deps.entdecke(quellen);
    const [vms, proxy, netze, backups] = await Promise.all([
      this.deps.vms().catch(() => []), this.deps.proxy().catch(() => []), this.deps.netze().catch(() => []),
      this.deps.backups?.().catch(() => undefined) ?? Promise.resolve(undefined),
    ]);
    const hosts = this.deps.hosts();
    const r = bestandsbericht({ hosts, vms, proxy, netze, ...(backups ? { backups } : {}) });
    const titel = `Bestandsbericht ${new Date().toLocaleDateString('de-AT', { timeZone: 'Europe/Vienna' })}`;
    const markdown = `${r.markdown}\n\n## Discovery\n\n${discovery.map(d => `- ${d}`).join('\n')}\n`;
    const docId = await this.deps.speichereBericht(titel, markdown);
    this.deps.protokoll?.('I1 Bestandsaufnahme fertig', { dauerS: Math.round((Date.now() - start) / 1000), hosts: hosts.length, vms: vms.length, auffaelligkeiten: r.auffaelligkeiten.length, docId });
    const top = r.auffaelligkeiten.slice(0, 25).map(a => `- **${a.schwere}** · ${a.bereich}: ${a.text}`);
    return {
      success: true,
      data: { docId, auffaelligkeiten: r.auffaelligkeiten, hosts: hosts.map(h => ({ zugang: h.zugang, container: h.container.length, fehler: h.fehler })), discovery },
      display: `## ${titel}\n\n${r.kurz}\n\n### Auffälligkeiten\n${top.join('\n') || 'Keine.'}${r.auffaelligkeiten.length > 25 ? `\n… und ${r.auffaelligkeiten.length - 25} weitere im Bericht` : ''}\n\nVollständiger Bericht als CMDB-Dokument (ID ${docId}).\n\n### Discovery\n${discovery.map(d => `- ${d}`).join('\n')}`,
    };
  }
}
