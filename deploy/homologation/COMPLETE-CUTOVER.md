# Corte Mac → AWS: consolidação e execução única

## Evidência já aceita; não repetir preparo/publicação/redimensionamento

- EC2 m7i.xlarge concluída; POSNET retornou e foi validado.
- API ADL saudável, HTTPS/aplicação confirmados e credenciais do fornecedor
  armazenadas em arquivo protegido. Preservar os composeOverrides salvos.
- Nenhum worker AWS iniciado. Mac tem o dono do lock PID 12811 e pai 12809;
  ambos suspensos conforme verificações anteriores. Journals/checkpoint legíveis
  e estáveis, não migrar bilhetes nem a plataforma Argentina Demo do Mac.
- SIGTERM anterior enviado sem conclusão. Campo macOS ps pending/sig foi retirado
  como gate por usar p_siglist legado; não inferir ausência de sinal/handler.
- A retomada não enviou sinais: bloqueou no tipo do pai, antes do backup/intent.

## Coleta consolidada concluída

O relatório recebido identificou o pai 12809 como concurrently suspenso, com UID e
cwd corretos; faltava somente o marcador de CLI TSX exigido pelo gate anterior.
O procedimento atual está na seção “Um único comando de execução no Mac”. Não é
necessário executar novamente o diagnóstico manual; o executor faz a revalidação
somente leitura antes de agir. O restante desta seção descreve a coleta já feita.

O relatório único contém:

- Mac: auditoria completa de processos/locks/journals/checkpoint/cooldown, cadeia
  de até quatro processos com PID/PPID/UID compatível/cwd classificado/estado T,
  grupos de job control, filhos/siblings por tipo, assinatura do launcher e **cada
  verificação que falhou** no gate atual. Distingue shell, CLI tsx, node --import,
  workspace relativo, watch, concurrently, outros targets web/API e expressões
  compostas. Argumentos são um esboço aproximado com valores/caminhos desconhecidos
  redigidos; isso é evidência para o plano, não autorização para retomar shell.
- Mac: estabilidade em cinco segundos, margem de disco para backup privado,
  origem configurada do state e prazos preliminares. Sem cópia de .env ou payloads.
- AWS: API saudável e worker parado, todos os overrides legíveis, imagem/usuário
  resolvidos, gates atuais, volumes isolados/UID/GID e existência de locks/journals,
  credenciais presentes com permissões, memória física disponível, disco e limites
  PM/IP configurados. GET local de status informa se há admin inicializado e modo
  financeiro simulado; não usa credenciais administrativas nem imprime segredo.
- Seção remota falha sem ocultar as demais independentes. Falha dependente informa
  a etapa, nunca texto bruto de Docker/modelo secreto. Não repetir DNS/TLS já
  confirmados nem iniciar diagnose:trade em paralelo ao consumidor.

status=collected significa que a coleta terminou, **não** liberação do corte.
readyToStartAWS permanece false. A saída identifica toda a informação necessária
para finalizar uma execução única; se houver campo unverified, sua etapa/reason
fica no mesmo documento, não como uma nova tentativa de sinal.

## Contrato do executor final, após identificação do pai

O comando de execução final deverá seguir os pontos abaixo sem pedir novamente
aprovação financeira/manutenção, e sem parar em cada etapa para um novo comando.
O executor está implementado em `complete-adl-cutover.mjs`. Os testes locais e
os testes remotos com Docker simulado estão descritos abaixo. Sua execução real
no Mac/AWS ainda precisa ser confirmada pela saída; não há acesso à chave do Mac
neste workspace.

1. **Preflight único**: revalidar identidade PID/início/UID/cwd e relação pai-filho,
   confirmar único consumidor Mac e worker AWS parado. Decidir retomada apenas
   para launcher dedicado demonstrado, nunca shell/supervisor genérico presumido.
2. **Backup e parada**: backup 700/600 fora do Git do checkpoint/journals/lock,
   SHA-256 fonte/cópia/manifesto e espaço suficiente; retomar identidades verificadas,
   TERM dirigido somente após retomada/revalidação se necessário; nenhum KILL.
   Aguardar persistência, saída, locks liberados e estabilidade; falha real bloqueia
   sem repetir sinais ou excluir locks. Intenções preservadas impedem repetição.
