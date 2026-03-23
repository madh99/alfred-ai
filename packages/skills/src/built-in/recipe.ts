import type { SkillMetadata, SkillContext, SkillResult } from '@alfred/types';
import type { RecipeConfig } from '@alfred/types';
import type { RecipeFavoriteRepository, RecipeFavorite } from '@alfred/storage';
import type { MealPlanRepository, MealPlanEntry } from '@alfred/storage';
import type { AlfredUserRepository } from '@alfred/storage';
import { Skill } from '../skill.js';
import { effectiveUserId } from '../user-utils.js';

// ── Error types ────────────────────────────────────────────

class ApiKeyError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ApiKeyError';
  }
}

class RateLimitError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'RateLimitError';
  }
}

// ── Types ──────────────────────────────────────────────────

interface RecipePreferences {
  diet?: string;
  intolerances?: string[];
  excludeIngredients?: string[];
  defaultServings?: number;
  cuisine?: string;
}

interface IngredientItem {
  name: string;
  amount: number;
  unit: string;
  category?: string;
}

// ── Constants ──────────────────────────────────────────────

const SPOONACULAR_BASE = 'https://api.spoonacular.com';
const EDAMAM_BASE = 'https://api.edamam.com';
const OFF_BASE = 'https://world.openfoodfacts.org';

const INGREDIENT_CATEGORIES: Record<string, string[]> = {
  produce: ['tomato', 'onion', 'garlic', 'pepper', 'lettuce', 'carrot', 'potato', 'broccoli', 'spinach', 'cucumber', 'zucchini', 'mushroom', 'celery', 'lemon', 'lime', 'apple', 'banana', 'avocado', 'herb', 'basil', 'parsley', 'cilantro', 'mint', 'thyme', 'rosemary', 'ginger', 'chili'],
  dairy: ['milk', 'cheese', 'butter', 'cream', 'yogurt', 'egg', 'mozzarella', 'parmesan', 'cheddar', 'sour cream', 'ricotta'],
  meat: ['chicken', 'beef', 'pork', 'lamb', 'turkey', 'bacon', 'sausage', 'ham', 'steak', 'ground', 'fish', 'salmon', 'tuna', 'shrimp', 'prawn'],
  pantry: ['flour', 'sugar', 'salt', 'pepper', 'oil', 'vinegar', 'soy sauce', 'pasta', 'rice', 'bread', 'noodle', 'stock', 'broth', 'can', 'sauce', 'honey', 'mustard', 'ketchup', 'spice', 'cumin', 'paprika', 'cinnamon', 'bean', 'lentil', 'chickpea', 'nut', 'almond', 'walnut'],
};

const DAYS_OF_WEEK = ['monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday', 'sunday'];
const MEALS = ['breakfast', 'lunch', 'dinner', 'snack'];

// ── RecipeSkill ────────────────────────────────────────────

export class RecipeSkill extends Skill {
  private cache = new Map<string, { data: unknown; expiresAt: number }>();
  private readonly CACHE_TTL = 60_000;
  private readonly DETAIL_CACHE_TTL = 3_600_000;

  readonly metadata: SkillMetadata = {
    name: 'recipe',
    description:
      'Rezeptsuche, Kochen, Meal-Planning und Nährwert-Infos. ' +
      'Suche Rezepte nach Zutaten, Name oder Küche. Verwalte Wochenpläne und Favoriten. ' +
      'Einkaufslisten werden über die bestehenden todo/microsoft_todo Skills erstellt. ' +
      'Nährwert-Daten für Zutaten via Open Food Facts. ' +
      'Diät-Einstellungen (vegetarisch, vegan, Allergien) pro User konfigurierbar. ' +
      'WICHTIG: Die API liefert englische Rezeptnamen — übersetze Rezeptnamen, Zutaten und ' +
      'Zubereitungsschritte IMMER in die Sprache des Users (aus dem Profil). ' +
      'Keywords: Rezept, kochen, Zutat, Ernährung, Diät, Einkaufsliste, Nährwert, Wochenplan, Mahlzeit, Frühstück, Mittagessen, Abendessen.',
    version: '1.0.0',
    riskLevel: 'write',
    category: 'productivity',
    timeoutMs: 30_000,
    inputSchema: {
      type: 'object',
      properties: {
        action: {
          type: 'string',
          enum: ['search', 'detail', 'nutrition', 'random', 'favorites', 'meal_plan', 'shopping_list', 'preferences'],
          description: 'Aktion: search (Rezeptsuche), detail (Rezeptdetails), nutrition (Nährwerte), random (Zufallsrezept), favorites (Favoriten verwalten), meal_plan (Wochenplan), shopping_list (Einkaufsliste), preferences (Diät-Einstellungen)',
        },
        query: {
          type: 'string',
          description: 'Suchbegriff für Rezeptsuche (z.B. "Pasta", "Chicken Curry")',
        },
        ingredients: {
          type: 'string',
          description: 'Komma-getrennte Zutaten für Suche nach vorhandenen Zutaten (z.B. "chicken,rice,garlic")',
        },
        cuisine: {
          type: 'string',
          description: 'Küche filtern (z.B. "italian", "asian", "german", "mexican")',
        },
        diet: {
          type: 'string',
          enum: ['vegetarian', 'vegan', 'glutenFree', 'dairyFree', 'ketogenic', 'paleo', 'whole30'],
          description: 'Diät-Filter',
        },
        recipeId: {
          type: 'string',
          description: 'Rezept-ID im Format "spoonacular:12345" oder "edamam:abc123"',
        },
        recipeIds: {
          type: 'array',
          items: { type: 'string' },
          description: 'Mehrere Rezept-IDs für Einkaufsliste',
        },
        ingredient: {
          type: 'string',
          description: 'Einzelne Zutat für Nährwert-Abfrage (z.B. "1 cup rice", "100g chicken breast")',
        },
        barcode: {
          type: 'string',
          description: 'EAN/UPC-Barcode für Produkt-Nährwerte via Open Food Facts',
        },
        number: {
          type: 'number',
          description: 'Anzahl Ergebnisse (Standard 5, max 20)',
        },
        servings: {
          type: 'number',
          description: 'Portionen für Einkaufsliste (Multiplikator)',
        },
        sub_action: {
          type: 'string',
          enum: ['add', 'list', 'remove', 'create', 'get', 'update', 'delete', 'set'],
          description: 'Unter-Aktion für favorites (add/list/remove), meal_plan (create/get/update/delete), preferences (get/set)',
        },
        week: {
          type: 'string',
          description: 'Kalenderwoche im Format "2026-W13" oder "current" für aktuelle Woche',
        },
        day: {
          type: 'string',
          enum: ['monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday', 'sunday'],
          description: 'Wochentag für Meal-Plan',
        },
        meal: {
          type: 'string',
          enum: ['breakfast', 'lunch', 'dinner', 'snack'],
          description: 'Mahlzeit (Frühstück, Mittag, Abend, Snack)',
        },
        title: {
          type: 'string',
          description: 'Rezept-Titel für manuellen Meal-Plan-Eintrag',
        },
        notes: {
          type: 'string',
          description: 'Notizen zum Meal-Plan-Eintrag',
        },
        tags: {
          type: 'array',
          items: { type: 'string' },
          description: 'Tags für Zufallsrezept (z.B. ["vegetarian", "dessert"])',
        },
        preferences: {
          type: 'object',
          properties: {
            diet: { type: 'string' },
            intolerances: { type: 'array', items: { type: 'string' } },
            excludeIngredients: { type: 'array', items: { type: 'string' } },
            defaultServings: { type: 'number' },
            cuisine: { type: 'string' },
          },
          description: 'Diät-Einstellungen zum Speichern',
        },
      },
      required: ['action'],
    },
  };

