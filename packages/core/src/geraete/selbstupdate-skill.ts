import { Skill } from '@alfred/skills';
import type { SkillMetadata, SkillContext, SkillResult } from '@alfred/types';
import type { Selbstupdate, UpdateQuelle } from './selbstupdate.js';

/**
 * v1266 — Skill `selbstupdate`: „Alfred, aktualisiere dich". Prüfen zeigt laufende Version, Eingang und npm-Tags;
 * aktualisieren stellt die Frage an den Owner (Bestätigungs-Queue mit Einmal-Freigabe) und startet nach dem Ja den
 * Ablauf aus `Selbstupdate`. Status zeigt den laufenden Vorgang.
 */
export interface SelbstupdateSkillDeps {
  update: Selbstupdate;
  bestaetigung: (frage: { description: string; params: Record<string, unknown> }) => Promise<boolean>;
}

export class SelbstupdateSkill extends Skill {
  readonly metadata: SkillMetadata = {
    name: 'selbstupdate',
    category: 'core',
    description: 'Alfred aktualisiert seine eigene Server-Software („aktualisiere dich", „gibt es ein Update", „welche Version läuft"). pruefen: laufende Version, bereitliegende Tarballs im Eingang, npm-Tags. aktualisieren: fragt den Owner (Button) und installiert danach die Version, startet außerhalb des Pass-Fensters neu und fällt bei Fehlschlag auf die vorige zurück. status: laufender Vorgang.',
    riskLevel: 'write',
    version: '1.0.0',
    timeoutMs: 60_000,
    inputSchema: {
      type: 'object',
      properties: {
        action: { type: 'string', enum: ['pruefen', 'aktualisieren', 'status'], description: 'pruefen | aktualisieren | status' },
        quelle: { type: 'string', enum: ['datei', 'registry'], description: 'datei: Tarball im Eingang (Standard); registry: npm-Register' },
        version: { type: 'string', description: 'Gewünschte Version (sonst die neueste im Eingang bzw. der Tag)' },
        tag: { type: 'string', description: 'npm-Tag für quelle=registry (z. B. multi-ha)' },
      },
      required: ['action'],
    },
  };

  constructor(private readonly deps: SelbstupdateSkillDeps) { super(); }

  async execute(input: Record<string, unknown>, _context: SkillContext): Promise<SkillResult> {
    const action = String(input.action ?? 'pruefen');
    const quelle: UpdateQuelle = input.quelle === 'registry'
      ? { art: 'registry', tag: typeof input.tag === 'string' ? input.tag : undefined, version: typeof input.version === 'string' ? input.version : undefined }
      : { art: 'datei', version: typeof input.version === 'string' ? input.version : undefined };

    if (action === 'status') {
      const l = this.deps.update.status();
      return { success: true, data: l ?? null, display: l ? `Update auf ${l.version} aus ${l.quelle}: Phase ${l.phase}${l.hinweis ? ` (${l.hinweis})` : ''}, seit ${new Date(l.seit).toLocaleTimeString('de-AT', { hour: '2-digit', minute: '2-digit' })}` : 'Kein Update in Arbeit.' };
    }

    if (action === 'pruefen') {
      const u = await this.deps.update.uebersicht(input.quelle === 'registry' || input.tag !== undefined);
      const zeilen = [`Läuft: ${u.laufend}${u.starter ? ' (über Starter)' : ''}`];
      if (u.installiert) zeilen.push(`Installiert: ${u.installiert.version}${u.installiert.bestaetigt ? ' bestätigt' : ' auf Probe'}${u.installiert.vorige ? `, vorige ${u.installiert.vorige}` : ''}`);
      zeilen.push(u.eingang.length ? `Eingang: ${u.eingang.map(e => `${e.version}${e.neuer ? ' (neuer)' : ''}${e.sha256Datei ? '' : ' ohne Prüfsumme'}`).join(', ')}` : 'Eingang: leer');
      if (u.registry) zeilen.push(`npm-Tags: ${Object.entries(u.registry).map(([t, v]) => `${t}=${v}`).join(', ')}`);
      if (u.lauf) zeilen.push(`In Arbeit: ${u.lauf.version} (${u.lauf.phase})`);
      return { success: true, data: u, display: zeilen.join('\n') };
    }

    if (action === 'aktualisieren') {
      const version = typeof input.version === 'string' ? input.version : undefined;
      // Nach dem Owner-Ja kommt die Queue mit der Einmal-Freigabe zurück
      const freigegeben = version ? this.deps.update.verbraucheFreigabe(input.freigabe, version) : undefined;
      if (freigegeben && version) {
        const l = this.deps.update.starte(freigegeben, version);
        return { success: true, data: l, display: `Update auf ${version} gestartet: prüfen, installieren, Startprobe, dann Neustart außerhalb des Pass-Fensters. Ich melde mich nach dem Neustart.` };
      }
      const k = await this.deps.update.kandidat(quelle);
      const nonce = this.deps.update.erzeugeFreigabe(k.version, k.quelle);
      const frage = `Alfred aktualisieren: ${this.deps.update.status()?.phase === 'warten' ? 'nach dem laufenden Vorgang ' : ''}${k.version} aus ${k.beschreibung}. Neustart außerhalb des Pass-Fensters, Rückfall bei Fehlschlag.`;
      const gestellt = await this.deps.bestaetigung({ description: frage, params: { action: 'aktualisieren', quelle: k.quelle.art, version: k.version, tag: (k.quelle as { tag?: string }).tag, freigabe: nonce } });
      return gestellt
        ? { success: true, data: { zurBestaetigung: true, version: k.version }, display: `Zur Bestätigung an den Owner gestellt: Update auf ${k.version} (${k.beschreibung}). Nach seinem Ja installiere ich und starte außerhalb des Pass-Fensters neu.` }
        : { success: false, error: 'Bestätigung konnte nicht gestellt werden' };
    }
    return { success: false, error: `Unbekannte Aktion „${action}"` };
  }
}
