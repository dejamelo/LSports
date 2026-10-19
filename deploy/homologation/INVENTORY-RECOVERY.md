# Inventário pendente após recuperação particionada

## O que a evidência permite afirmar

`completedFixtures:0` e `batches:0` não comprovam um inventário vazio. Sem o corpo
sanitizado ou contagens da rejeição, `invalid_snapshot` sozinho não identifica qual
campo falhou. A captura não prova IDs como strings/objetos, autenticação incorreta
ou ausência de fixtures. Não se relaxa o contrato `Body.Fixtures: number[]` do SDK
oficial 3.10.10 nem se usa a projeção como inventário.

Três falhas locais foram reproduzidas e corrigidas:

- AMQP só saía do buffer no callback `begin(ids)`, chamado depois de obter o
  inventário. Esperar por cooldown do próprio inventário podia reter as 100
  entregas sem ACK. Agora o baseline é bloqueado e a fila serial de persistência/ACK
  é liberada **antes** da consulta/espera do inventário. Isto remove a retenção
  local; não prova que o broker fechou especificamente por timeout de ACK.
- A validação completa dos IDs acontecia **depois** de `subscriptions.list` retornar
  ao coordenador. Um inventário rejeitado podia aparecer como `outcome:success`,
  perder o status HTTP e acabar sob o rótulo genérico `snapshot.events`. Agora a
  validação ocorre dentro da operação HTTP/coordenada, antes de registrar sucesso;
  rejeição grava `failed`, HTTP/envelope, código, fase e contagens, sem payload.
- Um baseline particionado inválido (`invalid_snapshot` e demais erros de validação HTTP/SDK) escapava da recuperação e encerrava a sessão AMQP. Agora
  mantém `recovering`, baseline falso e odds bloqueadas, aplica/persiste/ACKs deltas
  válidos e agenda nova tentativa respeitando o cooldown. Não reinicia distribuição
  só por falha no baseline HTTP. Mensagens inválidas continuam sem ACK e em requeue.

`partitionRecovery.stage:waiting` agora informa `waitingFor`; rejeição conhecida
fica em `failed`, sem reutilizar um `retryAt` antigo como se a consulta ainda estivesse
apenas esperando. Nenhum HTTP 200 isolado é considerado baseline completo.

## Diagnóstico sem segredos

`snapshotValidation` contém somente códigos fixos, tipos e contagens:

- `inventory_envelope`: `Body.Fixtures` não é array conforme contrato do SDK;
- `inventory_invalid_ids`: quantidade/tipos de IDs inválidos; não converte/omite IDs;
- `inventory_limit`: limite local de 50000 entradas preservado;
- `inventory_sdk_mismatch`: raw/SDK divergem em contagem ou IDs;
- `batch_invalid_fixture` / `batch_id_mismatch`: problema no lote, não no inventário;
- `inventory_changed`: inventário final diferente; exige outro baseline completo.

`attribution` diferencia limite local, contrato recebido, SDK/adaptador ou mudança
de inventário; `not_proven` explicita que ainda não foi possível atribuir a falha.
É a origem da validação rejeitada, não uma afirmação de culpa.
A instrumentação reconhece mensagens **constantes do nosso código anterior** em
checkpoints/logs e publica `legacyValidationCause`, sem imprimir texto arbitrário.
A causa do formato real ainda precisa dessa evidência na AWS; não foi inventada
uma correção do payload a partir da fotografia.

## Um comando no Mac

```bash
cd "$HOME/LSports" &&
git pull --ff-only origin feat/sportsbook-demo &&
node deploy/homologation/complete-adl-cutover.mjs --pid 12811 --parent 12809 --inventory-repair
```

Reutiliza migração/backup/relatório e salva em `inventoryRepairEvidence` o último
resultado do executor e uma leitura do checkpoint/logs/journals atuais **antes da
parada**. Essa coleta inicial não faz HTTP ao fornecedor. Não sinaliza PIDs antigos.

Verifica imagem/fontes da revisão 5069beb já aplicada, deriva/testa nova imagem
offline, reaudita ausência do consumidor Mac, encerra somente o worker AWS uma vez,
faz backup offline SHA-256 e atualiza somente sua imagem/flag existente. Preserva
POSNET, API, Caddy, segredos, volumes, todos os overrides, memória, limites InPlay,
assinaturas e journals. As etapas/recibos permitem retomar sem refazer migração.
Ambas as lanes reconectam uma vez por compartilharem o worker.

Acompanha somente consultas normais agendadas, sem probe extra ao fornecedor.
Se houver nova rejeição com diagnóstico da **sessão atual**, salva `inventoryRejection`
e retorna `INVENTORY_OR_BATCH_CONTRACT_REJECTED` imediatamente, com código e contagens;
não espera outros 45 minutos repetindo a mesma rejeição. Dados de sessão antiga
não comprovam nova falha. Distribuição persistentemente off ou AMQP 320 repetido
no container atual são relatados separadamente, sem forçar consultas/distribuição.
O worker permanece ativo e o Mac parado; nenhum bloqueio libera preços.

## Validação

Testes com SDK/HTTP isolados comprovam inventário válido, rejeição sanitizada,
coordenador registrando falha (não sucesso), cooldown após rejeição e nenhum lote
aplicado nessa condição. Teste de sessão comprova que um delta válido é persistido
antes do ACK enquanto o baseline está rejeitado, sem fechar/reabrir AMQP; cotações
continuam indisponíveis. Outro teste mantém o inventário pendente e exige o ACK de um delta antes mesmo
de chamar `begin(ids)`; falha se o worker voltar a segurar a fila nessa espera.
Testes do executor comprovam saída imediata com evidência,
sem reinício adicional nem repetição das etapas concluídas.

A aplicação real depende da execução no Mac/SSH. Este ambiente não tem essa chave;
nenhum snapshot/odds real foi declarado validado. Build e runtime Docker locais
passaram sem rede/segredos, incluindo decoder 38, inventário válido/rejeitado e lotes.
A cópia do overlay usa uma camada contendo somente as fontes permitidas, evitando
replicar a base para cada arquivo em drivers Docker que copiam camadas inteiras.
A falha inicial por disco cheio foi resolvida no ambiente local, sem reduzir guards.
O comando AWS exige construir e testar sua imagem antes de parar o worker. Se a próxima resposta contrariar
o SDK, o diagnóstico identifica o contrato específico para o ticket 217525, sem
senhas, tokens, URLs autenticadas ou payloads completos.
