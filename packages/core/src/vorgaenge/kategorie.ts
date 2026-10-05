/**
 * v1195 — Kategorie eines Vorgangs entlang der Weltmodell-Quellen (Jarvis Schicht 4).
 *
 * Die Erledigungsquote je Kategorie (Lern-Telemetrie) und die späteren Konsequenzen
 * (Digest-Modus, Aufstieg nach `auto`) brauchen Kategorien, die den Quellen des
 * Weltmodells entsprechen — nicht der alten Stichwortliste des Insight-Trackers,
 * die „9 unbeantwortete E-Mails" und „Kritische Systemfehler (Error-Rate)" als
 * `general` führte (Live 05.10.).
 *
 * Deterministisch, Reihenfolge = Priorität: die erste passende Regel gewinnt.
 * Wortgrenzen über Unicode-Lookarounds, damit Umlaute („Tür", „Überweisung") greifen.
 */
export type VorgangKategorie =
  | 'alfred' | 'itsm' | 'bmw' | 'energie' | 'haus' | 'infra' | 'email' | 'kalender'
  | 'aufgaben' | 'projekte' | 'finanzen' | 'social' | 'reise' | 'wetter' | 'nachrichten' | 'sonstiges';

/** Wortliste → Regex mit Unicode-Wortgrenzen (Terme dürfen eigene Regex-Teile enthalten). */
function woerter(...terme: string[]): RegExp {
  return new RegExp(`(?<![\\p{L}\\p{N}])(?:${terme.join('|')})(?![\\p{L}\\p{N}])`, 'iu');
}

const REGELN: Array<[VorgangKategorie, RegExp]> = [
  ['alfred', woerter('error[- ]?rate', 'fehlerrate', 'skill[- ]?(?:status|health|fehler)', 'systemfehler', 'sandbox', 'reasoning', 'alfred')],
  ['itsm', woerter('incidents?', 'cmdb', 'problem[- ]?tickets?', 'runbooks?', 'itsm', 'change[- ]?requests?')],
  ['bmw', woerter('bmw', 'fahrzeug', 'fahrzeugdaten', 'reichweite', 'cardata', 'mqtt-stream', 'kilometerstand', 'verriegelt', 'reifendruck', 'soc')],
  ['energie', woerter('strom', 'strompreis', 'energie', 'kwh', 'photovoltaik', 'pv', 'ess', 'hausbatterie', 'wallbox', 'awattar', 'einspeisung', 'netzbezug', 'ladeplan')],
  ['haus', woerter('tür', 'türe', 'türen', 'fenster', 'bewegung', 'anwesenheit', 'zu hause', 'rauch', 'wasser', 'smart[- ]?home', 'home[- ]?assistant', 'sensors?', 'sensoren', 'batterie', 'heizung', 'thermostat', 'temperatur')],
  ['infra', woerter('proxmox', 'unifi', 'mikrotik', 'docker', 'container', 'server', 'vm', 'ram', 'cpu', 'disk', 'festplatte', 'backup', 'dns', 'nginx', 'npm', 'commvault', 'git-server', 'netzwerk', 'wlan', 'switch', 'router', 'uptime')],
  ['email', woerter('e-?mails?', 'mailbox', 'posteingang', 'follow-?up', 'newsletter', 'absender')],
  ['kalender', woerter('kalender', 'termine?', 'meeting', 'besprechung', 'einladung')],
  ['aufgaben', woerter('todo', 'to-do', 'aufgaben?', 'erinnerung', 'reminder', 'fällig', 'erledigen')],
  ['projekte', woerter('projekte?', 'fussball-cc', 'lokalkraft', 'deploy', 'repository', 'repo', 'pull request', 'agent', 'sprint')],
  ['finanzen', woerter('crypto', 'bitcoin', 'btc', 'eth', 'kurs', 'bitpanda', 'rechnung', 'zahlung', 'überweisung', 'budget', 'kosten')],
  ['social', woerter('social', 'instagram', 'facebook', 'bluesky', 'youtube', 'post', 'reel', 'kanal', 'kanäle')],
  ['reise', woerter('reise', 'flug', 'hotel', 'urlaub', 'zug', 'bahn')],
  ['wetter', woerter('wetter', 'regen', 'sturm', 'frost', 'unwetter')],
  ['nachrichten', woerter('artikel', 'nachrichten', 'news', 'feed', 'rss', 'schlagzeile')],
];

export function kategorieAus(text: string): VorgangKategorie {
  const t = text.slice(0, 400);
  for (const [kat, re] of REGELN) if (re.test(t)) return kat;
  return 'sonstiges';
}
