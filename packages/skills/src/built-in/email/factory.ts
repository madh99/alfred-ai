import type { EmailAccountConfig } from '@alfred/types';
import type { EmailProvider } from './email-provider.js';

export async function createEmailProvider(config: EmailAccountConfig): Promise<EmailProvider> {
  if (config.provider === 'microsoft') {
    if (!config.microsoft) throw new Error('Microsoft email config missing');
    const { MicrosoftGraphEmailProvider } = await import('./microsoft-provider.js');
    const provider = new MicrosoftGraphEmailProvider(config.microsoft);
    await provider.initialize();
    return provider;
  }

  // Default: IMAP/SMTP
  if (!config.imap || !config.smtp || !config.auth) {
    throw new Error('IMAP/SMTP email config missing (imap, smtp, auth required)');
  }
  const { StandardEmailProvider } = await import('./standard-provider.js');
  const provider = new StandardEmailProvider(config);
  await provider.initialize();
  return provider;
}
