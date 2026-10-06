/**
 * v1217 — Jarvis Schicht 3: Befunde aus Deutungen des Weltmodells ableiten.
 *
 * Jede Normalzustands-Deutung liefert `auffaellig` (Objekt-Schlüssel wie
 * `sensorbatterie:sensor.temp_terrasse_battery:offline`) und `zeilen` (gedeutete Zeilen,
 * auffällige mit ⚠️). Daraus entsteht je Schlüssel ein Befund: Gegenstand = Schlüssel,
 * Titel = die passende ⚠️-Zeile, sonst ein generischer Titel. Rein, deterministisch.
 */
export interface BefundKandidat { gegenstand: string; titel: string; detail?: string }

const QUELLE_ZU_KATEGORIE: Record<string, string> = {
  bmw: 'bmw', energie: 'energie', sensorbatterien: 'haus', haus: 'haus', mikrotik: 'infra', infra: 'infra',
};

export function quelleZuKategorie(quelle: string): string {
  return QUELLE_ZU_KATEGORIE[quelle] ?? quelle;
}

/** Markdown-Fett, ⚠️ und Pfeile aus einer Deutungszeile entfernen. */
export function bereinigeZeile(z: string): string {
  return z.replace(/\*\*/g, '').replace(/^[\s⚠️🚨↳-]+/u, '').replace(/\s+/g, ' ').trim();
}

/** Wörter (≥ 3 Zeichen) aus einem Objekt-Schlüssel, zum Wiederfinden in den Zeilen. */
function schluesselWoerter(gegenstand: string): string[] {
  return gegenstand.toLowerCase().split(/[:._\-\s/]+/).filter(w => w.length >= 3 && !/^(sensor|binary|switch|light|offline|neu|down|niedrig|baseline|battery|batterie)$/.test(w));
}

/**
 * v1218 — Deutungen reihen mehrere Objekte in EINER Zeile mit „ · " auf (Realfall 13:22: der Befund
 * „Temp Terrasse offline" bekam den Zeilenanfang „20 Sensoren · Holztüre Garage 50 %" als Titel).
 * Darum wird auf Segment-Ebene gesucht: das ⚠️-Segment, das den Gegenstand nennt.
 */
export function segmenteAus(zeilen: string[]): string[] {
  const out: string[] = [];
  for (const z of zeilen) for (const seg of z.split(/\s·\s|\n/)) if (seg.trim()) out.push(seg.trim());
  return out;
}

export function befundeAusDeutung(quelle: string, deutung: { zeilen: string[]; auffaellig: string[] } | undefined): BefundKandidat[] {
  if (!deutung) return [];
  const segmente = segmenteAus(deutung.zeilen);
  const istWarn = (s: string) => /⚠️|🚨|ALARM/u.test(s);
  const warnSegmente = segmente.filter(istWarn);
  // v1221 — Stellt die Deutung je Schlüssel GENAU eine ⚠️-Zeile (Monitor-Alerts), gilt die Position.
  // Realfall 16:00: „proxmox:test-ubuntu:ram" bekam die git-server-Zeile, weil beide „proxmox" enthalten.
  const positionell = deutung.zeilen.length === deutung.auffaellig.length && deutung.zeilen.every(z => istWarn(z) && !/\s·\s/.test(z));
  const out: BefundKandidat[] = [];
  const gesehen = new Set<string>();
  deutung.auffaellig.forEach((key, i) => {
    if (!key || gesehen.has(key)) return;
    gesehen.add(key);
    let seg: string | undefined;
    if (positionell) {
      seg = deutung.zeilen[i];
    } else {
      // v1221 — bestes Segment nach Zahl der Schlüsselwort-Treffer, ⚠️ zählt als Bonus.
      // Realfall 16:23: „fahrzeug-unverriegelt" bekam „Fahrzeug: steht seit …" statt der ⚠️-Zeile „unverriegelt".
      const woerter = schluesselWoerter(key);
      let best = 0;
      for (const s of segmente) {
        const l = s.toLowerCase();
        const treffer = woerter.filter(w => l.includes(w)).length;
        if (treffer === 0) continue;
        const score = treffer * 2 + (istWarn(s) ? 1 : 0);
        if (score > best) { best = score; seg = s; }
      }
      if (!seg && warnSegmente.length === 1) seg = warnSegmente[0];
    }
    const titel = seg ? bereinigeZeile(seg).slice(0, 200) : `${quelle}: ${key}`;
    out.push({ gegenstand: key, titel, detail: deutung.zeilen.map(bereinigeZeile).filter(Boolean).join('\n').slice(0, 2000) });
  });
  return out;
}

/**
 * v1219 — Infrastruktur-Alerts des Monitor-Skills (Proxmox, UniFi, Home Assistant, Health-Checks)
 * bekommen einen stabilen Schlüssel ohne Messwerte: „git-server RAM usage 95,1 %" und „… 96,0 %"
 * sind derselbe Befund. Realfall 06.10.: fünf Vorgänge für denselben Server.
 */
