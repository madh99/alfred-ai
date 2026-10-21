import { Skill } from '@alfred/skills';
import type { SkillMetadata, SkillContext, SkillResult } from '@alfred/types';
import type { Fernzugang } from '@alfred/storage';
import { Freigaben } from '../geraete/freigaben.js';
import { befehlsklasse, fernBefehl, leseKeyscan, knownHostsZeilen, gueltigerHost, gueltigerBenutzer, einrichtungsBefehle, normalisiereBefehl } from './regeln.js';
import type { SshErgebnis, SshZiel } from './ssh.js';

/**
 * v1539 (Owner 21.10. „ssh über cmdb plus skill fernzugriff, benutzer alfred mit sudo-rechten, er soll auch etwas machen können“).
 * Realfall 21.10.: „Hast du keinen SSH-Zugang auf den Host?“ — Alfred konnte `zpool status` auf pve nicht ausführen.
 *
 * Zugänge liegen in `fernzugaenge` (verknüpft mit dem CMDB-Eintrag); der private Schlüssel bleibt eine Datei auf dem Server.
 * Lesende Befehle (feste Liste) laufen ohne Rückfrage, alles andere nur nach dem Ja des Owners (Einmal-Freigabe, gebunden an
 * Zugang + Befehl), Zerstörerisches nie. Der Host-Schlüssel wird beim Anlegen gelesen und erst nach Bestätigung verwendet;
 * ändert er sich, wird der Zugang gesperrt.
 */
export interface FernzugriffRepo {
  liste(userId: string): Promise<Fernzugang[]>;
  finde(userId: string, nameOderHost: string): Promise<Fernzugang | null>;
  hole(userId: string, id: string): Promise<Fernzugang | null>;
  speichere(userId: string, e: { name: string; host: string; port: number; benutzer: string; schluesselPfad: string; hostSchluessel?: string; fingerabdruck?: string; cmdbAssetId?: string; status: Fernzugang['status'] }): Promise<Fernzugang>;
  setzeStatus(userId: string, id: string, status: Fernzugang['status']): Promise<void>;
  merkeErgebnis(userId: string, id: string, ok: boolean, fehler?: string): Promise<void>;
  entferne(userId: string, id: string): Promise<boolean>;
}

export interface FernzugriffDeps {
  repo: FernzugriffRepo;
  owner: () => string | undefined;
  istOwner: (ctx: SkillContext) => boolean;
  /** CMDB-Eintrag zum Namen (Host aus IP/Hostname) und Rückverweis auf den Zugang */
  cmdbFinde?: (name: string) => Promise<{ id: string; name: string; host?: string } | null>;
  cmdbMarkiere?: (assetId: string, zugang: { name: string; benutzer: string; port: number } | null) => Promise<void>;
  bestaetigung: (frage: { description: string; params: Record<string, unknown> }, herkunft?: { chatId: string; platform: string }) => Promise<boolean>;
  ssh: (ziel: SshZiel, befehl: string, timeoutMs?: number) => Promise<SshErgebnis>;
  keyscan: (host: string, port: number) => Promise<string>;
  schluessel: () => Promise<{ pfad: string; oeffentlich: string; neu: boolean }>;
  melde?: (text: string) => void;
  protokoll?: (msg: string, daten: Record<string, unknown>) => void;
}

const ANZEIGE_MAX = 6000;
const AKTIONEN = ['liste', 'schluessel', 'anlegen', 'pruefen', 'lesen', 'ausfuehren', 'entfernen', 'zugang_bestaetigen'] as const;

function kuerze(t: string, max = ANZEIGE_MAX): string {
  return t.length <= max ? t : `${t.slice(0, max)}\n… (${t.length - max} Zeichen gekürzt)`;
}

