import type { SkillCategory, SkillMetadata } from '@alfred/types';

// Regex-based keyword map per category.
// 'core' is always active and not listed here.
// NOTE: Use \w* suffix on keywords to match plurals and compound forms (Rezept→Rezepte, Hotel→Hotels, Flug→Flüge etc.)
// Without \w*, \b(rezept)\b does NOT match "Rezepte" — causing FALLBACK (all 43 skills, ~13K tokens).
const CATEGORY_KEYWORDS: Record<Exclude<SkillCategory, 'core'>, RegExp> = {
  productivity: /\b(todos?\w*|notes?\w*|notiz\w*|remind\w*|erinner\w*|calend\w*|kalender\w*|termin\w*|events?\w*|e?-?mail\w*|kontakt\w*|contact\w*|briefing\w*|einkauf\w*|shopping\w*|liste\w*|rezept\w*|koch\w*|zutat\w*|küche\w*|meals?\w*|mahlzeit\w*|frühstück\w*|mittag\w*|abendessen\w*|wochenplan\w*|diät\w*|ernähr\w*|nährwert\w*|vegetari\w*|vegan\w*|reis\w{2,}|flug\w*|flüge\w*|hotels?\w*|urlaub\w*|reiseplan\w*|packli\w*|mietwag\w*|buch\w{3,}|barcelona|lissabon|airport\w*|flughafen\w*)\b/i,
  information:  /\b(search\w*|such\w*|weather|wetter\w*|calculat\w*|rechn\w*|time|date|zeit\w*|datum|uhrzeit|system.?info|transit\w*|bahn\w*|zug\w*|bus\w*|tram|u.?bahn|s.?bahn|abfahrt\w*|verbindung\w*|haltestell\w*|öffi\w*|fahrplan\w*|rout\w*|fahrzeit\w*|anfahrt|heimfahrt|fahrt\w*|navig\w*|navi|strom\w*|energy|preis\w*|price\w*|kwh|awattar|marktpreis\w*|spot|günstig\w*|cheapest|netzentgelt\w*|rss|feed\w*|atom|news|nachricht\w*|schlagzeil\w*|headline\w*|interesse\w*|themen?\w*|topics?\w*|dossier\w*|beobacht\w*|entwicklung\w*|youtube|video\w*|transkript\w*|transcript\w*|channel|kanal\w*|zusammenfass\w*|crypto\w*|krypto\w*|bitcoin|btc|ethereum|eth|coin\w*|token|blockchain|solana|cardano|altcoin\w*|market.?cap|bitpanda|portfolio\w*|aktie\w*|stock\w*|etf|gold|silber|metall\w*|depot|holding\w*|trad\w{2,}|exchange\w*|binance|kraken|coinbase|order\w*|limit.?order|kauf\w*|verkauf\w*|preisvergleich\w*|geizhals\w*|produkt\w*|notebook\w*|laptop\w*|smartphone\w*|handy\w*|fernseh\w*|grafikkart\w*|gpu\w*|cpu\w*|prozessor\w*|monitor\w*|ssd\w*|festplatt\w*|kopfhörer\w*|tablet\w*|smartwatch\w*|staubsaug\w*|waschmaschine\w*|kühlschrank\w*|kaffeemaschine\w*)\b/i,
  media:        /\b(voice\w*|stimme\w*|tts|speak\w*|sprech\w*|sprich\w*|spiel\w*|durchsage\w*|ansage\w*|vorlesen\w*|klonen\w*|clone\w*|screenshot\w*|clipboard|zwischenablage|icons?\w*|logos?\w*|grafik\w*|entwerf\w*|entw(u|ü)rf\w*|design\w*|zeichn\w*|brows\w*|öffne\w*|webseite\w*|website\w*|seite\w*|url|bild\w*|image\w*|generier\w*|photo\w*|foto\w*|spotify\w*|musik\w*|music\w*|songs?\w*|tracks?\w*|artists?\w*|albums?\w*|playlists?\w*|wiedergab\w*|abspiel\w*|pause\w*|skip\w*|lautstärke\w*|volume\w*|shuffle|repeat|sonos\w*|speaker\w*|lautsprech\w*|gruppier\w*|raum\w*|radio\w*|tunein|sleep.?timer|nachtmodus|stereo|halle|küche|wohnzimmer|schlafzimmer|bad)\b/i,
  // automation: shell/code-agent/script keywords select category but DON'T trigger superset.
  // Only watch/schedule keywords (in SUPERSET_KEYWORDS below) trigger the cross-category superset.
  // v945: +social\w*|post\w*|… — der social-Skill (Kategorie automation) wurde sonst
  // gefiltert, sobald die Nachricht nur „Kanal/News"-Wörter enthielt (→ information):
  // Realfall 03.07. „Nutze den social-Skill … update_channel" → „Skill nicht in Tool-Liste".
  automation:   /\b(background\w*|hintergrund\w*|shell\w*|bash|cron\w*|schedul\w*|code.?agent\w*|project.?agent\w*|projekt\w*|etapp\w*|abnahme\w*|claude.?code\w*|programmier\w*|entwickl\w*|kommandozeilen\w*|sandbox\w*|automat\w*|watch\w*|alert\w*|benachrichtig\w*|bescheid\w*|meld\w*|überwach\w*|script\w*|skript\w*|befehl\w*|kommando\w*|social\w*|posts?\w*|poste\w*|veröffentlich\w*|publish\w*|instagram\w*|facebook|threads|bluesky\w*|tiktok\w*|tweet\w*|twitter|drafts?\w*|entw(u|ü)rf\w*|freigeb\w*|freigabe\w*|content\w*|studio\w*|hashtag\w*|kommentar\w*|comments?|reels?\w*|shorts?\w*|stor(y|ies)\w*|config\w*|generate\w*|netzbetreiber\w*|smart.?meter\w*|energiegemeinschaft\w*|zählpunkt\w*|\beeg\b|tägliche?r?s?|stündliche?r?s?|wöchentliche?r?s?|monatliche?r?s?|jeden\s+(tag|morgen|abend|montag|dienstag|mittwoch|donnerstag|freitag|samstag|sonntag)|um\s+\d{1,2}\s*(uhr|:|h)|alle\s+\d+\s*(min|stund|sekund)|in\s+\d+\s*(minuten?|stunden?|sekunden?|hours?|minutes?|seconds?|min)|daily|hourly|weekly|every\s+(day|hour|morning|evening|night|\d+\s*min)|führ\w*aus|execut\w*|ausführ\w*)\b/i,
  files:        /\b(files?\w*|datei\w*|dokument\w*|document\w*|pdfs?\w*|https?\w*|download\w*|upload\w*|herunterlad\w*|herunter\w*|hochlad\w*|anhäng\w*|anhang\w*|attachment\w*|onedrive\w*|cloud.?speicher\w*|cloud.?drive\w*|sharepoint\w*|ablage\w*|verzeichnis\w*)\b/i,
  // Fix A: removed clone\w*, klone?\w*, template\w*, regel\w*, npm\w* (all redundant with proxmox/vm/lxc/firewall/nginx/proxy)
  // Fix C: added monitor\w* so MonitorSkill is reachable without superset trigger
  infrastructure: /\b(backup\w*|restore\w*|sicher\w*|wiederherstell\w*|commvault\w*|media.?agent\w*|storage.?pool\w*|backup.?job\w*|sla\w*|recovery.?point\w*|mikrotik\w*|routeros\w*|torch\w*|traceroute\w*|dhcp.?lease\w*|nat.?rule\w*|proxmox\w*|vms?\w*|container\w*|docker\w*|unifi\w*|wifi|wlan\w*|netzwerk\w*|network\w*|homeassistant|home.?assistant|smarthome|smart.?home|licht\w*|light\w*|schalter\w*|switch\w*|solar\w*|photovoltaik\w*|pv|wechselrichter\w*|inverter\w*|batterie.?speicher\w*|wallbox\w*|energieverbrauch\w*|stromverbrauch\w*|verbrauch\w{0,10}kwh|einspeis\w*|netzeinspeis\w*|autarkie\w*|eigenverbrauch\w*|bmw|auto\w*|fahrzeug\w*|ladestand\w*|reichweite\w*|laden(?!e)\w*|charging\w*|vehicle\w*|soc|ladehistori\w*|ladesession\w*|ladevorgang\w*|ladezyklus\w*|ladekurve\w*|km|kilometer\w*|mileage|tachostand\w*|charger\w*|ladest\w*|go.?e\w*|database\w*|datenbank\w*|sql\w*|query\w*|tabell\w*|table\w*|schema\w*|postgres\w*|mysql\w*|mariadb|mongodb|mongo\w*|influx\w*|redis|mssql|select\w*|insert\w*|verbindung\w{0,5}db|mqtt\w*|zigbee\w*|sensor\w*|temperatur\w*|luftfeucht\w*|tasmota\w*|shelly\w*|esphome\w*|cmdb\w*|inventar\w*|asset\w*|topologi\w*|discovery\w*|entdeck\w*|itsm\w*|incident\w*|change.?request\w*|service.?katalog\w*|postmortem\w*|runbook\w*|health.?check\w*|impact.?analy\w*|infra.?doc\w*|dokumentation\w*|cloudflare\w*|dns\w*|zon\w*|record\w*|subdomain\w*|nameserver\w*|nginx\w*|proxy\w*|reverse.?proxy\w*|ssl\w*|zertifikat\w*|certific\w*|lets.?encrypt|pfsense\w*|firewall\w*|rule\w*|vlan\w*|gateway\w*|dhcp\w*|arp\w*|deploy\w*|rollback\w*|setup.?node|setup.?python|infra\w*|server\w*|host\w*|lxc\w*|ssh\w*|monitor\w*|fernzugriff\w*|fernzugang\w*|bestandsaufnahme\w*|bestand|architektur\w*|migrier\w*|migration\w*|zpool\w*|zfs|pvecm\w*|journalctl\w*|systemctl\w*|smartctl\w*|sudo)\b/i, // v1539 Fernzugriff
  identity:     /\b(link\w*|verknüpf\w*|cross.?platform|identity\w*|identität\w*|user\w*|benutzer\w*|nutzer\w*|rolle\w*|role\w*|invite\w*|einlad\w*|connect\w*|verbinde?\w*|whoami|wer\s+bin\s+ich|profil\w*|registrier\w*|onboard\w*|deaktiv\w*|aktivier\w*|einrichte?\w*|richte?\s+.*\s+ein|konfigur\w*|setup.?service|postfach\w*|account\w*|microsoft|outlook|o365|office.?365|auth.?microsoft|matrix|telegram|whatsapp|discord|signal|schick\w*\s+.*\s+(auf|per|via|über)|sende\w*\s+.*\s+(auf|per|via|über)|nachricht\w*\s+an)/i,
  mcp:          /\bmcp\b/i,
};

