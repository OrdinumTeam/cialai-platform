// SPDX-License-Identifier: Apache-2.0

export const DEFAULT_LOCALE = 'pt-BR';
export const SUPPORTED_LOCALES = Object.freeze(['pt-BR', 'en', 'es']);

export const dictionaries = Object.freeze({
  'pt-BR': Object.freeze({
    'action.closeSections': 'Fechar seções',
    'action.openExternal': 'Abrir link fora do Cialai',
    'action.refresh': 'Atualizar dados',
    'appearance.dark': 'Usar aparência escura',
    'appearance.light': 'Usar aparência clara',
    'appearance.system': 'Voltar à aparência do sistema',
    'connection.connected': 'Conectado',
    'connection.connecting': 'Conectando',
    'connection.disabled': 'Aguardando conexão',
    'connection.disconnected': 'Sem conexão',
    'connection.incompatible': 'Atualização necessária',
    'connection.removed': 'Celular removido',
    'desktop.fallback': 'Computador',
    'language.current': 'Português',
    'language.switch': 'Mudar para inglês',
    'navigation.allSections': 'Todas as seções',
    'navigation.mainSections': 'Seções principais',
    'navigation.more': 'Mais',
    'navigation.moreSections': 'Mais seções',
    'state.readOnly': 'Somente visualização',
    'view.terminais.label': 'Terminais',
    'view.terminais.sub': 'Sessões, arquivos e navegador',
  }),
  en: Object.freeze({
    'action.closeSections': 'Close sections',
    'action.openExternal': 'Open link outside Cialai',
    'action.refresh': 'Refresh data',
    'appearance.dark': 'Use dark appearance',
    'appearance.light': 'Use light appearance',
    'appearance.system': 'Use system appearance',
    'connection.connected': 'Connected',
    'connection.connecting': 'Connecting',
    'connection.disabled': 'Waiting for connection',
    'connection.disconnected': 'Offline',
    'connection.incompatible': 'Update required',
    'connection.removed': 'Phone removed',
    'desktop.fallback': 'Computer',
    'language.current': 'English',
    'language.switch': 'Mudar para português',
    'navigation.allSections': 'All sections',
    'navigation.mainSections': 'Main sections',
    'navigation.more': 'More',
    'navigation.moreSections': 'More sections',
    'state.readOnly': 'Read only',
    'view.terminais.label': 'Terminals',
    'view.terminais.sub': 'Sessions, files and browser',
  }),
  es: Object.freeze({
    'action.closeSections': 'Cerrar secciones',
    'action.openExternal': 'Abrir enlace fuera de Cialai',
    'action.refresh': 'Actualizar datos',
    'appearance.dark': 'Usar apariencia oscura',
    'appearance.light': 'Usar apariencia clara',
    'appearance.system': 'Usar apariencia del sistema',
    'connection.connected': 'Conectado',
    'connection.connecting': 'Conectando',
    'connection.disabled': 'Esperando conexión',
    'connection.disconnected': 'Sin conexión',
    'connection.incompatible': 'Actualización necesaria',
    'connection.removed': 'Teléfono eliminado',
    'desktop.fallback': 'Computadora',
    'language.current': 'Español',
    'language.switch': 'Cambiar idioma',
    'navigation.allSections': 'Todas las secciones',
    'navigation.mainSections': 'Secciones principales',
    'navigation.more': 'Más',
    'navigation.moreSections': 'Más secciones',
    'state.readOnly': 'Solo lectura',
    'view.terminais.label': 'Terminales',
    'view.terminais.sub': 'Sesiones, archivos y navegador',
  }),
});

export function normalizeLocale(value) {
  const locale = String(value ?? '').trim().toLowerCase().replaceAll('_', '-');
  if (locale === 'en' || locale.startsWith('en-')) return 'en';
  if (locale === 'es' || locale.startsWith('es-')) return 'es';
  return DEFAULT_LOCALE;
}

export function translate(locale, key, values = {}) {
  const normalized = normalizeLocale(locale);
  const template = dictionaries[normalized][key] ?? dictionaries[DEFAULT_LOCALE][key];
  if (template === undefined) throw new Error(`Missing i18n key: ${key}`);
  return template.replace(/\{([A-Za-z][A-Za-z0-9]*)\}/g, (_, name) => {
    if (!(name in values)) throw new Error(`Missing i18n value: ${key}.${name}`);
    return String(values[name]);
  });
}

export function createI18n(initialLocale = DEFAULT_LOCALE) {
  let locale = normalizeLocale(initialLocale);
  const listeners = new Set();
  return Object.freeze({
    getLocale: () => locale,
    setLocale(value) {
      const next = normalizeLocale(value);
      if (next === locale) return locale;
      locale = next;
      for (const listener of listeners) listener();
      return locale;
    },
    subscribe(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    t: (key, values) => translate(locale, key, values),
  });
}
