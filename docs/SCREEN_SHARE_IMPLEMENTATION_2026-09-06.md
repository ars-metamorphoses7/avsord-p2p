# Transmissão: implementação e preparação do teste físico

Esta implementação sucede a auditoria `SCREEN_SHARE_AUDIT_2026-09-06.md`. Base: `0aa12e0`, versão ainda 1.0.28. Alterações locais para o próximo agente publicar pelo processo de `docs/RELEASE.md`; nenhuma release/tag foi criada.

## O que mudou

- Reprodução **Responsivo** por padrão: alvo inicial de 50 ms em desempenho e 80 ms em qualidade, proteção até 180/240 ms sob pressão sustentada de rede. Dois relatórios consecutivos de pressão precedem o aumento; três relatórios limpos permitem reduzir 30 ms. Freeze/drop isolado não aumenta o alvo. Métricas ausentes não são tratadas como rede saudável. O WebRTC pode impor outro atraso efetivo.
- Configurações → Reprodução de transmissões: **Responsivo / Automático do sistema / Compatibilidade**. Preferência local persistida, aplicada durante a chamada em até um ciclo de coleta (normalmente 1,5 s). Compatibilidade reproduz a antiga política de buffer; não reverte as outras mudanças do sender.
- Áudio da tela usa o buffer do WebRTC nas políticas novas, evitando copiar automaticamente o atraso de vídeo para áudio. Compatibilidade mantém o comportamento antigo. Isso não certifica sincronização física A/V; medir nos dois PCs, especialmente quando vídeo usa SFU e áudio usa mesh.
- A mesma política agora funciona no consumer SFU mesmo sem diagnostics. Fonte, perfil ou política novos não herdam pressão de uma sessão anterior. O vídeo mesh inativo não disputa o vínculo de diagnóstico do vídeo SFU.
- O controlador diferencia teto de bitrate de demanda observada. Com entrega saudável e sem limitação de banda reportada, estima demanda com 25% de margem sobre tráfego observado, limitada entre 50% e 100% do orçamento nominal. Para recovery espacial, projeta por área. Dados ausentes, entrega insuficiente ou limitação de banda restauram a referência conservadora. Os limites de rede, histerese, probes limitados e rollback continuam ativos. Esse estimador é uma heurística conservadora, não uma medição direta de qualidade perceptual.
- Qualidade usa hint `detail`; sob pressão moderada de capacidade, pode reduzir 30→20→15 FPS antes de resolução. Déficits severos e pressão dura de transporte continuam reduzindo pixels prontamente. Desempenho mantém prioridade de movimento.
- Fallback H.264→VP8 exige três observações consecutivas de encoder software com frames codificados, evitando fixar um codec por um único relatório transitório. A política inicial de plataformas explicitamente software-only continua válida.
- O router SFU anuncia H.264 Baseline `42001f` além de Constrained Baseline `42e01f`; o produtor prefere Baseline quando negociado. A restrição anterior a `42e01f` excluía o caminho NVIDIA observado nos testes. Routers antigos e peers sem Baseline continuam usando uma capacidade negociada disponível, com fallback existente.
- Alterar volume/mute/dispositivo não reatribui `srcObject` nem reinicia o coletor de vídeo. A saída de áudio pode voltar ao dispositivo padrão. A prévia local pode ser ocultada sem interromper a transmissão.
- Inícios duplicados de captura são bloqueados. Se o usuário cancelar enquanto a promessa de captura/áudio estiver pendente, a resposta tardia é descartada e a faixa é encerrada, sem iniciar uma transmissão depois do cancelamento.
- Diagnóstico separa intervalo de callback e intervalo de apresentação esperado. FPS apresentado usa delta de `presentedFrames` quando disponível; fallback usa intervalos entre callbacks, sem contar os dois extremos como um frame extra. Política ativa é incluída nas amostras do receptor.
- `test:media` inclui os novos testes e os de codec direcional/runtime. O teste Electron de diagnostics deixou de exigir uma versão fixa antiga e termina com erro real quando falha.

