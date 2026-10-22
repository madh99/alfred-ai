import { Skill } from '@alfred/skills';
import type { SkillMetadata, SkillContext, SkillResult } from '@alfred/types';
import { bestandsbericht, type BackupStand, type NetzEintrag, type ProxyEintrag, type VmEintrag } from './bericht.js';
import type { HostBestand } from './sammler.js';
import { architekturDokument, grundlageText, planungsGrundlage, pruefeArchitektur, DISTRIBUTIONEN, type KnotenStand, type PlanungsGrundlage, type SpeicherStand } from './architektur.js';
import { changeAnzeige, type ChangePlanung } from './change-planung.js';
import { PRUEF_TYPEN } from './change-schritte.js';

/** Ausschnitt des VorhabenRepository (@alfred/storage), damit der Skill ohne DB testbar bleibt. */
export interface VorhabenSpeicher {
  liste(userId: string, nurOffen?: boolean): Promise<VorhabenDaten[]>;
  finde(userId: string, schluessel: string): Promise<VorhabenDaten | null>;
  anlegen(userId: string, e: { titel: string; ziel: string; hosts: string[]; bestandDocId?: string }): Promise<VorhabenDaten>;
  setzeArchitektur(userId: string, id: string, architektur: unknown, docId: string, bestandDocId?: string): Promise<VorhabenDaten>;
  entscheide(userId: string, id: string, e: { entscheidung: 'annehmen' | 'ablehnen' | 'ueberarbeiten'; wortlaut: string; architekturVersion: number }, status: VorhabenDaten['status']): Promise<VorhabenDaten>;
  fuegeChangesHinzu?(userId: string, id: string, changeIds: string[]): Promise<void>;
}
export interface VorhabenDaten {
  id: string; titel: string; ziel: string; hosts: string[];
  status: 'entwurf' | 'architektur_vorgeschlagen' | 'angenommen' | 'verworfen';
  bestandDocId?: string; architekturDocId?: string; architekturVersion: number;
  entscheidungen: Array<{ zeit: string; entscheidung: string; wortlaut: string; architekturVersion: number }>;
  changeIds: string[]; erstellt: string;
}

/**
 * Spec Infrastruktur-Vorhaben — Skill `infrastruktur`.
 * I1 (Owner 22.10.2026): `bestand` — Bestandsaufnahme nur lesend (CMDB-Discovery, Sicherungen, Bestandsbericht als CMDB-Dokument).
 * I2 (Owner 22.10.2026 „I2 wie vorgeschlagen umsetzen“): Vorhaben und Zielarchitektur — `vorhaben_anlegen`, `grundlage`,
 * `architektur_vorschlagen` (Struktur wird deterministisch geprüft, Dokument nach fester Vorlage), `entscheiden`,
 * `vorhaben_liste`, `vorhaben_zeigen`. Nichts davon verändert die Infrastruktur.
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
  // ── I2 ──
  ownerId?: () => string | undefined;
  vorhaben?: VorhabenSpeicher;
  aktiveZugaenge?: () => Promise<string[]>;
  knoten?: () => Promise<KnotenStand[]>;
  speicher?: () => Promise<SpeicherStand[]>;
  letzterBestandDocId?: () => Promise<string | undefined>;
  speichereArchitektur?: (vorhabenId: string, titel: string, markdown: string) => Promise<string>;
  // ── I3 ──
  changes?: ChangePlanung;
}

export const BESTAND_QUELLEN = ['fernzugriff', 'proxmox', 'nginx_proxy_manager', 'unifi', 'pfsense', 'mikrotik'];
/** Host-Bestände älter als das werden für die Planung neu erfasst */
export const GRUNDLAGE_MAX_ALTER_MS = 6 * 3_600_000;

const AKTIONEN = ['bestand', 'vorhaben_anlegen', 'vorhaben_liste', 'vorhaben_zeigen', 'grundlage', 'architektur_vorschlagen', 'entscheiden', 'changes_planen', 'changes_liste', 'change_zeigen', 'change_aendern', 'freigabe_anfragen', 'freigeben'] as const;

const STATUS_TEXT: Record<VorhabenDaten['status'], string> = {
  entwurf: 'Entwurf (noch keine geprüfte Architektur)',
  architektur_vorgeschlagen: 'Architektur vorgeschlagen — Owner entscheidet',
  angenommen: 'Architektur angenommen',
  verworfen: 'verworfen',
};

