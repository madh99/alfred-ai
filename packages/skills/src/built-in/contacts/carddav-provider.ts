import { ContactsProvider } from './contacts-provider.js';
import type { Contact, CreateContactInput } from './contacts-provider.js';
import type { CardDAVContactsConfig } from '@alfred/types';

export class CardDAVContactsProvider extends ContactsProvider {
  private client: any;

  constructor(private readonly config: CardDAVContactsConfig) {
    super();
  }

  async initialize(): Promise<void> {
    try {
      const tsdav = await import('tsdav');
      const { createDAVClient } = tsdav;
      this.client = await createDAVClient({
        serverUrl: this.config.serverUrl,
        credentials: {
          username: this.config.username,
          password: this.config.password,
        },
        authMethod: 'Basic',
        defaultAccountType: 'carddav',
      });
    } catch (err) {
      throw new Error(`CardDAV initialization failed: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  async list(limit?: number, _offset?: number): Promise<Contact[]> {
    const addressBooks = await this.client.fetchAddressBooks();
    if (!addressBooks || addressBooks.length === 0) return [];

    const contacts: Contact[] = [];
    for (const book of addressBooks) {
      const vcards = await this.client.fetchVCards({ addressBook: book });
      for (const vcard of vcards) {
        const parsed = this.parseVCard(vcard.data, vcard.url);
        if (parsed) contacts.push(parsed);
      }
    }

    contacts.sort((a, b) => a.displayName.localeCompare(b.displayName));
    return limit ? contacts.slice(0, limit) : contacts;
  }

  async search(query: string): Promise<Contact[]> {
    // CardDAV text-match REPORT is unreliable across servers, filter client-side
    const all = await this.list();
    const q = query.toLowerCase();
    return all.filter(c =>
      c.displayName.toLowerCase().includes(q) ||
      c.emails.some(e => e.address.toLowerCase().includes(q)) ||
      c.phones.some(p => p.number.includes(q)),
    );
  }

  async get(id: string): Promise<Contact | undefined> {
    const all = await this.list();
    return all.find(c => c.id === id);
  }

  async create(input: CreateContactInput): Promise<Contact> {
    const addressBooks = await this.client.fetchAddressBooks();
    if (!addressBooks || addressBooks.length === 0) {
      throw new Error('No address books found');
    }

    const uid = `alfred-${Date.now()}@alfred`;
    const vcard = this.buildVCard(uid, input);

    await this.client.createVCard({
      addressBook: addressBooks[0],
      filename: `${uid}.vcf`,
      vCardString: vcard,
    });

    const displayName = input.displayName ?? ([input.firstName, input.lastName].filter(Boolean).join(' ') || 'Unknown');
    return {
      id: uid,
      displayName,
      firstName: input.firstName,
      lastName: input.lastName,
      emails: input.emails ?? [],
      phones: input.phones ?? [],
      addresses: input.addresses ?? [],
      organization: input.organization,
      birthday: input.birthday,
      notes: input.notes,
    };
  }

  async update(id: string, input: Partial<CreateContactInput>): Promise<Contact> {
    const addressBooks = await this.client.fetchAddressBooks();
    for (const book of addressBooks) {
      const vcards = await this.client.fetchVCards({ addressBook: book });
      for (const obj of vcards) {
        if (obj.url?.includes(id) || obj.data?.includes(id)) {
          const existing = this.parseVCard(obj.data, obj.url);
          if (!existing) continue;

          const merged: CreateContactInput = {
            firstName: input.firstName ?? existing.firstName,
            lastName: input.lastName ?? existing.lastName,
            displayName: input.displayName ?? existing.displayName,
            emails: input.emails ?? existing.emails,
            phones: input.phones ?? existing.phones,
            addresses: input.addresses ?? existing.addresses,
            organization: input.organization ?? existing.organization,
            birthday: input.birthday ?? existing.birthday,
            notes: input.notes ?? existing.notes,
          };

          const vcard = this.buildVCard(id, merged);
          await this.client.updateVCard({
            vCard: { ...obj, data: vcard },
          });

          const displayName = merged.displayName ?? ([merged.firstName, merged.lastName].filter(Boolean).join(' ') || 'Unknown');
          return {
            id,
            displayName,
            firstName: merged.firstName,
            lastName: merged.lastName,
            emails: merged.emails ?? [],
            phones: merged.phones ?? [],
            addresses: merged.addresses ?? [],
            organization: merged.organization,
            birthday: merged.birthday,
            notes: merged.notes,
          };
        }
      }
    }
    throw new Error(`Contact ${id} not found`);
  }

  async delete(id: string): Promise<void> {
    const addressBooks = await this.client.fetchAddressBooks();
    for (const book of addressBooks) {
      const vcards = await this.client.fetchVCards({ addressBook: book });
      for (const obj of vcards) {
        if (obj.url?.includes(id) || obj.data?.includes(id)) {
          await this.client.deleteVCard({ vCard: obj });
          return;
        }
      }
    }
    throw new Error(`Contact ${id} not found`);
  }

  private parseVCard(data: string, url: string): Contact | undefined {
    const get = (key: string): string | undefined => {
      const match = data.match(new RegExp(`^${key}[;:](.*)$`, 'mi'));
      return match?.[1]?.trim();
    };
    const fn = get('FN');
    if (!fn) return undefined;

    const n = get('N');
    const [lastName, firstName] = n ? n.split(';') : [undefined, undefined];

    const emails: Contact['emails'] = [];
    for (const m of data.matchAll(/^EMAIL[^:]*:(.+)$/gmi)) {
      const line = m[0];
      const addr = m[1].trim();
      const label = line.match(/TYPE=([^;:,]+)/i)?.[1];
      const primary = /TYPE=pref/i.test(line);
      emails.push({ address: addr, label, primary });
    }

    const phones: Contact['phones'] = [];
    for (const m of data.matchAll(/^TEL[^:]*:(.+)$/gmi)) {
      const line = m[0];
      const num = m[1].trim();
      const label = line.match(/TYPE=([^;:,]+)/i)?.[1];
      const primary = /TYPE=pref/i.test(line);
      phones.push({ number: num, label, primary });
    }

    // Parse ADR fields for addresses
    const addresses: Contact['addresses'] = [];
    for (const m of data.matchAll(/^ADR[^:]*:(.+)$/gmi)) {
      const parts = m[1].split(';');
      // ADR: PO Box;Extended;Street;City;Region;PostalCode;Country
      addresses.push({
        street: parts[2]?.trim() || undefined,
        city: parts[3]?.trim() || undefined,
        region: parts[4]?.trim() || undefined,
        postalCode: parts[5]?.trim() || undefined,
        country: parts[6]?.trim() || undefined,
      });
    }

    const org = get('ORG')?.replace(/;.*$/, '');
    const bday = get('BDAY');
    const note = get('NOTE');
    const uid = get('UID') ?? url;

    return { id: uid, displayName: fn, firstName, lastName, emails, phones, addresses, organization: org, birthday: bday, notes: note };
  }

  private buildVCard(uid: string, input: CreateContactInput): string {
    const displayName = input.displayName ?? ([input.firstName, input.lastName].filter(Boolean).join(' ') || 'Unknown');
    let vcard = 'BEGIN:VCARD\r\nVERSION:3.0\r\n';
    vcard += `UID:${uid}\r\n`;
    vcard += `FN:${displayName}\r\n`;
    vcard += `N:${input.lastName ?? ''};${input.firstName ?? ''};;;\r\n`;
    for (const e of input.emails ?? []) {
      vcard += `EMAIL;TYPE=${e.label ?? 'internet'}${e.primary ? ',pref' : ''}:${e.address}\r\n`;
    }
    for (const p of input.phones ?? []) {
      vcard += `TEL;TYPE=${p.label ?? 'voice'}${p.primary ? ',pref' : ''}:${p.number}\r\n`;
    }
    for (const a of input.addresses ?? []) {
      vcard += `ADR;TYPE=${a.label ?? 'home'}:;;${a.street ?? ''};${a.city ?? ''};${a.region ?? ''};${a.postalCode ?? ''};${a.country ?? ''}\r\n`;
    }
    if (input.organization) vcard += `ORG:${input.organization}\r\n`;
    if (input.birthday) vcard += `BDAY:${input.birthday}\r\n`;
    if (input.notes) vcard += `NOTE:${input.notes}\r\n`;
    vcard += 'END:VCARD\r\n';
    return vcard;
  }
}
