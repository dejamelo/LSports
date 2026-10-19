# ADL: homologação separada autorizada, implantação em etapas

## Escopo vigente

EC2 **m7i.xlarge já confirmada** pelo operador; 12 serviços POSNET retornaram,
saúde/páginas passaram e demo abriu. Não repetir o redimensionamento. Plano pago
AWS já ativo. Valor e implantação ADL autorizados; sem novo pedido financeiro.
Preservar POSNET, backups, imagens, aliases, políticas e suas rotas. Não executar
novamente os scripts de manutenção POSNET.

Domínio autorizado: **sportbook.apuestadeportiva.lat**, exatamente sem `s` após
`sport`. O operador cadastrou Namecheap **A `sportbook` → 77.113.150.100**, TTL
5 min. DNS deste workspace retornou ECONNREFUSED/timeout do resolvedor: isso não
é NXDOMAIN nem prova de erro no cadastro. A consulta do Mac fará a verificação.
Não alterar os domínios POSNET. Se existirem A adicionais/AAAA incompatíveis,
resolver antes da publicação HTTPS, sem ignorar TLS ou falsificar resolução.

Homologação AWS **separada**: Argentina Demo, bilhetes, resultados, odds aceitas,
bancos e `.env/.runtime` continuam preservados no Mac. Não copiar banco ou
checkpoint inteiro para uma plataforma nova, não executar migrações. AWS terá
seus próprios clientes/operações/credenciais de teste, todos em simulação.

Este workspace não possui a chave SSH (ela fica no Mac), AWS CLI vinculada à
conta ou credenciais LSports. Não alegar execução remota/validação real sem a
saída obtida pelo operador. Nenhum segredo deve ser enviado ao chat.

## Etapa 1: DNS, imagem e API isolada — executar agora no Mac

```bash
cd "$HOME/LSports"
git pull --ff-only origin feat/sportsbook-demo
node deploy/homologation/prepare-adl-aws.mjs
```

Seleciona a chave existente por `*Lottery*Key.pem` e usa o mesmo SSH. Preserva
alterações locais; a exclusão local conhecida de diagnose-aws-resize.py não é
restaurada à força. O conteúdo enviado é **git archive HEAD**, não o diretório
com `.env`, node_modules ou `.runtime`. Não necessita GitHub login no servidor.
Não imprime/chama variáveis secretas. A imagem é identificada pelo commit.

O receptor exige Python >=3.12, pelo menos 4 GiB de memória disponível e 10 GiB
livres para construir; valida porta 13001 livre, rede deploy_default existente e
nenhum projeto ADL anterior. Esses são checks de admissão da implantação nova,
não uma repetição do inventário POSNET. Cria release em `/opt/adl-homologation/releases/COMMIT`
e arquivos protegidos em `/etc/adl-homologation` (700/600). Se já existir release
parcial/configuração, não sobrescreve: relata etapa e preserva para revisão.

Inicia **somente a API** no projeto `adl-homologation`, com volumes próprios;
loopback 127.0.0.1:13001, 768 MiB/0,5 CPU, feed somente leitura, plataforma RW.
Conecta apenas a API à rede existente com alias `adl-homologation-api`. Não
publica 80/443, não modifica Caddy nem containers POSNET. Health /control 200
prova processo web, não feed nem usuário administrativo já criado.

Resultado esperado `stage=complete/status=ok/apiStarted=true/workerStarted=false`.
Guardar release/imagem da saída. Build/deploy têm logs privados no release;
falha publica etapa sanitizada. Não compartilhar log bruto sem revisão. A
construção canônica da imagem precisa concluir na AWS: o build local da aplicação
passou, mas a tentativa de instalação em imagem neste workspace não concluiu.
Não foi fornecida uma imagem nova como se já estivesse validada.

**Não parar ainda o worker Mac** nesta etapa. Ele continua sendo o único
consumidor enquanto se prepara API, HTTPS e a nova plataforma.

## Etapa 2: HTTPS e nova plataforma, antes do corte

Após a saída real da etapa 1 e DNS confirmado:

- Gerar/revisar um bloco novo de site somente para sportbook.apuestadeportiva.lat,
  upstream `adl-homologation-api:3001`; não ativar standalone-proxy nem outro Caddy.
- Salvar configuração ativa e arquivo Caddy em backup root-only, comparar baseline
  imediatamente antes da alteração, adaptar/validar candidato e garantir que as
  rotas POSNET continuam iguais. A mudança requer rollback de arquivo + reload
  se falhar; nunca restart do Caddy nem sobrescrita cega.
- Manter painel/control API restritos à rede administrativa identificada, além da
  autenticação. `deployment.json` registra CIDR do cliente SSH para essa revisão;
  se navegador usar outra rede/VPN, não abrir o painel a todos para contornar.
