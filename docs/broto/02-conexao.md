# 02 · Conexão e pareamento do Broto

## Estado em 06/11/2026

Pareamento próprio e discagem preparados. O código CIALAIB2 vale dez minutos e exige aprovação, com consulta curta enquanto aguarda. Identidade, token, revogação, reconexão e estado privado têm testes locais. A reserva foi exercitada com SOCKS local e TLS real; isso não comprova a rede Tor pública nem NAT entre redes distintas. O pareamento por QR lido pelo celular, da decisão 077, está preparado e tem testes locais; o onion temporário no Tor público e a marca na rede local ainda não foram provados com aparelhos.

| Peça | Estado | Base que reaproveita |
| --- | --- | --- |
| Discagem pela rede local, direta e Tor | Preparado | `packages/tunnel-core/mobile` e `internal/pathmgr`, `internal/transport/direct`, `internal/tor` |
| Papel de identidade `broto` | Preparado | `internal/identity/identity.go`, com `desktop`, `phone` e `broto` |
| Código, pedido guardado e lista Brotos ligando | Preparado | `internal/pairing` e a borda em `internal/edge/edge.go` |
| Token por aparelho e revogação | Preparado | `internal/pairing/registry.go` e `edge.Server.Revoke` |
| Pareamento por QR lido pelo celular | Preparado | `internal/pairing/qr.go`, o onion temporário em `internal/tor` e a marca em `internal/mdns` |

## Por que o Broto disca, e não o contrário

O hospedeiro já escuta pela rede: um ouvinte QUIC com TLS 1.3 mútuo, mapeamento de porta por UPnP, NAT-PMP ou PCP, STUN opcional, anúncio DNS-SD na rede local e um serviço onion de salto único no Tor como ponto de encontro e reserva. O celular entra por esses caminhos. O Broto entra pelos mesmos.

| Decisão | Ganho | Custo |
| --- | --- | --- |
| O Broto disca o hospedeiro | A máquina do Broto não abre porta nem publica onion; nada escuta nela | Com o hospedeiro desligado, o Broto fica só esperando |
| Um ouvinte só, no hospedeiro | Reaproveita a borda e o pareamento já testados | O hospedeiro precisa estar aberto, o que já é verdade porque a IA mora nele |

Como a IA e a pessoa trabalham no hospedeiro, o hospedeiro estar ligado é a condição normal de uso. O custo é aceitável.

## Caminhos da conexão

O Broto monta o gerenciador de caminho do celular, `internal/pathmgr`, e tenta, nesta ordem, com os mesmos prazos do celular:

| Passo | Caminho | Prazo |
| --- | --- | --- |
| 1 | Rede local, pelos candidatos anunciados no pareamento | 1,5 s |
| 2 | Direto pela internet por QUIC, em paralelo com o passo 1 | 4 s |
| 3 | Reserva pelo Tor, discando o onion do hospedeiro | 20 s |
| 4 | Furo de NAT por cima da reserva, para subir a direto, em segundo plano | 5 s |

A histerese é a mesma do celular: 2 min para trocar de caminho e no máximo uma tentativa de subida a cada 5 min, para não oscilar.

A diferença de empacotamento é o Tor. No celular, o app nativo roda o Tor e entrega o endereço SOCKS ao núcleo. O Broto não tem app nativo, então traz o próprio Tor ao lado do binário e sobe o cliente SOCKS por conta própria. O detalhe de empacotamento está no documento 07.

## Identidade

Cada aparelho no túnel tem uma identidade Ed25519 e um papel. O papel decide o prefixo do id e, com o desenho do Broto, as rotas que o aparelho pode usar.

| Papel | Prefixo de id | Hoje |
| --- | --- | --- |
| `desktop` | `d_` | Existe |
| `phone` | `dev_` | Existe |
| `broto` | `bro_` | Preparado e testado em `internal/identity/identity.go` |

O papel `broto` é novo e precisa entrar em `Role`, no `prefix()` e no `DeriveID`, e ser aceito nos pontos que hoje assumem só `phone`. A confiança continua sendo pela chave fixada, não pela validade do certificado: o Broto fixa a chave do hospedeiro e o hospedeiro fixa a chave do Broto, com TLS 1.3 mútuo, sem ticket e sem 0-RTT, como em `internal/identity/tls.go`.

## Pareamento

O pareamento nasce no hospedeiro, igual ao do celular, mas num fluxo próprio, para não misturar um Broto com um telefone.

### O código

Na página Dispositivos, cada clique em Conectar novo Broto gera um código novo e aleatório. O código é de uso único e vale por 10 minutos. Ao contrário do QR do celular, ele não gira a cada 90 s, porque precisa ser levado até a outra máquina; se vencer, basta gerar outro. O código fica preso ao primeiro Broto que o apresenta: outro aparelho com o mesmo código é recusado. Para conectar três máquinas, a pessoa gera três códigos.

O formato tem duas opções, a registrar junto com a decisão 059 do documento 08:

