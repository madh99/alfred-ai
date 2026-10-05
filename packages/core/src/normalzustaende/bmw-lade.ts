import { deuteBmw, type BmwDeutung } from './bmw.js';

/** Minimaler Repo-Vertrag (BmwTelematicRepository) — für Collector und Jobs gleich. */
export interface BmwTelematikQuelle {
  getLatestAnyVinBySource(userId: string, source: 'mqtt' | 'rest'): Promise<{ vin: string; createdAt: string; telematicData: Record<string, { value: string; unit?: string; timestamp?: string }> } | undefined>;
  getHistory(userId: string, vin: string, from: string, to: string, limit?: number): Promise<Array<{ createdAt: string; telematicData: Record<string, { value: string; unit?: string; timestamp?: string }> }>>;
}

const KM = 'vehicle.vehicle.travelledDistance';

/** v1175 — Deutung aus der Telematik-Tabelle laden (Snapshots + 7-Tage-Verlauf). Gemeinsam für Collector und bmw-rest-poll. */
export async function ladeBmwDeutung(repo: BmwTelematikQuelle, userId: string, now = new Date()): Promise<{ deutung?: BmwDeutung; restAlterMin: number }> {
  const mqtt = await repo.getLatestAnyVinBySource(userId, 'mqtt');
  const rest = await repo.getLatestAnyVinBySource(userId, 'rest');
  const restAlterMin = rest ? (now.getTime() - Date.parse(rest.createdAt)) / 60_000 : Infinity;
  if (!mqtt && !rest) return { restAlterMin };
  const vin = (mqtt ?? rest)!.vin;
  const eintraege = await repo.getHistory(userId, vin, new Date(now.getTime() - 7 * 86_400_000).toISOString(), now.toISOString(), 500).catch(() => []);
  const verlauf = eintraege.map(e => {
    const km = Number(e.telematicData[KM]?.value);
    return { createdAt: e.createdAt, km: Number.isFinite(km) ? km : undefined, kmZeit: e.telematicData[KM]?.timestamp };
  });
  const deutung = deuteBmw({
    mqtt: mqtt ? { source: 'mqtt', createdAt: mqtt.createdAt, data: mqtt.telematicData } : undefined,
    rest: rest ? { source: 'rest', createdAt: rest.createdAt, data: rest.telematicData } : undefined,
    verlauf, now,
  });
  return { deutung, restAlterMin };
}

/** Auffälligkeits-Schlüssel des Fahrzeug-Zustands (für Zustandswechsel-Erkennung). */
export function bmwAuffaellig(d: BmwDeutung): string[] {
  const z = d.zustand; const out: string[] = [];
  if (z.streamVerdacht) out.push('mqtt-stream-fehlt');
  if (z.restAusgefallen) out.push('bmw-rest-ausgefallen');
  if (z.verriegelt === false && z.steht) out.push('fahrzeug-unverriegelt');
  if (z.offen.length) out.push('fahrzeug-offen');
  if (z.reifenAbweichung.length) out.push('reifendruck');
  if (z.soc !== undefined && z.soc < 20) out.push('fahrzeug-soc-niedrig');
  return out;
}
