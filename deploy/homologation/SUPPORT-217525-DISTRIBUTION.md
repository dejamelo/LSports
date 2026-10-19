# Ticket 217525 — distribuição PreMatch / revisão de 19-10-2026

## Resultado da revisão

Fonte de evidência: captura enviada pelo operador após `--inventory-repair`.
Não houve acesso ao Mac/SSH nesta revisão, consulta ao fornecedor, reinício,
ativação/desativação de distribuição ou repetição da migração.

SDK oficial instalado: `trade360-nodejs-sdk@3.10.10`. A chamada e os DTOs usados
pelo adaptador correspondem ao SDK:

- `PackageDistributionHttpClient.getDistributionStatus(StatusResponseBody)`:
  POST `/Package/GetDistributionStatus` no Customers API;
- `startDistribution(StartResponseBody)`: POST `/Distribution/Start`;
- JSON de credenciais do SDK: `packageId`, `username`, `password`, somente no servidor;
  o cliente SDK não usa `Authorization: Bearer` nesse contrato. Não alterar a grafia
  dos campos do SDK nem transportar credenciais para navegador, relatório ou logs.
- `Body.Message` de Start mapeia para `StartResponseBody.message`;
  enum oficial: `Distribution is: Active` ou `Distribution is already Active`;
- o status autoritativo é **booleano** `Body.IsDistributionOn`, mapeado para
  `StatusResponseBody.isDistributionOn`. Mensagem/HTTP 2xx não confirmam snapshot,
  odds nem distribuição ativa; string `"false"` não é aceita como booleano.

**Falha local demonstrada:** `DistributionUtil.start()` do SDK aguarda
`distributionPropagationDelayMs` antes de `checkStatus()`. O padrão oficial é
2000 ms. Nosso adaptador reconsultava imediatamente; os 2000 ms existentes em
`session()` só ocorriam depois de esse método retornar, portanto não cobriam essa
conferência. As tentativas da captura duraram menos de 2 s no total e não observam
a espera oficial. Não se pode afirmar, com esses dados, que o status já deveria
estar ativo após a propagação, nem atribuir o bloqueio inteiro ao fornecedor.

Correção preparada: esperar o padrão oficial antes da única reconsulta; não adicionar
polling/Start/Stop extras. Guardar apenas a classe reconhecida da mensagem de Start
(`activated`, `already_active`, `missing`, `unrecognized`) e o atraso aplicado.
Texto arbitrário do fornecedor nunca é emitido. O controle atual de status booleano
é mantido. Essa revisão **não foi aplicada no worker AWS** e não altera a migração.

## Evidências da captura — todos os horários UTC em 2026-10-19

| Operação | Início da sessão/tentativa | Fim registrado | Evidência |
|---|---|---|---|
| distribution.start / PM 4511 | 13:15:50.578Z | 13:15:51.948Z | before=false, startRequested=true, after=false |
| amqp.connection / PM 4511 | 13:15:54.408Z | 13:18:48.460Z | código 320, connection_closed, connection_forced |
| distribution.start / PM 4511 | 13:18:53.715Z | 13:18:55.590Z | before=false, startRequested=true, after=false |
| amqp.connection / PM 4511 | 13:19:04.816Z | 13:21:48.327Z | código 320, connection_closed, connection_forced |
| distribution.start / PM 4511 | 13:22:05.589Z | 13:22:06.972Z | before=false, startRequested=true, after=false |

O horário **13:14:15.329Z** aparece no início truncado da captura, sem o nome
do campo visível. Não foi classificado como horário de fechamento; só os dois
fechamentos com `endedAt` identificável acima integram a análise temporal.

InPlay 4510: connected, snapshot da sessão concluído às **13:18:55.219Z**;
`regularSnapshotReady=true`, controles recebidos até **13:22:06.351Z**. Atualizações
de eventos, mercados e liquidações aparecem nulas nessa sessão: isso não comprova
odds ao vivo. Projeção agregada: 622 eventos, 995 mercados, 8285 preços e zero
seleções disponíveis. Contagens agregadas não provam que esses preços sejam atuais.

O erro `distribution_still_off` é uma classificação do **nosso adaptador** após
consultar status, não um código de rejeição emitido pela LSports. A captura não
registra o HTTP exato nem `Body.Message` do Start; não afirmar HTTP 200, mensagem de
aceitação ou erro de credenciais sem esses campos. AMQP 320/connection_forced é
independente; não prova ack_timeout, heartbeat_timeout ou fechamento administrativo.

