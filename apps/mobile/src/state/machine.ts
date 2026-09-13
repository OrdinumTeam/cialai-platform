export type OfflineReason = 'tunnel' | 'desktop' | 'server' | 'reconnecting' | 'removed';

export type AppScreen =
  | { kind: 'loading' }
  | { kind: 'pair'; error?: string }
  | { kind: 'desktops' }
  | { kind: 'settings' }
  | { kind: 'shell'; desktopId: string; url: string }
  | { kind: 'offline'; desktopId: string; reason: OfflineReason };

export type AppAction =
  | { type: 'needs-pairing'; error?: string }
  | { type: 'show-desktops' }
  | { type: 'show-settings' }
  | { type: 'desktop-opened'; desktopId: string; url: string }
  | { type: 'desktop-offline'; desktopId: string; reason: OfflineReason };

export function transition(_screen: AppScreen, action: AppAction): AppScreen {
  switch (action.type) {
    case 'needs-pairing': return { kind: 'pair', ...(action.error ? { error: action.error } : {}) };
    case 'show-desktops': return { kind: 'desktops' };
    case 'show-settings': return { kind: 'settings' };
    case 'desktop-opened': return { kind: 'shell', desktopId: action.desktopId, url: action.url };
    case 'desktop-offline': return { kind: 'offline', desktopId: action.desktopId, reason: action.reason };
  }
}