export class FernzugriffSkill extends Skill {
  readonly metadata: SkillMetadata = {
    name: 'fernzugriff',
    category: 'infrastructure',
    description:
      'SSH auf Hosts, die Alfred nicht selbst angelegt hat (z. B. Proxmox-Knoten pve, NAS), über hinterlegte Zugänge. ' +
      'liste: Zugänge. lesen: lesender Befehl (zpool status, pvecm status, qm list, df -h, free -h, journalctl -u …, systemctl status …, smartctl -a /dev/…) — läuft sofort. ' +
      'ausfuehren: jeder andere Befehl (Neustart eines Dienstes, zpool scrub, apt …) — fragt den Owner, läuft nach seinem Ja als root (sudo). Zerstörerisches (mkfs, zpool destroy, dd auf Datenträger …) nie. ' +
      'pruefen: Verbindung und sudo testen. anlegen: neuen Zugang (name, host oder CMDB-Name, benutzer alfred) — Host-Schlüssel wird gelesen und vom Owner bestätigt. ' +
      'schluessel: Alfreds öffentlichen Schlüssel und die Einrichtung auf dem Host zeigen. entfernen: Zugang löschen (mit Bestätigung).',
    riskLevel: 'write',
    version: '1.0.0',
    timeoutMs: 15 * 60_000,
    inputSchema: {
      type: 'object',
      properties: {
        action: { type: 'string', enum: [...AKTIONEN], description: 'liste | lesen | ausfuehren | pruefen | anlegen | schluessel | entfernen' },
        name: { type: 'string', description: 'Name des Zugangs (z. B. pve) oder sein Host' },
        befehl: { type: 'string', description: 'Shell-Befehl auf dem Host (lesen/ausfuehren)' },
        als_root: { type: 'boolean', description: 'ausfuehren: über sudo als root (Standard ja)' },
        host: { type: 'string', description: 'anlegen: IP oder Hostname (sonst aus dem CMDB-Eintrag)' },
        port: { type: 'number', description: 'anlegen: SSH-Port (Standard 22)' },
        benutzer: { type: 'string', description: 'anlegen: Benutzer auf dem Host (Standard alfred)' },
        timeout_s: { type: 'number', description: 'Zeitlimit in Sekunden (Standard 60, höchstens 900)' },
      },
      required: ['action'],
    },
  };

  private readonly freigaben = new Freigaben();

  constructor(private readonly deps: FernzugriffDeps) { super(); }

  /** v1537 — Vorschläge vor „Ausführen“ prüfen: Zugang und Befehl müssen angegeben sein. */
  pruefeEingabe(input: Record<string, unknown>): string | undefined {
    const a = String(input.action ?? '');
    if (['lesen', 'ausfuehren', 'pruefen', 'entfernen'].includes(a) && !(typeof input.name === 'string' && input.name.trim())) return `${a} braucht name (Zugang)`;
    if (['lesen', 'ausfuehren'].includes(a) && !(typeof input.befehl === 'string' && input.befehl.trim())) return `${a} braucht befehl`;
    return undefined;
  }

  async execute(input: Record<string, unknown>, context: SkillContext): Promise<SkillResult> {
    if (!this.deps.istOwner(context)) return { success: false, error: 'Fernzugriff ist nur für den Owner.' };
    const owner = this.deps.owner();
    if (!owner) return { success: false, error: 'Kein Owner bekannt.' };
    const action = String(input.action ?? 'liste');
    const herkunft = context.chatId && context.platform ? { chatId: context.chatId, platform: String(context.platform) } : undefined;
    try {
      switch (action) {
        case 'liste': return await this.liste(owner);
        case 'schluessel': return await this.schluesselZeigen();
        case 'anlegen': return await this.anlegen(owner, input, herkunft);
        case 'zugang_bestaetigen': return await this.zugangBestaetigen(owner, input);
        case 'pruefen': return await this.pruefen(owner, input);
        case 'lesen': return await this.lesen(owner, input);
        case 'ausfuehren': return await this.ausfuehren(owner, input, herkunft);
        case 'entfernen': return await this.entfernen(owner, input, herkunft);
        default: return { success: false, error: `Unbekannte Aktion „${action}“ (${AKTIONEN.filter(a => a !== 'zugang_bestaetigen').join(', ')})` };
      }
    } catch (err) {
      return { success: false, error: (err as Error).message.slice(0, 500) };
    }
  }

