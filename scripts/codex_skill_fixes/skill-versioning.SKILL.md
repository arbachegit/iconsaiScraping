---
name: skill-versioning
description: Gerencia versionamento automatico de projetos IconsAI com formato MAJOR.DEPLOY_COUNT.YEAR. Use quando o usuario pedir bump de versao, release, changelog ou integracao do versionamento ao deploy.
allowed-tools: Read, Write, Bash
---

# Skill: Versionamento Automatico (Global)

Gerencia o versionamento de projetos IconsAI com foco em deploy real, nao em bump artificial.

## Formato

`MAJOR.DEPLOY_COUNT.YEAR`

Exemplo: `1.257.2026`

## Preflight obrigatorio

1. Leia `VERSION`, `CHANGELOG.md` e o workflow de deploy antes de alterar qualquer coisa.
2. Descubra se o projeto ja usa um script local como `scripts/version.py`.
3. Se o workflow ja faz bump automatico durante o deploy, preserve esse contrato.
4. Se o deploy nao puder ocorrer, nao incremente versao sem pedido explicito.

## Regras

1. Sempre manter formato `MAJOR.COUNT.YEAR`.
2. Nunca reusar numero de versao.
3. Sempre manter `CHANGELOG.md` consistente com o numero realmente publicado.
4. Nao misturar formatos como `V1.70.2026` no arquivo `VERSION`; o prefixo `V` pode ser usado apenas na apresentacao.
5. Preferir o script de versao do proprio repositorio quando ele existir.
6. Se nao houver script local, usar incremento manual deterministico.

## Fluxo recomendado

1. Ler a versao atual:

```bash
cat VERSION
```

2. Se existir script local do projeto:

```bash
python scripts/version.py --deploy
```

3. Se nao existir script local:

```bash
CURRENT=$(cat VERSION)
MAJOR=$(echo "$CURRENT" | cut -d. -f1)
COUNT=$(echo "$CURRENT" | cut -d. -f2)
YEAR=$(date +%Y)
echo "$MAJOR.$((COUNT + 1)).$YEAR" > VERSION
```

4. Registrar no `CHANGELOG.md` a mesma versao que sera publicada.

## Integracao com CI/CD

1. Se o bump acontece no job de deploy, nao duplique o bump localmente.
2. Se o CI faz commit de `VERSION`, garanta que o `CHANGELOG.md` siga a mesma politica ou documente porque nao segue.
3. O endpoint `/health` ou `/version` deve exibir a versao publicada ou o SHA do deploy.

## Quando nao afirmar sucesso

Nao diga que a versao foi "deployada" se:

1. O commit nao foi criado.
2. O push nao aconteceu.
3. O workflow nao rodou.
4. O ambiente bloqueou escrita em `.git` ou acesso de rede.

## Checklist final

- [ ] `VERSION` lido e no formato correto
- [ ] `CHANGELOG.md` coerente
- [ ] script local de versionamento considerado
- [ ] bump alinhado com o workflow de deploy
- [ ] nenhuma versao foi incrementada sem deploy real, salvo pedido explicito
