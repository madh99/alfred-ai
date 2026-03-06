import type { SkillMetadata, SkillContext, SkillResult, EnergyPriceConfig } from '@alfred/types';
import { Skill } from '../skill.js';

type Action = 'current' | 'today' | 'tomorrow' | 'cheapest' | 'average';

interface MarketDataEntry {
  start_timestamp: number;
  end_timestamp: number;
  marketprice: number; // EUR/MWh
  unit: string;
}

interface MarketDataResponse {
  object: string;
  data: MarketDataEntry[];
}

// aWATTar HOURLY constants
const AWATTAR_MARKUP_CT = 1.5;        // ct/kWh netto
const AWATTAR_BASE_FEE_NETTO = 4.79;  // €/Monat
const AWATTAR_BASE_FEE_BRUTTO = 5.75; // €/Monat
const AUSGLEICH_FACTOR = 1.03;        // 3% Ausgleichsenergiekomponente (bis 31.03.2026)
const AUSGLEICH_END = new Date('2026-04-01T00:00:00+02:00'); // CEST
const UST_FACTOR = 1.20;              // 20% MwSt

// Österreichweite Abgaben (Stand 2026)
const ELEKTRIZITAETSABGABE_CT = 0.10;       // ct/kWh
const OEKOSTROM_ARBEIT_CT = 0.58;           // ct/kWh
const OEKOSTROM_VERLUST_CT = 0.04;          // ct/kWh

// Fixe monatliche Abgaben (netto, €/Monat, umgerechnet aus €/ZP/Jahr ÷ 12)
const OEKOSTROM_PAUSCHALE_NETTO = 0.32;     // €/Monat (3,80 €/Jahr)
const ERNEUERBAREN_PAUSCHALE_NETTO = 1.62;  // €/Monat (19,02 €/Jahr)

const API_URL = 'https://api.awattar.at/v1/marketdata';

export class EnergyPriceSkill extends Skill {
  readonly metadata: SkillMetadata = {
    name: 'energy_price',
    category: 'information',
    description:
      'Strompreise (aWATTar HOURLY Tarif, EPEX Spot AT). ' +
      '"current" zeigt den aktuellen Strompreis mit Aufschlüsselung (Marktpreis, Netzentgelte, Abgaben, Brutto). ' +
      '"today" zeigt alle Stundenpreise für heute. ' +
      '"tomorrow" zeigt Stundenpreise für morgen (verfügbar ab ~14:00). ' +
      '"cheapest" findet die günstigsten Stunden (Standard: 3 Stunden in den nächsten 24h). ' +
      '"average" zeigt den Durchschnittspreis für heute oder ein bestimmtes Datum.',
    riskLevel: 'read',
    version: '1.0.0',
    timeoutMs: 15_000,
    inputSchema: {
      type: 'object',
      properties: {
        action: {
          type: 'string',
          enum: ['current', 'today', 'tomorrow', 'cheapest', 'average'],
          description: 'Aktion',
        },
        hours: {
          type: 'number',
          description: 'Für cheapest: Anzahl günstigster Stunden (Standard: 3)',
        },
        date: {
          type: 'string',
          description: 'ISO-Datum für average (Standard: heute)',
        },
      },
      required: ['action'],
    },
  };

  private readonly config?: EnergyPriceConfig;

  constructor(config?: EnergyPriceConfig) {
    super();
    this.config = config;
  }

  async execute(input: Record<string, unknown>, _context: SkillContext): Promise<SkillResult> {
    const action = input.action as Action | undefined;
    if (!action) return { success: false, error: 'Missing required field "action"' };

    try {
      switch (action) {
        case 'current':   return await this.current();
        case 'today':     return await this.dayPrices('today');
        case 'tomorrow':  return await this.dayPrices('tomorrow');
        case 'cheapest':  return await this.cheapest(input.hours as number | undefined);
        case 'average':   return await this.average(input.date as string | undefined);
        default:
          return { success: false, error: `Unknown action "${action as string}"` };
      }
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      return { success: false, error: `aWATTar API error: ${msg}` };
    }
  }

  // ── Actions ────────────────────────────────────────────────

  private async current(): Promise<SkillResult> {
    const now = Date.now();
    const data = await this.fetchMarketData();
    const entry = data.find(d => d.start_timestamp <= now && d.end_timestamp > now);

    if (!entry) {
      return { success: false, error: 'Kein Marktpreis für die aktuelle Stunde verfügbar.' };
    }

    const breakdown = this.calculatePrice(entry.marketprice);
    const timeRange = this.formatHourRange(entry.start_timestamp, entry.end_timestamp);

    const lines = [`## Aktueller Strompreis (${timeRange})`, ''];
    lines.push(this.formatBreakdown(breakdown));

    return { success: true, data: breakdown, display: lines.join('\n') };
  }

