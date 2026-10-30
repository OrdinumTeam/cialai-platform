# Arquivos no Broto 0.1.2

## Estado local

O executor atende envio, recebimento e listagem nos caminhos acessíveis à conta de execução. Caminhos absolutos, relativos à pasta pessoal, volumes montados e links simbólicos usam as permissões do sistema. O recebimento mantém arquivo parcial, lock por destino, SHA256 e publicação após a conferência final.

## Validação executada

Em 29/10/2026, no macOS, com temporários e cache Go no SSD externo:

| Verificação | Resultado |
| --- | --- |
| `go test -mod=readonly -race -count=1 ./internal/brotoexec ./internal/brotoclient ./internal/brotocli ./internal/brotorpc ./internal/brotohostipc ./internal/brotomcp` | Seis pacotes aprovados |
| `go vet ./internal/brotoexec ./internal/brotoclient ./internal/brotocli` | Aprovado |
| `node --test tools/broto/*.test.mjs` | 17 testes aprovados |
| `TestLargeFileRoundTrip` com `CIALAI_BROTO_LARGE_FILE_TEST=1` | Envio e recebimento de 104857600 bytes aprovados, SHA256 igual nos dois sentidos |
| Documentação viva, documentação pública, matriz CI e `git diff --check` | Aprovados |

SHA256 do arquivo de 100 MiB: `122921bf96749ccbe330a032072c597559a5840f7a6c9471ca1417f337b73ccc`.

As regressões verificam acesso fora da pasta pessoal no volume externo, caminho relativo, listagem da raiz do volume, leitura de um arquivo do sistema, link de pasta, link de arquivo, sobrescrita explícita e erro real de permissão em leitura e escrita. A política existente continua carregando suas opções de capacidade e tamanho. Nenhum serviço instalado foi alterado durante os testes.

## Distribuição

Compilação e execução nativas de Windows e Linux, assinaturas, instaladores publicados e espelho do site têm validação própria na release `broto-v0.1.2`. O estado local acima não substitui essa execução nem comprova uma atualização aplicada em um Broto instalado.