  constructor(
    private readonly config?: RecipeConfig,
    private readonly repos?: {
      favorites: RecipeFavoriteRepository;
      mealPlans: MealPlanRepository;
      userRepo: AlfredUserRepository;
    },
  ) {
    super();
  }

  async execute(input: Record<string, unknown>, context: SkillContext): Promise<SkillResult> {
    const action = input.action as string;
    try {
      switch (action) {
        case 'search': return await this.search(input, context);
        case 'detail': return await this.detail(input, context);
        case 'nutrition': return await this.nutrition(input, context);
        case 'random': return await this.random(input, context);
        case 'favorites': return await this.favorites(input, context);
        case 'meal_plan': return await this.mealPlan(input, context);
        case 'shopping_list': return await this.shoppingList(input, context);
        case 'preferences': return await this.preferences(input, context);
        default: return { success: false, error: `Unbekannte Aktion: ${action}` };
      }
    } catch (err) {
      if (err instanceof ApiKeyError) throw err;
      return { success: false, error: err instanceof Error ? err.message : String(err) };
    }
  }

  // ── Cache helpers ────────────────────────────────────────

  private getCached<T>(key: string): T | undefined {
    const entry = this.cache.get(key);
    if (entry && Date.now() < entry.expiresAt) return entry.data as T;
    if (entry) this.cache.delete(key);
    return undefined;
  }

  private setCache(key: string, data: unknown, ttl = this.CACHE_TTL): void {
    this.cache.set(key, { data, expiresAt: Date.now() + ttl });
  }

  // ── API helpers ──────────────────────────────────────────

  private async apiRequest(url: string): Promise<unknown> {
    const res = await fetch(url, { signal: AbortSignal.timeout(15_000) });
    if (res.status === 429) throw new RateLimitError('API Rate-Limit erreicht');
    if (res.status === 401 || res.status === 403) throw new ApiKeyError('Ungültiger API-Key');
    if (!res.ok) throw new Error(`API-Fehler: ${res.status}`);
    return res.json();
  }

  private async resolveConfig(context: SkillContext): Promise<RecipeConfig | undefined> {
    if (context.userServiceResolver && context.alfredUserId) {
      const services = await context.userServiceResolver.getUserServices(context.alfredUserId, 'recipe');
      if (services.length > 0) {
        const userCfg = services[0].config as Record<string, unknown>;
        return { ...this.config, ...userCfg } as RecipeConfig;
      }
    }
    return this.config;
  }

  private async loadPreferences(context: SkillContext): Promise<RecipePreferences | null> {
    if (!this.repos?.userRepo || !context.alfredUserId) return null;
    try {
      const user = await this.repos.userRepo.getById(context.alfredUserId);
      if (!user?.settings?.recipe_preferences) return null;
      return user.settings.recipe_preferences as RecipePreferences;
    } catch {
      return null;
    }
  }

  // ── Search ───────────────────────────────────────────────

  private async search(input: Record<string, unknown>, context: SkillContext): Promise<SkillResult> {
    const ingredients = input.ingredients as string | undefined;
    const query = input.query as string | undefined;
    const cuisine = input.cuisine as string | undefined;
    const diet = input.diet as string | undefined;
    const number = Math.min(Math.max(1, (input.number as number | undefined) ?? 5), 20);

    if (!ingredients && !query) {
      return { success: false, error: 'Bitte "query" oder "ingredients" angeben.' };
    }

    const cfg = await this.resolveConfig(context);
    const prefs = await this.loadPreferences(context);
    const effectiveDiet = diet ?? prefs?.diet;

    // Try Spoonacular first
    if (cfg?.spoonacular?.apiKey) {
      try {
        return await this.searchSpoonacular(ingredients, query, cuisine, effectiveDiet, number, cfg.spoonacular.apiKey);
      } catch (err) {
        if (err instanceof ApiKeyError) throw err;
        // Fall through to Edamam
      }
    }

    // Try Edamam
    if (cfg?.edamam?.appId && cfg?.edamam?.appKey) {
      return await this.searchEdamam(query ?? ingredients ?? '', cuisine, effectiveDiet, number, cfg.edamam.appId, cfg.edamam.appKey);
    }

    return { success: false, error: 'Kein API-Key konfiguriert. Bitte Spoonacular oder Edamam API-Key in den Einstellungen hinterlegen.' };
  }