  private async dayPrices(day: 'today' | 'tomorrow'): Promise<SkillResult> {
    const now = new Date();
    const target = new Date(now);
    if (day === 'tomorrow') target.setDate(target.getDate() + 1);

    const dayStart = new Date(target);
    dayStart.setHours(0, 0, 0, 0);
    const dayEnd = new Date(dayStart);
    dayEnd.setDate(dayEnd.getDate() + 1);

    const data = await this.fetchMarketData(dayStart.getTime(), dayEnd.getTime());

    if (data.length === 0) {
      const hint = day === 'tomorrow' ? ' Preise für morgen sind ab ca. 14:00 verfügbar.' : '';
      return { success: false, error: `Keine Preisdaten für ${day === 'today' ? 'heute' : 'morgen'} verfügbar.${hint}` };
    }

    const label = day === 'today' ? 'Heute' : 'Morgen';
    const dateStr = dayStart.toLocaleDateString('de-AT');
    const lines = [`## Strompreise ${label} (${dateStr})`, ''];
    lines.push('| Uhrzeit | Markt ct/kWh | Brutto ct/kWh |');
    lines.push('|---|---|---|');

    let minPrice = Infinity;
    let maxPrice = -Infinity;
    let sumBrutto = 0;

    for (const entry of data) {
      const breakdown = this.calculatePrice(entry.marketprice);
      const time = this.formatHourRange(entry.start_timestamp, entry.end_timestamp);
      const spotCt = this.spotCtKwh(entry.marketprice);
      lines.push(`| ${time} | ${spotCt.toFixed(2)} | ${breakdown.bruttoCt.toFixed(2)} |`);
      minPrice = Math.min(minPrice, breakdown.bruttoCt);
      maxPrice = Math.max(maxPrice, breakdown.bruttoCt);
      sumBrutto += breakdown.bruttoCt;
    }

    const avgBrutto = sumBrutto / data.length;
    lines.push('');
    lines.push(`**Min:** ${minPrice.toFixed(2)} ct/kWh | **Max:** ${maxPrice.toFixed(2)} ct/kWh | **Ø:** ${avgBrutto.toFixed(2)} ct/kWh`);

    return { success: true, data: { entries: data.length, min: minPrice, max: maxPrice, avg: avgBrutto }, display: lines.join('\n') };
  }

  private async cheapest(hours?: number): Promise<SkillResult> {
    const count = hours ?? 3;
    const now = Date.now();
    const end = now + 24 * 60 * 60 * 1000;
    const data = await this.fetchMarketData(now, end);

    if (data.length === 0) {
      return { success: false, error: 'Keine Preisdaten für die nächsten 24 Stunden verfügbar.' };
    }

    const withPrices = data.map(entry => ({
      entry,
      breakdown: this.calculatePrice(entry.marketprice),
    }));

    withPrices.sort((a, b) => a.breakdown.bruttoCt - b.breakdown.bruttoCt);
    const cheapest = withPrices.slice(0, Math.min(count, withPrices.length));

    // Sort by time for display
    cheapest.sort((a, b) => a.entry.start_timestamp - b.entry.start_timestamp);

    const lines = [`## ${count} günstigste Stunden (nächste 24h)`, ''];
    for (const { entry, breakdown } of cheapest) {
      const time = this.formatHourRange(entry.start_timestamp, entry.end_timestamp);
      const dayLabel = new Date(entry.start_timestamp).toLocaleDateString('de-AT', { weekday: 'short' });
      lines.push(`- **${dayLabel} ${time}**: ${breakdown.bruttoCt.toFixed(2)} ct/kWh brutto (Markt: ${this.spotCtKwh(entry.marketprice).toFixed(2)} ct/kWh)`);
    }

    return { success: true, data: cheapest.map(c => ({ time: this.formatHourRange(c.entry.start_timestamp, c.entry.end_timestamp), bruttoCt: c.breakdown.bruttoCt })), display: lines.join('\n') };
  }

