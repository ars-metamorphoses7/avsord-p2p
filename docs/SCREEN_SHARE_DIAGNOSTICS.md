# Diagnóstico opt-in de compartilhamento de tela

O diagnóstico de screen share fica desativado por padrão. Para habilitá-lo em um field run, inicie o Electron com `JUMP_STREAM_DIAGNOSTICS=1`:

```powershell
$env:JUMP_STREAM_DIAGNOSTICS = '1'
npm run build
npm run desktop
```

Faça a chamada e o compartilhamento normalmente. O diagnóstico não altera codec, captura, constraints, jitter buffer, thresholds ou decisões do controlador; ele apenas reutiliza a cadência de estatísticas já existente (aproximadamente 1–1,5 s). No encerramento da transmissão, cada sessão é finalizada e gravada como JSON.

Os arquivos ficam em:

```text
<app.getPath('userData')>/diagnostics/screen-share/
```

Cada arquivo contém `schemaVersion`, o `runId` compartilhado, `role` (`sender` ou `receiver`), participante/origem, modo de transporte (`mesh` ou `sfu`), manifesto do ambiente, captura, série temporal, janelas agregadas de renderização e `summary`. O mesmo `runId` permite agrupar o sender e todos os receivers de uma transmissão; o nome inclui ainda papel, participante, timestamp e sequência para evitar colisões entre arquivos.

### Semântica de relógio e privacidade da fonte

`startedAtMs`, `performanceTimeOriginMs` e `monotonicStartMs` pertencem à máquina que gerou o artefato. O receiver registra seu próprio `startedAtMs` local quando cria a sessão; ele nunca reutiliza o timestamp de início anunciado pelo sender. Se esse timestamp remoto estiver disponível, ele aparece somente como `correlation.senderAnnouncedStartedAtMs`. `samples[*].elapsedMs` é calculado exclusivamente a partir do relógio monotônico local. Wall clocks entre máquinas não devem ser subtraídos.

O diagnóstico preserva apenas um identificador de fonte limitado e o tipo (`screen`, `window` etc.), além de perfil, constraints e configurações da track. Nome ou título arbitrário de janela/aplicação não é persistido no artefato.

Para conferir o contrato localmente:

```powershell
npm run test:media
npm run test:diagnostics
```

`test:diagnostics` abre o caminho real de `electron/main.cjs`, usa o preload de produção, cria dois participantes locais, compartilha uma tela e valida que sender/receiver gravaram JSONs correlacionados. O smoke test usa um `userData` temporário e remove os arquivos ao terminar; um field run real não deve apontar o diretório de diagnóstico para uma pasta compartilhada sem revisar o conteúdo.

Ao analisar os arquivos, use `samples[*].elapsedMs` para a linha do tempo do pipeline. Os campos de sender ficam em `pipeline`, `rateControl`, `transport` e `webrtc`; os do receiver acrescentam `jitter`, renderização agregada em `render.windows` e os mesmos dados de transporte. Valores indisponíveis permanecem `null`, e as amostras/renderizações são limitadas para impedir crescimento ilimitado de memória ou arquivo.
