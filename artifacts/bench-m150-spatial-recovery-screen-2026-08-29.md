# Spatial recovery probe — 2026-08-29

## Escopo

- Branch: `codex/screen-share-results-2026-08-29`
- Base: `5cb4c04ebcf59c03645213aa0d9abc583caf1d6c`
- Perfil: `performance`
- Viewer: `1`
- Captura: `screen`, backend default
- Rede/GPU artificial: off
- Duração: `150.000 s`, warmup `0`, sample `250 ms`
- Codec observado: NVIDIA H.264 MFT

Artefato bruto: `bench-m150-spatial-recovery-screen-2026-08-29-run3.json`.

## Resultado

O bloqueio era composto por duas condições independentes:

1. O operating point 360p60 era saudável, mas o contador `stableSamples` usava a métrica de estabilidade nominal do próximo ponto. Oscilações normais da captura em 56–57 FPS zeravam o contador apesar de `encoderDeliveryRatio=1`, encode baixo e ausência de pressão.
2. O cap nominal de 2 Mbps em scale `2` mantinha o GCC perto de 3,63 Mbps, abaixo dos 5,04 Mbps exigidos para liberar 540p60.

A implementação separa saúde do ponto atual da capacidade do próximo ponto. A saúde usa a tendência EMA com margem de 3 pontos percentuais (`max(pressureFpsRatio, stableFpsRatio - 0.03)`), entrega >= 0,92, encode dentro do orçamento e ausência de pressão. `stableFpsRatio=0.97`, `recoverySamples=10` e o threshold `1.12` não foram alterados.

Quando o ponto atual está saudável, mas falta headroom para o próximo ponto espacial, o controlador abre um probe temporário. O cap é calculado de `recoveryRequiredBitrate * 1.22`, arredondado em 50 kbps e limitado pelo máximo nominal do perfil. Scale e FPS permanecem inalterados. O probe aborta diante de pressão de rede/transporte ou encoder e aplica cooldown para evitar retry imediato. Mesh e SFU usam a mesma política de `adaptVideoSender`.

## Timeline do run normal

| Tempo | Estado | maxBitrate | available | recovery req. | headroom | stable | motivo |
|---:|---|---:|---:|---:|---:|---:|---|
| 82.000 s | 360p60, scale 2 | 2,00 Mbps | 3,629 Mbps | 2,00 Mbps | 1,815 | 0 | `temporal-recovery` |
| 92.501 s | 360p60 saudável | 2,00 Mbps | 3,629 Mbps | 4,50 Mbps | 0,807 | 1 | health acumulando |
| 106.001 s | 360p60, probe ativo | 5,50 Mbps | 3,629 Mbps | 4,50 Mbps | 0,807 | 10 | `spatial-recovery-probe` |
| 106.501 s | probe ativo | 5,50 Mbps | 5,059 Mbps | 4,50 Mbps | — | 10 | primeiro crossing de 5,04 Mbps |
| 107.500 s | 540p60, scale 4/3 | 4,226 Mbps | 5,418 Mbps | 4,50 Mbps | 1,204 | 0 | `recovery` |
| 109.000 s | 540p60 saudável | 4,226 Mbps | 6,008 Mbps | 8,00 Mbps | 0,751 | 1 | cooldown 4, health continua |
| 122.500 s | 540p60, probe ativo | 8,00 Mbps | 7,755 Mbps | 8,00 Mbps | 0,969 | 10 | `spatial-recovery-probe` |
| 124.750 s | probe ativo | 8,00 Mbps | 9,079 Mbps | 8,00 Mbps | — | 11 | primeiro crossing de 8,96 Mbps |
| 125.501 s | 720p60, scale 1 | 8,00 Mbps | 9,652 Mbps | 8,00 Mbps | 1,207 | 0 | `recovery` |
| 150.000 s | 720p60 | 8,00 Mbps | 14,094 Mbps | 8,00 Mbps | 1,762 | 6 | saudável |

O primeiro degrau espacial levou `1.499 s` desde a abertura do probe. O segundo levou `3.001 s`. O tempo entre chegar a 360p60 e 720p60 foi `43.501 s`, incluindo a recuperação da EMA após a mudança temporal e os dois períodos de estabilidade.

Durante os probes, a captura/encode/send permaneceu aproximadamente em `56.7–57.3 FPS`; o receiver ficou em aproximadamente `56–58 FPS`, e o render medido ficou em aproximadamente `57 FPS` nas janelas de transição. Não houve perda, retransmissão ou descarte. O maior `averagePacketSendDelayMs` após a fase inicial foi `6.918 ms`, sem pressão sustentada; no estado final foi `0.001 ms`. QP médio do run: `36.14`.

## Regressão de link limitado

Artefato bruto: `bench-m090-constrained-probe-screen-2026-08-29.json`.

- Emulação: upload `3500 kbps`, perda `0%`, latência `0 ms`, fila `0`.
- `availableOutgoingBitrate` máximo: `3,602 Mbps`, abaixo dos `5,04 Mbps` necessários para 360p60 → 540p60.
- O sender terminou em 360p60, scale `2`, maxBitrate `2 Mbps`, sem probe e sem recovery espacial falso.
- Depois de 15 s: zero samples de pressão de transporte/pacer; atraso máximo `1.478 ms`, perda `0`, retransmissão `0`, descarte `0`.

Conclusão da regressão: o probe não libera um degrau quando o link não oferece a capacidade; a proteção de link permanece ativa.

## Verificação

- `npm run build` — passou.
- `npm run test:media` — `68/68` passou.
- O patch não altera codec, track, constraints, jitter buffer, thresholds, `recoverySamples` ou o backend de captura.
