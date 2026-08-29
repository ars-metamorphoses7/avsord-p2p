# Investigação do backend de captura de tela — M150

Data: 2026-08-29  
Escopo: identificar o backend efetivo usado pelo Chromium/Electron nos cenários de tela e janela do JUMP.

## Ambiente e protocolo

- Electron 43.4.1.
- Chromium 150.0.7871.224.
- Windows 11 Pro 10.0.26200.
- Baseline libwebrtc: `1f975dfd761af6e5d76d28333191973b258d82a8`, recuperado pelo branch-head 7871/DEPS. O patchset exato carregado pelo Electron não está disponível no repositório.
- Base Git dos testes: `5d290024c0b854d236eb1f770033333b5dcb9929` (`main` local e `origin/main` estavam alinhadas antes da publicação).
- Fixture interna de benchmark, perfil de performance, aquecimento de 1 s, duração de 3 s, uma repetição e um viewer.
- `JUMP_BENCH_EXTERNAL_SOURCE=0`.
- Não foram alterados bitrate, codec, PeerMesh, SFU, jitter ou adaptação de vídeo.

## Como a seleção funciona

No launcher in-process do Chromium M150, uma origem de janela (`window_id != kNullId`) segue para `VizFrameSinkCapturer`/`AuraWindowVideoCaptureDevice` antes de chegar a `DesktopCaptureDevice`. Portanto, ela não passa pela seleção WGC/DXGI/GDI de desktop capture.

Para uma origem de tela, `DesktopCaptureDevice` cria um capturer de tela. Com `allow_wgc_screen_capturer` habilitado, o libwebrtc escolhe WGC; caso contrário, o caminho de tela usa o capturer DirectX/DXGI quando suportado, com fallback GDI.

Referências primárias do código upstream:

- [Chromium: launcher in-process, branch-head 7871](https://chromium.googlesource.com/chromium/src/+/refs/branch-heads/7871/content/browser/renderer_host/media/in_process_video_capture_device_launcher.cc#L324)
- [Chromium: DesktopCaptureDevice](https://chromium.googlesource.com/chromium/src/+/refs/branch-heads/7871/content/browser/media/capture/desktop_capture_device.cc#L952)
- [libwebrtc: fábrica de desktop capturers](https://webrtc.googlesource.com/src/+/1f975dfd761af6e5d76d28333191973b258d82a8/modules/desktop_capture/desktop_capturer.cc#L80)
- [libwebrtc: seleção de screen capturer no Windows](https://webrtc.googlesource.com/src/+/1f975dfd761af6e5d76d28333191973b258d82a8/modules/desktop_capture/screen_capturer_win.cc#L28)
- [libwebrtc: capturer DirectX/DXGI](https://webrtc.googlesource.com/src/+/1f975dfd761af6e5d76d28333191973b258d82a8/modules/desktop_capture/win/screen_capturer_win_directx.cc#L125)
- [libwebrtc: capturer WGC](https://webrtc.googlesource.com/src/+/1f975dfd761af6e5d76d28333191973b258d82a8/modules/desktop_capture/win/wgc_capturer_win.cc#L280)

## Resultado dos quatro probes

| Probe | Origem | Override | Evidência de seleção | Backend efetivo | Confiança |
|---|---|---|---|---|---|
| A | `screen:0:0` — Tela cheia | padrão | `UsingDesktopCapturer=1`; `allow_wgc_screen_capturer=0`; UMA DirectX: 268 amostras, 268 resultados 0 | DXGI/DirectX | Alta |
| B | `screen:0:0` — Tela cheia | `JUMP_SCREEN_CAPTURE_BACKEND=wgc` | `UsingDesktopCapturer=1`; `allow_wgc_screen_capturer=1`; log `WgcCapturerWin`; UMA WGC: 272 amostras, 272 resultados 0 | WGC | Alta |
| C | `window:525598:1` — `JUMP_BENCH_MOTION_SOURCE_14504` | padrão | `UsingVizFrameSinkCapturer=1`; nenhum `UsingDesktopCapturer` | VizFrameSinkCapturer (fora da taxonomia WGC/DXGI/GDI) | Alta |
| D | `window:460022:1` — `JUMP_BENCH_MOTION_SOURCE_30472` | `JUMP_SCREEN_CAPTURE_BACKEND=wgc` | `UsingVizFrameSinkCapturer=1`; nenhum `UsingDesktopCapturer`; override sem efeito | VizFrameSinkCapturer (fora da taxonomia WGC/DXGI/GDI) | Alta |

Nos quatro traces atuais, `DeliverTextureToClient` ocorreu zero vezes. No Chromium M150 investigado, o caminho de `DesktopCaptureDevice` termina em `OnIncomingCapturedData`; não há evidência atual de um método/evento `DeliverTextureToClient` nesse ponto.

Os eventos `WindowCapturerWinGdi`, WGC e UMA encontrados nos logs de C/D pertencem à descoberta de fontes (`desktopCapturer.getSources`), incluindo thumbnails, antes do `GenerateStreams` da captura efetiva. Eles não devem ser usados para classificar o backend da janela compartilhada.

## Primeira divergência identificada

- Para tela, a divergência A/B é a política `allow_wgc_screen_capturer`: desabilitada no padrão do probe A e habilitada pelo override no probe B.
- Para janela, a divergência ocorre antes da fábrica `DesktopCaptureDevice`: o launcher escolhe `VizFrameSinkCapturer` diretamente. Por isso, o override WGC não muda o backend efetivo dos probes C/D.
- A classificação `unknown` para C/D é intencional dentro da taxonomia solicitada; o backend real foi identificado separadamente como `VizFrameSinkCapturer`.

## Artefatos publicados

Cada probe possui o relatório JSON, o log nativo e o trace Perfetto. Os arquivos `.trace.json` são traces Perfetto; a extensão histórica não significa que sejam JSON textual.

- Probe A — tela padrão: [JSON](../artifacts/probe-m150-a-screen-default.json), [log](../artifacts/probe-m150-a-screen-default.log), [trace](../artifacts/probe-m150-a-screen-default.trace.json)
- Probe B — tela WGC: [JSON](../artifacts/probe-m150-b-screen-wgc.json), [log](../artifacts/probe-m150-b-screen-wgc.log), [trace](../artifacts/probe-m150-b-screen-wgc.trace.json)
- Probe C — janela padrão: [JSON](../artifacts/probe-m150-c-window-default.json), [log](../artifacts/probe-m150-c-window-default.log), [trace](../artifacts/probe-m150-c-window-default.trace.json)
- Probe D — janela WGC: [JSON](../artifacts/probe-m150-d-window-wgc.json), [log](../artifacts/probe-m150-d-window-wgc.log), [trace](../artifacts/probe-m150-d-window-wgc.trace.json)

Os traces M152 antigos e muito grandes não foram publicados: não representam o runtime M150 atual e não são necessários para reproduzir esta conclusão. Nenhuma alteração de código local foi incluída neste conjunto de resultados.

## Próximo ponto de investigação

Para avançar no pipeline de tela, o próximo corte de evidência deve correlacionar `VideoCaptureDeviceClient::OnIncomingCapturedData` com `WebRtcVideoSource::OnFrameCaptured` e, depois, com o encoder. Isso separa a captura nativa do restante do pipeline sem introduzir alterações de transporte ou adaptação.