  private async average(dateStr?: string): Promise<SkillResult> {
    let dayStart: Date;
    if (dateStr) {
      dayStart = new Date(dateStr);
      dayStart.setHours(0, 0, 0, 0);
    } else {
      dayStart = new Date();
      dayStart.setHours(0, 0, 0, 0);
    }
    const dayEnd = new Date(dayStart);
    dayEnd.setDate(dayEnd.getDate() + 1);

    const data = await this.fetchMarketData(dayStart.getTime(), dayEnd.getTime());

    if (data.length === 0) {
      return { success: false, error: `Keine Preisdaten für ${dayStart.toLocaleDateString('de-AT')} verfügbar.` };
    }

    let sumSpot = 0;
    let sumBrutto = 0;
    for (const entry of data) {
      sumSpot += this.spotCtKwh(entry.marketprice);
      sumBrutto += this.calculatePrice(entry.marketprice).bruttoCt;
    }

    const avgSpot = sumSpot / data.length;
    const avgBrutto = sumBrutto / data.length;
    const dateLabel = dayStart.toLocaleDateString('de-AT');

    const lines = [
      `## Durchschnittspreis ${dateLabel}`,
      '',
      `**Ø Marktpreis:** ${avgSpot.toFixed(2)} ct/kWh`,
      `**Ø Brutto-Gesamtpreis:** ${avgBrutto.toFixed(2)} ct/kWh`,
      '',
      `Basierend auf ${data.length} Stundenwerten.`,
    ];

    return { success: true, data: { date: dateLabel, avgSpotCt: avgSpot, avgBruttoCt: avgBrutto, hours: data.length }, display: lines.join('\n') };
  }

  // ── Price calculation ──────────────────────────────────────

  private spotCtKwh(marketpriceEurMwh: number): number {
    return marketpriceEurMwh / 10;
  }

  private calculatePrice(marketpriceEurMwh: number): PriceBreakdown {
    const spotCt = this.spotCtKwh(marketpriceEurMwh);

    // 3% Ausgleichsenergiekomponente (entfällt ab 01.04.2026)
    const useAusgleich = new Date() < AUSGLEICH_END;
    const energyBaseCt = useAusgleich ? spotCt * AUSGLEICH_FACTOR : spotCt;

    const energieNettoCt = energyBaseCt + AWATTAR_MARKUP_CT;

    // Netzentgelte
    const grid = this.getGridCosts();
    const netzNettoCt = grid.usageCt + grid.lossCt;

    // Abgaben (pro kWh)
    const abgabenCt = ELEKTRIZITAETSABGABE_CT + OEKOSTROM_ARBEIT_CT + OEKOSTROM_VERLUST_CT;

    const gesamtNettoCt = energieNettoCt + netzNettoCt + abgabenCt;
    const bruttoCt = gesamtNettoCt * UST_FACTOR;

    return {
      spotCt,
      ausgleichCt: useAusgleich ? spotCt * 0.03 : 0,
      aufschlagCt: AWATTAR_MARKUP_CT,
      energieNettoCt,
      netznutzungCt: grid.usageCt,
      netzverlustCt: grid.lossCt,
      eAbgabeCt: ELEKTRIZITAETSABGABE_CT,
      oekoArbeitCt: OEKOSTROM_ARBEIT_CT,
      oekoVerlustCt: OEKOSTROM_VERLUST_CT,
      gesamtNettoCt,
      ustCt: gesamtNettoCt * 0.20,
      bruttoCt,
      gridName: grid.name,
      hasGrid: grid.usageCt > 0,
    };
  }

  private getGridCosts(): { name: string; usageCt: number; lossCt: number } {
    const usageCt = this.config?.gridUsageCt ?? 0;
    const lossCt = this.config?.gridLossCt ?? 0;
    const name = this.config?.gridName ?? '';

    if (usageCt > 0) {
      return { name, usageCt, lossCt };
    }

    return { name: '', usageCt: 0, lossCt: 0 };
  }

