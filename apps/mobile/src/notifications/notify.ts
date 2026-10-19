import * as Notifications from 'expo-notifications';
import { Platform } from 'react-native';

import { t } from '../i18n';
import type { LocalNotice, NoticeChannel, NoticeTarget } from './watch';

// Avisos locais, disparados pelo próprio app quando um retrato novo do
// computador chega. Não há push remoto: com o app fechado, ou suspenso pelo
// sistema, nenhum retrato chega e nenhum aviso sai.
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
    await Notifications.scheduleNotificationAsync(noticeRequest(notice)).catch(() => undefined);
  }
}

// Pedido ao sistema para um aviso: título, corpo, o computador como subtítulo
// no iOS, a cor da sessão no Android e a sessão que o toque abre.
export function noticeRequest(notice: LocalNotice): Notifications.NotificationRequestInput {
  const channelId = notice.channel ?? 'activity';
  return {
    ...(notice.identifier ? { identifier: notice.identifier } : {}),
    content: {
      title: notice.title,
      body: notice.body,
      ...(notice.subtitle ? { subtitle: notice.subtitle } : {}),
      ...(notice.color ? { color: notice.color } : {}),
      ...(notice.target ? { data: { target: notice.target } } : {})
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
  return () => subscription.remove();
}