## Mensagem técnica pronta — contexto preliminar, sem culpar o fornecedor

**Subject: Ticket #217525 — Test package 4511: broker AMQP 320 closures and distribution status / propagation timing**

Hello Szymon / LSports Support,

We are investigating PreMatch Test package **4511** after moving its only consumer
to AWS (public egress IP **77.113.150.100**). The Mac consumer remains stopped;
we have not changed queues or subscriptions. InPlay Test package **4510** runs in
the same AWS worker and completed a session snapshot at **2026-10-19T13:18:55.219Z**.

Our pinned official Node SDK is **trade360-nodejs-sdk 3.10.10**. We use Customers API
POST `/Package/GetDistributionStatus` and POST `/Distribution/Start`, with the SDK's
server-side package credential DTO. We interpret `Body.IsDistributionOn` as a
boolean, not Start's `Body.Message` as proof of activation.

**We found a client timing defect:** the post-Start status check ran immediately,
whereas the official SDK distribution utility waits for propagation (default
2000 ms). We have prepared and locally tested a correction, but have **not yet
restarted/deployed it to the AWS consumer**. The observations below are pre-fix,
so we are not claiming a provider activation failure after the proper delay.

Observed UTC on **2026-10-19**, package 4511:

- distribution attempts **13:15:50.578–13:15:51.948**,
  **13:18:53.715–13:18:55.590**, and **13:22:05.589–13:22:06.972**:
  our status-before/status-after were both false. `distribution_still_off` is our
  local diagnostic label. The exact Start HTTP status/message is not in this capture.
- Separate broker connection endings at **13:18:48.460** and **13:21:48.327**
  reported AMQP **320**, `connection_closed`, `connection_forced`.
  We cannot determine the broker-side cause from code 320 alone.

PreMatch endpoint: `stm-prematch.lsports.eu`, vhost `StmPreMatch`, existing queue
`_4511_`. Please correlate these times in your broker/distribution logs and confirm:

1. What initiated each AMQP 320 closure (broker reason and any internal event ID)?
2. Is 2000 ms the appropriate propagation delay for this Test package, or is a
   different readiness rule required before rechecking status/connecting AMQP?
3. Do your logs show Start accepted for package 4511, and was any package-specific
   distribution restriction, source-IP restriction or other consumer present?
4. Do the broker closures and distribution status changes have a documented causal
   relationship for this package?

Please do not cancel/recreate subscriptions or queues while investigating. We can
provide additional sanitized operation timings on request; no credentials, tokens
or authenticated URLs are included here.

Thank you.

## Referências e testes

Fontes oficiais equivalentes às classes instaladas (links `main`; versão examinada
foi a distribuição npm 3.10.10):

- [distribution.service.ts](https://github.com/lsportsltd/trade360-nodejs-sdk/blob/main/src/api/customers-api/services/distribution.service.ts)
- [distribution-util.ts](https://github.com/lsportsltd/trade360-nodejs-sdk/blob/main/src/utilities/distribution-util.ts)
- [config-constants.ts](https://github.com/lsportsltd/trade360-nodejs-sdk/blob/main/src/feed/types/config-constants.ts)
- [start-response-body.ts](https://github.com/lsportsltd/trade360-nodejs-sdk/blob/main/src/api/common/distribution/responses/start-response-body.ts)
- [status-response-body.ts](https://github.com/lsportsltd/trade360-nodejs-sdk/blob/main/src/api/common/distribution/responses/status-response-body.ts)

Testes locais com servidor HTTP isolado e SDK real verificam sequência POST,
campos de autenticação do SDK, espera antes da reconsulta, estado já ligado sem
novo Start, resposta desconhecida sanitizada, tipo booleano e rejeição HTTP 403.
Não equivalem a nova validação real na AWS. A aplicação deve ser programada como
atualização controlada, nunca reinício cego para testar repetidamente o provedor.

## Aplicação autorizada e evidência posterior

A mensagem acima preserva a evidência **anterior** à correção. Para aplicar com um
único comando, ver [APPLY-DISTRIBUTION-2aa06f7.md](APPLY-DISTRIBUTION-2aa06f7.md).
O executor gera um novo rascunho protegido fora do repositório com os resultados reais
posteriores, sem reapresentar os horários históricos como se fossem da versão nova.