export class InfrastrukturSkill extends Skill {
  readonly metadata: SkillMetadata = {
    name: 'infrastruktur',
    category: 'infrastructure',
    description:
      'Infrastruktur-Vorhaben (Spec 2026-10-22). Ändert nichts an der Infrastruktur. '
      + 'bestand: vollständige Bestandsaufnahme NUR LESEND — aktualisiert die CMDB aus Fernzugriff (Hosts: OS, Ressourcen, Updates, Dienste, Ports, Container, Compose, Volumes), Proxmox, NPM, UniFi, pfSense, MikroTik, liest die Sicherungen aller VMs und erstellt den Bestandsbericht mit Auffälligkeiten (als CMDB-Dokument). '
      + 'Für ein Ziel wie „dockerhost aufteilen“, „neue Architektur vorschlagen“, „auf neue VMs migrieren“: '
      + '1) vorhaben_anlegen (titel, ziel in den Worten des Owners, hosts = Fernzugang-Namen); '
      + '2) grundlage (vorhaben) — Einheiten (Compose-Projekte, einzelne Container, Host) mit gemessenem RAM, Daten, Ports, Proxy-Domains, dazu Proxmox-Knoten, Speicher, Netze; '
      + '3) architektur_vorschlagen (vorhaben, architektur) — JEDE Einheit genau einer Gruppe zuordnen (ziel vm|lxc|bleibt|stilllegen; vm/lxc mit vmName, knoten, vcpu, ramGb, diskGb, distribution + distributionBegruendung, netz), '
      + 'netze (neu/vorhanden, geraet unifi|pfsense|mikrotik, vlan, subnetz ohne Überschneidung), firewall (je Regel eine Zone von/nach: Netz, Gruppe oder internet/vpn/proxy/alle; protokoll, ports), proxyDns, sicherung, updates, reihenfolge (jede neue VM/LXC), risiken, offeneEntscheidungen. Wird geprüft; bei Fehlern nachbessern und erneut senden. '
      + 'Ergebnis: Architektur-Dokument (CMDB). 4) entscheiden NUR auf ausdrückliche Aussage des Owners (annehmen|ueberarbeiten|ablehnen, wortlaut = seine Worte). '
      + 'vorhaben_liste / vorhaben_zeigen: Stand der Vorhaben. '
      + 'CHANGES (I3, nichts wird ausgeführt): changes_planen (vorhaben optional — nur mit angenommener Architektur; changes = Liste von Plänen: schluessel, titel, begruendung, typ normal|notfall, risiko niedrig|mittel|hoch|kritisch, ausfallMinuten, geplantAb, betroffen = CMDB-Assets, abhaengigVon = Schlüssel/Change-IDs, zweck stilllegung nur für Löschen, ohneSicherungGrund wenn nur Neues entsteht, schritte). '
      + 'Schritt: art aktion (skill, aktion, parameter, pruefung, rueckweg {skill,aktion,parameter} — Pflicht bei ändernden Aktionen; vor der ersten Änderung eine Sicherung, z. B. proxmox create_snapshot), pruefung (pruefung), warten (sekunden oder pruefung), owner (frage — für Handgriffe, solange eine Skill-Aktion fehlt). '
      + 'Verweise: {{schrittN.feld}} auf frühere Aktionen, {{geheim:name}} für Tresor-Werte. Ein Paket mit Fehlern wird nicht gespeichert — nachbessern. '
      + 'changes_liste, change_zeigen (change), change_aendern (change, plan — Freigabe verfällt), freigabe_anfragen (ids = Change-IDs; stellt dem Owner die Freigabe-Frage per Button). freigeben NIE selbst aufrufen — kommt nur über das Ja des Owners.',
    riskLevel: 'read',
    version: '2.0.0',
    timeoutMs: 15 * 60_000,
    inputSchema: {
      type: 'object',
      properties: {
        action: { type: 'string', enum: [...AKTIONEN] },
        quellen: { type: 'array', items: { type: 'string' }, description: `bestand: optional nur diese CMDB-Quellen (Standard: ${BESTAND_QUELLEN.join(', ')})` },
        vorhaben: { type: 'string', description: 'ID (oder ID-Anfang) oder Titel des Vorhabens' },
        titel: { type: 'string', description: 'vorhaben_anlegen: kurzer Titel' },
        ziel: { type: 'string', description: 'vorhaben_anlegen: Ziel in den Worten des Owners' },
        hosts: { type: 'array', items: { type: 'string' }, description: 'vorhaben_anlegen: Fernzugang-Namen, um die es geht (z. B. dockerhost)' },
        architektur: {
          type: 'object',
          description: 'architektur_vorschlagen: die Zielarchitektur',
          properties: {
            zusammenfassung: { type: 'string' },
            gruppen: { type: 'array', items: { type: 'object', properties: {
              name: { type: 'string' }, zweck: { type: 'string' }, begruendung: { type: 'string' },
              einheiten: { type: 'array', items: { type: 'string' } },
              ziel: { type: 'string', enum: ['vm', 'lxc', 'bleibt', 'stilllegen'] },
              vmName: { type: 'string' }, knoten: { type: 'string' }, vcpu: { type: 'number' }, ramGb: { type: 'number' }, diskGb: { type: 'number' }, speicher: { type: 'string' },
              distribution: { type: 'string', enum: [...DISTRIBUTIONEN] }, distributionBegruendung: { type: 'string' },
              netz: { type: 'string' }, verwaltung: { type: 'string', enum: ['fernzugriff', 'satellit'] },
            } } },
            netze: { type: 'array', items: { type: 'object', properties: { name: { type: 'string' }, vlan: { type: 'number' }, subnetz: { type: 'string' }, geraet: { type: 'string', enum: ['unifi', 'pfsense', 'mikrotik'] }, zweck: { type: 'string' }, neu: { type: 'boolean' } } } },
            firewall: { type: 'array', description: 'je Regel EINE Zone von/nach: Netzname, Gruppenname oder internet/vpn/proxy/alle; alles andere gilt als gesperrt', items: { type: 'object', properties: { von: { type: 'string' }, nach: { type: 'string' }, protokoll: { type: 'string', enum: ['tcp', 'udp', 'tcp+udp', 'icmp', 'alle'] }, ports: { type: 'string', description: '443 | 8008,8448 | 10000-20000 | alle' }, begruendung: { type: 'string' } } } },
            proxyDns: { type: 'string' }, sicherung: { type: 'string' }, updates: { type: 'string' },
            reihenfolge: { type: 'array', items: { type: 'object', properties: { gruppe: { type: 'string' }, ausfallMinuten: { type: 'number' }, voraussetzung: { type: 'string' } } } },
            risiken: { type: 'array', items: { type: 'object', properties: { risiko: { type: 'string' }, massnahme: { type: 'string' } } } },
            offeneEntscheidungen: { type: 'array', items: { type: 'string' } },
          },
        },
        entscheidung: { type: 'string', enum: ['annehmen', 'ueberarbeiten', 'ablehnen'], description: 'entscheiden: nur was der Owner ausdrücklich gesagt hat' },
        changes: {
          type: 'array', description: 'changes_planen: Pläne',
          items: { type: 'object', properties: {
            schluessel: { type: 'string' }, titel: { type: 'string' }, begruendung: { type: 'string' }, typ: { type: 'string', enum: ['normal', 'notfall'] },
            risiko: { type: 'string', enum: ['niedrig', 'mittel', 'hoch', 'kritisch'] }, ausfallMinuten: { type: 'number' }, geplantAb: { type: 'string' },
            betroffen: { type: 'array', items: { type: 'string' } }, abhaengigVon: { type: 'array', items: { type: 'string' } },
            zweck: { type: 'string', enum: ['stilllegung'] }, ohneSicherungGrund: { type: 'string' },
            schritte: { type: 'array', items: { type: 'object', properties: {
              titel: { type: 'string' }, art: { type: 'string', enum: ['aktion', 'pruefung', 'warten', 'owner'] }, skill: { type: 'string' }, aktion: { type: 'string' }, parameter: { type: 'object' },
              pruefung: { type: 'object', properties: { typ: { type: 'string', enum: [...PRUEF_TYPEN] }, ziel: { type: 'string' }, port: { type: 'number' }, erwartet: { type: 'string', description: 'Ausgabe muss das enthalten' }, nichtEnthalten: { type: 'string', description: 'Ausgabe darf das nicht enthalten (http/befehl/skill)' }, zugang: { type: 'string' }, container: { type: 'string' }, pfad: { type: 'string' }, befehl: { type: 'string' }, skill: { type: 'string' }, aktion: { type: 'string' }, parameter: { type: 'object' } } },
              rueckweg: { type: 'object', properties: { skill: { type: 'string' }, aktion: { type: 'string' }, parameter: { type: 'object' }, keiner: { type: 'string' } } },
              sekunden: { type: 'number' }, frage: { type: 'string' }, zeitlimitS: { type: 'number' }, beiFehler: { type: 'string', enum: ['anhalten', 'rueckweg', 'weiter'] },
            } } },
          } },
        },
        ids: { type: 'array', items: { type: 'string' }, description: 'freigabe_anfragen: Change-IDs (ein Change oder ein Paket)' },
        change: { type: 'string', description: 'change_zeigen/change_aendern: Change-ID (oder Anfang)' },
        plan: { type: 'object', description: 'change_aendern: vollständiger neuer Plan (wie ein Element von changes)' },
        wortlaut: { type: 'string', description: 'entscheiden: die Worte des Owners' },
      },
      required: ['action'],
    },
  };

