# JUMP P2P

Um chat de sala com mensagens replicadas entre os participantes e mídia WebRTC ponto a ponto.

## Rodar sem domínio

1. Instale as dependências: `npm install`
2. Inicie: `npm run dev`
3. No computador que está hospedando, descubra o IP da rede local ou do Radmin VPN.
4. Compartilhe `http://IP-DO-HOST:5173/?room=minha-sala` com os amigos.

O Vite e o servidor de sinalização escutam nas interfaces de rede, então o link funciona pela rede local ou pelo Radmin. Se o Windows Firewall perguntar, permita a porta `5173` (e `8787`, se necessário).

## O que é descentralizado

- Mensagens são salvas no navegador em IndexedDB e enviadas aos peers pelo WebRTC DataChannel.
- Cada peer repassa mensagens que ainda não conhece, eliminando duplicatas por ID.
- Ao entrar novamente, o peer pede aos participantes conectados as mensagens que faltam.
- Áudio, câmera e compartilhamento de tela continuam sendo WebRTC P2P.

O servidor não guarda o histórico. Ele mantém apenas presença, lista de salas e sinalização inicial para formar os canais WebRTC. Por isso, ele precisa estar acessível quando alguém novo entrar ou quando um participante voltar depois de ficar offline; peers que já estão conectados continuam trocando mensagens mesmo se a sinalização cair.

## Aplicativo desktop e atualizações

O Electron abre o frontend e o servidor local juntos, então cada computador pode ter sua própria instância do JUMP. O updater está ligado ao repositório público [ars-metamorphoses7/avsord-p2p](https://github.com/ars-metamorphoses7/avsord-p2p):

```bash
npm run desktop
```

No desktop, `copiar convite` prioriza automaticamente o IP de uma interface Radmin/VPN; se ela não existir, usa o primeiro IP da rede local.

Para gerar o instalador Windows:

```bash
npm run desktop:build
```

O botão `atualizar` aparece dentro do aplicativo desktop. Ele usa o `electron-updater` para consultar uma Release pública do GitHub, baixar a nova versão e reiniciar o aplicativo. Os usuários não precisam de conta no GitHub; somente quem publica as Releases precisa configurar o repositório.

Antes de publicar, crie uma Release nesse repositório e incremente a versão no `package.json` a cada lançamento. O workflow de GitHub Actions pode gerar o instalador automaticamente quando uma tag `v*` for enviada.

## Primeiro teste com um amigo

Para testar áudio, tela e chat pela Radmin:

1. Conecte os dois computadores à mesma rede Radmin VPN.
2. No computador de cada pessoa, abra o JUMP pelo instalador ou execute `npm run desktop`.
3. No host, clique em `copiar convite` e envie o link `jump://` para o amigo.
4. Com o JUMP instalado/aberto no computador do amigo, abra o convite. O app dele continuará usando `localhost` para liberar microfone/câmera e conectará a sinalização ao IP Radmin do host.
5. Permita o JUMP no Windows Firewall quando solicitado, especialmente a porta TCP `8787` no host.

O convite `jump://` é feito para o aplicativo desktop. O link HTTP do modo web serve para testar o chat, mas o desktop é o caminho recomendado para testar chamadas e compartilhamento de tela pela Radmin.
