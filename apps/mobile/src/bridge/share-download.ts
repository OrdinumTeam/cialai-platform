import { File, Paths } from 'expo-file-system';
import * as Sharing from 'expo-sharing';

import { t } from '../i18n';
import type { DownloadRequest } from './messages';
import { MAX_DOWNLOAD_BYTES, prepareDataDownload, prepareRemoteDownload } from './downloads';

export async function shareDownload(message: DownloadRequest, allowDevelopmentLoopback = false): Promise<void> {
  if (!(await Sharing.isAvailableAsync())) throw new Error(t('mobile.download.sharingUnavailable'));
  const prepared = typeof message.dataUrl === 'string'
    ? prepareDataDownload(message as Extract<DownloadRequest, { dataUrl: string }>)
    : prepareRemoteDownload(message as Extract<DownloadRequest, { url: string }>, allowDevelopmentLoopback);
  const file = new File(Paths.cache, prepared.name);
  if (file.exists) file.delete();
  try {
    if ('bytes' in prepared) {
      file.create();
      file.write(prepared.bytes);
    } else {
      const controller = new AbortController();
      await File.downloadFileAsync(prepared.url, file, {
        idempotent: true,
        signal: controller.signal,
        onProgress: ({ bytesWritten, totalBytes }) => {
          if (bytesWritten > MAX_DOWNLOAD_BYTES || totalBytes > MAX_DOWNLOAD_BYTES) controller.abort();
        }
      });
      if (file.size > MAX_DOWNLOAD_BYTES) throw new Error(t('mobile.download.fileTooLarge'));
    }
    await Sharing.shareAsync(file.uri, { dialogTitle: t('mobile.download.shareTitle', { name: prepared.name }), mimeType: prepared.mime });
  } finally {
    if (file.exists) file.delete();
  }
}
