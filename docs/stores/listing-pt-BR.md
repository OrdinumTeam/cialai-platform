# Cialai para as lojas em pt-BR

Status: publicado nas duas lojas em 16/09/2026; produção do Google Play enviada à revisão em 17/09/2026

O Google Play recebeu em 17/09/2026 a versão 0.2.4, versionCode 16, na faixa de
produção, com implantação completa e 177 países mais o resto do mundo. A
publicação gerenciada está desativada, então o app vai ao ar assim que a revisão
aprovar.

Este texto está aplicado na ficha pt-BR do Google Play e do App Store Connect. A
descrição completa entrou igual nas duas. As novidades da versão entraram só no
Play: a Apple recusa o campo na primeira versão de um app, porque ele descreve
mudanças em relação a uma versão anterior.

## Nome

```text
Cialai
```

## Subtítulo da App Store

```text
Terminais em todo lugar
```

## Texto promocional da App Store

```text
Acompanhe seus terminais, arquivos e sessões de código pelo celular com uma conexão cifrada que se configura sozinha.
```

## Descrição breve do Google Play

<!-- PLAY_SHORT_START -->
```text
Terminais, arquivos e sessões de código no computador e no celular.
```
<!-- PLAY_SHORT_END -->

## Descrição completa

<!-- STORE_LONG_START -->
```text
O Cialai leva seu estúdio de terminais do computador para o celular sem entregar seus projetos a um serviço hospedado pela Ordinum.

No computador, cada sessão abre um shell real na pasta escolhida. Você acompanha o processo em execução, o consumo de recursos e o estado dos seus agentes de código. O mesmo espaço reúne arquivos, alterações do Git, editor, prévias locais e um navegador Chromium controlado.

No celular, você pode acompanhar o histórico, assumir o terminal, usar teclas essenciais e navegar pelos arquivos permitidos. O cabeçalho mostra qual computador está aberto e o estado da conexão.

Principais recursos:

• Sessões de terminal organizadas por projeto
• Histórico local preservado ao fechar o aplicativo
• Retomada de sessões compatíveis do Claude Code e do Codex
• Arquivos, Git, prévias e Dev Browser no desktop
• Pareamento por código QR de curta duração
• Revogação de aparelhos pelo computador
• Proteção biométrica para ações sensíveis no celular
• Conexão cifrada de ponta a ponta entre aparelhos pareados
• Conexão automática, direta quando a rede permite e pelo Tor como reserva

O Cialai precisa do aplicativo desktop aberto no computador. Não há servidor para configurar: o celular conecta direto quando a rede permite e pela rede Tor como reserva. A Ordinum não oferece uma nuvem do Cialai e não recebe o conteúdo dos seus projetos ou terminais.

Consulte a política de privacidade e a documentação do projeto para saber quais redes públicas a conexão usa.
```
<!-- STORE_LONG_END -->

## Novidades da versão 1.0.0

### Texto curto para Google Play

Aplicado na produção do Google Play com a 0.2.12, versionCode 32, em 12/10/2026. Cobre o que chegou ao celular desde a 0.2.9, a versão anterior da loja.

<!-- PLAY_RELEASE_START -->
```text
Novidades desta versão:
• Avisos quando uma sessão pede atenção, com o nome e a cor dela; o toque abre a sessão.
• Enter, Esc, Ctrl C e Ctrl V sempre à vista na barra do terminal.
• Cor e ícone de cada sessão em toda a interface.
• Limite semanal no Início e em Agentes, com faixas em 60 e 80%.
• Marca oficial e ícones mais limpos.
```
<!-- PLAY_RELEASE_END -->

### Texto longo para App Store

