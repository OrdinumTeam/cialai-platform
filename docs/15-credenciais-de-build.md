# Credenciais de build e publicação

Nenhum segredo fica neste repositório. Os arquivos reais das builds iOS e Android no Codemagic ficam no repositório privado Ordinum Control, na pasta `secrets/cialai`, e as credenciais compartilhadas por todos os apps da Ordinum ficam em `secrets/ordinum`. Essas pastas são ignoradas pelo Git de lá e cada arquivo tem permissão 600. O procedimento completo de publicação dos apps da Ordinum, com App Store Connect, Google Play e Codemagic, fica na seção `docs/apps` do Ordinum Control.

Preparado em 13/09/2026.

## Onde cada credencial mora

| Credencial | Arquivo no Ordinum Control | Uso no Codemagic |
| --- | --- | --- |
| Chave da API do App Store Connect | `secrets/ordinum/app-store-connect-api-key.p8` | Integração `Advoris ASC API Key` já cadastrada no Codemagic, usada para assinatura, TestFlight e submissão. É a mesma chave da conta Apple da Ordinum usada pelo Advoris |
| Chave RSA de assinatura iOS | `secrets/ordinum/ios-distribution-cert-key.pem` | `CERTIFICATE_PRIVATE_KEY` do grupo `appstore_credentials`, em base64 |
| Conta de serviço do Google Play | `secrets/ordinum/google-play-service-account.json` | `GCLOUD_SERVICE_ACCOUNT_CREDENTIALS` do grupo `google_play`. Conta `ordinum-play-publisher@ordinum.iam.gserviceaccount.com` do projeto `ordinum`, compartilhada por todos os apps da Ordinum |
| Upload keystore Android | `secrets/cialai/upload-keystore.jks` | `CM_KEYSTORE_BASE64` do grupo `android_credentials`. Exclusivo do Cialai, alias `upload` |
| Senhas e alias do keystore | `secrets/cialai/key.properties` | `CM_KEYSTORE_PASSWORD`, `CM_KEY_PASSWORD` e `CM_KEY_ALIAS` do grupo `android_credentials` |
| Token e identificadores da conta | `secrets/ordinum/ordinum.env` | Token da API do Codemagic, emissor e identificador da chave Apple, time e conta do Play, compartilhados por todos os apps |
| Identificadores do app | `secrets/cialai/cialai.env` | Bundle, pacote, identificadores do app na Apple e no Play e caminhos do keystore |

O app `br.com.ordinum.cialai` foi criado no App Store Connect em 13/09/2026 e seu identificador `6811702125` já está em `APP_STORE_APP_ID` no `cialai.env`.

## Cadastro no Codemagic

O Codemagic guarda cópia própria e não lê os arquivos do Ordinum Control. Com o app do Cialai criado no Codemagic apontando para este repositório:

1. A integração App Store Connect é a `Advoris ASC API Key`, já cadastrada com a mesma chave da conta Ordinum. Nenhum cadastro novo é necessário; renomear para um nome da Ordinum exige cadastro manual no painel e troca nos yaml dos apps.
2. No grupo `appstore_credentials`, crie `CERTIFICATE_PRIVATE_KEY` como Secret com o base64 do `.pem`.
3. Nas variáveis do aplicativo, crie `APP_STORE_APP_ID` com o identificador numérico do app na Apple.
4. No grupo `android_credentials`, crie as quatro variáveis do keystore como Secret.
5. No grupo `google_play`, crie `GCLOUD_SERVICE_ACCOUNT_CREDENTIALS` como Secret com o conteúdo do JSON.

Na raiz do Ordinum Control, os valores vão para a área de transferência sem aparecer no terminal:

```sh
base64 -i secrets/ordinum/ios-distribution-cert-key.pem | pbcopy
base64 -i secrets/cialai/upload-keystore.jks | pbcopy
pbcopy < secrets/ordinum/google-play-service-account.json
```

## Pendências fora do repositório

| Item | Estado |
| --- | --- |
| App `br.com.ordinum.cialai` no App Store Connect | Criado em 13/09/2026 |
| App `br.com.ordinum.cialai` no Google Play | Criado em 13/09/2026 |
| App do Cialai no Codemagic com as integrações e grupos acima | Pendente: adicionar pelo painel com a integração GitHub; os grupos são recadastrados pela API em seguida |
| Convite de `ordinum-play-publisher@ordinum.iam.gserviceaccount.com` em Usuários e permissões do Play Console, com permissão na conta inteira | Ativo desde 13/09/2026 |
| Primeiro AAB do app enviado manualmente pelo Play Console, exigência do Google para apps novos | Pendente |
| Chave do updater e certificados de assinatura do desktop | Pendente, fora desta pasta |

## Proteção e rotação

Para conferir a proteção a qualquer momento, na raiz do Ordinum Control:

```sh
for f in secrets/cialai/* secrets/ordinum/*; do git check-ignore -q "$f" && echo "ok $f" || echo "EXPOSTO $f"; done
```

A rotação do token do Codemagic, da chave da Apple e da chave RSA segue a tabela do mapa de credenciais do Advoris. A chave da conta de serviço do Play é trocada com `gcloud iam service-accounts keys create` e `delete` no projeto `ordinum`, com login humano, e a nova chave precisa ir para o grupo `google_play` de todos os apps que a usam. O keystore do Cialai pode ser gerado de novo livremente até o primeiro envio ao Play; depois disso, a troca da chave de upload exige pedido ao suporte do Google.
