import type { CalendarConfig } from '@alfred/types';
import type { CalendarProvider } from './calendar-provider.js';

export async function createCalendarProvider(config: CalendarConfig): Promise<CalendarProvider> {
  switch (config.provider) {
    case 'caldav': {
      if (!config.caldav) throw new Error('CalDAV config missing');
      const { CalDAVProvider } = await import('./caldav-provider.js');
      const provider = new CalDAVProvider(config.caldav);
      await provider.initialize();
      return provider;
    }
    case 'google': {
      if (!config.google) throw new Error('Google Calendar config missing');
      const { GoogleCalendarProvider } = await import('./google-provider.js');
      const provider = new GoogleCalendarProvider(config.google);
      await provider.initialize();
      return provider;
    }
    case 'microsoft': {
      if (!config.microsoft) throw new Error('Microsoft Calendar config missing');
      const { MicrosoftCalendarProvider } = await import('./microsoft-provider.js');
      const provider = new MicrosoftCalendarProvider(config.microsoft);
      await provider.initialize();
      return provider;
    }
    default:
      throw new Error(`Unknown calendar provider: ${config.provider}`);
  }
}