// Fix B: Only watch/schedule/background keywords trigger the cross-category superset.
// Shell, code-agent, script, befehl, automat etc. select automation but DON'T need all categories.
const SUPERSET_KEYWORDS = /\b(watch\w*|überwach\w*|alert\w*|benachrichtig\w*|bescheid\w*|meld\w*|background\w*|hintergrund\w*|cron\w*|schedul\w*|tägliche?r?s?|stündliche?r?s?|wöchentliche?r?s?|monatliche?r?s?|jeden\s+(tag|morgen|abend|montag|dienstag|mittwoch|donnerstag|freitag|samstag|sonntag)|um\s+\d{1,2}\s*(uhr|:|h)|alle\s+\d+\s*(min|stund|sekund)|in\s+\d+\s*(minuten?|stunden?|sekunden?|hours?|minutes?|seconds?|min)|daily|hourly|weekly|every\s+(day|hour|morning|evening|night|\d+\s*min))\b/i;

/**
 * Determine which skill categories are relevant for a given message.
 * 'core' is always included. If no keywords match, common categories are returned
 * as a safe fallback (heavy categories like infrastructure/identity only on keyword match).
 */
export function selectCategories(
  message: string,
  availableCategories: Set<SkillCategory>,
): Set<SkillCategory> {
  return waehleKategorien(message, availableCategories, true)!;
}

