/**
 * Resolves per-user service configurations from the alfred_users/user_services tables.
 * Skills can use this to load user-specific Email, BMW, Calendar etc. configs.
 *
 * Fallback: if no per-user config exists, returns the global system config.
 */
import type { AlfredUserRepository, UserService } from '@alfred/storage';

export interface DienstStoerung { serviceType: string; serviceName: string; grund: string; seit: string }

export class UserServiceResolver {
  /** v1315 — gestörte Dienste (Skill konnte den Anbieter nicht bauen), Schlüssel typ/name. */
  private readonly stoerungen = new Map<string, DienstStoerung>();

  constructor(
    private readonly userRepo: AlfredUserRepository,
    private readonly logger?: { warn(o: object, msg: string): void; info(o: object, msg: string): void },
    private readonly now: () => Date = () => new Date(),
  ) {}

  /**
   * v1315 — Realfall 08.10.: der Familienkalender (DB-Dienst mit abgelaufenem Token) fiel still aus der Kontenliste,
   * der Fehler stand nur im Journal. Jetzt: ins Alfred-Log und als offener Zustand für das Lebenszeichen (Befund).
   */
  meldeStoerung(serviceType: string, serviceName: string, grund: string | null): void {
    const key = `${serviceType}/${serviceName}`;
    if (grund === null) {
      if (this.stoerungen.delete(key)) this.logger?.info({ dienst: key }, 'v1315 Dienst wieder nutzbar');
      return;
    }
    const kurz = grund.slice(0, 300);
    const alt = this.stoerungen.get(key);
    if (!alt) this.logger?.warn({ dienst: key, grund: kurz }, 'v1315 Dienst gestört — Anbieter konnte nicht gebaut werden');
    this.stoerungen.set(key, { serviceType, serviceName, grund: kurz, seit: alt?.seit ?? this.now().toISOString() });
  }

  gestoerteDienste(): DienstStoerung[] { return [...this.stoerungen.values()]; }

  /**
   * Get a user's service config. Falls back to null if not configured.
   * @param alfredUserId - The internal Alfred user ID (from SkillContext.alfredUserId)
   * @param serviceType - e.g. 'email', 'bmw', 'calendar', 'contacts', 'todo'
   * @param serviceName - e.g. 'gmail', 'outlook', 'google-calendar' (optional)
   */
  async getServiceConfig(alfredUserId: string | undefined, serviceType: string, serviceName?: string): Promise<Record<string, unknown> | null> {
    if (!alfredUserId) return null;
    try {
      const service = await this.userRepo.getService(alfredUserId, serviceType, serviceName);
      return service?.config ?? null;
    } catch {
      return null;
    }
  }

  /**
   * Get all services of a type for a user.
   */
  async getUserServices(alfredUserId: string | undefined, serviceType?: string): Promise<UserService[]> {
    if (!alfredUserId) return [];
    try {
      const all = await this.userRepo.getServices(alfredUserId);
      return serviceType ? all.filter(s => s.serviceType === serviceType) : all;
    } catch {
      return [];
    }
  }

  /**
   * Save a service config for a user (called when user configures via chat).
   */
  async saveServiceConfig(alfredUserId: string, serviceType: string, serviceName: string, config: Record<string, unknown>): Promise<void> {
    await this.userRepo.addService(alfredUserId, serviceType, serviceName, config);
  }

  /**
   * Remove a service config for a user.
   */
  async removeServiceConfig(alfredUserId: string, serviceType: string, serviceName: string): Promise<boolean> {
    return await this.userRepo.removeService(alfredUserId, serviceType, serviceName);
  }
}
