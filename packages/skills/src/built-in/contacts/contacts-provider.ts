export interface Contact {
  id: string;
  displayName: string;
  firstName?: string;
  lastName?: string;
  emails: { address: string; label?: string; primary?: boolean }[];
  phones: { number: string; label?: string; primary?: boolean }[];
  addresses: { street?: string; city?: string; region?: string; postalCode?: string; country?: string; label?: string }[];
  organization?: string;
  birthday?: string;
  notes?: string;
}

export interface CreateContactInput {
  firstName?: string;
  lastName?: string;
  displayName?: string;
  emails?: { address: string; label?: string; primary?: boolean }[];
  phones?: { number: string; label?: string; primary?: boolean }[];
  addresses?: { street?: string; city?: string; region?: string; postalCode?: string; country?: string; label?: string }[];
  organization?: string;
  birthday?: string;
  notes?: string;
}

export abstract class ContactsProvider {
  abstract initialize(): Promise<void>;
  abstract search(query: string): Promise<Contact[]>;
  abstract get(id: string): Promise<Contact | undefined>;
  abstract list(limit?: number, offset?: number): Promise<Contact[]>;
  abstract create(input: CreateContactInput): Promise<Contact>;
  abstract update(id: string, input: Partial<CreateContactInput>): Promise<Contact>;
  abstract delete(id: string): Promise<void>;
}
