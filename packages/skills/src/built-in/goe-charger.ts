import type { SkillMetadata, SkillContext, SkillResult, GoeChargerConfig, EnergyPriceConfig } from '@alfred/types';
import { Skill } from '../skill.js';

type Action =
  | 'status' | 'start' | 'stop' | 'set_amp' | 'set_phases' | 'phase_status'
  | 'set_mode' | 'get_mode' | 'set_eco' | 'set_energy_limit'
  | 'set_next_trip' | 'get_next_trip' | 'energy';

const CAR_STATUS: Record<number, string> = { 1: 'kein Auto', 2: 'lädt', 3: 'wartet', 4: 'fertig' };
const LMO_LABELS: Record<number, string> = { 0: 'Aus', 1: 'PV', 2: 'Min-SoC', 3: 'Zeitgesteuert', 4: 'PV-Überschuss' };
const PSM_LABELS: Record<number, string> = { 0: 'Einphasig', 1: 'Auto', 2: 'Dreiphasig' };
const ERR_LABELS: Record<number, string> = { 1: 'FI-Schutzschalter!', 3: 'Phasenfehler', 8: 'Erdung fehlt', 10: 'Interner Fehler' };

export class GoeChargerSkill extends Skill {
  private apiVersion?: 1 | 2;

  readonly metadata: SkillMetadata = {
    name: 'goe_charger',
    description:
      'go-e Wallbox steuern: Ladestatus, Laden starten/stoppen, Ampere setzen, ' +
      'Phasenumschaltung (1/3-phasig), Lademodi (PV-Überschuss, Eco, Zeitgesteuert), ' +
      'Energielimit, Trip-Planung. Wallbox, Laden, Ladestrom, Ampere, kWh, E-Auto, ' +
      'Elektroauto, Ladestation, Charger, PV, Solar, Photovoltaik, Überschuss.',
    version: '1.0.0',
    riskLevel: 'write',
    category: 'infrastructure',
    timeoutMs: 15_000,
    inputSchema: {
      type: 'object',
      required: ['action'],
      properties: {
        action: {
          type: 'string',
          enum: [
            'status', 'start', 'stop', 'set_amp', 'set_phases', 'phase_status',
            'set_mode', 'get_mode', 'set_eco', 'set_energy_limit',
            'set_next_trip', 'get_next_trip', 'energy',
          ],
          description: 'Wallbox-Aktion',
        },
        amp: { type: 'number', description: 'Ladestrom 6-32A' },
        phases: { type: 'number', enum: [1, 3], description: 'Phasen: 1 oder 3' },
        mode: {
          type: 'string',
          enum: ['off', 'pv', 'min_soc', 'scheduled', 'pv_surplus', 'single', 'auto', 'three'],
          description: 'Lademodus oder Phasenmodus',
        },
        enabled: { type: 'boolean', description: 'Eco/aWATTar aktivieren' },
        max_price: {
          type: 'number',
          description: 'Max Strompreis in ct/kWh (Endpreis brutto — wird automatisch in Marktpreis umgerechnet)',
        },
        kwh: { type: 'number', description: 'Energielimit in kWh (null = unbegrenzt)' },
        departure: { type: 'string', description: 'Nächste Abfahrt (ISO datetime)' },
      },
    },
  };

  constructor(
    private readonly config: GoeChargerConfig,
    private readonly energyConfig?: EnergyPriceConfig,
  ) {
    super();
  }

  // ── API Helpers ────────────────────────────────────────────

  private async detectApiVersion(): Promise<1 | 2> {
    if (this.apiVersion) return this.apiVersion;
    try {
      const res = await fetch(`http://${this.config.host}/api/status?filter=car`, {
        signal: AbortSignal.timeout(5000),
      });
      if (res.ok) {
        this.apiVersion = 2;
        return 2;
      }
    } catch { /* ignore */ }
    try {
      const res = await fetch(`http://${this.config.host}/status`, {
        signal: AbortSignal.timeout(5000),
      });
      if (res.ok) {
        this.apiVersion = 1;
        return 1;
      }
    } catch { /* ignore */ }
    throw new Error(`go-e Wallbox unter ${this.config.host} nicht erreichbar.`);
  }