  private async searchSpoonacular(
    ingredients: string | undefined,
    query: string | undefined,
    cuisine: string | undefined,
    diet: string | undefined,
    number: number,
    apiKey: string,
  ): Promise<SkillResult> {
    let url: string;
    let cacheKey: string;

    if (ingredients) {
      const params = new URLSearchParams({
        ingredients,
        number: String(number),
        ranking: '1',
        apiKey,
      });
      url = `${SPOONACULAR_BASE}/recipes/findByIngredients?${params}`;
      cacheKey = `sp:ingredients:${ingredients}:${number}:${diet ?? ''}`;
    } else {
      const params = new URLSearchParams({
        query: query!,
        number: String(number),
        apiKey,
      });
      if (cuisine) params.set('cuisine', cuisine);
      if (diet) params.set('diet', diet);
      url = `${SPOONACULAR_BASE}/recipes/complexSearch?${params}&addRecipeInformation=true`;
      cacheKey = `sp:search:${query}:${cuisine ?? ''}:${diet ?? ''}:${number}`;
    }

    const cached = this.getCached<unknown[]>(cacheKey);
    if (cached) return this.formatSearchResults(cached, 'spoonacular');

    const data = await this.apiRequest(url) as Record<string, unknown>;

    let recipes: Record<string, unknown>[];
    if (ingredients) {
      // findByIngredients returns array directly
      recipes = (data as unknown as Record<string, unknown>[]).map(r => ({
        id: r.id,
        title: r.title,
        image: r.image,
        usedIngredientCount: r.usedIngredientCount,
        missedIngredientCount: r.missedIngredientCount,
      }));
    } else {
      // complexSearch returns { results: [...] }
      const results = (data.results as Record<string, unknown>[]) ?? [];
      recipes = results.map(r => ({
        id: r.id,
        title: r.title,
        image: r.image,
        readyInMinutes: r.readyInMinutes,
        servings: r.servings,
        sourceUrl: r.sourceUrl,
      }));
    }

    this.setCache(cacheKey, recipes);
    return this.formatSearchResults(recipes, 'spoonacular');
  }

  private async searchEdamam(
    query: string,
    cuisine: string | undefined,
    diet: string | undefined,
    number: number,
    appId: string,
    appKey: string,
  ): Promise<SkillResult> {
    const cacheKey = `ed:search:${query}:${cuisine ?? ''}:${diet ?? ''}:${number}`;
    const cached = this.getCached<unknown[]>(cacheKey);
    if (cached) return this.formatSearchResults(cached, 'edamam');

    const params = new URLSearchParams({
      type: 'public',
      q: query,
      app_id: appId,
      app_key: appKey,
    });
    if (cuisine) params.set('cuisineType', cuisine);
    if (diet) params.set('health', diet);

    const data = await this.apiRequest(`${EDAMAM_BASE}/api/recipes/v2?${params}`) as Record<string, unknown>;
    const hits = ((data.hits as Record<string, unknown>[]) ?? []).slice(0, number);

    const recipes = hits.map(h => {
      const recipe = h.recipe as Record<string, unknown>;
      const uri = recipe.uri as string;
      const id = uri.split('#recipe_')[1] ?? uri;
      return {
        id,
        title: recipe.label,
        image: recipe.image,
        source: recipe.source,
        calories: Math.round((recipe.calories as number) ?? 0),
        totalTime: recipe.totalTime,
        yield: recipe.yield,
      };
    });

    this.setCache(cacheKey, recipes);
    return this.formatSearchResults(recipes, 'edamam');
  }

  private formatSearchResults(recipes: unknown[], source: string): SkillResult {
    if (recipes.length === 0) {
      return { success: true, data: { recipes: [], resultCount: 0 }, display: 'Keine Rezepte gefunden.' };
    }

    const lines: string[] = [];
    const items = recipes as Record<string, unknown>[];
    for (let i = 0; i < items.length; i++) {
      const r = items[i];
      const id = `${source}:${r.id}`;
      const time = r.readyInMinutes ? ` (${r.readyInMinutes} Min)` : r.totalTime ? ` (${r.totalTime} Min)` : '';
      const servings = r.servings ? `, ${r.servings} Portionen` : r.yield ? `, ${r.yield} Portionen` : '';
      lines.push(`${i + 1}) **${r.title}**${time}${servings} — ID: \`${id}\``);
    }

    return {
      success: true,
      data: {
        recipes: items.map(r => ({ ...r, recipeId: `${source}:${r.id}` })),
        resultCount: items.length,
      },
      display: `${items.length} Rezepte gefunden:\n${lines.join('\n')}`,
    };
  }

  // ── Detail ───────────────────────────────────────────────

  private async detail(input: Record<string, unknown>, context: SkillContext): Promise<SkillResult> {
    const recipeId = input.recipeId as string | undefined;
    if (!recipeId) return { success: false, error: 'Bitte "recipeId" angeben (z.B. "spoonacular:12345").' };

    const { source, id } = this.parseRecipeId(recipeId);
    const cacheKey = `detail:${recipeId}`;
    const cached = this.getCached<Record<string, unknown>>(cacheKey);
    if (cached) return this.formatDetailResult(cached, recipeId);

    const cfg = await this.resolveConfig(context);

    if (source === 'spoonacular') {
      if (!cfg?.spoonacular?.apiKey) return { success: false, error: 'Spoonacular API-Key nicht konfiguriert.' };
      const data = await this.apiRequest(`${SPOONACULAR_BASE}/recipes/${id}/information?apiKey=${cfg.spoonacular.apiKey}`) as Record<string, unknown>;
      this.setCache(cacheKey, data, this.DETAIL_CACHE_TTL);
      return this.formatDetailResult(data, recipeId);
    }

    if (source === 'edamam') {
      if (!cfg?.edamam?.appId || !cfg?.edamam?.appKey) return { success: false, error: 'Edamam API-Keys nicht konfiguriert.' };
      const data = await this.apiRequest(`${EDAMAM_BASE}/api/recipes/v2/${id}?type=public&app_id=${cfg.edamam.appId}&app_key=${cfg.edamam.appKey}`) as Record<string, unknown>;
      const recipe = (data.recipe ?? data) as Record<string, unknown>;
      this.setCache(cacheKey, recipe, this.DETAIL_CACHE_TTL);
      return this.formatDetailResult(recipe, recipeId);
    }

    return { success: false, error: `Unbekannte Quelle: ${source}. Verwende "spoonacular:ID" oder "edamam:ID".` };
  }