3. **Exportar**: auditoria fresca sem processos/locks; gerar handoff só dos journals
   e notBeforeUTC máximo de prazos compartilhados/por operação, Retry-After e
   intervalo após shutdown + margem. Não transferir checkpoint, DB ou bilhetes Mac.
4. **Importar/coordenar**: SSH para volume ADL confirmado, com backup e manifesto;
   conferir hashes, preservar prazos AWS já existentes (nunca encurtar por importação),
   criar apenas arquivos de scheduler com UID do worker, sem chown do volume inteiro.
   Não tocar assinaturas/filas. Importação parcial bloqueia partida e informa etapa.
5. **Esperar e partir**: aguardar prazo efetivo exibindo progresso. Só então afirmar
   gates de capacidade/Mac parado/notBefore via configuração específica do worker,
   preservando TODOS os overlays. Comparar modelo: nenhuma mudança incidental.
   Compose up de somente worker com --no-deps/--no-build/--pull never e profile
   feed-consumer. Consume exclusive/noAck=false e persistência antes do ACK intactos.
6. **Validar**: processo isolado, PM4511/IP4510, snapshots desta execução concluídos,
   handoff completo, regularSnapshotReady=true, atualizações efetivas de mercado
   distintas de keepalive. Confirmar candidatos abertos com preço atual pela API.
   Não forçar available, reaproveitar odds antigas, inventar dados ou repetir HTTP
   antes do retryAt. Emitir relatório único de sucesso ou falha local/fornecedor.
7. **Iframe e retorno**: acessar operação/sessão autenticadas da homologação separada.
   Em falha, manter AWS e Mac sem consumo simultâneo. Qualquer volta ao Mac exige
   primeiro parar AWS e importar seus prazos de volta. POSNET nunca é alvo do fluxo.

## O que ainda falta para dados reais e iframe na AWS

- Launcher identificado e política corrigida; executar parada/exportação/importação.
- Respeitar cooldown e iniciar um só consumidor por feed com limites PM256/IP128,
  container4GiB/heap3072, sem remover admissão de memória.
- Validar **realmente** credenciais HTTP/AMQP, distribuição e snapshots sob a nova
  memória. Credenciais gravadas e HTTPS funcionando ainda não comprovam isso.
- Receber eventos/mercados abertos atuais do pacote Test. Se só houver encerrados,
  resumir razões locais e IDs para LSports; não reabrir nem inventar odds.
- Confirmar bootstrap/admin na AWS e configurar seu próprio cliente/operação,
  domínio permitido, credencial backend e sessão iframe temporária. Status local
  do painel só comprova inicialização, não esse caminho autenticado. Manter moeda,
  isolamento, limites, risco e bilhetes/carteira simulados.

O setup do iframe administrativo é independente do consumidor: o feed pode ser
validado tecnicamente antes de uma operação estar pronta para incorporação.
Nenhuma etapa usa dados/tickets do Mac para preencher a homologação AWS.


## Relatório consolidado recebido e solução aplicada

Coleta de 19/10/2026 00:01:56 de Brasília (03:01:56 UTC): dono 12811,
Node com `--import tsx`, estado T; pai 12809 é Node executando **concurrently**,
também T; ancestral npm 12799 também T. Ambos os últimos são supervisores,
não dois consumidores. A validação TSX falhava por exigir `tsx/dist/cli` no pai.
O campo de sinais pendentes do macOS não é usado como autoridade.

**Somente o dono recebe SIGCONT** quando o pai observado é concurrently. O pai
compartilhado e o npm permanecem suspensos: nenhum sinal de grupo, TERM no pai ou
retomada dos outros comandos. Um launcher TSX dedicado continua com o fluxo
anterior. Identidade, início, UID, cwd, relação pai-filho e lease são revalidados.
Depois do backup SHA-256, uma intenção durável impede repetir sinais. Se o dono
continuar executável após a graça, no máximo um TERM dirigido é permitido.

Com pai suspenso, o filho pode sair e ficar Z até o pai coletar seu status. Z é
processo encerrado, sem execução nem descritores; NÃO é T. O coletor não o conta
como consumidor, mas exige liberação normal de TODOS os locks e journals estáveis.
Um concurrently T não é contado pelo texto do comando do filho; se estiver em
execução ele volta a bloquear a exportação. **Não execute fg, não retome o npm
antigo e não execute npm run dev após o corte.** Nenhum lock é removido manualmente.