  private async getStatus(filter?: string): Promise<Record<string, unknown>> {
    const v = await this.detectApiVersion();
    const base = v === 2
      ? `http://${this.config.host}/api/status`
      : `http://${this.config.host}/status`;
    const url = filter && v === 2 ? `${base}?filter=${filter}` : base;
    const res = await fetch(url, { signal: AbortSignal.timeout(10_000) });
    if (!res.ok) throw new Error(`go-e API Fehler: ${res.status}`);
    return res.json() as Promise<Record<string, unknown>>;
  }

  private async setParam(params: Record<string, unknown>): Promise<void> {
    const v = await this.detectApiVersion();
    if (v === 2) {
      const qs = Object.entries(params)
        .map(([k, val]) => `${k}=${typeof val === 'string' ? `"${val}"` : val}`)
        .join('&');
      const res = await fetch(`http://${this.config.host}/api/set?${qs}`, {
        signal: AbortSignal.timeout(10_000),
      });
      if (!res.ok) throw new Error(`go-e set Fehler: ${res.status}`);
    } else {
      // API v1: use /mqtt?payload=
      const qs = Object.entries(params).map(([k, val]) => `${k}=${val}`).join('&');
      const res = await fetch(
        `http://${this.config.host}/mqtt?payload=${encodeURIComponent(qs)}`,
        { signal: AbortSignal.timeout(10_000) },
      );
      if (!res.ok) throw new Error(`go-e set Fehler: ${res.status}`);
    }
  }

  private requireV2(action: string): SkillResult | null {
    if (this.apiVersion === 1) {
      return {
        success: false,
        error: `"${action}" benötigt go-e Charger V3+ mit API v2. Deine Wallbox unterstützt nur Basis-Funktionen (status, start, stop, set_amp, energy).`,
      };
    }
    return null;
  }

  // ── Price Conversion ───────────────────────────────────────

  private userPriceToMarketPrice(endpreisCt: number): number {
    const netzCt = this.energyConfig?.gridUsageCt ?? 8.79;
    const lossCt = this.energyConfig?.gridLossCt ?? 0.38;
    const abgabenCt = 0.10 + 0.58 + 0.04; // Elektrizitätsabgabe + Ökostrom Arbeit + Verlust
    const awattarCt = 1.5;
    const ustFactor = 1.20;
    return Math.max(0, (endpreisCt / ustFactor) - netzCt - lossCt - abgabenCt - awattarCt);
  }

  // ── Execute ────────────────────────────────────────────────

  async execute(input: Record<string, unknown>, _ctx: SkillContext): Promise<SkillResult> {
    const action = input.action as Action;
    try {
      switch (action) {
        case 'status': return await this.handleStatus();
        case 'start': return await this.handleStart(input);
        case 'stop': return await this.handleStop();
        case 'set_amp': return await this.handleSetAmp(input);
        case 'set_phases': return await this.handleSetPhases(input);
        case 'phase_status': return await this.handlePhaseStatus();
        case 'set_mode': return await this.handleSetMode(input);
        case 'get_mode': return await this.handleGetMode();
        case 'set_eco': return await this.handleSetEco(input);
        case 'set_energy_limit': return await this.handleSetEnergyLimit(input);
        case 'set_next_trip': return await this.handleSetNextTrip(input);
        case 'get_next_trip': return await this.handleGetNextTrip();
        case 'energy': return await this.handleEnergy();
        default:
          return { success: false, error: `Unbekannte Aktion: ${action}` };
      }
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      // Network errors should not count as skill failures
      if (msg.includes('nicht erreichbar') || msg.includes('fetch') || msg.includes('ECONNREFUSED') || msg.includes('timeout')) {
        return { success: false, error: `Wallbox nicht erreichbar. Prüfe LAN-Verbindung zu ${this.config.host}.`, skipHealthTracking: true } as SkillResult & { skipHealthTracking: boolean };
      }
      return { success: false, error: msg };
    }
  }

  // ── Status ─────────────────────────────────────────────────