  private formatDetailResult(data: Record<string, unknown>, recipeId: string): SkillResult {
    const title = (data.title ?? data.label ?? 'Unbekannt') as string;

    // Extract ingredients
    let ingredients: string[] = [];
    if (data.extendedIngredients) {
      ingredients = (data.extendedIngredients as Record<string, unknown>[]).map(
        i => (i.original ?? `${i.amount} ${i.unit} ${i.name}`) as string,
      );
    } else if (data.ingredientLines) {
      ingredients = data.ingredientLines as string[];
    }

    // Extract instructions
    let instructions = '';
    if (data.instructions && typeof data.instructions === 'string') {
      instructions = data.instructions;
    } else if (data.analyzedInstructions) {
      const steps = (data.analyzedInstructions as Record<string, unknown>[])[0]?.steps as Record<string, unknown>[] | undefined;
      if (steps) {
        instructions = steps.map(s => `${s.number}. ${s.step}`).join('\n');
      }
    }

    // Nutrition summary
    const nutrition: Record<string, unknown> = {};
    if (data.nutrition) {
      const nutrients = (data.nutrition as Record<string, unknown>).nutrients as Record<string, unknown>[] | undefined;
      if (nutrients) {
        for (const n of nutrients) {
          const name = (n.name as string).toLowerCase();
          if (['calories', 'protein', 'fat', 'carbohydrates'].includes(name)) {
            nutrition[name] = { amount: n.amount, unit: n.unit };
          }
        }
      }
    } else if (data.totalNutrients) {
      const tn = data.totalNutrients as Record<string, Record<string, unknown>>;
      if (tn.ENERC_KCAL) nutrition.calories = { amount: Math.round(tn.ENERC_KCAL.quantity as number), unit: 'kcal' };
      if (tn.PROCNT) nutrition.protein = { amount: Math.round(tn.PROCNT.quantity as number), unit: 'g' };
      if (tn.FAT) nutrition.fat = { amount: Math.round(tn.FAT.quantity as number), unit: 'g' };
      if (tn.CHOCDF) nutrition.carbohydrates = { amount: Math.round(tn.CHOCDF.quantity as number), unit: 'g' };
    }

    const lines = [
      `**${title}**\n`,
      data.readyInMinutes ? `Zubereitungszeit: ${data.readyInMinutes} Minuten` : null,
      data.totalTime ? `Zubereitungszeit: ${data.totalTime} Minuten` : null,
      data.servings ? `Portionen: ${data.servings}` : data.yield ? `Portionen: ${data.yield}` : null,
      '',
      '**Zutaten:**',
      ...ingredients.map(i => `- ${i}`),
      '',
    ];

    if (instructions) {
      lines.push('**Zubereitung:**', instructions, '');
    }

    if (Object.keys(nutrition).length > 0) {
      lines.push('**Nährwerte:**');
      for (const [key, val] of Object.entries(nutrition)) {
        const v = val as { amount: number; unit: string };
        lines.push(`- ${key}: ${v.amount} ${v.unit}`);
      }
    }

    return {
      success: true,
      data: {
        recipeId,
        title,
        readyInMinutes: data.readyInMinutes ?? data.totalTime,
        servings: data.servings ?? data.yield,
        ingredients,
        instructions,
        nutrition,
        image: data.image,
        sourceUrl: data.sourceUrl ?? data.url,
      },
      display: lines.filter(l => l !== null).join('\n'),
    };
  }

  // ── Nutrition ────────────────────────────────────────────

  private async nutrition(input: Record<string, unknown>, context: SkillContext): Promise<SkillResult> {
    const recipeId = input.recipeId as string | undefined;
    const ingredient = input.ingredient as string | undefined;
    const barcode = input.barcode as string | undefined;

    if (barcode) {
      return await this.nutritionByBarcode(barcode);
    }

    if (recipeId) {
      return await this.nutritionByRecipe(recipeId, context);
    }

    if (ingredient) {
      return await this.nutritionByIngredient(ingredient, context);
    }

    return { success: false, error: 'Bitte "recipeId", "ingredient" oder "barcode" angeben.' };
  }

  private async nutritionByRecipe(recipeId: string, context: SkillContext): Promise<SkillResult> {
    const { source, id } = this.parseRecipeId(recipeId);
    const cacheKey = `nutrition:${recipeId}`;
    const cached = this.getCached<Record<string, unknown>>(cacheKey);
    if (cached) return this.formatNutritionResult(cached, recipeId);

    const cfg = await this.resolveConfig(context);

    if (source === 'spoonacular' && cfg?.spoonacular?.apiKey) {
      const data = await this.apiRequest(`${SPOONACULAR_BASE}/recipes/${id}/nutritionWidget.json?apiKey=${cfg.spoonacular.apiKey}`) as Record<string, unknown>;
      this.setCache(cacheKey, data, this.DETAIL_CACHE_TTL);
      return this.formatNutritionResult(data, recipeId);
    }

    return { success: false, error: `Nährwert-Daten für ${source} nicht verfügbar.` };
  }

  private async nutritionByIngredient(ingredient: string, context: SkillContext): Promise<SkillResult> {
    const cacheKey = `nutrition:ingredient:${ingredient}`;
    const cached = this.getCached<Record<string, unknown>>(cacheKey);
    if (cached) return { success: true, data: cached, display: this.formatNutritionDisplay(cached) };

    // Try Edamam nutrition analysis first
    const cfg = await this.resolveConfig(context);
    if (cfg?.edamam?.appId && cfg?.edamam?.appKey) {
      try {
        const params = new URLSearchParams({
          app_id: cfg.edamam.appId,
          app_key: cfg.edamam.appKey,
          ingr: ingredient,
        });
        const data = await this.apiRequest(`${EDAMAM_BASE}/api/nutrition-data?${params}`) as Record<string, unknown>;
        const tn = data.totalNutrients as Record<string, Record<string, unknown>> | undefined;
        if (tn) {
          const result: Record<string, unknown> = {
            ingredient,
            calories: tn.ENERC_KCAL ? Math.round(tn.ENERC_KCAL.quantity as number) : null,
            protein: tn.PROCNT ? Math.round((tn.PROCNT.quantity as number) * 10) / 10 : null,
            carbs: tn.CHOCDF ? Math.round((tn.CHOCDF.quantity as number) * 10) / 10 : null,
            fat: tn.FAT ? Math.round((tn.FAT.quantity as number) * 10) / 10 : null,
            fiber: tn.FIBTG ? Math.round((tn.FIBTG.quantity as number) * 10) / 10 : null,
            source: 'edamam',
          };
          this.setCache(cacheKey, result, this.DETAIL_CACHE_TTL);
          return { success: true, data: result, display: this.formatNutritionDisplay(result) };
        }
      } catch {
        // Fall through to Open Food Facts
      }
    }

    // Fallback: Open Food Facts search
    return await this.nutritionByOFF(ingredient, cacheKey);
  }