/** v1300 — wie selectCategories, aber ohne Rückfall: undefined, wenn kein Schlüsselwort trifft. */
export function selectCategoriesOhneRueckfall(message: string, availableCategories: Set<SkillCategory>): Set<SkillCategory> | undefined {
  return waehleKategorien(message, availableCategories, false);
}

function waehleKategorien(message: string, availableCategories: Set<SkillCategory>, rueckfall: boolean): Set<SkillCategory> | undefined {
  const selected = new Set<SkillCategory>(['core']);

  let anyMatch = false;
  for (const [category, pattern] of Object.entries(CATEGORY_KEYWORDS) as [Exclude<SkillCategory, 'core'>, RegExp][]) {
    if (!availableCategories.has(category)) continue;
    if (pattern.test(message)) {
      selected.add(category);
      anyMatch = true;
    }
  }

  // Superset: only watch/schedule/background keywords need cross-category access
  // (e.g. "watch RSS feed" needs information + automation, "schedule daily briefing" needs productivity + automation).
  // Shell, code-agent, script etc. stay in automation only — they don't reference other skill categories.
  if (selected.has('automation') && SUPERSET_KEYWORDS.test(message)) {
    for (const cat of availableCategories) selected.add(cat);
    return selected;
  }

  // files needs automation because code_sandbox (automation) generates files (PDF, DOCX, Excel)
  if (selected.has('files')) {
    selected.add('automation');
  }

  // Fallback: if nothing matched, include common categories instead of ALL.
  // Heavy categories (infrastructure, identity, mcp) only appear when keywords match,
  // saving ~1500-2000 tokens per request on generic messages.
  if (!anyMatch && !rueckfall) return undefined; // v1300
  if (!anyMatch) {
    const commonCategories: SkillCategory[] = ['productivity', 'information', 'media', 'automation', 'files'];
    for (const cat of commonCategories) {
      if (availableCategories.has(cat)) selected.add(cat);
    }
  }

  return selected;
}

