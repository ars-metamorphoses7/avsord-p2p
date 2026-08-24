# Release do JUMP — procedimento para agentes

Use este documento sempre que o usuário pedir para **subir a próxima versão**, **publicar uma atualização** ou **fazer o aplicativo encontrar uma atualização**.

## Regra principal

O `electron-updater` não atualiza a partir de branches. Ele precisa de:

1. uma versão maior no `package.json` e no `package-lock.json`;
2. essa versão publicada em `main`;
3. uma tag `vX.Y.Z` enviada ao GitHub;
4. uma GitHub Release com o instalador e o arquivo `latest.yml`.

Apenas enviar uma branch não disponibiliza atualização para quem já tem o aplicativo instalado.

## Processo completo

### 1. Auditar antes de publicar

```powershell
git status --short --branch
git log --oneline --decorate -n 10
git branch -avv
git tag --list --sort=-creatordate
```

Confirmar:

- qual é a versão atual no `package.json`;
- qual é a última tag/release publicada;
- se existem alterações locais não relacionadas que precisam ser preservadas;
- se `main` está alinhada com `origin/main`.

Não apagar alterações do usuário, não usar `git reset --hard` e não forçar push.

### 2. Escolher a próxima versão

Usar uma versão semver maior que a última release. Exemplo: `1.0.18` → `1.0.19`.

Atualizar exatamente os dois arquivos:

- `package.json`
- `package-lock.json` (campo raiz e `packages[""].version`)

O número precisa ser idêntico nos dois arquivos e na tag.

### 3. Validar localmente

Executar, no mínimo:

```powershell
npm run test:update
npm run test:media
npm run build
```

Se a alteração envolver chamadas, captura ou o pipeline de mídia, executar também os testes relevantes, por exemplo:

```powershell
npm run test:call
npm run test:stream-benchmark
```

Não publicar se os testes obrigatórios falharem. O benchmark longo pode ser executado separadamente quando o objetivo for somente uma validação de release.

### 4. Commitar e publicar o código

Criar um commit explícito de versão, por exemplo:

```powershell
git add package.json package-lock.json
git commit -m "chore: prepare vX.Y.Z release"
```

Antes de publicar, confirmar que o commit contém todo o código que deve entrar na release. Se o trabalho estiver em uma branch de feature, publicar essa branch para backup/revisão e depois avançar `main` de forma fast-forward ou por merge normal aprovado.

```powershell
git push origin <branch-de-trabalho>
git push origin HEAD:main
```

Não criar uma release a partir de uma branch que ainda não esteja refletida em `main`.

### 5. Criar a tag que aciona os instaladores

Depois que `main` estiver no commit correto:

```powershell
git tag -a vX.Y.Z -m "JUMP vX.Y.Z"
git push origin vX.Y.Z
```

O workflow [`release.yml`](../.github/workflows/release.yml) é disparado somente por tags que começam com `v`. Ele gera e publica os instaladores Windows e Linux.

Não criar tags duplicadas, não mover tags existentes e não apagar releases para corrigir um erro sem autorização explícita.

### 6. Confirmar a release no GitHub

Acompanhar o workflow `Release JUMP` até os jobs `windows` e `linux` terminarem com sucesso. Confirmar que a release contém, pelo menos:

- `JUMP-X.Y.Z-win-x64.exe`;
- `latest.yml`;
- `JUMP-X.Y.Z-linux-x86_64.AppImage`;
- `latest-linux.yml`;
- pacote `.deb` Linux, quando o job Linux concluir.

O arquivo `latest.yml` deve declarar exatamente `version: X.Y.Z` e apontar para o instalador Windows correspondente. Sem esse arquivo o botão de atualização não encontra o pacote.

### 7. Teste prático

Em uma instalação empacotada da versão anterior:

1. fechar e reabrir o aplicativo;
2. clicar em atualizar/verificar atualizações;
3. confirmar que a versão nova aparece;
4. baixar e instalar;
5. confirmar a versão após a reabertura.

O updater não funciona em modo de desenvolvimento (`electron .`); ele exige o aplicativo empacotado.

## Checklist final do agente

- [ ] Versão incrementada em `package.json` e `package-lock.json`.
- [ ] Testes e build passaram.
- [ ] Commit de release criado.
- [ ] `main` contém o commit correto.
- [ ] Tag `vX.Y.Z` enviada.
- [ ] Workflow `Release JUMP` terminou com sucesso.
- [ ] Instalador Windows e `latest.yml` existem.
- [ ] Atualização prática confirmada ou limitação explicitada ao usuário.

## Estado conhecido deste repositório

A release confirmada mais recente antes deste ciclo é `v1.0.19`. A próxima versão preparada é `v1.0.20`; suas implementações, resultados e limitações estão registrados em [`RELEASE_NOTES_v1.0.20.md`](./RELEASE_NOTES_v1.0.20.md).