| Opção | Como fica |
| --- | --- |
| Payload próprio | Um texto `CIALAIB2.` com o mesmo conteúdo do `CIALAI2.` do celular, para o leitor nunca confundir os dois |
| Campo de papel | O mesmo `CIALAI2.` com um campo novo que diz o papel; exige subir a versão do payload |

Qualquer das duas sobe a versão do formato, porque o decodificador em `internal/pairing/codec.go` recusa campo desconhecido e exige que o payload reencode idêntico. A recomendação é o payload próprio, porque deixa o papel explícito desde o primeiro byte e evita um Broto entrar por engano pelo fluxo do celular.

O conteúdo é o mesmo do celular: a chave do hospedeiro, o onion sempre presente, até seis candidatos de rede, um segredo de 32 bytes, a validade e o id do pareamento, tudo abaixo de 700 bytes.

### Como a pessoa pareia

| Aparelho | Como |
| --- | --- |
| Computador com tela | A pessoa abre a janela do Broto, cola o código e clica em Ligar |
| Computador com tela, com um celular já pareado ao hospedeiro | A janela do Broto mostra um QR, o celular lê o QR em Ligar um Broto e a pessoa confirma nos dois aparelhos |
| Computador sem tela, como um servidor | A pessoa roda `cialai-broto parear` e cola o código quando ele pedir |
| Aparelho sem teclado bom, como TV | Fora da primeira versão; o jeito de levar o código até ele fica para a fase desses aparelhos |

O código nunca vai como argumento de linha de comando, para não ficar no histórico do shell nem na lista de processos da máquina.

### O fluxo na rede

O fluxo reaproveita o do celular em `internal/pairing` e `internal/edge/edge.go`:

1. O Broto lê o código, valida o formato e sobe com o papel `broto`.
2. O Broto alcança o hospedeiro por um dos caminhos e faz `POST /pair` com a própria chave pública, que precisa ser igual à chave da conexão TLS.
3. A borda confere que o pareamento existe, não expirou e não foi consumido, compara o segredo em tempo constante e confere que a chave da conexão bate com a declarada.
4. O pedido entra na lista Brotos ligando, na página Dispositivos, com o nome e o sistema do Broto e quatro dígitos derivados do id do pareamento e da chave do Broto. A janela do Broto mostra os mesmos quatro dígitos. A pessoa confere e aprova ou recusa. Essa aprovação é sempre obrigatória para Broto; no celular ela é opcional.

O nome configurado do Broto é o enviado no pedido. Ele aceita até 48 caracteres Unicode, sem controles. Quando não há nome escolhido, o cliente usa o hostname, removendo controles e limitando esse valor automático a 48 caracteres; um hostname vazio usa Cialai Broto. A validação do hospedeiro permanece a mesma.
5. O pedido fica guardado no hospedeiro até a decisão ou até o código vencer. Enquanto espera, o Broto volta a perguntar, sem segurar uma conexão aberta, e a primeira pergunta depois da aprovação já recebe o token. No celular, a borda espera a decisão por até 60 s com a conexão aberta; no Broto, o pedido guardado substitui essa espera, porque a pessoa pode estar na outra máquina quando cola o código.
6. Na aprovação, a borda consome o pareamento, grava o registro com o papel `broto` e entrega o token do aparelho. Na recusa, o pedido some e o código deixa de valer.

Consultas válidas que retornam espera não consomem a quota de tentativas de pareamento. Códigos inválidos, outra chave e tentativas recusadas continuam sujeitos ao limite. Assim, aguardar a pessoa não faz o próprio Broto esgotar a quota antes da aprovação. A suíte cobre consultas repetidas acima da quota sem registrar o aparelho antes do sim.

A entrada restrita de uma chave não registrada continua valendo: antes do pareamento terminar, uma chave desconhecida só alcança `POST /pair`, por no máximo 4 sessões de 60 s, com o portão reconferido a cada segundo, como em `internal/pairing/sessions.go`. Cada pergunta do Broto na espera é uma dessas sessões curtas.

### Pelo QR, com o celular

Pela decisão 077, há um segundo caminho, sem copiar nada: a janela do Broto mostra um QR e um celular já pareado com o hospedeiro lê esse QR. As regras de cima continuam valendo. O Broto só disca, nada escuta nele, e o celular nunca fala com o Broto pela rede: ele só lê a tela.

