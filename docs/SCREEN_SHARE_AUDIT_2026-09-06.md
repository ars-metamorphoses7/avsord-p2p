# Auditoria de transmissão do JUMP — 6 de setembro de 2026

**Atualização posterior:** após autorização de implementação, parte das recomendações foi aplicada. Consulte `SCREEN_SHARE_IMPLEMENTATION_2026-09-06.md` para o estado atual do código, validação e pendências físicas. O texto abaixo preserva a auditoria anterior às mudanças.

## Decisão recomendada

**Primeiro remover latência desnecessária e degradação sem evidência no pipeline atual. Em paralelo conceitual, reservar uma segunda etapa de mídia nativa GPU-resident para resolver o teto de captura/encode, se o teste físico mostrar esse teto.** Reescrever transporte ou trocar codecs antes disso não ataca o maior custo observado no receptor.

Esta entrega é uma auditoria e especificação de implementação, não uma versão otimizada já implementada. Não altera o comportamento do aplicativo, versão ou release. Base inspecionada: `0aa12e0`, versão 1.0.28. O outro agente deve implementar os lotes abaixo antes de publicar; publicar apenas estes documentos não melhora a transmissão.

Não há medição comparativa do Discord nestes artefatos. Portanto “nível Discord” é a meta de produto, não uma equivalência comprovada. Performance aqui significa conjuntamente: cadência, legibilidade, latência, estabilidade, impacto no jogo, CPU/GPU e áudio sincronizado.

## Evidência disponível

Inspecionados captura, constraints, perfis/controlador, mesh, SFU, codec policy, reprodução, telemetria, testes de replay e investigações históricas. Os seis JSONs não versionados na raiz são **exclusivamente de receptores**, todos em mesh/performance; dois Linux na 1.0.27 e quatro Windows na 1.0.28. Não há sender correspondente disponível nessa coleção. Eles não constituem A/B de versões: hardware, cenas e duração diferem.

Reprodução da extração, a partir da raiz:

```powershell
node scripts/summarize-screen-share-audit.mjs
```

Valores arredondados; IDs abreviados identificam os arquivos originais:

| Run | SO / versão | Duração s | Receive FPS p50 | Render FPS p50 | Decode ms p50 | Buffer efetivo ms p50 | Buffer mínimo ms p50 | Pós-recepção ms (*) | Freezes (**)|
|---|---|---:|---:|---:|---:|---:|---:|---:|---:|
| 014a6dc9 | Linux / .27 | 58,5 | 15,3 | 15,7 | 3,97 | 302 | 90 | 345 | 1 |
| 2bfb358f | Linux / .27 | 87,0 | 15,3 | 15,8 | 6,87 | 290 | 62 | 324 | 0 |
| 2b4382cb | Windows / .28 | 60,0 | 52,3 | 52,2 | 0,47 | 272 | 63 | 304 | 4 |
| 38da108e | Windows / .28 | 55,5 | 56,0 | 55,5 | 0,47 | 269 | 50 | 306 | 9 |
| c9794a27 | Windows / .28 | 171,0 | 55,3 | 54,3 | 0,45 | 280 | 37 | 306 | 11 |
| 389e4c86 | Windows / .28 | 873,0 | 46,7 | 49,0 | 0,47 | 238 | 44 | 272 | 82 |

(*) Mediana dos p95 de janelas de renderização, não p95 global nem latência ponta a ponta. `captureToCompositor` não possui amostras nos summaries consultados. (**) Soma dos deltas observados; mudanças de stream/pausas/transições precisam ser segmentadas antes de atribuir tudo a travamentos em gameplay contínuo.

Nos quatro Windows: decoder D3D11, resoluções observadas 1280×720, 960×540 e 640×360; RTT mediano 20–21 ms. P95 de perda reportada é zero nos seis runs: isso **não prova ausência de congestionamento**, rajadas, retransmissões ou fila no sender. `availableOutgoingBitrate` do receptor descreve o sentido de saída dele; não é a capacidade de upload do transmissor.

Conclusões sustentadas:

