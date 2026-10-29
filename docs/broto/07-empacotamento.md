# 07 · Empacotamento e distribuição

## Estado em 28/10/2026

O código de distribuição está implementado localmente. CLI, MCP, Tor, monitor,
instalador, serviços, checagem periódica, atualização assinada e workflow próprio
existem. As provas locais distinguem processo temporário, serviço nativo e
release publicada. Não houve tag, publicação, assinatura de produção nem
notarização de distribuição nesta entrega.

| Peça | Implementação e evidência |
| --- | --- |
| Binários por sistema | `tools/broto/build.mjs`, Go sem CGO, quatro alvos compilados |
| Tor empacotado | `tools/fetch-tor.mjs`, hashes fixados e assinatura upstream conferida |
| Monitor | `apps/broto`, Tauri e interface compartilhada, com instalação do serviço pela própria janela |
| Instalador | `internal/brotoinstall`, verificação minisign embutida e cópia imutável antes de ativar |
| Serviços | LaunchAgent ou LaunchDaemon, systemd por usuário e SCM, todos na conta de quem instala |
| Atualização | `internal/brotoupdate`, manifesto próprio, assinatura, saúde e rollback |
| Release | `.github/workflows/release-broto.yml`, prefixo e chave independentes do desktop |
| Site | Seção Broto nos três idiomas, arquivos, tamanhos, somas e espelho separado |

Os relatórios e logs de execução ficam fora do Git. O roteiro e os aceites do
[documento 08](./08-roteiro.md) continuam sendo a fonte dos resultados exigidos
por fase. Prova de build não equivale a publicação ou a revisão de loja.

Houve execução nativa de serviços e atualização em macOS, Windows e Linux,
com saúde e recuperação conferidas em laboratórios isolados. O registro
canônico está em [evidências locais](../evidence/broto-local/README.md).

## Os pacotes

O módulo Go em `packages/tunnel-core` fornece `cialai-broto` e
`cialai-broto-mcp`. O build usa `-trimpath`, `-mod=readonly` e `CGO_ENABLED=0`.
O payload inclui Tor, licenças, inventário e SBOM Go. O monitor usa o bundle
`br.com.ordinum.cialai.broto`.

| Alvo | Distribuição |
| --- | --- |
| macOS arm64 e x64 | Fonte preparada; fora da prévia pública inicial por escolha do usuário |
| Linux x86_64 | Pacotes nativos do monitor e payload verificado por minisign |
| Windows x64 | Pacote nativo do monitor e payload verificado por minisign, sem Authenticode por decisão |
| Linux ARM64 | Fora da primeira versão, sem Tor Expert Bundle oficial para esse alvo |

O Tor Expert Bundle 15.0.22 mantém os hashes fixados em `tools/fetch-tor.mjs`.
O CI também confere o manifesto assinado pelo projeto Tor. No macOS, os Mach-O
aninhados são assinados antes do manifesto do serviço. Os arquivos tar
suprimem atributos estendidos e AppleDouble para não introduzir arquivos extras
depois da assinatura.

## Instalação integrada

O instalador nativo instala o monitor. Se o serviço não estiver disponível, a
janela oferece Instalar e iniciar serviço. O executável Go vem em
`resources/service`, com manifesto e assinatura. O pin público é compilado no
monitor a partir de configuração confiável e nunca é aceito do próprio payload.

A CLI oferece o mesmo caminho para máquinas sem tela:

```sh
cialai-broto instalar --payload PAYLOAD_ASSINADO --key CHAVE_PUBLICA_CONFIAVEL
```

O verificador minisign roda dentro do Go, sem Node ou minisign externo no
aparelho instalado. O instalador confere a assinatura antes dos hashes,
recusa arquivos extras, links e caminhos inseguros, e verifica novamente a
cópia antes de ativá-la. No macOS exige codesign e spctl. A versão existente
não é sobrescrita. Configurações diferentes do plano esperado são preservadas.
`--prepare-only` produz a instalação verificada e o plano sem registrar serviços.

O código de pareamento entra pelo stdin de `parear`, nunca como argumento.
`status`, `pausar`, `retomar` e `desconectar` usam somente IPC protegido do usuário.
Fechar o monitor não encerra a conexão.

## Serviços na conta de quem instala

| Sistema | Mecanismo |
| --- | --- |
| macOS com sessão gráfica | LaunchAgent do usuário, iniciado no login |
| macOS sem login | Opção explícita `--headless`, LaunchDaemons com UserName e GroupName da conta escolhida, root incluído |
| Linux | systemd por usuário, com `--linger` ou `--headless` para solicitar execução após logout e no boot |
| Windows | Serviço SCM na mesma conta do monitor, comum ou de administrador |

O modo headless do macOS pede autorização administrativa apenas para os
descritores pertencentes ao root. O XML autorizado é enviado diretamente ao helper, sem
confiar em um plist mutável escrito pelo usuário. Os processos rodam na
conta escolhida. O supervisor acompanha o ponteiro privado e confirma a saúde do
processo novo antes de aceitar a troca.

