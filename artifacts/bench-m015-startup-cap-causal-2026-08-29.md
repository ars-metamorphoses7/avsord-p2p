# Evidência causal: startup cap de screen share

Data da análise: 2026-08-29. O experimento válido foi executado em `performance`, 1 viewer, `screen`, mesh, sem emulação de rede, GPU artificial desligada, `warmup=0`, `qualitySamples=0`, `sample=250 ms`, duração de 15 s.

## Resultado

**A — o cap do operating point participa causalmente do colapso inicial.**

No baseline, o sender começou em 8 Mbps, mas a primeira adaptação aplicou `maxBitrate=237047` bps antes da primeira amostra medida. Com H.264/NVIDIA, o encode/send ficou em aproximadamente 0–8 FPS durante os primeiros 5 s e o GCC permaneceu abaixo de 1 Mbps.

No A/B, a primeira redução solicitada (`237070` bps) e as duas seguintes (`3539162` e `4461286` bps) foram aplicadas ao sender como `8000000` bps. Sem forçar o bitrate real, o encode/send passou a aproximadamente 56–57 FPS e `availableOutgoingBitrate` atravessou 5,04 Mbps em `t=499,7 ms`, chegando a `7781610` bps. Não houve perda, retransmissão ou descarte de pacotes. Houve apenas pressão de pacer transitória no startup, que desapareceu antes de 3 s.

Isso é evidência de que o cap baixo fecha o operating point em um estado que limita a observação/expansão do GCC. Não prova que liberar o cap seja uma correção suficiente para o recovery espacial: quando a intervenção terminou, o controller ainda fez `network-spatial-downshift` para 540p60 porque o ponto 720p exigia mais capacidade.

## Auditoria read-only do caminho

