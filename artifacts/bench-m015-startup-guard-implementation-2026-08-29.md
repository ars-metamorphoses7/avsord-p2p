# Startup bitrate guard — implementação e evidência

Data: 2026-08-29. Branch: `codex/screen-share-results-2026-08-29`.

## Implementação

O `evaluateCaptureAdaptation()` agora expõe `startupBitrateGuardActive`, derivado exclusivamente do `sampleCount` já existente: ele fica ativo enquanto `sampleCount <= profile.startupSamples`. Para o perfil `performance`, isso corresponde aos três primeiros samples; não há timer ou contador paralelo.

Mesh e SFU transportam essa metadata para `adaptVideoSender()`. O sender considera uma redução `capacity-only` somente quando `targetBitrate < previousBitrate`, não há `transportPressure` e não há mudança estrutural de escala, cadência ou `degradationPreference`. Durante o startup, essa redução preserva o cap anterior. Loss, retransmission, pacer pressure e descarte continuam furando o guard imediatamente. O cap já reduzido por pressão não é restaurado artificialmente.

O `recoveryProbeMaxBitrate` continua tendo precedência sobre o guard. Mudanças estruturais do safe start continuam aplicando sua escala/cadência e o bitrate correspondente. Não foram alterados thresholds, `startupSamples`, ladders, recovery, codec, captura ou jitter buffer.

## Testes

`npm run test:media`: **79 pass, 0 fail**.

`npm run build`: **pass**.

Os testes cobrem: três samples capacity-only, fim da janela existente, loss/retransmission/pacer/discard durante startup, ausência de restauração do cap, safe start estrutural e precedência do recovery probe.

## Runtime normal — 15 s

Artefato: `bench-m015-startup-guard-normal-2026-08-29.json`.

Configuração: `performance`, 1 viewer, `screen`, H.264 NVIDIA, rede sem emulação, GPU artificial desligada, warmup 0, quality samples 0, sample 250 ms.

- O sender iniciou em 8 Mbps.
- Em `t≈1.000 ms`, com guard ativo, `availableOutgoingBitrate=5.979.895`, cap permaneceu em 8 Mbps, encode≈55 FPS e send≈58 FPS, sem loss/retransmission/discard.
- Em `t≈5.000 ms`, o cap ainda era 8 Mbps, available≈6,91 Mbps e encode/send≈57,3 FPS.
- A primeira mutation foi somente após o startup: em `t≈5.500 ms`, o controller fez `network-spatial-downshift`, `scale 1→4/3` e cap `8M→4,5M`, com guard já inativo. Isso é a decisão estrutural normal, não o colapso capacity-only.
- Resumo: capture≈57,53 FPS, encode/send≈57,47 FPS, bitrate≈4,40 Mbps, available mediano≈7,41 Mbps, loss 0, retransmission 0, discard 0.

O padrão `8 Mbps→~237 kbps→3–4 FPS` não foi reproduzido.

## Runtime de pressure — 15 s

Artefato: `bench-m015-startup-guard-pressure-loss-2026-08-29.json`.

A emulação foi solicitada e marcada como ativa com packet loss de 5%, mas o WebRTC observou loss=0, retransmission=0 e discard=0 durante todo o run; portanto não há evidência runtime de perda artificial efetivamente atravessando o transporte.

Houve, contudo, pressão de pacer observável durante o startup: em `t≈1.000 ms`, `pacerPressure=true`, `transportPressure=true`, `averagePacketSendDelay≈112,98 ms`, guard=true e cap `8M→3.460.563`. O cap foi reduzido imediatamente, demonstrando que a proteção não esconde pressão de transporte. A pressão desapareceu por `t≈2.750 ms`; encode/send voltaram a≈58 FPS. A redução estrutural para 540p60 ocorreu depois, em `t≈4.250 ms`.

Conclusão do runtime de pressure: bypass por pacer confirmado; caminho de packet loss permanece inconclusivo no harness porque os contadores reais ficaram zerados. O bypass de loss/retransmission/discard está coberto deterministically pelos testes.

## Runtime normal — 150 s

Artefato: `bench-m150-startup-guard-normal-2026-08-29.json`.

Timeline principal:

| Tempo aproximado | Estado observado |
|---:|---|
| `1.249 ms` | startup guard=true; pacer/transport pressure=true; cap `8M→3.779.347`; pacer≈113,24 ms; loss/retransmission/discard=0 |
| `2.749 ms` | pacer pressure desaparece; encode≈57,34 FPS; cap permanece em 3.779.347 |
| `4.250 ms` | startup encerrado; downshift estrutural para level 1, scale `4/3`, 60 FPS, cap 4,5 Mbps |
| `23.750 ms` | `stableSamples=10`; recovery probe abre, cap temporário 8 Mbps |
| `26.749 ms` | probe conclui; recovery para level 0, scale 1, 60 FPS, cap 8 Mbps |

Ao final de 150 s: level 0 / temporal 0 / 720p60, capture≈57,43 FPS, encode≈57,38 FPS, send≈57,38 FPS, available mediano≈14,14 Mbps (máximo≈14,28 Mbps), target≈7,98 Mbps, loss/retransmission/discard=0. Receiver ficou em≈57,42 FPS de decode e≈57,47 FPS render, sem frames dropped ou freezes.

O controller completo continuou capaz de recuperar até 720p60. A redução inicial para 3,78 Mbps foi acompanhada por pressão de pacer transitória, não por uma redução capacity-only para centenas de kbps; o guard deixou essa pressão reagir normalmente.

## Limitações

- A emulação de 5% não produziu packet loss/retransmission observável no WebRTC. Não se deve interpretar esse run como validação do caminho de perda; essa garantia é determinística nos testes.
- Os runs reais continuam sujeitos à variabilidade do startup do Chromium/GCC. Por isso a classificação da proteção é feita pelos sinais registrados em cada sample, sem assumir que toda redução inicial seja capacity-only.
- A mudança corrige a primeira divergência comprovada; não altera a política de recovery nem cria floor/ramp permanente.
