import { ContactsProvider } from './contacts-provider.js';
import type { Contact, CreateContactInput } from './contacts-provider.js';
import type { MicrosoftContactsConfig } from '@alfred/types';

export class MicrosoftContactsProvider extends ContactsProvider {
  private accessToken = '';
  private readonly userPath: string;

  constructor(private readonly config: MicrosoftContactsConfig & { sharedContacts?: string }) {
    super();
    this.userPath = config.sharedContacts ? `/users/${config.sharedContacts}` : '/me';
  }

  async initialize(): Promise<void> {
    await this.refreshAccessToken();
  }

  private async refreshAccessToken(): Promise<void> {
    const tokenUrl = `https://login.microsoftonline.com/${this.config.tenantId}/oauth2/v2.0/token`;
    const body = new URLSearchParams({
      client_id: this.config.clientId,
      client_secret: this.config.clientSecret,
      refresh_token: this.config.refreshToken,
      grant_type: 'refresh_token',
      scope: 'offline_access',
    });

    const res = await fetch(tokenUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: body.toString(),
    });

    if (!res.ok) {
      throw new Error(`Microsoft token refresh failed: ${res.status}`);
    }

    const data = (await res.json()) as { access_token: string };
    this.accessToken = data.access_token;
  }

  private async graphRequest(path: string, options: RequestInit = {}): Promise<any> {
    const res = await fetch(`https://graph.microsoft.com/v1.0${path}`, {
      ...options,
      headers: {
        Authorization: `Bearer ${this.accessToken}`,
        'Content-Type': 'application/json',
        ...options.headers,
      },
    });

    if (res.status === 401) {
      await this.refreshAccessToken();
      const retry = await fetch(`https://graph.microsoft.com/v1.0${path}`, {
        ...options,
        headers: {
          Authorization: `Bearer ${this.accessToken}`,
          'Content-Type': 'application/json',
          ...options.headers,
        },
      });
      if (!retry.ok) throw new Error(`Graph API error: ${retry.status}`);
      if (retry.status === 204) return undefined;
      return retry.json();
    }

    if (!res.ok) throw new Error(`Graph API error: ${res.status}`);
    if (res.status === 204) return undefined;
    return res.json();
  }

  async list(limit = 50): Promise<Contact[]> {
    const data = await this.graphRequest(`${this.userPath}/contacts?$top=${limit}&$orderby=displayName`);
    return (data.value ?? []).map((c: any) => this.mapContact(c));
  }

  async search(query: string): Promise<Contact[]> {
    try {
      const data = await this.graphRequest(`${this.userPath}/contacts?$search="${encodeURIComponent(query)}"`, {
        headers: { ConsistencyLevel: 'eventual' },
      });
      return (data.value ?? []).map((c: any) => this.mapContact(c));
    } catch {
      // Fallback to $filter if $search is not supported
      const data = await this.graphRequest(`${this.userPath}/contacts?$filter=contains(displayName, '${encodeURIComponent(query)}')`);
      return (data.value ?? []).map((c: any) => this.mapContact(c));
    }
  }

  async get(id: string): Promise<Contact | undefined> {
    try {
      const data = await this.graphRequest(`${this.userPath}/contacts/${id}`);
      return this.mapContact(data);
    } catch {
      return undefined;
    }
  }

  async create(input: CreateContactInput): Promise<Contact> {
    const body = this.buildContactBody(input);
    const data = await this.graphRequest(`${this.userPath}/contacts`, {
      method: 'POST',
      body: JSON.stringify(body),
    });
    return this.mapContact(data);
  }

  async update(id: string, input: Partial<CreateContactInput>): Promise<Contact> {
    const body = this.buildContactBody(input);
    const data = await this.graphRequest(`${this.userPath}/contacts/${id}`, {
      method: 'PATCH',
      body: JSON.stringify(body),
    });
    return this.mapContact(data);
  }

  async delete(id: string): Promise<void> {
    await this.graphRequest(`${this.userPath}/contacts/${id}`, { method: 'DELETE' });
  }

  private mapContact(c: any): Contact {
    const emails: Contact['emails'] = (c.emailAddresses ?? []).map((e: any) => ({
      address: e.address,
      label: e.name ?? undefined,
      primary: false,
    }));
    const phones: Contact['phones'] = [];
    if (c.mobilePhone) phones.push({ number: c.mobilePhone, label: 'mobile' });
    if (c.businessPhones) {
      for (const p of c.businessPhones) {
        phones.push({ number: p, label: 'work' });
      }
    }
    if (c.homePhones) {
      for (const p of c.homePhones) {
        phones.push({ number: p, label: 'home' });
      }
    }

    const addresses: Contact['addresses'] = [];
    if (c.homeAddress && Object.values(c.homeAddress).some(Boolean)) {
      addresses.push({
        street: c.homeAddress.street ?? undefined,
        city: c.homeAddress.city ?? undefined,
        region: c.homeAddress.state ?? undefined,
        postalCode: c.homeAddress.postalCode ?? undefined,
        country: c.homeAddress.countryOrRegion ?? undefined,
        label: 'home',
      });
    }
    if (c.businessAddress && Object.values(c.businessAddress).some(Boolean)) {
      addresses.push({
        street: c.businessAddress.street ?? undefined,
        city: c.businessAddress.city ?? undefined,
        region: c.businessAddress.state ?? undefined,
        postalCode: c.businessAddress.postalCode ?? undefined,
        country: c.businessAddress.countryOrRegion ?? undefined,
        label: 'work',
      });
    }

    const bday = c.birthday ? c.birthday.slice(0, 10) : undefined;

    return {
      id: c.id,
      displayName: c.displayName ?? '(No name)',
      firstName: c.givenName ?? undefined,
      lastName: c.surname ?? undefined,
      emails,
      phones,
      addresses,
      organization: c.companyName ?? undefined,
      birthday: bday,
      notes: c.personalNotes ?? undefined,
    };
  }

  private buildContactBody(input: Partial<CreateContactInput>): Record<string, unknown> {
    const body: Record<string, unknown> = {};

    if (input.firstName !== undefined) body.givenName = input.firstName;
    if (input.lastName !== undefined) body.surname = input.lastName;
    if (input.displayName !== undefined) body.displayName = input.displayName;

    if (input.emails) {
      body.emailAddresses = input.emails.map(e => ({
        address: e.address,
        name: e.label ?? e.address,
      }));
    }

    if (input.phones) {
      const mobile = input.phones.find(p => p.label === 'mobile');
      const work = input.phones.filter(p => p.label === 'work');
      const home = input.phones.filter(p => p.label === 'home');
      const other = input.phones.filter(p => !['mobile', 'work', 'home'].includes(p.label ?? ''));
      if (mobile) body.mobilePhone = mobile.number;
      if (work.length > 0) body.businessPhones = work.map(p => p.number);
      if (home.length > 0) body.homePhones = home.map(p => p.number);
      // Other phones go to businessPhones as fallback
      if (other.length > 0 && !work.length) {
        body.businessPhones = other.map(p => p.number);
      }
    }

    if (input.addresses) {
      for (const a of input.addresses) {
        const addr = {
          street: a.street,
          city: a.city,
          state: a.region,
          postalCode: a.postalCode,
          countryOrRegion: a.country,
        };
        if (a.label === 'work') {
          body.businessAddress = addr;
        } else {
          body.homeAddress = addr;
        }
      }
    }

    if (input.organization !== undefined) body.companyName = input.organization;
    if (input.birthday !== undefined) body.birthday = input.birthday;
    if (input.notes !== undefined) body.personalNotes = input.notes;

    return body;
  }
}