  private async nutritionByBarcode(barcode: string): Promise<SkillResult> {
    const cacheKey = `nutrition:barcode:${barcode}`;
    const cached = this.getCached<Record<string, unknown>>(cacheKey);
    if (cached) return { success: true, data: cached, display: this.formatNutritionDisplay(cached) };

    const data = await this.apiRequest(`${OFF_BASE}/api/v2/product/${barcode}.json`) as Record<string, unknown>;
    if (data.status === 0) return { success: false, error: `Produkt mit Barcode ${barcode} nicht gefunden.` };

    const product = data.product as Record<string, unknown>;
    const nutriments = product.nutriments as Record<string, unknown> | undefined;

    const result: Record<string, unknown> = {
      ingredient: product.product_name ?? barcode,
      barcode,
      calories: nutriments?.['energy-kcal_100g'] ?? null,
      protein: nutriments?.proteins_100g ?? null,
      carbs: nutriments?.carbohydrates_100g ?? null,
      fat: nutriments?.fat_100g ?? null,
      fiber: nutriments?.fiber_100g ?? null,
      per: '100g',
      source: 'openfoodfacts',
    };

    this.setCache(cacheKey, result, this.DETAIL_CACHE_TTL);
    return { success: true, data: result, display: this.formatNutritionDisplay(result) };
  }

  private async nutritionByOFF(searchTerm: string, cacheKey: string): Promise<SkillResult> {
    const params = new URLSearchParams({
      search_terms: searchTerm,
      search_simple: '1',
      action: 'process',
      json: '1',
      page_size: '1',
    });
    const data = await this.apiRequest(`${OFF_BASE}/cgi/search.pl?${params}`) as Record<string, unknown>;
    const products = (data.products as Record<string, unknown>[]) ?? [];

    if (products.length === 0) {
      return { success: false, error: `Keine Nährwert-Daten für "${searchTerm}" gefunden.` };
    }

    const product = products[0];
    const nutriments = product.nutriments as Record<string, unknown> | undefined;

    const result: Record<string, unknown> = {
      ingredient: product.product_name ?? searchTerm,
      calories: nutriments?.['energy-kcal_100g'] ?? null,
      protein: nutriments?.proteins_100g ?? null,
      carbs: nutriments?.carbohydrates_100g ?? null,
      fat: nutriments?.fat_100g ?? null,
      fiber: nutriments?.fiber_100g ?? null,
      per: '100g',
      source: 'openfoodfacts',
    };

    this.setCache(cacheKey, result, this.DETAIL_CACHE_TTL);
    return { success: true, data: result, display: this.formatNutritionDisplay(result) };
  }

  private formatNutritionResult(data: Record<string, unknown>, recipeId: string): SkillResult {
    // Spoonacular nutritionWidget format
    const result: Record<string, unknown> = { recipeId };
    const lines: string[] = ['**Nährwerte:**\n'];

    if (data.calories) {
      result.calories = data.calories;
      lines.push(`- Kalorien: ${data.calories}`);
    }
    if (data.protein) {
      result.protein = data.protein;
      lines.push(`- Protein: ${data.protein}`);
    }
    if (data.carbs) {
      result.carbs = data.carbs;
      lines.push(`- Kohlenhydrate: ${data.carbs}`);
    }
    if (data.fat) {
      result.fat = data.fat;
      lines.push(`- Fett: ${data.fat}`);
    }

    // Also check nutrients array
    if (data.nutrients) {
      const nutrients = data.nutrients as Record<string, unknown>[];
      for (const n of nutrients.slice(0, 10)) {
        const name = n.name as string;
        const amount = n.amount as number;
        const unit = n.unit as string;
        result[name.toLowerCase()] = { amount, unit };
        if (!['calories', 'protein', 'carbohydrates', 'fat'].includes(name.toLowerCase())) {
          lines.push(`- ${name}: ${amount} ${unit}`);
        }
      }
    }

    return { success: true, data: result, display: lines.join('\n') };
  }

  private formatNutritionDisplay(data: Record<string, unknown>): string {
    const name = data.ingredient ?? data.barcode ?? 'Unbekannt';
    const per = data.per ? ` (pro ${data.per})` : '';
    const lines = [`**Nährwerte für ${name}**${per}:\n`];
    if (data.calories != null) lines.push(`- Kalorien: ${data.calories} kcal`);
    if (data.protein != null) lines.push(`- Protein: ${data.protein} g`);
    if (data.carbs != null) lines.push(`- Kohlenhydrate: ${data.carbs} g`);
    if (data.fat != null) lines.push(`- Fett: ${data.fat} g`);
    if (data.fiber != null) lines.push(`- Ballaststoffe: ${data.fiber} g`);
    lines.push(`\nQuelle: ${data.source}`);
    return lines.join('\n');
  }

  // ── Random ───────────────────────────────────────────────

  private async random(input: Record<string, unknown>, context: SkillContext): Promise<SkillResult> {
    const tags = input.tags as string[] | undefined;
    const cfg = await this.resolveConfig(context);

    if (!cfg?.spoonacular?.apiKey) {
      return { success: false, error: 'Spoonacular API-Key nicht konfiguriert.' };
    }

    const prefs = await this.loadPreferences(context);
    const allTags = [...(tags ?? [])];
    if (prefs?.diet && !allTags.includes(prefs.diet)) allTags.push(prefs.diet);

    const params = new URLSearchParams({
      number: '1',
      apiKey: cfg.spoonacular.apiKey,
    });
    if (allTags.length > 0) params.set('tags', allTags.join(','));

    const data = await this.apiRequest(`${SPOONACULAR_BASE}/recipes/random?${params}`) as Record<string, unknown>;
    const recipes = data.recipes as Record<string, unknown>[] | undefined;

    if (!recipes || recipes.length === 0) {
      return { success: true, data: {}, display: 'Kein Zufallsrezept gefunden.' };
    }

    const r = recipes[0];
    this.setCache(`detail:spoonacular:${r.id}`, r, this.DETAIL_CACHE_TTL);
    return this.formatDetailResult(r, `spoonacular:${r.id}`);
  }

  // ── Favorites ────────────────────────────────────────────

  private async favorites(input: Record<string, unknown>, context: SkillContext): Promise<SkillResult> {
    const subAction = (input.sub_action ?? 'list') as string;

    if (!this.repos?.favorites) {
      return { success: false, error: 'Favoriten-Datenbank nicht verfügbar.' };
    }

    const userId = effectiveUserId(context);

    switch (subAction) {
      case 'add': return await this.addFavorite(input, context, userId);
      case 'list': return await this.listFavorites(userId);
      case 'remove': return await this.removeFavorite(input, userId);
      default: return { success: false, error: `Unbekannte sub_action: ${subAction}. Verwende add, list oder remove.` };
    }
  }