- Alterar arquivo host preservando o bind/inode, reload controlado e verificar
  certificado, novo domínio e POSNET. Não declarar HTTPS pronto apenas pelo A.
- Criar administrador no backend por entrada protegida no servidor, sem senha em
  chat/argv/log; configurar novo cliente/operação/moeda/domínio permitido e gerar
  credencial backend. Segredo LSports não vai para API/browser.
- Criar sessão temporária e página iframe da homologação pelo backend existente;
  não ativar /demo/argentina ou demonstração sintética em produção. Validar domínio
  autorizado e CSP. Bilhetes/carteira continuam simulados.

A publicação e bootstrap dependem da evidência da etapa 1; não apresentar um
reload ou conta criada como executado por este workspace.

## Etapa 3: corte Mac → AWS e cooldown

1. Encerrar normalmente o worker do Mac (Ctrl+C do processo npm/dev que o mantém).
   Esperar `worker.shutdown` e `lock=released`. Não apagar lock, SIGKILL geral,
   stopDistribution, novas filas ou cancelamento de assinaturas. Se npm dev
   reiniciar o worker, encerrar seu supervisor normal, sem matar outros Node.
2. Depois executar **no Mac**:

   ```bash
   npm run cutover:audit
   ```

   É leitura local, zero requisições ao fornecedor. Bloqueia qualquer lock de worker
   ou scheduler, processo reconhecido ainda ativo, journal ausente/corrompido ou
   evidência incompleta das lanes. Não recupera locks automaticamente.
3. O relatório calcula `notBeforeUTC` como máximo de todos `nextAt/due`, retryAt
   prematch/inplay e último snapshot + intervalo configurado, nunca antes de um
   intervalo completo após desligamento, com margem positiva. Não usar espera fixa
   de 5 min se algum Retry-After exigir mais tempo.
4. Transferir por SSH somente variáveis LSports permitidas e journals do scheduler
   (sem locks) para backend protegido; **não transferir `.env` inteiro**, plataforma,
   bilhetes ou checkpoint. Preservar prazos e hashes/auditoria da cópia. Arquivos
   secretos `worker.env` têm formato Compose **raw**, para não interpolar `$`/aspas.
   O formato exige Compose >=2.30; servidor informou v5.6.0.
5. Só após ausência de consumidor Mac, journals importados e horário UTC atingido,
   afirmar gates `ADL_CAPACITY_APPROVED=yes`, `ADL_MAC_WORKER_STOPPED=yes`,
   `ADL_SUPPLIER_NOT_BEFORE_UTC=...`; worker com perfil explícito feed-consumer.
   Launcher mantém orçamento de memória antes de importar cliente e a cada HTTP.
6. `basic.consume(exclusive=true,noAck=false)` fornece exclusividade de consumidor
   **na fila existente**, não cria fila exclusiva nem altera subscriptions. É opção
   AMQP suportada pelo amqplib instalado. Se já houver consumidor/incompatibilidade,
   falhar com diagnóstico, nunca rebaixar para não exclusivo. Exclusividade não
   substitui encerramento normal do Mac nem preservação de cooldown.

Local file lock não é fencing entre hosts. O gate operacional declara corte;
exclusividade de basic.consume impõe a restrição no broker. A aceitação dessa
opção nas filas específicas só pode ser validada na conexão real; não presumir
suporte a configurações especiais como single-active-consumer.

## Etapa 4: validação real, sem fallback

PreMatch cap 256 MiB/old-space 3072 MiB/container 4 GiB; InPlay cap 128 MiB.
Admissão usa margem física/cgroup e heap, não a RAM total isoladamente. Não baixar
guardas, timeout20s, cooldowns ou forçar available. Snapshot precisa completar
nesta execução, handoff terminar e regularSnapshotReady=true antes de aceitar odds.

Usar evidências existentes do painel: snapshot lastAttempt/lastSuccess, auditoria
bytes/eventos/mercados, phase de cada lane, último dado e último mercado efetivos,
exclusões locais e candidatos abertos; keepalive não prova atualização de preço.
Conferir mesmo fixture/mercado/seleção no diagnóstico API e iframe, preço/status
servidor e bilhete simulado. Sem evento aberto, registrar exclusões e evidência
para LSports; não inventar evento/odd para declarar conexão validada.

- memory_budget_exceeded/response_size_limit: bloqueio local, não ausência de feed.
- local_*_cooldown: adiamento sem HTTP; supplier_http/429: fornecedor, respeitar retryAt.
- AMQP consumer_conflict: outro consumidor/acesso exclusivo, não senha por suposição.
- HTTP401/403/AMQP autorização: registrar operação/código sanitizado; não revelar chave.
- AMQP320/distribution_still_off: separar transporte/distribuição de memória.
- Tipo desconhecido: preservar NACK/requeue e persistência antes do ACK; não descartar.