/* ────────────────────────────────────────────────────────────────────────────
 * v1300 — Werkzeugwahl je Nachricht (Owner-Freigabe 08.10. „freigabe für beide"; Spec §18.7)
 * Messung 07./08.10.: 64 Werkzeugschemata ≈ 35k Prompt-Tokens je Runde, Cache-Quote 50–61 %, 9 $/Tag auf default.
 * Hebel 1: Nennt die Nachricht ein Gerät (Name oder Skill-Kürzel), bekommt das Modell NUR die Geräte-Werkzeuge.
 * Hebel 2: Kategorien zuerst aus der aktuellen Nachricht; der Verlauf zählt nur, wenn die Nachricht selbst nichts
 * trifft (bisher wurde die Vereinigung aus Nachricht + 3 Vorgängern genommen); der Rückfall ohne Treffer ist klein
 * (core, productivity, information). Geräte-Skills kommen außerhalb von Hebel 1 nur bei Geräte-Wörtern dazu.
 * Deterministisch, modellunabhängig; allowedSkills (Mail-Regeln, Vorhaben) und Projekt-Chats bleiben unberührt.
 * ──────────────────────────────────────────────────────────────────────────── */
export const GERAETE_KEYWORDS = /\b(ger[äa]te?\w*|satellit\w*|bildschirm\w*|screenshot\w*|fenster\w*|zwischenablage|tasten?\w*|laptop\w*|notebook\w*|pc|vm|mac|macbook|rechner\w*|outlook|excel|vorhaben|programm\w*)\b/i;

export function istGeraeteSkill(meta: Pick<SkillMetadata, 'name'>): boolean { return meta.name.startsWith('geraet_'); }

