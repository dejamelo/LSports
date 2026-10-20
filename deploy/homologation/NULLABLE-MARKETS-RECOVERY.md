# #217525: Markets:null confirmado no PreMatch

A coleta AWS confirmou fixture 20563979, Markets:null, transformação SDK bem
sucedida preservando markets:null, documento com 11925 linhas. Evidência privada:
`/var/backups/adl-snapshot-shape-2thwo24l/rejected-row.private.json` e `report.json`.
Atribuição demonstrada: guard local rejeitava a ausência explícita de coleção que
o SDK preserva. Não há prova de falha do fornecedor nesta rejeição.

## Correção

`convertSnapshotRow` permite SOMENTE null adicionalmente a array/ausência em
Markets e Bets, preservando o valor convertido pelo SDK. Não cria [] nem odds,
não remove o fixture, não inventa fechamento/liquidação e não ignora mercados.
Objetos, strings, números e itens não objeto (inclusive null dentro do array)
continuam rejeitados, com fixture, caminho e tipo sanitizados.

A primeira passagem valida TODAS as linhas e o envelope completo, incluindo o
Header final, antes de aplicar qualquer fixture. Várias ocorrências de null são
válidas; um único mercado realmente inválido no fim impede toda aplicação e a
conclusão do baseline. A segunda passagem mantém os mesmos limites de memória,
spool, tamanho por fixture e HTTP existentes. Não muda intervalos ou assinaturas.

A recuperação existente invalida provas de preços anteriores antes do snapshot.
Uma coleção null não reconfirma preços: valores/resultados históricos continuam
armazenados, com odds antigas indisponíveis. AMQP posterior ao início da recuperação
continua sendo processado, persistido antes de ACK e reconciliado por versão; um
snapshot null não apaga uma cotação AMQP nova e válida. Resultado já armazenado
não é alterado pela ausência de mercados/seleções. Não há edição de bilhetes.

## Atualização única e retomável

O entrypoint existente recebe `--pid 12811 --parent 12809 --nullable-markets-repair`.
IDs selecionam somente o ledger da migração concluída, não recebem sinais. Usa
`ADL_REPO_ROOT` e Git ref imutável `ADL_RUNTIME_REF`; não exige checkout nem apaga
alterações locais do painel. A imagem anterior esperada é o runtime db4c193.

Antes da parada: verifica hashes da imagem, confere backup privado, SHA-256 e
semântica do fixture capturado; testa esse arquivo original com o novo conversor
em Docker SEM REDE, read-only e memória limitada. Testa também Bets:null e formas
inválidas, além de ordem de conexão, propagação e parser completo. Se a evidência
não conferir ou outra validação da linha original falhar, não para o worker.

Após os testes: Distribution/Stop antes do SIGTERM, espera saída e liberação dos
locks pelo processo, backup verificado de checkpoint/journals e um override somente
da imagem worker. Preserva API/POSNET, credenciais, volumes e todos os overrides.
Não repete exportação/importação, não toca o worker Mac, não purga filas e mantém
os journals de cooldown. Recibo e ledger salvam `nullable_markets_image` e
`nullable_markets_upgrade`; reexecução reutiliza etapas e não repete o restart.

A validação exige distribuição ON, consumidores registrados, ACK nas duas lanes,
snapshots desta sessão, ACK durante recuperação PreMatch, atualizações reais de
mercado e seleções disponíveis. Ausência de mercados abertos/deliveries pode manter
pendência identificada. Apenas conexão/container/keepalive não prova recuperação.
A sessão autenticada do iframe permanece uma verificação separada no navegador.

Rollback: mesmo executor/ref com `--nullable-markets-rollback`. Stop confirmado,
saída normal, override somente da imagem anterior, dados intactos e container
anterior PARADO, pois ainda rejeita null. Não restaura checkpoints antigos nem
inicia o Mac. Se Stop/saída/identidade não conferir, bloqueia preservando locks.

## Validação executada aqui

221 testes locais do worker aprovados, incluindo nulos múltiplos/documento inteiro,
erro tardio sem aplicação parcial, bloqueio de odds antigas, preservação de
settlement, reinício e atualização AMQP concorrente; snapshot >256 MiB limitado.
34 testes do executor/status aprovados, incluindo SHA incorreto impedindo a parada,
backup, rollback e preservação de overrides. Build TypeScript e imagem Docker
local/offline aprovados. A linha ORIGINAL e os feeds AWS são validados pelo comando
no Mac; não houve acesso SSH nem aplicação AWS a partir deste ambiente.