  private async addFavorite(input: Record<string, unknown>, context: SkillContext, userId: string): Promise<SkillResult> {
    const recipeId = input.recipeId as string | undefined;
    if (!recipeId) return { success: false, error: 'Bitte "recipeId" angeben.' };

    const { source, id } = this.parseRecipeId(recipeId);

    // Check if already favorite
    const existing = await this.repos!.favorites.get(userId, recipeId);
    if (existing) return { success: true, data: existing, display: `"${existing.title}" ist bereits in den Favoriten.` };

    // Get recipe detail for metadata
    let title = (input.title as string) ?? 'Unbekannt';
    let imageUrl: string | undefined;
    let prepTime: number | undefined;
    let servings: number | undefined;
    let ingredientsJson: string | undefined;

    const cached = this.getCached<Record<string, unknown>>(`detail:${recipeId}`);
    if (cached) {
      title = (cached.title ?? cached.label ?? title) as string;
      imageUrl = cached.image as string | undefined;
      prepTime = (cached.readyInMinutes ?? cached.totalTime) as number | undefined;
      servings = (cached.servings ?? cached.yield) as number | undefined;
      if (cached.extendedIngredients) {
        ingredientsJson = JSON.stringify(cached.extendedIngredients);
      } else if (cached.ingredientLines) {
        ingredientsJson = JSON.stringify(cached.ingredientLines);
      }
    } else {
      // Try to fetch detail
      try {
        const detailResult = await this.detail({ recipeId }, context);
        if (detailResult.success && detailResult.data) {
          const d = detailResult.data as Record<string, unknown>;
          title = (d.title as string) ?? title;
          imageUrl = d.image as string | undefined;
          prepTime = d.readyInMinutes as number | undefined;
          servings = d.servings as number | undefined;
          if (d.ingredients) ingredientsJson = JSON.stringify(d.ingredients);
        }
      } catch {
        // Use whatever info we have
      }
    }

    const fav = await this.repos!.favorites.add(userId, {
      recipeId,
      source,
      title,
      imageUrl,
      prepTimeMinutes: prepTime,
      servings,
      tags: input.tags as string[] | undefined,
      ingredientsJson,
    });

    return { success: true, data: fav, display: `"${title}" zu Favoriten hinzugefügt.` };
  }

  private async listFavorites(userId: string): Promise<SkillResult> {
    const favs = await this.repos!.favorites.list(userId);

    if (favs.length === 0) {
      return { success: true, data: { favorites: [], count: 0 }, display: 'Keine Favoriten gespeichert.' };
    }

    const lines = [`**${favs.length} Favoriten:**\n`];
    for (let i = 0; i < favs.length; i++) {
      const f = favs[i];
      const time = f.prepTimeMinutes ? ` (${f.prepTimeMinutes} Min)` : '';
      const servingsStr = f.servings ? `, ${f.servings} Portionen` : '';
      lines.push(`${i + 1}) **${f.title}**${time}${servingsStr} — ID: \`${f.recipeId}\``);
    }

    return {
      success: true,
      data: { favorites: favs, count: favs.length },
      display: lines.join('\n'),
    };
  }

  private async removeFavorite(input: Record<string, unknown>, userId: string): Promise<SkillResult> {
    const recipeId = input.recipeId as string | undefined;
    if (!recipeId) return { success: false, error: 'Bitte "recipeId" angeben.' };

    const removed = await this.repos!.favorites.remove(userId, recipeId);
    if (!removed) return { success: false, error: `Rezept "${recipeId}" nicht in Favoriten gefunden.` };

    return { success: true, data: { recipeId, removed: true }, display: `Rezept aus Favoriten entfernt.` };
  }

  // ── Meal Plan ────────────────────────────────────────────

  private async mealPlan(input: Record<string, unknown>, context: SkillContext): Promise<SkillResult> {
    const subAction = (input.sub_action ?? 'get') as string;

    if (!this.repos?.mealPlans) {
      return { success: false, error: 'Meal-Plan-Datenbank nicht verfügbar.' };
    }

    const userId = effectiveUserId(context);

    switch (subAction) {
      case 'create': return await this.createMealPlan(input, context, userId);
      case 'get': return await this.getMealPlan(input, userId);
      case 'update': return await this.updateMealPlan(input, userId);
      case 'delete': return await this.deleteMealPlan(input, userId);
      default: return { success: false, error: `Unbekannte sub_action: ${subAction}. Verwende create, get, update oder delete.` };
    }
  }

  private async createMealPlan(input: Record<string, unknown>, context: SkillContext, userId: string): Promise<SkillResult> {
    const week = this.resolveWeek(input.week as string | undefined);
    const cfg = await this.resolveConfig(context);

    // Try Spoonacular meal planner
    if (cfg?.spoonacular?.apiKey) {
      try {
        const params = new URLSearchParams({
          timeFrame: 'week',
          apiKey: cfg.spoonacular.apiKey,
        });
        const prefs = await this.loadPreferences(context);
        if (prefs?.diet) params.set('diet', prefs.diet);

        const data = await this.apiRequest(`${SPOONACULAR_BASE}/mealplanner/generate?${params}`) as Record<string, unknown>;
        const spWeek = data.week as Record<string, Record<string, unknown>> | undefined;

        if (spWeek) {
          const entries: MealPlanEntry[] = [];
          for (const day of DAYS_OF_WEEK) {
            const dayData = spWeek[day];
            if (!dayData?.meals) continue;
            const meals = dayData.meals as Record<string, unknown>[];
            const mealSlots = ['breakfast', 'lunch', 'dinner'];
            for (let i = 0; i < Math.min(meals.length, mealSlots.length); i++) {
              const m = meals[i];
              const entry = await this.repos!.mealPlans.setMeal(userId, week, day, mealSlots[i], {
                recipeId: `spoonacular:${m.id}`,
                source: 'spoonacular',
                title: m.title as string,
              });
              entries.push(entry);
            }
          }

          return {
            success: true,
            data: { week, entries: entries.length },
            display: `Wochenplan für ${week} erstellt mit ${entries.length} Mahlzeiten.`,
          };
        }
      } catch {
        // Fall through to random from favorites
      }
    }

    // Fallback: use random favorites
    if (this.repos?.favorites) {
      const favs = await this.repos.favorites.list(userId);
      if (favs.length >= 3) {
        const entries: MealPlanEntry[] = [];
        for (const day of DAYS_OF_WEEK) {
          const mealSlots = ['breakfast', 'lunch', 'dinner'];
          for (const meal of mealSlots) {
            const randomFav = favs[Math.floor(Math.random() * favs.length)];
            const entry = await this.repos!.mealPlans.setMeal(userId, week, day, meal, {
              recipeId: randomFav.recipeId,
              source: randomFav.source,
              title: randomFav.title,
            });
            entries.push(entry);
          }
        }
        return {
          success: true,
          data: { week, entries: entries.length },
          display: `Wochenplan für ${week} aus Favoriten erstellt (${entries.length} Mahlzeiten).`,
        };
      }
    }

    return { success: false, error: 'Kein API-Key konfiguriert und zu wenige Favoriten für automatischen Wochenplan.' };
  }

