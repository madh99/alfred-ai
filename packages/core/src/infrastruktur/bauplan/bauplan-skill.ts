/**
 * Spec Bauplan- und Dokument-Vorlagen §5.5/§5.7 — Skill `bauplan`: Vorlagen speichern (voll validiert, neue Version), Freigabe
 * anfragen, freigeben (nur über das Owner-Ja auf die Button-Frage), widerrufen, anwenden (normale Changes + EINE Freigabe-Frage).
 * Das Modell wählt nur Vorlage, Parameter und Instanzname; alles andere entscheidet der Code.
 */
import { Skill } from '@alfred/skills';
import type { SkillMetadata, SkillContext, SkillResult } from '@alfred/types';
import type { BauplanDienst } from './bauplan-dienst.js';
import { EINGEBAUTE_VORLAGEN, eingebauteVorlage } from './vorlagen/index.js';

const AKTIONEN = ['bauplan_speichern', 'bauplan_liste', 'bauplan_zeigen', 'bauplan_freigabe_anfragen', 'bauplan_freigeben', 'bauplan_widerrufen', 'bauplan_anwenden', 'bauplan_ableiten'] as const;
/**
 * Wie NUR_HAUPTGESPRAECH im Infrastruktur-Skill: nie aus einem Unteragenten oder einem Change-Schritt. V4 — bauplan_ableiten gehört
 * dazu, auch im Modus vorschlag (liest Laufdaten der Changes).
 */
export const BAUPLAN_SCHREIBEND: readonly string[] = ['bauplan_speichern', 'bauplan_freigabe_anfragen', 'bauplan_freigeben', 'bauplan_widerrufen', 'bauplan_anwenden', 'bauplan_ableiten'];

/**
 * Fix-Runde 1 (M-1) — nach dem Owner-Ja auf eine Bauplan-Frage: feste Meldung, KEINE Modellrunde (sie könnte sonst von sich aus
 * bauplan_anwenden aufrufen). Wird in alfred.ts von setNachAusfuehrung genutzt.
 */
export function bauplanNachJa(result: { success?: boolean; display?: string; error?: string } | undefined): { meldung: string } {
  if (result?.success && result.display) return { meldung: `✓ ${result.display}\n\nAngewendet wird nur auf ausdrücklichen Auftrag.` };
  return { meldung: `✗ ${String(result?.error ?? 'Freigabe nicht übernommen')}` };
}

const text = (x: unknown): string => (typeof x === 'string' ? x.trim() : '');
const objekt = (x: unknown): Record<string, unknown> | undefined => (x && typeof x === 'object' && !Array.isArray(x) ? x as Record<string, unknown> : undefined);