## Evidência local

Testes unitários de mídia, build de produção e integrações locais foram executados. O teste de diagnóstico valida também seleção das três políticas durante a transmissão e cancelamento de captura pendente. A integração de chamada cobre três participantes, envio de áudio/vídeo, pausa, mixer e reconexão; não mede lip sync físico nem frametime de jogo.

Validação final: **147 testes de mídia aprovados**, build Vite aprovada, integração mesh aprovada e integração de diagnostics aprovada. Os testes de codec, runtime e SFU estão incluídos na suíte. Os smokes de SFU verificaram os consumers e o handoff real, sem diagnostics habilitado.

O sandbox inicial impediu inicialização do subprocesso de GPU do Electron (`0xC0000135`). As integrações foram executadas com GPU fora desse sandbox. Não foi desabilitada aceleração em produção para contornar isso.

### Comparação exploratória de reprodução

Mesmo código do sender nas duas condições, mudando somente a preferência de reprodução; uma repetição, 5 s de aquecimento, 10 s medidos e dois frames alinhados para qualidade por modo. Fonte de janela interna do harness, um viewer, mesma máquina Windows/NVIDIA. Não é comparação entre versões completas, jogo externo ou PCs diferentes.

| Perfil / política | Resolução no fim | FPS apresentados | Pós-recepção p95 | Buffer efetivo médio | SSIM médio (2 frames) | Freezes no intervalo |
|---|---|---:|---:|---:|---:|---:|
| Desempenho / Responsivo | 1280×720 | 59,87 | 33,8 ms | 9,3 ms | 0,9881 | 0 |
| Desempenho / Compatibilidade | 960×540 | 57,09 | 215,5 ms | 191,2 ms | 0,9564 | 0 |
| Qualidade / Responsivo | 1920×1080 | 29,77 | 108,4 ms | 65,0 ms | 0,9924 | 0 |
| Qualidade / Compatibilidade | 1920×1080 | 29,91 | 232,8 ms | 205,7 ms | 0,9935 | 0 |

H.264 NVIDIA MFT nos quatro runs. Qualidade manteve a resolução e teve aproximadamente 124 ms a menos de pós-recepção p95. No desempenho, as resoluções divergem, portanto o ganho de FPS/SSIM não deve ser atribuído ao buffer. São runs curtos, sem ordem randomizada e sem repetição suficiente para significância; os resultados demonstram viabilidade e motivam o A/B físico. Nenhum valor acima é latência ponta a ponta.

Artefatos locais, ignorados pelo Git: `artifacts/screen-share-responsive-2026-09-06.json` e `artifacts/screen-share-legacy-2026-09-06.json`. Screenshot de revisão: `artifacts/screen-playback-settings-2026-09-06.png`.

Reprodução (após `npm run build`):

```powershell
$env:JUMP_BENCH_VIEWERS = '1'
$env:JUMP_BENCH_WARMUP_MS = '5000'
$env:JUMP_BENCH_DURATION_MS = '10000'
$env:JUMP_BENCH_REPEATS = '1'
$env:JUMP_BENCH_QUALITY_SAMPLES = '2'
$env:JUMP_BENCH_PLAYBACK_POLICY = 'responsive' # repetir com legacy
$env:JUMP_BENCH_OUTPUT = 'artifacts/playback-responsive.json'
npx electron tests/screen-share-benchmark.e2e.cjs
```

O smoke SFU usa três viewers e verifica consumer com alvo aplicado, handoff e zero senders mesh de tela ativos após transferência. Antes da correção de negociação, os smokes ficaram em VP8/libvpx, aproximadamente 30 FPS no desempenho e 20 FPS em qualidade. A confirmação sustentada de fallback sozinha não resolveu esse limite (`artifacts/screen-share-sfu-final-2026-09-06.json`).