1. Decoder Windows é muito rápido nas amostras, enquanto espera em buffer domina o processamento após recepção. Trocar esse decoder é baixa prioridade.
2. Cadência recebida já é baixa/variável. O renderer acompanha aproximadamente o recebido; não pode inventar os frames que faltam. Medianas independentes podem resultar em render FPS maior que receive FPS; isso não é ganho de frames.
3. Redução de resolução é real, mas sua causa só pode ser localizada com o sender pareado. Nos Linux, 15 FPS recebidos não provam que o decoder Linux derrubou a transmissão.
4. Os modos qualidade e SFU não foram validados por estes seis arquivos.

## Achados e mudanças prioritárias

### P0 — Buffer de reprodução acrescenta atraso e reage a sinais ambíguos

`src/media/screenShareProfiles.js`, `evaluatePlaybackBufferAdaptation`: base 140 ms em desempenho e 180 ms em qualidade; máximos 360/480 ms. Freeze adiciona 90 ms à fórmula; dropped frames e jitter também elevam o alvo. Queda de 15 ms exige cinco amostras estáveis de 1,5 s: do máximo até a base são cerca de **112,5 s / 150 s**, mesmo sem nova pressão.

`src/webrtc/usePeerMesh.js`, `sampleReceivers`: usa freeze/drop/jitter sem saber se faltou captura, se houve troca de resolução ou se o decoder atrasou. Também aplica o alvo de vídeo ao receiver de áudio da tela. Isso pode prolongar atraso de áudio sem que o áudio tenha apresentado problema. Igualar alvos não garante sincronização A/V.

**Implementação proposta:** política de reprodução separada da coleta diagnóstica. Começar com experimento opt-in `auto` (jitterBufferTarget padrão/null do runtime) versus `bounded` (alvo explícito baixo), mantendo `legacy` para A/B. Candidatos iniciais a medir: 40–60 ms no desempenho, 60–100 ms em qualidade; não tratar esses números como valores já validados. Crescer somente diante de pressão de entrega sustentada; freeze isolado de fonte/renegociação não justifica inflar buffer. Decair em segundos com histerese; registrar alvo solicitado, efetivo e mínimo. Teto experimental 120/180 ms em rede saudável; permitir proteção maior apenas quando medida e necessária.

Usar deltas de buffer mínimo/efetivo, jitter, perda e decode, disponíveis na telemetria; tratar campos ausentes como desconhecidos. Não atribuir `null` a zero. Separar política do áudio, preservando sincronização do desktop com vídeo e medindo A/V; o microfone deve continuar interativo. Verificar também o caso áudio mesh + vídeo SFU.

**Ganho possível, não garantido:** a diferença entre buffer efetivo e mínimo é da ordem de 190–240 ms nos Windows (diferença de medianas, não mediana das diferenças). Há espaço relevante para investigar redução de aproximadamente 100–200 ms; não se deve prometer remover toda essa diferença nem somá-la novamente ao pós-recepção.

### P0 — Teto de bitrate é tratado como necessidade mínima de qualidade

`screenShareEncodingBitrate` parte de 8 Mb/s nos dois perfis, dividido pela escala ao quadrado; `evaluateCaptureAdaptation` classifica pressão quando a estimativa fica abaixo de 92% desse orçamento, mesmo sem evidência de dano visual. Recuperar 720p exige 112% de 8 Mb/s, isto é, **8,96 Mb/s estimados** para um viewer. Uma fonte que ficaria boa com 4–6 Mb/s pode ser reduzida por regra de capacidade nominal. Isso é risco confirmado no código, não causa provada de cada run.

`adaptVideoSender` ainda limita bitrate a 78% da estimativa saudável. Logo existem simultaneamente teto nominal, cap derivado de GCC, limiares espaciais, trials e probes. Os testes de replay já documentam rajadas de pacer durante recovery; novas constantes isoladas tendem a deslocar o problema.

**Implementação proposta:** separar teto permitido, demanda estimada de conteúdo e limite de rede. GCC continua responsável por congestionamento/pacing; o aplicativo escolhe resolução/FPS numa escala temporal mais lenta. Não reduzir resolução apenas porque a estimativa é menor que o teto. Exigir déficit de entrega/qualidade sustentado ou fila/perda; respeitar banda efetiva quando a rede está ruim. QP pode ajudar dentro do mesmo codec/implementação, mas não deve ser comparado universalmente entre codecs nem tratado como disponível para todo H.264.