  private async handleStatus(): Promise<SkillResult> {
    const data = await this.getStatus('car,alw,amp,nrg,eto,dws,err,tma,cbl,pha,psm,lmo,frc,tmp');

    const carStatus = CAR_STATUS[data.car as number] ?? 'unbekannt';
    const nrg = (data.nrg ?? []) as number[];
    const powerKw = nrg[11] ? (nrg[11] / 1000).toFixed(1) : '0';
    const sessionKwh = data.dws ? ((data.dws as number) / 3600000).toFixed(1) : '0';
    const totalKwh = data.eto ? ((data.eto as number) / 10).toFixed(1) : '0';
    const temp = Array.isArray(data.tma) ? `${data.tma[0]}°C` : (data.tmp ? `${data.tmp}°C` : '?');
    const phases = data.pha as number ?? 0;
    const phaseCount = (phases & 0x38) ? 3 : 1; // bits 3-5 = phases after contactor
    const psmMode = PSM_LABELS[data.psm as number] ?? '?';
    const lmoMode = LMO_LABELS[data.lmo as number] ?? '?';
    const errCode = data.err as number | undefined;
    const errMsg = errCode && errCode !== 0
      ? ERR_LABELS[errCode] ?? `Fehler ${errCode}`
      : null;

    const lines = [
      '**Wallbox Status:**',
      `Auto: ${carStatus}${data.car === 2 ? ` | ${powerKw} kW` : ''}`,
      `Ampere: ${data.amp}A | Phasen: ${phaseCount} (${psmMode})`,
      `Modus: ${lmoMode}`,
      `Session: ${sessionKwh} kWh | Gesamt: ${totalKwh} kWh`,
      `Temperatur: ${temp}`,
    ];
    if (errMsg) lines.push(`WARNUNG: ${errMsg}`);

    return {
      success: true,
      data: {
        car_status: carStatus,
        charging: data.car === 2,
        power_kw: parseFloat(powerKw),
        amp: data.amp,
        phase_count: phaseCount,
        phase_mode: psmMode.toLowerCase(),
        charge_mode: lmoMode.toLowerCase(),
        session_kwh: parseFloat(sessionKwh),
        total_kwh: parseFloat(totalKwh),
        temperature: Array.isArray(data.tma) ? data.tma[0] : data.tmp,
        error: errMsg,
      },
      display: lines.join('\n'),
    };
  }

  // ── Start / Stop ───────────────────────────────────────────

  private async handleStart(input: Record<string, unknown>): Promise<SkillResult> {
    const v = await this.detectApiVersion();
    const amp = input.amp as number | undefined;

    if (amp !== undefined) {
      if (amp < 6 || amp > 32) {
        return { success: false, error: 'Ampere muss zwischen 6 und 32 sein.' };
      }
    }

    if (v === 2) {
      await this.setParam({ frc: 1 });
      if (amp) await this.setParam({ amp });
    } else {
      // v1: alw=1 for allow charging
      if (amp) {
        await this.setParam({ alw: 1, amx: amp });
      } else {
        await this.setParam({ alw: 1 });
      }
    }

    const display = amp ? `Laden gestartet mit ${amp}A.` : 'Laden gestartet.';
    return { success: true, data: { started: true, amp }, display };
  }

  private async handleStop(): Promise<SkillResult> {
    const v = await this.detectApiVersion();
    if (v === 2) {
      await this.setParam({ frc: 2 });
    } else {
      // v1: alw=0 for disallow charging
      await this.setParam({ alw: 0 });
    }
    return { success: true, data: { stopped: true }, display: 'Laden gestoppt.' };
  }

  // ── Set Ampere ─────────────────────────────────────────────

  private async handleSetAmp(input: Record<string, unknown>): Promise<SkillResult> {
    const amp = input.amp as number | undefined;
    if (amp === undefined || amp < 6 || amp > 32) {
      return { success: false, error: 'Ampere muss zwischen 6 und 32 sein.' };
    }
    const v = await this.detectApiVersion();
    if (v === 2) {
      await this.setParam({ amp });
    } else {
      await this.setParam({ amx: amp });
    }
    return { success: true, data: { amp }, display: `Ladestrom auf ${amp}A gesetzt.` };
  }

  // ── Phases ─────────────────────────────────────────────────

  private async handleSetPhases(input: Record<string, unknown>): Promise<SkillResult> {
    const check = this.requireV2('set_phases');
    if (check) return check;

    const mode = input.mode as string | undefined;
    const phases = input.phases as number | undefined;

    let psm: number;
    if (mode === 'single' || phases === 1) psm = 0;
    else if (mode === 'auto') psm = 1;
    else if (mode === 'three' || phases === 3) psm = 2;
    else return { success: false, error: 'Ungültig. mode: single/auto/three oder phases: 1/3.' };

    await this.setParam({ psm });
    const label = PSM_LABELS[psm]!;
    const kwHint = psm === 0 ? ' (~3,7 kW bei 16A)' : psm === 2 ? ' (~11 kW bei 16A)' : '';
    return {
      success: true,
      data: { psm, mode: label.toLowerCase() },
      display: `Phasenmodus auf ${label} gesetzt${kwHint}.`,
    };
  }

