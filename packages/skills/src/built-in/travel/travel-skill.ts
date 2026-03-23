import type { SkillMetadata, SkillContext, SkillResult, TravelConfig } from '@alfred/types';
import type { TravelPlanRepository } from '@alfred/storage';
import { Skill } from '../../skill.js';
import { effectiveUserId } from '../../user-utils.js';
import type { TravelProvider, FlightResult, HotelResult } from './travel-provider.js';
import { KiwiProvider } from './kiwi-provider.js';
import { BookingProvider } from './booking-provider.js';

interface SearchCache {
  data: unknown;
  cachedAt: number;
}

function formatDuration(minutes: number): string {
  const h = Math.floor(minutes / 60);
  const m = minutes % 60;
  return h > 0 ? `${h}h ${m}min` : `${m}min`;
}

function formatPrice(price: number, currency: string): string {
  return `${price.toFixed(2)} ${currency}`;
}

export class TravelSkill extends Skill {
  readonly metadata: SkillMetadata = {
    name: 'travel',
    category: 'information',
    description:
      'Reise-Skill: Flugsuche (Kiwi/Tequila), Hotelsuche (Booking.com), Reisepläne mit Budget-Tracking. ' +
      'Actions: search_flights (Flug suchen), search_hotels (Hotel suchen), ' +
      'plan_create/plan_list/plan_get/plan_update/plan_delete (Reiseplan verwalten), ' +
      'plan_add_item/plan_remove_item (Flug/Hotel/Mietwagen/Aktivität zu Plan hinzufügen), ' +
      'plan_budget (Budget-Übersicht), plan_checklist (Pack-/Checkliste generieren). ' +
      'Flugsuche, Hotelsuche, Mietwagen, Urlaub, Reiseplan, Budget, Packliste, Buchung. ' +
      'Watch-kompatibel: search_flights → "cheapest_price"/"result_count", search_hotels → "cheapest_price"/"result_count".',
    riskLevel: 'read',
    version: '1.0.0',
    timeoutMs: 30_000,
    inputSchema: {
      type: 'object',
      properties: {
        action: {
          type: 'string',
          enum: [
            'search_flights', 'search_hotels',
            'plan_create', 'plan_list', 'plan_get', 'plan_update', 'plan_delete',
            'plan_add_item', 'plan_remove_item', 'plan_budget', 'plan_checklist',
          ],
          description: 'Aktion',
        },
        // Flight search params
        origin: { type: 'string', description: 'Abflugort (IATA-Code oder Stadtname)' },
        destination: { type: 'string', description: 'Zielort' },
        dateFrom: { type: 'string', description: 'Hinflug-Datum (YYYY-MM-DD)' },
        dateTo: { type: 'string', description: 'Hinflug bis-Datum (YYYY-MM-DD, default = dateFrom)' },
        returnFrom: { type: 'string', description: 'Rückflug ab (YYYY-MM-DD, leer = Einweg)' },
        returnTo: { type: 'string', description: 'Rückflug bis (YYYY-MM-DD)' },
        adults: { type: 'number', description: 'Anzahl Erwachsene (default: 1)' },
        maxStopovers: { type: 'number', description: 'Max Zwischenstopps' },
        currency: { type: 'string', description: 'Währung (default: EUR)' },
        sort: { type: 'string', description: 'Sortierung (price/duration/quality)' },
        limit: { type: 'number', description: 'Max Ergebnisse (default: 10)' },
        // Hotel search params
        checkinDate: { type: 'string', description: 'Check-in Datum (YYYY-MM-DD)' },
        checkoutDate: { type: 'string', description: 'Check-out Datum (YYYY-MM-DD)' },
        stars: { type: 'number', description: 'Sterne-Filter (1-5)' },
        priceMin: { type: 'number', description: 'Mindestpreis' },
        priceMax: { type: 'number', description: 'Höchstpreis' },
        // Plan params
        plan_id: { type: 'string', description: 'Reiseplan-ID' },
        item_id: { type: 'string', description: 'Plan-Element-ID' },
        budget: { type: 'number', description: 'Budget in EUR' },
        travelers: { type: 'number', description: 'Anzahl Reisende' },
        notes: { type: 'string', description: 'Notizen' },
        status: { type: 'string', enum: ['draft', 'booked', 'completed', 'cancelled'], description: 'Status' },
        // Plan item params
        item_type: { type: 'string', enum: ['flight', 'hotel', 'car', 'activity'], description: 'Element-Typ' },
        title: { type: 'string', description: 'Titel des Elements' },
        price: { type: 'number', description: 'Preis' },
        booking_ref: { type: 'string', description: 'Buchungsreferenz' },
        details_json: { type: 'string', description: 'Details als JSON-String' },
      },
      required: ['action'],
    },
  };

