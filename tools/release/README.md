# Release móvel

## Chave do atualizador do desktop

Esta etapa depende do usuário porque a chave privada nunca entra no repositório. Gere o par fora da árvore do projeto:

```sh
npm exec --workspace @cialai/desktop -- tauri signer generate -- -w "$HOME/.tauri/cialai-updater.key"
```

Copie o conteúdo da chave pública gerada para `plugins.updater.pubkey` em `apps/desktop/src-tauri/tauri.conf.json`. Guarde a chave privada completa no secret `TAURI_SIGNING_PRIVATE_KEY` e a senha no secret `TAURI_SIGNING_PRIVATE_KEY_PASSWORD` do GitHub. O check de release falha enquanto a chave pública estiver com o marcador.

Os workflows em `codemagic.yaml` não têm disparo automático. Os atalhos desta pasta usam a API do Codemagic somente quando as variáveis locais são fornecidas de forma explícita.

## Configuração local

Copie apenas os nomes de `tools/release/.env.example` para um arquivo ignorado pelo Git ou exporte as variáveis no shell. Para guardar esse arquivo fora do repositório, defina `CIALAI_RELEASE_ENV_FILE` com o caminho absoluto.

Nunca versione tokens, chaves da App Store, chaves de assinatura ou credenciais das lojas.

## Atalhos

| Comando | Ação |
| --- | --- |
| `cm-trigger.sh ios-testflight main` | Dispara o workflow escolhido |
| `cm-watch.sh BUILD_ID` | Acompanha o build a cada 15 segundos |
| `cm-log.sh BUILD_ID --download` | Mostra o resumo e baixa logs sem expor URLs assinadas |
| `cm-publish.sh ios-testflight main` | Dispara, acompanha e resume |
| `asc_api.py builds` | Consulta a App Store Connect |
| `play_api.py status` | Consulta as faixas no Google Play |
| `play_api.py upload APP.aab internal` | Valida um AAB e descarta o ensaio sem publicar |
| `ios-gen-signing-key.sh` | Gera localmente a chave RSA em `secrets` |

Criar o app, configurar integrações e iniciar builds continuam sendo ações manuais do usuário.
