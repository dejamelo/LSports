# Recuperação protegida e corte retomável Mac → AWS

## Autorização e limites

O usuário autorizou expressamente o encerramento forçado exclusivamente do worker
verificado, após proteger e verificar os dados persistidos e impedir reinício
automático. Reconheceu a possível perda de estado apenas em memória. Não solicitar
nova aprovação financeira/manutenção ou nova autorização dessa intervenção.

Não usar SIGKILL. O procedimento preparado usa SIGHUP dirigido ao dono, cujo
comportamento padrão no Node/macOS é terminar sem aguardar o finally. Isso é uma
terminação **não cooperativa**, e não outra tentativa de desligamento gracioso.
Se não terminar, não escalar nem repetir o sinal automaticamente. Preservar
checkpoint, journals e lock; AWS permanece sem nova partida.

## Estado realmente conhecido

- API/HTTPS/credenciais AWS foram confirmados pelo usuário em etapas anteriores.
- Último estado informado: Mac dono 12811 vivo, supervisor 12809 retomado;
  SUPERVISOR_DRAIN_TIMEOUT_NO_MORE_SIGNALS, lock presente, sem exportação.
- O fechamento AMQP foi corrigido no Git, não dentro do processo antigo nem na
  imagem AWS original. A espera pela promessa de CloseOk pode sobreviver ao socket.
- Não há chave do Mac/agente SSH nem runtime do usuário no workspace Codex.
  Nenhuma parada/partida ou alteração AWS desta recuperação foi executada daqui.
- Redimensionamento, DNS, TLS, política POSNET e armazenamento de credenciais já
  concluídos; não repetir. Não aumentar custos nem criar assinaturas/recursos AWS.

## Um único comando no Mac

```bash
cd "$HOME/LSports" &&
git pull --ff-only origin feat/sportsbook-demo &&
node deploy/homologation/complete-adl-cutover.mjs --pid 12811 --parent 12809 --recover-and-cutover
```

O mesmo comando continua pelos resultados persistidos. Não iniciar `npm run dev`,
não usar `fg`, não remover locks/intenções, nem iniciar worker AWS por outro meio.
O executor não solicita novas aprovações. O flag identifica a recuperação já
explicitamente autorizada, incluindo a terminação não cooperativa se necessária.

## Etapas e proteção dos dados

1. **Gate atual AWS**: somente leitura de API, worker parado, limites PM256/IP128,
   container4GiB, credenciais 600/700 e overlays. Sem nova coleta DNS/TLS/POSNET.
2. **Proteção Mac**: revalida PID/início/UID/cwd/lease e ligação ao supervisor, as
   intenções TERM/drain e o backup anterior. Confirma ausência de TCP no worker e
   único filho vivo esperado. Verifica concurrently sem restart/fila/kill-timeout.
   Suspende, por PID, somente o supervisor e o worker. Nunca grupos/npm ancestral.
3. **Backup atual consistente**: o checkpoint continuou mudando depois do backup
   original; por isso uma cópia atual é necessária, não uma repetição da migração.
   O backup original é preservado. JSON/conexões/journals/cooldowns são validados;
   checkpoint/journals/lock atuais são copiados com SHA-256 e fsync fora do Git em
   pasta 700/arquivos600. Bancos legados e control.sqlite existentes são abertos
   somente leitura e copiados pela API SQLite backup, incluindo WAL comprometido.
   Integrity_check e fingerprint de todas as tabelas são comparados. Não restaurar,
   migrar ou reescrever bilhetes, odds aceitas, resultados ou auditoria.
4. **Imagem AWS corrigida**: deriva somente o worker da imagem de runtime já
   reparada. Confere SHA do connected.ts base com o commit da release, copia apenas
   connected.ts/connection-closer.ts com 644/UID node. Preserva todas as outras
   camadas, dependências e overlays. Testa fechamento offline, sem rede e sem .env.
   Novo overlay altera só worker.image; o modelo inteiro é comparado. API/Caddy/
   POSNET não são recriados. O build usa disco/instância existentes; nenhum recurso
   pago é criado. Se essa etapa falhar, Mac fica protegido e nenhum worker AWS liga.
