import type { SkillMetadata, SkillContext, SkillResult } from '@alfred/types';
import { Skill } from '../skill.js';

interface GeoResult {
  name: string;
  country: string;
  latitude: number;
  longitude: number;
  admin1?: string;
}

interface CurrentWeather {
  temperature: number;
  windspeed: number;
  winddirection: number;
  weathercode: number;
  is_day: number;
  time: string;
}

const WEATHER_CODES: Record<number, string> = {
  0: 'Clear sky',
  1: 'Mainly clear',
  2: 'Partly cloudy',
  3: 'Overcast',
  45: 'Foggy',
  48: 'Depositing rime fog',
  51: 'Light drizzle',
  53: 'Moderate drizzle',
  55: 'Dense drizzle',
  61: 'Slight rain',
  63: 'Moderate rain',
  65: 'Heavy rain',
  71: 'Slight snow',
  73: 'Moderate snow',
  75: 'Heavy snow',
  77: 'Snow grains',
  80: 'Slight rain showers',
  81: 'Moderate rain showers',
  82: 'Violent rain showers',
  85: 'Slight snow showers',
  86: 'Heavy snow showers',
  95: 'Thunderstorm',
  96: 'Thunderstorm with slight hail',
  99: 'Thunderstorm with heavy hail',
};

export class WeatherSkill extends Skill {
  readonly metadata: SkillMetadata = {
    name: 'weather',
    category: 'information',
    description:
      'Get current weather for any location. Uses Open-Meteo (free, no API key). ' +
      'Use when the user asks about weather, temperature, or conditions somewhere.',
    riskLevel: 'read',
    version: '2.0.0',
    inputSchema: {
      type: 'object',
      properties: {
        location: {
          type: 'string',
          description: 'City or place name (e.g. "Vienna", "New York", "Tokyo")',
        },
      },
      required: ['location'],
    },
  };

  async execute(
    input: Record<string, unknown>,
    _context: SkillContext,
  ): Promise<SkillResult> {
    const location = input.location as string;

    if (!location || typeof location !== 'string') {
      return { success: false, error: 'Missing required field "location"' };
    }

    try {
      // 1. Geocode the location
      const geo = await this.geocode(location);
      if (!geo) {
        return { success: false, error: `Location "${location}" not found` };
      }

      // 2. Fetch current weather
      const weather = await this.fetchWeather(geo.latitude, geo.longitude);

      const condition = WEATHER_CODES[weather.weathercode] ?? `Code ${weather.weathercode}`;
      const locationLabel = geo.admin1
        ? `${geo.name}, ${geo.admin1}, ${geo.country}`
        : `${geo.name}, ${geo.country}`;

      const data = {
        location: locationLabel,
        temperature: weather.temperature,
        unit: '°C',
        condition,
        windSpeed: weather.windspeed,
        windDirection: weather.winddirection,
        isDay: weather.is_day === 1,
      };

      const display =
        `${locationLabel}: ${weather.temperature}°C, ${condition}\n` +
        `Wind: ${weather.windspeed} km/h`;

      return { success: true, data, display };
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      return { success: false, error: `Weather fetch failed: ${msg}` };
    }
  }

  private async geocode(query: string): Promise<GeoResult | undefined> {
    const url = `https://geocoding-api.open-meteo.com/v1/search?name=${encodeURIComponent(query)}&count=1&language=en&format=json`;
    const res = await fetch(url);
    if (!res.ok) throw new Error(`Geocoding API returned ${res.status}`);

    const data = await res.json() as { results?: GeoResult[] };
    return data.results?.[0];
  }

  private async fetchWeather(lat: number, lon: number): Promise<CurrentWeather> {
    const url = `https://api.open-meteo.com/v1/forecast?latitude=${lat}&longitude=${lon}&current_weather=true&timezone=auto`;
    const res = await fetch(url);
    if (!res.ok) throw new Error(`Weather API returned ${res.status}`);

    const data = await res.json() as { current_weather: CurrentWeather };
    return data.current_weather;
  }
}
