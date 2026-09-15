# Roteiro Manual 3.9 para iPhone

Nota: a conectividade atual é validada por [`roteiro-conectividade.md`](roteiro-conectividade.md). Os cenários de Headscale desta folha ficaram históricos.

Estado: roteiro preparado, execução em aparelho real pendente

Use uma cópia impressa por combinação de iPhone, versão do iOS, build móvel e sistema do desktop. Todos os projetos, usuários e nomes precisam ser fictícios.

## Identificação

| Campo | Registro |
| --- | --- |
| Data e hora inicial |  |
| Pessoa responsável |  |
| Modelo do iPhone |  |
| Versão do iOS |  |
| Versão e build do Cialai móvel |  |
| Origem do build |  |
| Sistema e versão do desktop |  |
| Versão do Cialai desktop |  |
| Commit do código |  |
| Versão do Headscale |  |
| Rede Wi-Fi |  |
| Operadora LTE |  |
| Região do relé |  |

## Preparação

- [ ] Build interno instalado no iPhone real
- [ ] Desktop de teste com projeto fictício
- [ ] Headscale de teste saudável
- [ ] Relógios automáticos ativos antes do ensaio de desvio
- [ ] Logs sanitizados habilitados no desktop e no celular
- [ ] Captura de tela pronta para registrar cronômetros e estados
- [ ] Nenhum QR, token, chave ou dado privado será anexado à evidência

Critério geral: os treze cenários precisam ser aprovados. Uma falha, um campo obrigatório vazio ou uma medição sem evidência mantém a tarefa 3.9 pendente.

<div style="page-break-after: always;"></div>

## 1. Modo avião

Passos: abra uma sessão no celular, ative o modo avião por 60 segundos e desative.

Critérios: o desktop mostra o celular desconectado em até 40 segundos. Nenhum shell termina. O celular religa em até 10 segundos com replay e posição corretos.

| Campo | Registro |
| --- | --- |
| Tempo até desconectar |  |
| Tempo até religar |  |
| Shell permaneceu ativo |  |
| Replay e posição corretos |  |
| Evidência |  |
| Resultado | ☐ Aprovado ☐ Reprovado ☐ Bloqueado |
| Observações |  |

## 2. Celular atrasado

Passos: execute `yes | head -c 50000000` no desktop e acompanhe pelo celular.

Critérios: o desktop permanece fluido. O celular recebe `detached` e religa com 256 KiB. O proxy não desconecta por conta própria.

| Campo | Registro |
| --- | --- |
| Fluidez do desktop |  |
| Evento `detached` |  |
| Replay de 256 KiB |  |
| Desconexão do proxy |  |
| Memória antes e depois |  |
| Evidência |  |
| Resultado | ☐ Aprovado ☐ Reprovado ☐ Bloqueado |
| Observações |  |

## 3. Revogação

Passos: revogue o iPhone enquanto ele envia entrada. Depois faça um novo pareamento.

Critérios: o estado Removido aparece em até 5 segundos. O novo pareamento funciona. Com revogação na rede, o nó some do Headscale.

| Campo | Registro |
| --- | --- |
| Tempo até Removido |  |
| Nó removido do Headscale |  |
| Novo pareamento concluído |  |
| Evidência |  |
| Resultado | ☐ Aprovado ☐ Reprovado ☐ Bloqueado |
| Observações |  |

## 4. Reinício do desktop

Passos: saia do Cialai no desktop e abra novamente.

Critérios: o celular fica offline em até 40 segundos e retorna em até 15 segundos sem novo pareamento. Os tokens sobrevivem. O identificador do processo do sidecar muda uma vez.

| Campo | Registro |
| --- | --- |
| Tempo até offline |  |
| Tempo até retorno |  |
| Novo pareamento foi desnecessário |  |
| Tokens preservados |  |
| Mudanças do processo do sidecar |  |
| Evidência |  |
| Resultado | ☐ Aprovado ☐ Reprovado ☐ Bloqueado |
| Observações |  |

## 5. Reinício do aplicativo móvel

Passos: encerre o aplicativo por completo e abra novamente.

Critérios: nenhum QR é solicitado. A página abre em até 5 segundos no Wi-Fi e em até 10 segundos no LTE. O armazenamento local permanece intacto.

| Campo | Registro |
| --- | --- |
| Tempo no Wi-Fi |  |
| Tempo no LTE |  |
| QR foi desnecessário |  |
| Armazenamento local preservado |  |
| Evidência |  |
| Resultado | ☐ Aprovado ☐ Reprovado ☐ Bloqueado |
| Observações |  |

## 6. Troca de rede

Passos: troque de Wi-Fi para LTE e depois retorne ao Wi-Fi.