Rollback: parar worker AWS normalmente e confirmar ausência antes de reativar Mac,
respeitando também os prazos AWS; manter API/dados de homologação e processar seus
resultados pendentes. Não apagar volumes ou religar dois consumidores. Não
restaurar bancos Mac ou repetir migrações para corrigir falha de transporte.

## Retomada da etapa 1: falha comprovável no tmpfs

O operador confirmou `dnsConfirmed=true`, A correto e nenhum AAAA, mas a release
parou em `api_start`. Não repetir DNS, upload, instalação/build ou criação dos
envs. A imagem passou pelas etapas de construção/configuração; isso não prova
que um container tenha iniciado. O Mac continua com seu consumidor existente.

Defeito reproduzido localmente: YAML flow sequence sem aspas
`tmpfs: [/tmp:size=67108864,mode=1777]` resulta em **duas entradas**, com a segunda
`mode=1777`. O Engine rejeita com `invalid mount path: 'mode=1777' mount path must
be absolute`. O Compose source foi corrigido na API e no worker para
`tmpfs: ["/tmp:size=67108864,mode=1777"]`. Compose config --quiet sozinho não
capturava esse erro semântico: acrescentado teste com parser real e reprodução
com Engine (somente no workspace, sem AWS).

### Comando de diagnóstico e retomada condicionada, no Mac

```bash
cd "$HOME/LSports"
git pull --ff-only origin feat/sportsbook-demo
node deploy/homologation/resume-adl-api.mjs --apply
```

Para inspecionar sem qualquer alteração, omitir `--apply`.

A rotina lê `/etc/adl-homologation/deployment.json`, valida release/imagem e lê
somente a cauda do **deploy.private.log**. Não imprime linhas, credenciais ou
configuração completa. Mostra sinais predefinidos, API criada/running/exitCode/
health, sinais sanitizados dos logs API e GET loopback /control. Assim identifica
se houve início parcial. Não usa a captura como se contivesse o erro real.

Com --apply, exige **ambas** as evidências: o log privado confirma o erro específico
e o modelo tem as duas entradas inválidas. Outra causa bloqueia a retomada. Exige
imagem existente e nenhum worker AWS running. Não chama API do fornecedor.

Cria backup root-only em `/var/backups/adl-api-resume-*` e um override protegido
`/etc/adl-homologation/compose.tmpfs-fix.yaml`, usando `!override` (suportado pelo
Compose do servidor). Compara o modelo inteiro: somente tmpfs API/worker pode
mudar. Se aparecer diferença de imagem, env, volumes, rede, limites ou outro
campo, bloqueia antes de up. Mantém source/release original intacto.

Retoma **apenas API**, com `--no-build --no-deps --pull never`, reutilizando imagem
já construída e os volumes. Não worker profile, Caddy, POSNET, bootstrap ou Mac.
Aguarda /control 200. Se outro erro aparecer, registra etapa, estado parcial e
sinais conhecidos, preservando tudo; não tenta chown, apagar banco ou recriar
volumes às cegas. Um container API saudável já em execução não é reiniciado.

Resultado esperado: `stage=complete/status=ok/apiStarted=true/controlHttpStatus=200`,
`workerStarted=false`, `posnetChanged=false`, `imageRebuilt=false`.
A evidência de conexão/snapshot real na AWS continua pendente.

### Composição persistida e reversão

`deployment.json` passa a registrar `composeOverrides` e `apiResumeFix`. Todos os
próximos comandos ADL sobre essa release **devem acrescentar**
`-f /etc/adl-homologation/compose.tmpfs-fix.yaml`, depois dos dois arquivos
originais; isso inclui o futuro worker. Não usar a composição original inválida
por esquecimento. Nas próximas releases o source já contém a correção.

O backup preserva metadados/modelo antes/depois em arquivos privados 0600, nunca
para Git/chat. Não apagar o override para tentar rollback: isso restaura uma
configuração sabidamente inválida. Se retomar API causar outro problema, manter
dados/env e interromper somente a API ADL por procedimento dirigido, sem down -v
ou qualquer mudança POSNET/worker. Avaliar o diagnóstico antes de nova tentativa.
A rotina não executa rollback de bancos nem reinicia o worker do Mac.

Validação local: sete testes de retomada, incluindo prova pelo parser Compose,
gates de causa conhecida, diferenças inesperadas bloqueadas e API-only sem build;
Engine rejeitou a forma antiga e aceitou a corrigida. Não declarar leitura do
log AWS ou saúde da API real antes da saída do operador.

### API exit 1 after tmpfs repair — source access diagnostic

The protected release receiver uses umask 077 and Python's `tarfile` data filter.
Directory modes are discarded by that filter; extracted source directories become
root-owned 0700. COPY preserves them, while the runtime is USER node. This defect
is reproduced locally; the Mac report alone does not prove it caused the AWS exit.

