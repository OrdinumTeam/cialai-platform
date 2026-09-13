# Política de Privacidade do Cialai

Data de vigência: 13 de setembro de 2026

Estado de publicação: preparada para publicação antes da primeira versão pública

O Cialai é um estúdio de terminais de código aberto fornecido por ORDINUM INOVACAO E TECNOLOGIA LTDA. Esta política explica como os aplicativos Cialai para computador e celular tratam informações.

## Resumo

O Cialai não oferece conta da Ordinum, publicidade, análise de uso nem serviço de aplicativo hospedado. A Ordinum não coleta conteúdo de projetos, entrada de terminal, saída de terminal, códigos de pareamento, tokens de dispositivo ou dados biométricos por meio do Cialai.

O Cialai conecta aparelhos por um servidor Headscale escolhido e operado pela pessoa usuária ou por sua organização. A operação desse servidor é responsável pela infraestrutura e pelos registros administrativos.

## Informações processadas nos seus aparelhos

O Cialai processa as informações abaixo somente para oferecer seus recursos:

- Pastas e arquivos de projetos escolhidos no computador
- Entrada, saída, histórico de sessões e informações de processos do terminal
- Estado do Git e prévias locais
- Nomes e identificadores técnicos dos computadores e celulares pareados
- Estado da conexão, endereços de rede e registros de diagnóstico
- Configuração e credenciais do Headscale fornecidas pela pessoa usuária

Essas informações são armazenadas localmente quando necessário. As chaves da API do Headscale usam o cofre de credenciais do sistema no computador. Os tokens de dispositivo usam o armazenamento seguro do celular. No computador, os tokens de dispositivo são guardados somente como hashes. Os segredos de pareamento têm duração curta e não são mantidos depois do uso.

## Conexão entre aparelhos

O conteúdo do terminal e os arquivos de projeto transitam entre os aparelhos somente quando a pessoa abre uma sessão pareada. O tráfego entre os aparelhos pareados é cifrado de ponta a ponta. O Headscale coordena a descoberta dos aparelhos, mas não lê esse conteúdo cifrado. Um relé pode encaminhar pacotes cifrados quando não houver caminho direto.

O aplicativo móvel cria uma conexão de loopback no celular para mostrar a interface do computador. Essa conexão local não sai do aparelho. A câmera serve apenas para ler o código de pareamento. A biometria é verificada pelo sistema operacional e o Cialai não recebe os dados biométricos usados nessa verificação.

## Serviços escolhidos pela pessoa usuária

A pessoa informa o endereço do servidor Headscale e responde pelas práticas de privacidade de quem opera esse servidor. Um servidor próprio pode manter registros administrativos como horário da conexão, nome do aparelho e endereço de rede, conforme sua configuração.

Quando uma pessoa busca manualmente uma atualização no desktop, o aplicativo solicita o manifesto assinado e o pacote pelo GitHub Releases. O GitHub pode processar os metadados normais dessa requisição conforme seus próprios termos de privacidade. A Ordinum não recebe esses metadados por meio do Cialai.

## Compartilhamento e venda

A Ordinum não vende informações pessoais. O Cialai não compartilha conteúdo de projetos ou terminais com a Ordinum nem com parceiros de publicidade. Os dados seguem somente para aparelhos e infraestrutura escolhidos pela pessoa usuária para realizar a conexão solicitada.

## Retenção e exclusão

Preferências locais, histórico de sessões e perfis de conexão permanecem no aparelho até serem removidos pela pessoa ou até a desinstalação do aplicativo. A pessoa pode revogar um aparelho pareado pelo computador e esquecer um perfil pelo aplicativo móvel. A operação do Headscale controla a retenção e a exclusão no próprio servidor.

## Permissões

O aplicativo móvel pode solicitar acesso à câmera, à rede local e à biometria. A câmera lê códigos de pareamento. A rede local encontra o computador pareado. A biometria protege ações sensíveis do terminal. Negar uma permissão limita o recurso relacionado.

## Crianças

O Cialai é uma ferramenta para desenvolvimento e não é direcionado a crianças.

## Alterações

Mudanças relevantes nesta política serão publicadas com uma nova data de vigência. As respostas de privacidade das lojas serão revistas sempre que o comportamento do aplicativo ou o código de terceiros incluído mudar.

## Contato

Contato de privacidade: **A CONFIRMAR ANTES DA PUBLICAÇÃO**

Até a confirmação do contato dedicado, use o canal privado descrito no arquivo `SECURITY.md` do repositório.