AWS: API saudável/200, credenciais presentes em 600/700, dois overlays legíveis,
nenhum worker/checkpoint/journal/lock no volume isolado, aproximadamente 14,1 GiB
MemAvailable e 24 GiB livres. Plataforma ainda `initialized=false`: o bootstrap,
cliente/operação e sessão temporária de iframe são uma etapa administrativa
separada, não preenchida com bilhetes ou dados do Mac.

## Um único comando de execução no Mac

```bash
cd "$HOME/LSports" &&
git pull --ff-only origin feat/sportsbook-demo &&
node deploy/homologation/complete-adl-cutover.mjs --pid 12811
```

O PID é explícito, mas nunca confiado isoladamente. Se mudou ou houve reutilização,
o executor bloqueia por identidade. Não repita este comando após falha real sem
ler a etapa: intenções, backups e importações parciais são preservados.

O comando revalida as condições essenciais (sem repetir manutenção POSNET), faz
backup/parada/exportação, importa somente journals por SSH e mostra `notBeforeUTC`.
Espera automaticamente o maior prazo local/remoto, reaudita ausência do consumidor
Mac imediatamente antes da partida e inicia apenas `worker` com os overlays salvos.
A partida é exclusive por fila e sem ACK antecipado, build, pull ou recriação da API.
Não há chamadas HTTP paralelas de diagnose ao fornecedor. O próprio scheduler
continua responsável pelos limites e retryAt.

A importação faz backup dos journals AWS existentes, verifica leitura após gravação,
usa UID/GID do volume e arquivos 600, fsync e rename; não encurta prazos existentes.
Há recibo por hash do handoff e backup da configuração. Um overlay adicional muda
somente os três gates operacionais do worker; o modelo completo precisa ser
idêntico fora desses campos. Nenhuma alteração de Caddy, POSNET, assinaturas ou
bilhetes. Falha após importação informa backup e arquivos já gravados; não desfaz
coordenadores nem liga o Mac automaticamente.

A observação por até 15 minutos lê o checkpoint com orçamento de memória e informa
sessões, snapshots, handoff, diagnósticos, últimas atualizações efetivas/controle e
contagens de eventos/preços/seleções. Só retorna `snapshots_verified` com uma única
instância AWS ativa, publicação recente e snapshots completos de ambas as sessões
iniciadas nesta partida. Keepalive não prova atualização de mercado. Zero seleções
não é convertido em sucesso de odds. `validation_pending` conserva o worker e seus
prazos; não é instrução para reiniciar nem repetir consultas.

O relatório distingue `projectionOddsAvailable`, `authenticatedApiVerified=false`
e `iframeAuthenticated=false`. Receber odds no checkpoint não comprova ainda a
sessão de incorporação autenticada. Depois do feed, falta criar o administrador
AWS e configurar sua operação/sessão no painel exclusivo. Nenhuma senha é pedida
no chat e nenhum segredo LSports vai ao navegador.

## Testes desta correção

- 42 testes Node de identidade/parada, recuperação, processo OS suspenso, zumbi,
  exportação e cooldown: passaram. Incluem supervisor realmente suspenso que só
  é retomado no cleanup do próprio fixture isolado, após verificar filho encerrado.
- 4 testes Python: merge por máximos, rejeição de journals inválidos e fluxo
  importação/recusa por cooldown/partida somente do worker com overlays preservados; rejeição de snapshots de sessões antigas.
  Docker/SSH são simulados nesses testes; não comprovam conexão real LSports.
- Typecheck dirigido dos módulos de parada e sintaxe do executor verificados.

A confirmação final dos feeds reais depende da execução no Mac. Se fornecedor
recusar autenticação/distribuição, enviar 429 ou apenas eventos encerrados, os
códigos e retryAt ficam visíveis; nenhuma proteção é removida para apresentar odds.

## Atualização: timeout após CONT e TERM no Mac

O usuário confirmou backup verificado, CONT e TERM dirigidos ao dono 12811 e
`RESUME_TIMEOUT_NO_MORE_SIGNALS`. Nenhuma exportação/importação/partida AWS foi
concluída. Preservar a intenção e o backup já criados; **não repetir o executor
completo nem apagar as intenções para permitir novos sinais**.

