# Compartilhamento de tela: desempenho, qualidade e roadmap GPU-resident

**Status da decisão:** 2026-08-23  
**Runtime mantido:** Electron 43.4.1 / Chromium 150.0.7871.224  
**Decisão experimental:** não promover Electron 44.0.0-beta.6 e não ativar `WebRtcAllowWgcUsingTexture` em produção  
**Backend de tela inteira no Windows:** DXGI Desktop Duplication; WGC permanece para janelas  
**Escopo:** captura de janela/tela no Windows, envio P2P WebRTC e reprodução no receptor

## Resumo executivo

A regressão reproduzida no benchmark local não era causada simplesmente por “falta de bitrate”. Havia dois defeitos de controle que se reforçavam:

1. Depois de pedir largura, altura e FPS ao iniciar a captura, o código chamava `applyConstraints` somente com `frameRate`. Essa chamada substituiu o conjunto ativo e removeu os limites espaciais. O artefato anterior à correção registrou somente `frameRate` em `track.getConstraints()` e uma fonte de 640×360 no perfil desempenho.
2. O controlador interpretava FPS baixo e amostras iniciais de `qualityLimitationReason = bandwidth` como pressão acionável sem distinguir captura, encoder e rede. Ele aplicava `scaleResolutionDownBy` mesmo quando o encoder já entregava praticamente todos os frames capturados. O downscale do aplicativo ainda podia se somar à adaptação `maintain-framerate` do Chromium.

No run anterior à correção, o perfil desempenho terminou em 427×240, nível de adaptação 2, QP 40 e encoder `OpenH264`, embora a captura continuasse perto de 60 FPS. O resultado era precisamente o comportamento indesejado: cadência abaixo do alvo, imagem muito pior e perda do encoder NVIDIA por hardware. Em uma origem de jogo já limitada, o mesmo algoritmo podia manter a cadência praticamente inalterada e apenas destruir resolução.

A correção atual:

- reaplica o conjunto completo de constraints de captura;
- mantém todos os níveis do perfil desempenho em 360p ou acima;
- dá ao aplicativo, e não ao Chromium, o controle da adaptação espacial;
- mede separadamente captura, encode, envio, decode e apresentação;
- não reduz resolução quando a origem é o estágio limitante;
- reage a rede somente após pressão sustentada e com headroom insuficiente;
- trata cada downscale de encoder como um experimento e o reverte se três amostras não provarem ganho;
- mantém estado de adaptação por peer em vez de deixar um receptor fraco reduzir todos os envios.

No mesmo host e fixture, a correção levou desempenho de 427×240/OpenH264 para 960×540/NVIDIA H.264 MFT, com 59,77 FPS apresentados e intervalo p95 de 18,3 ms. Uma segunda rodada mostrou que 1280×720 manteve 59,68 FPS sob a pressão WebGL mais alta do harness, enquanto qualidade 1920×1080 apresentou 24,79 FPS. O perfil final foi, portanto, elevado para 720p60 com fallback controlado a 540p e 360p. Assim, os perfis voltaram a ter uma diferença útil: desempenho prioriza movimento e latência; qualidade prioriza detalhe.

O experimento de GPU texture do Chromium M152 não passou no gate. No único cenário em que o trace comprovou `DesktopCaptureDevice::DeliverTextureToClient`, a fonte externa do Chrome, ativar a feature reduziu o FPS apresentado de 54,50 para 49,32, elevou o encode médio de 2,48 para 7,83 ms e o WebRTC reportou `OpenH264`. A causa exata do fallback ainda não foi provada, mas a regressão é suficiente para uma decisão **no-go**.

## Como ler as evidências

Este documento usa quatro rótulos:

- **Medido:** consta nos JSONs de `artifacts/` gerados pelo harness em 2026-08-23.
- **Observado no código:** comportamento verificável no código do projeto ou em fonte oficial do Chromium/libwebrtc.
- **Inferido:** explicação compatível com as medições, mas ainda sem trace/experimento que estabeleça causalidade.
- **Meta:** gate de engenharia proposto; não é um resultado já alcançado.

Os números locais foram coletados em runs curtos, normalmente com uma repetição. Eles servem para diagnóstico e decisão de risco, não como garantia geral de desempenho. Antes de release, os mesmos testes devem ser repetidos por 60 segundos, cinco vezes, em mais de um hardware e com jogos reais.

## 1. Sintoma e causa-raiz

### 1.1 O mesmo FPS não torna os perfis equivalentes

Se dois perfis pedem o mesmo teto de FPS e ambos o atingem, é normal que o contador seja igual. O modo desempenho deve ser julgado também por:

- frametime e 1% low do jogo;
- custo de captura e conversão;
- tempo e fila de encode;
- retenção de frames em cada estágio;
- latência capture-to-present;
- robustez sob contenção de GPU e rede.

Reduzir apenas bitrate normalmente aumenta QP e artefatos; não necessariamente reduz o custo de capturar, converter e codificar a mesma quantidade de pixels por segundo.

No problema reproduzido, entretanto, não havia apenas igualdade de FPS. O aplicativo destruía resolução sem atacar o estágio que limitava a cadência.

### 1.2 Constraints espaciais eram descartadas

**Observado no código anterior:** a captura era criada com `screenCaptureConstraints(profile.id, sourceId)`, mas logo depois executava:

```js
videoTrack.applyConstraints({
  frameRate: { ideal: profile.frameRate, max: profile.frameRate },
});
```

