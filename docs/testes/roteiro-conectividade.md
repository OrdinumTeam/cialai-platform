# Roteiro de Conectividade em Aparelhos Reais

Estado: roteiro preparado, execução em aparelho real pendente

Este é o roteiro único de validação física da conectividade do Cialai: conexão direta por QUIC, descoberta na rede local, porta mapeada, furo de NAT e conexão de reserva pela rede Tor. Ele cobre os cenários CON-081 a CON-095. Os roteiros 3.9 e 4.7 descrevem o Headscale e ficaram históricos para a conectividade.

Regra de aprovação: cada cenário só é aprovado com execução em aparelho físico e registro preenchido nesta folha. Simulador do iOS, emulador Android, laboratório `tools/net-lab` e testes automatizados não aprovam nenhum cenário. Uma meta sem medição, um campo obrigatório vazio ou uma medição sem evidência mantém o cenário pendente.

As metas de cada cenário vêm da seção 9 do plano de conectividade e estão reunidas no fim desta folha, em Metas mensuráveis.

## Como usar

- Imprima uma cópia por rodada de bancada, em paisagem, porque as tabelas de execução são largas.
- Use somente projetos, nomes de computador, nomes de celular e arquivos fictícios.
- Preencha a Identificação da rodada, a Bancada e o Registro de ambientes antes do primeiro cenário.
- Em cada execução, escreva na coluna Ambiente o código do Registro de ambientes em uso. Crie um código novo sempre que mudar a data, o aparelho, o sistema, a operadora, o roteador, o tipo de NAT observado ou o IPv6.
- Nas colunas com caixas, marque uma única caixa por linha.
- Registre tempos em segundos com uma casa decimal, latências em milissegundos e memória em MB.
- Siga a ordem dos cenários, porque vários reaproveitam a condição de rede preparada no anterior.

## Identificação da rodada

| Campo | Registro |
| --- | --- |
| Data e hora inicial |  |
| Pessoa responsável |  |
| Commit do código |  |
| Computador: modelo, sistema e versão |  |
| Versão do Cialai no computador |  |
| iPhone: modelo e versão do iOS |  |
| Versão e build do Cialai no iPhone |  |
| Android: fabricante, modelo e versão |  |
| Versão e build do Cialai no Android |  |
| Versão do núcleo no celular |  |

## Bancada

| Item | Requisito | Registro |
| --- | --- | --- |
| Computador | Mac ou PC com o Cialai desktop instalado, ligado ao Wi-Fi residencial, na tomada e com um projeto fictício |  |
| iPhone | Aparelho físico com o build interno do Cialai e dados móveis 4G ou 5G ativos |  |
| Android | Aparelho físico com o build interno do Cialai e dados móveis 4G ou 5G ativos |  |
| Roteador residencial | Acesso à página administrativa para ligar e desligar UPnP, NAT-PMP e IPv6; começa com UPnP ligado e depois é desligado |  |
| Rede com CGNAT | Quando houver: provedor que entrega endereço compartilhado ao roteador, ou computador ligado ao ponto de acesso de um celular de apoio em rede móvel |  |
| Segunda rede Wi-Fi | Escritório ou casa de terceiros, sem relação com a rede residencial, para CON-083 |  |
| Rede de teste com firewall | Roteador de teste ou computador de apoio que compartilha internet e bloqueia UDP de saída, portas específicas ou todo tráfego exceto DNS, para CON-086, CON-087 e CON-092 |  |
| Aparelho de medição | Segundo celular com gravação em câmera lenta de 240 quadros por segundo e cronômetro |  |
| Carregadores | Para o computador e os dois celulares durante o soak de CON-095 |  |

## Preparação

- [ ] Builds internos da tarefa CON-056 instalados: TestFlight interno no iPhone e faixa interna do Play no Android
- [ ] Versões anotadas na Identificação: no computador, em Preferências, Versão atual; no celular, em Computadores, Ajustes, Sobre, e em Diagnóstico avançado, Versão do núcleo
- [ ] Computador com o estado Acessível no botão Vincular celular antes de cada cenário, salvo quando o cenário pede outra condição
- [ ] Preferência Manter ativo durante o uso remoto ligada no computador
- [ ] Nível de log do celular em Diagnóstico, em Computadores, Ajustes, Nível de log
- [ ] Relógios automáticos ativos no computador e nos celulares
- [ ] Nenhum QR, token, chave, endereço onion completo ou endereço IP público será anexado à evidência

### Onde ver o transporte e o diagnóstico no computador

| O que ver | Onde | Texto na tela |
| --- | --- | --- |
| Estado geral do acesso | Botão Vincular celular na barra lateral e na barra superior | Preparando acesso, Pronto para parear, Conexão de reserva preparando com o percentual, Acessível, Reconectando, Rede com problema ou Rede desligada |
| Painel Acesso pelo celular | Dispositivos, no topo da tela | Conexão direta: pronta, preparando ou com problema. Conexão de reserva: pronta, preparando com o percentual, desligada ou com problema. Celulares conectados: quantidade |
| Transporte de cada celular | Dispositivos, lista Celulares vinculados, badge na linha do celular | Direta ou Reserva, com Conectado agora ou o último acesso |
| Diagnóstico avançado | Dispositivos, seção Diagnóstico avançado, ou o atalho Diagnóstico avançado do painel | Identidade com Nome, Impressão digital e Identificador; Conexão direta com Estado, Porta UDP, Mapeamento de porta, Endereço mapeado e Endereços anunciados; Conexão de reserva com Inicialização, Serviço onion e Endereço onion; Redes públicas usadas |
| Verificações | Diagnóstico avançado, botões Executar diagnóstico e Atualizar endereços | Tudo certo ou Algumas verificações falharam, com Ouvinte direto, Endereços da rede local, IPv6, Mapeamento de porta, Endereço público por STUN, Processo do Tor, Inicialização do Tor, Serviço onion publicado, Anúncio DNS-SD local e Borda do estúdio |
| Pareamento | Vincular celular | Código QR de pareamento, Validade restante, Novo código em, aviso sobre a conexão de reserva e Pareamento concluído |
| Revogação | Dispositivos, Revogar nome do celular, Revogar acesso | Revogar dispositivo e, depois, Acesso revogado |

### Onde ver o transporte e o diagnóstico no celular

| O que ver | Onde | Texto na tela |
| --- | --- | --- |
| Transporte na sessão | Barra superior da sessão, ao lado do nome do computador | Direta, Reserva ou Procurando caminho |
| Transporte na lista | Computadores, badge abaixo do computador | Direta ou Reserva, com Conectado, Conectando, Não conectado, Fora de alcance ou Este celular foi removido |
| Diagnóstico avançado | Computadores, Ajustes, Diagnóstico avançado, Mostrar detalhes | Núcleo, Transporte ativo, Caminho ativo, Conexão de reserva, Computadores vinculados, Versão do núcleo e Redes públicas usadas |
| Caminho ativo | Diagnóstico avançado | Rede local, Internet direta ou Rede Tor |
| Conexão de reserva | Diagnóstico avançado | Iniciando, Preparando com o percentual, Pronta, Desligada ou Com problema |
| Etapas do pareamento | Vincular celular, depois de ler o código e tocar em Vincular | Lendo código, Procurando na rede local, Conectando pela internet, Conectando pela reserva e Confirmando |
| Motivo sem conexão | Tela exibida quando a sessão cai | Conectando, Preparando a conexão de reserva, Conexão de reserva indisponível, O computador está fora de alcance, Não foi possível conectar ou Este celular foi removido |

O transporte Direta cobre a rede local e a internet direta. O Caminho ativo separa os dois casos. O transporte Reserva corresponde sempre ao caminho Rede Tor.

### Tipo de NAT observado

O diagnóstico avançado do computador mostra o mapeamento e os endereços anunciados, mas não nomeia o tipo de NAT. Classifique cada ambiente pela tabela abaixo e registre a classe no Registro de ambientes.

| Classe | Como reconhecer |
| --- | --- |
| Mapeado | Mapeamento de porta mostra UPnP, NAT-PMP ou PCP e Endereço mapeado tem valor |
| CGNAT | O endereço WAN na página administrativa do roteador está na faixa 100.64.0.0/10 ou numa faixa privada, ou difere do chip Endereço público em Endereços anunciados |
| Cone | Mapeamento de porta mostra Nenhum e o teste de comportamento indica mapeamento independente do destino |
| Simétrico | Mapeamento de porta mostra Nenhum e o teste de comportamento indica mapeamento dependente do destino |
| Desconhecido | A verificação Endereço público por STUN falhou ou o teste de comportamento não foi feito |

Teste de comportamento: num computador ligado à mesma rede, rode uma ferramenta de teste de NAT por STUN com servidor compatível com a RFC 5780, como `stunclient --mode full stun.stunprotocol.org` do Stuntman, e anote a ferramenta em Observações. A rede do celular é classificada do mesmo modo, com um computador ligado a ela; sem esse teste, registre Desconhecido.

IPv6: registre sim quando Endereços anunciados mostra o chip IPv6 no computador e o celular tem endereço IPv6 global na rede em uso, conferido numa página de teste de IPv6 no navegador do celular. Nos demais casos, registre não.

### Como medir

- **Tempo até a página:** inicie o cronômetro no toque sobre o computador na lista Computadores e pare quando o terminal mostrar o prompt. Prefira gravar a tela do celular e ler o tempo pelos quadros.
- **Tor já iniciado:** antes da abertura, o Diagnóstico avançado do celular mostra Conexão de reserva Pronta.
- **App do celular frio:** encerre o Cialai pelo seletor de apps, abra pelo ícone e cronometre do toque no ícone até o prompt, incluindo o toque no computador.
- **Tempo até voltar:** inicie o cronômetro no evento do cenário, como a troca de rede ou o desbloqueio da tela, e pare quando o terminal voltar a receber saída.
- **Latência de eco:** grave a tela do celular com o aparelho de medição em 240 quadros por segundo, digite 20 caracteres num prompt vazio e conte os quadros entre o destaque da tecla e o caractere no terminal. Cada quadro vale cerca de 4,2 ms. Registre a mediana das 20 medidas.
- **Vazão de yes:** com a sessão aberta no celular, rode o comando abaixo e cronometre até o prompt voltar. Registre se o celular recebeu `detached` e se religou com replay.

```sh
yes | head -c 50000000
```

- **RSS e CPU do computador:** no macOS e no Linux, encontre os processos e leia RSS em KB e CPU em porcentagem; divida o RSS por 1024 para obter MB. Confira pelo caminho na coluna de comando que o `tor` é o embutido no Cialai. No Windows, use o Gerenciador de Tarefas, aba Detalhes, com as colunas de conjunto de trabalho e CPU de `cialai-tunnel.exe` e `tor.exe`.