5. **Terminação autorizada**: reconfirma os arquivos e bancos protegidos, identidade
   e estado suspenso. Registra intenção durável, envia um SIGHUP ao dono e CONT para
   permitir entrega; depois retoma somente o supervisor conhecido para recolher o
   filho. Nenhum TERM/KILL de grupo. Não aguarda finally da instância defeituosa:
   trabalho apenas em memória pode desaparecer. Só prossegue após PID realmente
   inexistente (ESRCH), não apenas ausência de socket ou processo zumbi.
6. **Arquivo do lock morto**: sob guard exclusivo, verifica novamente PID morto,
   inode/dev/UID/conteúdo do lock e dados protegidos. Renomeia somente esse lock
   para arquivo de auditoria no mesmo filesystem; o backup externo já contém cópia.
   Nunca remove lock de dono vivo nem guard alheio. JSON/bancos permanecem iguais.
7. **Exportação/importação**: auditoria Mac atual sem consumidores/locks; exporta
   somente scheduler journals, não checkpoint/bancos/credenciais. A AWS faz backup
   e merge por máximos, preservando todos os prazos; recibo por hash torna a
   importação repetida somente leitura quando já concluída.
8. **Cooldown/partida**: espera o maior prazo efetivo e reaudita o Mac imediatamente
   antes da partida. Preserva overlays e muda somente gates do worker. Compose up
   apenas worker, --no-deps/--no-build/--pull never, consumo exclusive/noAck=false.
   Caso a resposta de uma partida anterior tenha se perdido, só adota a instância
   quando imagem/gates/horário corresponderem ao recibo; nunca cria outra.
9. **Validação real**: até 15 minutos de observação do checkpoint AWS com orçamento
   de memória, sessões/snapshots atuais, handoff/ready e atualizações de mercado
   separadas de keepalive; conta eventos/preços/seleções e motivos de bloqueio.
   Não faz diagnose HTTP ao fornecedor em paralelo nem força consultas/available.

## Retomada, falhas e registros

O progresso é salvo em arquivo 600 fora do Git:
`~/Library/Application Support/ADL/Cutover/execution-12811-12809.json`.
Registra commits do executor, etapa, início, sucesso/resultado e falha sanitizada.
A proteção mantém registro separado em ADL/Recovery e conserva todos os backups
anteriores. Gate local de executor na porta loopback43761 evita duas sequências
simultâneas e é liberado pelo sistema ao terminar. Não serve aplicação/segredos.

Cada sucesso é reutilizado. Locks, identidade, hashes e gates atuais de segurança
são revalidados, mesmo quando o resultado anterior existe. Interrupção num instante
incerto entre envio de sinal e gravação de confirmação **não** autoriza repeti-lo;
nessa falha real o executor preserva tudo e identifica a etapa. Depois de saída
confirmada, a retomada pode concluir o arquivo do lock sem reenviar SIGHUP.

Durante proteção, o processo fica suspenso com memória e lock preservados. Falha
em backup/imagem não liga AWS nem restaura dados automaticamente. Durante/apos
terminação, nunca relançar Mac automaticamente; primeiro verificar estado real e
journals atuais. Se AWS falhar, fica pendente com diagnóstico/código/retryAt. O
mesmo comando retoma etapas idempotentes, sem redefinir prazos. Worker que já saiu
após partida confirmada exige análise da falha registrada, não restart cego.

`realFeedSnapshotsVerified=true` só é emitido após observação real das duas lanes
na AWS. `projectionOddsAvailable` é separado: snapshots com eventos encerrados
não comprovam odds abertas. `iframeAuthenticated=false`/`authenticatedApiVerified=false`
continuam explícitos até cadastrar admin/cliente/operação e sessão da homologação
separada. Não importar Argentina Demo ou bilhetes do Mac para preencher essa etapa.

## Validação no ambiente Codex

Testes isolados exercitam suspensão/backup/terminação por HUP/reap/arquivo após
morte real do fixture; dois bilhetes liquidados com odds aceitas preservadas,
SQLite WAL, ACK após persistência, retomada de etapas, merge/cooldown, imagem e
modelo Compose. Há teste Docker offline como usuário node, rede none e memória
limitada. Eles não comprovam parada no Mac, credenciais LSports, snapshot grande,
feeds reais nem iframe autenticado na AWS. Esses resultados só virão da execução
acima no Mac com sua chave existente.