  private readonly providers: TravelProvider[] = [];
  private readonly searchCache = new Map<string, SearchCache>();
  private static readonly SEARCH_CACHE_TTL = 5 * 60 * 1000; // 5 min

  constructor(
    private readonly config?: TravelConfig,
    private readonly repos?: { plans: TravelPlanRepository },
  ) {
    super();
    if (config?.kiwi?.apiKey) {
      this.providers.push(new KiwiProvider(config.kiwi.apiKey));
    }
    if (config?.booking?.rapidApiKey) {
      this.providers.push(new BookingProvider(config.booking.rapidApiKey));
    }
  }

  async execute(params: Record<string, unknown>, context: SkillContext): Promise<SkillResult> {
    const action = params.action as string;
    const userId = effectiveUserId(context);

    try {
      switch (action) {
        case 'search_flights': return await this.searchFlights(params);
        case 'search_hotels': return await this.searchHotels(params);
        case 'plan_create': return await this.planCreate(userId, params);
        case 'plan_list': return await this.planList(userId, params);
        case 'plan_get': return await this.planGet(params);
        case 'plan_update': return await this.planUpdate(params);
        case 'plan_delete': return await this.planDelete(params);
        case 'plan_add_item': return await this.planAddItem(params);
        case 'plan_remove_item': return await this.planRemoveItem(params);
        case 'plan_budget': return await this.planBudget(params);
        case 'plan_checklist': return await this.planChecklist(params);
        default:
          return { success: false, error: `Unbekannte Aktion: ${action}` };
      }
    } catch (err: any) {
      // API failures are NOT skill failures — don't penalize SkillHealth
      return { success: false, error: err.message ?? String(err) };
    }
  }

  // ─── Search: Flights ────────────────────────────────────────────────

