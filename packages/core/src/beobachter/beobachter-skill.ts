import { Skill } from '@alfred/skills';
import type { SkillMetadata, SkillContext, SkillResult } from '@alfred/types';
import type { BeobachterDienst } from './dienst.js';

/**
 * v1429 R4a — Beobachter im Gespräch: „sag mir, wenn in Downloads eine Rechnung landet" → Regel am Server, die der Satellit
 * ausführt. Dieselben Regeln wie in App und Web (Schalter je Regel). Anlegen, Ein/Aus und Löschen ohne Bestätigung — die
 * Wirkungen selbst halten die Autonomie-Grenzen ein (Projekt-Wunsch nur mit Bestätigung).
 */
export class BeobachterSkill extends Skill {
  readonly metadata: SkillMetadata = {
    name: 'beobachter',
    category: 'automation',
    description: 'Beobachter auf den Geräten des Owners (Satelliten): Ordner, Systembenachrichtigungen (Windows/macOS) oder den Outlook-Posteingang (Windows) beobachten und bei Treffern etwas tun. ' +
      'quelle=ordner (pfad, muster, ereignisse) · benachrichtigung (apps = Liste der Apps, optional titel) · outlook (optional absender, betreff; nur Konten, die der Server nicht selbst liest) · build (projekt = Geräte-Projekt, intervallMin 15–1440; führt nur dessen freigegebene Prüfbefehle aus, meldet rot/wieder grün; wirkung projekt = Fix-Lauf mit Bestätigung). ' +
      'action=liste (Regeln mit Stand am Gerät) · anlegen (geraet, pfad = absoluter Ordner auf dem Gerät, muster z. B. "*.pdf", ereignisse neu|geaendert|geloescht, unterordner, ' +
      'wirkung hinweis|vorgang|aufgabe|projekt, auftrag = was Alfred tun soll (Pflicht bei aufgabe/projekt), projekt = Projektname bei wirkung projekt, name) · an · aus · loeschen (regel = Name oder Kennung). ' +
      'v1433: einmalig=true für „sag mir Bescheid, sobald …“ (nach dem ersten Treffer aus); bis=<ISO-Zeitpunkt> oder tage/stunden für „die nächsten 3 Tage“ (danach aus). ' +
      'action=geraet_art (geraet, quelle, an=true|false) schaltet eine Beobachtungsart auf einem Gerät ganz ein/aus. Alfreds eigene Mail (Mail-Skill, Mail-Regeln) ist davon unabhängig. ' +
      'Wirkung: hinweis = Meldung; vorgang = Vorgang mit nächstem Schritt; aufgabe = Alfred erledigt den Auftrag mit fester Werkzeugliste (Gerät, Aufgaben, Erinnerungen, Gedächtnis); projekt = Weiterarbeiten am Geräte-Projekt, immer mit Bestätigung. ' +
      'Der Satellit meldet nur Dateiname/Größe, nie Inhalte; am Gerät kann der Owner alle Beobachter abschalten.',
    riskLevel: 'write',
    version: '1.0.0',
    inputSchema: {
      type: 'object',
      properties: {
        action: { type: 'string', enum: ['liste', 'anlegen', 'an', 'aus', 'loeschen', 'geraet_art'] },
        einmalig: { type: 'boolean', description: 'v1433 — nach dem ersten Treffer abschalten' },
        bis: { type: 'string', description: 'v1433 — gilt bis (ISO-Zeitpunkt)' },
        tage: { type: 'number', description: 'v1433 — gilt so viele Tage ab jetzt' },
        stunden: { type: 'number', description: 'v1433 — gilt so viele Stunden ab jetzt' },
        an: { type: 'boolean', description: 'v1433 — geraet_art: einschalten (true) oder ausschalten (false)' },
        regel: { type: 'string', description: 'Name oder Kennung der Regel (an/aus/loeschen)' },
        geraet: { type: 'string', description: 'Gerätename (z. B. PC-madh, Ubuntu-VM)' },
        quelle: { type: 'string', enum: ['ordner', 'benachrichtigung', 'outlook', 'build'] },
        intervallMin: { type: 'number', description: 'Build-Wache: Minuten zwischen zwei Prüfungen (15–1440, Standard 60)' },
        pfad: { type: 'string', description: 'Absoluter Ordner auf dem Gerät (quelle ordner)' },
        apps: { type: 'array', items: { type: 'string' }, description: 'Apps (quelle benachrichtigung), z. B. WhatsApp' },
        titel: { type: 'string', description: 'Titel enthält (quelle benachrichtigung)' },
        absender: { type: 'string', description: 'Absender enthält (quelle outlook)' },
        betreff: { type: 'string', description: 'Betreff enthält (quelle outlook)' },
        muster: { type: 'string', description: 'Dateimuster, z. B. "*.pdf, Rechnung*"' },
        ereignisse: { type: 'array', items: { type: 'string', enum: ['neu', 'geaendert', 'geloescht'] } },
        unterordner: { type: 'boolean' },
        wirkung: { type: 'string', enum: ['hinweis', 'vorgang', 'aufgabe', 'projekt'] },
        auftrag: { type: 'string' },
        projekt: { type: 'string' },
        name: { type: 'string' },
      },
      required: ['action'],
    },
  };

  constructor(private readonly dienst: BeobachterDienst) { super(); }

  async execute(input: Record<string, unknown>, _context: SkillContext): Promise<SkillResult> {
    const action = String(input.action ?? 'liste');
    if (action === 'anlegen') return this.dienst.anlegen(input);
    if (action === 'geraet_art') return this.dienst.geraetArt(input); // v1433 B10
    const l = await this.dienst.liste();
    if (action === 'liste') {
      if (!l.regeln.length) return { success: true, data: l, display: 'Keine Beobachter angelegt.' };
      return { success: true, data: l, display: l.regeln.map((r, i) => `${i + 1}. ${r.aktiv ? '🟢' : '⚪'} ${r.name} — ${r.geraet}: ${r.quelle === 'ordner' ? String(r.filter.pfad) : r.quelle}${r.filter.muster ? ` (${String(r.filter.muster)})` : ''} → ${r.wirkung}${r.auftrag ? ` „${r.auftrag.slice(0, 60)}"` : ''} · ${r.stand}${r.standGrund ? ` (${r.standGrund})` : ''} · ${r.treffer ?? 0} Treffer`).join('\n') };
    }
    const q = String(input.regel ?? '').trim().toLowerCase();
    const passend = l.regeln.filter(r => r.id === q || r.id.startsWith(q) || r.name.toLowerCase() === q || r.name.toLowerCase().includes(q));
    if (!q || passend.length !== 1) return { success: false, error: passend.length > 1 ? `Mehrdeutig: ${passend.map(r => r.name).join(', ')}` : `Regel nicht gefunden (${l.regeln.map(r => r.name).join(', ') || 'keine Regeln'})` };
    if (action === 'an' || action === 'aus' || action === 'loeschen') return this.dienst.aendern(passend[0]!.id, { aktion: action });
    return { success: false, error: 'action muss liste, anlegen, an, aus oder loeschen sein' };
  }
}
