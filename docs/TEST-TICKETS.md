# Bilhetes persistentes de teste

A interface existente registra bilhetes de **pontos fictícios**, sem dinheiro, carteira, depósito, débito ou pagamento. Demo e TRADE Test ficam identificados e separados na liquidação. Nenhum bilhete foi criado para 20540195: seus códigos confirmados (Groovinharmony=2, Vegas Vickie=1) validam apenas o mapeamento de resultados.

## Atualizar e executar no Mac

Pare `npm run dev` com Ctrl+C. No mesmo repositório, com Node >=22.13 (recomendado Node 24), execute este procedimento único:

```bash
cd ~/LSports
git switch feat/sportsbook-demo
git pull --ff-only origin feat/sportsbook-demo
npm ci
npm test
npm run build
npm run dev
```

Abra http://localhost:5173/sportsbook. Seu `.env` e `.runtime` permanecem no lugar; não copie `.env.example` sobre `.env`. Mantenha `DATA_MODE=connected` para usar seus feeds reais Test. Não é necessária nova variável. Opcionalmente `TEST_TICKETS_DB` altera o arquivo SQLite, **sempre com o mesmo valor na API e no worker**, relativo à raiz do repositório. Por padrão fica ao lado do `LSPORTS_STATE_FILE`, em `.runtime/test-tickets.sqlite`.

Escolha um evento atualmente aberto com odds reais, monte o bilhete, informe pontos e clique **Simular billete**. O servidor confirma o ID. Repetir a mesma requisição mantém esse ID; para outra aposta de teste use **Armar otro billete de prueba**. Suspensão, encerramento, resultado conhecido, preço alterado, seleção indisponível, feed desatualizado ou conexão perdida impedem nova aceitação. A interface não abre mercados nem oferece odds fictícias no modo conectado. O histórico abaixo dos eventos mostra odds aceitas, resultados, revisões e link de impressão.

Para verificar persistência, registre um bilhete de teste em um evento aberto, reinicie os processos e confira seu mesmo ID no histórico e em `GET /api/tickets/:id`. Um bilhete pendente continua pendente até resultados explícitos do fornecedor; não se infere resultado pelo status encerrado. O comprovante é de teste, sem valor monetário ou fiscal. Reimpressões mostram a revisão atual; um comprovante antigo pode ficar desatualizado após correção.

## Aceitação, persistência e liquidação

- SQLite nativo do Node, transações `BEGIN IMMEDIATE`, chave idempotente única, WAL e `synchronous=FULL`. Valores em centésimos de pontos; odds aceitas imutáveis com até seis casas; retorno calculado com inteiros e arredondado uma vez. Até 12 eventos distintos por combinada. Não há saldo nem movimentação financeira.
- `POST /api/tickets`: header `Idempotency-Key` (8–128 caracteres alfanuméricos, `:`, `_`, `-`), JSON `{ "stakeMinor":10000, "selections":[{"eventId":"ID local atual", "marketId":"ID local atual", "selectionId":"ID local atual", "expectedOdds":3.25}] }`. Não envie valores históricos para tentar aceitar uma aposta retroativa.
- Validação contra a projeção local mais recente, idade máxima 20 s e conexão do feed do evento. Não é ordem de aposta enviada à LSports e não garante preço executável no fornecedor. Repetir a mesma chave/corpo devolve o bilhete existente; reutilizar com outro corpo retorna conflito. O navegador conserva a chave da tentativa em sessionStorage quando disponível, inclusive em caso de resposta perdida.
- Worker grava os resultados no SQLite **antes** de publicar o checkpoint e dar ACK AMQP. Uma falha de persistência não confirma a mensagem. API também reconcilia os resultados locais ao consultar/criar bilhetes. Não faz novas chamadas ao fornecedor. Os IDs regulares são normalizados entre PreMatch/InPlay; IDs de Outright preservam competição/fixture/mercado/seleção.
- Resultados usam o mapeamento existente do SDK: `-1` cancelada, `0` sem liquidar, `1` perdedora, `2` ganadora, `3` reembolso, `4` meia perda e `5` meia vitória. Odds suspensas não são resultados. Código desconhecido mantém pendente com descrição explícita. Combinadas aguardam resultados reconhecidos de todas as pernas. Cancelamento/reembolso tem fator 1; meia perda fator 0,5; meia vitória fator `(odd+1)/2`. São regras do simulador, a homologar para qualquer produto financeiro.
- Resultados repetidos não incrementam revisão nem acumulam retorno. Correções mais recentes substituem a projeção de retorno e acrescentam histórico; resultado explícito 0 reabre como pendente. Atualizações antigas são ignoradas. Não há crédito em carteira a duplicar. Remover um evento do snapshot não apaga o bilhete nem o último resultado armazenado.
- Preserve **todo** `.runtime`: SQLite e arquivos `-wal`/`-shm`, checkpoint e cooldowns. Para backup simples consistente, pare API/worker antes de copiar o diretório; não copie apenas o `.sqlite` durante escrita. Arquivos ignorados pelo Git, sem credenciais. Não execute duas instâncias de worker para o mesmo checkpoint.

