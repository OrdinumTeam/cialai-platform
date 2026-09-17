import { requireNativeModule, type EventSubscription } from 'expo-modules-core';

// Espelho TypeScript do núcleo Go v2 do celular. Valores estruturados cruzam
// o nativo em JSON e chegam aqui como objetos; o token nunca é guardado pelo núcleo.

export type Transport = 'direct' | 'tor';
export type PathKind = 'lan' | 'direct' | 'tor';
export type LogLevel = 'error' | 'info' | 'debug';
export type TorState = 'disabled' | 'starting' | 'bootstrapping' | 'ready' | 'failed';

export type DesktopIdentity = { id: string; name: string; fingerprint: string };
export type DeviceDescription = { name: string; model: string; platform: 'ios' | 'android'; app: string };

export type PairInspection = {
  v: 2;
  desktop: DesktopIdentity;
  expiresAt: number;
  candidates: number;
  known: boolean;
  approvalCode: string;
};

export type PairResult = {
  desktopId: string;
  deviceId: string;
  token: string;
  desktop: DesktopIdentity;
  transport: Transport;
};

export type ConnectResult = {
  desktopId: string;
  transport: Transport;
  path: PathKind;
  elapsedMs: number;
};

export type OpenDesktopResult = { url: string; port: number; nonce: string; warning?: string };

export type TorProgress = { state: TorState; progress: number };

export type ActivePath = {
  desktopId: string;
  transport: Transport;
  path: PathKind;
  since: string | number;
};

export type TunnelStatus = {
  state: 'idle' | 'connecting' | 'connected' | 'offline';
  active?: ActivePath | null;
  tor: TorProgress;
  desktops: number;
};

export type DesktopRecord = DesktopIdentity & {
  pairedAt: string;
  lastSeenAt: string;
  lastTransport: Transport | '';
};

// Códigos de erro de `connect` definidos pelo contrato v2.
export type ConnectErrorCode = 'reserve_unavailable' | 'reserve_preparing' | 'desktop_unknown' | 'revoked' | 'no_path';

export type PathEvent = { desktopId: string; transport: Transport | ''; path: PathKind | ''; reason: string };
export type ProxyEvent = { state: string; desktopId?: string; deviceToken?: string; url?: string; port?: number; warning?: string };

export type TunnelEventKind = 'state' | 'path' | 'tor' | 'proxy' | 'pair' | 'log';
// A carga vem do nativo sem garantia de forma; quem consome valida antes de usar.
export type TunnelEvent = { kind: TunnelEventKind; payload: unknown };

type NativeCialaiTunnel = {
  addListener(eventName: 'onTunnelEvent', handler: (event: TunnelEvent) => void): EventSubscription;
  version(): string;
  inspectPairPayload(payload: string): Promise<PairInspection>;
  pair(payload: string, device: DeviceDescription): Promise<PairResult>;
  connect(desktopId: string): Promise<ConnectResult>;
  openDesktop(desktopId: string, deviceToken: string, preferredPort: number): Promise<OpenDesktopResult>;
  closeDesktop(desktopId: string): Promise<void>;
  stop(): Promise<void>;
  status(): Promise<TunnelStatus>;
  desktops(): Promise<{ desktops: DesktopRecord[] }>;
  notifyNetworkChange(reachable: boolean): void;
  notifyForeground(active: boolean): void;
  notifyHealthy(): void;
  forgetDesktop(desktopId: string): Promise<void>;
  setLogLevel(level: LogLevel): void;
};

const nativeModule = requireNativeModule<NativeCialaiTunnel>('CialaiTunnel');

export const version = (): string => nativeModule.version();
export const inspectPairPayload = (payload: string): Promise<PairInspection> =>
  nativeModule.inspectPairPayload(payload);
export const pair = (payload: string, device: DeviceDescription): Promise<PairResult> =>
  nativeModule.pair(payload, device);
export const connect = (desktopId: string): Promise<ConnectResult> => nativeModule.connect(desktopId);
export const openDesktop = (desktopId: string, deviceToken: string, preferredPort = 0): Promise<OpenDesktopResult> =>
  nativeModule.openDesktop(desktopId, deviceToken, preferredPort);
export const closeDesktop = (desktopId: string): Promise<void> => nativeModule.closeDesktop(desktopId);
export const stop = (): Promise<void> => nativeModule.stop();
export const status = (): Promise<TunnelStatus> => nativeModule.status();
export const desktops = async (): Promise<DesktopRecord[]> => (await nativeModule.desktops()).desktops;
export const notifyNetworkChange = (reachable: boolean): void => nativeModule.notifyNetworkChange(reachable);
export const notifyForeground = (active: boolean): void => nativeModule.notifyForeground(active);
// O app confirmou que o proxy aberto responde depois de voltar ao primeiro plano:
// a próxima conexão não precisa recomeçar do zero.
export const notifyHealthy = (): void => nativeModule.notifyHealthy();
export const forgetDesktop = (desktopId: string): Promise<void> => nativeModule.forgetDesktop(desktopId);
export const setLogLevel = (level: LogLevel): void => nativeModule.setLogLevel(level);
export const addListener = (handler: (event: TunnelEvent) => void): EventSubscription =>
  nativeModule.addListener('onTunnelEvent', handler);