```sh
pgrep -x cialai-tunnel
pgrep -x tor
ps -o pid=,rss=,pcpu=,command= -p PID_DO_SIDECAR,PID_DO_TOR
```

- **Memória do app no celular:** no Android, leia a linha TOTAL RSS do comando abaixo. No iPhone, instale pelo Xcode um build de desenvolvimento do mesmo commit e leia Debug Navigator, Memory; anote em Observações que a medida do Xcode é o footprint de memória desse build.

```sh
adb shell dumpsys meminfo br.com.ordinum.cialai
```

- **Bateria:** comece entre 80% e 90% de carga, fora da tomada, com brilho fixo em 50%. Mantenha a sessão em primeiro plano por 30 min com o comando abaixo e registre a diferença de carga.

```sh
while true; do date; sleep 1; done
```

### Logs sem segredos

No computador, os registros ficam na pasta Registros, também mostrada em Preferências, Arquivos do aplicativo. Copie para a pasta de evidência só os arquivos alterados durante a rodada.

| Sistema | Pasta |
| --- | --- |
| macOS | `~/Library/Logs/br.com.ordinum.cialai/` |
| Linux | `~/.local/share/br.com.ordinum.cialai/logs/` |
| Windows | `%LOCALAPPDATA%\br.com.ordinum.cialai\logs\` |

No celular, mantenha o Nível de log em Diagnóstico durante a rodada e volte para Informações ao final.

- **iPhone:** com o iPhone ligado ao Mac por cabo, abra o app Console, selecione o iPhone, filtre pelo processo Cialai, reproduza o cenário e salve as mensagens selecionadas.
- **Android:** descubra o processo do app e grave o log dele num arquivo.

```sh
adb shell pidof br.com.ordinum.cialai
adb logcat -c
adb logcat --pid=PID_DO_APP > cialai-android.log
```

O núcleo já troca tokens, códigos de pareamento e parâmetros secretos por `[redacted]`. Mesmo assim, procure resíduos antes de anexar. Qualquer ocorrência bloqueia o anexo até ser removida.

```sh
rg -n -i 'CIALAI2\.|cdt1\.|secret=|token=|key=|PRIVATE KEY' pasta-da-evidencia
```

Substitua endereços IP públicos pela classe do candidato, como Endereço público ou Porta mapeada, e o endereço onion pelos oito primeiros caracteres. Nunca anexe foto ou captura do QR.

## Registro de ambientes

Roteador: anote modelo e estado de UPnP, NAT-PMP e IPv6. Rede do celular: Wi-Fi residencial, outro Wi-Fi, rede de teste, 4G ou 5G.

| Código | Data | Aparelho | Sistema | Operadora | Rede do celular | Roteador | NAT observado | IPv6 |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
| E1 |  |  |  |  |  |  |  | ☐ sim ☐ não |
| E2 |  |  |  |  |  |  |  | ☐ sim ☐ não |
| E3 |  |  |  |  |  |  |  | ☐ sim ☐ não |
| E4 |  |  |  |  |  |  |  | ☐ sim ☐ não |
| E5 |  |  |  |  |  |  |  | ☐ sim ☐ não |
| E6 |  |  |  |  |  |  |  | ☐ sim ☐ não |
| E7 |  |  |  |  |  |  |  | ☐ sim ☐ não |
| E8 |  |  |  |  |  |  |  | ☐ sim ☐ não |
| E9 |  |  |  |  |  |  |  | ☐ sim ☐ não |
| E10 |  |  |  |  |  |  |  | ☐ sim ☐ não |
| E11 |  |  |  |  |  |  |  | ☐ sim ☐ não |
| E12 |  |  |  |  |  |  |  | ☐ sim ☐ não |
| E13 |  |  |  |  |  |  |  | ☐ sim ☐ não |
| E14 |  |  |  |  |  |  |  | ☐ sim ☐ não |
| E15 |  |  |  |  |  |  |  | ☐ sim ☐ não |
| E16 |  |  |  |  |  |  |  | ☐ sim ☐ não |
| E17 |  |  |  |  |  |  |  | ☐ sim ☐ não |
| E18 |  |  |  |  |  |  |  | ☐ sim ☐ não |
| E19 |  |  |  |  |  |  |  | ☐ sim ☐ não |
| E20 |  |  |  |  |  |  |  | ☐ sim ☐ não |
| E21 |  |  |  |  |  |  |  | ☐ sim ☐ não |
| E22 |  |  |  |  |  |  |  | ☐ sim ☐ não |
| E23 |  |  |  |  |  |  |  | ☐ sim ☐ não |
| E24 |  |  |  |  |  |  |  | ☐ sim ☐ não |

<div style="page-break-after: always;"></div>

## CON-081 Mesma rede

Validade: só vale execução em aparelho físico. Simulação não aprova este cenário.

**Objetivo:** comprovar o caminho local: pareamento pelo QR, descoberta na rede local, terminal interativo e tempo até a página.

### Rede

| Aparelho | Condição |
| --- | --- |
| Computador | Wi-Fi residencial |
| Celular | Mesmo Wi-Fi, com dados móveis desligados |

### Passos

1. Confirme no computador o estado Acessível ou Pronto para parear no botão Vincular celular.
2. No computador, abra Vincular celular. No celular, abra Vincular celular e leia o código.
3. Confira que o celular mostra a pergunta de vínculo com o nome do computador e a mesma Impressão digital exibida no Diagnóstico avançado do computador. Toque em Vincular.
4. Anote as etapas exibidas no celular. O esperado é Procurando na rede local seguida de Confirmando, sem Conectando pela reserva.
5. Na sessão aberta, rode `echo celular` e confira o eco da digitação e a saída.
6. Volte a Computadores. Toque no computador e meça o tempo até a página.
7. Anote o transporte da barra superior da sessão e o Caminho ativo do Diagnóstico avançado do celular. O esperado é Direta e Rede local.
8. Repita os passos 6 e 7 até completar dez execuções por aparelho.

### Meta da seção 9

- Tempo até a página na mesma rede: até 2 s em 9 de 10 aberturas.
- Latência de eco na rede local: até 60 ms de mediana, medida em CON-094.

**Critério de aprovação:** página em até 2 s em 9 de 10 execuções de cada aparelho, com transporte Direta.

### Verificações

| Item | iPhone | Android |
| --- | --- | --- |
| Pareamento pelo QR concluído | ☐ sim ☐ não | ☐ sim ☐ não |
| Etapa Procurando na rede local exibida | ☐ sim ☐ não | ☐ sim ☐ não |
| Impressão digital igual à do computador | ☐ sim ☐ não | ☐ sim ☐ não |
| Saída de `echo celular` correta | ☐ sim ☐ não | ☐ sim ☐ não |

### Execuções

| Nº | Aparelho | Ambiente | Tempo até a página em s | Transporte | Caminho ativo | Resultado |
| --- | --- | --- | --- | --- | --- | --- |
| 1 | iPhone |  |  | ☐ Direta ☐ Reserva |  | ☐ Passou ☐ Falhou |
| 2 | iPhone |  |  | ☐ Direta ☐ Reserva |  | ☐ Passou ☐ Falhou |
| 3 | iPhone |  |  | ☐ Direta ☐ Reserva |  | ☐ Passou ☐ Falhou |
| 4 | iPhone |  |  | ☐ Direta ☐ Reserva |  | ☐ Passou ☐ Falhou |
| 5 | iPhone |  |  | ☐ Direta ☐ Reserva |  | ☐ Passou ☐ Falhou |
| 6 | iPhone |  |  | ☐ Direta ☐ Reserva |  | ☐ Passou ☐ Falhou |
| 7 | iPhone |  |  | ☐ Direta ☐ Reserva |  | ☐ Passou ☐ Falhou |
| 8 | iPhone |  |  | ☐ Direta ☐ Reserva |  | ☐ Passou ☐ Falhou |
| 9 | iPhone |  |  | ☐ Direta ☐ Reserva |  | ☐ Passou ☐ Falhou |
| 10 | iPhone |  |  | ☐ Direta ☐ Reserva |  | ☐ Passou ☐ Falhou |
| 11 | Android |  |  | ☐ Direta ☐ Reserva |  | ☐ Passou ☐ Falhou |
| 12 | Android |  |  | ☐ Direta ☐ Reserva |  | ☐ Passou ☐ Falhou |
| 13 | Android |  |  | ☐ Direta ☐ Reserva |  | ☐ Passou ☐ Falhou |
| 14 | Android |  |  | ☐ Direta ☐ Reserva |  | ☐ Passou ☐ Falhou |
| 15 | Android |  |  | ☐ Direta ☐ Reserva |  | ☐ Passou ☐ Falhou |
| 16 | Android |  |  | ☐ Direta ☐ Reserva |  | ☐ Passou ☐ Falhou |
| 17 | Android |  |  | ☐ Direta ☐ Reserva |  | ☐ Passou ☐ Falhou |
| 18 | Android |  |  | ☐ Direta ☐ Reserva |  | ☐ Passou ☐ Falhou |
| 19 | Android |  |  | ☐ Direta ☐ Reserva |  | ☐ Passou ☐ Falhou |
| 20 | Android |  |  | ☐ Direta ☐ Reserva |  | ☐ Passou ☐ Falhou |

### Decisão

| Campo | Registro |
| --- | --- |
| Evidência anexada |  |
| Defeitos abertos |  |
| Observações |  |

Decisão do cenário: ☐ Aprovado ☐ Reprovado ☐ Bloqueado

<div style="page-break-after: always;"></div>

## CON-082 Wi-Fi residencial e 4G/5G

Validade: só vale execução em aparelho físico. Simulação não aprova este cenário.

**Objetivo:** validar o exemplo obrigatório do produto, com computador no Wi-Fi residencial e celular em rede móvel: conexão, transporte usado, tempo e latência de eco.

### Rede

| Aparelho | Condição |
| --- | --- |
| Computador | Wi-Fi residencial; rodada A com UPnP e NAT-PMP ligados, rodada B com os dois desligados |
| Celular | 4G ou 5G, com Wi-Fi desligado |

### Passos

1. Rodada A: ligue UPnP e NAT-PMP no roteador. No Diagnóstico avançado do computador, toque em Atualizar endereços e confirme Mapeamento de porta com UPnP, NAT-PMP ou PCP. Anote o NAT observado.
2. No celular, desligue o Wi-Fi e confirme 4G ou 5G ativo.
3. Aguarde Conexão de reserva pronta no computador e Conexão de reserva Pronta no Diagnóstico avançado do celular.
4. Na lista Computadores, toque no computador e meça o tempo até a página.
5. Anote o transporte e o Caminho ativo. Em ao menos três execuções por aparelho e rodada, meça a latência de eco.
6. Volte a Computadores e repita os passos 4 e 5 até completar dez execuções por aparelho.
7. Rodada B: desligue UPnP e NAT-PMP no roteador, toque em Atualizar endereços e confirme Mapeamento de porta Nenhum. Se o mapeamento continuar, saia do Cialai no computador e abra de novo. Repita os passos 2 a 6.
8. Pareamento de outra rede, uma vez por aparelho em cada rodada: com Serviço onion Publicado no computador, abra Vincular celular, leia o código no celular em 4G ou 5G e cronometre do toque em Vincular até a sessão abrir.

### Meta da seção 9

- Taxa de caminho direto em Wi-Fi residencial com UPnP e celular em 4G/5G: registrar; objetivo de ao menos 8 de 10.
- Tempo até a página pelo caminho direto pela internet: até 3 s em 9 de 10 aberturas.
- Tempo até a página pela reserva, Tor já iniciado: até 6 s em 9 de 10 aberturas.
- Pareamento de outra rede pela reserva, serviço já publicado: até 20 s.
- Latência de eco de tecla: até 150 ms direto pela internet e até 400 ms na reserva, mediana.

**Critério de aprovação:** conexão em 10 de 10 execuções por algum caminho, em cada aparelho e rodada, com a proporção direta contra reserva registrada.

### Execuções da rodada A, UPnP ligado

| Nº | Aparelho | Ambiente | Tempo até a página em s | Transporte | Caminho ativo | Eco mediano em ms | Resultado |
| --- | --- | --- | --- | --- | --- | --- | --- |
| 1 | iPhone |  |  | ☐ Direta ☐ Reserva |  |  | ☐ Passou ☐ Falhou |
| 2 | iPhone |  |  | ☐ Direta ☐ Reserva |  |  | ☐ Passou ☐ Falhou |
| 3 | iPhone |  |  | ☐ Direta ☐ Reserva |  |  | ☐ Passou ☐ Falhou |
| 4 | iPhone |  |  | ☐ Direta ☐ Reserva |  |  | ☐ Passou ☐ Falhou |
| 5 | iPhone |  |  | ☐ Direta ☐ Reserva |  |  | ☐ Passou ☐ Falhou |
| 6 | iPhone |  |  | ☐ Direta ☐ Reserva |  |  | ☐ Passou ☐ Falhou |
| 7 | iPhone |  |  | ☐ Direta ☐ Reserva |  |  | ☐ Passou ☐ Falhou |
| 8 | iPhone |  |  | ☐ Direta ☐ Reserva |  |  | ☐ Passou ☐ Falhou |
| 9 | iPhone |  |  | ☐ Direta ☐ Reserva |  |  | ☐ Passou ☐ Falhou |
| 10 | iPhone |  |  | ☐ Direta ☐ Reserva |  |  | ☐ Passou ☐ Falhou |
| 11 | Android |  |  | ☐ Direta ☐ Reserva |  |  | ☐ Passou ☐ Falhou |
| 12 | Android |  |  | ☐ Direta ☐ Reserva |  |  | ☐ Passou ☐ Falhou |
| 13 | Android |  |  | ☐ Direta ☐ Reserva |  |  | ☐ Passou ☐ Falhou |
| 14 | Android |  |  | ☐ Direta ☐ Reserva |  |  | ☐ Passou ☐ Falhou |
| 15 | Android |  |  | ☐ Direta ☐ Reserva |  |  | ☐ Passou ☐ Falhou |
| 16 | Android |  |  | ☐ Direta ☐ Reserva |  |  | ☐ Passou ☐ Falhou |
| 17 | Android |  |  | ☐ Direta ☐ Reserva |  |  | ☐ Passou ☐ Falhou |
| 18 | Android |  |  | ☐ Direta ☐ Reserva |  |  | ☐ Passou ☐ Falhou |
| 19 | Android |  |  | ☐ Direta ☐ Reserva |  |  | ☐ Passou ☐ Falhou |
| 20 | Android |  |  | ☐ Direta ☐ Reserva |  |  | ☐ Passou ☐ Falhou |

### Execuções da rodada B, UPnP desligado

| Nº | Aparelho | Ambiente | Tempo até a página em s | Transporte | Caminho ativo | Eco mediano em ms | Resultado |
| --- | --- | --- | --- | --- | --- | --- | --- |
| 1 | iPhone |  |  | ☐ Direta ☐ Reserva |  |  | ☐ Passou ☐ Falhou |
| 2 | iPhone |  |  | ☐ Direta ☐ Reserva |  |  | ☐ Passou ☐ Falhou |
| 3 | iPhone |  |  | ☐ Direta ☐ Reserva |  |  | ☐ Passou ☐ Falhou |
| 4 | iPhone |  |  | ☐ Direta ☐ Reserva |  |  | ☐ Passou ☐ Falhou |
| 5 | iPhone |  |  | ☐ Direta ☐ Reserva |  |  | ☐ Passou ☐ Falhou |
| 6 | iPhone |  |  | ☐ Direta ☐ Reserva |  |  | ☐ Passou ☐ Falhou |
| 7 | iPhone |  |  | ☐ Direta ☐ Reserva |  |  | ☐ Passou ☐ Falhou |
| 8 | iPhone |  |  | ☐ Direta ☐ Reserva |  |  | ☐ Passou ☐ Falhou |
| 9 | iPhone |  |  | ☐ Direta ☐ Reserva |  |  | ☐ Passou ☐ Falhou |
| 10 | iPhone |  |  | ☐ Direta ☐ Reserva |  |  | ☐ Passou ☐ Falhou |
| 11 | Android |  |  | ☐ Direta ☐ Reserva |  |  | ☐ Passou ☐ Falhou |
| 12 | Android |  |  | ☐ Direta ☐ Reserva |  |  | ☐ Passou ☐ Falhou |
| 13 | Android |  |  | ☐ Direta ☐ Reserva |  |  | ☐ Passou ☐ Falhou |
| 14 | Android |  |  | ☐ Direta ☐ Reserva |  |  | ☐ Passou ☐ Falhou |
| 15 | Android |  |  | ☐ Direta ☐ Reserva |  |  | ☐ Passou ☐ Falhou |
| 16 | Android |  |  | ☐ Direta ☐ Reserva |  |  | ☐ Passou ☐ Falhou |
| 17 | Android |  |  | ☐ Direta ☐ Reserva |  |  | ☐ Passou ☐ Falhou |
| 18 | Android |  |  | ☐ Direta ☐ Reserva |  |  | ☐ Passou ☐ Falhou |
| 19 | Android |  |  | ☐ Direta ☐ Reserva |  |  | ☐ Passou ☐ Falhou |
| 20 | Android |  |  | ☐ Direta ☐ Reserva |  |  | ☐ Passou ☐ Falhou |

### Resumo e pareamento de outra rede

| Item | iPhone rodada A | Android rodada A | iPhone rodada B | Android rodada B |
| --- | --- | --- | --- | --- |
| Execuções conectadas de 10 |  |  |  |  |
| Execuções Direta |  |  |  |  |
| Execuções Reserva |  |  |  |  |
| Tempo de pareamento pela reserva em s |  |  |  |  |
| Transporte ao fim do pareamento | ☐ Direta ☐ Reserva | ☐ Direta ☐ Reserva | ☐ Direta ☐ Reserva | ☐ Direta ☐ Reserva |

### Decisão

| Campo | Registro |
| --- | --- |
| Evidência anexada |  |
| Defeitos abertos |  |
| Observações |  |

Decisão do cenário: ☐ Aprovado ☐ Reprovado ☐ Bloqueado

<div style="page-break-after: always;"></div>

## CON-083 Redes diferentes sem relação

Validade: só vale execução em aparelho físico. Simulação não aprova este cenário.

**Objetivo:** cobrir o caso Wi-Fi para Wi-Fi, com o celular numa rede sem relação com a do computador, e medir a taxa de furo de NAT sem porta mapeada.

### Rede

| Aparelho | Condição |
| --- | --- |
| Computador | Wi-Fi residencial com UPnP e NAT-PMP desligados |
| Celular | Outro Wi-Fi, como escritório ou casa de terceiros, com dados móveis desligados |

### Passos

1. No Diagnóstico avançado do computador, toque em Atualizar endereços, confirme Mapeamento de porta Nenhum e anote o NAT observado.
2. Ligue o celular ao outro Wi-Fi, desligue os dados móveis e anote o NAT observado dessa rede, quando for possível classificá-la.
3. Aguarde Conexão de reserva Pronta no Diagnóstico avançado do celular.
4. Na lista Computadores, toque no computador e meça o tempo até a página.
5. Anote o transporte e o Caminho ativo na abertura.
6. Observe o transporte por 30 s depois da abertura. Se a sessão abriu em Reserva e passou a Direta com Internet direta, marque furo bem sucedido.
7. Rode `echo celular` e confira a saída.
8. Volte a Computadores e repita os passos 4 a 7 até completar cinco execuções por aparelho.

### Meta da seção 9

- Tempo até a página pelo caminho direto pela internet: até 3 s em 9 de 10 aberturas.
- Tempo até a página pela reserva, Tor já iniciado: até 6 s em 9 de 10 aberturas.
- Taxa de furo de NAT sem porta mapeada, NAT cone dos dois lados: registrar; objetivo de ao menos 6 de 10. Conte só execuções com NAT observado Cone nos dois lados e abertura em Reserva.

**Critério de aprovação:** conexão em 5 de 5 execuções por algum caminho, em cada aparelho.

### Execuções

| Nº | Aparelho | Ambiente | Tempo até a página em s | Transporte na abertura | Furo em 30 s | Resultado |
| --- | --- | --- | --- | --- | --- | --- |
| 1 | iPhone |  |  | ☐ Direta ☐ Reserva | ☐ Direta ☐ Ficou na reserva | ☐ Passou ☐ Falhou |
| 2 | iPhone |  |  | ☐ Direta ☐ Reserva | ☐ Direta ☐ Ficou na reserva | ☐ Passou ☐ Falhou |
| 3 | iPhone |  |  | ☐ Direta ☐ Reserva | ☐ Direta ☐ Ficou na reserva | ☐ Passou ☐ Falhou |
| 4 | iPhone |  |  | ☐ Direta ☐ Reserva | ☐ Direta ☐ Ficou na reserva | ☐ Passou ☐ Falhou |
| 5 | iPhone |  |  | ☐ Direta ☐ Reserva | ☐ Direta ☐ Ficou na reserva | ☐ Passou ☐ Falhou |
| 6 | Android |  |  | ☐ Direta ☐ Reserva | ☐ Direta ☐ Ficou na reserva | ☐ Passou ☐ Falhou |
| 7 | Android |  |  | ☐ Direta ☐ Reserva | ☐ Direta ☐ Ficou na reserva | ☐ Passou ☐ Falhou |
| 8 | Android |  |  | ☐ Direta ☐ Reserva | ☐ Direta ☐ Ficou na reserva | ☐ Passou ☐ Falhou |
| 9 | Android |  |  | ☐ Direta ☐ Reserva | ☐ Direta ☐ Ficou na reserva | ☐ Passou ☐ Falhou |
| 10 | Android |  |  | ☐ Direta ☐ Reserva | ☐ Direta ☐ Ficou na reserva | ☐ Passou ☐ Falhou |

| Item | Registro |
| --- | --- |
| Execuções válidas para a taxa de furo |  |
| Furos bem sucedidos |  |

### Decisão

| Campo | Registro |
| --- | --- |
| Evidência anexada |  |
| Defeitos abertos |  |
| Observações |  |

Decisão do cenário: ☐ Aprovado ☐ Reprovado ☐ Bloqueado

<div style="page-break-after: always;"></div>

## CON-084 CGNAT e NAT restritivo

Validade: só vale execução em aparelho físico. Simulação não aprova este cenário.

**Objetivo:** confirmar a queda para a reserva quando o computador está atrás de CGNAT ou de NAT simétrico sem UPnP, e registrar o comportamento do furo.

### Rede

| Aparelho | Condição |
| --- | --- |
| Computador | Atrás de CGNAT; sem essa rede, roteador sem UPnP e com NAT simétrico |
| Celular | 4G ou 5G, com Wi-Fi desligado |

### Passos

1. Confirme a condição do computador pela tabela Tipo de NAT observado e anote qual das duas foi usada.
2. No celular, desligue o Wi-Fi e confirme 4G ou 5G ativo.
3. Com Conexão de reserva Pronta no celular, toque no computador e meça o tempo até a página com Tor já iniciado.
4. Anote o transporte na abertura. O esperado é Reserva.
5. Observe o transporte por 30 s e anote se o furo levou a sessão para Direta.
6. Em ao menos duas execuções, encerre o app do celular e meça o tempo até a página com o app frio.
7. Repita até completar cinco execuções, usando os dois aparelhos, com ao menos duas execuções em cada.

### Meta da seção 9

- Tempo até a página pela reserva, Tor já iniciado: até 6 s em 9 de 10 aberturas.
- Tempo até a página pela reserva, app do celular frio: até 15 s em 9 de 10 aberturas.

**Critério de aprovação:** conexão pela reserva em 5 de 5 execuções, com o tempo até a reserva e o resultado do furo registrados.

### Execuções

| Nº | Aparelho | Ambiente | Início | Tempo até a página em s | Transporte na abertura | Furo em 30 s | Resultado |
| --- | --- | --- | --- | --- | --- | --- | --- |
| 1 | ☐ iPhone ☐ Android |  | ☐ Tor iniciado ☐ App frio |  | ☐ Direta ☐ Reserva | ☐ Direta ☐ Ficou na reserva | ☐ Passou ☐ Falhou |
| 2 | ☐ iPhone ☐ Android |  | ☐ Tor iniciado ☐ App frio |  | ☐ Direta ☐ Reserva | ☐ Direta ☐ Ficou na reserva | ☐ Passou ☐ Falhou |
| 3 | ☐ iPhone ☐ Android |  | ☐ Tor iniciado ☐ App frio |  | ☐ Direta ☐ Reserva | ☐ Direta ☐ Ficou na reserva | ☐ Passou ☐ Falhou |
| 4 | ☐ iPhone ☐ Android |  | ☐ Tor iniciado ☐ App frio |  | ☐ Direta ☐ Reserva | ☐ Direta ☐ Ficou na reserva | ☐ Passou ☐ Falhou |
| 5 | ☐ iPhone ☐ Android |  | ☐ Tor iniciado ☐ App frio |  | ☐ Direta ☐ Reserva | ☐ Direta ☐ Ficou na reserva | ☐ Passou ☐ Falhou |

### Decisão

| Campo | Registro |
| --- | --- |
| Evidência anexada |  |
| Defeitos abertos |  |
| Observações |  |

Decisão do cenário: ☐ Aprovado ☐ Reprovado ☐ Bloqueado

<div style="page-break-after: always;"></div>

## CON-085 IPv6 disponível e indisponível

Validade: só vale execução em aparelho físico. Simulação não aprova este cenário.

**Objetivo:** medir o ganho do candidato IPv6 repetindo CON-082 com IPv6 ativo e depois desligado no roteador.

### Rede

| Aparelho | Condição |
| --- | --- |
| Computador | Wi-Fi residencial com UPnP e NAT-PMP desligados, para o ganho do IPv6 não ficar mascarado pela porta mapeada |
| Celular | 4G ou 5G com IPv6 na rede móvel, com Wi-Fi desligado |

### Passos

1. Condição A: ative o IPv6 no roteador. No Diagnóstico avançado do computador, toque em Atualizar endereços e confirme o chip IPv6 em Endereços anunciados e a verificação IPv6 aprovada.
2. Confirme o IPv6 do celular numa página de teste de IPv6 e anote no Registro de ambientes.
3. Na lista Computadores, toque no computador e meça o tempo até a página.
4. Anote o transporte e o Caminho ativo.
5. Repita os passos 3 e 4 até completar cinco execuções na condição A.
6. Condição B: desligue o IPv6 no roteador, toque em Atualizar endereços e confirme a ausência do chip IPv6. Repita os passos 3 e 4 até completar cinco execuções.

### Meta da seção 9

- Tempo até a página pelo caminho direto pela internet: até 3 s em 9 de 10 aberturas.
- Tempo até a página pela reserva, Tor já iniciado: até 6 s em 9 de 10 aberturas.

**Critério de aprovação:** transporte e tempos registrados nas duas condições, em cinco execuções por condição.

### Execuções da condição A, IPv6 ativo

| Nº | Aparelho | Ambiente | Tempo até a página em s | Transporte | Caminho ativo | Resultado |
| --- | --- | --- | --- | --- | --- | --- |
| 1 | ☐ iPhone ☐ Android |  |  | ☐ Direta ☐ Reserva |  | ☐ Passou ☐ Falhou |
| 2 | ☐ iPhone ☐ Android |  |  | ☐ Direta ☐ Reserva |  | ☐ Passou ☐ Falhou |
| 3 | ☐ iPhone ☐ Android |  |  | ☐ Direta ☐ Reserva |  | ☐ Passou ☐ Falhou |
| 4 | ☐ iPhone ☐ Android |  |  | ☐ Direta ☐ Reserva |  | ☐ Passou ☐ Falhou |
| 5 | ☐ iPhone ☐ Android |  |  | ☐ Direta ☐ Reserva |  | ☐ Passou ☐ Falhou |

### Execuções da condição B, IPv6 desligado

| Nº | Aparelho | Ambiente | Tempo até a página em s | Transporte | Caminho ativo | Resultado |
| --- | --- | --- | --- | --- | --- | --- |
| 1 | ☐ iPhone ☐ Android |  |  | ☐ Direta ☐ Reserva |  | ☐ Passou ☐ Falhou |
| 2 | ☐ iPhone ☐ Android |  |  | ☐ Direta ☐ Reserva |  | ☐ Passou ☐ Falhou |
| 3 | ☐ iPhone ☐ Android |  |  | ☐ Direta ☐ Reserva |  | ☐ Passou ☐ Falhou |
| 4 | ☐ iPhone ☐ Android |  |  | ☐ Direta ☐ Reserva |  | ☐ Passou ☐ Falhou |
| 5 | ☐ iPhone ☐ Android |  |  | ☐ Direta ☐ Reserva |  | ☐ Passou ☐ Falhou |

| Condição | Execuções Direta | Execuções Reserva | Mediana do tempo em s |
| --- | --- | --- | --- |
| A, IPv6 ativo |  |  |  |
| B, IPv6 desligado |  |  |  |

### Decisão

| Campo | Registro |
| --- | --- |
| Evidência anexada |  |
| Defeitos abertos |  |
| Observações |  |

Decisão do cenário: ☐ Aprovado ☐ Reprovado ☐ Bloqueado

<div style="page-break-after: always;"></div>

## CON-086 UDP bloqueado

Validade: só vale execução em aparelho físico. Simulação não aprova este cenário.

**Objetivo:** verificar que a sessão usa o caminho de reserva quando o UDP de saída está bloqueado.

### Rede

| Aparelho | Condição |
| --- | --- |
| Computador | Wi-Fi residencial |
| Celular | Rede de teste com UDP de saída bloqueado, exceto DNS; ou celular em 4G ou 5G com o bloqueio aplicado na rede do computador |

### Passos

1. Aplique no firewall o bloqueio de UDP de saída, exceto DNS na porta 53, e anote em qual rede ele foi aplicado.
2. Confirme Conexão de reserva Pronta no Diagnóstico avançado do celular.
3. Na lista Computadores, toque no computador e meça o tempo até a página.
4. Anote o transporte no celular e o badge da linha do celular em Dispositivos, no computador. O esperado é Reserva nos dois.
5. Observe por 30 s que a sessão continua em Reserva, sem oscilar.
6. Rode `echo celular` e meça a latência de eco em ao menos uma execução por aparelho.
7. Repita os passos 3 a 6 até completar cinco execuções, usando os dois aparelhos.
8. Remova o bloqueio e anote, em Observações, se a sessão passou a Direta nos 5 min seguintes.

### Meta da seção 9

- Tempo até a página pela reserva, Tor já iniciado: até 6 s em 9 de 10 aberturas.
- Latência de eco de tecla na reserva: até 400 ms, mediana.

**Critério de aprovação:** conexão pela reserva em 5 de 5 execuções físicas, com badge Reserva. O cenário automatizado de UDP bloqueado do laboratório é registrado à parte e não substitui nenhuma execução física.

### Execuções

| Nº | Aparelho | Ambiente | Tempo até a página em s | Transporte no celular | Badge no computador | Eco mediano em ms | Resultado |
| --- | --- | --- | --- | --- | --- | --- | --- |
| 1 | ☐ iPhone ☐ Android |  |  | ☐ Direta ☐ Reserva | ☐ Direta ☐ Reserva |  | ☐ Passou ☐ Falhou |
| 2 | ☐ iPhone ☐ Android |  |  | ☐ Direta ☐ Reserva | ☐ Direta ☐ Reserva |  | ☐ Passou ☐ Falhou |
| 3 | ☐ iPhone ☐ Android |  |  | ☐ Direta ☐ Reserva | ☐ Direta ☐ Reserva |  | ☐ Passou ☐ Falhou |
| 4 | ☐ iPhone ☐ Android |  |  | ☐ Direta ☐ Reserva | ☐ Direta ☐ Reserva |  | ☐ Passou ☐ Falhou |
| 5 | ☐ iPhone ☐ Android |  |  | ☐ Direta ☐ Reserva | ☐ Direta ☐ Reserva |  | ☐ Passou ☐ Falhou |

| Item | Registro |
| --- | --- |
| Rede em que o bloqueio foi aplicado |  |
| Resultado do cenário automatizado do laboratório, só como referência |  |

### Decisão

| Campo | Registro |
| --- | --- |
| Evidência anexada |  |
| Defeitos abertos |  |
| Observações |  |

Decisão do cenário: ☐ Aprovado ☐ Reprovado ☐ Bloqueado

<div style="page-break-after: always;"></div>

## CON-087 Falha dos serviços públicos

Validade: só vale execução em aparelho físico. Simulação não aprova este cenário.

**Objetivo:** confirmar um comportamento honesto quando a rede Tor ou os servidores STUN falham, e a recuperação ao liberar.

### Rede

| Aparelho | Condição |
| --- | --- |
| Computador | Wi-Fi residencial; na condição B, com UPnP ligado |
| Celular | Condição A: rede de teste sem nenhuma saída além de DNS. Condição B: mesmo Wi-Fi do computador e depois 4G ou 5G |

### Passos

1. Condição A, Tor bloqueado e sem caminho direto: ligue o celular à rede de teste que bloqueia todo tráfego de saída exceto DNS, o que derruba a rede Tor e o caminho direto.
2. Na lista Computadores, toque no computador e anote a tela exibida. O esperado é Conexão de reserva indisponível, com o texto Não há caminho direto até o computador e a conexão de reserva não respondeu.
3. Anote os intervalos das novas tentativas pelo log do celular. O esperado é 2, 4, 8 e 16 s.
4. Libere o firewall sem tocar em Tentar agora e cronometre até a página voltar.
5. Repita os passos 1 a 4 até completar três execuções.
6. Condição B, STUN bloqueado: na rede do computador, bloqueie UDP de saída para as portas 3478 e 19302. No Diagnóstico avançado, toque em Executar diagnóstico e confirme a falha de Endereço público por STUN.
7. Confirme que Endereços anunciados mantém Rede local e Porta mapeada. Abra a sessão com o celular no mesmo Wi-Fi e anote Direta com Rede local; depois, em 4G ou 5G, anote o transporte e o Caminho ativo.
8. Libere o bloqueio sem tocar em Atualizar endereços e cronometre até Endereço público por STUN voltar aprovado em Executar diagnóstico.
9. Repita os passos 6 a 8 até completar três execuções.

### Meta da seção 9

- A seção 9 não tem linha própria para este cenário; valem o critério abaixo e as novas tentativas em 2, 4, 8 e 16 s.
- Recuperação ao liberar: até 30 s.

**Critério de aprovação:** com Tor bloqueado e sem caminho direto, tela sem conexão com o motivo Conexão de reserva indisponível; com STUN bloqueado, caminho local e mapeado continuam; recuperação em até 30 s ao liberar.

### Execuções da condição A, Tor bloqueado

| Nº | Aparelho | Ambiente | Motivo ou caminho observado | Transporte | Tempo de recuperação em s | Resultado |
| --- | --- | --- | --- | --- | --- | --- |
| 1 | ☐ iPhone ☐ Android |  |  | ☐ Direta ☐ Reserva |  | ☐ Passou ☐ Falhou |
| 2 | ☐ iPhone ☐ Android |  |  | ☐ Direta ☐ Reserva |  | ☐ Passou ☐ Falhou |
| 3 | ☐ iPhone ☐ Android |  |  | ☐ Direta ☐ Reserva |  | ☐ Passou ☐ Falhou |

### Execuções da condição B, STUN bloqueado

| Nº | Aparelho | Ambiente | Motivo ou caminho observado | Transporte | Tempo de recuperação em s | Resultado |
| --- | --- | --- | --- | --- | --- | --- |
| 1 | ☐ iPhone ☐ Android |  |  | ☐ Direta ☐ Reserva |  | ☐ Passou ☐ Falhou |
| 2 | ☐ iPhone ☐ Android |  |  | ☐ Direta ☐ Reserva |  | ☐ Passou ☐ Falhou |
| 3 | ☐ iPhone ☐ Android |  |  | ☐ Direta ☐ Reserva |  | ☐ Passou ☐ Falhou |

### Decisão

| Campo | Registro |
| --- | --- |
| Evidência anexada |  |
| Defeitos abertos |  |
| Observações |  |

Decisão do cenário: ☐ Aprovado ☐ Reprovado ☐ Bloqueado

<div style="page-break-after: always;"></div>

## CON-088 Troca entre Wi-Fi e rede móvel

Validade: só vale execução em aparelho físico. Simulação não aprova este cenário.

**Objetivo:** confirmar a reconexão após mudança de endereço do celular, com replay correto e sem comando duplicado.

### Rede

| Aparelho | Condição |
| --- | --- |
| Computador | Wi-Fi residencial com UPnP ligado |
| Celular | Começa no Wi-Fi residencial, com dados móveis 4G ou 5G ligados |

### Passos

1. Abra no celular uma sessão com um contador que imprime uma linha por segundo, como `seq 1 100000 | while read n; do echo $n; sleep 1; done`. Abra uma segunda sessão com o prompt livre.
2. Anote o transporte e o Caminho ativo antes da troca.
3. Na segunda sessão, digite `echo troca-N >> cialai-troca.txt`, trocando N pelo número da execução, e tecle Enter.
4. Logo em seguida, desligue o Wi-Fi do celular e inicie o cronômetro. Pare quando o contador voltar a avançar.
5. Anote o tempo, o transporte, o Caminho ativo e se houve migração ou reconexão. Migração: a página não mostra Conectando e o log do celular registra a troca de caminho sem nova conexão. Reconexão: aparece Conectando ou o log mostra conexão nova.
6. Confira que o contador não tem lacuna nem repetição depois do replay, e que `grep -c troca-N cialai-troca.txt` responde 1.
7. Religue o Wi-Fi e repita os passos 3 a 6 na direção de volta, com um novo N.
8. Repita até completar dez execuções por aparelho, cada uma com as duas direções.

### Meta da seção 9

- Reconexão após troca Wi-Fi para rede móvel: até 10 s em 10 de 10.

**Critério de aprovação:** página de volta em até 10 s em 10 de 10 execuções de cada aparelho, com replay correto e nenhum comando duplicado.

### Execuções

| Nº | Aparelho | Ambiente | Wi-Fi para móvel em s | Móvel para Wi-Fi em s | Transporte na rede móvel | Troca na ida | Replay e comando único | Resultado |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
| 1 | iPhone |  |  |  | ☐ Direta ☐ Reserva | ☐ Migração ☐ Reconexão | ☐ Correto ☐ Falhou | ☐ Passou ☐ Falhou |
| 2 | iPhone |  |  |  | ☐ Direta ☐ Reserva | ☐ Migração ☐ Reconexão | ☐ Correto ☐ Falhou | ☐ Passou ☐ Falhou |
| 3 | iPhone |  |  |  | ☐ Direta ☐ Reserva | ☐ Migração ☐ Reconexão | ☐ Correto ☐ Falhou | ☐ Passou ☐ Falhou |
| 4 | iPhone |  |  |  | ☐ Direta ☐ Reserva | ☐ Migração ☐ Reconexão | ☐ Correto ☐ Falhou | ☐ Passou ☐ Falhou |
| 5 | iPhone |  |  |  | ☐ Direta ☐ Reserva | ☐ Migração ☐ Reconexão | ☐ Correto ☐ Falhou | ☐ Passou ☐ Falhou |
| 6 | iPhone |  |  |  | ☐ Direta ☐ Reserva | ☐ Migração ☐ Reconexão | ☐ Correto ☐ Falhou | ☐ Passou ☐ Falhou |
| 7 | iPhone |  |  |  | ☐ Direta ☐ Reserva | ☐ Migração ☐ Reconexão | ☐ Correto ☐ Falhou | ☐ Passou ☐ Falhou |
| 8 | iPhone |  |  |  | ☐ Direta ☐ Reserva | ☐ Migração ☐ Reconexão | ☐ Correto ☐ Falhou | ☐ Passou ☐ Falhou |
| 9 | iPhone |  |  |  | ☐ Direta ☐ Reserva | ☐ Migração ☐ Reconexão | ☐ Correto ☐ Falhou | ☐ Passou ☐ Falhou |
| 10 | iPhone |  |  |  | ☐ Direta ☐ Reserva | ☐ Migração ☐ Reconexão | ☐ Correto ☐ Falhou | ☐ Passou ☐ Falhou |
| 11 | Android |  |  |  | ☐ Direta ☐ Reserva | ☐ Migração ☐ Reconexão | ☐ Correto ☐ Falhou | ☐ Passou ☐ Falhou |
| 12 | Android |  |  |  | ☐ Direta ☐ Reserva | ☐ Migração ☐ Reconexão | ☐ Correto ☐ Falhou | ☐ Passou ☐ Falhou |
| 13 | Android |  |  |  | ☐ Direta ☐ Reserva | ☐ Migração ☐ Reconexão | ☐ Correto ☐ Falhou | ☐ Passou ☐ Falhou |
| 14 | Android |  |  |  | ☐ Direta ☐ Reserva | ☐ Migração ☐ Reconexão | ☐ Correto ☐ Falhou | ☐ Passou ☐ Falhou |
| 15 | Android |  |  |  | ☐ Direta ☐ Reserva | ☐ Migração ☐ Reconexão | ☐ Correto ☐ Falhou | ☐ Passou ☐ Falhou |
| 16 | Android |  |  |  | ☐ Direta ☐ Reserva | ☐ Migração ☐ Reconexão | ☐ Correto ☐ Falhou | ☐ Passou ☐ Falhou |
| 17 | Android |  |  |  | ☐ Direta ☐ Reserva | ☐ Migração ☐ Reconexão | ☐ Correto ☐ Falhou | ☐ Passou ☐ Falhou |
| 18 | Android |  |  |  | ☐ Direta ☐ Reserva | ☐ Migração ☐ Reconexão | ☐ Correto ☐ Falhou | ☐ Passou ☐ Falhou |
| 19 | Android |  |  |  | ☐ Direta ☐ Reserva | ☐ Migração ☐ Reconexão | ☐ Correto ☐ Falhou | ☐ Passou ☐ Falhou |
| 20 | Android |  |  |  | ☐ Direta ☐ Reserva | ☐ Migração ☐ Reconexão | ☐ Correto ☐ Falhou | ☐ Passou ☐ Falhou |

### Decisão

| Campo | Registro |
| --- | --- |
| Evidência anexada |  |
| Defeitos abertos |  |
| Observações |  |

Decisão do cenário: ☐ Aprovado ☐ Reprovado ☐ Bloqueado

<div style="page-break-after: always;"></div>

## CON-089 Reinício do computador e do aplicativo

Validade: só vale execução em aparelho físico. Simulação não aprova este cenário.

**Objetivo:** confirmar que identidade, endereço onion e tokens persistem: o celular reconecta sem novo QR.

### Rede

| Aparelho | Condição |
| --- | --- |
| Computador | Wi-Fi residencial |
| Celular | Mesmo Wi-Fi ou 4G ou 5G; anote no Registro de ambientes |

### Passos

1. No Diagnóstico avançado do computador, anote os oito primeiros e os quatro últimos caracteres do Endereço onion.
2. Abra uma sessão no celular e anote o transporte.
3. Caso A: saia do Cialai no computador pelo menu Sair do Cialai e abra de novo. Inicie o cronômetro quando a janela do Cialai aparecer e pare quando a sessão voltar no celular.
4. Anote se o celular pediu novo QR e compare o Endereço onion com o anotado no passo 1.
5. Repita os passos 2 a 4 até completar cinco execuções do caso A.
6. Caso B: reinicie o computador, entre na conta e abra o Cialai. Cronometre como no passo 3 e repita o passo 4.
7. Repita o caso B até completar cinco execuções.

### Meta da seção 9

- Reconexão após reinício do app do computador: até 15 s.

**Critério de aprovação:** reconexão em até 15 s depois de o app voltar, sem novo QR e com o mesmo endereço onion antes e depois.

### Execuções

| Nº | Caso | Aparelho | Ambiente | Tempo até voltar em s | Transporte | Novo QR pedido | Mesmo onion | Resultado |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
| 1 | A, app | ☐ iPhone ☐ Android |  |  | ☐ Direta ☐ Reserva | ☐ não ☐ sim | ☐ sim ☐ não | ☐ Passou ☐ Falhou |
| 2 | A, app | ☐ iPhone ☐ Android |  |  | ☐ Direta ☐ Reserva | ☐ não ☐ sim | ☐ sim ☐ não | ☐ Passou ☐ Falhou |
| 3 | A, app | ☐ iPhone ☐ Android |  |  | ☐ Direta ☐ Reserva | ☐ não ☐ sim | ☐ sim ☐ não | ☐ Passou ☐ Falhou |
| 4 | A, app | ☐ iPhone ☐ Android |  |  | ☐ Direta ☐ Reserva | ☐ não ☐ sim | ☐ sim ☐ não | ☐ Passou ☐ Falhou |
| 5 | A, app | ☐ iPhone ☐ Android |  |  | ☐ Direta ☐ Reserva | ☐ não ☐ sim | ☐ sim ☐ não | ☐ Passou ☐ Falhou |
| 6 | B, computador | ☐ iPhone ☐ Android |  |  | ☐ Direta ☐ Reserva | ☐ não ☐ sim | ☐ sim ☐ não | ☐ Passou ☐ Falhou |
| 7 | B, computador | ☐ iPhone ☐ Android |  |  | ☐ Direta ☐ Reserva | ☐ não ☐ sim | ☐ sim ☐ não | ☐ Passou ☐ Falhou |
| 8 | B, computador | ☐ iPhone ☐ Android |  |  | ☐ Direta ☐ Reserva | ☐ não ☐ sim | ☐ sim ☐ não | ☐ Passou ☐ Falhou |
| 9 | B, computador | ☐ iPhone ☐ Android |  |  | ☐ Direta ☐ Reserva | ☐ não ☐ sim | ☐ sim ☐ não | ☐ Passou ☐ Falhou |
| 10 | B, computador | ☐ iPhone ☐ Android |  |  | ☐ Direta ☐ Reserva | ☐ não ☐ sim | ☐ sim ☐ não | ☐ Passou ☐ Falhou |

### Decisão

| Campo | Registro |
| --- | --- |
| Evidência anexada |  |
| Defeitos abertos |  |
| Observações |  |

Decisão do cenário: ☐ Aprovado ☐ Reprovado ☐ Bloqueado

<div style="page-break-after: always;"></div>

## CON-090 Retorno do celular após suspensão

Validade: só vale execução em aparelho físico. Simulação não aprova este cenário.

**Objetivo:** confirmar a reconexão quando o celular volta ao primeiro plano depois de ficar com a tela bloqueada.

### Rede

| Aparelho | Condição |
| --- | --- |
| Computador | Wi-Fi residencial |
| Celular | Rede anotada no Registro de ambientes; cubra os dois transportes ao longo das execuções quando for possível |

### Passos

1. Abra uma sessão no celular e anote o transporte.
2. Bloqueie a tela pelo tempo da linha: 1 min, 10 min ou 60 min.
3. Desbloqueie com o Cialai em primeiro plano, inicie o cronômetro no desbloqueio e pare quando a sessão voltar a receber saída.
4. Anote o transporte depois do retorno. No iPhone, reconexão do zero é esperada; no Android, o núcleo para depois de 120 s e reabre.
5. Repita até completar três execuções por duração e aparelho.

### Meta da seção 9

- Reconexão após retorno do segundo plano: até 5 s direto e até 15 s na reserva.

**Critério de aprovação:** página de volta em até 5 s no caminho direto e em até 15 s na reserva, em todas as execuções.

### Execuções

| Nº | Aparelho | Duração | Ambiente | Tempo até voltar em s | Transporte | Resultado |
| --- | --- | --- | --- | --- | --- | --- |
| 1 | iPhone | 1 min |  |  | ☐ Direta ☐ Reserva | ☐ Passou ☐ Falhou |
| 2 | iPhone | 1 min |  |  | ☐ Direta ☐ Reserva | ☐ Passou ☐ Falhou |
| 3 | iPhone | 1 min |  |  | ☐ Direta ☐ Reserva | ☐ Passou ☐ Falhou |
| 4 | iPhone | 10 min |  |  | ☐ Direta ☐ Reserva | ☐ Passou ☐ Falhou |
| 5 | iPhone | 10 min |  |  | ☐ Direta ☐ Reserva | ☐ Passou ☐ Falhou |
| 6 | iPhone | 10 min |  |  | ☐ Direta ☐ Reserva | ☐ Passou ☐ Falhou |
| 7 | iPhone | 60 min |  |  | ☐ Direta ☐ Reserva | ☐ Passou ☐ Falhou |
| 8 | iPhone | 60 min |  |  | ☐ Direta ☐ Reserva | ☐ Passou ☐ Falhou |
| 9 | iPhone | 60 min |  |  | ☐ Direta ☐ Reserva | ☐ Passou ☐ Falhou |
| 10 | Android | 1 min |  |  | ☐ Direta ☐ Reserva | ☐ Passou ☐ Falhou |
| 11 | Android | 1 min |  |  | ☐ Direta ☐ Reserva | ☐ Passou ☐ Falhou |
| 12 | Android | 1 min |  |  | ☐ Direta ☐ Reserva | ☐ Passou ☐ Falhou |
| 13 | Android | 10 min |  |  | ☐ Direta ☐ Reserva | ☐ Passou ☐ Falhou |
| 14 | Android | 10 min |  |  | ☐ Direta ☐ Reserva | ☐ Passou ☐ Falhou |
| 15 | Android | 10 min |  |  | ☐ Direta ☐ Reserva | ☐ Passou ☐ Falhou |
| 16 | Android | 60 min |  |  | ☐ Direta ☐ Reserva | ☐ Passou ☐ Falhou |
| 17 | Android | 60 min |  |  | ☐ Direta ☐ Reserva | ☐ Passou ☐ Falhou |
| 18 | Android | 60 min |  |  | ☐ Direta ☐ Reserva | ☐ Passou ☐ Falhou |

### Decisão

| Campo | Registro |
| --- | --- |
| Evidência anexada |  |
| Defeitos abertos |  |
| Observações |  |

Decisão do cenário: ☐ Aprovado ☐ Reprovado ☐ Bloqueado

<div style="page-break-after: always;"></div>

## CON-091 Aparelho não autorizado e revogação

Validade: só vale execução em aparelho físico. Simulação não aprova este cenário.

**Objetivo:** confirmar a proteção contra reutilização do código e a revogação efetiva, nos dois transportes.

### Rede

| Aparelho | Condição |
| --- | --- |
| Computador | Wi-Fi residencial |
| Celular | Direta: mesmo Wi-Fi. Reserva: condição de CON-086 ou de CON-084 |

### Passos

1. Caso A, foto do QR: fotografe o código com o aparelho de medição, conclua o pareamento real no primeiro celular e leia a foto no segundo celular. O esperado é Este código já foi usado. Gere um novo no computador.
2. Anote onde o computador registrou a tentativa: na tela ou em Registros.
3. Caso B, QR expirado: fotografe um código, espere mais de 10 min e leia a foto. O esperado é Este código expirou. Gere um novo no computador.
4. Caso C, revogação durante a digitação: com o celular digitando sem parar, abra Dispositivos no computador, toque em Revogar nome do celular e em Revogar acesso. Cronometre do toque até o celular mostrar Este celular foi removido.
5. No log do computador, anote o tempo entre a revogação e o fechamento das conexões do celular.
6. Caso D, reconexão do revogado: no celular revogado, toque no computador ou em Tentar agora e anote a recusa exibida.
7. Execute os quatro casos nos dois transportes.

### Meta da seção 9

- Revogação: sockets fechados em até 1 s; "removido" no celular em até 5 s.

**Critério de aprovação:** recusas com as mensagens corretas, Este celular foi removido em até 5 s e tentativa registrada no computador.

### Execuções

| Nº | Caso | Aparelho | Ambiente | Tempo em s | Transporte | Mensagem observada | Resultado |
| --- | --- | --- | --- | --- | --- | --- | --- |
| 1 | A, foto do QR | ☐ iPhone ☐ Android |  |  | Direta |  | ☐ Passou ☐ Falhou |
| 2 | A, foto do QR | ☐ iPhone ☐ Android |  |  | Reserva |  | ☐ Passou ☐ Falhou |
| 3 | B, QR expirado | ☐ iPhone ☐ Android |  |  | Direta |  | ☐ Passou ☐ Falhou |
| 4 | B, QR expirado | ☐ iPhone ☐ Android |  |  | Reserva |  | ☐ Passou ☐ Falhou |
| 5 | C, revogação | ☐ iPhone ☐ Android |  |  | Direta |  | ☐ Passou ☐ Falhou |
| 6 | C, revogação | ☐ iPhone ☐ Android |  |  | Reserva |  | ☐ Passou ☐ Falhou |
| 7 | D, revogado | ☐ iPhone ☐ Android |  |  | Direta |  | ☐ Passou ☐ Falhou |
| 8 | D, revogado | ☐ iPhone ☐ Android |  |  | Reserva |  | ☐ Passou ☐ Falhou |

| Item | Direta | Reserva |
| --- | --- | --- |
| Fechamento das conexões no log do computador em s |  |  |
| Acesso revogado exibido no computador | ☐ sim ☐ não | ☐ sim ☐ não |
| Tentativa registrada no computador | ☐ sim ☐ não | ☐ sim ☐ não |

### Decisão

| Campo | Registro |
| --- | --- |
| Evidência anexada |  |
| Defeitos abertos |  |
| Observações |  |

Decisão do cenário: ☐ Aprovado ☐ Reprovado ☐ Bloqueado

<div style="page-break-after: always;"></div>

## CON-092 Queda e recuperação do componente Tor

Validade: só vale execução em aparelho físico. Simulação não aprova este cenário.

**Objetivo:** confirmar a supervisão do componente Tor: reinício pelo sidecar com o mesmo endereço e retorno da sessão pela reserva.

### Rede

| Aparelho | Condição |
| --- | --- |
| Computador | Wi-Fi residencial |
| Celular | Sessão pela reserva, na condição de CON-086 ou de CON-084 |

### Passos

1. Confirme a sessão em Reserva e anote os oito primeiros e os quatro últimos caracteres do Endereço onion.
2. Parte do computador: encontre o processo `tor` do Cialai pelo método de Como medir e anote o PID.
3. Encerre o processo à força, com `kill -9 PID` no macOS e no Linux ou Finalizar tarefa no Windows, e inicie o cronômetro.
4. Anote quando surge um novo processo `tor` e quando o Diagnóstico avançado mostra Serviço onion Publicado com o mesmo endereço.
5. Anote quando a sessão volta a receber saída no celular.
6. Repita os passos 2 a 5 até completar cinco execuções.
7. Parte do celular: interrompa só a reserva do celular pelo meio de teste disponível no build interno e cronometre até Conexão de reserva Pronta e até a sessão voltar. Sem esse meio, bloqueie a rede Tor na rede do celular por 60 s, libere e anote o método em Observações. Encerrar o app inteiro não vale para esta parte.
8. Repita a parte do celular até completar cinco execuções.

### Meta da seção 9

- A seção 9 não tem linha própria para este cenário; vale o critério abaixo, com reinício do `tor` em recuo de 1 a 30 s.

**Critério de aprovação:** `tor` reiniciado pelo sidecar em até 30 s com o mesmo endereço e sessão de volta em até 60 s.

### Execuções

| Nº | Parte | Aparelho | Ambiente | Tempo até o Tor voltar em s | Mesmo onion | Tempo até a sessão voltar em s | Transporte | Resultado |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
| 1 | Computador | ☐ iPhone ☐ Android |  |  | ☐ sim ☐ não |  | ☐ Direta ☐ Reserva | ☐ Passou ☐ Falhou |
| 2 | Computador | ☐ iPhone ☐ Android |  |  | ☐ sim ☐ não |  | ☐ Direta ☐ Reserva | ☐ Passou ☐ Falhou |
| 3 | Computador | ☐ iPhone ☐ Android |  |  | ☐ sim ☐ não |  | ☐ Direta ☐ Reserva | ☐ Passou ☐ Falhou |
| 4 | Computador | ☐ iPhone ☐ Android |  |  | ☐ sim ☐ não |  | ☐ Direta ☐ Reserva | ☐ Passou ☐ Falhou |
| 5 | Computador | ☐ iPhone ☐ Android |  |  | ☐ sim ☐ não |  | ☐ Direta ☐ Reserva | ☐ Passou ☐ Falhou |
| 6 | Celular | ☐ iPhone ☐ Android |  |  | não se aplica |  | ☐ Direta ☐ Reserva | ☐ Passou ☐ Falhou |
| 7 | Celular | ☐ iPhone ☐ Android |  |  | não se aplica |  | ☐ Direta ☐ Reserva | ☐ Passou ☐ Falhou |
| 8 | Celular | ☐ iPhone ☐ Android |  |  | não se aplica |  | ☐ Direta ☐ Reserva | ☐ Passou ☐ Falhou |
| 9 | Celular | ☐ iPhone ☐ Android |  |  | não se aplica |  | ☐ Direta ☐ Reserva | ☐ Passou ☐ Falhou |
| 10 | Celular | ☐ iPhone ☐ Android |  |  | não se aplica |  | ☐ Direta ☐ Reserva | ☐ Passou ☐ Falhou |

### Decisão

| Campo | Registro |
| --- | --- |
| Evidência anexada |  |
| Defeitos abertos |  |
| Observações |  |

Decisão do cenário: ☐ Aprovado ☐ Reprovado ☐ Bloqueado

<div style="page-break-after: always;"></div>

## CON-093 Terminal, arquivos e prévias pelo produto

Validade: só vale execução em aparelho físico. Simulação não aprova este cenário.

**Objetivo:** confirmar as funcionalidades do produto sobre o transporte novo, nos dois transportes.

### Rede

| Aparelho | Condição |
| --- | --- |
| Computador | Wi-Fi residencial |
| Celular | Direta: 4G ou 5G com UPnP ligado no roteador. Reserva: condição de CON-086 ou de CON-084 |

### Passos

1. No computador, crie uma sessão com saída anterior. No celular, abra a sessão e confirme o histórico.
2. Rode `echo celular` e meça a latência de eco.
3. Digite `echo unico-N >> cialai-unico.txt`, trocando N pelo número da execução, e tecle Enter.
4. Rode `yes | head -c 50000000` e meça a vazão. Confirme que o computador continua fluido e anote se houve `detached` e replay.
5. Abra a lista de arquivos do projeto fictício, a prévia de uma imagem e a prévia de um texto.
6. Use as teclas especiais do celular: Ctrl+C interrompe um comando, Tab completa, as setas navegam no histórico e Esc funciona.
7. Confirme que `grep -c unico-N cialai-unico.txt` responde 1.
8. Encerre a sessão pelo celular e confirme o encerramento no computador.
9. Execute uma vez por transporte e aparelho.

### Meta da seção 9

- Latência de eco de tecla: até 150 ms direto pela internet e até 400 ms na reserva, mediana.
- Vazão de `yes` no celular: direto sem `detached`; reserva pode receber `detached` e religar com replay.

**Critério de aprovação:** todos os itens funcionam nos dois transportes e nenhum comando é duplicado.

### Execuções

| Nº | Transporte | Aparelho | Ambiente | Eco mediano em ms | Vazão de yes em s | `detached` e replay | Comando único | Resultado |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
| 1 | Direta | iPhone |  |  |  | ☐ nenhum ☐ religou com replay ☐ falhou | ☐ sim ☐ não | ☐ Passou ☐ Falhou |
| 2 | Direta | Android |  |  |  | ☐ nenhum ☐ religou com replay ☐ falhou | ☐ sim ☐ não | ☐ Passou ☐ Falhou |
| 3 | Reserva | iPhone |  |  |  | ☐ nenhum ☐ religou com replay ☐ falhou | ☐ sim ☐ não | ☐ Passou ☐ Falhou |
| 4 | Reserva | Android |  |  |  | ☐ nenhum ☐ religou com replay ☐ falhou | ☐ sim ☐ não | ☐ Passou ☐ Falhou |

| Item | Direta iPhone | Direta Android | Reserva iPhone | Reserva Android |
| --- | --- | --- | --- | --- |
| Sessão com histórico | ☐ | ☐ | ☐ | ☐ |
| Saída de `echo celular` | ☐ | ☐ | ☐ | ☐ |
| Computador fluido durante a vazão | ☐ | ☐ | ☐ | ☐ |
| Lista de arquivos | ☐ | ☐ | ☐ | ☐ |
| Prévia de imagem | ☐ | ☐ | ☐ | ☐ |
| Prévia de texto | ☐ | ☐ | ☐ | ☐ |
| Teclas especiais | ☐ | ☐ | ☐ | ☐ |
| Encerrar sessão | ☐ | ☐ | ☐ | ☐ |

### Decisão

| Campo | Registro |
| --- | --- |
| Evidência anexada |  |
| Defeitos abertos |  |
| Observações |  |

Decisão do cenário: ☐ Aprovado ☐ Reprovado ☐ Bloqueado

<div style="page-break-after: always;"></div>

## CON-094 Desempenho direto contra reserva e recursos

Validade: só vale execução em aparelho físico. Simulação não aprova este cenário.

**Objetivo:** preencher a tabela de metas com valores medidos de latência, vazão, memória, CPU, bateria e tamanho dos artefatos.

### Rede

| Aparelho | Condição |
| --- | --- |
| Computador | Wi-Fi residencial |
| Celular | Direta na mesma rede e pela internet; Reserva na condição de CON-086 ou de CON-084 |

### Passos

1. Para cada transporte e aparelho, abra a sessão e meça a latência de eco. Na mesma rede, anote também o valor de rede local.
2. Rode `yes | head -c 50000000` e meça a vazão.
3. Deixe a sessão aberta sem digitação por 5 min e meça RSS e CPU do sidecar e do `tor` no computador.
4. Meça a memória do app no celular com a sessão conectada.
5. Execute a medida de bateria de 30 min.
6. Repita os passos 1 a 5 até completar três execuções por transporte e aparelho.
7. Anote o tamanho do sidecar, do IPA e do AAB antes da conectividade nova e no build desta rodada.
8. Copie as medianas para a coluna Medido de Metas mensuráveis, com data e aparelho.

### Meta da seção 9

- Latência de eco de tecla: até 60 ms na rede local, até 150 ms direto pela internet e até 400 ms na reserva, mediana.
- Vazão de `yes` no celular: direto sem `detached`; reserva pode receber `detached` e religar com replay.
- Memória do computador em espera: sidecar e `tor` somados até 150 MB de RSS; CPU abaixo de 1% ocioso.
- Memória do app do celular conectado: até 120 MB de RSS, limite herdado do spike 1.
- Bateria do celular em sessão de 30 min em primeiro plano: registrar; objetivo de até 4%.
- Tamanho do sidecar, do IPA e do AAB: registrar antes e depois; objetivo de não crescer mais que 10 MB por artefato.

**Critério de aprovação:** tabela Metas mensuráveis com a coluna Medido preenchida para todas as linhas deste cenário.

### Execuções de rede e terminal

| Nº | Transporte | Aparelho | Ambiente | Eco mediano em ms | Vazão de yes em s | `detached` | Resultado |
| --- | --- | --- | --- | --- | --- | --- | --- |
| 1 | Direta | iPhone |  |  |  | ☐ não ☐ sim | ☐ Passou ☐ Falhou |
| 2 | Direta | iPhone |  |  |  | ☐ não ☐ sim | ☐ Passou ☐ Falhou |
| 3 | Direta | iPhone |  |  |  | ☐ não ☐ sim | ☐ Passou ☐ Falhou |
| 4 | Direta | Android |  |  |  | ☐ não ☐ sim | ☐ Passou ☐ Falhou |
| 5 | Direta | Android |  |  |  | ☐ não ☐ sim | ☐ Passou ☐ Falhou |
| 6 | Direta | Android |  |  |  | ☐ não ☐ sim | ☐ Passou ☐ Falhou |
| 7 | Reserva | iPhone |  |  |  | ☐ não ☐ sim | ☐ Passou ☐ Falhou |
| 8 | Reserva | iPhone |  |  |  | ☐ não ☐ sim | ☐ Passou ☐ Falhou |
| 9 | Reserva | iPhone |  |  |  | ☐ não ☐ sim | ☐ Passou ☐ Falhou |
| 10 | Reserva | Android |  |  |  | ☐ não ☐ sim | ☐ Passou ☐ Falhou |
| 11 | Reserva | Android |  |  |  | ☐ não ☐ sim | ☐ Passou ☐ Falhou |
| 12 | Reserva | Android |  |  |  | ☐ não ☐ sim | ☐ Passou ☐ Falhou |

### Execuções de recursos

| Nº | Transporte | Aparelho | Ambiente | RSS do sidecar e do tor em MB | CPU ociosa em % | Memória do app em MB | Bateria em 30 min em % | Resultado |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
| 1 | Direta | iPhone |  |  |  |  |  | ☐ Passou ☐ Falhou |
| 2 | Direta | iPhone |  |  |  |  |  | ☐ Passou ☐ Falhou |
| 3 | Direta | iPhone |  |  |  |  |  | ☐ Passou ☐ Falhou |
| 4 | Direta | Android |  |  |  |  |  | ☐ Passou ☐ Falhou |
| 5 | Direta | Android |  |  |  |  |  | ☐ Passou ☐ Falhou |
| 6 | Direta | Android |  |  |  |  |  | ☐ Passou ☐ Falhou |
| 7 | Reserva | iPhone |  |  |  |  |  | ☐ Passou ☐ Falhou |
| 8 | Reserva | iPhone |  |  |  |  |  | ☐ Passou ☐ Falhou |
| 9 | Reserva | iPhone |  |  |  |  |  | ☐ Passou ☐ Falhou |
| 10 | Reserva | Android |  |  |  |  |  | ☐ Passou ☐ Falhou |
| 11 | Reserva | Android |  |  |  |  |  | ☐ Passou ☐ Falhou |
| 12 | Reserva | Android |  |  |  |  |  | ☐ Passou ☐ Falhou |

### Tamanho dos artefatos

| Artefato | Antes em MB | Depois em MB | Diferença em MB |
| --- | --- | --- | --- |
| Sidecar |  |  |  |
| IPA |  |  |  |
| AAB |  |  |  |

### Decisão

| Campo | Registro |
| --- | --- |
| Evidência anexada |  |
| Defeitos abertos |  |
| Observações |  |

Decisão do cenário: ☐ Aprovado ☐ Reprovado ☐ Bloqueado

<div style="page-break-after: always;"></div>

## CON-095 Soak de 24 horas

Validade: só vale execução em aparelho físico. Simulação não aprova este cenário.

**Objetivo:** comprovar robustez com o soak do proxy por 24 h e, em paralelo, uma sessão real pela reserva no celular físico.

### Rede

| Aparelho | Condição |
| --- | --- |
| Computador | Wi-Fi residencial, na tomada, com repouso desativado |
| Celular | Sessão pela reserva, na tomada, com bloqueio automático da tela desligado |

### Passos

1. Anote o commit, o espaço livre em disco e o transporte usado pelo soak. O critério pede o proxy sobre o transporte direto; se a suíte ainda usar loopback, registre isso em Observações e marque Bloqueado.
2. Em `packages/tunnel-core`, inicie o soak com o comando abaixo.
3. Em paralelo, abra no celular uma sessão pela reserva com um comando que imprime a hora a cada minuto, como `while true; do date; sleep 60; done`.
4. Nas marcas de 0 h, 4 h, 8 h, 12 h, 16 h, 20 h e 24 h, anote RSS do sidecar e do `tor`, o transporte da sessão e se ela continua recebendo saída.
5. Ao final, leia no relatório JSON a duração, as desconexões atribuídas ao proxy e o RSS inicial, final e pico.
6. Confira na saída da sessão do celular se faltou alguma hora e anote cada queda com horário e motivo exibido.

### Meta da seção 9

- Soak: 24 h sem desconexão pelo proxy e memória estável.

**Critério de aprovação:** zero desconexões atribuídas ao proxy e crescimento de memória abaixo de 20 MB.

Comando do soak:

```sh
CIALAI_SOAK_DURATION=24h CIALAI_SOAK_BURST_INTERVAL=10s \
CIALAI_SOAK_REPORT="$PWD/build/soak/proxy-soak-24h.json" \
go test -tags=soak -count=1 -run '^TestProxySoak$' -timeout=25h -v ./soak
```

### Execuções

| Marca | Data e hora | Ambiente | RSS do sidecar em MB | RSS do tor em MB | Transporte da sessão | Sessão recebendo saída | Resultado |
| --- | --- | --- | --- | --- | --- | --- | --- |
| 0 h |  |  |  |  | ☐ Direta ☐ Reserva | ☐ sim ☐ não | ☐ Passou ☐ Falhou |
| 4 h |  |  |  |  | ☐ Direta ☐ Reserva | ☐ sim ☐ não | ☐ Passou ☐ Falhou |
| 8 h |  |  |  |  | ☐ Direta ☐ Reserva | ☐ sim ☐ não | ☐ Passou ☐ Falhou |
| 12 h |  |  |  |  | ☐ Direta ☐ Reserva | ☐ sim ☐ não | ☐ Passou ☐ Falhou |
| 16 h |  |  |  |  | ☐ Direta ☐ Reserva | ☐ sim ☐ não | ☐ Passou ☐ Falhou |
| 20 h |  |  |  |  | ☐ Direta ☐ Reserva | ☐ sim ☐ não | ☐ Passou ☐ Falhou |
| 24 h |  |  |  |  | ☐ Direta ☐ Reserva | ☐ sim ☐ não | ☐ Passou ☐ Falhou |

| Item | Registro |
| --- | --- |
| Duração registrada no relatório |  |
| Desconexões atribuídas ao proxy |  |
| RSS inicial em MB |  |
| RSS final em MB |  |
| RSS de pico em MB |  |
| Crescimento de memória em MB |  |
| Quedas da sessão pela reserva |  |

### Decisão

| Campo | Registro |
| --- | --- |
| Evidência anexada |  |
| Defeitos abertos |  |
| Observações |  |

Decisão do cenário: ☐ Aprovado ☐ Reprovado ☐ Bloqueado

<div style="page-break-after: always;"></div>

## Encerramento da rodada

| Campo | Registro |
| --- | --- |
| Cenários aprovados de 15 |  |
| Cenários reprovados |  |
| Cenários bloqueados |  |
| Defeitos abertos |  |
| Evidência consolidada |  |
| Data e hora final |  |
| Assinatura da pessoa responsável |  |
| Revisão independente |  |

Decisão da fase de validação em aparelhos reais: ☐ Aprovada ☐ Pendente

Somente marque Aprovada quando os quinze cenários tiverem decisão Aprovado e evidência correspondente.

## Metas mensuráveis

Todas as linhas são metas da seção 9 do plano de conectividade. A coluna Medido só recebe valores vindos de execução física registrada nesta folha, sempre com data e aparelho.

| Métrica | Meta | Cenário | Medido |
| --- | --- | --- | --- |
| Tempo até a página na mesma rede | até 2 s em 9 de 10 aberturas | CON-081 |  |
| Tempo até a página pelo caminho direto pela internet | até 3 s em 9 de 10 aberturas | CON-082, CON-083, CON-085 |  |
| Tempo até a página pela reserva, Tor já iniciado | até 6 s em 9 de 10 aberturas | CON-082, CON-084, CON-086 |  |
| Tempo até a página pela reserva, app do celular frio | até 15 s em 9 de 10 aberturas | CON-084 |  |
| Pareamento de outra rede pela reserva, serviço já publicado | até 20 s | CON-082 |  |
| Taxa de caminho direto em Wi-Fi residencial com UPnP e celular em 4G/5G | registrar; objetivo de ao menos 8 de 10 | CON-082 |  |
| Taxa de furo de NAT sem porta mapeada, NAT cone dos dois lados | registrar; objetivo de ao menos 6 de 10 | CON-083 |  |
| Reconexão após troca Wi-Fi para rede móvel | até 10 s em 10 de 10 | CON-088 |  |
| Reconexão após retorno do segundo plano | até 5 s direto, até 15 s reserva | CON-090 |  |
| Reconexão após reinício do app do computador | até 15 s | CON-089 |  |
| Latência de eco de tecla | até 60 ms na rede local, até 150 ms direto pela internet, até 400 ms na reserva, mediana | CON-093, CON-094 |  |
| Vazão de `yes` no celular | direto sem `detached`; reserva pode receber `detached` e religar com replay | CON-093, CON-094 |  |
| Revogação | sockets fechados em até 1 s; "removido" no celular em até 5 s | CON-091 |  |
| Memória do computador em espera | sidecar e `tor` somados até 150 MB de RSS; CPU abaixo de 1% ocioso | CON-094 |  |
| Memória do app do celular conectado | até 120 MB de RSS, limite herdado do spike 1 | CON-094 |  |
| Bateria do celular em sessão de 30 min em primeiro plano | registrar; objetivo de até 4% | CON-094 |  |
| Tamanho do sidecar, do IPA e do AAB | registrar antes e depois; objetivo de não crescer mais que 10 MB por artefato | CON-094 |  |
| Soak | 24 h sem desconexão pelo proxy e memória estável | CON-095 |  |

Estado: roteiro preparado, execução em aparelho real pendente