  private async liste(owner: string): Promise<SkillResult> {
    const l = await this.deps.repo.liste(owner);
    if (!l.length) return { success: true, data: [], display: 'Noch kein Fernzugang hinterlegt. Mit `schluessel` zeige ich meinen öffentlichen Schlüssel und die Einrichtung auf dem Host, danach `anlegen`.' };
    const zeilen = l.map(z => `- **${z.name}** ${z.benutzer}@${z.host}${z.port !== 22 ? `:${z.port}` : ''} · ${z.status === 'aktiv' ? 'aktiv' : z.status === 'wartet' ? 'wartet auf Bestätigung des Host-Schlüssels' : 'gesperrt'}${z.zuletztOk ? ` · zuletzt ok ${z.zuletztOk.slice(0, 16).replace('T', ' ')}` : ''}${z.zuletztFehler ? ` · Fehler: ${z.zuletztFehler.slice(0, 120)}` : ''}`);
    return { success: true, data: l.map(({ hostSchluessel: _h, ...rest }) => rest), display: zeilen.join('\n') };
  }

  private async schluesselZeigen(): Promise<SkillResult> {
    const k = await this.deps.schluessel();
    this.deps.protokoll?.('v1539 Fernzugriff-Schlüssel angezeigt', { neu: k.neu });
    return {
      success: true, data: { oeffentlich: k.oeffentlich, neu: k.neu },
      display: `${k.neu ? 'Neuen Schlüssel erzeugt. ' : ''}Mein öffentlicher Schlüssel für den Fernzugriff:\n\n\`\`\`\n${k.oeffentlich}\n\`\`\`\n\nEinrichtung auf dem Host (als root):\n\n\`\`\`\n${einrichtungsBefehle(k.oeffentlich)}\n\`\`\`\n\nDanach: „lege den Fernzugang <name> an“.`,
    };
  }

  private async anlegen(owner: string, input: Record<string, unknown>, herkunft?: { chatId: string; platform: string }): Promise<SkillResult> {
    const name = typeof input.name === 'string' ? input.name.trim() : '';
    if (!name || !/^[\w.-]{1,64}$/.test(name)) return { success: false, error: 'anlegen braucht einen Namen (Buchstaben, Ziffern, . _ -)' };
    const cmdb = await this.deps.cmdbFinde?.(name).catch(() => null) ?? null;
    const host = (typeof input.host === 'string' && input.host.trim()) || cmdb?.host || '';
    if (!host) return { success: false, error: `Kein Host für „${name}“: weder angegeben noch im CMDB-Eintrag (IP/Hostname).` };
    if (!gueltigerHost(host)) return { success: false, error: `Ungültiger Host „${host}“` };
    const port = typeof input.port === 'number' && input.port > 0 && input.port < 65536 ? Math.floor(input.port) : 22;
    const benutzer = typeof input.benutzer === 'string' && input.benutzer.trim() ? input.benutzer.trim() : 'alfred';
    if (!gueltigerBenutzer(benutzer)) return { success: false, error: `Ungültiger Benutzer „${benutzer}“` };
    const k = await this.deps.schluessel();
    const schluessel = leseKeyscan(await this.deps.keyscan(host, port));
    if (!schluessel.length) return { success: false, error: `Von ${host}:${port} kam kein Host-Schlüssel (SSH nicht erreichbar?).` };
    const z = await this.deps.repo.speichere(owner, { name, host, port, benutzer, schluesselPfad: k.pfad, hostSchluessel: knownHostsZeilen(host, port, schluessel), fingerabdruck: schluessel.map(s => `${s.typ} ${s.fingerabdruck}`).join(', '), cmdbAssetId: cmdb?.id, status: 'wartet' });
    const params = { action: 'zugang_bestaetigen', name: z.name, id: z.id, fingerabdruck: z.fingerabdruck };
    const nonce = this.freigaben.erzeuge('fernzugriff', 'zugang_bestaetigen', params);
    const ed = schluessel.find(s => s.typ === 'ssh-ed25519') ?? schluessel[0]!;
    const frage = [
      `🔑 Fernzugang „${z.name}“ anlegen: ${benutzer}@${host}${port !== 22 ? `:${port}` : ''}${cmdb ? ` (CMDB: ${cmdb.name})` : ''}.`,
      `Host-Schlüssel ${ed.typ}: ${ed.fingerabdruck}`,
      `Vergleichen auf dem Host: ssh-keygen -lf /etc/ssh/ssh_host_${ed.typ === 'ssh-ed25519' ? 'ed25519' : ed.typ.startsWith('ecdsa') ? 'ecdsa' : 'rsa'}_key.pub`,
      'Nach dem Ja gilt nur dieser Schlüssel; ändert er sich, sperre ich den Zugang.',
    ].join('\n');
    const gestellt = await this.deps.bestaetigung({ description: frage, params: { ...params, freigabe: nonce } }, herkunft);
    this.deps.protokoll?.('v1539 Fernzugang angelegt, Host-Schlüssel zur Bestätigung', { name: z.name, host, port, benutzer, fingerabdruck: ed.fingerabdruck, cmdb: cmdb?.id });
    return gestellt
      ? { success: true, data: { zurBestaetigung: true, name: z.name, fingerabdruck: ed.fingerabdruck }, display: `Zugang „${z.name}“ angelegt. Den Host-Schlüssel (${ed.fingerabdruck}) habe ich dir zur Bestätigung gestellt — erst danach verbinde ich mich.` }
      : { success: false, error: 'Bestätigung konnte nicht gestellt werden' };
  }

