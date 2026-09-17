# Roteiro dos screenshots de loja do Cialai

> Voz: direta, calma, precisa. Frases curtas, sem exclamação, sem gíria, sem humor
> forçado. O sistema não se anuncia; ele funciona.
> Marca: ameixa `#3A1B33` sobre a superfície blush `#FBF3F7`, Outfit. Rosa e magenta
> nunca em texto sobre o fundo claro; o acento vive dentro da tela do app.

## Decisões travadas

- Fundo blush `#FBF3F7` chapado em todos os slides. Sem gradiente, sem forma.
- Oito screenshots mais a capa. A Apple aceita dez, o Google aceita oito.
- iPhone frontal com Dynamic Island, gerado uma vez com a tela chroma. O mesmo render
  serve ao Google Play e à App Store.
- O app aparece em modo escuro em sete slides. O oitavo mostra o modo claro.
- Sem logo desenhada pela IA. A assinatura entra em pós, e só na capa.
- Sem nome real de computador. `Mac de Foco` vira `MacBook de Ana`, o mesmo nome
  fictício do site.
- Sem parênteses, hífen solto, meia-risca ou travessão em texto visível.
- pt-BR nesta rodada. O roteiro em inglês espera capturas em inglês.

## Os oito screenshots

| # | Disposição | Tela | Origem | Headline | Subtítulo |
|---|---|---|---|---|---|
| 1 | full | Lista de sessões, escuro | real | Todos os seus terminais, no celular. | Cada sessão do computador, com estado, agente e consumo. |
| 2 | bottom | Terminal, escuro | real | Acompanhe o agente e assuma o terminal. | Histórico ao vivo e teclas essenciais na mesma tela. |
| 3 | full | Parear, confirmação | IA, provisória | Vincule o celular com um código QR. | Código de curta duração, sem conta e sem servidor. |
| 4 | bottom | Computadores | IA, provisória | Seus computadores, com o estado da conexão. | Direta quando a rede permite, pelo Tor como reserva. |
| 5 | full | Arquivos | real | Navegue pelos arquivos do projeto. | Somente leitura, só nas pastas liberadas no computador. |
| 6 | bottom | Lista, escuro, cortada no card do agente | real | Veja o que o agente está fazendo. | Modelo, esforço, contexto e custo em cada sessão. |
| 7 | full | Ajustes | IA, provisória | Segurança no próprio aparelho. | Biometria em cada ação sensível, idioma e tema à sua escolha. |
| 8 | bottom | Lista de sessões, claro | real | Claro ou escuro, como o sistema. | A mesma lista, no tema do seu aparelho. |

As quebras de linha são autorais e ficam em `docs/compose_device.py`, duas linhas de
headline e duas de subtítulo por slide.

### Por que o slide 6 corta o topo

A lista escura entra pela segunda vez, cortada na borda do primeiro card. Na disposição
`bottom` isso deixa o card `cialai-platform` na dobra visível do aparelho, com o agente,
o modelo, o esforço, o contexto e o custo à vista. É o slide que prova o acompanhamento
de agentes sem precisar de uma tela nova.

### Ordem

As telas reais abrem e fecham o carrossel e ocupam as posições ímpares mais fortes. As
três telas provisórias ficam em 3, 4 e 7, onde contam a história de pareamento e de
segurança que o plano de loja do produto pede, até a build de aparelho render as capturas
reais.

## Capa do Google Play

Aparelho à esquerda com a lista escura, topo visível e base cortada pela borda. Coluna
direita, alinhada à esquerda: o lockup oficial, símbolo mais nome Cialai, e abaixo a
headline `Todos os seus terminais.` com o subtítulo `No computador e no celular.`
Símbolo, headline e subtítulo começam na mesma margem, e o lockup guarda trinta por
cento da própria altura de respiro antes da headline.

## Fora desta rodada

- Reconectando, a tela honesta de computador indisponível. Strings já levantadas:
  `Sem conexão`, `O computador está fora de alcance`, `Deixe o Cialai aberto no
  computador e confira a internet dos dois aparelhos.`, `Tentar agora`, `Trocar de
  computador`. Entra quando houver captura real ou quando o carrossel da App Store
  for a dez.
- Rodada em inglês, com o mesmo roteiro traduzido, depois das capturas em `en`.
