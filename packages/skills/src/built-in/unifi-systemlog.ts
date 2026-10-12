/**
 * v1381 — UniFi Network 8.x/9.x: Alarme und Ereignisse stehen im System-Log (v2-API), nicht mehr unter `list/alarm`,
 * `rest/alarm` (HTTP 400 api.err.InvalidObject) oder `stat/event` (404). Realfall 12.10.: Nachforschen-Rezept und Monitor
 * bekamen keine UniFi-Alarme; live geprüft: `POST /proxy/network/v2/api/site/<site>/system-log/all|critical` mit
 * {timestampFrom, timestampTo, pageNumber, pageSize}. Einträge: key, severity (LOW/MEDIUM/…), category, message_raw mit
 * Platzhaltern ({CLIENT}, {DEVICE}, …) und parameters. 24 h ≈ 1 100 Einträge, fast alle Routine (LOW) oder Firewall-Blocks.
 */

export interface SystemLogEintrag {
  key?: string;
  severity?: string;
  category?: string;
  subcategory?: string;
  message_raw?: string;
  title_raw?: string;
  parameters?: Record<string, unknown>;
  timestamp?: number;
}

/** Parameterwert lesbar: Objekte tragen name/value/id, sonst der Wert selbst. */
function wert(p: unknown): string | undefined {
  if (p === null || p === undefined) return undefined;
  if (typeof p === 'object') {
    const o = p as Record<string, unknown>;
    const v = o.name ?? o.value ?? o.id;
    return v === undefined ? undefined : String(v);
  }
  return String(p);
}

/** Text eines Eintrags mit eingesetzten Parametern („{CLIENT} connected to {WLAN}" → „Handy connected to Heim"). */
export function eintragText(e: SystemLogEintrag): string {
  const roh = e.message_raw ?? e.title_raw ?? e.key ?? '';
  return roh.replace(/\{(\w+)\}/g, (m, k: string) => wert(e.parameters?.[k]) ?? m).slice(0, 300);
}

/** Gerät des Eintrags (für die Tabelle). */
export function eintragGeraet(e: SystemLogEintrag): string {
  const p = e.parameters;
  return wert(p?.DEVICE) ?? wert(p?.DEVICE_TO) ?? wert(p?.DST_DEVICE) ?? wert(p?.CLIENT) ?? wert(p?.SRC_CLIENT) ?? wert(p?.CONSOLE_NAME) ?? '-';
}

/** Ins bisherige Alarm-Format (Felder wie `list/alarm`), damit Ausgabe, Filter und Zählung gleich bleiben. */
export function alsAlarm(e: SystemLogEintrag): { key: string; msg: string; datetime: string; device_name: string; severity: string; category: string; archived: false } {
  return {
    key: e.key ?? 'unknown', msg: eintragText(e), datetime: e.timestamp ? new Date(e.timestamp).toISOString() : '-',
    device_name: eintragGeraet(e), severity: e.severity ?? '-', category: e.category ?? '-', archived: false,
  };
}

/** Warnungen = alles außer Routine (LOW). */
export function istWarnung(e: SystemLogEintrag): boolean {
  return !!e.severity && e.severity !== 'LOW';
}

const RANG: Record<string, number> = { CRITICAL: 0, VERY_HIGH: 1, HIGH: 2, MEDIUM: 3, LOW: 4 };

/** Schwerste zuerst, innerhalb gleicher Schwere die neuesten — sonst verdrängen ~400 Firewall-Blocks/Tag (MEDIUM) die seltenen HIGH (Realfall 12.10.: SFP-Fehler). */
export function nachSchwere<T extends SystemLogEintrag>(liste: T[]): T[] {
  return [...liste].sort((a, b) => (RANG[a.severity ?? ''] ?? 5) - (RANG[b.severity ?? ''] ?? 5) || (b.timestamp ?? 0) - (a.timestamp ?? 0));
}

/** Infrastruktur-Ereignis: weder Client-Verbindungen (Roaming, Verbinden/Trennen) noch Firewall-Blocks. */
export function istInfraEreignis(e: SystemLogEintrag): boolean {
  const k = e.key ?? '';
  return !/CLIENT/.test(k) && !k.startsWith('TRAFFIC_BLOCKED');
}
