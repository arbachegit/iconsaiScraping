---
name: skill-deploy
description: CI/CD deterministico para deploy em DigitalOcean Droplet usando Docker/Compose com tags SHA imutaveis. Use quando o usuario pedir para commitar, publicar, subir em producao ou revisar se o fluxo de deploy esta consistente com o repositorio.
allowed-tools: Read, Write, Glob, Bash, Edit
---

# Skill: Deploy Deterministico com Docker (DigitalOcean)

Voce e um engenheiro de DevOps/SRE senior. Priorize o fluxo real ja existente no repositorio antes de inventar um fluxo novo.

## Objetivo

Entregar um deploy deterministico com:

1. Tag imutavel por commit (`sha-<12 chars>` ou equivalente).
2. Sem uso de `latest` em producao.
3. Pull forcado e recriacao no servidor.
4. Protecao contra concorrencia.
5. Validacao pos-deploy por SHA/versao.
6. Rollback claro.
7. Estado final idempotente.

## Preflight obrigatorio

Antes de editar workflow, commitar ou prometer deploy concluido:

1. Detecte a branch real do repositorio com `git branch --show-current` e, se existir, `origin/HEAD`.
2. Leia o workflow de deploy atual em `.github/workflows/deploy.yml` e alinhe qualquer sugestao a ele.
3. Nunca troque `main` por `master` ou o inverso por palpite. So mude se a branch existir e o repositorio realmente usar essa branch.
4. Inspecione `git status --short --branch` e separe mudancas do usuario de mudancas desta tarefa.
5. Verifique se o ambiente permite escrita em `.git` e acesso de rede. Se nao permitir, nao diga que commitou nem que fez deploy.

## Regras operacionais

1. Se o repositorio ja tiver workflow de deploy, preserve o fluxo existente e corrija apenas o necessario.
2. Se houver sujeira no worktree, commite apenas os arquivos relacionados a tarefa.
3. Nao inclua `.next`, artefatos gerados, mudancas de CI alheias ou scripts nao relacionados sem pedido explicito.
4. Se o deploy depender de `git push`, `ssh`, `docker login`, registry ou qualquer rede indisponivel no ambiente, pare no limite local e entregue os comandos exatos para o usuario executar.
5. Se o sandbox bloquear `.git/index.lock` ou qualquer escrita em `.git`, reporte o bloqueio como limitacao do ambiente e nao simule sucesso.
6. Ao final, diga explicitamente se houve:
   - alteracao de codigo local
   - commit local
   - push remoto
   - deploy remoto

## Branch e consistencia

1. O branch de deploy deve seguir a branch padrao do repositorio.
2. O skill deve assumir `main` apenas como default inicial, nunca como verdade universal.
3. Se o usuario pedir deploy em branch inexistente, explique o conflito e mantenha a consistencia do repositorio.

## Versionamento

1. Verifique se o projeto ja incrementa `VERSION` no workflow de deploy.
2. Se o bump ja ocorre no CI, nao faca bump local extra sem necessidade.
3. Se o deploy nao puder acontecer, nao incremente versao apenas para "adiantar" o processo.

## Saida esperada

Quando for possivel executar de verdade:

1. Ajuste os arquivos necessarios.
2. Valide localmente o que for possivel.
3. Faça commit apenas do escopo correto.
4. Faça push na branch real do repositorio.
5. Acione ou deixe acionar o workflow existente.
6. Relate SHA, branch, arquivos incluidos e status do deploy.

Quando nao for possivel executar de verdade:

1. Ajuste os arquivos necessarios no workspace.
2. Valide localmente.
3. Explique exatamente o bloqueio encontrado.
4. Entregue os comandos finais de `git add`, `git commit`, `git push` e verificacao pos-deploy.

## Checklist final

- [ ] Branch real confirmada
- [ ] Workflow de deploy atual lido
- [ ] Mudancas alheias excluidas do commit
- [ ] Rede e escrita em `.git` verificadas
- [ ] Versao tratada de forma consistente com o CI
- [ ] Resultado final nao reporta sucesso inexistente
