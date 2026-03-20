import type { SkillMetadata, SkillContext, SkillResult, ContactsConfig } from '@alfred/types';
import { Skill } from '../../skill.js';
import type { ContactsProvider, Contact } from './contacts-provider.js';

type ContactsAction = 'search' | 'get' | 'list' | 'create' | 'update' | 'delete' | 'list_accounts';

export class ContactsSkill extends Skill {
  readonly metadata: SkillMetadata;

  private readonly providers: Map<string, ContactsProvider>;
  private readonly defaultAccount: string;

  /** Per-request override for user-specific providers (set in execute, cleared in finally). */
  private activeProviders?: Map<string, ContactsProvider>;

  constructor(providers?: Map<string, ContactsProvider> | ContactsProvider) {
    super();

    if (providers instanceof Map) {
      this.providers = providers;
    } else if (providers) {
      this.providers = new Map([['default', providers]]);
    } else {
      this.providers = new Map();
    }

    this.defaultAccount = [...this.providers.keys()][0] ?? 'default';

    const accountProp = {
      account: {
        type: 'string' as const,
        description: 'Contacts account name. Use list_accounts to see available accounts.',
      },
    };

    const description = 'Manage contacts. Search, view, create, update, or delete contacts. Use "list_accounts" to see available contacts accounts.';

    this.metadata = {
      name: 'contacts',
      category: 'productivity',
      description,
      riskLevel: 'write',
      version: '2.0.0',
      inputSchema: {
        type: 'object',
        properties: {
          action: {
            type: 'string',
            enum: ['search', 'get', 'list', 'create', 'update', 'delete', 'list_accounts'],
            description: 'The contacts action to perform',
          },
          ...accountProp,
          query: {
            type: 'string',
            description: 'Search query (for search action)',
          },
          contactId: {
            type: 'string',
            description: 'Contact ID (for get/update/delete)',
          },
          firstName: {
            type: 'string',
            description: 'First name (for create/update)',
          },
          lastName: {
            type: 'string',
            description: 'Last name (for create/update)',
          },
          displayName: {
            type: 'string',
            description: 'Display name (for create/update)',
          },
          email: {
            type: 'string',
            description: 'Single email address (for create/update, shorthand)',
          },
          phone: {
            type: 'string',
            description: 'Single phone number (for create/update, shorthand)',
          },
          organization: {
            type: 'string',
            description: 'Organization / company (for create/update)',
          },
          birthday: {
            type: 'string',
            description: 'Birthday in YYYY-MM-DD format (for create/update)',
          },
          notes: {
            type: 'string',
            description: 'Notes (for create/update)',
          },
          emailAddresses: {
            type: 'string',
            description: 'JSON array of {address, label?, primary?} for multiple emails',
          },
          phoneNumbers: {
            type: 'string',
            description: 'JSON array of {number, label?, primary?} for multiple phones',
          },
          addresses: {
            type: 'string',
            description: 'JSON array of {street?, city?, region?, postalCode?, country?, label?}',
          },
          limit: {
            type: 'number',
            description: 'Maximum number of contacts to return (for list, default 50)',
          },
        },
        required: ['action'],
      },
    };
  }

  async execute(input: Record<string, unknown>, context: SkillContext): Promise<SkillResult> {
    // Resolve per-user contacts providers if available
    const userProviders = await this.resolveUserProviders(context);
    this.activeProviders = userProviders ?? undefined;

    try {
      // Multi-user: non-admin users must have their own contacts config, no fallback to global
      const providers = this.activeProviders
        ?? (context.userRole === 'admin' || !context.alfredUserId ? this.providers : new Map());
      if (providers.size === 0) {
        return { success: false, error: 'Kontakte nicht konfiguriert. Nutze "setup_service" um Kontakte zu verbinden.' };
      }

      const action = input.action as ContactsAction;

      switch (action) {
        case 'search':
          return this.searchContacts(input);
        case 'get':
          return this.getContact(input);
        case 'list':
          return this.listContacts(input);
        case 'create':
          return this.createContact(input);
        case 'update':
          return this.updateContact(input);
        case 'delete':
          return this.deleteContact(input);
        case 'list_accounts':
          return this.handleListAccounts(providers);
        default:
          return { success: false, error: `Unknown action: "${String(action)}"` };
      }
    } finally {
      this.activeProviders = undefined;
    }
  }

  // ── Provider Resolution ──────────────────────────────────────────

  /**
   * Resolve per-user contacts providers from UserServiceResolver.
   * Returns null if no per-user config is available (fall back to global).
   */
  private async resolveUserProviders(context: SkillContext): Promise<Map<string, ContactsProvider> | null> {
    if (!context.userServiceResolver || !context.alfredUserId) return null;
    const services = await context.userServiceResolver.getUserServices(context.alfredUserId, 'contacts');
    if (services.length === 0) return null;

    const providers = new Map<string, ContactsProvider>();
    for (const svc of services) {
      try {
        const { createContactsProvider } = await import('./factory.js');
        const provider = await createContactsProvider(svc.config as unknown as ContactsConfig);
        providers.set(svc.serviceName, provider);
      } catch { /* skip broken per-user configs */ }
    }
    return providers.size > 0 ? providers : null;
  }

