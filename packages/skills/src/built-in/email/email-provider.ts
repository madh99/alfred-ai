export interface EmailMessage {
  id: string;
  from: string;
  to: string[];
  subject: string;
  date: Date;
  read: boolean;
  preview?: string;
  hasAttachments?: boolean;
}

export interface EmailDetail extends EmailMessage {
  body: string;
  bodyHtml?: string;
  cc?: string[];
  bcc?: string[];
  attachments?: EmailAttachment[];
}

export interface EmailAttachment {
  id: string;
  name: string;
  contentType: string;
  size: number;
}

export interface SendEmailInput {
  to: string;
  subject: string;
  body: string;
  cc?: string;
  replyTo?: string;
  isHtml?: boolean;
}

export abstract class EmailProvider {
  abstract initialize(): Promise<void>;
  abstract fetchInbox(count: number): Promise<EmailMessage[]>;
  abstract readMessage(id: string): Promise<EmailDetail>;
  abstract searchMessages(query: string, count: number): Promise<EmailMessage[]>;
  abstract sendMessage(input: SendEmailInput): Promise<{ messageId: string }>;
  abstract listFolders(): Promise<string[]>;
  abstract fetchFolder(folder: string, count: number): Promise<EmailMessage[]>;
  abstract downloadAttachment(messageId: string, attachmentId: string): Promise<Buffer>;

  /** Create a draft email without sending. Not all providers support this. */
  async createDraft(_input: SendEmailInput): Promise<{ messageId: string }> {
    throw new Error('Draft creation is not supported by this email provider.');
  }
}
