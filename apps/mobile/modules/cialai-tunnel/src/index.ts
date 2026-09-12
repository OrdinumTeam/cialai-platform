import { EventEmitter, requireNativeModule, type EventSubscription } from 'expo-modules-core';

export type TunnelEventKind = 'state' | 'peer' | 'proxy' | 'pair' | 'log';
export type TunnelEvent = { kind: TunnelEventKind; payload: unknown };

export type PairInspection = {
  v: 1;
  control: string;
  userId: string;
  userName: string;
  desktop: { id: string; name: string; port: number };
  expiresAt: number;
  hasAuthKey: boolean;
  profileMatch: 'existing' | 'new';
};

export type PairResult = {
  profileId: string;
  desktopId: string;
  deviceId: string;
  token: string;
  desktop: { id: string; name: string; port: number; nodeKey: string };
  nodeKey: string;
};

export type TunnelStatus = {
  state: 'stopped' | 'starting' | 'needs-login' | 'running' | 'offline';
  ip4?: string;
  ip6?: string;
  dnsName?: string;
  nodeKey?: string;
  keyExpiry?: string;
  health?: string[];
  peers: Array<{
    nodeKey: string;
    name: string;
    online: boolean;
    ip4?: string;
    ip6?: string;
    lastSeen?: string;
  }>;
};

type NativeCialaiTunnel = {
  version(): string;
  inspectPairPayload(payload: string): Promise<PairInspection>;
  pair(
    payload: string,
    device: { name: string; model: string; platform: 'ios' | 'android'; app: string }
  ): Promise<PairResult>;
  startProfile(profileId: string): Promise<void>;
  stop(): Promise<void>;
  status(): Promise<TunnelStatus>;
  openDesktop(
    desktopId: string,
    deviceToken: string,
    preferredPort?: number
  ): Promise<{ url: string; port: number; nonce: string; warning?: string }>;
  closeDesktop(desktopId: string): Promise<void>;
  notifyNetworkChange(reachable: boolean): void;
  notifyForeground(active: boolean): void;
  forgetProfile(profileId: string): Promise<void>;
  setLogLevel(level: 'error' | 'info' | 'debug'): void;
};

const nativeModule = requireNativeModule<NativeCialaiTunnel>('CialaiTunnel');
const emitter = new EventEmitter(nativeModule);

export const version = (): string => nativeModule.version();
export const inspectPairPayload = (payload: string): Promise<PairInspection> =>
  nativeModule.inspectPairPayload(payload);
export const pair = (
  payload: string,
  device: { name: string; model: string; platform: 'ios' | 'android'; app: string }
): Promise<PairResult> => nativeModule.pair(payload, device);
export const startProfile = (profileId: string): Promise<void> => nativeModule.startProfile(profileId);
export const stop = (): Promise<void> => nativeModule.stop();
export const status = (): Promise<TunnelStatus> => nativeModule.status();
export const openDesktop = (
  desktopId: string,
  deviceToken: string,
  preferredPort = 0
): Promise<{ url: string; port: number; nonce: string; warning?: string }> =>
  nativeModule.openDesktop(desktopId, deviceToken, preferredPort);
export const closeDesktop = (desktopId: string): Promise<void> => nativeModule.closeDesktop(desktopId);
export const notifyNetworkChange = (reachable: boolean): void =>
  nativeModule.notifyNetworkChange(reachable);
export const notifyForeground = (active: boolean): void => nativeModule.notifyForeground(active);
export const forgetProfile = (profileId: string): Promise<void> => nativeModule.forgetProfile(profileId);
export const setLogLevel = (level: 'error' | 'info' | 'debug'): void => nativeModule.setLogLevel(level);
export const addListener = (handler: (event: TunnelEvent) => void): EventSubscription =>
  emitter.addListener<TunnelEvent>('onTunnelEvent', handler);
