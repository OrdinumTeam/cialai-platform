# Política de Privacidade do Cialai

Data de vigência: 15 de setembro de 2026

Estado de publicação: preparada para publicação antes da primeira versão pública

O Cialai é um estúdio de terminais de código aberto fornecido por ORDINUM INOVACAO E TECNOLOGIA LTDA. Esta política explica como os aplicativos Cialai para computador e celular tratam informações.

## Resumo

O Cialai não oferece conta da Ordinum, publicidade, análise de uso nem serviço de aplicativo hospedado. A Ordinum não coleta conteúdo de projetos, entrada de terminal, saída de terminal, códigos de pareamento, tokens de dispositivo ou dados biométricos por meio do Cialai.

Os aplicativos de celular se conectam somente ao computador da própria pessoa usuária, por uma conexão cifrada de ponta a ponta que o computador prepara sozinho, sem servidor da pessoa usuária, da Ordinum ou do projeto no caminho. A Ordinum não recebe, não armazena e não acessa terminais, arquivos ou tráfego.

## Informações processadas nos seus aparelhos

O Cialai processa as informações abaixo somente para oferecer seus recursos:

- Pastas e arquivos de projetos escolhidos no computador
- Entrada, saída, histórico de sessões e informações de processos do terminal
- Estado do Git e prévias locais
- Leitura local do uso do plano de agentes de código, a partir dos arquivos que esses agentes gravam no computador
- A identidade do computador, com as chaves Ed25519, e a lista de celulares pareados, para que cada um possa ser revogado
- Nomes e identificadores técnicos dos computadores e celulares pareados
- Estado da conexão, endereços de rede e registros de diagnóstico

Essas informações são armazenadas localmente, nos diretórios de dados do próprio aplicativo, e nenhuma delas é enviada à Ordinum. No celular ficam a chave pública de cada computador pareado, recebida pelo QR de pareamento, a chave própria do aparelho, que o identifica diante do computador, e um token por computador pareado, guardado no armazenamento seguro do aparelho e restrito a ele. No computador, os tokens de dispositivo são guardados somente como hashes. Os segredos de pareamento têm duração curta e não são mantidos depois do uso. Uma chave da API do Headscale gravada por uma prévia anterior não é mais usada e pode ser apagada nos diagnósticos avançados da tela Dispositivos.

## Conexão entre aparelhos

O conteúdo do terminal e os arquivos de projeto transitam entre os aparelhos somente quando a pessoa abre uma sessão pareada. A comunicação entre computador e celular é cifrada de ponta a ponta com TLS 1.3 mútuo em todos os caminhos: na rede local, na conexão direta pela internet e na reserva pelo Tor. Não existe servidor da pessoa usuária, da Ordinum ou do projeto no caminho.

O QR de pareamento leva a chave pública do computador e é de uso único: gira a cada 90 segundos e expira em 10 minutos. Cada celular tem a própria chave e o próprio token, revogáveis um a um, e a revogação derruba as sessões do aparelho nos dois caminhos.

O aplicativo móvel cria uma conexão de loopback no celular para mostrar a interface do computador. Essa conexão local não sai do aparelho. A câmera serve apenas para ler o código de pareamento e nada é armazenado dela. A biometria é verificada pelo sistema operacional e o Cialai não recebe os dados biométricos usados nessa verificação.

## Redes públicas e serviços de terceiros

Para que os aparelhos se encontrem, o Cialai usa redes públicas, e cada uma vê só o que está descrito a seguir:

- **Rede Tor.** O computador publica um serviço onion embutido, que serve de ponto de encontro e de conexão de reserva. Os relés do Tor transportam só tráfego cifrado. Como esse serviço onion é de salto único para ganhar latência, os relés de introdução e de encontro podem ver o endereço IP do computador, nunca o conteúdo.
- **Servidores STUN públicos da Cloudflare e do Google.** São opcionais e servem para descobrir o endereço público do computador. Quando o STUN é usado, esses servidores veem o endereço IP público do computador.
- **DNS-SD na rede local.** O anúncio publica um identificador derivado da chave pública do computador, sem o nome da pessoa.
- **Roteador da pessoa usuária.** Quando o roteador permite, o computador pede o mapeamento de uma porta por UPnP, NAT-PMP ou PCP.

Quando uma pessoa busca manualmente uma atualização no desktop, o aplicativo solicita o manifesto assinado e o pacote pelo GitHub Releases. O GitHub pode processar os metadados normais dessa requisição conforme seus próprios termos de privacidade. A Ordinum não recebe esses metadados por meio do Cialai.

## Compartilhamento e venda

A Ordinum não vende informações pessoais. O Cialai não compartilha conteúdo de projetos ou terminais com a Ordinum nem com parceiros de publicidade. O conteúdo segue somente entre os aparelhos pareados pela pessoa usuária, cifrado de ponta a ponta, inclusive quando atravessa as redes públicas descritas acima.

## Retenção e exclusão

Preferências locais, histórico de sessões, identidades e computadores pareados permanecem no aparelho até serem removidos pela pessoa ou até a desinstalação do aplicativo. A pessoa pode revogar um aparelho pareado pelo computador e esquecer um computador pelo aplicativo móvel. Como nenhum servidor da Ordinum ou do projeto participa da conexão, não há dados de conexão a excluir junto à Ordinum. Para apagar o que o aplicativo guarda, remova o aplicativo ou os seus diretórios de dados.

## Permissões

O aplicativo móvel pode solicitar acesso à câmera, à rede local e à biometria. A câmera lê códigos de pareamento. A rede local encontra o computador pareado antes de o celular usar a conexão pela internet. A biometria protege ações sensíveis do terminal. Negar uma permissão limita o recurso relacionado.

## Crianças

O Cialai é uma ferramenta para desenvolvimento e não é direcionado a crianças.

## Alterações

Mudanças relevantes nesta política serão publicadas com uma nova data de vigência. As respostas de privacidade das lojas serão revistas sempre que o comportamento do aplicativo ou o código de terceiros incluído mudar.

## Contato

Contato de privacidade: **A CONFIRMAR ANTES DA PUBLICAÇÃO**

Até a confirmação do contato dedicado, use o canal privado descrito no arquivo `SECURITY.md` do repositório.