  private async zugangBestaetigen(owner: string, input: Record<string, unknown>): Promise<SkillResult> {
    const { freigabe, ...params } = input;
    if (!this.freigaben.verbrauche(freigabe, 'fernzugriff', 'zugang_bestaetigen', params)) return { success: false, error: 'Diese Bestätigung ist ungültig oder abgelaufen — Zugang neu anlegen.' };
    const z = await this.deps.repo.hole(owner, String(params.id ?? ''));
    if (!z || z.fingerabdruck !== params.fingerabdruck) return { success: false, error: 'Zugang nicht gefunden oder inzwischen verändert.' };
    await this.deps.repo.setzeStatus(owner, z.id, 'aktiv');
    if (z.cmdbAssetId) await this.deps.cmdbMarkiere?.(z.cmdbAssetId, { name: z.name, benutzer: z.benutzer, port: z.port }).catch(() => undefined);
    this.deps.protokoll?.('v1539 Fernzugang bestätigt', { name: z.name, host: z.host });
    const p = await this.pruefen(owner, { name: z.name });
    return { success: true, display: `✅ Fernzugang „${z.name}“ ist aktiv.\n${p.display ?? p.error ?? ''}` };
  }

  private async zugang(owner: string, input: Record<string, unknown>): Promise<Fernzugang> {
    const name = typeof input.name === 'string' ? input.name.trim() : '';
    if (!name) throw new Error('Welcher Zugang? (name)');
    const z = await this.deps.repo.finde(owner, name);
    if (!z) {
      const l = await this.deps.repo.liste(owner);
      throw new Error(`Kein Fernzugang „${name}“. ${l.length ? `Vorhanden: ${l.map(x => x.name).join(', ')}.` : 'Noch keiner hinterlegt — erst `schluessel`, dann `anlegen`.'}`);
    }
    if (z.status === 'wartet') throw new Error(`Der Host-Schlüssel von „${z.name}“ ist noch nicht bestätigt (offene Frage beim Owner).`);
    if (z.status === 'gesperrt') throw new Error(`Fernzugang „${z.name}“ ist gesperrt${z.zuletztFehler ? ` (${z.zuletztFehler.slice(0, 160)})` : ''} — neu anlegen, um den Host-Schlüssel erneut zu bestätigen.`);
    return z;
  }

  private async lauf(owner: string, z: Fernzugang, befehl: string, timeoutMs: number): Promise<SshErgebnis> {
    const r = await this.deps.ssh({ id: z.id, host: z.host, port: z.port, benutzer: z.benutzer, schluesselPfad: z.schluesselPfad, hostSchluessel: z.hostSchluessel }, befehl, timeoutMs);
    if (r.hostSchluesselGeaendert) {
      await this.deps.repo.setzeStatus(owner, z.id, 'gesperrt');
      await this.deps.repo.merkeErgebnis(owner, z.id, false, 'Host-Schlüssel hat sich geändert');
      this.deps.protokoll?.('v1539 Host-Schlüssel geändert — Zugang gesperrt', { name: z.name, host: z.host });
      this.deps.melde?.(`⚠️ Fernzugang „${z.name}“ (${z.host}) gesperrt: Der Host-Schlüssel hat sich geändert. Wenn der Host neu installiert wurde, den Zugang neu anlegen und den neuen Schlüssel bestätigen.`);
    } else {
      await this.deps.repo.merkeErgebnis(owner, z.id, r.code === 0, r.code === 0 ? undefined : r.stderr.trim().split('\n').slice(-2).join(' '));
    }
    return r;
  }

