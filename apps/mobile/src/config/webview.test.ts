import { Linking } from 'react-native';
import { createOnShouldStartLoadWithRequest } from 'react-native-webview/lib/WebViewShared';

import { controlOriginWhitelist, isSameControlOrigin } from './url';

const URL = `http://127.0.0.1:47400/?k=${'A'.repeat(43)}`;

test('the installed WebView accepts the local URL before the exact origin guard', () => {
  const loadRequest = jest.fn();
  const exactOriginGuard = jest.fn((request: { url: string }) => isSameControlOrigin(URL, request.url));
  const handler = createOnShouldStartLoadWithRequest(loadRequest, controlOriginWhitelist(URL), exactOriginGuard);
  handler({ nativeEvent: { url: URL, lockIdentifier: 7 } } as never);
  expect(exactOriginGuard).toHaveBeenCalledWith(expect.objectContaining({ url: URL }));
  expect(loadRequest).toHaveBeenCalledWith(true, URL, 7);
});

test('every navigation reaches the app guard before React Native can open it externally', () => {
  const loadRequest = jest.fn();
  const exactOriginGuard = jest.fn(() => false);
  const openUrl = jest.spyOn(Linking, 'openURL').mockResolvedValue(undefined);
  const handler = createOnShouldStartLoadWithRequest(loadRequest, controlOriginWhitelist(URL), exactOriginGuard);
  handler({ nativeEvent: { url: 'javascript:alert(1)', lockIdentifier: 9 } } as never);
  expect(exactOriginGuard).toHaveBeenCalled();
  expect(loadRequest).toHaveBeenCalledWith(false, 'javascript:alert(1)', 9);
  expect(openUrl).not.toHaveBeenCalled();
  openUrl.mockRestore();
});