A versão anterior não inspecionava estado T depois do TERM. O timeout sozinho
não distingue nova suspensão por controle de terminal, espera de stdout/socket
com concurrently suspenso, ou outra espera do encerramento carregado. Grupos de
terminal diferentes não provam SIGTTIN/SIGTTOU. O código carregado continua
unknown; git pull não o atualiza dentro do processo existente.

O diagnóstico existente foi ampliado, sem novo script de recuperação. Comando:

```bash
cd "$HOME/LSports" &&
git pull --ff-only origin feat/sportsbook-demo &&
node deploy/homologation/diagnose-adl-shutdown.mjs
```

Coleta independente do estado antes/depois, owner/parent/npm, PGID/TPGID, classe de
espera (sem texto bruto), terminal stdin e tostop consultado somente leitura,
TCP/descritores, backup/manifesto e intenções já criados vinculados à identidade
PID/início/UID/argv. Verifica hashes dos arquivos existentes e compara checkpoint
atual com backup. Não refaz backup, não envia sinais, não altera terminal, não
remove locks nem acessa AWS. Não imprime argumentos, credenciais ou payloads.

`attemptedShutdown.finding` distingue `os_stopped_after_directed_term` de
`owner_alive_after_term`; só levanta hipótese de backpressure se pai suspenso e
saída pipe/socket. `causeProven=false` é deliberado: um ps não identifica a Promise
ou o sinal que causou a parada. `ownerAfter` e estabilidade dos arquivos mostram
se houve progresso durante a janela. Se o lock já tiver sido liberado, tenta a
única identidade de worker ainda encontrada, sem depender do lock para observação.

A recuperação seguinte deve usar esse relatório atual e reutilizar backup/intenção
verificados; não deve contornar `RECOVERY_ALREADY_REQUESTED_NO_REPEAT`. Retomar um
supervisor compartilhado exige verificar seus comandos/restart/filhos e controle
do terminal; não é equivalente a retomar launcher dedicado. O diagnóstico não
executa retomada adicional. O AWS permanece parado até
confirmar fim da execução Mac, liberação dos locks e exportação fresca.

## Recuperação específica: dono S, pai concurrently T, após TERM já enviado

Nova evidência do Mac: PID 12811 S, pai 12809 T, nenhum socket TCP; identidade e
backup existentes verificados. Checkpoint alterado de 03:28:02.322Z para
03:28:07.455Z em 19/10/2026 (00:28 de Brasília), journals estáveis. Não há evidência
de nova suspensão nessa janela. O heartbeat de persistência pode continuar porque
`runConnected` aguarda as sessões antes de limpar o intervalo. Isso não prova que
stdout seja a causa nem identifica a Promise pendente na versão carregada.

O SDK instalado oferece outra causa reproduzível: `ChannelModel.close()` usa uma
promessa do callback CloseOk. Se o transporte emitir `close` sem executar esse
callback, a promessa não termina. O encerramento local aguardava essa promessa
mesmo com a conexão efetivamente fechada. `connection-closer.ts` agora compartilha
um único fechamento e também observa `close`; continua aguardando processamento
+ persistência antes da saída e não introduz timeout, ACK antecipado ou destruição
do transporte. **Git pull não aplica essa correção ao PID antigo nem à imagem AWS
já construída.** Atualizar a imagem do worker é pendência antes da execução AWS.

Para o PID antigo existe agora uma recuperação do supervisor, sem repetir TERM
no worker. Ela não afirma que backpressure esteja comprovado no Mac; é uma ação
limitada para permitir que o supervisor drene stdout/stderr e recolha o filho.

```bash
cd "$HOME/LSports" &&
git pull --ff-only origin feat/sportsbook-demo &&
node deploy/homologation/drain-adl-supervisor.mjs --pid 12811 --parent 12809
```

Antes do único SIGCONT ao pai, verifica:

- Mesmas identidades PID/início/UID/cwd e relação pai-filho; dono não suspenso,
  pai suspenso, lease atual inalterado e único filho vivo sendo o dono conhecido.
- Backup/manifesto/intenções originais íntegros e vinculados ao mesmo dono. Não
  copia novamente o checkpoint, não sobrescreve backup nem apaga intenções.
