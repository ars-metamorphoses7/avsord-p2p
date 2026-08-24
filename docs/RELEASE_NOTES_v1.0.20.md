# JUMP v1.0.20

## Resumo

Esta versão preserva as salas acessadas por convite entre reinicializações e atualizações do aplicativo, melhora a experiência de mídia e introduz compartilhamento de tela híbrido: mesh P2P para até dois espectadores e SFU `mediasoup` a partir de três.

## Persistência de salas

- Salas acessadas por `jump://` são registradas em `room-sessions.json` dentro do diretório persistente `userData` do Electron, que não é substituído durante uma atualização normal.
- A sessão ativa é restaurada ao reabrir o aplicativo, incluindo o endereço do servidor de sinalização usado pelo convite.
- Até 50 salas recentes são mantidas, deduplicadas por origem de sinalização e ID da sala.
- A escrita usa arquivo temporário e renomeação, reduzindo o risco de estado parcialmente gravado.
- Identificadores, nomes e origens HTTP/HTTPS são normalizados antes da persistência; conteúdo inválido é ignorado.
- A interface permite reabrir salas recentes, inclusive salas hospedadas em outra origem.

## Compartilhamento de tela

- Até dois espectadores continuam no caminho mesh P2P existente.
- Com três ou mais espectadores, o transmissor publica uma única faixa de tela no SFU e o servidor encaminha RTP aos receptores.
- O handoff mantém cada sender P2P disponível até o consumer SFU correspondente confirmar que está pronto.
- Falha, pausa ou fechamento de uma perna SFU restaura automaticamente o caminho P2P daquele espectador.
- O servidor SFU é empacotado com a aplicação; o worker nativo do `mediasoup` é extraído do ASAR em Windows e Linux.
- O host deve aceitar TCP `8787` e UDP/TCP `40000–49999`. Em hosts com múltiplas interfaces, `JUMP_SFU_ANNOUNCED_ADDRESS` deve conter o IPv4 alcançável pelos convidados.

## Adaptação, codecs e telemetria

- A escolha de codec considera `encoderImplementation` e `powerEfficientEncoder` observados no fluxo real, em vez de confiar apenas no status global da GPU.
- H.264 permanece preferido quando há encoder de hardware confirmado; em encoder por software, a negociação pode migrar de OpenH264 para VP8/libvpx.
- O controlador aplica safe-start, histerese de bitrate, recuperação agrupada e adaptação por estágio para reduzir reconfigurações e keyframes desnecessários.
- Linux oferece aceleração VA-API experimental por opt-in com `JUMP_LINUX_VIDEO_ACCELERATION=vaapi`, sem ignorar a blocklist de segurança do Chromium.
- A telemetria registra keyframes, frames grandes, NACK, PLI, FIR, congelamentos, mudanças de codec e mutações de parâmetros.

## Resultados medidos em 2026-08-23

O protocolo de um espectador executou cinco repetições de 60 segundos por perfil, com 10/10 rodadas válidas, zero perda e zero congelamentos:

| Perfil | FPS apresentado (mediana) | SSIM (mediana) | CV do bitrate | Upload |
|---|---:|---:|---:|---:|
| Desempenho | 27,81 | 0,9658 | 0,128 | 2,13 Mb/s |
| Qualidade | 14,37 | 0,9756 | 0,196 | 3,55 Mb/s |

O A/B com um transmissor e três espectadores, executado três vezes por perfil, mostrou:

| Comparação SFU contra mesh | Desempenho | Qualidade |
|---|---:|---:|
| Upload total do transmissor | −36,3% | −18,3% |
| CPU do renderer transmissor | −37,5% | −47,0% |
| FPS apresentado | +31,1% | +59,2% |
| Congelamentos no receptor amostrado | 2 → 0 | 2 → 0 |

As rodadas de grupo são evidência A/B diagnóstica: quatro janelas Electron e a fonte de vídeo competiram na mesma máquina, deixando a cadência da fixture abaixo do gate. A topologia foi confirmada em 6/6 rodadas SFU, mas a certificação de produção ainda exige máquinas físicas separadas e redes reais.

## Compatibilidade e limitações conhecidas

- O código não é exclusivo para NVIDIA. A política é independente de fabricante e cobre fallback por software.
- Intel UHD 620 foi exercitada no Linux; mesmo com o Chromium anunciando aceleração disponível, o WebRTC ainda escolheu software nesse host e o fallback VP8 foi aplicado.
- AMD física e a matriz Windows com NVIDIA, Intel, AMD e gráficos híbridos continuam pendentes.
- O SFU envia uma camada de vídeo adaptada; simulcast/SVC ainda não está habilitado.
- Ambientes fora da LAN/VPN podem precisar de TURN e configuração pública apropriada para mídia UDP/TCP.

## Validação da release

Validação local concluída antes da publicação:

- `npm run test:update`: 2/2 testes aprovados.
- `npm run test:persistence`: 5/5 testes aprovados.
- `npm run test:media`: 59/59 testes aprovados.
- `npm run test:call`: chamada com três participantes, A/V sincronizado, foco, pausa, mixer, RTP e reconexão aprovados.
- `npm run test:desktop-audio`: teste multiplataforma aprovado; dois testes WASAPI corretamente ignorados no Linux.
- `npm audit --omit=dev`: zero vulnerabilidades conhecidas.
- `npm run build`: build de produção aprovado.
- Linux local: AppImage, pacote `.deb`, `latest-linux.yml` e worker `mediasoup` desempacotado gerados com sucesso.
- Windows: o instalador NSIS e `latest.yml` são gerados e validados no runner nativo Windows do workflow `Release JUMP`; o host Linux local não possui Wine para concluir um cross-build NSIS.

Os detalhes técnicos, protocolo de benchmark e roadmap permanecem em [`screen-share-performance.md`](./screen-share-performance.md).
