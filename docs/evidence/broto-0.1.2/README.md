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

A [release broto-v0.1.2](https://github.com/OrdinumTeam/cialai-platform/releases/tag/broto-v0.1.2) foi publicada a partir do commit `f78133b8aff5ca785ec2923067e16498946615df`. O [workflow 40989233901](https://github.com/OrdinumTeam/cialai-platform/actions/runs/40989233901) aprovou testes nativos, builds Linux e Windows e publicação.

Os três instaladores, NSIS, DEB e RPM, foram extraídos. A assinatura e os hashes do serviço embutido foram conferidos com a chave pública Broto independente. Todos contêm `broto-v0.1.2`, com o mesmo executável do payload do atualizador correspondente. Os dois arquivos de atualização e os três instaladores passaram na verificação dos atestados GitHub.

O espelho [downloads/broto](https://cialai.com.br/downloads/broto/latest.json) recebeu os arquivos assinados, com invalidação do CDN concluída. Os cinco downloads públicos foram lidos integralmente e comparados aos hashes e tamanhos do manifesto assinado. O manifesto público do desktop permaneceu idêntico ao baseline 0.5.1.

## Executável em conexão real

Um executável Broto nativo macOS, compilado do mesmo commit da release, foi exercitado em processo separado com um hospedeiro de teste. O pareamento usou identidades efêmeras e conexão QUIC com TLS mútuo. Envio e recebimento de 1520000 bytes no SSD externo passaram com SHA256 `724ba854aeb3d59246af3d7ef58e230ed0fbbac3fb8570bd2743dfc5d3a042a7`. Listagem, link simbólico, consulta de arquivo do sistema e desconexão também passaram.

O estado e as credenciais efêmeras do ensaio foram removidos. Nenhum serviço instalado ou aplicativo do usuário foi reiniciado. Essa prova valida o executável e a transferência pelo transporte real; a distribuição pública desta versão continua restrita a Windows e Linux. Uma atualização aplicada em um Broto já instalado depende da execução do atualizador naquela máquina.