- Executável Node usando o CLI concurrently do node_modules deste projeto;
  versão 9, defaults instalados anteriores à partida do pai. Defaults explícitos
  restartTries=0, maxProcesses=0 (todos iniciados), handleInput=false e sinal
  padrão, sem opções/variáveis herdadas que alterem reinício, fila, input,
  kill-signal ou escalonamento por kill-timeout. Não imprime o ambiente lido.
- Terminal de saída consultado somente leitura, com tostop desativado; nenhum
  fg/tcsetpgrp, alteração stty, sinal de grupo ou retomada do npm ancestral.

O helper registra intenção própria wx/600 e envia **apenas um CONT ao pai**,
revalidando imediatamente antes. Não envia TERM/KILL ao dono. Se o concurrently
original usa `-k`, ele pode aplicar seu comportamento normal de SIGTERM ao
processar a saída de comandos; não configuramos esse comportamento nem permitimos
kill-timeout/SIGKILL ou reinício. O comando só considera sucesso após saída do dono
E supervisor, liberação normal do lock e estabilidade dos journals. Depois chama
apenas `prepare-adl-cutover.mjs`: exporta e mostra `notBeforeUTC`, sem SSH/start AWS.

Nova suspensão, processo/lease diferente, novo filho, opção de reinício ou timeout
são falhas reais. Não há segundo CONT, repetição de TERM ou exclusão de lock. Se o
pai voltar e o dono continuar S + persistindo após 120s, a dependência do supervisor
não foi suficiente para explicar/liberar o encerramento. O helper conserva tudo e
informa `SUPERVISOR_DRAIN_TIMEOUT_NO_MORE_SIGNALS`. Não transformar isso em permissão
para matar o processo ou contornar o lock. A Promise da versão antiga ainda pode
estar pendente; corrigir arquivos no disco não retoma uma continuação já carregada.

Validação desta etapa: 51 testes direcionados passaram, incluindo SDK amqplib real
com callback CloseOk não executado, stdout represado por concurrently realmente
suspenso e liberação após somente CONT do pai; ACK/persistência/requeue e reinício
com dois bilhetes liquidados preservados. São testes isolados, não confirmação da
parada real do Mac nem conexão validada com LSports.


## Recuperação forçada autorizada e executor retomável — procedimento atual

O usuário autorizou a terminação não cooperativa do worker antigo após proteção
dos dados persistidos. Use [RESUMABLE-CUTOVER.md](RESUMABLE-CUTOVER.md). O comando
único `complete-adl-cutover.mjs --pid 12811 --parent 12809 --recover-and-cutover`
substitui novas tentativas manuais de TERM/CONT/drain e não pede nova aprovação.
Nunca anunciar execução Mac/AWS a partir dos testes isolados.


### Retomada de `local_exit` após divergência de identidade

`PID_REUSED_AFTER_TERMINATION` na versão anterior comparava também `command`:
um argv alterado durante a saída podia receber esse rótulo sem prova de reutilização.
O executor agora lê estado e identidade de nascimento em uma única leitura de `ps`
(LC_ALL=C) e registra `owner_exit_reconciliation`, sem argv ou credenciais.
Compara PID, UID e lstart ao registro protegido; divergência nesses campos bloqueia
sem sinal. Um argv diferente, sozinho, não comprova reutilização. Estado E ainda é
vivo; Z exige coleta pelo pai e confirmação ESRCH antes de tratar o lock.

Retomar o mesmo comando `--recover-and-cutover`: `worker_image` e backup concluídos
são reutilizados. Com `terminationRequested=true`, não há novo HUP/CONT no worker.
Somente o pai idêntico ao registro, suspenso e ainda não retomado por esta tentativa,
pode receber CONT para coletar o filho morto. O executor verifica backup, ausência
OS do PID, ausência de consumidores e validade dos journals antes de arquivar o lock.
Se houver PID vivo com nascimento diferente, ou dados ambíguos, preserva o lock e
informa a causa; não assume que o novo processo seja o worker nem o sinaliza.

Validação de desenvolvimento: testes de E → Z → ausência, argv mutável, nascimento
alterado, reexecução sem sinais repetidos, saída real de processo isolado e preservação
de dois bilhetes SQLite. Fixtures de ps macOS não substituem a execução real no Mac.
Não houve acesso ao Mac/AWS nesta revisão; os feeds só estarão validados depois da
exportação/importação, cooldown e confirmação real das duas lanes pelo executor.