  constructor(private readonly deps: InfrastrukturDeps) { super(); }

  async execute(input: Record<string, unknown>, context: SkillContext): Promise<SkillResult> {
    if (!this.deps.istOwner(context)) return { success: false, error: 'Nur für den Owner.' };
    const action = String(input.action ?? '');
    if (action === 'bestand') return this.bestand(input);
    if (!(AKTIONEN as readonly string[]).includes(action)) return { success: false, error: `Unbekannte Aktion (${AKTIONEN.join(', ')})` };
    const owner = this.deps.ownerId?.();
    if (!owner || !this.deps.vorhaben) return { success: false, error: 'Vorhaben sind nicht verfügbar (kein Owner oder keine Datenbank).' };
    const repo = this.deps.vorhaben;
    if (action.startsWith('change') || action === 'freigabe_anfragen' || action === 'freigeben') return this.changeAktion(owner, repo, action, input);
    switch (action) {
      case 'vorhaben_anlegen': return this.anlegen(owner, repo, input);
      case 'vorhaben_liste': {
        const l = await repo.liste(owner);
        if (!l.length) return { success: true, data: [], display: 'Noch keine Infrastruktur-Vorhaben.' };
        return { success: true, data: l.map(v => ({ id: v.id, titel: v.titel, status: v.status, hosts: v.hosts })), display: l.map(v => `- **${v.titel}** (${v.id.slice(0, 8)}) — ${STATUS_TEXT[v.status]}; Hosts: ${v.hosts.join(', ')}`).join('\n') };
      }
    }
    const v = await repo.finde(owner, String(input.vorhaben ?? ''));
    if (!v) return { success: false, error: `Vorhaben „${String(input.vorhaben ?? '')}“ nicht gefunden — vorhaben_liste zeigt alle.` };
    switch (action) {
      case 'vorhaben_zeigen': return { success: true, data: v, display: this.zeige(v) };
      case 'grundlage': {
        const g = await this.grundlage(v.hosts);
        return { success: true, data: g, display: `Vorhaben **${v.titel}** — Ziel: ${v.ziel}\n\n${grundlageText(g)}` };
      }
      case 'architektur_vorschlagen': return this.vorschlagen(owner, repo, v, input.architektur);
      case 'entscheiden': return this.entscheiden(owner, repo, v, input);
    }
    return { success: false, error: 'Unbekannte Aktion' };
  }