Pelo algoritmo de [`applyConstraints`](https://www.w3.org/TR/mediacapture-streams/#dom-constrainablepattern-applyconstraints), a chamada passa a ser o novo conjunto de constraints do track. Ela não é um merge implícito com largura e altura anteriores.

**Medido antes da correção:** no run `bench-m150.json`, desempenho registrou:

```text
track constraints: { frameRate: { ideal: 60, max: 60 } }
source settings:   640×360 @ 60
sender output:     427×240
```

**Correção:** reaplicar `screenCaptureConstraints(profile.id)` inteiro depois que o track é criado. No run corrigido, `getConstraints()` contém width, height e frameRate, e `getSettings()` retorna 960×540 no desempenho e 1920×1080 na qualidade.

### 1.3 A adaptação confundia origem lenta com encoder lento

**Observado no código anterior:** o controlador usava o menor valor entre `captureFps` e `framesPerSecond` como pressão geral. Um FPS absoluto abaixo da meta podia causar downscale sem verificar se havia perda entre captura e encode. Também tratava qualquer amostra `bandwidth` como pressão imediata.

Isso é incorreto quando:

```text
capture FPS < target FPS
encode FPS ≈ capture FPS
encode time << frame budget
quality limitation = none
```

Nesse estado, o encoder já preserva o que recebe. Escalar depois da captura não faz a origem produzir mais frames; apenas reduz detalhe.

**Medido antes da correção:** desempenho terminou em `scaleResolutionDownBy = 1.5`, nível 2 e razão final encode/captura próxima de 1. O motivo registrado era `bandwidth`, embora o run local não tivesse perda de pacotes relevante. O resultado agregado foi:

```text
capture 59,92 FPS → encode 56,03 FPS → present 56,14 FPS
427×240, OpenH264, QP 40,0
```

**Correção:** o controlador agora classifica o gargalo por estágio:

- `source`: captura abaixo da meta, encode/captura ≥ 0,92, encode com folga e sem limitação de rede;
- `encoder`: encode/captura < 0,90 ou encode time consome o orçamento do frame;
- `network`: `bandwidth` persistente e `availableOutgoingBitrate / configuredMaxBitrate < 0,92`;
- `healthy`: cadência próxima da meta, encode com folga e sem pressão de CPU/rede.

Uma origem limitada não gera downshift. Se um downshift anterior não ajudou, o controlador recupera um nível depois de duas amostras source-limited.

### 1.4 Downscale duplo e fallback de encoder

**Observado no código anterior:** desempenho usava `degradationPreference = maintain-framerate` e o aplicativo também aplicava `scaleResolutionDownBy`. Chromium e controlador podiam degradar a dimensão espacial de forma independente.

**Medido:** o run antigo terminou em 240p e `encoderImplementation = OpenH264`. Depois de impor piso de 360p e usar `maintain-resolution`, o mesmo host permaneceu em `MediaFoundationVideoEncodeAccelerator (NVIDIA H.264 Encoder MFT)`.

**Inferido:** neste hardware/runtime, cruzar abaixo de 360p provocou a seleção do caminho por software. O benchmark demonstra a correlação 240p/OpenH264 e 360p+/NVIDIA MFT, mas não prova que 360p seja um limite universal de todos os drivers e versões Chromium.

### 1.5 Limitação estrutural ainda existente no Chromium

O [`DesktopCaptureDevice` do Chromium](https://chromium.googlesource.com/chromium/src/+/refs/heads/main/content/browser/media/capture/desktop_capture_device.cc) limita por padrão o custo de captura a aproximadamente 50% de um core. Se readback/conversão demorar, o scheduler aumenta o intervalo entre capturas.

**Observado no código upstream, não medido como causa neste app:** essa política pode explicar por que uma captura pesada fica source-limited. Ela é motivação para o roadmap nativo, mas não deve ser apresentada como causa comprovada do caso Forza sem ETW/trace do jogo.

## 2. Arquitetura atual corrigida

```text
desktopCapturer / getDisplayMedia
        │
        ├─ constraints completos por perfil
        ├─ contentHint = motion
        ▼
MediaStreamTrack de tela
        │
        ├─ uma RTCRtpSender por peer
        ├─ H.264 > VP9 > VP8
        ├─ maxFramerate e maxBitrate por perfil/peer
        ├─ scaleResolutionDownBy controlado pelo app
        ▼
Chromium WebRTC + hardware encoder quando disponível
        │
        ├─ GCC/TWCC/pacer do WebRTC
        ▼
receptor
        ├─ jitterBufferTarget por perfil
        └─ requestVideoFrameCallback para FPS/latência apresentados
```

### 2.1 Regras de captura

- Constraints espaciais e temporais são aplicadas juntas.
- O track não é reconfigurado a cada amostra. Reiniciar constraints durante a transmissão pode interromper timestamps e cadência.
- A adaptação espacial ocorre no sender por `scaleResolutionDownBy`.
- `contentHint = motion` comunica que movimento contínuo é mais importante que preservar detalhe estático.

### 2.2 Regras de adaptação

- Intervalo de decisão: 1,5 s.
- As três primeiras amostras são somente observação de startup.
- Pressão puramente de rede reduz o budget de bitrate, não a resolução; o estado só é classificado como sustentado após quatro amostras em desempenho ou seis em qualidade.
- Downshift por FPS só ocorre quando há perda entre captura e encode.
- Encode time é comparado ao orçamento de 16,67 ms em 60 FPS ou 33,33 ms em 30 FPS.
- Cada downshift de encoder abre um trial de três amostras. Ele só permanece com ganho de delivery ≥8 pontos percentuais, recuperação para ≥0,92 ou queda de custo de encode ≥15%; caso contrário volta exatamente ao nível anterior e entra em cooldown.
- Downshift comprovadamente eficaz é rápido; recuperação é lenta e tem cooldown.
- O bitrate acompanha aproximadamente o número de pixels, preservando 22% de headroom da estimativa de uplink.
- Cada peer possui seu próprio estado, encoder e congestion controller. Um peer ruim não altera diretamente o perfil dos demais.

### 2.3 O que a arquitetura atual não é

- Não é um pipeline nativo zero-readback.
- Não escolhe diretamente presets NVENC/AMF/Quick Sync.
- Não garante hardware encode apenas porque `video_encode` aparece como enabled; o campo `encoderImplementation` do stream deve confirmar.
- Não usa simulcast espacial. Para um receptor P2P, isso duplicaria encode/pixel-rate sem benefício claro.
- Não substitui o GCC/pacer do WebRTC por um controlador próprio.

## 3. Perfis e trade-offs

| Propriedade | Desempenho | Qualidade |
|---|---:|---:|
| Objetivo | movimento/latência | detalhe espacial |
| Captura nominal | 1280×720 @ 60 FPS | 1920×1080 @ 30 FPS |
| Níveis espaciais | 720p, 540p, 360p | 1080p, 900p, 720p |
| Bitrate máximo, 1 peer | 8 Mbps | 8 Mbps |
| Bitrate mínimo | 1,2 Mbps | 1,2 Mbps |
| `degradationPreference` | `maintain-resolution` | `maintain-resolution` |
| `contentHint` | `motion` | `motion` |
| Codec preferido | H.264 por hardware | H.264 por hardware |
| Buffer-alvo do receptor | 140 ms | 180 ms |
| Pressão necessária | reage mais cedo | reage mais cautelosamente |

`maintain-resolution` em desempenho parece contraintuitivo, mas é deliberado: evita uma segunda adaptação espacial oculta no Chromium. A prioridade temporal continua sendo implementada pelo target de 60 FPS e pelo controlador do aplicativo, que reduz resolução somente quando há evidência de pressão downstream.

Trade-offs:

- Desempenho processa o dobro de frames, com 4/9 dos pixels por frame de 1080p e aproximadamente 89% do pixel-rate total. Sob a carga WebGL 128, isso resultou em encode de 2,53 ms/frame contra 4,53 ms/frame em qualidade.
- Qualidade preserva texto, HUD e detalhes finos, mas seu intervalo nominal é 33,3 ms e sua latência/jitter buffer são maiores.
- Em um jogo que a API de captura só consiga observar a 30 FPS, os dois perfis podem mostrar cadência semelhante. A diferença correta passa a ser menor pixel-rate/latência no desempenho, sem uma queda autodestrutiva para 240p.
- H.264 é o baseline por compatibilidade e hardware. VP9/AV1 só devem subir de prioridade quando `encoderImplementation`, energia, latência e matriz de drivers demonstrarem vantagem.

## 4. Telemetria

### 4.1 Estágios medidos

O coletor usa [`RTCStatsReport`](https://www.w3.org/TR/webrtc-stats/) e resolve reports ligados ao mesmo track/SSRC:

| Estágio | Campos principais | Derivação |
|---|---|---|
| Fonte | `media-source.frames`, width, height, FPS | `Δframes / Δt` |
| Encoder | `framesEncoded`, `totalEncodeTime`, `qpSum` | FPS, ms/frame, QP/frame |
| Sender | `framesSent`, bytes, retransmissões, packet delay | FPS e bitrate efetivos |
| Rede | available outgoing bitrate, RTT, loss, jitter | headroom e congestionamento |
| Decoder | frames received/decoded/dropped, decode time | retenção e ms/frame |
| Jitter buffer | delay, target/minimum, emitted count | delay médio por frame |
| Render | `requestVideoFrameCallback` | FPS apresentado, intervalos e latência |

Relações diagnósticas:

```text
retenção capture→encode = ΔframesEncoded / ΔsourceFrames
retenção encode→decode  = ΔframesDecoded / ΔframesEncoded
retenção capture→present = ΔpresentedFrames / ΔsourceFrames
encode ms/frame         = 1000 × ΔtotalEncodeTime / ΔframesEncoded
bitrate efetivo         = 8 × ΔbytesSent / Δtempo
```

Não se deve usar apenas `framesPerSecond`, porque um único número não identifica onde o frame desapareceu.

### 4.2 Telemetria opt-in no aplicativo

Adicionar `streamTelemetry` à query string ativa snapshots locais e eventos de adaptação:

```text
http://127.0.0.1:8787/?room=teste&streamTelemetry=1
```

O estado fica em `globalThis.__jumpStreamTelemetry` e é somente diagnóstico. Falha de telemetria não deve interromper a chamada.

## 5. Harness de benchmark

O harness `tests/screen-share-benchmark.e2e.cjs`:

- cria sender e receiver Electron via loopback;
- usa uma fixture determinística 1920×1080/60;
- alterna a ordem dos perfis entre repetições;
- coleta stats a cada 250 ms;
- mede apresentação com `requestVideoFrameCallback`;
- suporta pressão WebGL sintética;
- suporta fonte externa Chrome ou ffplay para exercitar WGC entre processos;
- mede CPU/memória por processo Electron e, quando disponível, utilização/VRAM/potência/temperatura da GPU via `nvidia-smi`;
- alterna `window|screen` e permite A/B de features do Chromium sem alterar o app;
- grava manifesto de runtime, OS, CPU, GPU, display, configuração, commit e working tree.

### 5.1 Testes rápidos

```powershell
node --test tests/screen-share-profiles.test.js tests/screen-share-telemetry.test.js
npm run build
```

### 5.2 Benchmark de release no runtime atual

```powershell
$env:JUMP_BENCH_WARMUP_MS = '15000'
$env:JUMP_BENCH_DURATION_MS = '60000'
$env:JUMP_BENCH_REPEATS = '5'
$env:JUMP_BENCH_SAMPLE_MS = '250'
$env:JUMP_BENCH_PRETTY = '1'
$env:JUMP_BENCH_OUTPUT = 'artifacts/bench-m150-release.json'
npm run test:stream-benchmark
```

Com `JUMP_BENCH_OUTPUT`, o JSON completo vai somente para o arquivo para não inundar o terminal. Defina `JUMP_BENCH_STDOUT=1` quando um runner de CI precisar consumir o relatório por stdout.

### 5.3 Pressão sintética de GPU

```powershell
$env:JUMP_BENCH_PROFILES = 'performance'
$env:JUMP_BENCH_GPU_LOAD = '128'
$env:JUMP_BENCH_OUTPUT = 'artifacts/bench-m150-gpu128.json'
npm run test:stream-benchmark
```

`JUMP_BENCH_GPU_LOAD` é a quantidade de iterações do shader WebGL da fixture. **Não é porcentagem de utilização da GPU.** Para medir GPU 3D/copy/video e impacto no jogo, usar PresentMon/ETW/GPUView.

O harness consulta `nvidia-smi` apenas quando ele existe. Desative essa amostragem com `JUMP_BENCH_NVIDIA_SMI=0`; o benchmark WebRTC continua válido em AMD/Intel, apenas sem os contadores NVIDIA.

### 5.4 Fonte externa do Chrome

```powershell
$env:JUMP_BENCH_PROFILES = 'performance'
$env:JUMP_BENCH_EXTERNAL_SOURCE = 'chrome'
$env:JUMP_BENCH_WARMUP_MS = '2000'
$env:JUMP_BENCH_DURATION_MS = '6000'
$env:JUMP_BENCH_REPEATS = '1'
$env:JUMP_BENCH_OUTPUT = 'artifacts/bench-m150-chrome.json'
npm run test:stream-benchmark
```

Esse cenário é mais representativo do que capturar uma janela do mesmo Electron para verificar a rota WGC interprocesso.

### 5.5 A/B de tela inteira WGC versus DDA

```powershell
$env:JUMP_BENCH_CAPTURE_TYPE = 'screen'
$env:JUMP_BENCH_EXTERNAL_SOURCE = 'chrome'
$env:JUMP_BENCH_PROFILES = 'performance'

# WGC padrão do Windows 11 24H2
Remove-Item Env:JUMP_BENCH_DISABLE_FEATURES -ErrorAction SilentlyContinue
$env:JUMP_BENCH_OUTPUT = 'artifacts/bench-screen-wgc.json'
npm run test:stream-benchmark

# DXGI Desktop Duplication
$env:JUMP_BENCH_DISABLE_FEATURES = 'AllowWgcScreenCapturer'
$env:JUMP_BENCH_OUTPUT = 'artifacts/bench-screen-dda.json'
npm run test:stream-benchmark
```

### 5.6 M152 sem instalar ou alterar o lockfile

```powershell
npm run build

$env:JUMP_BENCH_OUTPUT = 'artifacts/bench-m152-off.json'
npm exec --yes --package=electron@44.0.0-beta.6 -- `
  electron tests/screen-share-benchmark.e2e.cjs

$env:JUMP_BENCH_OUTPUT = 'artifacts/bench-m152-wgc-texture.json'
npm exec --yes --package=electron@44.0.0-beta.6 -- `
  electron `
  --enable-features=WebRtcAllowWgcUsingTexture `
  tests/screen-share-benchmark.e2e.cjs
```

`npm exec --package` usa o cache do npm. Nos probes desta rodada, os hashes de `package.json` e `package-lock.json` e o `git status` permaneceram idênticos.

### 5.7 Trace do caminho texture

```powershell
$env:JUMP_BENCH_PROFILES = 'performance'
$env:JUMP_BENCH_EXTERNAL_SOURCE = 'chrome'
$env:JUMP_BENCH_OUTPUT = 'artifacts/bench-m152-wgc-chrome.json'

npm exec --yes --package=electron@44.0.0-beta.6 -- `
  electron `
  --enable-features=WebRtcAllowWgcUsingTexture `
  --trace-startup=disabled-by-default-video_and_image_capture,webrtc,media,gpu `
  --trace-startup-file="$PWD\artifacts\wgc-external-trace.json" `
  tests/screen-share-benchmark.e2e.cjs
```

Evidência positiva do caminho:

```text
DesktopCaptureDevice::DeliverTextureToClient
storage_type: GpuMemoryBuffer
```

Somente passar a flag não prova que a fonte selecionada produziu textures.

### 5.8 Benchmark de jogos

O próximo benchmark real deve executar cada jogo em três estados: sem stream, desempenho e qualidade, com mesma cena/rota/configuração. O [PresentMon](https://github.com/GameTechDev/PresentMon) deve registrar frametime de CPU/GPU/display, incluindo 1%/0,1% lows. Exemplo a adaptar ao executável instalado:

```powershell
PresentMon.exe `
  --process_name ForzaHorizon5.exe `
  --timed 120 `
  --track_gpu_video `
  --output_file artifacts/presentmon-forza-performance.csv
```

Usar [GPUView](https://learn.microsoft.com/en-us/windows-hardware/drivers/display/using-gpuview) quando houver stalls, cópia cross-adapter ou device contention.

## 6. Resultados empíricos

### 6.1 Ambiente

Todos os números abaixo são da execução local de 2026-08-23:

```text
Windows 11 Pro 10.0.26200
AMD Ryzen 7 5700X, 16 threads
32 GiB RAM
NVIDIA GeForce RTX 3060
driver 32.0.15.9636
display 2560×1440 @ 165 Hz
transporte P2P em loopback local
```

Os manifests reportaram aceleração, GPU compositing e video encode como enabled. Também reportaram `supportsD3dSharedImages = false`; isso é **medido**, mas seu papel no fallback observado com a feature M152 é apenas **inferido**.

### 6.2 Antes e depois da correção no M150

Runs: 3 s de warmup, 10 s de medição, uma repetição.

| Versão do código/perfil | Capture FPS | Encode FPS | Present FPS | Saída | Encoder | Encode ms | QP | Bitrate | Intervalo p95 |
|---|---:|---:|---:|---:|---|---:|---:|---:|---:|
| Antes — desempenho | 59,92 | 56,03 | 56,14 | 427×240 | OpenH264 | 2,59 | 40,0 | 2,87 Mbps | 30,3 ms |
| Corrigido — desempenho | 60,06 | 59,96 | 59,77 | 960×540 | NVIDIA H.264 MFT | 2,27 | 34,3 | 5,49 Mbps | 18,3 ms |
| Antes — qualidade | 29,97 | 29,97 | 29,93 | 1920×1080 | NVIDIA H.264 MFT | 5,71 | 31,0 | 7,20 Mbps | 36,5 ms |
| Corrigido — qualidade | 29,96 | 29,96 | 29,96 | 1920×1080 | NVIDIA H.264 MFT | 4,91 | 29,2 | 7,86 Mbps | 36,4 ms |

Outras medidas do run corrigido:

| Perfil | Jitter buffer médio | Post-receive p95 | Encode/capture |
|---|---:|---:|---:|
| Desempenho | 110,1 ms | 136,3 ms | 0,998 |
| Qualidade | 155,2 ms | 176,6 ms | 1,000 |

**Conclusão medida:** desempenho agora entrega aproximadamente o dobro da cadência da qualidade, mantém hardware encode e melhora simultaneamente resolução, retenção e regularidade em relação ao código anterior.

**Não concluído:** este run sintético não mede FPS/1% low do Forza ou Ultrakill nem qualidade perceptual VMAF.

### 6.3 Electron/Chromium M150 e M152

Os binários reais foram consultados por `process.versions`:

| Electron | Chromium | `WebRtcAllowWgcUsingTexture` |
|---|---|---|
| 43.4.1 | 150.0.7871.224 | ausente no código/binário |
| 44.0.0-beta.6 | 152.0.7977.30 | presente, disabled by default |

Fonte oficial do M152:

- [definição da feature](https://chromium.googlesource.com/chromium/src/+/152.0.7977.30/media/webrtc/webrtc_features.cc#23);
- [uso no DesktopCaptureDevice e alinhamento do adapter LUID](https://chromium.googlesource.com/chromium/src/+/152.0.7977.30/content/browser/media/capture/desktop_capture_device.cc#1336).

Fixture interna, 3 s + 10 s, uma repetição:

| Runtime/feature/perfil | Capture FPS | Encode FPS | Present FPS | Encode ms | Capture→compositor p95 | Intervalo p95 |
|---|---:|---:|---:|---:|---:|---:|
| M152 off — desempenho | 59,90 | 59,90 | 59,72 | 1,86 | 134,0 ms | 18,3 ms |
| M152 on — desempenho | 59,91 | 59,91 | 59,67 | 1,95 | 140,2 ms | 18,3 ms |
| M152 off — qualidade | 29,97 | 30,07 | 29,97 | 5,31 | 187,6 ms | 36,5 ms |
| M152 on — qualidade | 29,96 | 29,96 | 29,96 | 4,73 | 188,6 ms | 36,4 ms |

**Conclusão medida:** a feature não trouxe ganho de cadência ou latência na fixture interna.

**Explicação comprovada pelo trace:** esse teste não exerceu o ramo texture; `wgc-texture-trace.json` teve zero ocorrências de `DesktopCaptureDevice::DeliverTextureToClient`. Portanto, ele só demonstra ausência de regressão pela presença da flag quando a fonte não usa essa rota.

### 6.4 Pressão WebGL sintética

Somente perfil desempenho:

| Runtime/feature | Iterações WebGL | Present FPS | Encode ms | Intervalo p95 | Capture→compositor p95 |
|---|---:|---:|---:|---:|---:|
| M150 | 32 | 59,70 | 1,92 | 24,3 ms | indisponível |
| M150 | 128 | 59,76 | 2,03 | 24,2 ms | indisponível |
| M152 off | 32 | 59,71 | 2,22 | 18,3 ms | 144,0 ms |
| M152 off | 128 | 59,54 | 1,80 | 18,4 ms | 127,0 ms |
| M152 texture on | 32 | 59,54 | 2,17 | 18,4 ms | 140,5 ms |
| M152 texture on | 128 | 59,59 | 1,94 | 24,3 ms | 127,2 ms |

**Conclusão medida:** todos permaneceram entre 59,5 e 59,8 FPS apresentados. M152 off melhorou o intervalo p95 neste fixture, mas a feature texture não foi consistentemente melhor e voltou a 24,3 ms no nível 128.

**Limite:** não houve coleta de porcentagem de GPU, video-engine load ou frametime de um jogo. `32/128` são parâmetros do shader, não utilização de hardware.

### 6.5 Fonte externa Chrome: teste que exerceu WGC texture

Runs: 2 s de warmup, 6 s de medição, uma repetição, somente desempenho.

| Runtime/feature | Capture FPS | Encode FPS | Present FPS | Encode ms | Encode/capture | Encoder | Capture→compositor p95 | Intervalo p95 | Post-receive p95 |
|---|---:|---:|---:|---:|---:|---|---:|---:|---:|
| M150 | 55,00 | 55,00 | 54,50 | 2,47 | 1,000 | NVIDIA H.264 MFT | indisponível | 24,3 ms | 117,8 ms |
| M152 off | 54,84 | 54,84 | 54,50 | 2,48 | 1,000 | NVIDIA H.264 MFT | 129,3 ms | 24,2 ms | 126,2 ms |
| M152 texture on | 54,84 | 50,00 | 49,32 | 7,83 | 0,912 | OpenH264 | 148,4 ms | 36,4 ms | 139,0 ms |

O trace `wgc-external-trace.json` contém:

```text
189 × DesktopCaptureDevice::DeliverTextureToClient
539 × GpuMemoryBuffer
```

Logo, **foi medido** que o caminho texture esteve ativo. Comparado ao M152 off:

- FPS apresentado caiu 9,5%;
- FPS codificado caiu 8,8%;
- encode médio ficou 3,16× mais lento;
- intervalo p95 piorou 12,2 ms;
- capture-to-compositor p95 piorou 19,1 ms;
- o encoder reportado mudou de NVIDIA MFT para OpenH264.

**Inferido, não provado:** uma incompatibilidade/falha entre texture/GpuMemoryBuffer/SharedImage e o encoder de hardware fez o WebRTC escolher OpenH264. O trace mostra o ramo texture e o benchmark mostra a troca de encoder, mas ainda falta localizar o evento exato que causou a seleção/fallback.

### 6.6 Perfil final 720p e recursos do sistema

O perfil desempenho final foi testado em 1280×720 com `JUMP_BENCH_GPU_LOAD=128`. Estes runs têm 3 s de warmup, 10 s de medição e uma repetição:

| Fonte/perfil | Capture FPS | Encode FPS | Present FPS | Saída | Encode ms | QP | CPU Electron | GPU | NVENC |
|---|---:|---:|---:|---:|---:|---:|---:|---:|---:|
| Electron — desempenho | 59,94 | 59,83 | 59,68 | 1280×720 | 2,53 | 36,2 | 9,90% | 38,73% | 6,18% |
| Electron — qualidade | 24,89 | 24,89 | 24,79 | 1920×1080 | 4,53 | 28,8 | 7,77% | 31,45% | 4,73% |
| Chrome externo — desempenho | 54,93 | 55,03 | 54,53 | 1280×720 | 3,08 | 39,3 | 6,66% | 38,00% | 4,60% |
| Chrome externo — qualidade | 26,00 | 26,00 | 25,94 | 1920×1080 | 5,99 | 25,1 | 5,52% | 27,55% | 5,09% |

**Conclusão medida:** sob contenção, desempenho preservou 2,41× a cadência apresentada da qualidade na fonte interna e 2,10× na janela externa. O encoder e decoder permaneceram acelerados por hardware.

Para decidir entre 540p e 720p, foram executadas três repetições de 2 s + 6 s com Chrome externo, tela inteira, DDA e carga 128:

| Desempenho | Present FPS mediano | Intervalo p95 | Encode ms | CPU Electron | NVENC | Bitrate |
|---|---:|---:|---:|---:|---:|---:|
| 960×540 | 57,16 | 18,3 ms | 1,83 | 5,47% | 3,0% | 5,87 Mbps |
| 1280×720 | 56,99 | 18,3 ms | 2,77 | 5,96% | 4,8% | 7,07 Mbps |

720p custou 0,48 ponto percentual de CPU Electron e 1,8 ponto no engine NVENC, mas perdeu apenas 0,17 FPS apresentados (0,29%). Esse custo pequeno compra 77,8% mais pixels por frame; por isso 720p foi escolhido como o topo do perfil desempenho.

### 6.7 Tela inteira: WGC versus DXGI Desktop Duplication

No Windows 11 24H2, o Chromium pode habilitar WGC para tela inteira mesmo quando a feature não foi explicitamente ligada. O código upstream documenta essa seleção e respeita um override explícito de `AllowWgcScreenCapturer` ([Chromium](https://chromium.googlesource.com/chromium/src.git/+/refs/heads/lkgr/content/browser/media/capture/desktop_capture_device.cc)). O libwebrtc descreve o cropping/DXGI como capaz de frame rates significativamente maiores, com trade-offs de oclusão para captura de janela ([DesktopCaptureOptions](https://webrtc.googlesource.com/src/+/e922cd12628e32b37c06c2be4d23e4f8a1452e80/modules/desktop_capture/desktop_capture_options.h)). O override adotado aqui afeta apenas `TYPE_SCREEN`; janelas continuam no WGC, que captura corretamente conteúdo ocluído.

Três repetições de 2 s + 6 s, Chrome externo fullscreen, 720p desempenho e carga 128:

| Backend | Capture FPS mediano | Encode FPS | Present FPS | Intervalo p95 | CPU Electron | GPU |
|---|---:|---:|---:|---:|---:|---:|
| WGC | 55,01 | 55,01 | 54,95 | 24,2 ms | 6,05% | 49,0% |
| DDA | 57,12 | 57,00 | 56,99 | 18,3 ms | 5,96% | 50,4% |

DDA entregou 3,7% mais FPS apresentados e removeu um degrau de pacing p95, com CPU ligeiramente menor e 1,4 ponto percentual a mais de GPU. A produção desabilita WGC somente para tela inteira no Windows. `JUMP_SCREEN_CAPTURE_BACKEND=wgc` é o escape por sessão para drivers/máquinas em que DDA apresente regressão.

### 6.8 Artefatos locais

Os principais arquivos são:

```text
artifacts/bench-m150.json
artifacts/bench-m150-fixed.json
artifacts/bench-m152-off.json
artifacts/bench-m152-wgc-texture.json
artifacts/bench-m150-gpu32.json
artifacts/bench-m150-gpu128.json
artifacts/bench-m152-off-gpu32.json
artifacts/bench-m152-off-gpu128.json
artifacts/bench-m152-wgc-texture-gpu32.json
artifacts/bench-m152-wgc-texture-gpu128.json
artifacts/bench-m150-chrome.json
artifacts/bench-m152-off-chrome.json
artifacts/bench-m152-wgc-chrome.json
artifacts/bench-m150-720-gpu128.json
artifacts/bench-m150-720-chrome-gpu128.json
artifacts/bench-m150-screen-wgc-720-gpu128-r3.json
artifacts/bench-m150-screen-dda-720-gpu128-r3.json
artifacts/bench-m150-screen-dda-540-gpu128-r3.json
artifacts/wgc-external-trace.json
```

`artifacts/` é ignorado pelo Git. Os JSONs armazenam o commit base e o estado dirty usado no teste; não devem ser confundidos com resultados de uma release publicada.

## 7. Decisão: manter M150; não ativar a feature

### 7.1 `WebRtcAllowWgcUsingTexture`: no-go

Motivos:

1. É uma feature disabled by default no M152.
2. Não existe no M150 atual; ativá-la na linha de comando do Electron 43 é inócuo.
3. No fixture interno, a flag não exerceu o caminho texture e não trouxe ganho.
4. Na fonte externa, onde o trace confirmou o caminho, houve regressão material e fallback observado para OpenH264.
5. O comportamento precisa ser validado em NVIDIA, AMD, Intel e notebooks híbridos antes de produção.

Critério para reconsiderar: runtime estável, hardware encoder preservado, trace positivo, cinco repetições sem regressão e ganho mensurável de CPU/GPU/latência em ao menos duas famílias de GPU.

### 7.2 Electron 44 beta: no-go

M152 off apresentou alguns intervalos p95 melhores sob pressão WebGL, mas:

- o ganho não foi consistente em todas as dimensões;
- não houve benchmark longo/multimáquina;
- a release é beta;
- atualizar Electron mistura mudanças de Chromium, libwebrtc, Node e segurança, exigindo uma regressão completa do app;
- a melhoria observada não compensa o risco atual.

A atualização deve ser reavaliada quando a linha Electron 44 correspondente estiver estável, independentemente da feature WGC texture.

### 7.3 Decisão operacional atual

- Manter Electron 43.4.1/M150.
- Entregar a correção de constraints e adaptação stage-aware.
- Usar 1280×720/60 como topo de desempenho; os trials comprovam ou revertem os níveis 540p/360p.
- No Windows, usar DDA para tela inteira e WGC para janelas; manter `JUMP_SCREEN_CAPTURE_BACKEND=wgc` como escape.
- Usar H.264/NVIDIA MFT observado neste host como baseline, sempre validando `encoderImplementation` em runtime.
- Executar benchmark longo e testes reais Forza/Ultrakill antes de declarar o objetivo encerrado.
- Não adicionar a feature experimental de texture ao `main.cjs` ou ao pacote de produção.

## 8. Roadmap nativo GPU-resident

O objetivo de longo prazo é remover readback CPU e manter o frame na GPU desde a captura até o encoder:

```text
WGC CreateFreeThreaded / DXGI Desktop Duplication
                    │ ID3D11Texture2D
                    ▼
crop / scale / tone-map / BGRA→NV12 ou P010 na GPU
                    │ ring de superfícies + fence
                    ▼
Media Foundation hardware encoder
ou NVENC / AMF / oneVPL, se necessário
                    │
                    ▼
libwebrtc RTP + GCC/TWCC + pacer
```

“Zero-copy” deve significar **zero readback para CPU**. Uma cópia GPU→GPU para formato ou compartilhamento ainda pode ser necessária e aceitável.

### Fase 0 — baseline e observabilidade

**Estado:** implementada no working tree; validação de release pendente.

Entregáveis:

- telemetry snapshot por estágio;
- fixture determinística e fonte externa;
- alternância de ordem e repetições;
- trace WGC/GpuMemoryBuffer;
- baseline sem stream para jogos reais.

Gate de saída:

- cinco runs de 60 s por perfil;
- desempenho interno: ≥58 FPS apresentados, encode/capture ≥0,98, intervalo p95 ≤20 ms;
- qualidade interna: ≥29 FPS apresentados, encode/capture ≥0,98, intervalo p95 ≤40 ms;
- zero freezes em LAN limpa;
- nenhum fallback para software em 360p ou mais no hardware suportado;
- Forza e Ultrakill: queda de 1% low ≤5% e queda de FPS médio ≤3% contra jogo sem stream.

Se o M150 corrigido cumprir os gates em hardware-alvo, ele permanece como release enquanto o core nativo é prototipado separadamente.

### Fase 1 — reavaliar Chromium GPU texture estável

Entregáveis:

- Electron/Chromium estável que contenha a feature ou equivalente;
- A/B no mesmo runtime, flag off/on;
- source externa e jogos reais;
- ETW de CPU, GPU 3D, copy e video encode;
- fallback e device-reset tests.

Gate go:

- trace `DeliverTextureToClient` presente;
- hardware encoder permanece ativo em 100% dos runs;
- encode/capture ≥0,98;
- nenhuma regressão >5% em FPS, intervalo p95 ou 1% low;
- ao menos 10% de redução em CPU de captura, GPU copy ou capture-to-present p95 em duas famílias de GPU.

Gate no-go:

- qualquer fallback recorrente para OpenH264/software;
- crash/device lost sem fallback limpo;
- ganho somente em fixture interna que não exerça WGC texture;
- regressão semelhante ao M152 externo desta rodada.

### Fase 2 — protótipo nativo de captura D3D11

Implementar em helper/addon C++ isolado:

- [Windows Graphics Capture](https://learn.microsoft.com/en-us/windows/uwp/audio-video-camera/screen-capture) com [`Direct3D11CaptureFramePool.CreateFreeThreaded`](https://learn.microsoft.com/en-us/uwp/api/windows.graphics.capture.direct3d11captureframepool.createfreethreaded) para janelas;
- [DXGI Desktop Duplication](https://learn.microsoft.com/en-us/windows/win32/direct3ddxgi/desktop-dup-api) para monitor/fullscreen e fallback;
- adapter LUID igual ao GPU process/encoder;
- fila bounded “latest frame wins”;
- timestamp QPC por frame;
- resize, cursor, rotation, HDR/tone mapping e device lost.

Gate go:

- nenhum `Map`/readback de frame no steady state, confirmado por trace;
- captura 1080p60 ≥59 FPS em fonte externa;
- tempo capture/copy p95 ≤4 ms;
- fila p95 <16,7 ms e sem crescimento contínuo;
- soak de 30 minutos sem leak, deadlock ou device lost não recuperado;
- impacto nos 1% lows do jogo dentro do gate da fase 0.

Não integrar ao produto se o protótipo não superar o WGC/Chromium estável com a mesma qualidade.

### Fase 3 — conversão e encode GPU-resident

Primeira implementação:

- D3D11 Video Processor ou compute shader para BGRA→NV12;
- P010/tone mapping apenas quando HDR for necessário;
- ring de 2–3 superfícies e sincronização por fence/keyed mutex;
- Media Foundation low-latency antes de APIs específicas de fabricante.

O [`ID3D11VideoContext::VideoProcessorBlt`](https://learn.microsoft.com/en-us/windows/win32/api/d3d11/nf-d3d11-id3d11videocontext-videoprocessorblt) escreve diretamente em superfícies D3D. O Media Foundation expõe [`CODECAPI_AVLowLatencyMode`](https://learn.microsoft.com/en-us/windows/win32/medfound/codecapi-avlowlatencymode), com o trade-off documentado de possível redução de qualidade.

Gate go:

- H.264 hardware sem fallback em todos os perfis suportados;
- encode p95 <8 ms em 1080p60 e p99 <16,7 ms;
- encode/capture ≥0,98;
- fila capture→encode p95 <1 frame;
- capture-to-present p95 ao menos 15% melhor que o baseline estável ou custo de jogo ao menos 10% menor;
- recuperação automática de encoder/device reset.

### Fase 4 — integração nativa com libwebrtc

Se Media Foundation/Chromium não aceitar a textura sem cópia/readback, integrar native frames e um `VideoEncoderFactory` próprio ou manter um fork mínimo de libwebrtc.

Regras:

- preservar GCC/TWCC e pacing;
- nunca criar fila ilimitada antes do encoder;
- descartar frame vencido antes de conversão/encode;
- singlecast por padrão em P2P com um receptor;
- testar `L1T2` somente se hardware e receptor realmente suportarem temporal scalability.

Gate go:

- desempenho: ≥58 FPS apresentados em LAN, intervalo p95 ≤20 ms e zero freeze;
- capture-to-present p95 <120 ms ou melhora relativa ≥20%;
- qualidade: ≥29 FPS apresentados em 1080p e retenção ≥0,98;
- perda de pacote, RTT e rate changes não geram fila crescente;
- matriz NVIDIA/AMD/Intel e notebook híbrido aprovada.

### Fase 5 — encoders de fabricante e AV1

Somente se Media Foundation não atingir os gates:

- [NVENC](https://docs.nvidia.com/video-technologies/video-codec-sdk/13.1/nvenc-video-encoder-api-prog-guide/index.html): D3D11 input, LL/ULL, P1–P7, async output, sem B-frames no perfil low-latency;
- [AMD AMF](https://github.com/GPUOpen-LibrariesAndSDKs/AMF/blob/master/amf/doc/AMF_Video_Encode_API.md): low/ultra-low latency e superfícies D3D11;
- [Intel oneVPL](https://intel.github.io/libvpl/latest/programming_guide/VPL_prg_hw.html): D3D11 surfaces, `AsyncDepth = 1`, `GopRefDist = 1`.

H.264 continua baseline. AV1 hardware só passa para qualidade quando:

- não usa software encode;
- mantém latência dentro de 10% do H.264;
- melhora VMAF em pelo menos 5 pontos no mesmo bitrate, ou reduz bitrate em pelo menos 25% na mesma qualidade;
- funciona na matriz de drivers e no receptor.

Para qualidade objetiva, usar [VMAF](https://github.com/Netflix/vmaf) com referência e recepção temporalmente alinhadas, além de CAMBI/SSIM e métricas de frames duplicados/perdidos.

## 9. Riscos

| Risco | Consequência | Mitigação/gate |
|---|---|---|
| GPU/driver/vendor | fallback, crash, frame corruption | capability probe, matriz e fallback por sessão |
| Notebook híbrido | cópia cross-adapter e stalls | adapter LUID explícito e teste dGPU/iGPU |
| GPU process/device reset | textura inválida | recriar device/pool/encoder e fallback limpo |
| Fork Chromium/libwebrtc | alto custo de atualização e segurança | patch mínimo, CI contra upstream, evitar se MF atender |
| NVENC/AMF/oneVPL | três implementações e semânticas diferentes | interface comum e vendor APIs somente após gate MF |
| HDR/colorspace | imagem lavada ou clipping | P010/float e tone mapping testado |
| Fila excessiva | FPS nominal alto, latência crescente | latest-frame queue e métricas p95/p99 |
| Adaptadores simultâneos | uma conexão ruim degrada outras | estado e budget por peer |
| Simulcast desnecessário | múltiplos encodes e maior GPU load | singlecast P2P; simulcast só com SFU/múltiplos receptores |
| Hook no processo do jogo | anti-cheat, crashes e segurança | fora do roadmap padrão; somente estudo opt-in isolado |

## 10. Critério final go/no-go para trocar a arquitetura

Prosseguir do Chromium corrigido para um core nativo somente se todas as condições forem verdadeiras:

1. Benchmarks longos e jogos reais mostram que o runtime estável não cumpre pelo menos um gate crítico.
2. Um protótipo GPU-resident prova a remoção de readback e mantém hardware encode.
3. A melhora é material: ≥15% em latência/custo do pipeline ou redução ≥10% da perda de 1% lows causada pelo stream, sem piorar qualidade.
4. A matriz NVIDIA/AMD/Intel e híbrida não apresenta fallback/crash recorrente.
5. O custo de manutenção do bridge/fork é aceito explicitamente.

Interromper ou redesenhar a iniciativa se:

- a vantagem desaparecer em cinco repetições;
- o caminho nativo piorar 1% lows em mais de 5%;
- depender de software encode para uma combinação suportada;
- exigir hook/injeção no jogo como caminho padrão;
- device loss ou atualização de driver não puderem ser recuperados com segurança.

## 11. Fontes técnicas primárias

### Windows e D3D

- [Windows Graphics Capture](https://learn.microsoft.com/en-us/windows/uwp/audio-video-camera/screen-capture)
- [Direct3D11CaptureFramePool.CreateFreeThreaded](https://learn.microsoft.com/en-us/uwp/api/windows.graphics.capture.direct3d11captureframepool.createfreethreaded)
- [DXGI Desktop Duplication](https://learn.microsoft.com/en-us/windows/win32/direct3ddxgi/desktop-dup-api)
- [Desktop Duplication mantém frames na GPU](https://learn.microsoft.com/en-us/windows-hardware/drivers/display/desktop-duplication-api)
- [D3D11 VideoProcessorBlt](https://learn.microsoft.com/en-us/windows/win32/api/d3d11/nf-d3d11-id3d11videocontext-videoprocessorblt)
- [D3D11 multithreading](https://learn.microsoft.com/en-us/windows/win32/direct3d11/overviews-direct3d-11-render-multi-thread-intro)
- [Media Foundation low latency](https://learn.microsoft.com/en-us/windows/win32/medfound/mf-low-latency)

### Chromium e libwebrtc

- [Chromium M152: WebRtcAllowWgcUsingTexture](https://chromium.googlesource.com/chromium/src/+/152.0.7977.30/media/webrtc/webrtc_features.cc)
- [Chromium M152: DesktopCaptureDevice](https://chromium.googlesource.com/chromium/src/+/152.0.7977.30/content/browser/media/capture/desktop_capture_device.cc)
- [Chromium: Media Foundation Video Encode Accelerator](https://chromium.googlesource.com/chromium/src/+/master/media/gpu/windows/media_foundation_video_encode_accelerator_win.cc)
- [libwebrtc: implementação WGC com staging/Map](https://webrtc.googlesource.com/src/+/0a53c16218d0cac9784abb2f0b82a8a19c8e0e64/modules/desktop_capture/win/wgc_capture_session.cc)
- [libwebrtc pacing](https://webrtc.googlesource.com/src/+/HEAD/modules/pacing/g3doc/index.md)
- [Google Congestion Control](https://webrtc.googlesource.com/src/+/refs/heads/main/modules/congestion_controller/goog_cc/goog_cc_network_control.cc)
- [Frame dropper](https://webrtc.googlesource.com/src/+/refs/heads/main/modules/video_coding/utility/frame_dropper.h)

### WebRTC e métricas

- [WebRTC 1.0](https://www.w3.org/TR/webrtc/)
- [Media Capture and Streams](https://www.w3.org/TR/mediacapture-streams/)
- [Media Capture Content Hints](https://www.w3.org/TR/mst-content-hint/)
- [WebRTC Statistics](https://www.w3.org/TR/webrtc-stats/)
- [WebRTC SVC](https://www.w3.org/TR/webrtc-svc/)
- [RFC 8835: WebRTC transports e filas](https://www.rfc-editor.org/rfc/rfc8835.html)

### Ferramentas de validação

- [PresentMon](https://github.com/GameTechDev/PresentMon)
- [GPUView](https://learn.microsoft.com/en-us/windows-hardware/drivers/display/using-gpuview)
- [Netflix VMAF](https://github.com/Netflix/vmaf)
- [Electron command-line switches](https://www.electronjs.org/docs/latest/api/command-line-switches)
- [npm exec](https://docs.npmjs.com/cli/v11/commands/npm-exec)
