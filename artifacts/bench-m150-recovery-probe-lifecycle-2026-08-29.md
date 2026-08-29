# Recovery probe lifecycle — 2026-08-29

## Escopo

- Branch de trabalho: `codex/screen-share-results-2026-08-29`
- Base da rodada: `4b954e857f1b9190cff2694dc4ea18d6cbd0ad11`
- Perfil: `performance`
- Viewer: `1`
- Captura: `screen`, backend default
- Codec observado: NVIDIA H.264 MFT
- Alterações fora do lifecycle: nenhuma

## Conclusão

O lifecycle anterior tinha a lacuna C: depois de abrir, o probe não tinha timeout nem limite de samples e podia manter o cap temporário indefinidamente. A implementação agora fecha essa lacuna:

1. `RECOVERY_PROBE_MAX_SAMPLES = 8`: o probe expira após oito avaliações ativas sem `networkRecoveryReady` (aproximadamente 12 s na cadência de 1,5 s).
2. No mesmo estado de timeout, `recoveryProbeActive` e `recoveryProbeMaxBitrate` são limpos; o sender volta ao orçamento do operating point.
3. `RECOVERY_PROBE_COOLDOWN_SAMPLES = 10` impede reabertura imediata (aproximadamente 15 s), separado do `cooldownSamples` estrutural.
4. O cooldown específico não bloqueia adaptação normal: uma pressão real ainda pode fazer downshift.

Resultado causal do controlador: **B — probe inconclusivo, mas limitado**. O caminho de timeout é determinístico e coberto pelos testes. Não há mais caminho de estado C no código.

## Auditoria da máquina de estados atual

### Início

O probe abre somente quando o ponto atual está saudável, `level > 0`, `temporalLevel === 0`, `networkPressure=false`, `encoderRecoveryReady=true`, `networkRecoveryReady=false`, `stableSamples >= recoverySamples` e o cooldown específico chegou a zero.

### Durante o probe

Cada avaliação ativa incrementa apenas `recoveryProbeSamples`. Saúde do ponto atual, pressão de rede/transporte e encoder continuam sendo gates independentes.

### Encerramento

- `networkRecoveryReady=true`: recovery normal reduz exatamente um nível e limpa o probe.
- Ponto atual insalubre, pressão ou encoder não pronto: aborta, limpa o cap e aplica cooldown estrutural curto mais cooldown específico de retry.
- Headroom ainda insuficiente após 8 samples: timeout, limpa o cap na mesma avaliação, preserva o operating point e aplica cooldown específico de 10 samples.

## Testes causais

`npm run test:media` passou com **74/74**. A cobertura adicionada verifica:

- início com `recoveryProbeSamples=0`;
- timeout com `recoveryProbeReason=spatial-recovery-probe-timeout`;
- restauração imediata do cap de 5,5 Mbps para o orçamento de 2 Mbps;
- retry bloqueado durante cooldown e reaberto somente após expiração;
- recovery de um nível quando a capacidade aparece depois de um retry;
- abort por pressão com cooldown;
- downshift normal durante o cooldown específico.

`npm run build` também passou.

## Evidência runtime — link emulado limitado

O harness foi executado com perda, latência, fila e reordenação desligadas. A emulação de upload do Chromium mostrou variabilidade: em algumas execuções a estimativa GCC escapou do limite antes dos oito samples. Os artefatos brutos mantêm essa evidência, sem classificá-la como timeout observado.

### Execução upload 2,0 Mbps

JSON bruto: `bench-m150-recovery-probe-lifecycle-upload2000-screen-2026-08-29.json`.

| Tempo | Estado | stable | probe | maxBitrate | available | recovery headroom | network/transport | motivo |
|---:|---|---:|---|---:|---:|---|---|---|
| 80,750 s | 360p60, scale 2 | 0 | não | 2,0 Mbps | 3,683 Mbps | 0,812 | false / false | `temporal-recovery` |
| 116,751 s | 360p60 saudável | 10 | abriu | 2,0 → 5,5 Mbps | 3,683 Mbps | 0,812 | false / false | `spatial-recovery-probe` |
| 118,249 s | 540p60, scale 4/3 | 0 | encerrou | 5,5 → 4,5 Mbps | 6,013 Mbps | 1,336 | false / false | `recovery` |
| 148,249 s | 540p60, scale 4/3 | 10 | abriu | 4,5 → 8,0 Mbps | 7,774 Mbps | 0,972 | false / false | `spatial-recovery-probe` |
| 150,000 s | probe ativo | — | ativo | 8,0 Mbps | 8,928 Mbps máx. do run | — | false / false | sem encerramento observado |

Na primeira abertura, a condição era a desejada: 360p60 saudável, `networkRecoveryReady=false`, sem perda, retransmissão, descarte ou pressão de transporte. Contudo, o GCC aumentou a estimativa e liberou recovery em 1,498 s. A segunda abertura ficou ativa até o fim do run, mas não teve os 8 samples necessários; logo, esse run não é evidência de timeout runtime.

Resumo do run: capture `41,47 FPS`, encode/send `37,37 FPS`, bitrate efetivo `2,266 Mbps`, available mediano `3,562 Mbps`, pacer médio `0,505 ms`, retransmissão `0`.

### Execução upload 3,5 Mbps, 210 s

JSON bruto: `bench-m210-recovery-probe-lifecycle-screen-2026-08-29.json`.

O primeiro probe abriu em `28,251 s` e recuperou em `29,750 s`; o segundo abriu em `44,750 s` e recuperou em `47,750 s`. O available chegou a `14,348 Mbps` e nenhum probe atingiu o timeout. O transporte não apresentou perda/retransmissão; encode/send médio foi `56,47 FPS`.

## Comparabilidade normal

JSON bruto: `bench-m150-recovery-probe-lifecycle-normal-screen-2026-08-29.json`.

Sem emulação de rede, o primeiro probe abriu em `118,000 s` e recuperou para 540p60 em `121,001 s`; o segundo abriu em `136,000 s` e recuperou para 720p60 em `139,000 s`. Isso confirma que o timeout não interrompe probes cujo headroom aparece normalmente.

## Limitação observada

O mecanismo `Network.emulateNetworkConditionsByRule` foi ativado no `sender-renderer`, mas não manteve uma capacidade RTP rígida em todas as execuções: o available GCC por vezes cresceu além do upload solicitado. Por isso, a conclusão de lifecycle limitado vem dos testes determinísticos e a evidência runtime é reportada como tentativa válida, porém inconclusiva para o timeout.

## Arquivos sincronizados

- `src/media/screenShareProfiles.js`
- `src/webrtc/usePeerMesh.js`
- `tests/screen-share-profiles.test.js`
- `bench-m150-recovery-probe-lifecycle-upload2000-screen-2026-08-29.json`
- `bench-m210-recovery-probe-lifecycle-screen-2026-08-29.json`
- `bench-m150-recovery-probe-lifecycle-normal-screen-2026-08-29.json`