  private timeout(input: Record<string, unknown>): number {
    const s = typeof input.timeout_s === 'number' ? input.timeout_s : 60;
    return Math.min(Math.max(s, 5), 900) * 1000;
  }

  private ergebnis(z: Fernzugang, befehl: string, r: SshErgebnis): SkillResult {
    const aus = [r.stdout.trimEnd(), r.stderr.trim() ? `[stderr]\n${r.stderr.trim()}` : ''].filter(Boolean).join('\n');
    const kopf = `${z.name}$ ${befehl}${r.code !== 0 ? `  (Exit ${r.code})` : ''}`;
    return { success: r.code === 0, data: { name: z.name, befehl, code: r.code, stdout: r.stdout.slice(0, 200_000), stderr: r.stderr.slice(0, 20_000) }, display: `\`\`\`\n${kuerze(`${kopf}\n${aus || '(keine Ausgabe)'}`)}\n\`\`\``, ...(r.code !== 0 ? { error: r.hostSchluesselGeaendert ? 'Host-Schlüssel geändert — Zugang gesperrt' : `Exit ${r.code}: ${r.stderr.trim().slice(-300)}` } : {}) };
  }

  private async pruefen(owner: string, input: Record<string, unknown>): Promise<SkillResult> {
    const z = await this.zugang(owner, input);
    const a = await this.lauf(owner, z, 'hostname', 20_000);
    if (a.code !== 0) return { success: false, error: `Verbindung zu ${z.benutzer}@${z.host} fehlgeschlagen: ${a.stderr.trim().slice(-300)}${/Permission denied/i.test(a.stderr) ? ' — Schlüssel auf dem Host noch nicht eingetragen? (`schluessel` zeigt die Einrichtung)' : ''}` };
    const s = await this.lauf(owner, z, 'sudo -n true', 20_000);
    return { success: true, data: { hostname: a.stdout.trim(), sudo: s.code === 0 }, display: `Verbindung ok: ${a.stdout.trim()} (${z.benutzer}@${z.host}). sudo ohne Passwort: ${s.code === 0 ? 'ja' : 'nein — Befehle laufen dann ohne root'}.` };
  }

  /** Lesender Befehl: als root, wenn sudo ohne Passwort geht, sonst als Benutzer. */
  private async lesen(owner: string, input: Record<string, unknown>): Promise<SkillResult> {
    const befehl = typeof input.befehl === 'string' ? normalisiereBefehl(input.befehl) : '';
    const klasse = befehlsklasse(befehl);
    if (klasse !== 'lesen') return { success: false, error: klasse === 'nie' ? `„${befehl.slice(0, 120)}“ ist nie erlaubt.` : `„${befehl.slice(0, 120)}“ ist kein reiner Lesebefehl — mit action=ausfuehren stelle ich ihn dem Owner zur Bestätigung.` };
    const z = await this.zugang(owner, input);
    let r = await this.lauf(owner, z, fernBefehl(befehl, true), this.timeout(input));
    if (r.code !== 0 && /sudo: (a password is required|.*not allowed|.*may not run)/i.test(r.stderr)) r = await this.lauf(owner, z, befehl, this.timeout(input));
    this.deps.protokoll?.('v1539 Fernzugriff lesen', { name: z.name, befehl: befehl.slice(0, 200), code: r.code });
    return this.ergebnis(z, befehl, r);
  }

