/**
 * Jarvis Schicht 3 — Autonomie-Klassen je Aktion (Freigabe Owner 05.10.2026).
 *
 * `auto`        reversibel, risikoarm: Reminder setzen, Watch anlegen, Todo anlegen,
 *               Dokument ablegen, Notiz/Memory schreiben → tun und berichten.
 * `bestaetigen` Geld, extern sichtbar oder nicht rückgängig: E-Mail senden,
 *               Kalender ändern, Einkauf, Smart-Home-Schaltungen, Social, Infra-Schreibzugriffe.
 * `nie`         Konfigurations-Löschungen, Zahlungen, destruktive Shell-/DB-Befehle.
 *
 * Deterministisch und modellunabhängig: die Klasse hängt an Skill + Aktionswort,
 * nicht an der Formulierung des Modells. Unbekanntes ist `bestaetigen`.
 */
export type Autonomie = 'auto' | 'bestaetigen' | 'nie';

const LOESCH_WORTE = /^(delete|remove|rm|drop|purge|wipe|reset|destroy|clear|truncate|cancel_all|revoke)/i;
const ZAHLUNG_WORTE = /(pay|payment|buy|sell|order|purchase|transfer|withdraw|checkout|bezahl|kauf|überweis)/i;

const AUTO: Record<string, RegExp> = {
  reminder: /^(set|create|add|snooze|update)$/,
  todo: /^(create|add|complete|update|note|add_note)$/,
  note: /^(create|add|append|update)$/,
  memory: /^(save|set|store|remember|update)$/,
  watch: /^(create|add|enable|update|pause|resume)$/,
  document: /^(store|save|upload|add|tag)$/,
  insights: /^(dismiss|snooze|act)$/,
  goals: /^(add|update|check|checkpoint)$/,
  calendar: /^(list|get|search|find|free_slots|availability)$/,
};

const NIE: Record<string, RegExp | true> = {
  shell: /(rm\s|rmdir|mkfs|dd\s|shutdown|reboot|halt|kill\s|:\(\)\{|chmod\s+777|>\s*\/dev\/sd)/i,
  configure: /(delete|remove|reset|disable_service|revoke)/i,
  environments: /(delete|remove|rotate|reset)/i,
  database: /(drop|truncate|delete|alter)/i,
  bitpanda: /(buy|sell|order|withdraw|transfer)/i,
  trading: true,
  marketplace: /(buy|order|pay|bid)/i,
  cloudflare_dns: /(delete|remove)/i,
  nginx_proxy_manager: /(delete|remove)/i,
  proxmox: /(delete|destroy|remove|stop|shutdown|reboot)/i,
  unifi: /(delete|remove|block|forget|factory)/i,
  mikrotik: /(delete|remove|reset|reboot)/i,
  docker: /(rm|remove|prune|kill|down)/i,
  system_backup: /(delete|remove|restore)/i,
};

export function klassifiziereAktion(skillName: string, params: Record<string, unknown> | undefined): Autonomie {
  const skill = (skillName ?? '').toLowerCase();
  const aktion = String(params?.action ?? params?.command ?? params?.cmd ?? '').trim();
  const aktionL = aktion.toLowerCase();
  const text = `${aktionL} ${JSON.stringify(params ?? {}).toLowerCase()}`;

  const nie = NIE[skill];
  if (nie === true) return 'nie';
  if (nie && (nie.test(aktionL) || (skill === 'shell' && nie.test(text)))) return 'nie';
  if (LOESCH_WORTE.test(aktionL) && !['reminder', 'todo', 'note', 'watch', 'insights', 'memory'].includes(skill)) return 'nie';
  if (ZAHLUNG_WORTE.test(aktionL)) return 'nie';

  const auto = AUTO[skill];
  if (auto && (aktionL === '' ? skill === 'memory' : auto.test(aktionL))) return 'auto';
  return 'bestaetigen';
}

export type AusfuehrungsEntscheid = 'ausfuehren' | 'bestaetigen' | 'blockieren';

/**
 * v1180 — Durchsetzung: Die Autonomie-Klasse schlägt die Skill-Listen des Modells.
 * `nie` wird nie ausgeführt und nie zur Bestätigung gestellt (Owner macht es
 * selbst). `bestaetigen` geht immer in die Confirmation-Queue — auch wenn der
 * Skill bisher als „proaktiv" galt (Smart Home schalten, Kalender ändern).
 * `auto` läuft direkt, außer der Owner hat `confirm_all` gesetzt.
 */
export function entscheideAusfuehrung(klasse: Autonomie, autonomyLevel: 'confirm_all' | 'proactive' | 'autonomous'): AusfuehrungsEntscheid {
  if (klasse === 'nie') return 'blockieren';
  if (klasse === 'bestaetigen') return 'bestaetigen';
  return autonomyLevel === 'confirm_all' ? 'bestaetigen' : 'ausfuehren';
}

const HANDLUNGS_WORTE = /\b(prüfen|prüfe|kontrollieren|tauschen|austauschen|ersetzen|kaufen|besorgen|bestellen|erneuern|verlängern|bezahlen|überweisen|anrufen|kontaktieren|melden|planen|buchen|reservieren|vereinbaren|absagen|verschieben|laden|aufladen|nachfüllen|sichern|aktualisieren|updaten|neu starten|neustarten|einstellen|aktivieren|deaktivieren|freigeben|entscheiden|beantragen|einreichen|abholen|zurückgeben)\b/i;
const INFO_MARKER = /\b(NORMAL|kein Handlungsbedarf|zur Info|FYI|informativ|keine Aktion)\b/i;

/** v1180 — Insight mit Handlungsimplikation (wird Vorgang) vs. reine Information (bleibt Insight mit Ablauf). */
export function istHandlungsInsight(text: string): boolean {
  if (INFO_MARKER.test(text)) return false;
  return HANDLUNGS_WORTE.test(text) || /→\s*[A-ZÄÖÜa-zäöü]/.test(text) && /⚠️|❗|🚨|HIGH|URGENT|dringend/i.test(text);
}

/** Kurzer Titel aus einem Insight-Text (erste Zeile, ohne Nummerierung/Markdown). */
export function vorgangTitelAus(insight: string): string {
  return insight.split('\n')[0].replace(/^\s*\d+\.\s*/, '').replace(/\*\*/g, '').replace(/\[(?:HIGH|URGENT|NORMAL|LOW|MEDIUM|KRITISCH|DRINGEND)\]\s*/gi, '').replace(/^[^\p{L}\p{N}]+/u, '').trim().slice(0, 160);
}

export function autonomieText(a: Autonomie): string {
  return a === 'auto' ? 'automatisch (reversibel, risikoarm)' : a === 'nie' ? 'nie automatisch (Löschung/Zahlung/destruktiv)' : 'nur mit Bestätigung';
}
