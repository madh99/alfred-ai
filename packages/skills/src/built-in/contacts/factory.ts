import type { ContactsConfig } from '@alfred/types';
import type { ContactsProvider } from './contacts-provider.js';

export async function createContactsProvider(config: ContactsConfig): Promise<ContactsProvider> {
  switch (config.provider) {
    case 'carddav': {
      if (!config.carddav) throw new Error('CardDAV contacts config missing');
      const { CardDAVContactsProvider } = await import('./carddav-provider.js');
      const provider = new CardDAVContactsProvider(config.carddav);
      await provider.initialize();
      return provider;
    }
    case 'google': {
      if (!config.google) throw new Error('Google contacts config missing');
      const { GoogleContactsProvider } = await import('./google-provider.js');
      const provider = new GoogleContactsProvider(config.google);
      await provider.initialize();
      return provider;
    }
    case 'microsoft': {
      if (!config.microsoft) throw new Error('Microsoft contacts config missing');
      const { MicrosoftContactsProvider } = await import('./microsoft-provider.js');
      const provider = new MicrosoftContactsProvider(config.microsoft);
      await provider.initialize();
      return provider;
    }
    default:
      throw new Error(`Unknown contacts provider: ${config.provider}`);
  }
}