export interface InfraAlert { source: string; message: string }

function slug(t: string): string {
  // Nur freistehende Messwerte entfernen (95.1 %, 3) — Ziffern in Namen bleiben (pve2, ws22s-b01, 30000ms)
  return t.toLowerCase().replace(/(?<![\p{L}\p{N}])\d+([.,]\d+)?\s*%?(?![\p{L}\p{N}])/gu, '').replace(/[^\p{L}\p{N}]+/gu, '-').replace(/^-+|-+$/g, '').slice(0, 60);
}

export function infraAlertSchluessel(a: InfraAlert): string {
  const m = a.message;
  let t: RegExpMatchArray | null;
  if (a.source === 'proxmox') {
    if ((t = m.match(/^Node "([^"]+)" is offline/))) return `proxmox:${slug(t[1])}:offline`;
    if ((t = m.match(/^(.+?) disk usage /))) return `proxmox:${slug(t[1])}:disk`;
    if ((t = m.match(/^(.+?) RAM usage /))) return `proxmox:${slug(t[1])}:ram`;
  }
  if (a.source === 'unifi') {
    if ((t = m.match(/^Subsystem "([^"]+)"/))) return `unifi:subsystem:${slug(t[1])}`;
    if ((t = m.match(/^Device "([^"]+)" is not connected/))) return `unifi:device:${slug(t[1])}`;
    if (/open alert\(s\)/.test(m)) return 'unifi:alarms';
  }
  if (a.source === 'homeassistant') {
    if ((t = m.match(/^Low battery: (.+?) at /))) return `homeassistant:battery:${slug(t[1])}`;
  }
  return `${a.source}:${slug(m) || 'alert'}`;
}

/** Monitor-Alerts als Deutung (eine ⚠️-Zeile je Alert), damit Befunde und Mini-Pass denselben Weg nehmen. */
export function infraDeutungAus(alerts: InfraAlert[]): { zeilen: string[]; auffaellig: string[] } {
  const zeilen: string[] = []; const auffaellig: string[] = []; const gesehen = new Set<string>();
  for (const a of alerts) {
    const key = infraAlertSchluessel(a);
    if (gesehen.has(key)) continue;
    gesehen.add(key);
    auffaellig.push(key);
    zeilen.push(`⚠️ ${a.source}: ${a.message}`);
  }
  return { zeilen, auffaellig };
}

/** v1219 — Befund-Titel für Infra: Schlüsselwörter sind Host/Gerät, nicht die Quelle. */
export function infraBefunde(alerts: InfraAlert[]): BefundKandidat[] {
  const out: BefundKandidat[] = []; const gesehen = new Set<string>();
  for (const a of alerts) {
    const key = infraAlertSchluessel(a);
    if (gesehen.has(key)) continue;
    gesehen.add(key);
    out.push({ gegenstand: key, titel: `${a.source}: ${a.message}`.slice(0, 200), detail: a.message });
  }
  return out;
}

/**
 * v1222 — Gehört ein Insight-Text zu einem offenen Befund? Dann entsteht kein Prosa-Vorgang mehr:
 * der Befund IST das Objekt. Zwei Wege, beide deterministisch: die Anker-Regel der Vorgänge
 * (themenGleich) zwischen Insight und Befund-Titel, oder die Wörter des Gegenstands (Host, Gerät,
 * Sensor) kommen im Insight vor. Realfall 06.10.: fünf Prosa-Vorgänge für „git-server RAM 95 %".
 */
export function gegenstandWoerter(gegenstand: string): string[] {
  return gegenstand.toLowerCase().split(/[:._\-\s/]+/).filter(w => w.length >= 4 && !/^(sensor|binary|switch|light|offline|niedrig|baseline|battery|batterie|device|unifi|proxmox|homeassistant|mikrotik|fahrzeug|usage|status|subsystem)$/.test(w));
}

export function passtZuBefund(text: string, befund: { gegenstand: string; titel: string }, themenGleich: (a: string, b: string) => boolean): boolean {
  if (!text) return false;
  if (themenGleich(text, befund.titel)) return true;
  const woerter = gegenstandWoerter(befund.gegenstand);
  if (woerter.length === 0) return false;
  const l = text.toLowerCase().replace(/[-_]/g, ' ');
  const treffer = woerter.filter(w => l.includes(w.replace(/[-_]/g, ' '))).length;
  // Ein Wort reicht, wenn es ein Hostname/Bezeichner mit Bindestrich oder Ziffer ist (git-server, ac-mesh); sonst zwei Wörter
  const spezifisch = woerter.some(w => (/[-\d]/.test(w) || w.length >= 8) && l.includes(w.replace(/[-_]/g, ' ')));
  return treffer >= 2 || spezifisch;
}
