# Protocolo de field run de screen share

Este protocolo é a preparação para o benchmark físico entre máquinas. Ele usa a build unpacked do sender, mantém todos os participantes nos mesmos bits e coleta somente diagnostics opt-in. Não executar benchmark sintético de vídeo nesta etapa.

## Privacidade e escopo

O manifesto pode conter OS/version, CPU, quantidade de CPUs lógicas, RAM, IDs/driver da GPU, Electron/Chromium, aceleração, encoder/decoder reais, display, refresh rate, scale factor, política de captura e codecs observados.

Não são coletados username, hostname, IP, MAC, processos, nomes de arquivos, títulos de janela, histórico, nomes de dispositivos pessoais, conteúdo de áudio ou conteúdo visual. RTCStats são reduzidos a campos técnicos permitidos antes da persistência. Para áudio, `deviceId`, `groupId`, `label` e nome de saída não aparecem; somente settings técnicos de sample rate/size, canais, AEC, noise suppression e AGC.

O artefato preserva o mesmo `runId` entre sender e receiver e usa timeline monotônica local. `startedAtMs` e `performanceTimeOriginMs` são locais ao processo que gerou o JSON. Wall clocks entre máquinas não devem ser subtraídos.

## Áudio observado

Na mesma série temporal do vídeo, cada sample pode conter quatro caminhos independentes:

| Caminho | Origem |
| --- | --- |
| `microphoneOutbound` | sender → rede, microfone |
| `microphoneInbound` | receiver, microfone recebido |
| `screenAudioOutbound` | sender → rede, áudio do desktop |
| `screenAudioInbound` | receiver, áudio do desktop recebido |

Para cada caminho disponível são observados codec/MIME, clock rate, canais, settings técnicos, packets/bytes, bitrate por delta, perda, jitter, RTT correlacionável, retransmissão e nível/energia. No inbound também são observados jitter buffer, samples ocultados/concealment, samples totais e ajustes de aceleração/desaceleração quando o runtime expõe esses campos. Counters que resetam produzem `null` naquele intervalo. O summary oferece bitrate p05/p50, perda, jitter p50/p95, jitter buffer efetivo p50/p95, totais de concealment e distribuição de `audioLevel`.

Diagnostics desabilitado não cria o polling adicional de áudio. Não há polling de alta frequência, escrita por sample, análise PCM, captura adicional ou gravação de áudio.

## Build única para sender e receivers

Na máquina que produzirá o field run:

```powershell
npm ci
npm run desktop:dir
```

O `electron-builder --dir` produz a pasta unpacked em `release/win-unpacked` no Windows. Envie essa pasta, ou um ZIP dela, aos amigos. Eles não precisam instalar Node, npm ou clonar o repositório.

No sender e em cada receiver, a partir da pasta unpacked:

```powershell
$env:JUMP_STREAM_DIAGNOSTICS = '1'
$env:JUMP_APP_COMMIT = '<COMMIT_DO_FIELD_RUN>'
.\JUMP.exe
```

O valor de `JUMP_APP_COMMIT` deve identificar os mesmos bits enviados. O diretório final aparece uma vez no log:

```text
[screen-share-diagnostics] enabled; output: <path>
```

O deep link já é aceito pelo executável empacotado. Para entrar diretamente:

```powershell
.\JUMP.exe "jump://join?signal=...&room=..."
```

O processo usa o argumento `jump://` no primeiro start e encaminha novos links ao processo existente pelo single-instance handler; não é necessário alterar deep-linking.

## Topologia

Cada conjunto usa exatamente um sender e um receiver em mesh/P2P. O segundo amigo fica fora da call durante todo o conjunto do primeiro. Depois ele entra como único receiver do segundo conjunto. Não usar dois receivers simultâneos, SFU, profile quality, window capture, WGC override, network emulation ou GPU artificial.

Confirme em cada artefato que `transportMode` é `mesh`.

## Runs oficiais

Use o mesmo sender, a mesma resolução/settings e o mesmo jogo pesado entre todos os runs. A tela deve ter movimento contínuo próximo de 60 FPS; não usar tela estática.

| Label | Receiver | Duração | Profile | Fonte | Áudio | Rede/GPU |
| --- | --- | ---: | --- | --- | --- | --- |
| A1 — LIGHT | amigo 1 | 60 s | `performance` | whole screen | include audio ON; áudio do sistema contínuo; frase a cada 10–15 s | sem emulação; sem carga artificial |
| B1 — HEAVY GAME | amigo 1 | 90 s | `performance` | whole screen | jogo/áudio do sistema contínuo; frase a cada 10–15 s | sem emulação; sem carga artificial |
| A2 — LIGHT | amigo 2 | 60 s | `performance` | whole screen | include audio ON; áudio do sistema contínuo; frase a cada 10–15 s | sem emulação; sem carga artificial |
| B2 — HEAVY GAME | amigo 2 | 90 s | `performance` | whole screen | jogo/áudio do sistema contínuo; frase a cada 10–15 s | sem emulação; sem carga artificial |

Para B1/B2, carregue completamente o mesmo jogo antes de iniciar o share, mantenha resolução/settings fixos e jogue com movimento real durante os 90 segundos; não permaneça no menu. Anote manualmente o FPS aproximado do jogo antes e durante o share. Não instrumente o jogo.

## Checklist por run

1. Inicie sender e receiver com a mesma pasta unpacked e as variáveis de diagnóstico.
2. Entre na mesma sala por mesh/P2P e confirme áudio normal antes do share.
3. Selecione `performance`, whole screen e `include audio ON`.
4. Comece a gravação manual do run no instante em que o share estiver ativo; aguarde toda a duração.
5. Durante o run, faça uma frase curta aproximadamente a cada 10–15 segundos.
6. Pare o share e aguarde os JSONs sender/receiver aparecerem no `outputDirectory` de cada máquina.
7. Preserve os JSONs sem editar e registre o `runId` comum, o receiver e as notas subjetivas.

## Notas humanas

Não inserir estas notas no JSON. Elas complementam a evidência objetiva:

| Campo | Anotação |
| --- | --- |
| run label | A1 / B1 / A2 / B2 |
| runId | |
| receiver | amigo 1 / amigo 2 |
| sender game FPS pre-share | |
| sender game FPS during-share | |
| receiver video smoothness | 1–5 |
| receiver visual quality | 1–5 |
| perceived video latency | baixo / médio / alto |
| mic artifacts | none / dropout / robotic |
| screen-audio artifacts | none / dropout / robotic |
| A/V sync perceptível | yes / no |
| observação curta | |

## Saída e comparação

Os JSONs ficam em:

```text
<app.getPath('userData')>/diagnostics/screen-share/
```

Use o `outputDirectory` retornado por `stream-diagnostics:config` como fonte de verdade. Compare primeiro LIGHT vs HEAVY no mesmo receiver e depois B1 vs B2. Use a primeira divergência cronológica:

| Observação | Hipótese inicial |
| --- | --- |
| capture cai junto com encode | capture/GPU contention |
| capture estável, encode cai | encoder/GPU encode |
| send estável, receive cai | transporte/rede |
| receive estável, decode cai | decoder/receiver |
| decode estável, render cai | playback/compositor |

Também compare implementation/power efficiency de encoder/decoder, resolução, bitrate, adaptation, pacer, RTT, loss, jitter e os quatro caminhos de áudio.

## Validação local desta preparação

```powershell
npm run test:media
npm run build
npm run test:diagnostics
npm run test:call
```

Esses comandos são smoke/local integration. Não executar `npm run test:stream-benchmark` nesta rodada.
