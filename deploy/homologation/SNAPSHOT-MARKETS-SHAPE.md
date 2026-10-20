# Rejeição PreMatch `invalid_markets_shape`

Evidência recebida: distribuição ON e consumidores registrados após correção da
ordem, ACK em ambos os feeds e sem novos AMQP 320; HTTP 200 PreMatch rejeitado com
`full_document_invalid / invalid_markets_shape`. InPlay tem snapshot. Não repetir
migração nem atribuir esta rejeição ao fornecedor.

## Comprovado no código e SDK 3.10.10

`convertSnapshotRow` usa a mesma mensagem para quatro categorias: Markets não é
array, item Markets não é objeto, item é array, Bets presente não é array. A
mensagem não identifica a categoria nem o fixture. O finally de `fullSnapshot`
remove o diretório inclusive após rejeição. Portanto o relatório existente NÃO
comprova o tipo recebido. Não há acesso a esse corpo AWS neste ambiente.

O SDK declara `GetEventsResultElement.markets?: Market[]` e `Market.bets?: Bet[]`.
A transformação preserva null nessas propriedades; isso é comportamento de
conversão, não confirmação de contrato nullable nem evidência do corpo AWS.
Não converter objetos em arrays, aceitar null por suposição, filtrar mercados ou
publicar snapshot parcial. A ordem de conexão, ACK, memória e recuperação não são
alteradas nesta coleta.

## Única coleta necessária

`snapshot-markets-report.mjs` identifica o único worker AWS via labels Compose,
fixa seu image ID e monta somente o volume do feed, READ ONLY. Executa um leitor
sem rede, 384 MiB e 0,5 CPU na imagem já instalada; não carrega credenciais, não
consulta o fornecedor, não modifica processos, locks, journals ou overrides.

Primeiro procura resposta retida em `.rejected-full-snapshot`. A versão atual a
remove; nesse caso observa por até dez minutos a próxima resposta naturalmente
agendada. Abre o arquivo sem escrever e mantém o descritor após unlink, espera a
remoção pelo worker e valida o envelope completo antes de usar a evidência.
Não lê um documento ainda em download como se fosse completo.

A saída sanitizada informa `rejection.path`, `actualType`, IDs/índice quando
válidos e forma convertida pelo SDK. Somente o primeiro fixture rejeitado é salvo
privadamente (máximo 16 MiB, SHA-256, modo 0600), junto ao report.json em diretório
0700 `/var/backups/adl-snapshot-shape-*`. Nenhum valor de mercado, nome arbitrário
ou corpo é impresso. Não publicar `rejected-row.private.json` ou logs privados.

Se não houver tentativa natural durante a observação, retorna
`NO_REJECTED_COMPLETE_RESPONSE_OBSERVED`; não força consulta nem reinício. Se o
relatório trouxer a forma exata, ela decide a correção e fornece o fixture para
um teste representativo. Esta coleta não alega reparar o contrato ainda não visto.

Testes locais isolados: todas as categorias do guard; comparação de null com SDK;
imagem Docker sem rede com resposta retida e captura de resposta removida durante
a leitura. A validação real do formato AWS depende da execução da coleta.