Recovery precisa de probe limitado em duração e tráfego e de rollback, já parcialmente existentes; preservar essas proteções. Mudar uma variável estrutural por janela de observação. Adicionar testes de cenários: 720p saudável com estimativa 5 Mb/s; queda real para 1 Mb/s; conteúdo estático; rajada de keyframe; fonte a 30 FPS; encoder software; retorno de capacidade. Testes devem comprovar decisões e limites, não apenas copiar os limiares atuais.

### P1 — Os modos precisam representar objetivos distintos

Hoje qualidade também usa `contentHint: motion`, reduz resolução antes do FPS e tem o mesmo teto de bitrate. É principalmente 1080p30 versus 720p60, com mais tolerância a atraso. Aumentar buffer não aumenta detalhe.

Proposta inicial, preservando dois botões:

| Modo | Objetivo | Ponto inicial | Ordem de adaptação |
|---|---|---|---|
| Desempenho | Movimento e baixo atraso | 720p60 | Ajustar bitrate; 540p60; fallback temporal conforme encoder/rede; 360p como emergência |
| Qualidade | Texto e detalhe estável | 1080p30 | Ajustar bitrate; 1080p20/15 para conteúdo de detalhe; depois 900p/720p |

Para qualidade, testar hint `detail`/`text` em conteúdo correspondente; em vídeo/jogo pode ser melhor `motion`. Registrar hint real e cena, sem presumir que ele sozinho modifica o hardware encoder. Evitar classificadores de conteúdo caros: começar com duas políticas explícitas, medir texto/scroll/vídeo/jogo. 1080p60 ou 1440p entram depois como pontos superiores condicionados a hardware e rede, não como promessas universais.

### P1 — Benchmark de captura pode dar uma resposta correta para a fonte errada

A investigação de 29/08 encontrou VizFrameSinkCapturer para **a janela interna usada nos probes**. Não permite generalizar que qualquer janela de jogo externo segue o mesmo caminho. O documento antigo `screen-share-performance.md` também afirma WGC para janelas no cabeçalho, em tensão com essa investigação posterior.

No Windows, `electron/media-runtime-config.cjs` desabilita WGC de tela por padrão; isso escolhe uma preferência, não comprova que todos os drivers executaram DXGI sem fallback. Repetir trace com janela de processo externo real e monitor inteiro; registrar backend efetivo, dimensões, GPU de captura e GPU do encoder, principalmente em notebook híbrido.

Ter NVENC/MFT no stats não prova que captura, resize e conversão ficaram na GPU. O histórico local não comprovou um caminho de textura eficiente de ponta a ponta e registrou regressão no experimento M152. Não promover flags ou Electron beta com base apenas na presença de uma feature.

### P1 — SFU resolve replicação, não a qualidade do teste entre dois PCs

`useScreenSfu.js`: ativação a partir de três viewers e produtor único `L1T1`. Não há camadas espaciais para escolher por receptor. O controlador do produtor observa a conexão até o SFU; isso não representa cada downlink. O receiver SFU não passa pela mesma política de buffer do receiver mesh; o polling de consumers inspecionado é diagnóstico opt-in.

Manter P2P direto para 1:1 saudável. Para expansão, selecionar SFU também por orçamento total de upload/encode, com histerese, em vez de somente contagem fixa. Avaliar uma camada adicional ou SVC somente com suporte real de hardware/codec e custo medido; simulcast não é encode gratuito. Introduzir feedback/seleção por receptor para que um downlink fraco não receba um fluxo impossível de sustentar. Unificar política de reprodução nos dois transportes.

`usePeerMesh.js` tem STUN e não configura TURN. Isso limita conectividade em certas redes; prever TURN autenticado ou fallback SFU para 1:1 que não conecta. TURN/SFU podem aumentar latência e custo de infraestrutura; não são otimização automática do caminho já direto. Para dois PCs conectados em mesh, mudar o limiar de viewers não melhora o buffer atual.

### P2 — Reprodução e diagnósticos

`CallStreamCard.jsx` usa vídeo nativo, bom ponto de partida. O efeito de `MediaElement` reaplica `srcObject` e reinicia o collector quando volume/mute/sink/session mudam. Separar vínculo do stream dos controles de áudio e da coleta reduz trabalho desnecessário; não há evidência de que seja o gargalo principal.

Manter preview local desligável e medir seu impacto na GPU; não adicionar canvas/readback ao caminho de vídeo. Os counters e `requestVideoFrameCallback` são proxies de apresentação; complementar com medição física quando a meta for latência percebida. Corrigir documentação contraditória e distinguir testes sintéticos, replay, integrações e aprovação física.