1. Em Ligar pelo celular, o serviço do Broto sorteia um segredo de 32 bytes e monta o texto `CIALAIQ1.`, com a chave pública do Broto, o segredo, a validade de 10 minutos, o nome e o sistema. O QR é de uso único.
2. No celular, o menu de cada computador ganha Ligar um Broto, que abre a câmera. O celular manda o texto lido ao hospedeiro pela própria ponte, no comando `broto_qr_begin`, e passa a consultar `broto_qr_state`.
3. Do segredo, hospedeiro e Broto derivam por HKDF-SHA256, cada valor com o próprio rótulo, a chave de um onion temporário, o id e o segredo do pareamento e a chave de uma marca para a rede local. O hospedeiro publica o onion temporário com `ADD_ONION`, apontado para a mesma entrada do onion principal, e anuncia a marca por mDNS, os dois só enquanto o pedido vale.
4. O Broto procura a marca na rede local e disca o endereço dela; sem a marca, disca o onion temporário. Ele começa antes de o celular ler o QR, e o Tor não volta a procurar por 15 minutos um onion que não achou. Por isso, antes de cada nova tentativa pelo Tor, o Broto pede `SIGNAL NEWNYM` ao próprio Tor, que esquece as buscas que falharam.
5. Na primeira conexão o Broto ainda não conhece a chave do hospedeiro. O TLS guarda a que recebeu e, depois do primeiro pedido aceito, toda conexão do mesmo pareamento exige essa chave. O Broto faz `POST /pair` com o tipo `broto-qr`, o id e o segredo derivados e um número novo de 32 bytes a cada tentativa. O hospedeiro só aceita a chave de Broto que veio no QR.
6. Hospedeiro e Broto calculam quatro dígitos sobre a chave do hospedeiro, a chave do Broto, o segredo e o número da tentativa. O celular mostra o nome, o sistema e os dígitos, com Confirmar e Recusar. A pessoa digita os dígitos na janela do Broto, que confere sozinha e dá três tentativas. Com os dígitos certos, o Broto avisa o hospedeiro e passa a perguntar, como no código colado.
7. O token só sai quando o celular confirmou e o Broto conferiu os dígitos. A resposta é a mesma do código colado, e o Broto só guarda o hospedeiro se a chave dela for a mesma que o TLS guardou. No registro do hospedeiro, o Broto entra com o nome e o sistema do QR, os mesmos que o celular mostrou. Daí em diante, a conexão segue pelo onion principal e pelos candidatos da resposta.
8. Depois do sucesso ou da recusa, o onion temporário e a marca ficam no ar mais 30 s, para o Broto ler a resposta. Na validade, ou quando a rede do hospedeiro para, saem na hora: o onion com `DEL_ONION` e a marca com a despedida do mDNS.

O hospedeiro aceita no máximo dois QR ao mesmo tempo e lembra de cada QR lido até ele vencer, para recusar uma segunda leitura. Na mesma rede, a marca liga em segundos. Pelo Tor, o pareamento espera o onion temporário ser publicado, o que leva de dezenas de segundos a alguns minutos.

## Token e registro

O Broto recebe um token por aparelho, no mesmo molde do `cdt1` do celular, guardado como `sha256:` e comparado em tempo constante, preso à chave TLS do Broto. A recomendação é um prefixo próprio, por exemplo `cbt1`, para o registro distinguir token de Broto de token de celular à primeira vista.

O registro em `internal/pairing/registry.go`, o `devices.json`, ganha um campo `kind` com `phone` ou `broto`. A ausência do campo significa `phone`, para registros antigos continuarem válidos. Isso é uma subida de versão do registro, com decodificação estrita como a de hoje.

O token gira a cada 30 dias, com o token anterior válido por 24 h, igual ao do celular.

## Revogação e desconexão

O corte pode vir de qualquer uma das duas pontas.

Revogar um Broto no hospedeiro faz o mesmo que revogar um celular, em `edge.Server.Revoke`:

1. O registro marca o Broto como revogado.
2. O evento de mudança de aparelhos faz a ponte fechar os sockets do Broto com o código 4401.
3. A borda espera até 500 ms e fecha as sessões daquela chave em todos os ouvintes.

Desconectar na janela do Broto faz o caminho inverso: o Broto fecha as sessões e esquece o hospedeiro e o token. Se o hospedeiro estiver conectado na hora, ele recebe o aviso e revoga o token do Broto; se não estiver, o Broto aparece lá como sem contato, até a pessoa remover. Nos dois casos, voltar exige um código novo.

## Um hospedeiro por Broto, vários Brotos por hospedeiro

O Broto guarda um hospedeiro. O estado local do Broto, no molde do `mobile-state.json` do celular, guarda a chave, o onion e os candidatos de um único hospedeiro. Parear de novo substitui o anterior e descarta o token velho. Não há troca de hospedeiro em tempo de uso nem lista de hospedeiros. Isso mantém o Broto simples e deixa claro de quem ele recebe ordens.

O hospedeiro, ao contrário, tem quantos Brotos quiser, cada um com o seu código, a sua aprovação, o seu token e a sua linha em Dispositivos.

## Evidência local de BRO-001 e BRO-002

Em 28/10/2026, `go test ./...` passou em `packages/tunnel-core`. O registro v3 guarda `kind`, emite tokens `cbt1` para Brotos e conserva a rotação de 30 dias e a janela anterior de 24 horas. Registros v2 são migrados em memória e gravados como v3 na próxima alteração; ausência de `kind` significa `phone`. Versões anteriores do aplicativo não leem v3 depois dessa gravação.

Uma chave não pode ser registrada sob dois papéis. A borda consulta o papel persistido antes de servir qualquer rota. Brotos não recebem estáticos, health nem acesso à ponte por `/pty` ou pelo upgrade em `/`. Celulares recebem 403 em `/broto`. Um Broto com token vinculado à chave TLS abre o canal reverso nessa rota por upgrade HTTP. O canal negocia hello versão 1 antes de aparecer conectado.
