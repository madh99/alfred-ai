import { ContactsProvider } from './contacts-provider.js';
import type { Contact, CreateContactInput } from './contacts-provider.js';
import type { GoogleContactsConfig } from '@alfred/types';

const PERSON_FIELDS = 'names,emailAddresses,phoneNumbers,addresses,organizations,birthdays,biographies';
const PEOPLE_API = 'https://people.googleapis.com/v1';

export class GoogleContactsProvider extends ContactsProvider {
  private accessToken = '';

  constructor(private readonly config: GoogleContactsConfig) {
    super();
  }

  async initialize(): Promise<void> {
    await this.refreshAccessToken();
  }

  private async refreshAccessToken(): Promise<void> {
    const body = new URLSearchParams({
      client_id: this.config.clientId,
      client_secret: this.config.clientSecret,
      refresh_token: this.config.refreshToken,
      grant_type: 'refresh_token',
    });

    const res = await fetch('https://oauth2.googleapis.com/token', {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: body.toString(),
    });

    if (!res.ok) {
      throw new Error(`Google token refresh failed: ${res.status}`);
    }

    const data = (await res.json()) as { access_token: string };
    this.accessToken = data.access_token;
  }

  private async apiRequest(method: string, url: string, body?: unknown): Promise<any> {
    const options: RequestInit = {
      method,
      headers: {
        Authorization: `Bearer ${this.accessToken}`,
        'Content-Type': 'application/json',
      },
    };
    if (body) options.body = JSON.stringify(body);

    const res = await fetch(url, options);

    if (res.status === 401) {
      await this.refreshAccessToken();
      const retry = await fetch(url, {
        ...options,
        headers: {
          Authorization: `Bearer ${this.accessToken}`,
          'Content-Type': 'application/json',
        },
      });
      if (!retry.ok) throw new Error(`People API error: ${retry.status}`);
      if (retry.status === 204) return undefined;
      return retry.json();
    }

    if (!res.ok) throw new Error(`People API error: ${res.status}`);
    if (res.status === 204) return undefined;
    return res.json();
  }

  async list(limit = 50): Promise<Contact[]> {
    const url = `${PEOPLE_API}/people/me/connections?personFields=${PERSON_FIELDS}&pageSize=${limit}`;
    const data = await this.apiRequest('GET', url);
    return (data.connections ?? []).map((p: any) => this.mapPerson(p));
  }

  async search(query: string): Promise<Contact[]> {
    const url = `${PEOPLE_API}/people:searchContacts?query=${encodeURIComponent(query)}&readMask=${PERSON_FIELDS}&pageSize=30`;
    const data = await this.apiRequest('GET', url);
    return (data.results ?? []).map((r: any) => this.mapPerson(r.person));
  }

  async get(id: string): Promise<Contact | undefined> {
    try {
      const url = `${PEOPLE_API}/${id}?personFields=${PERSON_FIELDS}`;
      const data = await this.apiRequest('GET', url);
      return this.mapPerson(data);
    } catch {
      return undefined;
    }
  }

  async create(input: CreateContactInput): Promise<Contact> {
    const body = this.buildPersonBody(input);
    const data = await this.apiRequest('POST', `${PEOPLE_API}/people:createContact`, body);
    return this.mapPerson(data);
  }

  async update(id: string, input: Partial<CreateContactInput>): Promise<Contact> {
    // Fetch existing to get etag
    const existing = await this.apiRequest('GET', `${PEOPLE_API}/${id}?personFields=${PERSON_FIELDS}`);
    const body = this.buildPersonBody(input);
    body.etag = existing.etag;

    const updateFields = 'names,emailAddresses,phoneNumbers,addresses,organizations,birthdays,biographies';
    const url = `${PEOPLE_API}/${id}:updateContact?updatePersonFields=${updateFields}`;
    const data = await this.apiRequest('PATCH', url, body);
    return this.mapPerson(data);
  }

  async delete(id: string): Promise<void> {
    await this.apiRequest('DELETE', `${PEOPLE_API}/${id}:deleteContact`);
  }

  private mapPerson(person: any): Contact {
    const name = person.names?.[0];
    const emails: Contact['emails'] = (person.emailAddresses ?? []).map((e: any) => ({
      address: e.value,
      label: e.type,
      primary: e.metadata?.primary ?? false,
    }));
    const phones: Contact['phones'] = (person.phoneNumbers ?? []).map((p: any) => ({
      number: p.value,
      label: p.type,
      primary: p.metadata?.primary ?? false,
    }));
    const addresses: Contact['addresses'] = (person.addresses ?? []).map((a: any) => ({
      street: a.streetAddress ?? undefined,
      city: a.city ?? undefined,
      region: a.region ?? undefined,
      postalCode: a.postalCode ?? undefined,
      country: a.country ?? undefined,
      label: a.type ?? undefined,
    }));
    const org = person.organizations?.[0]?.name;
    const bday = person.birthdays?.[0]?.date
      ? `${person.birthdays[0].date.year ?? '????'}-${String(person.birthdays[0].date.month).padStart(2, '0')}-${String(person.birthdays[0].date.day).padStart(2, '0')}`
      : undefined;
    const notes = person.biographies?.[0]?.value;

    return {
      id: person.resourceName ?? person.etag ?? '',
      displayName: name?.displayName ?? '(No name)',
      firstName: name?.givenName,
      lastName: name?.familyName,
      emails,
      phones,
      addresses,
      organization: org,
      birthday: bday,
      notes,
    };
  }

  private buildPersonBody(input: Partial<CreateContactInput>): any {
    const body: any = {};

    if (input.firstName !== undefined || input.lastName !== undefined || input.displayName !== undefined) {
      body.names = [{
        givenName: input.firstName,
        familyName: input.lastName,
        displayName: input.displayName,
      }];
    }

    if (input.emails) {
      body.emailAddresses = input.emails.map(e => ({
        value: e.address,
        type: e.label ?? 'home',
      }));
    }

    if (input.phones) {
      body.phoneNumbers = input.phones.map(p => ({
        value: p.number,
        type: p.label ?? 'mobile',
      }));
    }

    if (input.addresses) {
      body.addresses = input.addresses.map(a => ({
        streetAddress: a.street,
        city: a.city,
        region: a.region,
        postalCode: a.postalCode,
        country: a.country,
        type: a.label ?? 'home',
      }));
    }

    if (input.organization) {
      body.organizations = [{ name: input.organization }];
    }

    if (input.birthday) {
      const parts = input.birthday.split('-');
      body.birthdays = [{
        date: {
          year: parts[0] !== '????' ? parseInt(parts[0], 10) : undefined,
          month: parseInt(parts[1], 10),
          day: parseInt(parts[2], 10),
        },
      }];
    }

    if (input.notes) {
      body.biographies = [{ value: input.notes, contentType: 'TEXT_PLAIN' }];
    }

    return body;
  }
}
