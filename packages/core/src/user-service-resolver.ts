/**
 * Resolves per-user service configurations from the alfred_users/user_services tables.
 * Skills can use this to load user-specific Email, BMW, Calendar etc. configs.
 *
 * Fallback: if no per-user config exists, returns the global system config.
 */
import type { AlfredUserRepository, UserService } from '@alfred/storage';

export class UserServiceResolver {
  constructor(
    private readonly userRepo: AlfredUserRepository,
  ) {}

  /**
   * Get a user's service config. Falls back to null if not configured.
   * @param alfredUserId - The internal Alfred user ID (from SkillContext.alfredUserId)
   * @param serviceType - e.g. 'email', 'bmw', 'calendar', 'contacts', 'todo'
   * @param serviceName - e.g. 'gmail', 'outlook', 'google-calendar' (optional)
   */
  getServiceConfig(alfredUserId: string | undefined, serviceType: string, serviceName?: string): Record<string, unknown> | null {
    if (!alfredUserId) return null;
    try {
      const service = this.userRepo.getService(alfredUserId, serviceType, serviceName);
      return service?.config ?? null;
    } catch {
      return null;
    }
  }

  /**
   * Get all services of a type for a user.
   */
  getUserServices(alfredUserId: string | undefined, serviceType?: string): UserService[] {
    if (!alfredUserId) return [];
    try {
      const all = this.userRepo.getServices(alfredUserId);
      return serviceType ? all.filter(s => s.serviceType === serviceType) : all;
    } catch {
      return [];
    }
  }

  /**
   * Save a service config for a user (called when user configures via chat).
   */
  saveServiceConfig(alfredUserId: string, serviceType: string, serviceName: string, config: Record<string, unknown>): void {
    this.userRepo.addService(alfredUserId, serviceType, serviceName, config);
  }

  /**
   * Remove a service config for a user.
   */
  removeServiceConfig(alfredUserId: string, serviceType: string, serviceName: string): boolean {
    return this.userRepo.removeService(alfredUserId, serviceType, serviceName);
  }
}