## Contrato preparado para APK POSNET

Não existe APK, SDK ou protocolo POSNET no repositório. Foi criado **nosso contrato REST de teste**, sem afirmar compatibilidade com um equipamento:

1. `GET /api/posnet/test/capabilities`: contrato `adl-rest-test-v1`, `hardwareValidated:false`.
2. `POST /api/tickets`, mesmo corpo acima, mais `channel:"posnet_test"` e `terminalId:"terminal-test-01"`. O APK deverá conservar sua chave idempotente por tentativa antes do envio.
3. `GET /api/posnet/test/print-jobs?terminalId=terminal-test-01`: jobs pendentes persistentes; cada um contém `ticketId` e `id` próprios.
4. `GET /api/tickets/:id` para dados estruturados ou `/api/tickets/:id/receipt` para HTML imprimível, com escape de nomes recebidos.
5. Após confirmação de impressão pelo hardware, `POST /api/posnet/test/print-jobs/:id/ack` com `{"terminalId":"terminal-test-01"}`. ACK repetido é idempotente e limitado ao terminal do job. Falha entre imprimir e confirmar pode exigir reimpressão: o APK deve deduplicar pelo ID do job; não existe garantia de impressão única sem suporte do dispositivo. Novas revisões de resultado aparecem no histórico/consulta, não geram automaticamente outro job de impressão.

Não há chamada para cobrar cartão ou movimentar dinheiro. Impressão Android depende do SDK real do dispositivo; o HTML não presume APIs de impressora. Não exponha estes endpoints de laboratório à Internet.

## Verificação realizada e bloqueios de produção

Testes isolados cobrem aceitação/rejeição, preço, desconexão, suspensão, encerramento, persistência e reinício, idempotência, correções/reabertura, resultados desconhecidos, cálculos inteiros, jobs POSNET e escape do comprovante. O script `npm run validate:local-ui` (Playwright/Chromium instalados) usa mensagens sintéticas explicitamente isoladas em diretório temporário: decode SDK → estado/checkpoint → API → React → aceitação → resultado → histórico → comprovante. Não consome filas, cria assinaturas ou altera retryAt. Dados de teste não entram em `.runtime`.

Bloqueios concretos antes de produção: autenticação e isolamento por usuário/terminal (o histórico atual é compartilhado no laboratório); HTTPS e autorização do iframe/POSNET; regras de risco/limites de apostas; carteira e ledger financeiro auditável; termos de correções/reembolso; homologação regulatória/fiscal; backup operacional e monitoramento; SDK/protocolo oficial e hardware do APK POSNET. É necessário homologar aceitação e correções com um evento aberto real no Mac, pois o ambiente cloud não possui credenciais nem o feed local. Também falta comprovar com a LSports recuperação de resultados perdidos durante indisponibilidade (especialmente bilhetes pendentes de eventos que já saíram do snapshot); a persistência não inventa esses resultados. O chamado 217525 e a disponibilidade de mercados/odds continuam dependentes do fornecedor. HTTP 200 ou conexão AMQP não comprovam aceitação/resultado em produção.
