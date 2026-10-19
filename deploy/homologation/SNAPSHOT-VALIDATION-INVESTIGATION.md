# PreMatch: investigação somente leitura de invalid_snapshot

Evidência recebida em 19/10/2026: antes da atualização, o validador registrou
`phase=batch`, `code=batch_id_mismatch`, `requested=10`, `received=0`,
`missing=10`, `unexpected=0`. Depois da correção de propagação, a saída resumida
registra apenas `invalid_snapshot`; não prova que a mesma causa persiste.

## Contrato e pontos de rejeição

A implementação oficial instalada `trade360-nodejs-sdk@3.10.10` contém:

- `dist/src/api/snapshot-api/services/prematch-snapshot.service.js`:
  `getEvents` mapeia GetEventRequestDto para GetEventRequest e faz POST em
  `/Prematch/GetEvents`, convertendo Body para GetEventsResultElement.
- `dist/src/api/common/snapshot/requests/event-request.js`: filtro `fixtures`,
  array numérico. Nosso código envia `new GetEventRequestDto({fixtures:ids})`.
- `dist/src/api/common/snapshot/responses/events-response.js`: `FixtureId` →
  `fixtureId` (Number), `Fixture` → `fixture`, `Markets` → `markets`.

O adaptador local exige resposta não nula, IDs seguros, Fixture objeto e
contagem SDK igual à contagem bruta observada. Falha nessa etapa recebe
`batch_invalid_fixture` (attribution=not_proven); esse código agrupa causas,
portanto sozinho não identifica o campo defeituoso.

O coordenador particionado exige correspondência exata entre IDs solicitados e
retornados, sem duplicatas. `batch_id_mismatch` é rejeição de **completude do
lote**, não necessariamente tipo ou campo inválido. Zero rows passa pela
validação estrutural do array vazio e falha na completude. O filtro fixtures
é suportado pelo SDK; o SDK não estabelece que todo ID do inventário de
assinaturas necessariamente aparece no snapshot PreMatch. Uma assinatura pode
exigir esclarecimento de disponibilidade/cobertura pelo fornecedor. Não foi
comprovado que essa é a causa desta resposta.

Não há comprovação suficiente para alterar o parser, classificar a ausência
como erro do fornecedor ou dispensar IDs ausentes do baseline. Não foi
consultado o fornecedor ao executar os testes desta investigação. A comparação
acima é com o código oficial instalado, não nova confirmação do suporte.

## Coleta única usando dados existentes

No Mac:

```bash
cd "$HOME/LSports" &&
git pull --ff-only origin feat/sportsbook-demo &&
node deploy/homologation/complete-adl-cutover.mjs --pid 12811 --parent 12809 --snapshot-validation-report
```

Executa preflight somente leitura, confirma ausência do consumidor Mac e lê
uma vez o status/checkpoint/logs já existentes via SSH. Não inicia/reinicia
workers, não invoca endpoints LSports nem espera novo snapshot. Não altera
locks, journals, overrides, volumes, bilhetes ou POSNET. O executor mantém seu
registro local habitual; o relatório protegido é salvo fora do repositório em
`~/Library/Application Support/ADL/Cutover/snapshot-validation-12811-12809.json`.
Mostra os diagnósticos atuais e históricos separadamente, códigos de validação,
contagens, timestamps, fase particionada e até cinco IDs ausentes já registrados.
Não exporta payloads, mensagens livres, credenciais, headers ou URLs.

Os corpos HTTP rejeitados não são retidos pelo adaptador: se os códigos e
contagens persistidos forem insuficientes, não se pode recuperar seu conteúdo
por leitura local. Não se deve alegar conhecer a estrutura bruta real sem
ela. Nesse caso, solicitar ao suporte o retorno de `/Prematch/GetEvents` dos
IDs ausentes nos horários UTC registrados (com credenciais removidas) e
confirmar se pertencem ao snapshot PreMatch ou a outra família/estado. Não
fazer consultas extras nem flexibilizar validação para obter baseline verde.

## Testes

`node --test deploy/homologation/snapshot-validation-report.test.mjs` verifica
sanitização, separação temporal e preservação de desconhecido versus zero.
`node --import tsx --test apps/worker/src/partitioned-snapshot.test.ts` exercita
SDK oficial contra HTTP local isolado, filtros e conversão, lote incompleto,
inventário, backoff, limites e bloqueio de preços antes do baseline completo.
Isso não valida a resposta real da AWS ou a disponibilidade da LSports.