Critérios: a sessão religa em até 10 segundos em cada troca. O log registra `NotifyNetworkChange` sem segredos.

| Campo | Registro |
| --- | --- |
| Tempo de Wi-Fi para LTE |  |
| Tempo de LTE para Wi-Fi |  |
| Evento no log |  |
| Evidência |  |
| Resultado | ☐ Aprovado ☐ Reprovado ☐ Bloqueado |
| Observações |  |

## 7. Segundo plano

Passos: deixe o aplicativo em segundo plano por 10 minutos e retorne.

Critério: a sessão religa em até 5 segundos.

| Campo | Registro |
| --- | --- |
| Duração em segundo plano |  |
| Tempo até religar |  |
| Estado da sessão e do histórico |  |
| Evidência |  |
| Resultado | ☐ Aprovado ☐ Reprovado ☐ Bloqueado |
| Observações |  |

<div style="page-break-after: always;"></div>

## 8. Somente relé

Passos: bloqueie UDP na rede Wi-Fi do iPhone e abra a sessão.

Critérios: a conexão usa o relé, a latência permanece aceitável para digitação e o estado informa relé.

| Campo | Registro |
| --- | --- |
| Bloqueio aplicado |  |
| Região do relé |  |
| Latência medida |  |
| Estado mostrou relé |  |
| Evidência |  |
| Resultado | ☐ Aprovado ☐ Reprovado ☐ Bloqueado |
| Observações |  |

## 9. Headscale fora do ar

Passos: pare o Headscale por 2 minutos durante uma sessão e depois restaure.

Critérios: a sessão direta continua ou religa. Novas conexões mostram Servidor inacessível. O sistema recupera quando o servidor volta.

| Campo | Registro |
| --- | --- |
| Sessão existente durante a parada |  |
| Estado de nova conexão |  |
| Tempo de recuperação |  |
| Evidência |  |
| Resultado | ☐ Aprovado ☐ Reprovado ☐ Bloqueado |
| Observações |  |

## 10. Relógio adiantado

Passos: adiante o relógio do iPhone em 30 minutos, faça o pareamento e depois restaure o horário.

Critérios: o pareamento funciona. Qualquer recusa de handshake ao restaurar o relógio precisa ser registrada.

| Campo | Registro |
| --- | --- |
| Pareamento concluído |  |
| Recusa ao restaurar o relógio |  |
| Evidência |  |
| Resultado | ☐ Aprovado ☐ Reprovado ☐ Bloqueado |
| Observações |  |

## 11. Segundo celular e segundo desktop

Passos: pareie outro celular e depois pareie o primeiro iPhone com outro desktop do mesmo usuário.

Critérios: os vínculos coexistem. A largura do terminal permanece correta. A troca de desktop não exige nova entrada na rede.

| Campo | Registro |
| --- | --- |
| Segundo celular conectado |  |
| Segundo desktop conectado |  |
| Largura correta |  |
| Troca sem nova entrada |  |
| Evidência |  |
| Resultado | ☐ Aprovado ☐ Reprovado ☐ Bloqueado |
| Observações |  |

## 12. Foto do QR

Passos: fotografe o QR, conclua o pareamento real e tente usar a foto depois.

Critérios: a foto é recusada com `pair_consumed` e `auth_key_rejected`. O desktop mostra a tentativa sem expor segredos.

| Campo | Registro |
| --- | --- |
| `pair_consumed` observado |  |
| `auth_key_rejected` observado |  |
| Tentativa visível no desktop |  |
| Evidência |  |
| Resultado | ☐ Aprovado ☐ Reprovado ☐ Bloqueado |
| Observações |  |

## 13. Permissões

Passos: negue a câmera e confira a alternativa de colar. Reinstale quando necessário, negue a rede local e tente conectar pelo relé.

Critérios: os pedidos explicam a finalidade. Negar a câmera mantém uma alternativa clara. Negar a rede local força somente o relé.

| Campo | Registro |
| --- | --- |
| Mensagem ao negar câmera |  |
| Alternativa de colar funciona |  |
| Mensagem ao negar rede local |  |
| Conexão pelo relé |  |
| Evidência |  |
| Resultado | ☐ Aprovado ☐ Reprovado ☐ Bloqueado |
| Observações |  |

## Encerramento

| Campo | Registro |
| --- | --- |
| Cenários aprovados de 13 |  |
| Cenários reprovados |  |
| Cenários bloqueados |  |
| Defeitos abertos |  |
| Evidência consolidada |  |
| Data e hora final |  |
| Assinatura da pessoa responsável |  |
| Revisão independente |  |

Decisão da tarefa 3.9: ☐ Aprovada ☐ Pendente

Somente marque Aprovada quando os treze cenários tiverem resultado aprovado e evidência correspondente.
