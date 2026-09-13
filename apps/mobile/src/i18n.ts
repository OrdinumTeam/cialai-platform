// SPDX-License-Identifier: Apache-2.0
import { createI18n } from '@cialai/i18n';

const detectedLocale = Intl.DateTimeFormat().resolvedOptions().locale;
export const i18n = createI18n(detectedLocale);
export const getLocale = i18n.getLocale;
export const setLocale = i18n.setLocale;
export const subscribeLocale = i18n.subscribe;
export const t = i18n.t;