  private async getMealPlan(input: Record<string, unknown>, userId: string): Promise<SkillResult> {
    const week = this.resolveWeek(input.week as string | undefined);
    const day = input.day as string | undefined;

    if (day) {
      const entries = await this.repos!.mealPlans.getDay(userId, week, day);
      // Structure for Watch compatibility
      const dayData: Record<string, { title: string; recipeId?: string } | null> = {
        breakfast: null, lunch: null, dinner: null, snack: null,
      };
      for (const e of entries) {
        dayData[e.meal] = { title: e.title, recipeId: e.recipeId };
      }

      const lines = [`**${this.dayName(day)}, ${week}:**\n`];
      for (const meal of MEALS) {
        const m = dayData[meal];
        lines.push(`- ${this.mealName(meal)}: ${m ? m.title : '—'}`);
      }

      return {
        success: true,
        data: dayData,
        display: lines.join('\n'),
      };
    }

    // Full week
    const entries = await this.repos!.mealPlans.getWeek(userId, week);
    if (entries.length === 0) {
      return { success: true, data: { week, days: {} }, display: `Kein Wochenplan für ${week} vorhanden.` };
    }

    const byDay: Record<string, Record<string, MealPlanEntry>> = {};
    for (const e of entries) {
      if (!byDay[e.day]) byDay[e.day] = {};
      byDay[e.day][e.meal] = e;
    }

    const lines = [`**Wochenplan ${week}:**\n`];
    for (const day of DAYS_OF_WEEK) {
      if (!byDay[day]) continue;
      lines.push(`**${this.dayName(day)}:**`);
      for (const meal of MEALS) {
        const m = byDay[day][meal];
        if (m) lines.push(`  - ${this.mealName(meal)}: ${m.title}`);
      }
      lines.push('');
    }

    return {
      success: true,
      data: { week, days: byDay, entryCount: entries.length },
      display: lines.join('\n'),
    };
  }

  private async updateMealPlan(input: Record<string, unknown>, userId: string): Promise<SkillResult> {
    const week = this.resolveWeek(input.week as string | undefined);
    const day = input.day as string | undefined;
    const meal = input.meal as string | undefined;
    const title = input.title as string | undefined;
    const recipeId = input.recipeId as string | undefined;
    const notes = input.notes as string | undefined;

    if (!day || !meal) return { success: false, error: 'Bitte "day" und "meal" angeben.' };
    if (!title && !recipeId) return { success: false, error: 'Bitte "title" oder "recipeId" angeben.' };

    let entryTitle = title ?? 'Unbekannt';
    let source: string | undefined;
    if (recipeId) {
      const parsed = this.parseRecipeId(recipeId);
      source = parsed.source;
      // Try to get title from cache
      const cached = this.getCached<Record<string, unknown>>(`detail:${recipeId}`);
      if (cached && !title) {
        entryTitle = (cached.title ?? cached.label ?? entryTitle) as string;
      }
    }

    const entry = await this.repos!.mealPlans.setMeal(userId, week, day, meal, {
      recipeId,
      source,
      title: entryTitle,
      notes,
    });

    return {
      success: true,
      data: entry,
      display: `${this.mealName(meal)} am ${this.dayName(day)} (${week}): "${entryTitle}" eingetragen.`,
    };
  }

  private async deleteMealPlan(input: Record<string, unknown>, userId: string): Promise<SkillResult> {
    const week = this.resolveWeek(input.week as string | undefined);
    const day = input.day as string | undefined;
    const meal = input.meal as string | undefined;

    if (day && meal) {
      const removed = await this.repos!.mealPlans.deleteMeal(userId, week, day, meal);
      if (!removed) return { success: false, error: `Kein Eintrag für ${this.mealName(meal)} am ${this.dayName(day)} (${week}).` };
      return { success: true, data: { week, day, meal, removed: true }, display: `${this.mealName(meal)} am ${this.dayName(day)} gelöscht.` };
    }

    if (!day && !meal) {
      const count = await this.repos!.mealPlans.deleteWeek(userId, week);
      return { success: true, data: { week, removed: count }, display: `Wochenplan ${week} gelöscht (${count} Einträge).` };
    }

    return { success: false, error: 'Bitte entweder "day" + "meal" oder weder "day" noch "meal" (ganze Woche löschen) angeben.' };
  }

  // ── Shopping List ────────────────────────────────────────