```text
Esta é a primeira versão do Cialai para celular:

• Pareie seu computador por um código QR de curta duração e confirme o vínculo quando a aprovação estiver ativa.
• Veja os computadores disponíveis e o estado de cada conexão.
• Acompanhe o histórico do terminal, assuma a sessão e use as teclas essenciais pelo celular.
• Navegue pelos arquivos liberados no desktop e abra prévias compatíveis.
• Retome a conexão depois de mudar de rede ou voltar ao aplicativo.
• Proteja perfis e tokens no armazenamento seguro do aparelho.

O aplicativo requer o Cialai aberto no computador. Nenhum servidor precisa ser configurado.
```

## Novidades da prévia na App Store

O que a App Store mostra em Novidades desta versão. A loja tem uma fonte só, e
é esta: `tools/release/asc_submit.py` lê este bloco e grava o texto na versão
antes de enviar à revisão. A última versão publicada na loja é a 0.2.9, então o
texto cobre tudo que chegou ao iPhone desde ela, e não só o da entrega do dia.

O ícone não entra na lista. Ele foi reenquadrado mais de uma vez entre a 0.2.2 e a
0.2.9, mas voltou ao mesmo lugar: a arte mede 597 por 898 nos dois arquivos, e a
diferença visível entre eles é zero pixel. Para quem atualiza do iPhone, o ícone
não mudou, e anunciar que mudou seria mentira na ficha da loja.

<!-- ASC_WHATS_NEW_START -->
```text
Esta atualização traz ao iPhone a nova cara do Cialai e avisos de atenção.

• Avisos quando uma sessão pede atenção: o sino do terminal, o comando que terminou, o agente aguardando você ou pedindo permissão e a resposta pronta. O aviso traz o nome e a cor da sessão, e o toque abre a sessão. Liga em Ajustes, em Sessões pedindo atenção.
• Enter, Esc, Ctrl C e Ctrl V sempre à vista na barra do terminal. A setinha continua abrindo o teclado especial.
• Cada sessão com a própria cor e o próprio ícone, no card, no cabeçalho e nas pastas do Início. Sem cor, o rosa do Cialai.
• Limite semanal no Início e na aba Agentes, que diferencia conta sem limite semanal de leitura que ainda não chegou.
• Faixas de uso novas: âmbar a partir de 60% e vermelho a partir de 80%.
• Marca oficial do Cialai e ícones sem placas de fundo.
• Os avisos são locais e saem enquanto o app está com o terminal aberto ou logo depois de ir para segundo plano. Atualize também o Cialai do computador para receber os avisos de atenção.
```
<!-- ASC_WHATS_NEW_END -->

## Texto promocional da App Store

Aparece acima da descrição na ficha. A Apple deixa trocar este campo sem nova
revisão, e ele NÃO é copiado quando uma versão nova é criada: a 0.2.8 nasceu com
ele vazio até ser regravado daqui. Por isso mora no repositório.

<!-- ASC_PROMO_START -->
```text
Acompanhe seus terminais, arquivos e sessões de código pelo celular com uma conexão cifrada que se configura sozinha.
```
<!-- ASC_PROMO_END -->

São 117 dos 170 caracteres.

## Palavras chave da App Store

<!-- ASC_KEYWORDS_START -->
```text
ssh,shell,console,cli,comandos,codigo,programar,desenvolvedor,remoto,git,arquivos,agente
```
<!-- ASC_KEYWORDS_END -->

São 88 dos 100 caracteres. Nome e subtítulo ficam de fora porque a Apple já os
indexa, e nenhuma marca de terceiro entra, o que causaria rejeição. Escolha
feita junto com a categoria, ainda sem medição de desempenho na busca.

## Campos resolvidos

| Campo | Valor |
| --- | --- |
| URL de suporte | `https://cialai.com.br` |
| URL de marketing | `https://cialai.com.br` |
| URL da política de privacidade | `https://cialai.com.br/privacy-policy` |
| Categoria no Google Play | Ferramentas |
| Categoria na App Store | Developer Tools, com Utilities como secundária |
| Copyright da App Store | `2026 Ordinum Inovação e Tecnologia Ltda.` |
