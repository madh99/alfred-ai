/**
 * Skill windows_pki (Vorhaben 3bb8c058) — v1810 Etappe 1: status (lesend), online über SSH (zugang) oder für die netzlose
 * Offline-Root über den QEMU-Gastagenten (vmid + vm_name). Ändernde Bausteine folgen in Etappe 2 (nur in Changes).
 */
import { Skill } from '@alfred/skills';
import type { SkillMetadata, SkillContext, SkillResult } from '@alfred/types';
import { kodiert, adErgebnis, clixmlFehler } from './windows-ad.js';
import { pkiStatusSkript, pkiStatusText, type PkiStatus } from './windows-pki.js';

export interface WindowsPkiDeps {
  skript: (zugang: string, befehl: string, eingabe: string | undefined, timeoutMs: number, zweck: string) => Promise<{ code: number; stdout: string; stderr: string }>;
  gast?: (vmid: number, vmName: string, skript: string, eingabe: string | undefined, timeoutMs: number) => Promise<{ code: number; stdout: string; stderr: string }>;
}

export const PKI_LESEND = new Set(['status']);
const ZUGANG = /^[a-z0-9][a-z0-9.-]{0,62}$/i;
const VM_NAME = /^[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?$/;

export class WindowsPkiSkill extends Skill {
  readonly metadata: SkillMetadata = {
    name: 'windows_pki',
    category: 'infrastructure',
    description:
      'Eigene PKI (Vorhaben 3bb8c058: Offline-Root pkiroot01 ohne Netz + Enterprise-Issuing-CA pkiiss01) über feste PowerShell-Bausteine. '
      + 'status (lesend, auch außerhalb von Changes): entweder zugang = Windows-Fernzugang (Issuing-CA, Domänenmitglied) ODER vmid + vm_name für die netzlose Offline-Root (über den QEMU-Gastagenten, nie über ein Netz) — '
      + 'Rolle ADCS-Cert-Authority, Dienst CertSvc, CA-Name und -Typ, Zertifikat (Schlüssel, Signatur, pathLen, Laufzeit, Kette, privater Schlüssel, Thumbprint), CRL-Periode/Überlappung/Delta, CDP/AIA, CRL-Dateien, Domäne/Workgroup und Zahl der Netzwerkkarten. '
      + 'Ergebnis beginnt mit „PKI_STATUS_OK“, sobald eine CA eingerichtet ist; vorher „keine CA“ bzw. „Rolle installiert, keine CA eingerichtet“. Offline-Ergebnisse tragen die Erhebungszeit.',
    riskLevel: 'admin',
    version: '1.0.0',
    timeoutMs: 600_000,
    inputSchema: {
      type: 'object',
      properties: {
        action: { type: 'string', enum: [...PKI_LESEND] },
        zugang: { type: 'string', description: 'Windows-Fernzugang (z. B. pkiiss01)' },
        vmid: { type: 'number', description: 'netzlose Offline-Root: VMID (Gastagent)' },
        vm_name: { type: 'string', description: 'netzlose Offline-Root: erwarteter VM-Name (Schutz vor falscher VMID), z. B. pkiroot01' },
      },
      required: ['action'],
    },
  };

  constructor(private readonly d: WindowsPkiDeps) { super(); }

  async execute(input: Record<string, unknown>, _context?: SkillContext): Promise<SkillResult> {
    const action = String(input.action ?? '');
    if (!PKI_LESEND.has(action)) return { success: false, error: `Unbekannte Aktion ${action}` };
    try {
      const { r, weg } = await this.lauf<PkiStatus>(input, pkiStatusSkript(), 'PKI-Status', 180_000);
      return { success: true, data: { ...r, weg }, display: pkiStatusText(r, weg) };
    } catch (err) { return { success: false, error: (err as Error).message }; }
  }

  /** Online über SSH (zugang) oder offline über den Gastagenten (vmid + vm_name) — nie beides */
  private async lauf<T>(input: Record<string, unknown>, skript: string, zweck: string, timeoutMs: number, eingabe?: Record<string, string>): Promise<{ r: T; weg: 'ssh' | 'gastagent' }> {
    const zugang = input.zugang === undefined ? '' : String(input.zugang).trim();
    const hatVm = input.vmid !== undefined;
    if (!!zugang === hatVm) throw new Error('entweder zugang (Fernzugang) ODER vmid + vm_name (netzlose VM über den Gastagenten) angeben');
    let roh: { code: number; stdout: string; stderr: string }; let wo: string; let weg: 'ssh' | 'gastagent';
    if (zugang) {
      if (!ZUGANG.test(zugang)) throw new Error('zugang: Name des Windows-Fernzugangs');
      roh = await this.d.skript(zugang, kodiert(skript), eingabe ? JSON.stringify(eingabe) : undefined, timeoutMs, zweck); wo = zugang; weg = 'ssh';
    } else {
      const vmid = Number(input.vmid); const name = String(input.vm_name ?? '').trim();
      if (!Number.isInteger(vmid) || vmid < 100) throw new Error('vmid: VMID der netzlosen VM');
      if (!VM_NAME.test(name)) throw new Error('vm_name: erwarteter VM-Name (Pflicht beim Gastagenten)');
      if (!this.d.gast) throw new Error('Gastagent nicht verfügbar (Proxmox-Skill fehlt)');
      roh = await this.d.gast(vmid, name, skript, eingabe ? JSON.stringify(eingabe) : undefined, timeoutMs); wo = `${name} (VM ${vmid}, Gastagent)`; weg = 'gastagent';
    }
    const e = adErgebnis<T>(roh.stdout);
    if (roh.code !== 0 || !e) {
      const klar = `${roh.stderr}\n${roh.stdout}`.split(/\r?\n/).filter(z => z.trim() && !z.startsWith('#< CLIXML') && !z.startsWith('<Objs')).join(' ');
      throw new Error(`${zweck} auf ${wo} gescheitert (Exit ${roh.code}): ${`${klar} ${clixmlFehler(`${roh.stderr}\n${roh.stdout}`)}`.replace(/\s+/g, ' ').trim().slice(-600) || 'keine Ausgabe'}`);
    }
    return { r: e, weg };
  }
}
