export interface CalendarEvent {
  id: string;
  title: string;
  start: Date;
  end: Date;
  location?: string;
  description?: string;
  allDay?: boolean;
}

export interface CreateEventInput {
  title: string;
  start: Date;
  end: Date;
  location?: string;
  description?: string;
  allDay?: boolean;
}

export abstract class CalendarProvider {
  abstract initialize(): Promise<void>;
  abstract listEvents(start: Date, end: Date): Promise<CalendarEvent[]>;
  abstract createEvent(input: CreateEventInput): Promise<CalendarEvent>;
  abstract updateEvent(id: string, input: Partial<CreateEventInput>): Promise<CalendarEvent>;
  abstract deleteEvent(id: string): Promise<void>;
  abstract checkAvailability(start: Date, end: Date): Promise<{ available: boolean; conflicts: CalendarEvent[] }>;
}
