# Correções Globais dos Skills Codex

Este documento resume os problemas encontrados nos skills globais `skill-deploy` e `skill-versioning`, as correções aplicadas e como sincronizá-las para `~/.codex/skills`.

## Objetivo

Evitar falhas operacionais recorrentes em tarefas de commit, deploy e versionamento, principalmente quando:

- a branch real do repositório não é a branch presumida pelo agente
- o ambiente bloqueia escrita em `.git`
- o ambiente não tem acesso de rede
- existe sujeira no worktree que não deve entrar no commit
- o CI já faz bump de versão e o agente tenta duplicar isso localmente

## Problemas identificados

### 1. Suposição rígida de branch

O skill de deploy tratava `main` como padrão fixo de operação. Isso funciona em muitos projetos, mas é incorreto como regra global.

Risco:

- sugerir ou implementar deploy em branch errada
- trocar `main` por `master` ou o inverso sem validar a realidade do repositório

### 2. Falta de preflight operacional

Os skills não exigiam uma checagem mínima do ambiente antes de afirmar que houve commit ou deploy.

Risco:

- dizer que commitou sem conseguir escrever em `.git`
- dizer que fez deploy sem rede, `git push`, `ssh` ou acesso ao registry

### 3. Mistura entre mudanças da tarefa e mudanças alheias

O skill de deploy não deixava forte o suficiente a separação entre arquivos da tarefa e sujeira pré-existente no worktree.

Risco:

- commits contaminados com alterações não relacionadas
- inclusão indevida de artefatos como `.next/`

### 4. Bump de versão fora do momento real

O skill de versionamento assumia incremento automático em toda situação de “deploy”, sem verificar se o deploy realmente ocorreria.

Risco:

- `VERSION` ficar adiantado sem publicação real
- `CHANGELOG.md` ficar incoerente com o que foi efetivamente ao ar

### 5. Inconsistência entre skill global e scripts do projeto

O skill de versionamento apontava para um fluxo genérico, mas alguns projetos já têm script próprio, como `scripts/version.py`.

Risco:

- duplicação de regra
- divergência entre versionamento local e versionamento do CI

## Correções aplicadas

### `skill-deploy`

O template corrigido agora exige:

1. detecção da branch real com `git branch --show-current`
2. leitura do workflow atual em `.github/workflows/deploy.yml`
3. validação do estado do `git`
4. verificação explícita de escrita em `.git`
5. verificação explícita de disponibilidade de rede
6. separação entre mudanças da tarefa e mudanças alheias
7. relato honesto do que de fato ocorreu:
   - alteração local
   - commit local
   - push remoto
   - deploy remoto

Também foi adicionada a regra:

- nunca trocar `main` e `master` por palpite

### `skill-versioning`

O template corrigido agora exige:

1. leitura prévia de `VERSION`, `CHANGELOG.md` e workflow de deploy
2. priorização do script local do projeto quando existir
3. alinhamento com o bump feito pelo CI, se já houver
4. proibição de bump artificial quando o deploy não ocorreu
5. consistência entre valor de `VERSION` e apresentação visual com prefixo `V`

## Arquivos criados

### Templates corrigidos

- `scripts/codex_skill_fixes/skill-deploy.SKILL.md`
- `scripts/codex_skill_fixes/skill-versioning.SKILL.md`

### Script de sincronização global

- `scripts/sync_codex_global_skills.py`

### Documento com script embutido

- `scripts/codex_skill_fixes/README.md`

## Como aplicar globalmente

Executar:

```bash
python3 scripts/sync_codex_global_skills.py
```

Isso sobrescreve:

- `~/.codex/skills/skill-deploy/SKILL.md`
- `~/.codex/skills/skill-versioning/SKILL.md`

Com backup automático do arquivo anterior no mesmo diretório, no formato:

```text
SKILL.md.bak.<timestamp>
```

## Como validar antes

Dry run:

```bash
python3 scripts/sync_codex_global_skills.py --dry-run
```

Teste em diretório temporário:

```bash
python3 scripts/sync_codex_global_skills.py --output-dir /tmp/codex-skills-test
```

## Resultado esperado

Depois da sincronização:

- o agente não deve mais afirmar commit/deploy sem condições reais de execução
- o agente deve respeitar a branch real do projeto
- o versionamento deve seguir o fluxo real do repositório
- o risco de commit contaminado por arquivos alheios cai significativamente

## Limitação deste ambiente

Eu não consegui escrever diretamente em `~/.codex/skills` a partir daqui porque o sandbox bloqueia escrita fora do workspace. Por isso, a solução foi empacotada no repositório para aplicação local pelo script de sincronização.