  private async handlePhaseStatus(): Promise<SkillResult> {
    const check = this.requireV2('phase_status');
    if (check) return check;

    const data = await this.getStatus('pha,psm,pnp');
    const phases = data.pha as number ?? 0;
    const psm = data.psm as number ?? 0;
    const pnp = data.pnp as number ?? 0; // phase-neutral pairing
    const activeBefore = phases & 0x07; // bits 0-2: before contactor
    const activeAfter = (phases >> 3) & 0x07; // bits 3-5: after contactor
    const phaseCount = activeAfter ? (activeAfter === 7 ? 3 : 1) : 1;
    const switchable = pnp !== 0;

    return {
      success: true,
      data: {
        phase_count: phaseCount,
        phase_mode: PSM_LABELS[psm]?.toLowerCase() ?? 'unbekannt',
        phases_before_contactor: activeBefore,
        phases_after_contactor: activeAfter,
        switchable,
      },
      display: [
        `**Phasen-Status:**`,
        `Aktive Phasen: ${phaseCount} (${PSM_LABELS[psm] ?? '?'})`,
        `Vor Schütz: ${activeBefore.toString(2).padStart(3, '0')} | Nach Schütz: ${activeAfter.toString(2).padStart(3, '0')}`,
        `Umschaltbar: ${switchable ? 'Ja' : 'Nein'}`,
      ].join('\n'),
    };
  }

  // ── Charge Modes ───────────────────────────────────────────

  private async handleSetMode(input: Record<string, unknown>): Promise<SkillResult> {
    const check = this.requireV2('set_mode');
    if (check) return check;

    const mode = input.mode as string | undefined;
    const modeMap: Record<string, number> = {
      off: 0, pv: 1, min_soc: 2, scheduled: 3, pv_surplus: 4,
    };
    const lmo = mode ? modeMap[mode] : undefined;
    if (lmo === undefined) {
      return { success: false, error: 'Ungültiger Modus. Erlaubt: off, pv, min_soc, scheduled, pv_surplus.' };
    }

    await this.setParam({ lmo });
    const label = LMO_LABELS[lmo]!;
    const hints: Record<number, string> = {
      0: '',
      1: ' Lädt nur bei PV-Ertrag.',
      2: ' Mindest-Ladung sicherstellen, dann PV.',
      3: ' Lädt zum günstigsten Zeitpunkt.',
      4: ' Lädt nur bei Solarertrag.',
    };
    return {
      success: true,
      data: { lmo, mode: label.toLowerCase() },
      display: `Lademodus: ${label}.${hints[lmo] ?? ''}`,
    };
  }

  private async handleGetMode(): Promise<SkillResult> {
    // Works on both v1 and v2 (lmo may be absent on v1, fall back gracefully)
    const data = await this.getStatus('lmo');
    const lmo = data.lmo as number | undefined;
    if (lmo === undefined) {
      return { success: true, data: { mode: 'unbekannt' }, display: 'Lademodus: nicht verfügbar (API v1).' };
    }
    const label = LMO_LABELS[lmo] ?? 'Unbekannt';
    return {
      success: true,
      data: { lmo, mode: label.toLowerCase() },
      display: `Aktueller Lademodus: ${label}.`,
    };
  }

  // ── Eco / aWATTar ──────────────────────────────────────────

  private async handleSetEco(input: Record<string, unknown>): Promise<SkillResult> {
    const check = this.requireV2('set_eco');
    if (check) return check;

    const enabled = input.enabled as boolean | undefined;
    const maxPrice = input.max_price as number | undefined;

    if (enabled === false) {
      await this.setParam({ awe: false });
      return { success: true, data: { enabled: false }, display: 'aWATTar Eco-Laden deaktiviert.' };
    }

    const params: Record<string, unknown> = { awe: true };
    let priceDisplay = '';
    if (maxPrice !== undefined) {
      const marketPrice = this.userPriceToMarketPrice(maxPrice);
      params.awp = Math.round(marketPrice * 10) / 10; // round to 1 decimal
      priceDisplay = ` | Max ${maxPrice} ct/kWh brutto (= ${params.awp} ct Marktpreis)`;
    }

    await this.setParam(params);
    return {
      success: true,
      data: { enabled: true, max_price_gross: maxPrice, max_price_market: params.awp },
      display: `aWATTar Eco-Laden aktiviert${priceDisplay}.`,
    };
  }

