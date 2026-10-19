# PreMatch particionado e mensagem 38

## Entrega e contrato confirmado

O diagnóstico protegido confirmou PreMatch 4511 excedendo 268435456 bytes com HTTP
200 no container atual. Não aumentar o teto, heap ou instância. O worker mantém
container de 4 GiB e heap de 3072 MiB; InPlay 4510 continua com recuperação e limite
anteriores. O relatório existente é reutilizado, sem repetir migração ou assinaturas.

Verificado no SDK oficial **trade360-nodejs-sdk 3.10.10** instalado e na fonte oficial:

- `SubscriptionService.getSubscriptions(new GetSubscriptionsRequestDto({}))`:
  POST customers `/Fixtures/Get`, sem filtros, `SubscriptionsCollectionResponse.fixtures`
  mapeado de `Body.Fixtures: number[]`. O DTO não tem paginação; não inventar parâmetros.
- `GetEventRequestDto({fixtures: ids})`: POST snapshot `/Prematch/GetEvents` com
  filtro de fixtures. O SDK injeta autenticação/packageCredentials exclusivamente no
  servidor. Isto consulta assinaturas existentes; não chama subscribe/unsubscribe.
- [OutrightLeagueFixtureUpdate oficial](https://github.com/lsportsltd/trade360-nodejs-sdk/blob/main/src/entities/message-types/outright-league-fixture-update.ts)
  declara `EntityKey(38)`. O contrato é `Competition.Competitions[].Events[]`, cada
  evento com `FixtureId` e `OutrightLeague`, e não o contrato plano de 37/41.
  `OutrightLeagueFixture` contém nome, subscription, sport, location, LastUpdate,
  StartDate, status, extraData, EndDate e season. Não é placar, odds ou liquidação.

A fonte GitHub do tipo 38 foi consultada com sucesso. O portal docs.lsports.eu estava
inacessível deste ambiente; não foi usada especulação para preencher esse acesso.
O SDK fixado e seus DTOs/serviços/transformadores constituem a evidência implementada.

## Recuperação e memória

Ativada somente no PreMatch por `LSPORTS_PREMATCH_PARTITIONED_SNAPSHOT=true` no
novo override privado do worker. Não há fallback para GetEvents sem filtro.

1. Obter e validar todo o inventário: SDK/raw com mesma contagem/valores, sem erros
   de aplicação, IDs inteiros positivos, máximo 50000 entradas/2 MiB. Canonizar
   repetições de IDs sem perder nenhum fixture; comparar os conjuntos completos.
   Nunca usar os eventos já publicados como inventário completo.
2. Marcar baseline pendente e processar sequencialmente lotes de até 10 IDs, cada
   resposta limitada a 16 MiB. Em estouro, subdividir o lote respeitando o cooldown
   registrado. Um fixture único denso pode usar 32 e depois 64 MiB, sempre com nova
   admissão de memória e cooldown da falha; acima de 64 MiB permanece bloqueado.
   Nunca se eleva o teto original de 256 MiB nem o heap.
3. Exigir que cada resposta contenha exatamente os IDs solicitados. Persistir cada
   lote e liberar seu array, sem concatenar uma resposta completa de centenas de MiB.
4. Consultar novamente o inventário sem filtros e exigir igualdade com o inicial.
   Inventário alterado, dados ausentes, filtros ignorados ou resposta inválida impedem
   concluir o baseline; não são ausência bem-sucedida de eventos.
5. Somente após todos os lotes, verificação e handoff serial, registrar lastSnapshotAt
   e permitir connected. Fixture/seletor fechado, odds não reconfirmadas ou timestamps
   antigos continuam bloqueados. Um inventário comprovadamente vazio não gera
   `GetEvents({fixtures:[]})`, pois um filtro vazio poderia consultar todos.

Orçamentos de admissão por operação: inventário 80 MiB; lote inicial 192 MiB (320/576 MiB para fixture denso em 32/64 MiB); margem adicional
para aplicação/persistência equivalente ao orçamento de 64 MiB (576 MiB). A admissão
usa heap V8 e memória disponível e permanece ativa durante toda a recuperação.
São estimativas conservadoras de conversão, não garantia absoluta de RSS. O estado
final também precisa caber no worker: falta de memória interrompe/deferirá sem
liberar baseline parcial, em vez de ignorar o guard ou produzir dados fictícios.

Os journals e paths existentes são preservados. O scheduler grava cada requisição
antes do HTTP, com recoveryId/partitionPart. O primeiro lote respeita o cooldown
anterior; continuadores só avançam depois do próprio lote bem-sucedido, mantendo
espaçamento global por host e exclusão por lock. Falha/429 nunca habilita continuação
antecipada; Retry-After/backoff e cooldown de falhas são preservados. Outro processo
ou nova sessão/recoveryId não pode herdar essa permissão. InPlay pode usar o mesmo
host entre lotes, sem aguardar um lock ocupado por toda a recuperação.
GetSubscriptions do diagnóstico também participa do coordenador de inventário.

AMQP e lotes passam pela mesma fila serial de aplicação/persistência; ACK somente
depois de gravar resultados e projeção. Durante cooldowns longos o AMQP continua
processando, sem manter 100 mensagens presas até o fim do snapshot. Versões UTC e
precisão existentes arbitram atualizações: HTTP antigo não sobrescreve AMQP recente.
O estado permanece recovering, portanto processar keepalive não libera odds.

Contadores de progresso ficam no checkpoint em `connections.prematch.partitionRecovery`
(inventário/digest, lotes, fixtures concluídos, cap, retryAt). Após reinício/reconexão,
um novo inventário/baseline é obrigatório; não reutilizar lotes históricos como
preços atuais. Os dados/resultados já persistidos não são apagados nem migrados.

## Tipo 38

Handler próprio usa o transformador oficial, valida hierarquia/contagens/IDs/datas
antes de aplicar e preserva competition/season e metadados. Mescla participantes e
mercados anteriores, preservando odds aceitas e settlements; não infere resultados.
Forma inválida falha com diagnóstico sanitizado e requeue, não ACK de descarte.
A fila existente entrega novamente a mensagem anteriormente bloqueada ao reconectar.

## Comando único no Mac

```bash
cd "$HOME/LSports" &&
git pull --ff-only origin feat/sportsbook-demo &&
node deploy/homologation/complete-adl-cutover.mjs --pid 12811 --parent 12809 --partitioned-recovery
```

Lê o relatório protegido `ADL/Cutover/snapshot-volume-12811-12809.json`, confirma
migração concluída e consumidor Mac ausente. Não sinaliza os PIDs antigos.

Preparação constrói imagem derivada da imagem atual, após verificar hashes dos
arquivos de base. Copia somente fontes permitidas; build sem rede/pull e teste
Docker offline de tipo 38/partições antes da parada. Não copia .env, credenciais,
checkpoints, bilhetes ou dados de exemplo para a imagem. API/Caddy/POSNET intactos.

Ativação reaudita o Mac, pede SIGTERM uma vez ao container AWS, espera saída e
liberação dos locks, faz backup offline de checkpoint/journals com SHA-256 e salva
recibo/deployment anteriores em diretório protegido. Acrescenta somente imagem do
worker e flag de partição; compara o modelo Compose completo antes de gravar.
Não altera limites de InPlay, memória, redes, volumes, credenciais ou outros overrides.
Como os dois feeds compartilham o processo, ambos reconectarão uma vez no reinício.

O recibo privado `partitioned-upgrade-<digest>.json` registra prepared →
stop_requested → stopped → configured → start_requested → running. Reexecutar o
mesmo comando reutiliza imagem/fases, sem repetir sinal já registrado ou recriar
worker já validado. Lock remanescente é preservado; falha após pedido de partida
não provoca reinício cego. Backups ficam em `/var/backups/adl-partitioned-upgrade-*`.

Acompanha até 45 minutos, salvando o progresso. Ready exige snapshots em ambas as
sessões atuais, baseline completo e checkpoint recente; reporta odds selecionáveis
separadamente. Se atingir o prazo, o worker continua e o comando pode ser retomado.
Se novo payload incompatível ocorrer, exibe tipo/contagens de forma/requeue sem
payload ou credenciais, mantendo a entrega para revisão. Não forçar ACK/available.

## Validação e limites de evidência

Testes locais cobrem inventário incompleto/alterado, filtros ignorados, divisões,
Retry-After, coordenação entre processos/feeds, memória finita, ACK após persistência,
requeue em falha, timestamps/versões, participantes e settlements no restart.
Um servidor HTTP isolado com SDK oficial entregou **280 MiB cumulativos em 28 lotes**,
com limite individual de 16 MiB e processo de teste com heap de 1 GiB. Outro teste
forçou resposta de 17 MiB e validou subdivisão, sem elevar o cap. Nenhuma dessas
amostras é publicada na aplicação como evento ou cotação real.

Docker local, sem rede/segredos/volumes, valida os imports, decoder 38 e execução da
partição na imagem derivada. Build de frontend/API/worker e testes de simulação
continuam separados da validação real AWS. O ambiente de desenvolvimento não tem
acesso ao Mac/chave SSH: emissão real/ACK do payload 38, snapshots do fornecedor e
odds reais só serão confirmados pelo comando acima. Autenticação do iframe não é
simulada por esse monitor e ainda exige sessão própria de homologação.

`distribution_still_off` e AMQP 320 são bloqueios independentes. Não são declarados
resolvidos por esse patch; a validação continua mostrando suas causas/horários para
o ticket 217525, sem cancelar assinaturas ou forçar consultas fora dos cooldowns.
