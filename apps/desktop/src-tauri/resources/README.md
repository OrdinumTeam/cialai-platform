# Recursos gerados do desktop

`mobile/` é gerado por `npm run build:mobile-resource --workspace @cialai/desktop`
e empacotado pelo Tauri como `$RESOURCE/mobile`. O diretório gerado não deve ser
editado nem versionado; sua entrada é `apps/desktop/mobile.html`.