- `configureVideoSender()` inicia o sender com `screenShareEncodingBitrate('performance', 1, 1) = 8000000` bps em [src/media/screenShareProfiles.js](../src/media/screenShareProfiles.js#L324).
- O primeiro cap runtime é aplicado por `adaptVideoSender()`, não por `evaluateCaptureAdaptation()`: o loop mesh faz `getStats()` → avaliação → `adaptVideoSender()` → `sender.setParameters()` em [src/webrtc/usePeerMesh.js](../src/webrtc/usePeerMesh.js#L273), [src/webrtc/usePeerMesh.js](../src/webrtc/usePeerMesh.js#L287), [src/webrtc/usePeerMesh.js](../src/webrtc/usePeerMesh.js#L391).
- A conversão é `networkBudget = availableOutgoingBitrate * headroom`, com headroom `0,78` sem pressão, `0,70` com pressão de transporte e `0,64` sob pressão severa; `targetBitrate` é limitado pelo budget nominal do nível e tem piso de 32 kbps em [src/media/screenShareProfiles.js](../src/media/screenShareProfiles.js#L388).
- Uma queda material (`target < previous * 0,90`) ou pressão severa reduz imediatamente o cap; o intervalo de 6 s em [src/media/screenShareProfiles.js](../src/media/screenShareProfiles.js#L82) só impede aumentos, não reduções.
- `startupSamples=3` aparece na avaliação estrutural em [src/media/screenShareProfiles.js](../src/media/screenShareProfiles.js#L671) e só transforma pressão inicial em observação; não protege o caminho de redução de bitrate em `adaptVideoSender()`.
- Portanto, a primeira divergência causal observada é: configuração nominal de 8 Mbps → primeiro stats/GCC baixo → `adaptVideoSender()` grava o cap baixo → encoder/pacer produzem pouca saída → o GCC recebe pouca oportunidade de elevar a estimativa.

## Timeline comparável

Os tempos abaixo são relativos ao início da janela medida. Os eventos do A/B podem ocorrer antes de `t=0`, porque o benchmark só inicia a janela depois de confirmar RTP mensurável.

| t aproximado | Baseline: cap / available / encode-send / estado | A/B: cap / available / encode-send / estado |
|---:|---|---|
| `-0,622 s` | mutation inicial já reduz `8M → 237047`; o primeiro stats medido vem em `740203` | — |
| `-0,517 s` | — | intervenção instalada; sender já estava em `8M`, scale 1, 60 FPS |
| `-0,375 s` | — | request `237070` mantido em `8M` |
| `0,0 s` | `237047` / `740203` / primeiro encode 0, send ~4 FPS; `network-observation` | `8M` / `781904` / primeiro stats; `network-observation` |
| `0,50 s` | `237047` / `755494` / ~4 FPS | `8M` / `5451200` / ~56 FPS e ~4,62 Mbps; primeiro cruzamento de 5,04 Mbps |
| `1,00 s` | `237047` / `773932` / encode 4,63, pacer 237,44 ms; `startup-observation` | `8M` / `5529941` / encode observado ~47 FPS; pacer transitório 141,80 ms |
| `1,114 s` | — | request `3539162` mantido em `8M` |
| `2,50 s` | `237047` / `773932` / encode 2,69, send 0–4 FPS; pacer 26,50 ms | `8M` / `5719597` / send ~56 FPS; request `4461286` ocorre em `2,616 s` |
| `2,616 s` | — | terceira interceptação concluída; intervenção restaurada; cap continua 8M até a próxima mutation |
| `3,00 s` | `237047` / `773932` / send ~4 FPS | `8M` / `5719597` / encode ~57,3 FPS, pacer ~0,0007 ms, sem pressão de transporte |
| `3,836 s` | mutation `network-spatial-downshift`: scale `1 → 4/3`, cap `331866` | — |
| `4,115 s` | — | mutation `network-spatial-downshift`: scale `1 → 4/3`, cap `8M → 4500000`; sample visível em `4,250 s`, available `5915347` |
| `6,835 s` | mutation encoder-fps-severe: scale `4/3 → 2`, cap `464612` | `4500000` / ~6,72M / ~56 FPS, scale 4/3 |
| `8,00 s` | `464612` / `828945` / send ~20, encode ~7,3 FPS, scale 2 | `4500000` / `7635795` / send ~60, encode ~57,4 FPS, scale 4/3 |
| `14,334 s` | mutation temporal: 60 → 30 FPS, cap `650457`; available máximo `962378` | `4500000` / `7781610` / send ~56, encode ~57,3 FPS; `stableSamples=2`, recovery espacial ainda bloqueado |

## Comparação agregada

| Métrica | Baseline | A/B válido |
|---|---:|---:|
| Codec / encoder | H.264 / NVIDIA MFT | H.264 / NVIDIA MFT |
| encode FPS médio | 16,47 | 56,60 |
| send FPS médio | 16,47 | 56,60 |
| bitrate enviado médio | 378924 bps | 4200145 bps |
| `availableOutgoingBitrate` máximo | 962378 bps | 7781610 bps |
| cap mínimo observado | 237047 bps | 4500000 bps após o downshift; 8M durante a intervenção |
| pacer delay médio | 15,78 ms | 9,27 ms |
| pacer delay máximo na janela inicial | 237,44 ms | 141,80 ms |
| packet loss / retransmission / discarded | 0 / 0 / 0 | 0 / 0 / 0 |
| redução espacial | 1 → 4/3 → 2 | 1 → 4/3 |
| redução temporal | 60 → 30 FPS | nenhuma em 15 s |

Nos primeiros 5 s, o baseline teve available entre `740203–773932` bps, send FPS mediano `4,0` e encode FPS mediano `2,69`. O A/B teve available entre `4396571–6176933` bps, send FPS mediano `56,19` e encode FPS mediano `47,15`; o pico de pacer foi transitório e não veio acompanhado de perda ou descarte.

## Escopo e integridade

- O primeiro A/B instrumentado antes da ativação do compartilhamento selecionou VP8/libvpx e foi descartado.
- O artefato válido é o run H.264 em `bench-m015-startup-cap-hold-screen-2026-08-29-v4.json`.
- A instrumentação foi somente no harness, foi removida antes do checkpoint e não existe alteração de produção no commit.
- O baseline limpo está em `bench-m015-startup-cap-baseline-screen-2026-08-29.json`.
