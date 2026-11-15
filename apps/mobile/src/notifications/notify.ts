import {
  addListener as addTunnelListener, canPresentNotices, presentNotice, takeOpenedNotice, type NativeNotice
} from 'cialai-tunnel';
import { Directory, File, Paths } from 'expo-file-system';
import * as Notifications from 'expo-notifications';
import { Platform } from 'react-native';

import { t } from '../i18n';
import type { LocalNotice, NoticeChannel, NoticeTarget } from './watch';

// Avisos locais, disparados pelo próprio app quando um retrato novo do
// computador chega. Não há push remoto: com o app fechado, ou suspenso pelo
// sistema, nenhum retrato chega e nenhum aviso sai. No Android a conexão fica
// viva em segundo plano pelo serviço do módulo nativo, que também desenha o
// aviso com a imagem da sessão como ícone grande; no iPhone a imagem vai
// anexada, como miniatura.
export type NotificationPermission = 'granted' | 'denied' | 'undetermined';

// No Android, a atenção tem canal próprio, com importância alta para aparecer
// por cima da tela; atividade e uso seguem discretos.
const CHANNELS: Record<NoticeChannel, { key: string; importance: Notifications.AndroidImportance }> = {
  activity: { key: 'mobile.notify.channel', importance: Notifications.AndroidImportance.DEFAULT },
  attention: { key: 'mobile.notify.channel.attention', importance: Notifications.AndroidImportance.HIGH }
};
const MAX_REMEMBERED = 200;
const shown = new Set<string>();
let configured = false;

function configure() {
  if (configured) return;
  configured = true;
  Notifications.setNotificationHandler({
    handleNotification: async () => ({ shouldShowBanner: true, shouldShowList: true, shouldPlaySound: false, shouldSetBadge: false })
  });
  if (Platform.OS === 'android') {
    for (const [id, channel] of Object.entries(CHANNELS)) {
      Notifications.setNotificationChannelAsync(id, { name: t(channel.key), importance: channel.importance }).catch(() => undefined);
    }
  }
}

function stateOf(response: { granted: boolean; canAskAgain: boolean }): NotificationPermission {
  if (response.granted) return 'granted';
  return response.canAskAgain ? 'undetermined' : 'denied';
}

export async function notificationPermission(): Promise<NotificationPermission> {
  try {
    return stateOf(await Notifications.getPermissionsAsync());
  } catch {
    return 'denied';
  }
}

// Pede a permissão uma vez; se o usuário já negou, o sistema não pergunta de
// novo e o caminho é o ajuste do aparelho.
export async function requestNotificationPermission(): Promise<NotificationPermission> {
  try {
    configure();
    const current = await Notifications.getPermissionsAsync();
    if (current.granted || !current.canAskAgain) return stateOf(current);
    const answer = await Notifications.requestPermissionsAsync({ ios: { allowAlert: true, allowBadge: false, allowSound: false } });
    return answer.granted ? 'granted' : 'denied';
  } catch {
    return 'denied';
  }
}

// Mostra cada aviso uma vez por chave, mesmo que o retrato vá e volte.
export async function presentNotices(notices: readonly LocalNotice[]): Promise<void> {
  const fresh = notices.filter(notice => !shown.has(notice.key));
  if (!fresh.length) return;
  configure();
  if ((await notificationPermission()) !== 'granted') return;
  for (const notice of fresh) {
    shown.add(notice.key);
    if (shown.size > MAX_REMEMBERED) shown.delete(shown.values().next().value!);
    if (Platform.OS === 'android' && canPresentNotices()) {
      // O nativo desenha o aviso com a imagem; se ele falhar, sai pelo expo, sem ela.
      if (await presentNotice(nativeNotice(notice)).catch(() => false)) continue;
    }
    const attachment = Platform.OS === 'ios' ? noticeAttachment(notice) : null;
    await Notifications.scheduleNotificationAsync(noticeRequest(notice, attachment)).catch(() => undefined);
  }
}