A investigação adicional encontrou o router restrito a H.264 Constrained Baseline, diferente do Baseline usado pelo hardware em mesh. Após anunciar ambas as variantes e preferir Baseline, **o encoder NVIDIA H.264 MFT apareceu nos dois modos SFU**. O smoke passou a 1280×720/59,66 FPS em desempenho; qualidade manteve 1920×1080 e adaptou para aproximadamente 20 FPS nessa rodada curta. Zero senders mesh ativos e três viewers confirmados. Artefato: `artifacts/screen-share-sfu-baseline-profile-2026-09-06.json`. Isso demonstra a remoção do fallback neste hardware, não garante todas as GPUs nem certifica desempenho físico sob jogo.

Uma rodada adicional de qualidade com 25 s de aquecimento e 10 s medidos confirmou **1920×1080 / 29,50 FPS apresentados**, H.264 NVIDIA MFT, zero freezes no intervalo e três viewers via SFU, sem senders mesh ativos. Artefato: `artifacts/screen-share-sfu-quality-settled-2026-09-06.json`. Não foi medida qualidade visual nessa rodada SFU; seu papel é confirmar encode, cadência e transporte depois do aquecimento.

## Como testar a versão publicada em dois PCs

1. Mesmo instalador/commit em ambos; ativar Field Run Diagnostics. Começar em cabo ou rede saudável, um sender e um viewer. No receiver, escolher Responsivo.
2. Rodar desempenho e qualidade, cada um com texto/scroll, vídeo e trecho reproduzível de jogo pesado. Anotar FPS/1% lows do jogo antes e durante a transmissão. Capturar monitor inteiro e depois janela externa real.
3. Repetir com Compatibilidade no receiver, mantendo o sender e a cena. Alternar a ordem e fazer três repetições de 90 s após 15 s de aquecimento. Isso compara buffers; para comparar o controlador completo, usar uma build baseline separada.
4. Guardar os dois JSONs de cada run, pareados por runId. Não concluir gargalo do sender usando apenas receiver. Comparar retenção de frames, resolução ao longo do tempo, freezes/duração, fila/pacer, encoder/decoder real, buffer e áudio.
5. Fazer uma rodada contínua de 10 min, testar ocultar/mostrar prévia, pausa, minimizar/restaurar, volume, saída de áudio, parar/reiniciar compartilhamento e sair/reentrar na chamada. Repetir o cenário principal com papéis dos PCs invertidos.
6. Medir sincronização A/V com marcador audiovisual; medir ponta a ponta filmando fonte e receptor juntos quando possível. Não subtrair relógios de dois PCs. Depois repetir em Wi-Fi e rede limitada. Discord deve ser comparado em execução separada, com a mesma cena e configuração equivalente.

Critérios completos e gates sugeridos estão na auditoria. Se houver regressão perceptível de continuidade/áudio com Responsivo, Compatibilidade oferece retorno imediato da reprodução e os JSONs permitem identificar o estágio responsável.

## Limites e decisões de arquitetura

Não foram implementados serviço nativo DXGI/WGC+libwebrtc, novos codecs, TURN ou camadas de SFU. São projetos de arquitetura/infraestrutura, não correções demonstradas pelo conjunto de receiver logs disponível. A decisão aqui foi melhorar e instrumentar o caminho atual antes de substituí-lo. O teste físico continua necessário para impacto no jogo, legibilidade em cenas reais, estabilidade de longo prazo, sincronização A/V e paridade com Discord. Não há promessa de performance máxima universal.

Para publicar: revisar o diff local, incluir os arquivos novos de produção/teste/documentação e `sfu-server.mjs`, executar as verificações de release e seguir `docs/RELEASE.md`. O host do servidor de sinalização/SFU também precisa da atualização para anunciar Baseline; atualizar somente os receivers não altera as capacidades do router antigo. Não versionar os seis JSONs de usuário da raiz nem traces/benchmarks grandes automaticamente.