  private formatBreakdown(b: PriceBreakdown): string {
    const lines = [
      '| Komponente | ct/kWh |',
      '|---|---:|',
      `| EPEX Spot Marktpreis | ${b.spotCt.toFixed(2)} |`,
    ];

    if (b.ausgleichCt > 0) {
      lines.push(`| Ausgleichsenergie (3%) | ${b.ausgleichCt.toFixed(2)} |`);
    }

    lines.push(`| aWATTar Aufschlag | ${b.aufschlagCt.toFixed(2)} |`);
    lines.push(`| **Energie netto** | **${b.energieNettoCt.toFixed(2)}** |`);

    if (b.hasGrid) {
      lines.push(`| Netznutzung (${b.gridName}) | ${b.netznutzungCt.toFixed(2)} |`);
      lines.push(`| Netzverlust | ${b.netzverlustCt.toFixed(2)} |`);
    }

    lines.push(`| Elektrizitätsabgabe | ${b.eAbgabeCt.toFixed(2)} |`);
    lines.push(`| Ökostrom-Förderbeitrag | ${b.oekoArbeitCt.toFixed(2)} |`);
    lines.push(`| Ökostrom-Verlust | ${b.oekoVerlustCt.toFixed(2)} |`);
    lines.push(`| **Gesamt netto** | **${b.gesamtNettoCt.toFixed(2)}** |`);
    lines.push(`| USt (20%) | ${b.ustCt.toFixed(2)} |`);
    lines.push(`| **Gesamt brutto** | **${b.bruttoCt.toFixed(2)}** |`);

    if (!b.hasGrid) {
      lines.push('');
      lines.push('*Netzentgelte nicht inkludiert — Netzkosten via `alfred setup` oder ENV konfigurieren*');
    }

    // Fixed monthly costs
    const capFee = this.config?.gridCapacityFee ?? 0;
    const meterFee = this.config?.gridMeterFee ?? 0;
    lines.push('');
    lines.push('**Fixe Monatskosten (netto → brutto):**');
    lines.push(`- aWATTar Grundgebühr: ${AWATTAR_BASE_FEE_NETTO.toFixed(2)} € → ${AWATTAR_BASE_FEE_BRUTTO.toFixed(2)} €`);
    if (capFee > 0) {
      const label = this.config?.gridName ? ` (${this.config.gridName})` : '';
      lines.push(`- Leistungspauschale${label}: ${capFee.toFixed(2)} € → ${(capFee * UST_FACTOR).toFixed(2)} €`);
    }
    if (meterFee > 0) {
      lines.push(`- Messentgelt: ${meterFee.toFixed(2)} € → ${(meterFee * UST_FACTOR).toFixed(2)} €`);
    }
    lines.push(`- Ökostrom-Förderpauschale: ${OEKOSTROM_PAUSCHALE_NETTO.toFixed(2)} € → ${(OEKOSTROM_PAUSCHALE_NETTO * UST_FACTOR).toFixed(2)} €`);
    lines.push(`- Erneuerbaren-Förderpauschale: ${ERNEUERBAREN_PAUSCHALE_NETTO.toFixed(2)} € → ${(ERNEUERBAREN_PAUSCHALE_NETTO * UST_FACTOR).toFixed(2)} €`);
    const fixNetto = AWATTAR_BASE_FEE_NETTO + OEKOSTROM_PAUSCHALE_NETTO + ERNEUERBAREN_PAUSCHALE_NETTO + capFee + meterFee;
    const fixBrutto = fixNetto * UST_FACTOR;
    lines.push(`- **Summe:** ${fixNetto.toFixed(2)} € → **${fixBrutto.toFixed(2)} € brutto/Monat**`);

    return lines.join('\n');
  }

  // ── API ────────────────────────────────────────────────────

  private async fetchMarketData(startMs?: number, endMs?: number): Promise<MarketDataEntry[]> {
    const params = new URLSearchParams();
    if (startMs != null) params.set('start', startMs.toString());
    if (endMs != null) params.set('end', endMs.toString());

    const url = params.toString() ? `${API_URL}?${params}` : API_URL;
    const res = await fetch(url, { signal: AbortSignal.timeout(10_000) });

    if (!res.ok) {
      const detail = await res.text().catch(() => '');
      throw new Error(`HTTP ${res.status} — ${detail.slice(0, 300)}`);
    }

    const json = (await res.json()) as MarketDataResponse;
    return json.data || [];
  }

  // ── Helpers ────────────────────────────────────────────────

  private formatHourRange(startMs: number, endMs: number): string {
    const s = new Date(startMs).toLocaleTimeString('de-AT', { hour: '2-digit', minute: '2-digit' });
    const e = new Date(endMs).toLocaleTimeString('de-AT', { hour: '2-digit', minute: '2-digit' });
    return `${s}–${e}`;
  }
}

interface PriceBreakdown {
  spotCt: number;
  ausgleichCt: number;
  aufschlagCt: number;
  energieNettoCt: number;
  netznutzungCt: number;
  netzverlustCt: number;
  eAbgabeCt: number;
  oekoArbeitCt: number;
  oekoVerlustCt: number;
  gesamtNettoCt: number;
  ustCt: number;
  bruttoCt: number;
  gridName: string;
  hasGrid: boolean;
}