// O aviso como o módulo Android desenha: a etiqueta faz o aviso novo de uma
// sessão substituir o anterior, como o identificador do expo.
export function nativeNotice(notice: LocalNotice): NativeNotice {
  const channel = notice.channel ?? 'activity';
  return {
    tag: notice.identifier ?? notice.key,
    channel,
    channelName: t(CHANNELS[channel].key),
    title: notice.title,
    body: notice.body,
    ...(notice.subtitle ? { subtitle: notice.subtitle } : {}),
    ...(notice.color ? { color: notice.color } : {}),
    ...(notice.image ? { image: notice.image } : {}),
    ...(notice.target ? { desktopId: notice.target.desktopId, sessionId: notice.target.sessionId } : {})
  };
}

const PNG_BASE64 = /^iVBORw0KGgo[A-Za-z0-9+/]+={0,2}$/;
let attachmentSeq = 0;

// A imagem da sessão num arquivo para o iOS anexar. O sistema move o arquivo
// para o próprio depósito, então cada aviso grava o seu.
export function noticeAttachment(notice: LocalNotice): Notifications.NotificationContentAttachmentIos | null {
  if (!notice.image || !PNG_BASE64.test(notice.image)) return null;
  try {
    const directory = new Directory(Paths.cache, 'notice-badges');
    if (!directory.exists) directory.create({ intermediates: true });
    const file = new File(directory, `badge-${Date.now()}-${attachmentSeq++}.png`);
    const binary = globalThis.atob(notice.image);
    file.write(Uint8Array.from(binary, character => character.charCodeAt(0)));
    return { identifier: 'session', url: file.uri, type: null, typeHint: 'public.png', hideThumbnail: false };
  } catch {
    return null;
  }
}

// Pedido ao sistema para um aviso: título, corpo, o computador como subtítulo
// no iOS, a cor da sessão no Android, a imagem da sessão anexada no iOS e a
// sessão que o toque abre.
export function noticeRequest(notice: LocalNotice,
  attachment: Notifications.NotificationContentAttachmentIos | null = null): Notifications.NotificationRequestInput {
  const channelId = notice.channel ?? 'activity';
  return {
    ...(notice.identifier ? { identifier: notice.identifier } : {}),
    content: {
      title: notice.title,
      body: notice.body,
      ...(notice.subtitle ? { subtitle: notice.subtitle } : {}),
      ...(notice.color ? { color: notice.color } : {}),
      ...(notice.target ? { data: { target: notice.target } } : {}),
      ...(attachment ? { attachments: [attachment] } : {})
    },
    trigger: Platform.OS === 'android' ? { channelId } : null
  };
}

function targetOf(response: Notifications.NotificationResponse | null): NoticeTarget | null {
  const target = response?.notification.request.content.data?.target as Partial<NoticeTarget> | undefined;
  return target && typeof target.desktopId === 'string' && typeof target.sessionId === 'string'
    ? { desktopId: target.desktopId, sessionId: target.sessionId } : null;
}

// Toque num aviso de sessão: com o app aberto, e também quando o toque é que
// abriu o app. A resposta guardada pelo sistema é apagada depois de atendida,
// para a mesma sessão não reabrir na próxima montagem.
export function onNoticeOpened(listener: (target: NoticeTarget) => void): () => void {
  const deliver = (response: Notifications.NotificationResponse | null) => {
    const target = targetOf(response);
    if (!target) return;
    try { Notifications.clearLastNotificationResponse(); } catch { /* sem resposta guardada */ }
    listener(target);
  };
  const subscription = Notifications.addNotificationResponseReceivedListener(deliver);
  try { deliver(Notifications.getLastNotificationResponse()); } catch { /* módulo sem resposta guardada */ }
  // Avisos desenhados pelo Android: o toque chega pelo módulo, que guarda a
  // sessão até ser buscada, também quando o toque é que abriu o app.
  const deliverNative = () => {
    const opened = takeOpenedNotice();
    if (opened) listener({ desktopId: opened.desktopId, sessionId: opened.sessionId });
  };
  const native = Platform.OS === 'android'
    ? addTunnelListener(event => { if (event.kind === 'notice') deliverNative(); })
    : null;
  if (native) deliverNative();
  return () => {
    subscription.remove();
    native?.remove();
  };
}
