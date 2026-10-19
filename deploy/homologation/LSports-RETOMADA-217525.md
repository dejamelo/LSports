# Retomada pendente da LSports — ticket #217525

## Estado comprovado e preservado

Migração concluída. Worker do Mac parado, journals exportados/importados,
cooldowns preservados; não repetir cutover, assinaturas ou migrações.
API AWS e HTTPS tiveram validação anterior. O painel atualizado requer a
publicação API-only descrita em `API-PANEL-UPDATE.md`.

Evidência informada pelo operador: PreMatch 4511 e InPlay 4510 recusados com
AMQP 403 em `amqp.connect` desde **2026-10-19 18:18:45 UTC** até **19:35 UTC**.
Relatório protegido já coletado no Mac:
`~/Library/Application Support/ADL/Cutover/startup-12811-12809.json`.
`credentialsEqualToPrevious:true` e `connectionSettingsEqualToPrevious:true`
nas duas lanes, inclusive container versus Compose; imagem corresponde ao
código esperado. Igualdade não comprova que credenciais continuam válidas ou
que o broker permite conectar enquanto Distribution está desligada.
Não coletar novamente sem uma pergunta que o relatório anterior não responda.

A última atualização mudou a ordem: conecta e registra consumidor antes de
Distribution/Start, para consumir continuamente durante snapshots. SDK/ordem
anterior ativava antes de conectar. O 403 sozinho NÃO prova dependência entre
ativação e autenticação. Não mudar a AWS apenas por hipótese.

Confirmações anteriores do fornecedor continuam válidas: todos timestamps UTC;
/GetEvents sem filtro fixtures fornece PreMatch atual; /Fixtures/Get é histórico;
snapshot completo a cada 15 s, filtrado a cada 1 s; fila 10.000 não lidas desliga
distribuição/força AMQP 320; Stop antes de parada planejada. Preservar spool em
disco com memória limitada, persistência antes de ACK e ordenação por versão.

## Resposta necessária do fornecedor

No ticket existente, pedir causa exata do 403 em amqp.connect por pacote:
autenticação, permissão de vhost, restrição da conta/ambiente ou bloqueio por
Distribution OFF; confirmar validade atual das credenciais e permitir conexão
exclusiva da AWS (nenhuma chave deve ser enviada no chamado). Pedir confirmação
escrita se Connect + Consume são permitidos antes de Distribution/Start; caso
contrário, ordem obrigatória e tempo de propagação. Não solicitar purge, novas
assinaturas pagas ou reset sem justificativa do fornecedor.

## Decisão e aplicação após resposta

- Se corrigirem autorização no broker: observar a reconexão normal, respeitando
  retryAt e cooldown. Não é necessário reiniciar apenas para tentar.
- Se confirmarem outra ordem contratual: ajustar/testar a sequência conforme a
  resposta, mantendo consumo contínuo após propagação e persistência antes do ACK.
  Só então preparar imagem do worker e parada planejada com Distribution/Stop.
  Não usar a atualização API-only para trocar a imagem do worker.
- Se pedirem evidência específica nova: coletar somente essa diferença, sem
  novas consultas snapshot nem reinício genérico.

O executor de validação existente reaproveita o progresso e não repete migração:

```bash
cd "$HOME/LSports" &&
node deploy/homologation/complete-adl-cutover.mjs \
  --pid 12811 --parent 12809 --validate-only
```

Os IDs identificam o registro histórico do cutover, não autorização para enviar
sinais a processos atuais. Usar **depois** de resposta/ação concreta do fornecedor;
não executar agora apenas para aguardar novamente. Não ativar --full-recovery,
--recover-and-cutover ou reparos de imagem sem a causa correspondente.

## Critérios de conclusão real na AWS

1. Uma execução AWS por feed, Mac continua sem consumidor; nenhuma nova recusa 403.
2. Consumidor registrado e mensagens efetivamente persistidas antes do ACK;
   lastAckAt e acknowledgedMessages avançam nas duas lanes. Consumidor ocioso
   sem mensagens não comprova consumo contínuo; keepalive não é atualização de odds.
3. Snapshots atuais completos nesta sessão, inventário atual e handoff concluídos;
   PreMatch recuperado por spool controlado, sem limites removidos ou fila purgada.
4. Atualizações novas de eventos/mercados com versões válidas, preços atuais e
   seleções abertas disponíveis pelo backend. Não reutilizar preços do checkpoint,
   não reabrir liquidados e não aceitar baseline incompleta.
5. Sessão iframe autenticada da operação AWS, origem autorizada e isolamento;
   selecionar cuota real aberta, registrar bilhete SIMULADO e consultar comprovante.
6. Idempotência, persistência e liquidação por resultados recebidos validadas nessa
   operação; se o fornecedor não fornecer settlement durante a janela, registrar
   essa validação pendente. Não fabricar resultados ou apostas retroativas.

O relatório de feeds não valida login do proprietário nem iframe autenticado;
essas etapas devem constar separadamente. Container running e testes locais não
satisfazem os critérios. Zero odds pode ser indisponibilidade real do fornecedor:
reportar motivos de bloqueio do servidor em vez de forçar abertura.

## Escopo suspenso

APK, JICAI Q2, impressoras e integração de terminais foram suspensos pelo
proprietário. Não há APK conectado ao projeto; nenhum artefato Android integra
esta publicação. POSNET Lottery permanece independente e intocado.