  private async shoppingList(input: Record<string, unknown>, context: SkillContext): Promise<SkillResult> {
    const recipeIds = (input.recipeIds ?? (input.recipeId ? [input.recipeId] : [])) as string[];
    const servingsMultiplier = (input.servings as number | undefined) ?? 1;

    if (recipeIds.length === 0) {
      return { success: false, error: 'Bitte "recipeIds" oder "recipeId" angeben.' };
    }

    const allIngredients: IngredientItem[] = [];

    for (const recipeId of recipeIds) {
      // Try cache first, then fetch detail
      let detailData = this.getCached<Record<string, unknown>>(`detail:${recipeId}`);
      if (!detailData) {
        const detailResult = await this.detail({ recipeId }, context);
        if (detailResult.success && detailResult.data) {
          detailData = this.getCached<Record<string, unknown>>(`detail:${recipeId}`);
        }
      }

      if (!detailData) continue;

      const recipeServings = (detailData.servings ?? detailData.yield ?? 1) as number;
      const ratio = servingsMultiplier / recipeServings;

      if (detailData.extendedIngredients) {
        const ingredients = detailData.extendedIngredients as Record<string, unknown>[];
        for (const ing of ingredients) {
          allIngredients.push({
            name: (ing.name ?? ing.nameClean ?? 'unbekannt') as string,
            amount: ((ing.amount as number) ?? 0) * ratio,
            unit: (ing.unit ?? '') as string,
            category: this.categorizeIngredient((ing.name ?? ing.aisle ?? '') as string),
          });
        }
      } else if (detailData.ingredientLines) {
        const lines = detailData.ingredientLines as string[];
        for (const line of lines) {
          allIngredients.push({
            name: line,
            amount: 1 * ratio,
            unit: '',
            category: this.categorizeIngredient(line),
          });
        }
      }
    }

    if (allIngredients.length === 0) {
      return { success: false, error: 'Keine Zutaten gefunden. Bitte zuerst Rezeptdetails laden.' };
    }

    // Aggregate same ingredients
    const aggregated = new Map<string, IngredientItem>();
    for (const ing of allIngredients) {
      const key = `${ing.name.toLowerCase()}:${ing.unit.toLowerCase()}`;
      const existing = aggregated.get(key);
      if (existing) {
        existing.amount += ing.amount;
      } else {
        aggregated.set(key, { ...ing });
      }
    }

    // Group by category
    const grouped: Record<string, IngredientItem[]> = {};
    for (const ing of aggregated.values()) {
      const cat = ing.category ?? 'other';
      if (!grouped[cat]) grouped[cat] = [];
      grouped[cat].push(ing);
    }

    // Format display
    const categoryNames: Record<string, string> = {
      produce: 'Obst & Gemüse',
      dairy: 'Milchprodukte & Eier',
      meat: 'Fleisch & Fisch',
      pantry: 'Vorratskammer',
      other: 'Sonstiges',
    };

    const lines = ['**Einkaufsliste:**\n'];
    const categories = ['produce', 'dairy', 'meat', 'pantry', 'other'];
    for (const cat of categories) {
      if (!grouped[cat] || grouped[cat].length === 0) continue;
      lines.push(`**${categoryNames[cat] ?? cat}:**`);
      for (const ing of grouped[cat]) {
        const amountStr = ing.amount > 0 && ing.unit
          ? `${Math.round(ing.amount * 100) / 100} ${ing.unit} `
          : '';
        lines.push(`- ${amountStr}${ing.name}`);
      }
      lines.push('');
    }

    return {
      success: true,
      data: {
        ingredients: [...aggregated.values()],
        grouped,
        totalItems: aggregated.size,
        recipeCount: recipeIds.length,
      },
      display: lines.join('\n'),
    };
  }

  // ── Preferences ──────────────────────────────────────────

  private async preferences(input: Record<string, unknown>, context: SkillContext): Promise<SkillResult> {
    const subAction = (input.sub_action ?? 'get') as string;

    if (!this.repos?.userRepo || !context.alfredUserId) {
      return { success: false, error: 'User-Datenbank nicht verfügbar oder kein User zugeordnet.' };
    }

    switch (subAction) {
      case 'get': return await this.getPreferences(context);
      case 'set': return await this.setPreferences(input, context);
      default: return { success: false, error: `Unbekannte sub_action: ${subAction}. Verwende get oder set.` };
    }
  }

  private async getPreferences(context: SkillContext): Promise<SkillResult> {
    const prefs = await this.loadPreferences(context);
    if (!prefs) {
      return { success: true, data: {}, display: 'Keine Rezept-Einstellungen gespeichert.' };
    }

    const lines = ['**Rezept-Einstellungen:**\n'];
    if (prefs.diet) lines.push(`- Diät: ${prefs.diet}`);
    if (prefs.intolerances?.length) lines.push(`- Unverträglichkeiten: ${prefs.intolerances.join(', ')}`);
    if (prefs.excludeIngredients?.length) lines.push(`- Ausgeschlossene Zutaten: ${prefs.excludeIngredients.join(', ')}`);
    if (prefs.defaultServings) lines.push(`- Standard-Portionen: ${prefs.defaultServings}`);
    if (prefs.cuisine) lines.push(`- Bevorzugte Küche: ${prefs.cuisine}`);

    return { success: true, data: prefs, display: lines.join('\n') };
  }

  private async setPreferences(input: Record<string, unknown>, context: SkillContext): Promise<SkillResult> {
    const newPrefs = input.preferences as RecipePreferences | undefined;
    if (!newPrefs) return { success: false, error: 'Bitte "preferences" Objekt angeben.' };

    const user = await this.repos!.userRepo.getById(context.alfredUserId!);
    if (!user) return { success: false, error: 'User nicht gefunden.' };

    const settings = { ...user.settings };
    const existingPrefs = (settings.recipe_preferences ?? {}) as RecipePreferences;
    const merged = { ...existingPrefs, ...newPrefs };
    settings.recipe_preferences = merged;

    await this.repos!.userRepo.updateSettings(user.id, settings);

    return {
      success: true,
      data: merged,
      display: 'Rezept-Einstellungen gespeichert.',
    };
  }

  // ── Utilities ────────────────────────────────────────────

  private parseRecipeId(recipeId: string): { source: string; id: string } {
    const colonIndex = recipeId.indexOf(':');
    if (colonIndex === -1) {
      // Assume spoonacular if only numeric
      return { source: 'spoonacular', id: recipeId };
    }
    return {
      source: recipeId.substring(0, colonIndex),
      id: recipeId.substring(colonIndex + 1),
    };
  }

  private resolveWeek(week: string | undefined): string {
    if (!week || week === 'current') {
      return this.getCurrentISOWeek();
    }
    return week;
  }

  private getCurrentISOWeek(): string {
    const now = new Date();
    const jan4 = new Date(now.getFullYear(), 0, 4);
    const dayOfYear = Math.floor((now.getTime() - new Date(now.getFullYear(), 0, 1).getTime()) / 86_400_000) + 1;
    const jan4DayOfWeek = jan4.getDay() || 7;
    const weekNumber = Math.ceil((dayOfYear + jan4DayOfWeek - 1) / 7);
    return `${now.getFullYear()}-W${String(weekNumber).padStart(2, '0')}`;
  }

  private categorizeIngredient(name: string): string {
    const lower = name.toLowerCase();
    for (const [category, keywords] of Object.entries(INGREDIENT_CATEGORIES)) {
      if (keywords.some(kw => lower.includes(kw))) return category;
    }
    return 'other';
  }

  private dayName(day: string): string {
    const names: Record<string, string> = {
      monday: 'Montag', tuesday: 'Dienstag', wednesday: 'Mittwoch',
      thursday: 'Donnerstag', friday: 'Freitag', saturday: 'Samstag', sunday: 'Sonntag',
    };
    return names[day] ?? day;
  }

  private mealName(meal: string): string {
    const names: Record<string, string> = {
      breakfast: 'Frühstück', lunch: 'Mittagessen', dinner: 'Abendessen', snack: 'Snack',
    };
    return names[meal] ?? meal;
  }
}
