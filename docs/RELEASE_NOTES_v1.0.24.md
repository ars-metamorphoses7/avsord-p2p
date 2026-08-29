# JUMP 1.0.24 — Field Run Diagnostics

## Atualização para usuários existentes

Após a publicação de `v1.0.24`, o fluxo normal permanece:

```text
JUMP
→ Configurações
→ Verificar atualização
→ Baixar
→ Instalar/reabrir
```

Depois da atualização, prepare um field run sem PowerShell, Node, npm ou build manual:

```text
Configurações
→ Field Run Diagnostics
→ Ativar e reiniciar
```

O JUMP retorna à sessão de sala persistida, mostra `FIELD DIAGNOSTICS ON` durante a chamada e grava os JSONs somente no computador local. Ao terminar o run, use **Abrir pasta de diagnóstico** para abrir `<userData>/diagnostics/screen-share`.

## Privacidade e identificabilidade da build

Diagnostics permanece desativado por padrão e não faz upload automático. A build embute versão, commit e horário de construção em `electron/build-metadata.json`; os artefatos mostram a versão e o commit sem depender de `.git` na instalação. `JUMP_APP_COMMIT` continua disponível como override de desenvolvimento.

`JUMP_STREAM_DIAGNOSTICS=1` continua suportado para testes e automação. Quando o ambiente força o modo, a interface deixa isso explícito e a desativação por botão fica indisponível.
