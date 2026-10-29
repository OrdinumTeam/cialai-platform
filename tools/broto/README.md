# Distribuição do Broto

## Instalação pelo monitor

O pacote nativo instala a janela Cialai Broto. Quando o serviço ainda não existe,
a janela oferece Instalar e iniciar serviço. Ela chama o executável empacotado
com `instalar --payload CAMINHO --key CHAVE_PUBLICA`, sem shell. A chave vem do
build confiável do monitor, não do próprio payload. O serviço verifica a
assinatura minisign em Go, todos os arquivos e a ausência de extras e links.
O macOS exige também codesign e Gatekeeper antes de instalar.

O instalador copia uma versão imutável para a pasta privada do usuário,
configura o serviço e a checagem assinada a cada seis horas. Não precisa de
Node ou do comando minisign instalado. Fechar a janela mantém o serviço.

No Windows, o sistema pede elevação e a credencial protegida da mesma conta
sem privilégios usada pelo monitor. A senha nunca vai em argumento, log ou
arquivo do Broto. A conta recebe SeServiceLogonRight e SeBatchLogonRight,
controle apenas do seu serviço e tarefa agendada limitada. O perfil e a pasta
de estado são explícitos. A senha da tarefa fica sob a proteção do Windows.
O usuário não recebe SERVICE_CHANGE_CONFIG. O SCM mantém um launcher fixo,
sempre na conta comum, que supervisiona o executável atual. Atualizar troca
somente o ponteiro privado e aguarda o PID correto confirmar saúde. Assim,
a permissão de atualizar não permite trocar a conta do serviço para SYSTEM.
Contas de administrador são recusadas por padrão. SmartScreen pode avisar
editor desconhecido porque esta versão não usa Authenticode.

## Instalação sem tela

```sh
cialai-broto instalar --payload PAYLOAD_ASSINADO --key CHAVE_PUBLICA_CONFIAVEL
```

Use `--prepare-only` para copiar a versão verificada e devolver o plano sem
escrever descritores do sistema nem executar comandos de serviço. A instalação
pode ser repetida depois de uma falha, desde que os arquivos existentes sejam
exatamente os mesmos da versão assinada. Configuração diferente é preservada.

No macOS, o padrão é LaunchAgent por usuário, iniciado no login. Para iniciar
no boot sem login, use `--headless`. O sistema pede autorização administrativa
para instalar dois LaunchDaemons root-owned, mas ambos executam com UserName e
GroupName da conta sem privilégios. O supervisor lê o ponteiro privado da versão
e confirma a saúde do processo novo, sem exigir nova elevação a cada atualização.

No Linux, o padrão é systemd por usuário. `--linger` ou `--headless` solicita
`loginctl enable-linger` de forma explícita, permitindo boot e execução após
logout. A política administrativa da máquina pode pedir autenticação.

Parear pede o código no stdin. Nunca passe o código como argumento. `status`,
`pausar`, `retomar` e `desconectar` usam somente IPC protegido do usuário.

## Atualização

O serviço tem um job separado de atualização para conseguir parar e reiniciar
sem matar o atualizador. LaunchAgent ou LaunchDaemon, timer systemd e tarefa do
Windows consultam o `latest.json` próprio a cada seis horas. O script estável
resolve a versão ativa pelo arquivo protegido `current-path`.

```sh
cialai-broto atualizar --update-key CHAVE_PUBLICA_CONFIAVEL
```

O endpoint padrão é `https://cialai.com.br/downloads/broto/latest.json`. A chave
pública é obrigatória antes da rede. O atualizador valida a assinatura minisign,
versão, plataforma, tamanho e SHA256 antes de extrair. A extração recusa links,
arquivos especiais e caminhos fora da pasta. O macOS confere codesign e spctl.
Um lock impede instalação e atualização simultâneas. O arquivo ativo nunca é
sobrescrito. A ativação troca a configuração com rollback e só avança o ponteiro
após sucesso. Uma versão já baixada e autenticada pode repetir a ativação.
Estar na última versão é resultado normal, sem baixar o arquivo novamente.

`tools/broto/install.mjs` e `update.mjs` continuam disponíveis como ferramentas
offline de diagnóstico, com Node e minisign externos. O caminho integrado e o
agendamento usam o verificador Go embutido.

## Build e release

`node tools/broto/build.mjs ALVO DIRETORIO_NO_SSD` compila CLI e MCP sem CGO e
encena Tor e licenças. Os alvos são macos-arm64, macos-x64, linux-x64 e
windows-x64. Linux ARM64 está fora porque falta bundle Tor oficial.

O workflow aceita tags `broto-v*` de mantenedores autorizados, exige o ambiente
protegido e a chave Broto independente, assina o payload service antes de
embuti-lo no monitor e compila o pin com `CIALAI_BROTO_SERVICE_PUBLIC_KEY`.
A configuração adicional é `src-tauri/tauri.service.conf.json`. A release
publica manifests assinados, SBOM e proveniência com `--latest=false`.

Configure `BROTO_MINISIGN_SECRET_KEY` e a variável pública
`BROTO_MINISIGN_PUBLIC_KEY`, sem reutilizar a chave do desktop. O macOS exige
`BROTO_APPLE_CERTIFICATE`, `BROTO_APPLE_CERTIFICATE_PASSWORD`,
`BROTO_APPLE_SIGNING_IDENTITY` e as credenciais Apple de notarização. Ausência
ou divergência da chave impede o empacotamento. Não há chave de produção nestes
arquivos. O SBOM Go não substitui as licenças nativas do Tor incluídas no pacote.

O payload inclui `cialai-broto-mcp`. No hospedeiro, registre o caminho verificado
com `claude mcp add --transport stdio cialai-broto -- CAMINHO`.

## Testes locais seguros

```sh
node --test tools/broto/*.test.mjs
```

```sh
cd packages/tunnel-core
go test -race ./internal/brotoinstall ./internal/brotoupdate ./internal/brotohostipc ./internal/brotomcp
```

Os testes não registram serviços. Instalador e ativação usam diretórios
temporários, assinaturas reais efêmeras e executores substituídos. A variável
`CIALAI_BROTO_TEST_BINARY` habilita também o teste do supervisor com CLI real,
estado temporário e STUN desligado, sem registrar LaunchDaemon.
O script Windows aceita `-ValidateOnly` para compilar seu helper sem alterar
contas, direitos ou serviços. `-PlanOnly` exibe o plano. `-LoadTypesOnly` carrega
os tipos para testes administrativos explicitamente autorizados.
