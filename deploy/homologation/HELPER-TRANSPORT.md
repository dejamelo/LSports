# b63e735: remote_consumer_gate sem JSON

Causa reproduzida sem acessar AWS: o bundle tinha 114865 bytes e era escapado como
um único argumento `sudo -n python3 -c '<source>'`, com 131137 bytes. O sshd Linux
executa o shell com esse comando como argumento de `-c`. Isso excede o limite de
131072 bytes por argumento (incluindo terminador). A reprodução Linux com a mesma
string, executando somente `/bin/true`, retornou E2BIG antes de iniciar o processo.
O bundle compila corretamente; portanto não era erro de sintaxe do parser de mercados.
O código antigo descartava o stderr e mostrava HELPER_EXIT_NONZERO_SEE_STAGE.
Não se conhece o código numérico que o SSH devolveu no Mac naquela tentativa.

## Correção

O comando remoto agora tem cerca de 2 KiB: bootstrap Python fixo. Código e request
são enviados num envelope JSON pela entrada padrão do SSH. O bootstrap limita a
entrada a 8 MiB e o código a 512 KiB, compila com nome sintético e entrega o pedido
num TextIOWrapper/BytesIO, preservando `sys.stdin.buffer` do executor existente.
Não grava código ou credenciais em arquivo remoto. Não usa shell sem verificação
de host, transporte alternativo ou mudança de permissões. As ações e suas
proteções permanecem as mesmas.

Falhas informam stage, action, exitCode, signal, presença de stderr e diagnóstico
de uma lista controlada. Bootstrap também informa compile/execute/envelope e tipo
de exceção; erros de compilação podem informar linha/coluna, nunca fonte/traceback.
Falhas internas do helper e seções do preflight incluem tipo de exceção, errno e
código de subprocesso quando disponíveis. Não imprime stderr, argumentos,
headers, senhas, payloads ou configuração privada.

## Coleta somente leitura

Entry point existente: `--pid 12811 --parent 12809 --helper-preflight-report`.
Esses argumentos mantêm o encaminhamento explícito do CLI; não sinalizam PIDs.
O modo entra ANTES do lease, criação/leitura/gravação do ledger, auditorias ou
ramificações de mutação. Executa exclusivamente `preflight` na AWS. Não consulta
LSports, não inicia/para/recria containers, não importa journals e não altera locks,
overrides, volumes, painel ou POSNET. A saída registra os tamanhos do código e do
comando, resultado do preflight ou diagnóstico sanitizado com código de saída.

A correção de Markets:null permanece preparada. Este comando não a aplica nem
reinicia o worker. A aplicação posterior usa o mesmo transporte corrigido e
`--nullable-markets-repair`, reutilizando as etapas concluídas e o backup capturado.

## Testes executados

43 testes locais passaram: reprodução real de E2BIG no limite anterior, stdin com
código de 150 KiB, compatibilidade do leitor binário de request, compilação do bundle
completo, falhas antes do primeiro JSON, saída de subprocesso real, supressão de
segredos e invocação completa de preflight com SSH substituído em ambiente isolado.
Esse teste confirmou que o modo somente leitura não cria o ledger. Regressões de
CLI, validação de feeds, status, backup e rollback passaram. Não houve SSH real,
consulta ao fornecedor, mudança de worker nem validação de snapshot AWS aqui.