### Worker AWS saiu com código 2 após a primeira partida

O gerador Python de `notBeforeUTC` usava `isoformat()` com seis casas; a imagem
implantada exige segundos ou milissegundos no gate de homologação. Isso pode gerar
`homologation.admission / supplier_cooldown_not_confirmed`, antes de importar o worker
ou abrir conexões ao fornecedor. O código 2 isolado não prova essa causa (a admissão
de memória também pode usar código 2).

O mesmo executor agora lê os últimos logs privados do container, incluindo stderr,
e publica apenas operações/motivos conhecidos, números de capacidade permitidos e
sinais de erro sanitizados. Não imprime payloads, segredos, headers ou exceções brutas.
Em `aws_start_recovery`, só permite nova partida se comprovar: container único parado,
código 2 sem OOM, imagem esperada, gates idênticos ao recibo e rejeição especificamente
do prazo com seis casas. Revalida ausência de consumidor no Mac, locks e cooldowns.

A correção arredonda o prazo **para cima** ao próximo milissegundo. Faz backup privado
do recibo, deployment e logs, preserva a tentativa anterior no recibo e acrescenta um
override somente desse gate. Não altera a imagem pronta, o POSNET, credenciais, volumes,
memória, journals ou seus prazos; não refaz exportação/importação/cooldown já cumpridos.
Novos imports já geram o formato compatível. Uma saída com outra causa é diagnosticada
sem reinício automático; lock existente continua sendo bloqueio, sem remoção.

Os testes reproduzem a rejeição real do launcher sem importações do fornecedor e
exercitam a recuperação com Docker/SSH simulados. A correção na AWS só se confirma
pelo relatório da execução real e pelos snapshots de ambas as lanes.

### Continuar somente a validação, com worker AWS já running

Use `complete-adl-cutover.mjs --pid 12811 --parent 12809 --validate-only`.
Exige progresso salvo de local_exit, exportação, importação e partida concluídos,
container AWS único running e auditoria atual de ausência do consumidor no Mac.
Não chama patch/start/recover/import nem modifica overrides, volumes ou journals;
salva apenas o progresso local e lê Docker logs/checkpoint/journals por SSH.
O worker existente continua com seu próprio agendamento e cooldowns. Não execute
diagnose:trade paralelo nem reinicie consumidores para antecipar o prazo.

Acompanha por até 15 minutos e salva cada observação, mesmo se bloquear depois:
- `lanes.*.sessionEnds`: causas terminais e horários, separadas do erro atual;
- `diagnostic.amqpCloseSignals`: código 320 = connection_forced, não prova sozinho
  de outro consumidor, fechamento administrativo ou timeout;
- `rateLimitSource`: supplier_http identifica HTTP 429; local_operation_cooldown,
  local_host_cooldown e local_in_flight identificam adiamento sem chamada HTTP;
- `evidence.schedulers`: reserva, conclusão, outcome e dueAt reais dos journals;
- `distributionInspection`: before=false/startRequested=true/after=false indica
  status ainda desligado após start; não inferir credenciais inválidas nem tratar
  HTTP 200 como distribuição habilitada;
- `evidence.recentErrors`: últimos erros sanitizados com timestamp do Docker,
  sem textos livres, URLs, payloads ou credenciais; inspeção não chama fornecedor.

Se persistir distribuição desligada ou fechamento 320, usar esses horários UTC,
packages 4511/4510 e sinais de fechamento no ticket LSports 217525: solicitar causa
exata do fechamento no broker e motivo de a distribuição permanecer OFF após start,
confirmando ausência de bloqueio/limite operacional do pacote Test. Não alterar
assinaturas nem executar stopDistribution. A lista de erros agregada sem cronologia
não prova a causa raiz, nem demonstra falha local de parsing ou de memória.

Snapshots só são considerados validados em sessões atuais, com baseline pronto e
checkpoint recente. Keepalive, dados restaurados e mercados encerrados continuam
insuficientes para liberar cotações. Sessão autenticada de iframe ainda exige a
operação de homologação própria; esse monitor não declara iframe validado.

### Dimensionar um snapshot que excedeu 128 MiB na AWS