  private resolveProvider(input: Record<string, unknown>): { provider: ContactsProvider; account: string } | SkillResult {
    const providers = this.activeProviders ?? this.providers;
    const accountNames = [...providers.keys()];
    const defaultAccount = accountNames[0] ?? 'default';
    const account = (input.account as string) ?? defaultAccount;
    const provider = providers.get(account);
    if (!provider) {
      return {
        success: false,
        error: `Unbekannter Kontakte-Account "${account}". Verfügbar: ${accountNames.join(', ')}`,
      };
    }
    return { provider, account };
  }

  private accountLabel(account: string, text: string): string {
    const providers = this.activeProviders ?? this.providers;
    return providers.size > 1 ? `[${account}] ${text}` : text;
  }

  private encodeId(account: string, rawId: string): string {
    const providers = this.activeProviders ?? this.providers;
    return providers.size > 1 ? `${account}::${rawId}` : rawId;
  }

  private decodeId(compositeId: string): { account: string; rawId: string } {
    const providers = this.activeProviders ?? this.providers;
    if (providers.size > 1) {
      const idx = compositeId.indexOf('::');
      if (idx >= 0) {
        return { account: compositeId.slice(0, idx), rawId: compositeId.slice(idx + 2) };
      }
    }
    const defaultAccount = [...providers.keys()][0] ?? this.defaultAccount;
    return { account: defaultAccount, rawId: compositeId };
  }

  // ── Handlers ─────────────────────────────────────────────────────

  private async searchContacts(input: Record<string, unknown>): Promise<SkillResult> {
    const query = input.query as string;
    if (!query) return { success: false, error: 'Missing required field "query"' };

    const resolved = this.resolveProvider(input);
    if ('success' in resolved) return resolved;
    const { provider, account } = resolved;

    try {
      const contacts = await provider.search(query);

      if (contacts.length === 0) {
        return { success: true, data: [], display: this.accountLabel(account, `No contacts found for "${query}".`) };
      }

      const display = this.formatTable(contacts, account);
      return { success: true, data: contacts, display: this.accountLabel(account, `${contacts.length} contact(s) found:\n${display}`) };
    } catch (err) {
      return { success: false, error: `Failed to search contacts: ${err instanceof Error ? err.message : String(err)}` };
    }
  }

  private async getContact(input: Record<string, unknown>): Promise<SkillResult> {
    const contactId = input.contactId as string;
    if (!contactId) return { success: false, error: 'Missing required field "contactId"' };

    const { account, rawId } = this.decodeId(contactId);
    const providers = this.activeProviders ?? this.providers;
    const provider = providers.get(account);
    if (!provider) {
      return { success: false, error: `Unbekannter Kontakte-Account "${account}".` };
    }

    try {
      const contact = await provider.get(rawId);
      if (!contact) {
        return { success: false, error: `Contact "${rawId}" not found.` };
      }

      const display = this.formatDetail(contact, account);
      return { success: true, data: contact, display };
    } catch (err) {
      return { success: false, error: `Failed to get contact: ${err instanceof Error ? err.message : String(err)}` };
    }
  }

  private async listContacts(input: Record<string, unknown>): Promise<SkillResult> {
    const limit = (input.limit as number) ?? 50;

    const resolved = this.resolveProvider(input);
    if ('success' in resolved) return resolved;
    const { provider, account } = resolved;

    try {
      const contacts = await provider.list(limit);

      if (contacts.length === 0) {
        return { success: true, data: [], display: this.accountLabel(account, 'No contacts found.') };
      }

      const display = this.formatTable(contacts, account);
      return { success: true, data: contacts, display: this.accountLabel(account, `${contacts.length} contact(s):\n${display}`) };
    } catch (err) {
      return { success: false, error: `Failed to list contacts: ${err instanceof Error ? err.message : String(err)}` };
    }
  }

  private async createContact(input: Record<string, unknown>): Promise<SkillResult> {
    const resolved = this.resolveProvider(input);
    if ('success' in resolved) return resolved;
    const { provider, account } = resolved;

    try {
      const contactInput = this.buildContactInput(input);
      const contact = await provider.create(contactInput);
      return {
        success: true,
        data: contact,
        display: this.accountLabel(account, `Contact created: ${contact.displayName}`),
      };
    } catch (err) {
      return { success: false, error: `Failed to create contact: ${err instanceof Error ? err.message : String(err)}` };
    }
  }

  private async updateContact(input: Record<string, unknown>): Promise<SkillResult> {
    const contactId = input.contactId as string;
    if (!contactId) return { success: false, error: 'Missing required field "contactId"' };

    const { account, rawId } = this.decodeId(contactId);
    const providers = this.activeProviders ?? this.providers;
    const provider = providers.get(account);
    if (!provider) {
      return { success: false, error: `Unbekannter Kontakte-Account "${account}".` };
    }

    try {
      const contactInput = this.buildContactInput(input);
      const contact = await provider.update(rawId, contactInput);
      return {
        success: true,
        data: contact,
        display: this.accountLabel(account, `Contact updated: ${contact.displayName}`),
      };
    } catch (err) {
      return { success: false, error: `Failed to update contact: ${err instanceof Error ? err.message : String(err)}` };
    }
  }