  // ── Energy Limit ───────────────────────────────────────────

  private async handleSetEnergyLimit(input: Record<string, unknown>): Promise<SkillResult> {
    const check = this.requireV2('set_energy_limit');
    if (check) return check;

    const kwh = input.kwh as number | null | undefined;
    if (kwh === null || kwh === undefined || kwh === 0) {
      await this.setParam({ dwo: 0 });
      return { success: true, data: { kwh: null }, display: 'Energielimit aufgehoben (unbegrenzt).' };
    }
    if (kwh < 0.1 || kwh > 200) {
      return { success: false, error: 'Energielimit muss zwischen 0.1 und 200 kWh liegen.' };
    }
    const wh = Math.round(kwh * 1000);
    await this.setParam({ dwo: wh });
    return {
      success: true,
      data: { kwh, wh },
      display: `Energielimit auf ${kwh} kWh gesetzt. Laden stoppt automatisch.`,
    };
  }

  // ── Trip Planning ──────────────────────────────────────────

  private async handleSetNextTrip(input: Record<string, unknown>): Promise<SkillResult> {
    const check = this.requireV2('set_next_trip');
    if (check) return check;

    const departure = input.departure as string | undefined;
    if (!departure) {
      return { success: false, error: 'departure ist erforderlich (ISO datetime, z.B. "2026-03-28T07:00:00").' };
    }
    const dt = new Date(departure);
    if (isNaN(dt.getTime())) {
      return { success: false, error: 'Ungültiges Datum. Format: ISO datetime (z.B. "2026-03-28T07:00:00").' };
    }
    await this.setParam({ dto: dt.toISOString() });
    const formatted = dt.toLocaleString('de-AT', {
      weekday: 'short', day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit',
    });
    return {
      success: true,
      data: { departure: dt.toISOString() },
      display: `Nächste Abfahrt: ${formatted}. Wallbox plant Ladung rechtzeitig.`,
    };
  }

  private async handleGetNextTrip(): Promise<SkillResult> {
    const check = this.requireV2('get_next_trip');
    if (check) return check;

    const data = await this.getStatus('dto');
    const dto = data.dto as string | undefined;
    if (!dto) {
      return { success: true, data: { departure: null }, display: 'Keine Abfahrt geplant.' };
    }
    const dt = new Date(dto);
    const formatted = dt.toLocaleString('de-AT', {
      weekday: 'short', day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit',
    });
    return {
      success: true,
      data: { departure: dto },
      display: `Nächste geplante Abfahrt: ${formatted}.`,
    };
  }

  // ── Energy Stats ───────────────────────────────────────────

  private async handleEnergy(): Promise<SkillResult> {
    const data = await this.getStatus('eto,dws,nrg');

    const totalKwh = data.eto ? (data.eto as number) / 10 : 0;
    const sessionKwh = data.dws ? (data.dws as number) / 3600000 : 0;
    const nrg = (data.nrg ?? []) as number[];
    const powerKw = nrg[11] ? nrg[11] / 1000 : 0;

    // Estimate cost based on average energy price if available
    const avgPriceCt = this.energyConfig?.gridUsageCt
      ? (this.energyConfig.gridUsageCt + (this.energyConfig.gridLossCt ?? 0) + 0.72 + 1.5 + 5) * 1.20
      : null;
    const sessionCost = avgPriceCt ? (sessionKwh * avgPriceCt / 100) : null;

    const lines = [
      '**Energie-Statistik:**',
      `Gesamt: ${totalKwh.toFixed(1)} kWh`,
      `Aktuelle Session: ${sessionKwh.toFixed(1)} kWh`,
      `Aktuelle Leistung: ${powerKw.toFixed(1)} kW`,
    ];
    if (sessionCost !== null) {
      lines.push(`Geschätzte Session-Kosten: ~${sessionCost.toFixed(2)} EUR`);
    }

    return {
      success: true,
      data: {
        total_kwh: parseFloat(totalKwh.toFixed(1)),
        session_kwh: parseFloat(sessionKwh.toFixed(1)),
        power_kw: parseFloat(powerKw.toFixed(1)),
        estimated_session_cost_eur: sessionCost ? parseFloat(sessionCost.toFixed(2)) : null,
      },
      display: lines.join('\n'),
    };
  }
}