Run on the Mac (no AWS worker or POSNET changes):

```sh
cd "$HOME/LSports" &&
git pull --ff-only origin feat/sportsbook-demo &&
node deploy/homologation/repair-adl-runtime.mjs --apply
```

Without `--apply`, the command only reads private log classifications and runs
network-disabled, read-only Node filesystem probes against the exact local image.
No application code, environment files, credentials or data volumes enter those
probes. Root is used only for a comparison probe; the application stays non-root.
The command prints fixed error categories and access results, never raw logs.

Apply requires both module/access failure in the private API logs and EACCES for
non-root with successful root reads. Missing files, unrecognized causes, a running
AWS worker or unrelated model changes block repair. Existing Compose overrides
are honored, including the completed tmpfs repair. Backup includes the previous
metadata, resolved model, image metadata and private API logs in a root-only
`/var/backups/adl-runtime-repair-*` directory before configuration changes.

The derived image is built offline FROM the immutable existing image ID, changing
only source-directory traversal and source-file readability. No npm installation,
registry pull, live-volume chmod/chown or deletion occurs. Both service image
references are prepared consistently, but only `api` is recreated with no-deps,
no-build and pull-never. Original image is retained. The saved deployment metadata
lists the new override and backup. Success requires control HTTP 200 AND Docker
health=healthy. Failure identifies its stage and whether API mutation was requested;
retain the backup and report that sanitized result before retrying. Do not use the
original prepare script or manually start the AWS worker.

Future full image builds normalize these same source permissions in
Dockerfile.homologation; secrets, env and runtime trees are outside that operation.
The AWS cause and startup remain unvalidated until the operator runs this command.

#### Derived-image build correction

A second defect was reproduced with the actual Docker builder: `FROM sha256:<ID>`
is parsed as `docker.io/library/sha256:<ID>`, causing registry resolution and
access rejection even with `--pull=false` and `--network none` (the latter only
restricts RUN networking). The first repair script used that incorrect FROM form.

The corrected script tags the already-present image as
`adl-runtime-base:<full-image-hash>`, verifies that tag's image ID, builds from the
local tag, and verifies the parent ID again afterwards. Conflicting tags block
rather than being overwritten. No package install or pull is requested. The
original image, previous backup and failed build log remain intact.

The inspect report now includes `previousBuildEvidence`, restricted to backups
whose private image manifest matches the current source image ID. Only fixed
build-error categories are printed. New build failures expose `buildLogSignals`;
derived-image verification has its own stage. An unrecognized cause remains
blocked with no API mutation. This enables checking the remote log without sharing
it. The Docker reproduction establishes the script defect, not the remote log's
contents; confirm the latter in the report.

Resume with the same `repair-adl-runtime.mjs --apply` command above after pulling.
It creates a fresh protected backup, retaining all previous backups. Success still
requires API HTTP 200 and healthy; AWS worker remains stopped. No preparation,
resize, volume recreation, POSNET changes or Mac worker changes are involved.

## API recuperada: publicação HTTPS e credenciais (próxima etapa)

Evidência do operador: reparo concluído com `stage=complete`, `status=ok`,
`controlHttpStatus=200`, `health=healthy`; worker não iniciado, POSNET e volumes
inalterados. Não repetir preparação, rebuild completo ou redimensionamento.
Os overrides de tmpfs e imagem corrigida permanecem em deployment.json.

Executar no Mac:

```bash
cd "$HOME/LSports" &&
git pull --ff-only origin feat/sportsbook-demo &&
node deploy/homologation/publish-adl-https.mjs --apply &&
node deploy/homologation/stage-adl-credentials.mjs
```

O primeiro comando publica somente `sportbook.apuestadeportiva.lat`, no Caddy
existente, sem restart dos containers. Confere igualdade ativo/boot e arquivo
montado, adapta o candidato com o binário Caddy real e permite somente a inclusão
da rota desse domínio; qualquer outra diferença bloqueia. Backup root-only em
`/var/backups/adl-https-*`; gravação preserva inode/bind. Reload falho restaura
arquivo anterior e configuração carregada, informando `rollback`. TLS é validado
sem ignorar certificado. `https_pending` mantém o candidato válido instalado,
mas bloqueia a sequência: revisar emissão/DNS/firewall, não anexar o site outra
vez. O script bloqueia reaplicação se o domínio já estiver presente.

O novo site usa upstream `adl-homologation-api:3001`, bloqueia rotas demo/sintéticas
e restringe `/control`, `/api/control/*` e `/api/diagnostics/*` ao CIDR administrativo
já registrado, além da autenticação da aplicação. `log_skip` evita registrar URLs
de sessões temporárias. Não adiciona X-Frame-Options incompatível com iframe.
Painel após sucesso: `https://sportbook.apuestadeportiva.lat/control`. O iframe
usa `/embed/:cliente/:operacao/sportsbook`, após configurar a operação e sessão. A AWS é plataforma nova: ainda
precisa de bootstrap de administrador e operação autorizada, não usar contas ou
bilhetes Argentina Demo do Mac. Página HTTP 200 não prova feed/sessão incorporada.

