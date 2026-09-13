import * as LocalAuthentication from 'expo-local-authentication';
import type { AppStateStatus } from 'react-native';

export type AuthLevel = 'session' | 'action';
export type Authenticate = (reason: string) => Promise<boolean>;

export const SESSION_BACKGROUND_TTL_MS = 5 * 60 * 1_000;

export async function authenticateWithDevice(reason: string): Promise<boolean> {
  try {
    const result = await LocalAuthentication.authenticateAsync({
      promptMessage: reason,
      cancelLabel: 'Cancelar',
      fallbackLabel: 'Usar código',
      disableDeviceFallback: false
    });
    return result.success;
  } catch {
    return false;
  }
}

export class BiometricSession {
  private unlocked = false;
  private backgroundedAt: number | null = null;
  private epoch = 0;
  private queue: Promise<void> = Promise.resolve();

  constructor(
    private readonly authenticate: Authenticate,
    private readonly now: () => number = Date.now
  ) {}

  isUnlocked(): boolean {
    return this.unlocked;
  }

  lock(): boolean {
    const wasUnlocked = this.unlocked;
    this.epoch += 1;
    this.unlocked = false;
    return wasUnlocked;
  }

  handleAppState(nextState: AppStateStatus): boolean {
    if (nextState !== 'active') {
      if (this.backgroundedAt === null) this.backgroundedAt = this.now();
      return false;
    }
    if (this.backgroundedAt === null) return false;
    const elapsed = this.now() - this.backgroundedAt;
    this.backgroundedAt = null;
    if (elapsed < SESSION_BACKGROUND_TTL_MS) return false;
    this.lock();
    return true;
  }

  authorize(level: AuthLevel, reason: string): Promise<boolean> {
    const requestedAtEpoch = this.epoch;
    return new Promise(resolve => {
      this.queue = this.queue
        .then(async () => {
          if (requestedAtEpoch !== this.epoch) return resolve(false);
          if (level === 'session' && this.unlocked) return resolve(true);
          const ok = await this.authenticate(reason);
          const current = requestedAtEpoch === this.epoch;
          if (ok && current && level === 'session') this.unlocked = true;
          resolve(ok && current);
        })
        .catch(() => resolve(false));
    });
  }
}
