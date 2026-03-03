import type { SkillMetadata, SkillContext, SkillResult } from '@alfred/types';
import { Skill } from '../../skill.js';
import type { ContactsProvider, Contact } from './contacts-provider.js';

type ContactsAction = 'search' | 'get' | 'list' | 'create' | 'update' | 'delete';

export class ContactsSkill extends Skill {
  readonly metadata: SkillMetadata = {
    name: 'contacts',
    description:
      'Manage contacts. Search, view, create, update, or delete contacts.',
    riskLevel: 'write',
    version: '1.0.0',
    inputSchema: {
      type: 'object',
      properties: {
        action: {
          type: 'string',
          enum: ['search', 'get', 'list', 'create', 'update', 'delete'],
          description: 'The contacts action to perform',
        },
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

  constructor(private readonly contactsProvider: ContactsProvider) {
    super();
  }

  async execute(input: Record<string, unknown>, _context: SkillContext): Promise<SkillResult> {
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
      default:
        return { success: false, error: `Unknown action: "${String(action)}"` };
    }
  }

  private async searchContacts(input: Record<string, unknown>): Promise<SkillResult> {
    const query = input.query as string;
    if (!query) return { success: false, error: 'Missing required field "query"' };

    try {
      const contacts = await this.contactsProvider.search(query);

      if (contacts.length === 0) {
        return { success: true, data: [], display: `No contacts found for "${query}".` };
      }

      const display = this.formatTable(contacts);
      return { success: true, data: contacts, display: `${contacts.length} contact(s) found:\n${display}` };
    } catch (err) {
      return { success: false, error: `Failed to search contacts: ${err instanceof Error ? err.message : String(err)}` };
    }
  }

  private async getContact(input: Record<string, unknown>): Promise<SkillResult> {
    const contactId = input.contactId as string;
    if (!contactId) return { success: false, error: 'Missing required field "contactId"' };

    try {
      const contact = await this.contactsProvider.get(contactId);
      if (!contact) {
        return { success: false, error: `Contact "${contactId}" not found.` };
      }

      const display = this.formatDetail(contact);
      return { success: true, data: contact, display };
    } catch (err) {
      return { success: false, error: `Failed to get contact: ${err instanceof Error ? err.message : String(err)}` };
    }
  }

  private async listContacts(input: Record<string, unknown>): Promise<SkillResult> {
    const limit = (input.limit as number) ?? 50;

    try {
      const contacts = await this.contactsProvider.list(limit);

      if (contacts.length === 0) {
        return { success: true, data: [], display: 'No contacts found.' };
      }

      const display = this.formatTable(contacts);
      return { success: true, data: contacts, display: `${contacts.length} contact(s):\n${display}` };
    } catch (err) {
      return { success: false, error: `Failed to list contacts: ${err instanceof Error ? err.message : String(err)}` };
    }
  }

  private async createContact(input: Record<string, unknown>): Promise<SkillResult> {
    try {
      const contactInput = this.buildContactInput(input);
      const contact = await this.contactsProvider.create(contactInput);
      return {
        success: true,
        data: contact,
        display: `Contact created: ${contact.displayName}`,
      };
    } catch (err) {
      return { success: false, error: `Failed to create contact: ${err instanceof Error ? err.message : String(err)}` };
    }
  }

  private async updateContact(input: Record<string, unknown>): Promise<SkillResult> {
    const contactId = input.contactId as string;
    if (!contactId) return { success: false, error: 'Missing required field "contactId"' };

    try {
      const contactInput = this.buildContactInput(input);
      const contact = await this.contactsProvider.update(contactId, contactInput);
      return {
        success: true,
        data: contact,
        display: `Contact updated: ${contact.displayName}`,
      };
    } catch (err) {
      return { success: false, error: `Failed to update contact: ${err instanceof Error ? err.message : String(err)}` };
    }
  }

  private async deleteContact(input: Record<string, unknown>): Promise<SkillResult> {
    const contactId = input.contactId as string;
    if (!contactId) return { success: false, error: 'Missing required field "contactId"' };

    try {
      await this.contactsProvider.delete(contactId);
      return { success: true, data: { deleted: contactId }, display: `Contact "${contactId}" deleted.` };
    } catch (err) {
      return { success: false, error: `Failed to delete contact: ${err instanceof Error ? err.message : String(err)}` };
    }
  }

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

  private formatTable(contacts: Contact[]): string {
    const header = '| Name | Email | Phone |\n|------|-------|-------|';
    const rows = contacts.map(c => {
      const email = c.emails[0]?.address ?? '-';
      const phone = c.phones[0]?.number ?? '-';
      return `| ${c.displayName} | ${email} | ${phone} |`;
    });
    return `${header}\n${rows.join('\n')}`;
  }

  private formatDetail(contact: Contact): string {
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
    lines.push(`**ID:** ${contact.id}`);
    return lines.join('\n');
  }
}
