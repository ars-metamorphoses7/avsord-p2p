# Recovery probe lifecycle audit — 2026-08-29

## Escopo

- Branch/checkpoint de entrada: `codex/screen-share-results-2026-08-29` @ `7bedeca259cd7da8dae67f6d806a889d1d076c1c`
- Perfil: `performance`
- Viewer: `1`
- Captura: `screen`, backend default
- Upload emulado: `3500 kbps`
- Perda/latência/fila/reordenação: `0% / 0 ms / 0 / off`
- Duração: `149.9996 s`, warmup `0`, sample `250 ms`
- Codec: NVIDIA H.264 MFT

JSON bruto: `bench-m150-recovery-probe-insufficient-screen-2026-08-29.json`.

## Etapa 1 — auditoria read-only

### 1. Início

`recoveryProbeActive` inicia quando todas estas condições são verdadeiras em `evaluateCaptureAdaptation` (`src/media/screenShareProfiles.js`, bloco de spatial probe):

- não há probe ativo;
- `level > 0`;
- `temporalLevel === 0`;
- `currentOperatingPointHealthy`;
- `networkPressure === false`;
- `encoderRecoveryReady === true`;
- `networkRecoveryReady === false`;
- `stableSamples >= profile.recoverySamples`.

Na prática, o bloco também só é alcançado quando `cooldownSamples` já chegou a zero, porque ele vem depois do ramo que segura o estado durante cooldown.

### 2. Encerramento/abort

O probe aborta se, enquanto ativo, ocorrer qualquer uma destas condições:

- `level === 0`;
- `temporalLevel > 0`;
- `currentOperatingPointHealthy === false`;
- `networkPressure === true`;
- `encoderRecoveryReady === false`.

Ele termina normalmente quando `networkRecoveryReady` passa a true e o ramo de recovery reduz um nível espacial. Nesse caso o cap temporário é limpo. `adaptVideoSender` aplica o cap do probe enquanto o estado está ativo e não há pressão.

### 3. Limites explícitos

Não existe limite explícito de duração, quantidade de samples, quantidade de adaptation cycles ou deadline para o probe. O código só possui cooldown de três samples depois de um abort; esse cooldown não é timeout do probe.

### 4. Estado se o headroom nunca chegar

Se o operating point atual continuar saudável, sem `networkPressure`, sem `transportPressure`, com encoder pronto e `networkRecoveryReady=false` permanentemente:

1. `stableSamples` continua acumulando;
2. `stable` continua false porque depende de `networkRecoveryReady`;
3. o ramo de recovery normal não executa;
4. o ramo `recoveryProbeActive` mantém `reason=spatial-recovery-probe`;
5. o cap temporário continua sendo reaplicado pelo sender.

Conclusão da auditoria: **B/C estrutural — o probe pode permanecer ativo indefinidamente**. Não há caminho automático de término sem pressão, sem encoder failure ou sem headroom suficiente.

## Etapa 2 — runtime

| Tempo | Estado | stable | maxBitrate | send bitrate | available | req. recovery | headroom | networkReady | pressão | motivo |
|---:|---|---:|---:|---:|---:|---:|---:|---|---|---|
| 24.750 s | 360p60, scale 2 | 0 | 2,000 Mbps | 1,826 Mbps | 2,899 Mbps | 4,500 Mbps | 0,362 | false | network ramp | `network-spatial-downshift` |
| 26.250 s | 360p60 saudável | 1 | 2,000 Mbps | 1,994 Mbps | 2,933 Mbps | 4,500 Mbps | 0,652 | false | nenhuma | `network-spatial-downshift` |
| 38.250 s | 360p60 saudável | 9 | 2,000 Mbps | — | 3,405 Mbps | 4,500 Mbps | 0,757 | false | nenhuma | `network-spatial-downshift` |
| 39.750 s | probe aberto | 10 | 5,500 Mbps | 2,853 Mbps | 3,219 Mbps | 4,500 Mbps | 0,763 | false | nenhuma | `spatial-recovery-probe` |
| 50.000 s | probe ativo | 16 | 5,500 Mbps | 3,657 Mbps | 3,990 Mbps | 4,500 Mbps | 0,797 | false | nenhuma | `spatial-recovery-probe` |
| 90.000 s | probe ativo | 43 | 5,500 Mbps | 3,316 Mbps | 3,714 Mbps | 4,500 Mbps | 0,818 | false | nenhuma | `spatial-recovery-probe` |
| 120.000 s | probe ativo | 63 | 5,500 Mbps | 3,161 Mbps | 3,569 Mbps | 4,500 Mbps | 0,785 | false | nenhuma | `spatial-recovery-probe` |
| 149.999 s | probe ativo | 83 | 5,500 Mbps | 2,654 Mbps | 3,302 Mbps | 4,500 Mbps | 0,725 | false | nenhuma | `spatial-recovery-probe` |

O operating point ficou saudável a partir de `26.250 s` (`captureFps=56.689`, `encodedFps=56.689`, entrega 1, encode ~2,32 ms, sem pressão). O probe abriu em `39.750 s`, portanto o run observou `110.250 s` de probe ativo e `442` snapshots nessa condição.

O maior `availableOutgoingBitrate` durante o probe foi `4.191 Mbps` em aproximadamente `50.500 s`, equivalente a headroom máximo de aproximadamente `0.909` contra o requisito de `4.5 Mbps`. O gate exigia `1.12`, portanto nunca ficou pronto.

Não houve timestamp/reason de encerramento: o último sample ainda tinha `recoveryProbeActive=true`, `recoveryProbeAbortReason=null`, `networkPressure=false`, `transportPressure=false`, `encoderRecoveryReady=true`, `networkRecoveryReady=false` e cap aplicado de `5.5 Mbps`. Não existe estado “depois” no run; o cap permaneceu ativo até o encerramento do harness.

## Transporte e pipeline

- `packet loss`: `0`
- retransmissão: `0`
- `packetsDiscardedOnSend`: `0`
- samples de `transportPressure` após a abertura: `0`
- maior `averagePacketSendDelayMs` após a abertura: `1.639 ms`
- `captureFps`/`encodeFps` durante o probe: aproximadamente `56.0–57.4 FPS`
- `sendFps` durante o probe: aproximadamente `55–58 FPS`
- média do run: encode/send `56.36 FPS`, bitrate efetivo `2.907 Mbps`, encode `2.24 ms`
- receiver ao final: decode `56.41 FPS`, 360p; render `56.28 FPS`

## Classificação

**Resultado C — PROBE INDEFINIDO.**

O caso relevante foi reproduzido sem packet loss artificial: o GCC manteve o transporte saudável, o operating point atual permaneceu em 360p60, a estimativa não alcançou o próximo gate e o cap do probe permaneceu ativo indefinidamente. Esta rodada não corrige esse lifecycle.

## Alterações sincronizadas

Somente este relatório e o JSON bruto foram adicionados. Nenhum arquivo de código foi alterado nesta rodada.