  private async ausfuehren(owner: string, input: Record<string, unknown>, herkunft?: { chatId: string; platform: string }): Promise<SkillResult> {
    const { freigabe, ...params } = input;
    const befehl = typeof params.befehl === 'string' ? normalisiereBefehl(params.befehl) : '';
    if (!befehl) return { success: false, error: 'ausfuehren braucht befehl' };
    const klasse = befehlsklasse(befehl);
    if (klasse === 'nie') {
      this.deps.protokoll?.('v1539 Fernzugriff abgewiesen (nie)', { name: params.name, befehl: befehl.slice(0, 200) });
      return { success: false, error: `„${befehl.slice(0, 120)}“ ist nie erlaubt (zerstört Datenträger, Pools oder das System). Das muss der Owner selbst am Host tun.` };
    }
    if (klasse === 'lesen') return this.lesen(owner, params);
    const z = await this.zugang(owner, params);
    const alsRoot = params.als_root !== false;
    const gebunden = { action: 'ausfuehren', name: z.name, befehl, als_root: alsRoot, ...(typeof params.timeout_s === 'number' ? { timeout_s: params.timeout_s } : {}) };
    if (freigabe !== undefined) {
      if (!this.freigaben.verbrauche(freigabe, 'fernzugriff', 'ausfuehren', gebunden)) return { success: false, error: 'Diese Freigabe ist ungültig, abgelaufen oder gehört zu einem anderen Befehl.' };
      const r = await this.lauf(owner, z, fernBefehl(befehl, alsRoot), this.timeout(params));
      this.deps.protokoll?.('v1539 Fernzugriff ausgeführt (bestätigt)', { name: z.name, befehl: befehl.slice(0, 200), code: r.code, root: alsRoot });
      return this.ergebnis(z, befehl, r);
    }
    const nonce = this.freigaben.erzeuge('fernzugriff', 'ausfuehren', gebunden);
    const frage = `🖥 Auf ${z.name} (${z.host}) ${alsRoot ? 'als root ' : ''}ausführen?\n\n${befehl.slice(0, 1500)}`;
    const gestellt = await this.deps.bestaetigung({ description: frage, params: { ...gebunden, freigabe: nonce } }, herkunft);
    this.deps.protokoll?.('v1539 Fernzugriff zur Bestätigung', { name: z.name, befehl: befehl.slice(0, 200), root: alsRoot });
    return gestellt
      ? { success: true, data: { zurBestaetigung: true, name: z.name, befehl }, display: `Zur Bestätigung an den Owner gestellt: \`${befehl.slice(0, 200)}\` auf ${z.name}. Nach dem Ja führe ich es aus und melde das Ergebnis.` }
      : { success: false, error: 'Bestätigung konnte nicht gestellt werden' };
  }

  private async entfernen(owner: string, input: Record<string, unknown>, herkunft?: { chatId: string; platform: string }): Promise<SkillResult> {
    const { freigabe, ...params } = input;
    const name = typeof params.name === 'string' ? params.name.trim() : '';
    const z = name ? await this.deps.repo.finde(owner, name) : null;
    if (!z) return { success: false, error: `Kein Fernzugang „${name}“.` };
    const gebunden = { action: 'entfernen', name: z.name };
    if (freigabe !== undefined) {
      if (!this.freigaben.verbrauche(freigabe, 'fernzugriff', 'entfernen', gebunden)) return { success: false, error: 'Diese Freigabe ist ungültig oder abgelaufen.' };
      await this.deps.repo.entferne(owner, z.id);
      if (z.cmdbAssetId) await this.deps.cmdbMarkiere?.(z.cmdbAssetId, null).catch(() => undefined);
      this.deps.protokoll?.('v1539 Fernzugang entfernt', { name: z.name });
      return { success: true, display: `Fernzugang „${z.name}“ entfernt. Auf dem Host bleibt der Benutzer ${z.benutzer} samt Schlüssel, bis du ihn dort löschst.` };
    }
    const nonce = this.freigaben.erzeuge('fernzugriff', 'entfernen', gebunden);
    const gestellt = await this.deps.bestaetigung({ description: `Fernzugang „${z.name}“ (${z.benutzer}@${z.host}) entfernen?`, params: { ...gebunden, freigabe: nonce } }, herkunft);
    return gestellt ? { success: true, data: { zurBestaetigung: true }, display: `Entfernen von „${z.name}“ zur Bestätigung gestellt.` } : { success: false, error: 'Bestätigung konnte nicht gestellt werden' };
  }
}