/** Namen, unter denen ein Gerät in Nachrichten vorkommt: der Anzeigename aus der Beschreibung („Office-VM") und das Kürzel (office_vm, office-vm, office vm). */
export function geraeteNamen(meta: Pick<SkillMetadata, 'name' | 'description'>): string[] {
  const namen: string[] = [];
  const m = /Ger[äa]t „([^"“”]+)["“”]/.exec(meta.description ?? '');
  if (m?.[1]) namen.push(m[1].trim());
  const slug = meta.name.replace(/^geraet_/, '');
  if (slug) namen.push(slug, slug.replace(/_/g, '-'), slug.replace(/_/g, ' '));
  return [...new Set(namen.map(n => n.toLowerCase()).filter(n => n.length >= 2))];
}

export function genannteGeraete<T extends Pick<SkillMetadata, 'name' | 'description'>>(text: string, metas: T[]): T[] {
  const t = text.toLowerCase();
  return metas.filter(m => istGeraeteSkill(m) && geraeteNamen(m).some(n => new RegExp(`(^|[^\\p{L}\\p{N}])${n.replace(/[.*+?^${}()|[\\]\\\\]/g, '\\$&')}(?![\\p{L}\\p{N}])`, 'iu').test(t)));
}

export type WerkzeugwahlGrund = 'geraet_genannt' | 'nachricht' | 'verlauf' | 'rueckfall';

/**
 * v1388 — Realfall 12.10.: „Bau mir auf der Ubuntu-VM … ein Werkzeug, Abnahme je Etappe" — Hebel 1 gab NUR das Gerätewerkzeug,
 * der Projekt-Agent mit Gerät (v1387) war nie wählbar. Beschreibt die Nachricht ein Bau-Projekt, kommt project_agent dazu.
 */
export const PROJEKT_AUF_GERAET = /(^|[^\p{L}])(projekt\w*|etapp\w*|abnahme\w*|claude.?code\w*|programmier\w*|entwickl\w*|bau(e|en|t)?|baue?\s+mir|repo\w*|gitlab|github|klon\w*|clone\w*|merge.?requests?|mr)(?![\p{L}])/iu; // v1434 B13 Repo holen; v1455 Merge Requests

/**
 * v1398 — Projektakten: Namen der aktiven Projekte (Teile ≥ 4 Buchstaben). Nennt der Owner eines („am Supermarkt-Projekt
 * weiter: …"), ist project_agent in jedem Zweig dabei — ohne Gerätenamen und ohne Bau-Wort.
 */
let projektNamenMuster: RegExp | undefined;
export function setzeProjektNamenMuster(m: RegExp | undefined): void { projektNamenMuster = m; }

/**
 * v1550 (S4a) — nennt die Nachricht (oder der jüngste Verlauf) einen Host mit Fernzugang („pve3 hat Probleme“, „was ist mit dem
 * dockerhost los?“), sind alle Infrastruktur-Werkzeuge dabei — Fachskills UND Fernzugriff —, damit Alfred zwischen ihnen abwägen kann.
 * Vorher traf so eine Nachricht oft kein Stichwort und landete im Rückfall ohne beide.
 */
let fernzugangNamenMuster: RegExp | undefined;
export function setzeFernzugangNamenMuster(m: RegExp | undefined): void { fernzugangNamenMuster = m; }

/**
 * v1472 — Realfall 16.10. 08:47: Icon-Entwurf mit zwei image_generate-Aufrufen, dann „freigegeben“, „oder doch … flutter“, „ja“ —
 * die Anfrage rutschte aus den letzten 3 Nutzernachrichten, der Rückfall hatte keine Medien, Alfred sagte „Bildgenerierung nicht verfügbar“.
 * Werkzeuge, die im selben Gespräch zuletzt tatsächlich aufgerufen wurden, bleiben deshalb in jeder Auswahl.
 */
export const BENUTZT_FENSTER_MIN = 60;
export const BENUTZT_MAX = 8;
export function zuletztBenutzteWerkzeuge(verlauf: Array<{ role: string; toolCalls?: string; createdAt?: string }>, jetzt: Date, interne: ReadonlySet<string> = new Set(['help', 'memory', 'chat_history'])): string[] {
  const namen: string[] = [];
  for (let i = verlauf.length - 1; i >= 0 && namen.length < BENUTZT_MAX; i--) {
    const m = verlauf[i]!;
    if (m.role !== 'assistant' || !m.toolCalls) continue;
    const t = m.createdAt ? Date.parse(m.createdAt.includes('T') || m.createdAt.endsWith('Z') ? m.createdAt : `${m.createdAt.replace(' ', 'T')}Z`) : NaN;
    if (Number.isFinite(t) && (jetzt.getTime() - t) / 60_000 > BENUTZT_FENSTER_MIN) break;
    let calls: unknown;
    try { calls = JSON.parse(m.toolCalls); } catch { continue; }
    if (!Array.isArray(calls)) continue;
    for (const c of calls) {
      const n = (c as { name?: unknown })?.name;
      if (typeof n === 'string' && !interne.has(n) && !namen.includes(n) && namen.length < BENUTZT_MAX) namen.push(n);
    }
  }
  return namen;
}

/**
 * v1474 — Realfall 16.10.: „Erzeuge mit code_sandbox … lies sie mit read_store“ traf keine Kategorie (vor „sandbox“ steht ein
 * Unterstrich, „Ausgabedatei“ beginnt nicht mit „datei“), Alfred sagte „stehen mir nicht zur Verfügung“. Nennt die Nachricht
 * ein Werkzeug beim Namen (code_sandbox, code-sandbox, „code sandbox“), ist es dabei. Namen unter 4 Zeichen zählen nicht.
 */
export function genannteWerkzeuge(text: string, alle: Array<Pick<SkillMetadata, 'name'>>): string[] {
  const t = (text ?? '').toLowerCase();
  if (!t) return [];
  return alle.filter(m => m.name.length >= 4 && !istGeraeteSkill(m)).filter(m => {
    const muster = m.name.toLowerCase().replace(/[.*+?^${}()|[\]\\]/g, '\\$&').replace(/_/g, '[ _-]');
    return new RegExp(`(^|[^\\p{L}\\p{N}_])${muster}(?![\\p{L}\\p{N}_])`, 'u').test(t);
  }).map(m => m.name);
}

export function werkzeugeFuerNachricht<T extends SkillMetadata>(text: string, verlauf: string[], alle: T[], benutzt: string[] = []): { metas: T[]; grund: WerkzeugwahlGrund } {
  const r0 = werkzeugeOhneAkten(text, verlauf, alle);
  const namen = [...benutzt, ...genannteWerkzeuge(text, alle)]; // v1472 benutzt, v1474 beim Namen genannt
  const fehlend = [...new Set(namen)].map(n => alle.find(m => m.name === n)).filter((m): m is T => !!m && !r0.metas.includes(m));
  let r = fehlend.length ? { metas: [...r0.metas, ...fehlend], grund: r0.grund } : r0;
  if (fernzugangNamenMuster && (fernzugangNamenMuster.test(text) || verlauf.slice(-2).some(v => fernzugangNamenMuster!.test(v ?? '')))) {
    const infra = alle.filter(m => m.category === 'infrastructure' && !istGeraeteSkill(m) && !r.metas.includes(m));
    if (infra.length) r = { metas: [...r.metas, ...infra], grund: r.grund };
  }
  if (!projektNamenMuster?.test(text) || r.metas.some(m => m.name === 'project_agent')) return r;
  const pa = alle.find(m => m.name === 'project_agent');
  return pa ? { metas: [...r.metas, pa], grund: r.grund } : r;
}

function werkzeugeOhneAkten<T extends SkillMetadata>(text: string, verlauf: string[], alle: T[]): { metas: T[]; grund: WerkzeugwahlGrund } {
  const geraete = alle.filter(istGeraeteSkill);
  const genannt = genannteGeraete(text, geraete);
  if (genannt.length) {
    const projekt = PROJEKT_AUF_GERAET.test(text) ? alle.filter(m => m.name === 'project_agent') : [];
    return { metas: [...genannt, ...projekt], grund: 'geraet_genannt' };
  }
  const ohneGeraete = alle.filter(m => !istGeraeteSkill(m));
  const available = new Set<SkillCategory>(ohneGeraete.map(s => s.category ?? 'core'));
  const vText = verlauf.filter(Boolean).join(' ');
  // v1324 — Realfall 09.10. 13:45: „warum setzt du es nicht um?" nach dem MacBook-Auftrag landete im Rückfall ohne Gerätewerkzeug,
  // Alfred erklärte, er habe kein Werkzeug. Ein in den letzten Nachrichten genanntes Gerät bleibt in jedem Zweig dabei,
  // und der Rückfall prüft Nachricht UND Verlauf auf Gerätewörter.
  const ausVerlaufGenannt = vText ? genannteGeraete(vText, geraete) : [];
  const mitGeraeten = (metas: T[], quelle: string): T[] => {
    const dazu = GERAETE_KEYWORDS.test(quelle) ? geraete : ausVerlaufGenannt;
    return dazu.length ? [...metas, ...dazu.filter(g => !metas.includes(g))] : metas;
  };
  const eigene = selectCategoriesOhneRueckfall(text, available);
  if (eigene) return { metas: mitGeraeten(filterSkills(ohneGeraete, eigene) as T[], text), grund: 'nachricht' };
  const ausVerlauf = vText ? selectCategoriesOhneRueckfall(vText, available) : undefined;
  if (ausVerlauf) return { metas: mitGeraeten(filterSkills(ohneGeraete, ausVerlauf) as T[], `${text} ${vText}`), grund: 'verlauf' };
  const klein = new Set<SkillCategory>((['core', 'productivity', 'information'] as SkillCategory[]).filter(c => available.has(c)));
  return { metas: mitGeraeten(filterSkills(ohneGeraete, klein) as T[], `${text} ${vText}`), grund: 'rueckfall' };
}

/**
 * Filter a list of SkillMetadata to only those whose category is in the given set.
 * Skills without a category default to 'core'.
 */
export function filterSkills(
  skills: SkillMetadata[],
  categories: Set<SkillCategory>,
): SkillMetadata[] {
  return skills.filter(s => categories.has(s.category ?? 'core'));
}

/**
 * v1374 — Lernende Helfer L0: grobe Absicht einer Anfrage = Kategorien, deren Schlüsselwörter treffen (ohne Rückfall,
 * ohne 'core'). Deterministisch, für das Anfrage-Protokoll.
 */
export function absichtenAus(text: string): string[] {
  return (Object.entries(CATEGORY_KEYWORDS) as [string, RegExp][]).filter(([, p]) => p.test(text)).map(([k]) => k);
}
