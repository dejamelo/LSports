# LSports #217525 — ordem confirmada e atualização somente do worker

Confirmação escrita de Michal Szczepański: distribuição OFF recusa conexão e registro
AMQP com ACCESS_REFUSED 403. Pacotes: PreMatch 4511 e InPlay 4510.

Sequência implementada: status → Start se OFF → **uma espera de 2000 ms** →
status (`Body.IsDistributionOn` e valor convertido pelo SDK) → conexão →
registro exclusivo do consumidor → snapshot. O cliente HTTP de baixo nível do
SDK 3.10.10 não espera; `DistributionUtil.start` espera. O adaptador usa o primeiro
e mantém a espera em um único lugar. Não há outra espera na sessão.

O consumidor permanece processando durante recuperação. Persistência precede ACK;
a reconciliação preserva a ordem das atualizações. O PreMatch continua usando
`/Prematch/GetEvents` sem filtro, spool em disco e duas passagens com limites
explícitos, sem inventário histórico obrigatório de `/Fixtures/Get`. Nenhum teto,
intervalo, timeout, assinatura ou fila é ampliado/alterado por esta atualização.

## Execução

Executar no Mac com o worker local parado. O entrypoint aceita
`--pid 12811 --parent 12809 --supplier-order-repair`: os IDs identificam o registro
protegido **já concluído**, não são alvos de sinais. A execução usa o Git ref explícito
`ADL_RUNTIME_REF` e o repositório `ADL_REPO_ROOT`, permitindo um executor temporário
sem tocar nas alterações locais do painel.

A atualização verifica o hash dos 13 arquivos de runtime contra a imagem anterior
conhecida (3425f72), deriva a imagem offline, testa ordem/propagação/spool, preserva
os overrides e exige auditoria fresca de ausência de consumidor no Mac. Antes do
SIGTERM chama Distribution/Stop nos dois pacotes. Após saída normal e liberação
pelo dono, copia checkpoint e journals com SHA-256. Acrescenta somente um override
de imagem do worker; API, banco, credenciais e POSNET permanecem intactos. Os
journals de cooldown continuam válidos. Migração/importação não são repetidas.

Reexecutar o mesmo comando reutiliza imagem e partida já registradas; não reinicia
às cegas. Resultado e backup ficam no ledger protegido da migração e no recibo
`/etc/adl-homologation/partitioned-upgrade-*.json` na AWS (o caminho exato é
emitido pelo executor).

## Critérios da validação real

Ambas as lanes precisam comprovar distribuição ON após propagação, registro do
consumidor na sessão atual, mensagens persistidas/ACK, snapshot atual concluído e
atualização de mercado atual. PreMatch também comprova ACK durante recuperação.
Há registro sanitizado de `Body.IsDistributionOn`, horários UTC e novos AMQP 320.
Odds selecionáveis são exigidas para declarar disponibilidade. Mercados fechados,
feed parado, somente keepalive ou container running não satisfazem os critérios.
Ausência de mensagens/mercados abertos pode deixar a validação pendente; isso não
é automaticamente classificado como falha do fornecedor. A sessão autenticada do
iframe exige validação no navegador, separada dos critérios de feed.

## Rollback preparado

No mesmo executor/ref, substituir o modo por `--supplier-order-rollback`. Exige
novamente identidade da imagem e ausência do consumidor Mac, chama Stop, aguarda
saída normal, acrescenta override somente da imagem anterior e cria o container
**parado**. Não restaura dados antigos nem perde cooldowns/overrides. A imagem
anterior possui a ordem defeituosa, portanto não deve ser iniciada automaticamente.
Falha de Stop ou saída pendente bloqueia a reversão sem remover locks ou forçar.
O backup privado contém modelo anterior, metadados e `rollback.worker.private.json`;
não publicar esses arquivos. Não usar `down -v`, purga de fila ou restart do Mac.

## Evidência local versus AWS

Testes locais verificam ordem nas duas lanes, uma propagação real de 2000 ms contra
servidor HTTP isolado, consumo/persistência/ACK concorrente com snapshot, spool
acima de 256 MiB e reversão sem tocar API/journals. Nenhuma chamada LSports real é
usada nos testes. O resultado AWS só é conhecido após execução e fica no ledger;
este documento não declara recuperação real.
