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
- O botão de tela abre a captura no Electron; no Windows ele compartilha o monitor principal e a captura é interrompida quando a fonte é encerrada.
- O botão de configurações ao lado dos controles permite escolher microfone e saída de áudio. A troca do microfone durante a chamada é imediata.
- O botão `+` do chat envia imagens comprimidas e fragmentadas pelo DataChannel, sem upload para o servidor.
- A navegação lateral separa `salas` e `amigos`; o chat fica em tela cheia e a chamada aparece ao clicar no telefone do header.
- Salas personalizadas podem ser criadas com nome e senha. A senha nunca é enviada na lista pública: o sinalizador guarda apenas um hash enquanto a sala está ativa, e o convite continua sendo compartilhado separadamente.

O servidor não guarda o histórico. Ele mantém apenas presença, lista de salas e sinalização inicial para formar os canais WebRTC. Por isso, ele precisa estar acessível quando alguém novo entrar ou quando um participante voltar depois de ficar offline; peers que já estão conectados continuam trocando mensagens mesmo se a sinalização cair.

As salas são instâncias independentes dentro do sinalizador em execução. A sala pública padrão pode ser usada sem senha; para criar uma sala privada, abra a aba `salas`, clique no `+`, informe nome e senha e envie o convite. Como a lista de salas fica em memória, uma sala desaparece quando todos saem ou quando o processo do sinalizador reinicia.

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

Para gerar os pacotes Linux do Mint:

```bash
npm run desktop:build:linux
```

O Linux recebe um `AppImage` (recomendado para atualização automática e sem root) e um `.deb` (instalação integrada no Mint/Ubuntu/Debian). O `.deb` pode pedir autenticação do sistema ao instalar uma atualização; o botão `atualizar` dispara essa instalação explicitamente.

Para um teste rápido sem gerar instalador, `npm run desktop:dir` cria o aplicativo em `release/win-unpacked/JUMP.exe`; a pasta pode ser compactada e enviada ao amigo.

O botão `atualizar` aparece dentro do aplicativo desktop. Ele usa o `electron-updater` para consultar uma Release pública do GitHub, baixar o artefato correto para Windows ou Linux e reiniciar o aplicativo. Os usuários não precisam de conta no GitHub; somente quem publica as Releases precisa configurar o repositório.

Antes de publicar, incremente a versão no `package.json` e no `package-lock.json`, crie uma tag `v*` e envie-a ao repositório. O workflow de GitHub Actions gera em paralelo o instalador Windows, o AppImage e o `.deb`, publicando também os metadados usados pelo updater.

## Primeiro teste com um amigo

Para testar áudio, tela e chat pela Radmin:

1. Conecte os dois computadores à mesma rede Radmin VPN.
2. No computador de cada pessoa, abra o JUMP pelo instalador Windows, pelo AppImage ou pelo `.deb`.
3. No host, clique em `copiar convite` e envie o link `jump://` para o amigo.
4. Com o JUMP instalado/aberto no computador do amigo, abra o convite. O app dele continuará usando `localhost` para liberar microfone/câmera e conectará a sinalização ao IP Radmin do host.
5. Permita o JUMP no Windows Firewall quando solicitado, especialmente a porta TCP `8787` no host.

Durante o teste, entre na chamada antes de conferir o microfone. Use o ícone de ajustes nos controles para trocar entrada/saída e o ícone de monitor para compartilhar a tela. O chat aceita PNG, JPG, WebP e GIF; imagens muito grandes são reduzidas para caber na conexão P2P.

O convite `jump://` é registrado pelo instalador nos dois sistemas. O link HTTP do modo web serve para testar o chat, mas o desktop é o caminho recomendado para testar chamadas e compartilhamento de tela pela Radmin.