  private async deleteContact(input: Record<string, unknown>): Promise<SkillResult> {
    const contactId = input.contactId as string;
    if (!contactId) return { success: false, error: 'Missing required field "contactId"' };

    const { account, rawId } = this.decodeId(contactId);
    const providers = this.activeProviders ?? this.providers;
    const provider = providers.get(account);
    if (!provider) {
      return { success: false, error: `Unbekannter Kontakte-Account "${account}".` };
    }

    try {
      await provider.delete(rawId);
      return { success: true, data: { deleted: rawId }, display: this.accountLabel(account, `Contact "${rawId}" deleted.`) };
    } catch (err) {
      return { success: false, error: `Failed to delete contact: ${err instanceof Error ? err.message : String(err)}` };
    }
  }

  private handleListAccounts(providers: Map<string, ContactsProvider>): SkillResult {
    const names = [...providers.keys()];
    if (names.length === 0) {
      return { success: true, data: { accounts: [] }, display: 'Keine Kontakte-Accounts konfiguriert.\nNutze "setup_service" um Kontakte zu verbinden.' };
    }
    return {
      success: true,
      data: { accounts: names, default: names[0] },
      display: `Verfügbare Kontakte-Accounts:\n${names.map((n, i) => `${i === 0 ? '• ' + n + ' (Standard)' : '• ' + n}`).join('\n')}`,
    };
  }

  // ── Helpers ──────────────────────────────────────────────────────

  private buildContactInput(input: Record<string, unknown>): Partial<import('./contacts-provider.js').CreateContactInput> {
    const result: Partial<import('./contacts-provider.js').CreateContactInput> = {};

    if (input.firstName) result.firstName = input.firstName as string;
    if (input.lastName) result.lastName = input.lastName as string;
    if (input.displayName) result.displayName = input.displayName as string;
    if (input.organization) result.organization = input.organization as string;
    if (input.birthday) result.birthday = input.birthday as string;
    if (input.notes) result.notes = input.notes as string;

    // Handle emails: JSON array takes precedence over single string
    if (input.emailAddresses) {
      try {
        result.emails = JSON.parse(input.emailAddresses as string);
      } catch {
        result.emails = [{ address: input.emailAddresses as string }];
      }
    } else if (input.email) {
      result.emails = [{ address: input.email as string, primary: true }];
    }

    // Handle phones: JSON array takes precedence over single string
    if (input.phoneNumbers) {
      try {
        result.phones = JSON.parse(input.phoneNumbers as string);
      } catch {
        result.phones = [{ number: input.phoneNumbers as string }];
      }
    } else if (input.phone) {
      result.phones = [{ number: input.phone as string, primary: true }];
    }

    // Handle addresses
    if (input.addresses) {
      try {
        result.addresses = JSON.parse(input.addresses as string);
      } catch {
        // Ignore invalid JSON
      }
    }

    return result;
  }

  private formatTable(contacts: Contact[], account: string): string {
    const header = '| Name | Email | Phone |\n|------|-------|-------|';
    const rows = contacts.map(c => {
      const email = c.emails[0]?.address ?? '-';
      const phone = c.phones[0]?.number ?? '-';
      const id = this.encodeId(account, c.id);
      return `| ${c.displayName} | ${email} | ${phone} | [id:${id}]`;
    });
    return `${header}\n${rows.join('\n')}`;
  }

  private formatDetail(contact: Contact, account: string): string {
    const lines: string[] = [];
    lines.push(`**Name:** ${contact.displayName}`);
    if (contact.firstName) lines.push(`**First name:** ${contact.firstName}`);
    if (contact.lastName) lines.push(`**Last name:** ${contact.lastName}`);
    if (contact.emails.length > 0) {
      lines.push(`**Email(s):** ${contact.emails.map(e => `${e.address}${e.label ? ` (${e.label})` : ''}`).join(', ')}`);
    }
    if (contact.phones.length > 0) {
      lines.push(`**Phone(s):** ${contact.phones.map(p => `${p.number}${p.label ? ` (${p.label})` : ''}`).join(', ')}`);
    }
    if (contact.addresses.length > 0) {
      for (const a of contact.addresses) {
        const parts = [a.street, a.city, a.region, a.postalCode, a.country].filter(Boolean);
        lines.push(`**Address${a.label ? ` (${a.label})` : ''}:** ${parts.join(', ')}`);
      }
    }
    if (contact.organization) lines.push(`**Organization:** ${contact.organization}`);
    if (contact.birthday) lines.push(`**Birthday:** ${contact.birthday}`);
    if (contact.notes) lines.push(`**Notes:** ${contact.notes}`);
    lines.push(`**ID:** ${this.encodeId(account, contact.id)}`);
    return lines.join('\n');
  }
}
