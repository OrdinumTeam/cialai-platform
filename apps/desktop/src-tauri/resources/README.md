# Recursos gerados do desktop

`mobile/` é gerado por `npm run build:mobile-resource --workspace @cialai/desktop`
e empacotado pelo Tauri como `$RESOURCE/mobile`. O diretório gerado não deve ser
editado nem versionado; sua entrada é `apps/desktop/mobile.html`.

`tor/` é gerado por `npm run sidecar --workspace @cialai/desktop`, que chama
`tools/build-tunnel.mjs --local`, ou por `node tools/fetch-tor.mjs --stage --target <triplo>`
na release. Ele traz o Tor Expert Bundle fixado por versão e hash, com `tor/tor`,
as bibliotecas ao lado, `data/geoip`, `data/geoip6`, as licenças em `docs/`,
`tor-bundle.json` e `SHA256SUMS`, e é empacotado como `$RESOURCE/tor`. Também não
deve ser editado nem versionado; `node tools/fetch-tor.mjs --verify-resource --target <triplo>`
confere o conteúdo.
