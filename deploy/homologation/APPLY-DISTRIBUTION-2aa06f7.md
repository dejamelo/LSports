# Aplicar a correção 2aa06f7 no worker AWS e validar

Autorização: operador aprovou o reinício necessário do worker, sem nova migração,
sem reiniciar POSNET e mantendo o Mac parado. O ambiente de desenvolvimento não
possui a chave do Mac/SSH; a aplicação e a validação reais ocorrem pelo comando.

```bash
cd "$HOME/LSports" &&
git pull --ff-only origin feat/sportsbook-demo &&
node deploy/homologation/complete-adl-cutover.mjs --pid 12811 --parent 12809 --distribution-repair
```

Os PIDs identificam o progresso existente; não são sinalizados. Nenhum worker Mac
é iniciado. A chave usa o padrão já validado em Downloads, sem imprimir conteúdo.

## Escopo verificável

- Exige migração concluída, upgrade anterior e auditoria atual de zero consumidores
  no Mac. Reutiliza recibos, sem copiar/importar novamente journals ou bilhetes.
- Confere as fontes da imagem AWS contra **941b7c8**, que estava aplicada. Exige a
  correção **2aa06f7** na revisão local. As únicas alterações adicionais de runtime
  permitidas são observações sanitizadas no provider, persistência dessas observações
  no checkpoint e os respectivos tipos; não há alteração das regras de apostas.
- Deriva imagem do worker com overlay de fontes permitidas. Não reconstrói API,
  não copia .env/segredos/dados para a imagem e não altera Caddy/POSNET.
- Antes de parar o consumidor, testa a imagem sem rede externa/credenciais/volumes.
  O teste real do SDK contra localhost exige status false → Start → espera de
  2000 ms → status true, com observação bruta e SDK iguais. Não é conexão real LSports.
- Reaudita o Mac; envia SIGTERM uma única vez ao worker AWS; espera saída e liberação
  normal dos locks. Faz backup offline SHA-256 de checkpoint/journals e guarda os
  modelos/deployment/recibo anteriores. Não remove lock vivo nem usa kill -9.
- Acrescenta somente a imagem/flag já existente do worker, comparando o modelo Compose
  completo. Preserva todos os overrides, volumes, credenciais, memória 4 GiB, heap,
  limites por lane e journals de coordenação/cooldowns. Sobe só o serviço worker com
  `--no-deps --no-build --pull never`. Ambos os feeds reconectam por compartilhar o processo.

Etapas `distribution_image`, `distribution_upgrade`, `distribution_validation`
ficam no progresso existente. Recibo remoto com digest permite retomar a mesma
revisão sem novo SIGTERM/recriação de um worker que já esteja rodando na imagem
verificada. Se o worker sair, a validação não o reinicia às cegas.

## Registro e critério de validação

A correção temporal de 2aa06f7 permanece: aguardar 2000 ms **antes** da reconsulta.
A instrumentação adicional não faz requisições extras. Em
`connections.<lane>.distributionObservations` grava até três observações da tentativa:

- `before_start`: `Body.IsDistributionOn` bruto e booleano interpretado pelo SDK;
- `start_response`: somente classe da mensagem oficial, sem texto arbitrário;
- `after_propagation`: os mesmos booleanos, horário UTC, atraso previsto e tempo
  monotônico decorrido desde o retorno do Start. Estado já ligado não provoca Start.

O checkpoint é gravado inclusive quando a ativação falha antes de abrir AMQP.
O executor consulta **apenas nosso status local na AWS**, sem novo HTTP ao fornecedor.
Registra observações e fechamentos 320 posteriores à referência real da nova imagem;
registros de sessões anteriores não confirmam o estado atual. Checkpoint/log do mesmo
fechamento em janela de 2 s são correlacionados, evitando contar duas vezes. Os dados
originais sanitizados permanecem em `lastValidation` e nos logs/checkpoint.

Distribuição true, container running, snapshot completo e odds disponíveis são
resultados separados. Só `CURRENT_FEEDS_AND_ODDS_VERIFIED` confirma todos os critérios:
consumidor único rodando; dois status brutos/SDK atuais true; dois baselines da sessão
atual completos; projeção recente validada pela API; e seleções realmente disponíveis.
Autenticação do iframe não é confirmada automaticamente por este comando.

Se o status continuar false depois do intervalo medido, o executor retorna
`DISTRIBUTION_OFF_AFTER_MEASURED_PROPAGATION` sem outro ciclo de espera. Falhas de
requisição, contrato de snapshot, saída do worker e fechamentos 320 repetidos têm
motivos próprios. Caso contrário acompanha a recuperação normal por até 45 minutos,
respeitando os cooldowns existentes; timeout não é ausência de eventos ou recuperação.

## Mensagem atualizada do ticket 217525

O comando grava atomicamente, com modo 0600, fora do repositório:

`~/Library/Application Support/ADL/Cutover/support-217525-post-2aa06f7-12811-12809.md`

O campo `reportFile` mostra o endereço exato. Contém os novos horários UTC, pacote,
`Body.IsDistributionOn`, valor SDK, atraso medido, novos AMQP 320 e resultado de cada
lane. Não recicla os horários pré-correção como evidências novas, nem afirma HTTP 200
ou motivo específico do broker quando não registrados. É um rascunho pronto para
copiar/anexar; não envia mensagens ao fornecedor automaticamente.

## Validação local

Build de frontend/API/worker; testes do contrato SDK, persistência da observação em
falha de Start, validação sem falso sucesso por container running e relatório privado.
Testes do updater verificam preservação do modelo/journals, um único restart,
retomada sem novo sinal e teste offline anterior à parada. A imagem local também
executou o teste de propagação sem rede externa. Isso não comprova recuperação real
na AWS, que permanece condicionada aos resultados emitidos pelo comando.
