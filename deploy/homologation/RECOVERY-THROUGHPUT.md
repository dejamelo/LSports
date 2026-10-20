# #217525: retomada após aplicação de coleções nullable

Evidência trazida pelo usuário: 3100 ACK PreMatch, fechamentos 320 às
2026-10-20T01:26:34.651Z e 01:34:54.159Z, snapshot completo sem conclusão. InPlay
ativo com `local_in_flight`. Esses horários são UTC; não são HTTP 429. Os ACKs e os
preços persistidos não comprovam baseline completo nem explicam o fechamento.

## Causas locais demonstradas e correções

1. O `SnapshotScheduler.run` envolvia download, duas passagens de parsing e aplicação
com persistência. Seu lock exclusivo por host ficava retido por trabalho local,
impedindo chamadas InPlay durante a recuperação PreMatch. Agora a reserva cobre
somente o download HTTP. Mantém espaçamento >=15s, refresh >=5min, timeouts e
backoff/journals. Sucesso nesse coordenador significa download concluído; validação
local tem progresso/diagnóstico próprio e continua necessária para baseline.
2. A aplicação disparava gravação de todo checkpoint/projeção por 10 fixtures:
11925 fixtures implicavam 1192 gravações completas adicionais. Removidas. A aplicação
do snapshot não é uma entrega AMQP a confirmar; heartbeat, commits AMQP e fechamento
ainda persistem. Cada ACK AMQP espera sua gravação durável, incluindo os resultados
e a liquidação normal. Não há ACK antecipado nem novo formato/WAL/migração.
3. Saves concorrentes de duas lanes e heartbeat podiam enfileirar cópias completas.
Agora compartilham apenas uma gravação QUE AINDA NÃO COMEÇOU. Uma requisição feita
após a captura ativa sempre aguarda captura posterior. Compartilhar a gravação já
ativa poderia confirmar dados não persistidos; esse caso é explicitamente testado.

O snapshot mantém duas passagens, valida TODO documento antes da primeira aplicação
e preserva null em Markets/Bets. Dados antigos permanecem bloqueados; atualizações
AMQP novas e liquidações mantêm ordem, persistência e reconciliação. Adicionados
progresso waiting_http/download/validate/apply/complete, linhas, bytes e duração de persistência.
Status de distribuição já consultado no fluxo normal fornece contadores de fila/
consumidores/taxa quando presentes; não são criadas consultas adicionais.

Adiamentos locais de coordenador agora retomam no retryAt registrado, sem
acrescentar cinco minutos como se fossem rejeição de conteúdo. O journal continua
impedindo consultas antes do prazo do fornecedor; isso não transforma local_in_flight
em HTTP429. A fase waiting_http distingue espera local de download iniciado.

AMQP 320 continua significando fechamento pelo broker. A política de 10000 não
lidos foi confirmada antes pelo suporte, mas NÃO está comprovada como motivo dos
fechamentos desta execução. O comando separa essa dúvida dos gargalos locais.

## Comando único retomável

Entry point: `--pid 12811 --parent 12809 --recovery-throughput-repair` com
ADL_REPO_ROOT e ADL_RUNTIME_REF explícitos. Não sinaliza PIDs históricos.

- Preflight de segurança; auditoria atual de ausência do worker Mac.
- Coleta READ ONLY dos registros desta execução, coordenador/locks preservados,
  metadados do spool, recursos e hashes de full-snapshot/provider/connected da
  imagem instalada. Confere recibo do teste capturado nullable. Só aceita runtime
  anterior conhecido (b63e735) ou a própria correção já testada/aplicada; divergência
  não provoca restart por tentativa.
- Guarda evidência anterior no ledger. Imagem derivada SOMENTE do worker, validação
  offline de sequência, fixture privado original/SHA, 1600 fixtures sem checkpoints
  redundantes e coalescência segura. API/POSNET/overrides/limites não mudam.
- Distribution/Stop antes de SIGTERM; drain, liberação de locks pelo dono, backup
  durável verificado de checkpoint/journals. Troca de imagem única. Journals mantêm
  cooldown. Não repete encerramento Mac, exportação, importação ou redimensionamento.
- Partida única e observação READ ONLY. Uma falha transitória pode usar a reconexão
  já implementada no runtime; o executor não reinicia o container. Dois novos 320
  encerram a validação com evidência, sem novo restart. Erros de autenticação,
  decode/ACK/persistência ou documento inválido não são ignorados.
- Recuperação exige snapshots atuais completos, consumidores registrados e ACK,
  updates reais de mercado nas duas lanes, seleções disponíveis e janela adicional
  de 120s com avanço de ACK E de timestamp de atualização de mercado em ambas.
  Se snapshots e registro estiverem prontos mas nenhuma seleção ficar disponível
  por 120s, termina com evidência dos bloqueios, sem repetir espera de 45min.
  Keepalive, snapshot isolado e preços armazenados não satisfazem esses critérios.

A prova anterior de runtime é reutilizada somente para os mesmos hashes de fontes
imutáveis. Assim uma interrupção após Stop não exige um consumidor vivo para
repetir a coleta. Antes de enviar qualquer sinal, o helper revalida a identidade
da imagem antiga e seu limite de 4 GiB.

Etapas `throughput_image` e `throughput_upgrade` e recibo remoto são reutilizados.
Reexecução depois da partida continua validação; não repete a troca da imagem.
API, painel em andamento, bilhetes, bancos, segredos, filas e assinaturas preservados.

Se continuar pendente, produz `recovery_summary` com aplicado/validado/bloqueio e
arquivo protegido versionado `support-217525-recovery-*.md` no Mac. Ele separa
fechamentos anteriores e posteriores à correção, local_in_flight e HTTP429, com
pacotes/horários/ACKs/snapshot/progresso. Não envia mensagens ao fornecedor sozinho
nem afirma falha dele sem prova; se houver 320 pós-correção, pede a causa exata no
broker e profundidade ready/unacked/taxas, inclusive confirmação da política de fila.
Uma lane sem atualizações reais suficientes termina pendente, sem habilitar odds.

Rollback preparado: mesmo executor/ref com `--recovery-throughput-rollback`. Volta
somente imagem e mantém o worker anterior parado, após Stop/drain. Não restaura
checkpoints antigos nem inicia Mac. Reversão concluída pode ser reexecutada sem
repetir ações; ausência de preparo bloqueia antes da mutação.

## Validação local

225 testes do worker; 52 testes do executor/status/validação. Incluem fila de saves
com versão capturada e promise de commit, 1600 fixtures sem saves por bloco de 10,
ACK após persistência, nulls e erro tardio sem aplicação parcial, snapshot >256MiB,
coordenador liberado durante aplicação mantendo espaçamento, coleta sem ler corpo
privado, estabilidade com mercado/ACK reais e ticket sem credenciais. Build TS e
imagem offline Docker com memória 384MiB aprovados. Nenhum feed real AWS foi
validado neste ambiente; os resultados reais vêm da execução no Mac.