## Arquitetura para o salto maior

Se o sender continuar sem entregar cadência com encoder/rede folgados, recomendo **serviço nativo de mídia, mantendo Electron como UI e o protocolo WebRTC como transporte**:

```text
Electron: salas, picker, preferências e controle por IPC
  → processo nativo: captura DXGI/WGC selecionada por fonte/compatibilidade
  → textura GPU → resize + conversão NV12 na GPU
  → encoder hardware, preset de baixa latência
  → libwebrtc nativo: RTP/SRTP, ICE, RTCP, pacing, retransmissão e GCC
  → P2P ou SFU → decoder e apresentação do receptor
```

Começar pelo sender Windows e receptor Electron existente, via SDP/ICE/RTP compatíveis. Não é possível assumir que um `RTCRtpSender` JavaScript aceita arbitrariamente o bitstream de um encoder externo: integrar encoder/captura com libwebrtc nativo e adaptar sinalização/lifecycle é parte real do projeto. Áudio e relógios precisam permanecer sincronizados; desligar, trocar fonte e recuperar crash também entram no MVP.

Buffers de captura pequenos e limitados; descartar frames de captura antigos antes de codificar, sem descartar arbitrariamente referências já codificadas. Usar timestamps monotônicos e instrumentação de fila por estágio. Conversão/encode no mesmo adaptador quando possível, com caminho explícito para GPU híbrida. Não mandar frames RGBA via IPC/JavaScript. Evitar B-frames/lookahead que acrescentem atraso no preset interativo; medir compromisso de qualidade. NVENC, Intel e AMD requerem adapters/capabilities/fallbacks próprios. Linux deve manter o caminho atual inicialmente; não prometer o mesmo backend Windows.

**MVP limitado:** 1 sender Windows, H.264 720p60 e 1080p30, áudio sincronizado, um receiver atual, seleção de monitor/janela externa, telemetria de fila e fallback para pipeline atual. Só expandir codecs, 1080p60 e SFU depois do A/B. Avaliar AV1 quando encoder e decoder reais forem eficientes; HEVC não é substituto universal no navegador. Não reescrever confiabilidade de mídia sobre WebSocket/TCP.

Essa arquitetura oferece controle de cópias, filas e preset que falta no JS, mas tem custo de integração, distribuição e manutenção do libwebrtc. Não há evidência suficiente para garantir ganho percentual ou estimativa fechada de prazo. Exigir trace que mostre o custo removido e teste físico que confirme o ganho antes de tornar padrão.

## Handoff para implementação e publicação

Lotes pequenos, cada um com rollback. Não executar todos como uma alteração indivisível:

1. **Build de teste de reprodução:** implementar `legacy/auto/bounded` como opção experimental nas configurações, persistida e gravada no manifesto; aplicar em mesh e SFU independentemente de diagnostics. Separar áudio e verificar sincronização. Não mudar captura, codec e escada ao mesmo tempo. Esse é o primeiro instalador útil para os dois PCs.
2. **Build de controlador:** separar teto/demanda, acrescentar testes acima, manter seleção A/B com política antiga. Usar os mesmos PCs/cenas do lote 1; só combinar as mudanças depois que cada efeito for conhecido.
3. **Modos:** ajustar escada de qualidade e hint com teste de legibilidade e movimento. Preservar o desempenho vencedor.
4. **Captura nativa:** abrir implementação separada somente se a primeira divergência pareada continuar em captura/encode. Encerrar se não superar o caminho atual de forma repetível.

Para cada lote: executar `npm run test:media`, os testes de codec/runtime que não estão nesse script (`node --test tests/mesh-codec-policy.test.js tests/media-runtime-config.test.cjs`), `npm run build`, integrações `test:diagnostics` e `test:call` pertinentes. Asserções unitárias não provam performance. Não foi executado benchmark físico nesta auditoria; a entrega atual só adiciona script de leitura e documentação.

Quando autorizado a subir a versão, o agente deve ler `docs/RELEASE.md` e completar branch → PR → merge em main → tag/release, como exige AGENTS.md. Não há publicação nesta entrega.

## Teste objetivo em dois PCs

Este protocolo é uma nova rodada; o `SCREEN_SHARE_FIELD_RUN.md` antigo restringe a performance/tela inteira e não cobre a matriz desta auditoria.