  private async searchFlights(params: Record<string, unknown>): Promise<SkillResult> {
    const provider = this.providers.find(p => p.type === 'flights') as KiwiProvider | undefined;
    if (!provider) return { success: false, error: 'Kein Flug-Provider konfiguriert. Bitte ALFRED_TRAVEL_KIWI_API_KEY setzen.' };

    const origin = (params.origin as string) ?? this.config?.defaultOrigin;
    if (!origin) return { success: false, error: 'Abflugort (origin) fehlt' };
    if (!params.destination) return { success: false, error: 'Zielort (destination) fehlt' };
    if (!params.dateFrom) return { success: false, error: 'Datum (dateFrom) fehlt' };

    const currency = (params.currency as string) ?? this.config?.defaultCurrency ?? 'EUR';

    // Check cache
    const cacheKey = `flights:${JSON.stringify({ ...params, origin, currency })}`;
    const cached = this.getFromCache(cacheKey);
    if (cached) return cached as SkillResult;

    const flights = await provider.search({ ...params, origin, currency }) as FlightResult[];

    const lines: string[] = [];
    if (flights.length === 0) {
      lines.push('Keine Flüge gefunden.');
    } else {
      lines.push(`**${flights.length} Flüge** ${origin} → ${params.destination}\n`);
      lines.push('| # | Airlines | Abflug | Ankunft | Dauer | Stopps | Preis | Link |');
      lines.push('|---|---------|--------|---------|-------|--------|-------|------|');
      for (let i = 0; i < flights.length; i++) {
        const f = flights[i];
        const dep = f.departure ? new Date(f.departure).toLocaleString('de-AT', { day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit' }) : '—';
        const arr = f.arrival ? new Date(f.arrival).toLocaleString('de-AT', { day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit' }) : '—';
        const link = f.deepLink ? `[Buchen](${f.deepLink})` : '—';
        lines.push(`| ${i + 1} | ${f.airlines.join(', ')} | ${dep} | ${arr} | ${formatDuration(f.duration)} | ${f.stopovers} | ${formatPrice(f.price, f.currency)} | ${link} |`);
      }
    }

    const cheapest = flights.length > 0 ? Math.min(...flights.map(f => f.price)) : null;

    const result: SkillResult = {
      success: true,
      data: {
        flights: flights.map(f => ({ id: f.id, airlines: f.airlines, price: f.price, duration: f.duration, stopovers: f.stopovers, deepLink: f.deepLink })),
        cheapest_price: cheapest,
        result_count: flights.length,
        origin,
        destination: params.destination,
        currency,
      },
      display: lines.join('\n'),
    };

    this.setCache(cacheKey, result);
    return result;
  }

  // ─── Search: Hotels ─────────────────────────────────────────────────

  private async searchHotels(params: Record<string, unknown>): Promise<SkillResult> {
    const provider = this.providers.find(p => p.type === 'hotels') as BookingProvider | undefined;
    if (!provider) return { success: false, error: 'Kein Hotel-Provider konfiguriert. Bitte ALFRED_TRAVEL_BOOKING_RAPID_API_KEY setzen.' };

    if (!params.destination) return { success: false, error: 'Zielort (destination) fehlt' };
    const checkin = (params.checkinDate ?? params.dateFrom) as string;
    const checkout = (params.checkoutDate ?? params.dateTo) as string;
    if (!checkin || !checkout) return { success: false, error: 'Check-in und Check-out Datum erforderlich' };

    const currency = (params.currency as string) ?? this.config?.defaultCurrency ?? 'EUR';

    // Check cache
    const cacheKey = `hotels:${JSON.stringify({ ...params, currency })}`;
    const cached = this.getFromCache(cacheKey);
    if (cached) return cached as SkillResult;

    const hotels = await provider.search({ ...params, checkinDate: checkin, checkoutDate: checkout, currency }) as HotelResult[];

    const lines: string[] = [];
    if (hotels.length === 0) {
      lines.push('Keine Hotels gefunden.');
    } else {
      lines.push(`**${hotels.length} Hotels** in ${params.destination}\n`);
      lines.push('| # | Hotel | Sterne | Bewertung | Preis/Nacht | Gesamt | Link |');
      lines.push('|---|-------|--------|-----------|-------------|--------|------|');
      for (let i = 0; i < hotels.length; i++) {
        const h = hotels[i];
        const name = h.name.length > 40 ? h.name.slice(0, 37) + '...' : h.name;
        const stars = h.stars ? '★'.repeat(h.stars) : '—';
        const rating = h.rating ? `${h.rating}${h.reviewScore ? ` (${h.reviewScore})` : ''}` : '—';
        const link = h.deepLink ? `[Buchen](${h.deepLink})` : '—';
        lines.push(`| ${i + 1} | ${name} | ${stars} | ${rating} | ${formatPrice(h.pricePerNight, h.currency)} | ${formatPrice(h.totalPrice, h.currency)} | ${link} |`);
      }
    }

    const cheapest = hotels.length > 0 ? Math.min(...hotels.map(h => h.totalPrice)) : null;

    const result: SkillResult = {
      success: true,
      data: {
        hotels: hotels.map(h => ({ id: h.id, name: h.name, stars: h.stars, rating: h.rating, pricePerNight: h.pricePerNight, totalPrice: h.totalPrice, deepLink: h.deepLink })),
        cheapest_price: cheapest,
        result_count: hotels.length,
        destination: params.destination,
        currency,
      },
      display: lines.join('\n'),
    };

    this.setCache(cacheKey, result);
    return result;
  }

  // ─── Plans: CRUD ────────────────────────────────────────────────────

  private ensureRepo(): TravelPlanRepository {
    if (!this.repos?.plans) throw new Error('TravelPlanRepository nicht verfügbar');
    return this.repos.plans;
  }

  private async planCreate(userId: string, params: Record<string, unknown>): Promise<SkillResult> {
    const repo = this.ensureRepo();
    if (!params.destination) return { success: false, error: 'Zielort (destination) fehlt' };
    if (!params.dateFrom || !params.dateTo) return { success: false, error: 'Reisezeitraum (dateFrom, dateTo) fehlt' };

    const plan = await repo.create(userId, {
      destination: params.destination as string,
      dateFrom: params.dateFrom as string,
      dateTo: params.dateTo as string,
      budget: params.budget as number | undefined,
      travelers: params.travelers as number | undefined,
      notes: params.notes as string | undefined,
    });

    return {
      success: true,
      data: plan,
      display: `Reiseplan erstellt: **${plan.destination}** (${plan.dateFrom} bis ${plan.dateTo})${plan.budget ? ` — Budget: ${plan.budget} EUR` : ''}\nID: ${plan.id}`,
    };
  }

  private async planList(userId: string, params: Record<string, unknown>): Promise<SkillResult> {
    const repo = this.ensureRepo();
    const plans = await repo.list(userId, params.status as string | undefined);

    if (plans.length === 0) {
      return { success: true, data: { plans: [], count: 0 }, display: 'Keine Reisepläne vorhanden.' };
    }

    const lines = ['**Reisepläne:**\n'];
    for (const p of plans) {
      const budget = p.budget ? ` | Budget: ${p.budgetSpent.toFixed(0)}/${p.budget.toFixed(0)} EUR` : '';
      lines.push(`- **${p.destination}** (${p.dateFrom} – ${p.dateTo}) [${p.status}]${budget} — ID: \`${p.id.slice(0, 8)}\``);
    }

    return { success: true, data: { plans, count: plans.length }, display: lines.join('\n') };
  }

  private async planGet(params: Record<string, unknown>): Promise<SkillResult> {
    const repo = this.ensureRepo();
    const planId = params.plan_id as string;
    if (!planId) return { success: false, error: 'plan_id fehlt' };

    const plan = await repo.get(planId);
    if (!plan) return { success: false, error: 'Reiseplan nicht gefunden' };

    const lines = [`**${plan.destination}** — ${plan.dateFrom} bis ${plan.dateTo} [${plan.status}]`];
    if (plan.budget) lines.push(`Budget: ${plan.budgetSpent.toFixed(2)} / ${plan.budget.toFixed(2)} EUR`);
    if (plan.travelers > 1) lines.push(`Reisende: ${plan.travelers}`);
    if (plan.notes) lines.push(`Notizen: ${plan.notes}`);

    if (plan.items.length > 0) {
      lines.push('\n**Elemente:**');
      for (const item of plan.items) {
        const price = item.price != null ? ` — ${item.price.toFixed(2)} ${item.currency}` : '';
        const dates = item.dateFrom ? ` (${item.dateFrom}${item.dateTo ? ' – ' + item.dateTo : ''})` : '';
        const ref = item.bookingRef ? ` [Ref: ${item.bookingRef}]` : '';
        lines.push(`- [${item.type}] ${item.title}${dates}${price}${ref}`);
      }
    }

    return { success: true, data: plan, display: lines.join('\n') };
  }

  private async planUpdate(params: Record<string, unknown>): Promise<SkillResult> {
    const repo = this.ensureRepo();
    const planId = params.plan_id as string;
    if (!planId) return { success: false, error: 'plan_id fehlt' };

    const fields: Record<string, unknown> = {};
    for (const key of ['destination', 'dateFrom', 'dateTo', 'budget', 'travelers', 'status', 'notes']) {
      if (params[key] !== undefined) fields[key] = params[key];
    }

    const updated = await repo.update(planId, fields as any);
    if (!updated) return { success: false, error: 'Reiseplan nicht gefunden oder keine Änderungen' };

    return { success: true, data: { planId, updated: fields }, display: `Reiseplan aktualisiert.` };
  }

  private async planDelete(params: Record<string, unknown>): Promise<SkillResult> {
    const repo = this.ensureRepo();
    const planId = params.plan_id as string;
    if (!planId) return { success: false, error: 'plan_id fehlt' };

    const deleted = await repo.delete(planId);
    if (!deleted) return { success: false, error: 'Reiseplan nicht gefunden' };

    return { success: true, data: { planId }, display: 'Reiseplan gelöscht.' };
  }

  private async planAddItem(params: Record<string, unknown>): Promise<SkillResult> {
    const repo = this.ensureRepo();
    const planId = params.plan_id as string;
    if (!planId) return { success: false, error: 'plan_id fehlt' };
    if (!params.item_type) return { success: false, error: 'item_type fehlt (flight/hotel/car/activity)' };
    if (!params.title) return { success: false, error: 'title fehlt' };

    const item = await repo.addItem(planId, {
      type: params.item_type as string,
      title: params.title as string,
      dateFrom: params.dateFrom as string | undefined,
      dateTo: params.dateTo as string | undefined,
      price: params.price as number | undefined,
      currency: (params.currency as string) ?? this.config?.defaultCurrency ?? 'EUR',
      detailsJson: params.details_json as string | undefined,
      bookingRef: params.booking_ref as string | undefined,
    });

    return {
      success: true,
      data: item,
      display: `Element hinzugefügt: [${item.type}] ${item.title}${item.price != null ? ` — ${item.price.toFixed(2)} ${item.currency}` : ''}`,
    };
  }

  private async planRemoveItem(params: Record<string, unknown>): Promise<SkillResult> {
    const repo = this.ensureRepo();
    const itemId = params.item_id as string;
    if (!itemId) return { success: false, error: 'item_id fehlt' };

    const removed = await repo.removeItem(itemId);
    if (!removed) return { success: false, error: 'Element nicht gefunden' };

    return { success: true, data: { itemId }, display: 'Element entfernt.' };
  }

  private async planBudget(params: Record<string, unknown>): Promise<SkillResult> {
    const repo = this.ensureRepo();
    const planId = params.plan_id as string;
    if (!planId) return { success: false, error: 'plan_id fehlt' };

    const plan = await repo.get(planId);
    if (!plan) return { success: false, error: 'Reiseplan nicht gefunden' };

    const lines = [`**Budget-Übersicht: ${plan.destination}**\n`];

    if (plan.budget) {
      const remaining = plan.budget - plan.budgetSpent;
      const pct = Math.round((plan.budgetSpent / plan.budget) * 100);
      lines.push(`Budget: ${plan.budget.toFixed(2)} EUR`);
      lines.push(`Ausgegeben: ${plan.budgetSpent.toFixed(2)} EUR (${pct}%)`);
      lines.push(`Verbleibend: ${remaining.toFixed(2)} EUR`);
      if (remaining < 0) lines.push('**Achtung: Budget überschritten!**');
    } else {
      lines.push(`Gesamtkosten: ${plan.budgetSpent.toFixed(2)} EUR`);
      lines.push('Kein Budget festgelegt.');
    }

    if (plan.items.length > 0) {
      lines.push('\n**Aufschlüsselung:**');
      const byType = new Map<string, number>();
      for (const item of plan.items) {
        if (item.price != null) {
          byType.set(item.type, (byType.get(item.type) ?? 0) + item.price);
        }
      }
      for (const [type, total] of byType) {
        lines.push(`- ${type}: ${total.toFixed(2)} EUR`);
      }
    }

    return {
      success: true,
      data: {
        budget: plan.budget,
        budgetSpent: plan.budgetSpent,
        remaining: plan.budget ? plan.budget - plan.budgetSpent : null,
        items: plan.items.length,
      },
      display: lines.join('\n'),
    };
  }

  private async planChecklist(params: Record<string, unknown>): Promise<SkillResult> {
    const repo = this.ensureRepo();
    const planId = params.plan_id as string;
    if (!planId) return { success: false, error: 'plan_id fehlt' };

    const plan = await repo.get(planId);
    if (!plan) return { success: false, error: 'Reiseplan nicht gefunden' };

    const hasFlights = plan.items.some(i => i.type === 'flight');
    const hasHotels = plan.items.some(i => i.type === 'hotel');
    const hasCar = plan.items.some(i => i.type === 'car');

    const lines = [`**Checkliste: ${plan.destination}** (${plan.dateFrom} – ${plan.dateTo})\n`];

    // Documents
    lines.push('**Dokumente:**');
    lines.push('- [ ] Reisepass / Personalausweis (Gültigkeit prüfen!)');
    if (hasFlights) {
      lines.push('- [ ] Boarding-Pässe');
      lines.push('- [ ] Flugbuchungsbestätigung');
    }
    if (hasHotels) lines.push('- [ ] Hotelbuchungsbestätigung');
    if (hasCar) lines.push('- [ ] Führerschein + Mietwagen-Buchung');
    lines.push('- [ ] Reiseversicherung');
    lines.push('- [ ] Kreditkarte / Bargeld');

    // Packing
    lines.push('\n**Packliste (Grundausstattung):**');
    lines.push('- [ ] Kleidung (Tage: ' + this.daysBetween(plan.dateFrom, plan.dateTo) + ')');
    lines.push('- [ ] Toilettenartikel');
    lines.push('- [ ] Ladegeräte (Handy, Laptop)');
    lines.push('- [ ] Adapter / Steckdosen');
    lines.push('- [ ] Medikamente');
    lines.push('- [ ] Sonnenschutz');

    // Preparation
    lines.push('\n**Vorbereitung:**');
    lines.push('- [ ] Check-in online (24h vorher)');
    lines.push('- [ ] Wohnung: Heizung/Fenster/Müll');
    lines.push('- [ ] Haustier-/Pflanzenversorgung');
    lines.push('- [ ] Bank informieren (Auslandsreise)');

    const checklist = lines.join('\n');

    return {
      success: true,
      data: {
        destination: plan.destination,
        dateFrom: plan.dateFrom,
        dateTo: plan.dateTo,
        days: this.daysBetween(plan.dateFrom, plan.dateTo),
        hasFlights,
        hasHotels,
        hasCar,
      },
      display: checklist,
    };
  }

  // ─── Helpers ────────────────────────────────────────────────────────

  private daysBetween(from: string, to: string): number {
    return Math.max(1, Math.round((new Date(to).getTime() - new Date(from).getTime()) / 86_400_000));
  }

  private getFromCache(key: string): unknown | null {
    const entry = this.searchCache.get(key);
    if (entry && Date.now() - entry.cachedAt < TravelSkill.SEARCH_CACHE_TTL) {
      return entry.data;
    }
    if (entry) this.searchCache.delete(key);
    return null;
  }

  private setCache(key: string, data: unknown): void {
    // Keep cache bounded
    if (this.searchCache.size > 100) {
      const oldest = [...this.searchCache.entries()].sort((a, b) => a[1].cachedAt - b[1].cachedAt);
      for (let i = 0; i < 50; i++) this.searchCache.delete(oldest[i][0]);
    }
    this.searchCache.set(key, { data, cachedAt: Date.now() });
  }
}