O segundo comando lê apenas oito chaves permitidas de `.env` no Mac: USERNAME,
PASSWORD e o par opcional MQ_USERNAME/MQ_PASSWORD de cada lane. Não modifica o
arquivo local, não transfere seu conteúdo integral, checkpoint, tickets ou banco.
O payload vai por stdin no SSH (não argv); a recepção não imprime valores. Usa os
endpoints/pacotes/vhosts/filas Test do exemplo aprovado e grava `worker.env` em
0600 sob diretório 0700. Faz backup protegido do arquivo anterior antes da troca
atômica. O arquivo Compose é raw: `$`, aspas e `#` são literais após o parsing do
.env de origem; valores com quebra de linha são rejeitados. Credenciais ficam
somente no worker, não API, imagem, navegador, Git ou logs. Não faz login no
fornecedor nem abre AMQP; credenciais armazenadas não significam validadas.
Nenhum override, gate de cutover ou container é modificado nessa transferência.

### Corte preparado, sem partida automática

Manter o worker Mac ligado até HTTPS e nova plataforma estarem preparados. Depois
encerrar normalmente seu supervisor com Ctrl+C e esperar persistência/lock released.
Não executar `npm run dev`/`dev:embed` depois do corte: eles iniciam novamente o
worker. Para continuar UI/API locais sem feed usar somente `dev:web` e `dev:api`.

Após encerramento, executar:

```bash
cd "$HOME/LSports" && node deploy/homologation/prepare-adl-cutover.mjs
```

Reaproveita `cutover:audit`: exige ausência de processos e locks, lê checkpoint
somente para confirmar evidências das lanes, calcula máximo de todos cooldowns e
retryAt com margem, e exporta APENAS journals do scheduler e relatório para pasta
0700 fora do repositório (`~/Library/Application Support/ADL/Cutover/.../handoff.json`,
0600). Não copia checkpoint nem bilhetes, não inicia/para processos e não faz SSH
ou chamadas LSports. Exportação local não é fencing: manter Mac desligado.

Ainda antes da partida AWS: importar esses journals no volume de feed preservando
prazos/nomes por host; confirmar `notBeforeUTC` e então configurar gates do deploy
com os overrides salvos. O worker usa consume exclusivo em ambas as filas e
persistência antes do ACK. Se conflito, falhar sem fallback não exclusivo. Não
usar apenas cinco minutos fixos ou diagnosticar fornecedor em paralelo. Nesta
entrega nenhum comando de start AWS é disparado, para não antecipar corte/cooldown.

Validação pendente real: TLS na AWS, bootstrap/operação de homologação, importação
dos journals após shutdown, partida única, snapshots completos e odds atuais no
iframe. Falhas de memória/cooldown local continuam separadas de 429/autorização/
fechamento AMQP do fornecedor. Não liberar odds do checkpoint nem forçar available.

### HTTPS pending após reload: verificar sem publicar novamente

O operador confirmou `https_pending`, `caddyReloaded=true`, rotas anteriores e
overrides preservados. A sequência com `&&` encerrou antes da transferência das
credenciais, portanto não houve `credentialsStored=true`.

Foi encontrado um erro no probe de publicação: `/sportsbook` não é uma rota do
modo plataforma. Ela pode retornar 404 mesmo com certificado válido. O iframe é
`/embed/:cliente/:operacao/sportsbook`; só deve ser construído para a operação/sessão
autorizada após o bootstrap. O probe futuro foi corrigido para ler `/control` via
loopback e verificar um asset JavaScript real por HTTPS, sem abrir rotas anônimas.
Não repetir a publicação já aplicada para instalar essa correção do probe.

Executar no Mac:

```bash
cd "$HOME/LSports" &&
git pull --ff-only origin feat/sportsbook-demo &&
node deploy/homologation/verify-adl-https.mjs &&
node deploy/homologation/stage-adl-credentials.mjs
```

O verificador é somente leitura: não reload, restart, append de site ou alteração
de overrides. Compara configuração ativa/boot/montada; faz handshake TLS verificado
com SNI do domínio tanto na porta local quanto no destino público, informando
validade/fingerprint públicos do certificado, ou categorias DNS/conexão/TLS.
Testa o asset real via HTTPS sem seguir redirects e mostra códigos HTTP de
`/control` e da antiga `/sportsbook` separadamente. `403` no control externo pode
ser a restrição CIDR esperada; `404` da rota antiga não implica falha TLS.