export class BauplanSkill extends Skill {
  readonly metadata: SkillMetadata = {
    name: 'bauplan',
    category: 'infrastructure',
    description:
      'Bauplan-Vorlagen: wiederholbare Aufbauten als Paket normaler Changes mit Parametern (z. B. Test-Lab mit VLAN, Netz, VM). '
      + 'bauplan_speichern (vorlage = JSON-Objekt: schema 1, key, titel, zweck, dokumentart testprotokoll|betrieb, parameter, annahmen, changes; KEIN Feld version — '
      + 'ODER eingebaut = Schlüssel einer mitgelieferten Vorlage, z. B. pki_lab; dann kein JSON abschreiben) — '
      + 'prüft streng (Schema, Platzhalter, keine Geheimniswerte, Probe durch den Change-Validator) und speichert die nächste Version als Entwurf. '
      + 'bauplan_liste; bauplan_zeigen (key, optional version). '
      + 'bauplan_freigabe_anfragen (key) — stellt dem Owner die Button-Frage für die neueste Version. '
      + 'bauplan_freigeben ruft NUR die Bestätigung des Owners auf — nie selbst aufrufen. '
      + 'bauplan_widerrufen (key) — nur auf Wunsch des Owners. '
      + 'bauplan_anwenden (key, parameter = Objekt mit den Werten, instanz = neuer Name [A-Za-z0-9_.-]) — nur die neueste, freigegebene Version: '
      + 'prüft erneut, kontrolliert die Annahmen live, legt normale Changes an und stellt EINE Freigabe-Frage für das Paket. Nichts läuft ohne Owner-Ja. '
      + 'bauplan_ableiten — Vorlage aus erfolgreich ausgeführten (completed) Changes ableiten (changes = Liste von IDs oder eindeutigen Anfängen, höchstens 30): '
      + 'zuerst modus vorschlag (nur lesend: Kandidaten-Tabelle, Teilvorkommen mit ids, Verweise, Hinweise), dann modus erzeugen mit denselben changes, '
      + 'auswahl = Objekt Kandidaten-Nr → Parametername, teil = Objekt Teilvorkommen-id → "ersetzen"|"fest" (für jedes Teilvorkommen der gewählten Kandidaten), '
      + 'key, titel, zweck, dokumentart — speichert einen Entwurf (volle Prüfung); Freigabe danach nur über bauplan_freigabe_anfragen.',
    riskLevel: 'write',
    version: '1.0.0',
    inputSchema: {
      type: 'object',
      properties: {
        action: { type: 'string', enum: [...AKTIONEN] },
        vorlage: { type: 'object', description: 'bauplan_speichern: die Vorlage als JSON-Objekt (ohne version) — oder stattdessen eingebaut' },
        eingebaut: { type: 'string', enum: Object.keys(EINGEBAUTE_VORLAGEN), description: 'bauplan_speichern: Schlüssel einer mitgelieferten Vorlage, z. B. pki_lab (statt vorlage)' },
        key: { type: 'string', description: 'Schlüssel der Vorlage, z. B. pki_lab' },
        version: { type: 'number', description: 'bauplan_zeigen: Version (sonst die neueste)' },
        parameter: { type: 'object', description: 'bauplan_anwenden: Parameterwerte, z. B. {"vlan": 832, "netz": "10.203.32.0/28"}' },
        instanz: { type: 'string', description: 'bauplan_anwenden: Name der neuen Bauplan-Instanz, z. B. pki-lab-2026-11-20' },
        modus: { type: 'string', enum: ['vorschlag', 'erzeugen'], description: 'bauplan_ableiten: vorschlag (nur lesend) oder erzeugen (Entwurf speichern)' },
        changes: { type: 'array', items: { type: 'string' }, description: 'bauplan_ableiten: Change-IDs oder eindeutige Anfänge, z. B. ["2cfde1a2", "7335dfeb"]' },
        auswahl: { type: 'object', description: 'bauplan_ableiten erzeugen: Kandidaten-Nr → Parametername, z. B. {"5": "vlan", "12": "vmid_server"}' },
        teil: { type: 'object', description: 'bauplan_ableiten erzeugen: Teilvorkommen-id (aus dem Vorschlag) → "ersetzen" oder "fest"' },
        titel: { type: 'string', description: 'bauplan_ableiten erzeugen: Titel der neuen Vorlage' },
        zweck: { type: 'string', description: 'bauplan_ableiten erzeugen: Zweck der neuen Vorlage' },
        dokumentart: { type: 'string', enum: ['testprotokoll', 'betrieb'], description: 'bauplan_ableiten erzeugen: Dokumentart der neuen Vorlage' },
      },
      required: ['action'],
    },
  };

  constructor(private readonly dienst: BauplanDienst, private readonly d: { istOwner: (ctx: SkillContext) => boolean; owner: () => string | undefined }) { super(); }

