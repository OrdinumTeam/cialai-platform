# Headscale para o Cialai

Receita para colocar no ar, em cerca de 10 minutos, o servidor de coordenação que liga o celular ao computador. O tráfego dos terminais nunca passa pelo Headscale: ele só apresenta os aparelhos e, quando não há caminho direto, repassa pacotes já cifrados pelo relé DERP embutido.

A especificação completa está em [docs/arquitetura/06-rede-e-pareamento.md](../../docs/arquitetura/06-rede-e-pareamento.md).

## Requisitos

| Item | Valor |
| --- | --- |
| Servidor | Linux com IP público e Docker Compose v2 |
| DNS | Registro A do domínio escolhido apontando para o IPv4 do servidor |
| Portas abertas | `443/tcp` para clientes e relé, `80/tcp` para o certificado Let's Encrypt, `3478/udp` para STUN |
| Porta interna | `9090/tcp` de métricas, nunca exposta |
| Imagem | `headscale/headscale:0.29.3`, fixada por digest no `docker-compose.yml` |

## Guia de 10 minutos

1. Crie o registro A do domínio, por exemplo `hs.exemplo.com`, e espere ele resolver para o IPv4 do servidor.
2. Libere `443/tcp`, `80/tcp` e `3478/udp` no firewall do servidor e do provedor.
3. Copie esta pasta para o servidor e entre nela.
4. Gere a configuração e suba o serviço:

   ```sh
   ./bootstrap.sh --domain hs.exemplo.com --ipv4 203.0.113.10
   ```

   O script valida os valores, gera `config/config.yaml` a partir do modelo, confere a configuração com `headscale configtest`, sobe o contêiner e espera o certificado.

5. Crie a chave da API:

   ```sh
   docker compose exec headscale headscale apikeys create --expiration 365d
   ```

6. No Cialai do computador, abra Preferências, seção Rede, informe `https://hs.exemplo.com` e cole a chave. O assistente confere o servidor, cria ou escolhe o usuário e conecta o computador.

Os usuários são criados pelo assistente pela API. Crie um usuário por pessoa; os celulares dessa pessoa só alcançam os computadores dela na porta 4740.

## Arquivos

| Arquivo | Papel |
| --- | --- |
| `docker-compose.yml` | Serviço `headscale`, portas, volume de dados, socket em memória e verificação de saúde pelo próprio binário |
| `config/config.yaml.template` | Modelo do documento 06 com os marcadores de domínio e IPv4 |
| `config/config.yaml` | Gerado pelo `bootstrap.sh` e ignorado pelo Git |
| `config/policy.json` | Política com `autogroup:self` na porta 4740 e sem tags |
| `bootstrap.sh` | Geração, validação, subida e espera do certificado |

## Diagnóstico

| Verificação | Comando | Esperado |
| --- | --- | --- |
| DNS | `dig +short A hs.exemplo.com` | O IPv4 do servidor |
| Porta 443 e saúde | `curl -fsS https://hs.exemplo.com/health` | Resposta de sucesso |
| Certificado | `openssl s_client -connect hs.exemplo.com:443 -servername hs.exemplo.com </dev/null \| openssl x509 -noout -issuer -dates` | Emissor Let's Encrypt e datas válidas |
| Versão | `docker compose exec headscale headscale version` | `v0.29.3` |
| Saúde interna | `docker compose ps` | Estado `healthy` |
| STUN | `docker compose logs headscale \| grep -i stun` | Servidor STUN ouvindo em `:3478` |
| Registros | `docker compose logs --tail 200 headscale` | Sem erros de certificado ou de política |

O teste de UDP a partir de fora depende da rede de quem testa. Se o celular só conectar pelo relé, confira a regra de `3478/udp` no provedor.

Quando o certificado não sai, os motivos mais comuns são DNS ainda não propagado, porta 80 fechada ou outro serviço ocupando as portas 80 e 443.

## Atualização com backup

1. Pare o serviço e copie o volume de dados, que guarda o SQLite, as chaves do servidor e o cache do certificado:

   ```sh
   docker compose stop headscale
   mkdir -p backup
   docker run --rm -v cialai-headscale_headscale-data:/data:ro -v "$PWD/backup":/backup alpine \
     tar czf "/backup/headscale-$(date +%Y%m%d-%H%M).tgz" -C /data .
   ```

2. Leia as notas da nova versão do Headscale e só avance se o Cialai já tiver sido validado com ela.
3. Troque a tag e o digest da imagem no `docker-compose.yml`, depois rode `docker compose pull` e `docker compose up --detach`.
4. Confirme `docker compose ps` como `healthy` e abra a tela Dispositivos do Cialai.
5. Para voltar, restaure o arquivo do backup no volume com o serviço parado e retorne a imagem anterior.

## Segurança

A chave da API controla o servidor inteiro. Ela fica somente no chaveiro do computador que roda o Cialai, nunca neste servidor nem em repositórios.

A política fica em modo arquivo, então quem tem a chave da API não consegue reescrevê-la pela API. Mudanças na política exigem editar `config/policy.json` e reiniciar o serviço.

O relé DERP embutido é o único relé configurado. Se o servidor cair, conexões diretas já estabelecidas podem continuar, mas conexões novas e caminhos que dependem do relé param.