  private async bestand(input: Record<string, unknown>): Promise<SkillResult> {
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

  private async anlegen(owner: string, repo: VorhabenSpeicher, input: Record<string, unknown>): Promise<SkillResult> {
    const titel = typeof input.titel === 'string' ? input.titel.trim() : '';
    const ziel = typeof input.ziel === 'string' ? input.ziel.trim() : '';
    if (titel.length < 3 || ziel.length < 10) return { success: false, error: 'titel und ziel (in den Worten des Owners) angeben' };
    const aktiv = (await this.deps.aktiveZugaenge?.()) ?? [];
    const gewuenscht = Array.isArray(input.hosts) ? input.hosts.filter((h): h is string => typeof h === 'string' && !!h.trim()) : [];
    if (!gewuenscht.length) return { success: false, error: `hosts angeben (Fernzugang-Namen: ${aktiv.join(', ') || 'keine aktiv'})` };
    const hosts: string[] = [];
    for (const h of gewuenscht) {
      const z = aktiv.find(a => a.toLowerCase() === h.trim().toLowerCase());
      if (!z) return { success: false, error: `Kein aktiver Fernzugang „${h}“ (aktiv: ${aktiv.join(', ') || 'keine'})` };
      if (!hosts.includes(z)) hosts.push(z);
    }
    const bestandDocId = await this.deps.letzterBestandDocId?.().catch(() => undefined);
    const v = await repo.anlegen(owner, { titel, ziel, hosts, ...(bestandDocId ? { bestandDocId } : {}) });
    this.deps.protokoll?.('I2 Vorhaben angelegt', { id: v.id, titel, hosts });
    return { success: true, data: { id: v.id }, display: `Vorhaben **${titel}** angelegt (${v.id.slice(0, 8)}), Hosts: ${hosts.join(', ')}.\nNächster Schritt: grundlage, dann architektur_vorschlagen.` };
  }

  /** Planungsgrundlage für die Hosts des Vorhabens; zu alte oder fehlende Host-Bestände werden vorher neu erfasst (nur lesend). */
  private async grundlage(hosts: string[]): Promise<PlanungsGrundlage> {
    const frisch = (b?: HostBestand) => !!b?.erfasst && Date.now() - Date.parse(b.erfasst) < GRUNDLAGE_MAX_ALTER_MS;
    const finde = () => hosts.map(h => this.deps.hosts().find(b => b.zugang.toLowerCase() === h.toLowerCase()));
    if (!finde().every(frisch)) await this.deps.entdecke(['fernzugriff']);
    const bestaende = finde().filter((b): b is HostBestand => !!b);
    const [knoten, speicher, netze, proxy, vms] = await Promise.all([
      this.deps.knoten?.().catch(() => []) ?? Promise.resolve([]), this.deps.speicher?.().catch(() => []) ?? Promise.resolve([]),
      this.deps.netze().catch(() => []), this.deps.proxy().catch(() => []), this.deps.vms().catch(() => []),
    ]);
    return planungsGrundlage({ hosts: bestaende, knoten, speicher, netze, proxy, vms });
  }

  private async vorschlagen(owner: string, repo: VorhabenSpeicher, v: VorhabenDaten, roh: unknown): Promise<SkillResult> {
    if (v.status === 'verworfen') return { success: false, error: 'Das Vorhaben ist verworfen.' };
    if (v.status === 'angenommen') return { success: false, error: 'Die Architektur ist bereits angenommen — für eine neue Fassung zuerst entscheiden(ueberarbeiten) auf Wunsch des Owners.' };
    if (!this.deps.speichereArchitektur) return { success: false, error: 'Dokumentablage nicht verfügbar' };
    const g = await this.grundlage(v.hosts);
    if (!g.hosts.length) return { success: false, error: `Kein Bestand für ${v.hosts.join(', ')} — Fernzugriff prüfen.` };
    const p = pruefeArchitektur(typeof roh === 'string' ? (() => { try { return JSON.parse(roh); } catch { return {}; } })() : roh, g);
    if (p.fehler.length) {
      this.deps.protokoll?.('I2 Architektur abgewiesen', { id: v.id, fehler: p.fehler.length, erste: p.fehler.slice(0, 5) });
      return { success: false, error: `Architektur nicht vollständig (${p.fehler.length} Punkte) — bitte nachbessern und erneut senden:\n${p.fehler.map(x => `- ${x}`).join('\n')}` };
    }
    const version = v.architekturVersion + 1;
    const bestandDocId = await this.deps.letzterBestandDocId?.().catch(() => undefined) ?? v.bestandDocId;
    const md = architekturDokument({ titel: v.titel, ziel: v.ziel, id: v.id, version, ...(bestandDocId ? { bestandDocId } : {}) }, p.architektur, g, p.hinweise);
    const docId = await this.deps.speichereArchitektur(v.id, `Zielarchitektur ${v.titel} v${version}`, md);
    await repo.setzeArchitektur(owner, v.id, p.architektur, docId, bestandDocId);
    this.deps.protokoll?.('I2 Architektur vorgeschlagen', { id: v.id, version, docId, gruppen: p.architektur.gruppen.length, neueVms: p.architektur.gruppen.filter(x => x.ziel === 'vm' || x.ziel === 'lxc').length, hinweise: p.hinweise.length });
    return { success: true, data: { docId, version, hinweise: p.hinweise }, display: `${md}\n\n---\nGespeichert als CMDB-Dokument ${docId} (Vorhaben ${v.id.slice(0, 8)}, Version ${version}). Bitte den Owner entscheiden lassen.` };
  }

  private async entscheiden(owner: string, repo: VorhabenSpeicher, v: VorhabenDaten, input: Record<string, unknown>): Promise<SkillResult> {
    const e = String(input.entscheidung ?? '') as 'annehmen' | 'ueberarbeiten' | 'ablehnen';
    const wortlaut = typeof input.wortlaut === 'string' ? input.wortlaut.trim() : '';
    if (!['annehmen', 'ueberarbeiten', 'ablehnen'].includes(e)) return { success: false, error: 'entscheidung: annehmen, ueberarbeiten oder ablehnen' };
    if (wortlaut.length < 2) return { success: false, error: 'wortlaut: die Worte des Owners angeben — ohne ausdrückliche Aussage des Owners nicht entscheiden' };
    if (e === 'annehmen' && v.status !== 'architektur_vorgeschlagen') return { success: false, error: `Annehmen geht nur bei vorgeschlagener Architektur (Stand: ${STATUS_TEXT[v.status]})` };
    if (v.status === 'verworfen') return { success: false, error: 'Das Vorhaben ist bereits verworfen.' };
    const status = e === 'annehmen' ? 'angenommen' : e === 'ablehnen' ? 'verworfen' : 'entwurf';
    const neu = await repo.entscheide(owner, v.id, { entscheidung: e, wortlaut, architekturVersion: v.architekturVersion }, status);
    this.deps.protokoll?.('I2 Owner-Entscheidung', { id: v.id, entscheidung: e, version: v.architekturVersion });
    const weiter = e === 'annehmen' ? 'Grundlage für die Changes (nächste Ausbaustufe I3: Changes mit Schritten, je Change eigene Freigabe).' : e === 'ueberarbeiten' ? 'Architektur nach den Hinweisen des Owners überarbeiten und erneut mit architektur_vorschlagen senden.' : 'Vorhaben beendet.';
    return { success: true, data: { status: neu.status }, display: `Vorhaben **${v.titel}**: ${STATUS_TEXT[neu.status]} („${wortlaut}“). ${weiter}` };
  }

  private async changeAktion(owner: string, repo: VorhabenSpeicher, action: string, input: Record<string, unknown>): Promise<SkillResult> {
    const ch = this.deps.changes;
    if (!ch) return { success: false, error: 'Change-Planung nicht verfügbar' };
    if (action === 'freigeben') {
      const r = await ch.freigebenNachJa(owner, input);
      return r.ok ? { success: true, display: r.text } : { success: false, error: r.text };
    }
    if (action === 'changes_planen') {
      let vorhaben: VorhabenDaten | null = null;
      if (typeof input.vorhaben === 'string' && input.vorhaben.trim()) {
        vorhaben = await repo.finde(owner, input.vorhaben);
        if (!vorhaben) return { success: false, error: `Vorhaben „${input.vorhaben}“ nicht gefunden` };
      }
      const plaene = Array.isArray(input.changes) ? input.changes : typeof input.changes === 'string' ? (() => { try { const x = JSON.parse(input.changes as string); return Array.isArray(x) ? x : []; } catch { return []; } })() : [];
      const r = await ch.planen(owner, plaene, vorhaben ? { id: vorhaben.id, status: vorhaben.status, titel: vorhaben.titel } : undefined);
      if (!r.ok) {
        this.deps.protokoll?.('I3 Changes abgewiesen', { fehler: r.fehler.length, erste: r.fehler.slice(0, 5) });
        return { success: false, error: `Changes nicht gespeichert (${r.fehler.length} Punkte) — bitte nachbessern und das ganze Paket erneut senden:\n${r.fehler.map(x => `- ${x}`).join('\n')}` };
      }
      if (vorhaben) await repo.fuegeChangesHinzu?.(owner, vorhaben.id, r.changes.map(c => c.id));
      return {
        success: true, data: r.changes.map(c => ({ id: c.id, titel: c.title, fingerabdruck: c.fingerabdruck })),
        display: `${r.changes.length} Change${r.changes.length > 1 ? 's' : ''} geplant und geprüft (nichts ausgeführt):\n${r.changes.map(c => `- **${c.title}** (${c.id.slice(0, 8)}) — ${(c.schritte ?? []).length} Schritte${c.pruefung?.hinweise.length ? `; Hinweise: ${c.pruefung.hinweise.join('; ')}` : ''}`).join('\n')}\n\nZur Freigabe: freigabe_anfragen mit den IDs (der Owner bestätigt per Button). Ansicht auch im Web unter ITSM → Changes.`,
      };
    }
    if (action === 'changes_liste') {
      let l = (await ch.liste(owner)).filter(c => c.schritte?.length);
      if (typeof input.vorhaben === 'string' && input.vorhaben.trim()) { const v = await repo.finde(owner, input.vorhaben); l = l.filter(c => c.vorhabenId === v?.id); }
      return { success: true, data: l.map(c => ({ id: c.id, titel: c.title, status: c.status })), display: l.length ? l.map(c => `- **${c.title}** (${c.id.slice(0, 8)}) — ${c.status}, ${(c.schritte ?? []).length} Schritte${c.vorhabenId ? `, Vorhaben ${c.vorhabenId.slice(0, 8)}` : ''}`).join('\n') : 'Keine Changes mit Schritten.' };
    }
    if (action === 'change_zeigen') {
      const c = await ch.finde(owner, String(input.change ?? ''));
      if (!c) return { success: false, error: `Change „${String(input.change ?? '')}“ nicht gefunden` };
      return { success: true, data: c, display: c.schritte?.length ? changeAnzeige(c) : `${c.title} (${c.status}) — ohne Schritte` };
    }
    if (action === 'change_aendern') {
      const r = await ch.aendern(owner, String(input.change ?? ''), typeof input.plan === 'string' ? (() => { try { return JSON.parse(input.plan as string); } catch { return {}; } })() : input.plan);
      if (!r.ok) return { success: false, error: `Änderung nicht gespeichert:\n${r.fehler.map(x => `- ${x}`).join('\n')}` };
      return { success: true, data: { id: r.change.id, status: r.change.status }, display: `Change **${r.change.title}** geändert (Plan ${r.change.fingerabdruck?.slice(0, 12)}).${r.freigabeVerfallen ? ' Die bisherige Freigabe ist verfallen — neue Freigabe nötig.' : ''}` };
    }
    if (action === 'freigabe_anfragen') {
      const ids = (Array.isArray(input.ids) ? input.ids : Array.isArray(input.changes) ? input.changes : typeof input.change === 'string' ? [input.change] : []).map(x => typeof x === 'string' ? x : String((x as { id?: string })?.id ?? '')).filter(Boolean);
      if (!ids.length) return { success: false, error: 'ids (Change-IDs) angeben' };
      const r = await ch.freigabeAnfragen(owner, ids);
      return r.ok ? { success: true, display: r.text } : { success: false, error: r.fehler.join('\n') };
    }
    return { success: false, error: 'Unbekannte Aktion' };
  }

  private zeige(v: VorhabenDaten): string {
    const z = [`## ${v.titel}`, '', `**Ziel:** ${v.ziel}`, `**Status:** ${STATUS_TEXT[v.status]}`, `**Hosts:** ${v.hosts.join(', ')}`, `**ID:** ${v.id}`];
    if (v.bestandDocId) z.push(`**Bestandsbericht:** ${v.bestandDocId}`);
    if (v.architekturDocId) z.push(`**Architektur:** Version ${v.architekturVersion}, Dokument ${v.architekturDocId}`);
    if (v.entscheidungen.length) z.push('', '**Entscheidungen:**', ...v.entscheidungen.map(e => `- ${e.zeit.slice(0, 16).replace('T', ' ')} UTC · ${e.entscheidung} (Version ${e.architekturVersion}): „${e.wortlaut}“`));
    if (v.changeIds.length) z.push('', `**Changes:** ${v.changeIds.join(', ')}`);
    return z.join('\n');
  }
}
