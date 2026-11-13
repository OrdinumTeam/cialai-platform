# Monitor Broto

A interface compartilhada vive em `packages/ui/src/broto`. O desenho e o estado
da entrega estão em [Interface](../../docs/broto/05-interface.md) e
[Empacotamento](../../docs/broto/07-empacotamento.md).

`npm run dev --workspace @cialai/broto` abre o monitor em desenvolvimento.
O controle exige o daemon do mesmo usuário, por socket protegido ou named pipe.
O botão de instalação usa somente o payload assinado empacotado e a chave
pública fixada em compilação. O workflow de distribuição encena esse payload
antes de aplicar `src-tauri/tauri.service.conf.json`. Um build de desenvolvimento
sem payload e sem chave não instala serviço.

## Teste nativo isolado

Compile o daemon Go e o monitor para a plataforma local, com target Rust no
SSD. O monitor de teste precisa das features `custom-protocol,selftest` e dos
assets produzidos por `npm run build:ui --workspace @cialai/broto`.

Defina `CIALAI_BROTO_SELFTEST_DAEMON` e `CIALAI_BROTO_SELFTEST_MONITOR` com os
binários locais. Opcionalmente, `CIALAI_BROTO_SELFTEST_OUTPUT` escolhe a pasta
que recebe o perfil temporário e a evidência. Execute
`npm run test:native --workspace @cialai/broto`.

O teste abre uma janela nativa com assets reais, usa IPC real contra um daemon
isolado, verifica o formulário e confirma que fechar a janela mantém o daemon
vivo. Depois encerra seus processos. Não instala serviço, não pareia com um
hospedeiro e não usa dados do perfil existente. A feature de teste não faz
parte do build normal de distribuição.

`npm run test:native:connected --workspace @cialai/broto` amplia a prova local
no macOS. Ele usa `TestBrotoExternalPeer` da borda Go, inicia daemon e janela
reais, transfere o código somente por arquivo privado, confere os quatro dígitos
e aprova pelo controle do laboratório. Abre um PTY real, verifica atividade,
pausa com recusa de nova mutação, retoma com saída do terminal e desconecta
com revogação observada pelo hospedeiro. O diretório temporário usa `/tmp`
para respeitar o limite de tamanho dos sockets Unix.

Essa prova usa a borda e o hub reais, com identidades efêmeras. Ela não usa o
sidecar completo do desktop, não acessa o hospedeiro de produção e não prova
o caminho de reserva por Tor. O perfil, os controles do laboratório e a saída
do terminal permanecem privados; o resumo impresso contém somente resultados.
