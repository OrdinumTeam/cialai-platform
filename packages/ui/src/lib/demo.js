// SPDX-License-Identifier: Apache-2.0
// Chaves de demonstração na URL: `?terminais=demo`, `?tunnel=demo` e
// `?notch=demo:…` trocam as integrações por dados fictícios, para capturas e
// checagens em navegador. Dentro do app do computador, que roda no Tauri, e da
// página aberta pelo celular, que recebe a casca nativa, a chave é ignorada:
// uma tela de produção nunca mostra sessão, conta ou número inventado.

export function hostedInApp(win = typeof window !== 'undefined' ? window : undefined) {
  if (!win) return false;
  return Boolean(win.__TAURI_INTERNALS__ || win.__CIALAI_SHELL__ || win.ReactNativeWebView);
}

// Valor da chave na URL, ou nulo quando a página roda dentro de um dos apps.
export function demoParam(name, search, win = typeof window !== 'undefined' ? window : undefined) {
  if (hostedInApp(win)) return null;
  try {
    return new URLSearchParams(search ?? win?.location?.search ?? '').get(name);
  } catch (_error) {
    return null;
  }
}