Consulta últimas 2000 linhas/30 minutos dos logs do Caddy e publica apenas sinais
fixos relativos a esse domínio: certificado obtido, emissão em curso, desafio/DNS/
CAA, limite ACME, timeout, permissão de armazenamento e repetição agendada. Nunca
imprime texto bruto, chaves privadas, URLs ACME ou identificadores de conta.
Ausência de sinais nesse recorte não comprova ausência de emissão. Não força uma
nova emissão nem consulta o fornecedor LSports.

Sucesso exige `status=ok`, `httpsVerified=true`, `applicationVerified=true`; só então
`&&` prossegue para o staging protegido e `credentialsStored=true`. Se falhar,
reportar somente JSON sanitizado; não remover proteção TLS ou publicar o site de
novo. Mesmo com sucesso, Mac continua consumidor único e worker AWS parado até
bootstrap, desligamento normal, audit/export dos journals e cooldown.

### Corte bloqueado no Mac: diagnóstico local somente leitura

Uma saída genérica de `cutover.prepare` não identifica a evidência ausente. Não
concluir que há lock residual ou consumidor ativo somente porque não há npm em
uma aba do Terminal. A auditoria anterior descartava a causa e o launcher de
exportação também ocultava o relatório do subprocesso quando ele saía com código
2. Agora `prepare` expõe `stage` e `auditEvidence` sanitizados; a exportação também
distingue journal alterado após a auditoria, contagem diferente e erro de arquivo.

Executar primeiro, sem repetir a exportação ou iniciar consumidores:

```bash
cd "$HOME/LSports" &&
git pull --ff-only origin feat/sportsbook-demo &&
node deploy/homologation/diagnose-adl-cutover.mjs
```

Relatório `cutover.diagnose`, somente leitura e zero requisições LSports/AWS:

- `blockers`: etapas e códigos específicos; coleta continua após a primeira falha.
- `processes`: apenas PID, PPID e categoria de worker reconhecido; nenhum argv,
  ambiente ou comando completo. Falha de `ps` não é tratada como ausência.
- `locks`: tipo (worker, guard ou scheduler), PID quando numérico, dono
  running/not_running/unknown e idade; todos com action=preserved. PID ausente ou
  morto não autoriza remoção. Inclui guard do worker que a coleta anterior omitia.
- `journals`: índice, tamanho, integridade JSON/estrutura, quantidade de operações
  e maior prazo; nenhum conteúdo completo ou texto arbitrário de erros.
- `checkpoint`: existência/leitura/JSON, modo classificado e presença das duas
  lanes, sem eventos, bilhetes ou payloads. Parse limitado a 256 MiB e admitido
  apenas com margem conservadora de memória física/heap; recusa informa orçamento.
- `notBeforeUTC`: só calculado quando há evidência legível; não substitui
  status=ok nem dispensa confirmar que o consumidor Mac continua desligado.
- `stateLocationSource`: default ou configured, sem imprimir o valor do .env.
- `diagnostic_start`: distingue falha de loader/dependências/opção Node/timeout
  antes mesmo de executar a coleta; stderr bruto permanece oculto.

Envie apenas o JSON sanitizado. Nenhum lock é apagado/reclamado, nenhum arquivo
.env/checkpoint/journal/bilhete é modificado e nenhum worker ou processo é morto.
Não há SSH neste comando nem alterações no POSNET, volumes ou composeOverrides.
Só prosseguir para exportação/importação depois de resolver a causa demonstrada.

Validação desta alteração: 11 testes direcionados de diagnóstico/cooldown e
tipagem dos três scripts passaram. O `tsc -p tsconfig.json` genérico inclui o
frontend sem sua configuração JSX e testes fora dos targets de build, portanto
não é um check global válido; não foram alterados frontend/configs para contorná-lo.
O diagnóstico foi exercitado também contra ausência de checkpoint no workspace;
isso não é evidência sobre o Mac, cuja causa ainda depende do relatório local.

### Worker Mac ativo sem Terminal visível: encerramento por dono verificado

O operador confirmou dois processos reconhecidos (12809 e 12811 na captura),
com o segundo como dono vivo do lock. Esses PIDs são evidência histórica, não
alvos fixos. O comando abaixo relê as identidades antes de qualquer sinal:

```bash
cd "$HOME/LSports" &&
git pull --ff-only origin feat/sportsbook-demo &&
node deploy/homologation/stop-adl-mac-worker.mjs
```

O comando local identifica os processos novamente, lê lock regular e PID numérico,
e confirma UID, argumento de entrada do worker, diretório real deste repositório
(ou apps/worker), horário de início do processo e identidade inode/dev do lock.
No Mac usa `ps` e `lsof` para leitura; nenhum argv/cwd bruto é impresso. Falta de
permissão ou identidade divergente bloqueia. Não deve ser executado com sudo.