No Windows, a interface protegida do sistema pede a credencial da conta do monitor.
A senha não vai em argumentos, logs ou arquivos do Broto. O sistema protege a
credencial do SCM e da tarefa agendada. A conta recebe os direitos de logon de
serviço e de tarefa, sem receber SERVICE_CHANGE_CONFIG. O SCM usa um launcher
fixo; atualizar muda somente o filho verificado e mantém a conta do serviço.
O perfil e o diretório de estado são explícitos. Conta de administrador é
aceita desde a decisão 072: o logon de serviço não passa pelo filtro do UAC, e
o serviço recebe o token completo, então o hospedeiro roda comandos de
administrador sem consentimento nem senha. O instalador confere a senha por
logon interativo antes de conceder qualquer direito, e só então testa o logon
de serviço. Se o Windows não elevar o instalador, como acontece com o UAC
desligado, ele para com erro em vez de se relançar; nessa configuração nenhuma
conta comum consegue instalar o serviço.

Todo serviço do Windows recebe SeImpersonatePrivilege e SeCreateGlobalPrivilege,
e por causa deles o Windows marca o token de qualquer serviço como elevado.
Numa conta comum, o Broto remove esses dois privilégios do próprio token antes
do primeiro comando, para nenhum shell aberto pelo hospedeiro passar da conta
escolhida. Numa conta de administrador ou de sistema, o token fica inteiro. O
teste olha a conta de fato, o grupo Administradores ativo ou LocalSystem, e não
a marca de elevado.

O socket Unix exige proprietário correto e permissão 0600. O named pipe do
Windows tem ACL do usuário. Nenhuma dessas superfícies abre uma porta TCP.

## Atualização automática

Um job separado consulta o `latest.json` próprio a cada seis horas. No macOS é
um agente ou daemon do launchd, no Linux um timer systemd, e no Windows uma
tarefa limitada da conta do serviço. O job resolve `current-path` para sempre usar a
CLI ativa e não depender do caminho de uma versão antiga.

A atualização exige o pin minisign independente antes de buscar dados. Usa
HTTPS, confere assinatura, versão, alvo, tamanho e SHA256, limita a expansão do
arquivo e recusa links, arquivos especiais e traversal. A versão nova fica em
pasta imutável. Um lock impede instalações ou atualizações concorrentes.

A ativação espera uma instância saudável e um PID observado. Se a candidata
falhar, o supervisor mantém o controle e a versão anterior precisa confirmar
saúde no rollback. O ponteiro e os descritores não são tratados como sucesso
antes dessa confirmação. Estar na última versão é resultado normal, sem baixar
o arquivo novamente. O hospedeiro continua pareado após o reinício.

## Release e cadeia de suprimento

| Item | Regra |
| --- | --- |
| Tag | `broto-v*`, somente mantenedores autorizados |
| Marca latest | Sempre desligada para preservar o atualizador do desktop |
| Chave | Minisign exclusiva do Broto, sem reutilizar a chave do desktop |
| Recursos do monitor | Serviço assinado antes do build Tauri, com pin independente compilado |
| Somas | Manifestos do serviço, dos arquivos e de atualização assinados |
| Proveniência | Atestado GitHub para os artefatos publicados |
| Dependências | SBOM ao lado de cada pacote e licenças incluídas |
| Actions | Referências fixadas por SHA |
| Tor | Hashes fixados e assinatura upstream verificada em CI |

O workflow exige o ambiente protegido e falha sem a chave própria ou sem a
assinatura de distribuição exigida no macOS. Builds locais com chave efêmera e
assinatura ad hoc não são releases oficiais.

O Windows continua sem Authenticode. SmartScreen pode avisar editor
desconhecido e antivírus podem identificar a função de acesso remoto. A pessoa
confere a assinatura das somas com o pin oficial antes de executar o download.

## Site e espelho

O namespace é `/downloads/broto/`, com `latest.json`, assinatura e somas
próprios. A página lê essa metadata somente para mostrar arquivos, tamanhos e
hashes; a autoridade da instalação continua sendo o pin do verificador. Sem
metadata válida, a seção não inventa links de download.

`scripts/mirror-broto-release.sh`, no site, prepara uma pasta local por padrão.
Confere assinaturas e os quatro arquivos antes de permitir `--apply`. A cópia
e a invalidação ficam restritas ao prefixo Broto, sem reescrever o latest do
desktop. O teste usa AWS simulado e prova que o modo padrão não publica.
As páginas estáticas e os textos legais existem em português, inglês e espanhol.
Nenhuma publicação foi executada nesta entrega.

Os comandos e as exigências operacionais estão em
[tools/broto/README.md](../../tools/broto/README.md).

## Comando do hospedeiro

O subcomando `broto` pertence ao sidecar `cialai-tunnel` já empacotado. Os wrappers POSIX usam a versão 2. No Windows, o desktop embute um lançador Go nativo e instala `cialai.exe` por usuário com um descritor de caminhos, sem repassar argumentos por batch. A CLI exige o hospedeiro aberto, usa IPC privado e retorna 120 quando ele está fechado. Não há download adicional nem instalação automática do MCP. A validação da continuação está em [BRO-015](./09-ia-no-comando.md).

## Prévia pública inicial

Por escolha do usuário em 29/10/2026, a primeira distribuição do Broto usa versão independente 0.1.0 e somente Windows x64 e Linux x64. O Cialai hospedeiro passa a 0.5.0 nos três sistemas desktop. Não há submissão do Broto a loja nem instalador macOS nesta etapa.

O workflow publica o instalador NSIS Windows e os pacotes Linux DEB e RPM diretamente, além dos dois arquivos de atualização, SBOM e somas assinadas pela chave independente do Broto. A release usa `broto-v0.1.0` e `latest=false`, preservando o canal do Cialai. A página própria no site mostra somente os instaladores dessa prévia. Os scripts macOS continuam no código para uma etapa futura, sem contar como distribuição aprovada.