1. Instalar a mesma build/commit nos dois PCs e ativar Field Run Diagnostics em ambos. Anotar GPU, display/Hz, fonte, rede, modo e variante experimental. Parear JSONs por runId. Inverter sender/receiver ao menos no cenário principal para separar capacidade de envio e recepção.
2. Baseline antes de mudanças: texto pequeno + scroll, vídeo 60 FPS e jogo pesado com trecho reproduzível. Monitor inteiro primeiro; depois janela externa real. Duas políticas de modo. Aquecimento 15 s e três repetições de 90 s por condição principal; ordem alternada entre baseline/candidata. Uma rodada longa de 10 min para estabilidade após escolher vencedora.
3. Começar com cabo/rede saudável para isolar pipeline. Depois repetir o cenário vencedor em Wi-Fi e sob redução controlada de capacidade. Para medir impacto no jogo, mesmo trecho sem share e com share; usar FPS/frametime/1% lows, sem carga sintética concorrente que altere a cena.
4. Registrar a primeira perda de cadência: fonte → captura → encode → envio → recebimento → decode → apresentação. Associar transitions, encoder real, filas/pacer e resolução. Segmentar pausas, troca de perfil e startup.
5. Para latência ponta a ponta, filmar fonte e receptor no mesmo enquadramento com movimento/contador identificável (alta taxa de câmera ajuda). Se PCs estiverem distantes, usar método com sincronização/calibração explícita. Nunca subtrair wall clocks de máquinas diferentes. Para imagem, comparar o mesmo frame/crop em texto e movimento; SSIM sozinho pode esconder borrão em letras. Áudio: frase + marcador audiovisual, observando desvio A/V e interrupções.

Critérios propostos, a negociar com os resultados do hardware, não garantias atuais:

| Eixo | Gate inicial |
|---|---|
| Desempenho em fonte 60 FPS saudável | Render mediano ≥57 FPS; p95 global de intervalo ≤33,4 ms; permanecer em 720p em ≥95% do período estável |
| Qualidade em fonte 30 FPS saudável | Render mediano ≥29 FPS; 1080p em ≥95% do período estável; texto legível sem piora versus baseline |
| Latência | Reduzir pós-recepção em ≥80 ms se baseline permitir; alvo físico LAN p95 ≤150 ms desempenho / ≤200 ms qualidade, a validar |
| Continuidade | Não aumentar freezes ou queda de áudio; meta ≤1 freeze/min em cena contínua; reportar também duração total |
| Impacto no jogo | Meta ≤5% de perda de FPS médio e ≤10% de piora de 1% lows no hardware de referência |
| Recuperação | Sem alternância repetida de resolução em rede estável; recuperar após pressão sem acumular fila |
| Compatibilidade | Nenhum novo fallback software em caminho antes acelerado; saída/reentrada/troca de fonte funcionam |

O agregador desta entrega não calcula p95 global de frames: esse gate exige os frames/janelas adequados no harness. Um run incapaz de atender a fonte de 60 FPS deve ser classificado como limitado pela fonte, não aprovado como 720p60 nem usado para culpar o receiver.

## Referências primárias

- [W3C WebRTC: controle de jitter buffer](https://www.w3.org/TR/webrtc/): alvo de buffer é compromisso entre espera e underrun; valor pedido não garante atraso efetivo exato.
- [W3C WebRTC Stats](https://www.w3.org/TR/webrtc-stats/): distinguir atraso acumulado, alvo, mínimo e contagem emitida; usar deltas em janelas.
- [Microsoft Desktop Duplication API](https://learn.microsoft.com/en-us/windows/win32/direct3ddxgi/desktop-dup-api): disponibiliza superfícies DXGI processáveis na GPU; isso não prova que o pipeline atual preserva residência na GPU.
- [NVIDIA NVENC programming guide](https://docs.nvidia.com/video-technologies/video-codec-sdk/13.1/nvenc-video-encoder-api-prog-guide/index.html): presets e tuning de latência são escolhas explícitas do encoder nativo.
- Evidência interna: `docs/screen-share-capture-backend-investigation-2026-08-29.md`, `docs/screen-share-performance.md`, `tests/field-controller-replay.test.js` e os seis exports receiver da raiz. As conclusões históricas não substituem validação na build atual.