Envia exatamente um SIGTERM ao PID positivo do dono atual verificado, sem sinais
para pai, grupo, npm geral, API ou outros Node. Aguarda até 120s tanto a saída do
processo quanto ausência do lock e guard, sem removê-los. O próprio worker executa
seu finally normal de persistência, fechamento AMQP e liberação do próprio lock.
Se a política já existente do supervisor encerrar processos acompanhantes após
saída do worker, o comando não altera essa política. Nunca reativa o supervisor.

Após a saída, exige auditoria sem processos/locks, journals estáveis entre duas
leituras e nova auditoria. Só então chama automaticamente prepare-adl-cutover.mjs.
A última saída é cutover.prepare/status=ok com destination, journals e notBeforeUTC.
Esse prazo é calculado na exportação fresca e pode ser posterior ao visto no
diagnóstico anterior à parada. Compartilhar apenas a saída sanitizada; manter Mac
worker desligado. Nenhuma operação SSH, AWS, POSNET, volume ou override é feita.

Se timeout, PID reutilizado, dono diferente, lock residual, processo remanescente
ou supervisor recriando worker: termina blocked sem repetir sinal, sem SIGKILL,
sem apagar lock e sem exportar/iniciar AWS. O lock de dono morto continua preservado
para análise; a parada normal não contorna as proteções de recuperação.

Validação: 20 testes de identidade, encerramento real SIGINT/SIGTERM (direto e
npm/concurrently), persistência/restauração, dois bilhetes isolados preservados,
locks próprios/concorrentes e cooldown; tipagem direcionada dos novos scripts passou.
O teste real de sinal usa apenas o harness isolado, sem conexão ao fornecedor.
A parada e notBeforeUTC do Mac continuam dependendo da execução pelo operador.

### SIGTERM emitido, timeout com lock preservado: observar sem novo sinal

O operador confirmou `signalRequested=true` e
`GRACEFUL_SHUTDOWN_TIMEOUT_LOCK_PRESERVED`, sem exportação ou partida AWS. Isso
não comprova se o processo continua vivo neste momento nem em qual Promise
parou. Não executar novamente o comando de parada, SIGTERM/SIGINT adicional,
SIGKILL, remoção de lock ou inicialização para contornar.

Próximo comando no Mac:

```bash
cd "$HOME/LSports" &&
git pull --ff-only origin feat/sportsbook-demo &&
node deploy/homologation/diagnose-adl-shutdown.mjs
```

Somente leitura: reidentifica dono do lock/UID/cwd e processo, lê `ps` e `lsof`
sem imprimir comandos, caminhos, IPs ou endpoints, observa checkpoint/journals
por 5 segundos e executa a auditoria novamente. Mostra:

- processo/parent PID verificados, estado, tempo e CPU, sem argv;
- conexões por classe de porta AMQP/HTTPS e estado (ESTABLISHED, CLOSE_WAIT etc.);
- stdout/stderr como terminal/pipe/arquivo/socket, sem ler terminal ou consumir pipe;
- somente se stdout/stderr forem arquivos regulares pertencentes ao usuário,
  resume últimas 128 KiB em contadores fixos de worker.shutdown. Não imprime
  conteúdo/erros/URLs; logs podem ser compartilhados ou anteriores ao sinal;
- fases persistidas das lanes, estágio de recovery, alterações do checkpoint e
  estabilidade dos journals; bloqueios atuais continuam preservados.

No código, shutdown pode aguardar sessão (HTTP/snapshot), processamento das
mensagens, persistência, fechamento AMQP e finalmente liberação do próprio lock.
`connection.close()` é uma espera sem timeout explícito, mas isso sozinho não
prova que seja o ponto pendente do processo Mac. A versão efetivamente carregada
pelo processo antigo não é conhecida. Estado de socket, CPU ou fase gravada não
identifica uma Promise nem comprova que o handler de SIGTERM executou.
Por isso o relatório marca `pendingStage=not_proven_in_existing_process`; não
aplica timeout de destruição ou correção especulativa no worker em execução.

Se `status=ready_for_export`, a nova auditoria confirmou ausência de processos/
locks e journals estáveis. Então executar `prepare-adl-cutover.mjs`, obtendo
notBeforeUTC fresco. Se `blocked`, enviar só o JSON sanitizado para decidir o
próximo passo com evidência. Dono morto com lock residual continua bloqueado,
sem recuperação automática. Nenhum SSH, reload, worker start ou alteração POSNET,
volumes, backups ou composeOverrides é realizado por essa observação.

### Evidência OS: state=T — histórico da primeira recuperação

