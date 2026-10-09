import * as Notifications from 'expo-notifications';
import { Platform } from 'react-native';

import { t } from '../i18n';
import type { LocalNotice } from './watch';

// Avisos locais, disparados pelo próprio app quando um retrato novo do
// computador chega. Não há push remoto: com o app fechado, ou suspenso pelo
// sistema, nenhum retrato chega e nenhum aviso sai.
export type NotificationPermission = 'granted' | 'denied' | 'undetermined';

const CHANNEL_ID = 'activity';
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
    Notifications.setNotificationChannelAsync(CHANNEL_ID, {
      name: t('mobile.notify.channel'),
      importance: Notifications.AndroidImportance.DEFAULT
    }).catch(() => undefined);
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
    await Notifications.scheduleNotificationAsync({
      content: { title: notice.title, body: notice.body },
      trigger: Platform.OS === 'android' ? { channelId: CHANNEL_ID } : null
    }).catch(() => undefined);
  }
}
