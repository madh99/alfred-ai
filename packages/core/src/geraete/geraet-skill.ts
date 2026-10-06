import { Skill } from '@alfred/skills';
import type { SkillMetadata, SkillContext, SkillResult, GeraetManifest, GeraetAktionDef } from '@alfred/types';
import { paramsKurz } from './protokoll.js';

/**
 * v1224 — Skill-Proxy: ein verbundenes Gerät erscheint im Gehirn als Skill `geraet_<name>`.
 * `execute` leitet an das Gerät weiter. Autonomie kommt aus dem Manifest: `bestaetigen`
 * geht in die Bestätigungs-Queue (Owner-Button), `nie` wird abgewiesen, `auto` läuft sofort.
 * Jede Ausführung wird als Schritt im Ausführungsgedächtnis protokolliert (Quelle `geraet`).
 */
export interface GeraetSkillDeps {
  geraetId: string;
  name: string;
  manifest: GeraetManifest;
  skillName: string;
  sendeAktion: (aktion: string, params: Record<string, unknown>, timeoutMs?: number) => Promise<{ success: boolean; data?: unknown; display?: string; error?: string; dauerMs: number }>;
  /** Reiht die Frage beim Owner ein; die Queue erhält Parameter mit einer Einmal-Freigabe (v1225). */
  bestaetigung: (frage: { description: string; aktion: string; params: Record<string, unknown> }) => Promise<boolean>;
  /** v1225 — prüft und verbraucht die Einmal-Freigabe aus den Parametern der Bestätigungs-Queue. */
  pruefeFreigabe: (nonce: unknown, aktion: string, params: Record<string, unknown>) => boolean;
  schritt?: (s: { art: 'ausgefuehrt' | 'fehlgeschlagen' | 'zur_bestaetigung' | 'blockiert'; aktion: string; params: Record<string, unknown>; beschreibung: string; ergebnis?: string; autonomie: GeraetAktionDef['autonomie'] }) => Promise<void>;
}

export class GeraetSkill extends Skill {
  readonly metadata: SkillMetadata;

  constructor(private readonly deps: GeraetSkillDeps) {
    super();
    const aktionen = deps.manifest.aktionen;
    const params: Record<string, unknown> = {
      action: { type: 'string', enum: aktionen.map(a => a.name), description: 'Aktion auf dem Gerät: ' + aktionen.map(a => `${a.name} (${a.autonomie}): ${a.beschreibung}`).join(' | ') },
    };
    for (const a of aktionen) for (const [k, p] of Object.entries(a.parameter ?? {})) if (!params[k]) params[k] = { type: p.type, description: p.description ?? `${k} (für ${a.name})` };
    this.metadata = {
      name: deps.skillName,
      category: 'core',
      description: `Gerät „${deps.name}" (${deps.manifest.plattform}) des Owners — Alfred handelt DORT, nicht auf dem Server. Aktionen: ${aktionen.map(a => a.name).join(', ')}. Verändernde Aktionen fragen den Owner vorher (Bestätigung per Button); melde dann nur „zur Bestätigung gestellt". Nutze dieses Gerät, wenn der Owner „auf meinem PC/Mac/Rechner/Laptop" oder den Gerätenamen nennt.`,
      riskLevel: 'write',
      version: '1.0.0',
      timeoutMs: 11 * 60_000,
      inputSchema: { type: 'object', properties: params, required: ['action'] },
    };
  }

  async execute(input: Record<string, unknown>, _context: SkillContext): Promise<SkillResult> {
    const aktion = String(input.action ?? '');
    const def = this.deps.manifest.aktionen.find(a => a.name === aktion);
    if (!def) return { success: false, error: `Unbekannte Aktion „${aktion}" auf ${this.deps.name}. Verfügbar: ${this.deps.manifest.aktionen.map(a => a.name).join(', ')}` };
    const params: Record<string, unknown> = { ...input };
    // v1225 — Sicherheitsbefund: `confirmed: true` konnte auch das Modell setzen. Jetzt zählt nur eine
    // Einmal-Freigabe, die das Gehirn beim Einreihen erzeugt hat und die an Aktion + Parameter gebunden ist.
    const freigabe = params.freigabe;
    delete params.freigabe;
    delete params.confirmed;
    const bestaetigt = this.deps.pruefeFreigabe(freigabe, aktion, params);
    const beschreibung = `Auf ${this.deps.name}: ${aktion} ${paramsKurz(params)}`.trim();

    if (def.autonomie === 'nie') {
      await this.deps.schritt?.({ art: 'blockiert', aktion, params, beschreibung, ergebnis: 'Autonomie-Klasse nie', autonomie: 'nie' });
      return { success: false, error: `„${aktion}" auf ${this.deps.name} ist für Alfred gesperrt (Autonomie: nie) — nur der Owner selbst.` };
    }
    if (def.autonomie === 'bestaetigen' && !bestaetigt) {
      const gestellt = await this.deps.bestaetigung({ description: beschreibung, aktion, params });
      await this.deps.schritt?.({ art: 'zur_bestaetigung', aktion, params, beschreibung, autonomie: 'bestaetigen' });
      return gestellt
        ? { success: true, data: { zurBestaetigung: true, geraet: this.deps.name, aktion }, display: `Zur Bestätigung an den Owner gestellt: ${beschreibung}. Nach Freigabe wird es auf dem Gerät ausgeführt.` }
        : { success: false, error: 'Bestätigung konnte nicht gestellt werden (keine Bestätigungs-Queue)' };
    }
    const r = await this.deps.sendeAktion(aktion, params, aktion === 'shell' ? 10 * 60_000 : undefined);
    await this.deps.schritt?.({ art: r.success ? 'ausgefuehrt' : 'fehlgeschlagen', aktion, params, beschreibung, ergebnis: r.success ? (r.display ?? JSON.stringify(r.data ?? null)).slice(0, 300) : (r.error ?? '').slice(0, 300), autonomie: def.autonomie });
    return r.success
      ? { success: true, data: r.data, display: r.display ?? `${beschreibung} — ausgeführt (${r.dauerMs} ms)` }
      : { success: false, error: r.error ?? 'Gerät meldete Fehler' };
  }
}