O operador confirmou PID 12811 em T. A versão 34f7f16 tentou usar SIGCONT
condicionado à máscara pending do ps, mas bloqueou antes de backup/sinais com
SIGTERM_NOT_PENDING e resumed=false. Esse procedimento foi substituído pela
sequência corrigida abaixo; a opção antiga --prior-term-confirmed é rejeitada.
Não remover arquivos de intenção de tentativas anteriores nem retomar outra
identidade/PID para contornar bloqueios.

### macOS: recuperação corrigida, sem depender de p_siglist

Revisão das fontes oficiais Apple:

- [adv_cmds ps/keyword.c](https://github.com/apple-oss-distributions/adv_cmds/blob/main/ps/keyword.c):
  pending é alias de sig; sig imprime p_siglist via formato hexadecimal.
- [XNU bsd/sys/proc.h](https://github.com/apple-oss-distributions/xnu/blob/main/bsd/sys/proc.h):
  p_siglist e p_sigmask no extern_proc são marcados DEPRECATED.
- [XNU bsd/kern/kern_sysctl.c](https://github.com/apple-oss-distributions/xnu/blob/main/bsd/kern/kern_sysctl.c):
  fill_user64_externproc exporta outros campos de sinais, mas não preenche p_siglist.

Essas fontes atuais explicam por que esse campo legado não pode ser usado como
pré-requisito confiável no macOS. Não identificamos a build do kernel ou o commit
JavaScript carregado pelo processo do operador. Zero nessa máscara não prova que
o SIGTERM anterior nunca foi enviado/recebido, nem descreve o estado do handler.
No Darwin, o script deixa de consultar esse campo e reporta a observação como null,
com pendingMaskAuthority=deprecated_macos_field_ignored. Não troca false por true.

Executar no Mac **uma vez, sem sudo**, com a NOVA opção explícita:

```bash
cd "$HOME/LSports" &&
git pull --ff-only origin feat/sportsbook-demo &&
node deploy/homologation/recover-stopped-mac-worker.mjs --pid 12811 --resume-and-stop
```

1. Revalida PID, UID, horário de início, argumento de worker, cwd real do projeto,
   posse/inode/dev do lock e estado T. Outro PID/processo/estado bloqueia.
2. Antes de sinais, cria backup privado 700/600 fora do Git em
   ~/Library/Application Support/ADL/Recovery/stopped-worker-* com checkpoint,
   journals, lock e manifesto. Exige espaço, T durante a cópia e SHA-256 igual da
   fonte antes/depois e backup. Sincroniza os arquivos; não copia .env.
3. Registra intenção exclusiva por identidade, preservada em disco, e envia um
   SIGCONT ao dono. Pai também T só é retomado se for launcher tsx não-watch do
   mesmo projeto/UID, com relação pai-filho revalidada; nunca grupo/npm genérico.
4. Aguarda 3 segundos para o encerramento anterior progredir. Se já saiu e liberou
   lock, não envia TERM. Se a máscara é indisponível/legada/sem TERM e o mesmo
   processo ainda vive, exige novamente estado fora de T, UID/cwd/horário/argv e
   o mesmo lock. Registra intenção separada e envia **um único SIGTERM dirigido**.
   No Linux, uma máscara que comprova TERM já pendente evita esse segundo sinal.
5. Aguarda até 120s após CONT por saída/liberação normal. Não repete sinais, não
   usa KILL, não remove lock vivo ou órfão e não aplica timeout destrutivo. Se o
   processo for suspenso de novo ou a identidade mudar, bloqueia sem TERM.
6. Auditoria e journals estáveis são obrigatórios antes da exportação automática.
   A saída cutover.prepare informa destination/journals/notBeforeUTC frescos.

A mudança não é uma repetição cega de SIGTERM: a retomada e a identidade ativa
são confirmadas antes de um sinal dirigido no novo modo. Se o handler antigo já
estiver finalizando e sair durante as verificações, a posse desaparecida impede
novo sinal e o script aguarda a saída natural. Intenções existentes impedem
reaplicação automática; não são apagadas mesmo se a recuperação ficar parcial.
O bloqueio SIGTERM_NOT_PENDING/resumed=false ocorreu antes de criar intenções,
portanto esse resultado por si não exige recuperação de marcador nem locks.

Se bloquear novamente, enviar apenas JSON sanitizado com stage/reason/backup/
resumed/directedTermRequested. Preservar backups e dados, sem tentar outra opção
para ignorar proteções. Nenhum worker AWS, POSNET, volume ou composeOverride é
alterado. O consumidor Mac pode progredir brevemente durante a retomada, por isso
AWS continua parado e os journals finais/cooldown devem ser exportados novamente.

Testes isolados reproduzem os dois cenários reais: TERM pendente + CONT e ausência
de TERM + CONT seguido de TERM revalidado. Ambos concluem persistência e liberação
do próprio lock. Também cobrem backup falho, intenção já usada, PID/lock trocado,
suspensão recorrente e timeout sem repetição/escalada. Nenhum teste usa fornecedor.