  async execute(input: Record<string, unknown>, context: SkillContext): Promise<SkillResult> {
    const action = String(input.action ?? '');
    if (!(AKTIONEN as readonly string[]).includes(action)) return { success: false, error: `Unbekannte Aktion (${AKTIONEN.join(', ')})` };
    if (!this.d.istOwner(context)) return { success: false, error: 'Nur für den Owner.' };
    if ((context.unteragent === true || context.ausChange === true) && BAUPLAN_SCHREIBEND.includes(action)) return { success: false, error: `${action} läuft nur im Hauptgespräch (nicht im Unteragenten oder als Change-Schritt).` };
    const o = this.d.owner();
    if (!o) return { success: false, error: 'Kein Owner bekannt.' };
    const key = text(input.key);
    const braucheKey = (): SkillResult | undefined => (key ? undefined : { success: false, error: 'key: Schlüssel der Vorlage angeben' });
    try {
      switch (action) {
        case 'bauplan_speichern': {
          // Final-Welle I2 — genau eines: vorlage (Objekt/JSON) oder eingebaut (Schlüssel einer mitgelieferten Vorlage)
          const hatVorlage = input.vorlage !== undefined && input.vorlage !== null && input.vorlage !== '';
          const hatEingebaut = input.eingebaut !== undefined && input.eingebaut !== null && input.eingebaut !== '';
          if (hatVorlage === hatEingebaut) return { success: false, error: `genau eines angeben: vorlage (JSON-Objekt) oder eingebaut (${Object.keys(EINGEBAUTE_VORLAGEN).join(', ')})` };
          let roh: unknown = input.vorlage;
          if (hatEingebaut) {
            roh = typeof input.eingebaut === 'string' ? eingebauteVorlage(input.eingebaut.trim()) : undefined;
            if (roh === undefined) return { success: false, error: `eingebaut: keine mitgelieferte Vorlage „${String(input.eingebaut).slice(0, 40)}“ — vorhanden: ${Object.keys(EINGEBAUTE_VORLAGEN).join(', ')}` };
          }
          if (typeof roh === 'string') { try { roh = JSON.parse(roh); } catch { return { success: false, error: 'vorlage: kein gültiges JSON' }; } }
          if (!objekt(roh)) return { success: false, error: 'vorlage: JSON-Objekt der Vorlage angeben' };
          const r = await this.dienst.speichern(o, roh);
          if (!r.ok) return { success: false, error: `Nicht gespeichert:\n${r.fehler.map(f => `- ${f}`).join('\n')}` };
          return { success: true, data: { key: r.zeile.key, version: r.zeile.version, status: r.zeile.status, abdruck: r.zeile.abdruck }, display: `✅ Bauplan-Vorlage ${r.zeile.key} v${r.zeile.version} gespeichert (Entwurf, Abdruck ${r.zeile.abdruck.slice(0, 12)}). Anwenden erst nach der Owner-Freigabe (bauplan_freigabe_anfragen).${r.hinweise.length ? `\nHinweise: ${r.hinweise.join('; ')}` : ''}` };
        }
        case 'bauplan_liste': {
          const l = await this.dienst.liste(o);
          return { success: true, data: l, display: l.length ? l.map(v => `- **${v.titel}** (${v.key}) — v${v.version} ${v.status}${v.freigegebeneVersion ? ` · v${v.freigegebeneVersion} freigegeben (gilt nicht, neuere Version vorhanden)` : ''}`).join('\n') : 'Noch keine Bauplan-Vorlagen.' };
        }
        case 'bauplan_zeigen': {
          const k = braucheKey(); if (k) return k;
          const v = input.version === undefined || input.version === null || input.version === '' ? undefined : Number(input.version);
          if (v !== undefined && !Number.isInteger(v)) return { success: false, error: 'version: ganze Zahl' };
          const z = await this.dienst.zeigen(o, key, v);
          if (!z) return { success: false, error: `Bauplan-Vorlage ${key}${v ? ` v${v}` : ''} gibt es nicht` };
          let json = z.json;
          try { json = JSON.stringify(JSON.parse(z.json), null, 2); } catch { /* roh zeigen */ }
          return { success: true, data: { key: z.key, version: z.version, status: z.status, abdruck: z.abdruck, ...(z.grund ? { grund: z.grund } : {}) }, display: `**${z.key} v${z.version}** — ${z.status}${z.grund ? ` (${z.grund})` : ''}, Abdruck ${z.abdruck.slice(0, 12)}\n\`\`\`json\n${json.length > 12_000 ? `${json.slice(0, 12_000)}\n…` : json}\n\`\`\`` };
        }
        case 'bauplan_freigabe_anfragen': {
          const k = braucheKey(); if (k) return k;
          const r = await this.dienst.freigabeAnfragen(o, key);
          return r.ok ? { success: true, display: r.text } : { success: false, error: r.fehler.join('\n') };
        }
        case 'bauplan_freigeben': {
          // Nur über die Bestätigung: die Einmal-Freigabe steht nur in den Parametern des Buttons, in der DB nur ihr Hash
          const r = await this.dienst.freigebenNachJa(o, key, Number(input.version), input.freigabe);
          return r.ok ? { success: true, display: r.text } : { success: false, error: r.text };
        }
        case 'bauplan_widerrufen': {
          const k = braucheKey(); if (k) return k;
          const r = await this.dienst.widerrufen(o, key);
          return r.ok ? { success: true, display: r.text } : { success: false, error: r.fehler.join('\n') };
        }
        case 'bauplan_anwenden': {
          const k = braucheKey(); if (k) return k;
          const parameter = objekt(input.parameter) ?? (input.parameter === undefined ? {} : undefined);
          if (!parameter) return { success: false, error: 'parameter: Objekt mit den Parameterwerten' };
          const instanz = text(input.instanz);
          if (!instanz) return { success: false, error: 'instanz: Name der neuen Bauplan-Instanz angeben' };
          const r = await this.dienst.anwenden(o, key, parameter, instanz);
          return r.ok ? { success: true, data: { ids: r.ids, ...(r.instanzId ? { instanz: r.instanzId } : {}) }, display: r.text } : { success: false, error: `Nicht angewendet:\n${r.fehler.map(f => `- ${f}`).join('\n')}` };
        }
        case 'bauplan_ableiten': {
          const modus = text(input.modus);
          if (modus !== 'vorschlag' && modus !== 'erzeugen') return { success: false, error: 'modus: vorschlag oder erzeugen' };
          const changes = Array.isArray(input.changes) ? input.changes.map(c => text(c)).filter(Boolean)
            : typeof input.changes === 'string' ? input.changes.split(/[\s,]+/).filter(Boolean) : [];
          if (!changes.length) return { success: false, error: 'changes: Liste der Change-IDs (oder eindeutigen Anfänge) angeben' };
          if (modus === 'vorschlag') {
            const r = await this.dienst.ableitenVorschlag(o, changes);
            return r.ok
              ? { success: true, data: { kandidaten: r.kandidaten.length, verweise: r.verweise.length, hinweise: r.hinweise.length }, display: r.text }
              : { success: false, error: `Kein Vorschlag:\n${r.fehler.map(f => `- ${f}`).join('\n')}` };
          }
          const auswahlRoh = objekt(input.auswahl);
          if (!auswahlRoh || !Object.keys(auswahlRoh).length) return { success: false, error: 'auswahl: Objekt Kandidaten-Nr → Parametername (aus dem Vorschlag)' };
          const auswahl = Object.fromEntries(Object.entries(auswahlRoh).map(([k, v]) => [k, typeof v === 'string' ? v.trim() : v])) as Record<string, string>;
          const teil = objekt(input.teil) ?? (input.teil === undefined || input.teil === null ? {} : undefined);
          if (!teil) return { success: false, error: 'teil: Objekt Teilvorkommen-id → "ersetzen" oder "fest"' };
          const dokumentart = text(input.dokumentart);
          if (dokumentart !== 'testprotokoll' && dokumentart !== 'betrieb') return { success: false, error: 'dokumentart: testprotokoll oder betrieb' };
          const kopf: { key: string; titel: string; zweck: string; dokumentart: 'testprotokoll' | 'betrieb' } = { key, titel: text(input.titel), zweck: text(input.zweck), dokumentart };
          if (!kopf.key || !kopf.titel || !kopf.zweck) return { success: false, error: 'key, titel und zweck der neuen Vorlage angeben' };
          // teil geht unverändert an baueEntwurf — ungültige Entscheidungen meldet die Ableitung selbst
          const r = await this.dienst.ableitenErzeugen(o, changes, auswahl, kopf, teil as Record<string, 'ersetzen' | 'fest'>);
          return r.ok ? { success: true, display: r.text } : { success: false, error: `Nicht erzeugt (nichts gespeichert):\n${r.fehler.map(f => `- ${f}`).join('\n')}` };
        }
      }
    } catch (e) {
      return { success: false, error: (e as Error).message };
    }
    return { success: false, error: 'Unbekannte Aktion' };
  }
}
