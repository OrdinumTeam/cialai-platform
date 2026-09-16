import * as LocalAuthentication from 'expo-local-authentication';
import type { AppStateStatus } from 'react-native';

import { t } from '../i18n';

export type AuthLevel = 'session' | 'action';
export type Authenticate = (reason: string) => Promise<boolean>;

// Quando a biometria é pedida, escolha dos ajustes: sempre, como o desenho
// original, só ao abrir o computador, ou nunca.
export type BiometricPolicy = 'always' | 'session' | 'off';
export const BIOMETRIC_POLICIES: readonly BiometricPolicy[] = ['always', 'session', 'off'];
export const BIOMETRIC_STORAGE_KEY = 'cialai.biometrics';

export function normalizeBiometricPolicy(value: unknown): BiometricPolicy {
  return value === 'session' || value === 'off' ? value : 'always';
}

export const SESSION_BACKGROUND_TTL_MS = 5 * 60 * 1_000;

export async function authenticateWithDevice(reason: string): Promise<boolean> {
  try {
    const result = await LocalAuthentication.authenticateAsync({
      promptMessage: reason,
      cancelLabel: t('mobile.biometric.cancel'),
      fallbackLabel: t('mobile.biometric.fallback'),
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
  private policy: BiometricPolicy = 'always';
  private queue: Promise<void> = Promise.resolve();

  constructor(
    private readonly authenticate: Authenticate,
    private readonly now: () => number = Date.now
  ) {}

  isUnlocked(): boolean {
    return this.unlocked;
  }

  getPolicy(): BiometricPolicy {
    return this.policy;
  }

  setPolicy(policy: BiometricPolicy): void {
    this.policy = normalizeBiometricPolicy(policy);
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
    // Desligada: nada pergunta, e a sessão conta como aberta para a página.
    if (this.policy === 'off') {
      this.unlocked = true;
      return Promise.resolve(true);
    }
    // Só ao abrir: cada ação vale como abertura, confirmada uma vez por
    // sessão e de novo depois do tempo em segundo plano.
    const effective: AuthLevel = this.policy === 'session' ? 'session' : level;
    const requestedAtEpoch = this.epoch;
    return new Promise(resolve => {
      this.queue = this.queue
        .then(async () => {
          if (requestedAtEpoch !== this.epoch) return resolve(false);
          if (effective === 'session' && this.unlocked) return resolve(true);
          const ok = await this.authenticate(reason);
          const current = requestedAtEpoch === this.epoch;
          if (ok && current && effective === 'session') this.unlocked = true;
          resolve(ok && current);
        })
        .catch(() => resolve(false));
    });
  }
}