`--repair-snapshot` exige migração concluída e Mac sem consumidor. Inspeciona o
container atual, sua imagem, limites de Compose/Docker, cgroup memory.max/current,
e a admissão V8/availableMemory com o mesmo ambiente dentro do container. O probe
é um processo auxiliar, não mede o heap ocupado do processo principal; a proteção
real continua sendo recalculada pelo worker imediatamente antes de cada snapshot.
Verifica hashes dos três módulos HTTP/capacidade contra a revisão Git preparada;
fonte diferente bloqueia, sem patch indiscriminado de imagem antiga.

A lane é identificada pelo erro e pela capacidade efetiva: só eleva de 128 para
256 MiB se houver response_size_limit com HTTP 200 e responseLimitBytes=134217728
para aquela lane. Não presume que seja PreMatch. Se a lane já usa 256 MiB, não
reinicia nem eleva acima do teto suportado. A outra lane mantém sua configuração.

Mantém container em 4 GiB e NODE_OPTIONS existente (heap 3072 MiB). O orçamento
para 256 MiB é 2112 MiB; exige admissão do probe e margem conservadora do cgroup
antes de qualquer parada. Recusa preventiva preserva o worker running e imprime
valores numéricos. Não aumenta heap para contornar RAM disponível.

Quando há ajuste comprovado: backup protegido de deployment/inspeção, SIGTERM único
sem SIGKILL, aguarda até 90 s, exige saída e liberação dos locks pelo próprio worker,
copia checkpoint/journals offline e verifica SHA-256 por streaming. Só então adiciona
override do limite da lane, compara o modelo inteiro, preserva recibo e atualiza a
referência de sessão da validação. Recria somente worker, sem build/pull/deps, e
retoma a validação dos snapshots atuais. Não toca em bilhetes, POSNET, credenciais,
assinaturas ou journals; cooldowns persistidos continuam impostos pelo agendador.
Se o encerramento não terminar ou houver lock, não força nem remove: registra a
etapa e interrompe. Uma falha posterior preserva backups para recuperação explícita.

`distribution_still_off`/AMQP 320 são coletados separadamente nos logs e sessionEnds;
o ajuste de tamanho não os declara resolvidos. Local_operation_cooldown após uma
falha de volume é o adiamento preservado pelo scheduler, não prova HTTP 429.
O monitor não chama startDistribution nem diagnose:trade; o worker existente usa
sua rotina normal. Persistindo OFF/320, encaminhar a cronologia UTC ao ticket
217525 para confirmar o motivo do broker e o estado dos pacotes Test.

### Reconciliação do container encontrado com 2 GiB

O reparo anterior recusava qualquer limite diferente de 4 GiB antes da inspeção;
isso impedia reconciliar um deployment real de 2 GiB. A retomada aceita 2/4 GiB
somente neste modo de reparo e relata separadamente Compose, HostConfig.Memory,
cgroup e as camadas de overrides. Lê somente a variável de memória permitida do
deploy.env para indicar sua origem, sem imprimir outras configurações/segredos.
Não presume que o valor do preflight seja igual ao limite do container em execução.

A configuração PreMatch 256 MiB exige orçamento de conversão de 2112 MiB e,
portanto, não cabe integralmente no container de 2 GiB. O reparo reconcilia o worker
para 4 GiB com heap 3072 MiB mesmo se o erro de volume estiver temporariamente
encoberto por cooldown; não exige que a admissão no container antigo de 2 GiB passe.
Exige 6 GiB livres no host antes da parada (4 GiB para worker + reserva conservadora
de 2 GiB para serviços existentes), revalida antes do override e mantém a admissão
real por operação no novo container. Sem margem, bloqueia antes do SIGTERM.
Não cria instância, não aumenta recursos cobrados nem mexe no POSNET.

A lane que excedeu 128 MiB é identificada por responseLimitFailuresByLane,
inclusive coordinator.failure preservado pelo cooldown e journal packageId 4510/4511.
Somente essa evidência permite elevar uma lane de 128 para 256 MiB. PreMatch já em
256 permanece em 256; InPlay permanece em 128 se não houver falha comprovada nele.
Dados insuficientes não são convertidos em afirmação de qual feed falhou. O limite
novo é confirmado em Docker após a recriação, com mesma imagem e overrides anteriores
preservados. O mesmo comando --repair-snapshot continua a validação, sem migrar de novo.
