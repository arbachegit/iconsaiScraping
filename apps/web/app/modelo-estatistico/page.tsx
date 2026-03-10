'use client';

import type { ReactNode } from 'react';
import Link from 'next/link';
import {
  BookOpen,
  LayoutDashboard,
  Network,
  Sigma,
  TriangleAlert,
  CheckCircle2,
  FlaskConical,
} from 'lucide-react';

const sourceWeights = [
  ['fato_transacao_empresas', '1.00', 'Contrato social / quadro societário'],
  ['dim_empresas', '0.95', 'Cadastro empresarial estruturado'],
  ['dim_pessoas', '0.90', 'Pessoa física ou executivo já resolvido'],
  ['dim_politicos', '0.90', 'Cadastro político estruturado'],
  ['fato_politicos_mandatos', '0.85', 'Mandato, eleição ou exercício do cargo'],
  ['fato_emendas', '0.85', 'Emenda parlamentar'],
  ['fato_bens_candidato', '0.80', 'Bens declarados'],
  ['fato_receitas_campanha', '0.80', 'Receitas de campanha'],
  ['fato_votos_legislativos', '0.80', 'Votação legislativa'],
  ['dim_noticias', '0.50', 'Matéria jornalística'],
  ['fato_noticias_topicos', '0.40', 'Tópicos ou entidades extraídas de notícia'],
];

const relationWeights = [
  ['contrato_social', '1.00', 'Ligação formal e documental'],
  ['database', '0.85 ou strength da aresta', 'Relação já consolidada no grafo'],
  ['eleicao', '0.85', 'Mandato ou vínculo político-eleitoral'],
  ['cross_reference', '0.40', 'Coocorrência textual inferida'],
];

const advantages = [
  'É explicável: cada confiança nasce de pesos visíveis por fonte ou por evidência.',
  'É monotônico: nova evidência forte só aumenta a confiança, não reduz.',
  'Funciona bem com fontes heterogêneas, sem exigir treino supervisionado imediato.',
  'Permite separar duas perguntas diferentes: “o nó é confiável?” e “a relação é confiável?”',
  'É barato de computar e simples de recalibrar conforme o produto evolui.',
];

const problems = [
  'Assume independência entre evidências. Na prática, duas fontes podem derivar da mesma origem.',
  'Não modela evidência negativa. Ausência de dado não reduz a confiança.',
  'O peso inicial é calibrado manualmente; se o peso estiver errado, o resultado também estará.',
  'Coocorrência textual (`cross_reference`) pode criar falso positivo sem contexto semântico.',
  'Não há decaimento temporal embutido. Relações antigas continuam fortes até outra regra reduzi-las.',
  'Algumas arestas ainda dependem de heurística textual; isso deve ser tratado como investigação, não como prova final.',
];

const implementationChanges = [
  'IDs do grafo foram padronizados como compostos (`tipo:id`) para evitar colisão visual entre entidades diferentes com o mesmo ID bruto.',
  'O `entityId` bruto passou a ser preservado no payload do nó para que a sidebar consiga buscar detalhes corretos da entidade.',
  'A relevância do nó continua derivando das fontes do nó, mas a força da aresta passou a ser calculada pelas evidências da própria relação.',
  'O subgrafo expandido passou a buscar também arestas internas entre os nós descobertos, quando elas existem no grafo persistido.',
  'O tipo `mandato` foi alinhado com o contrato central do grafo para reduzir inconsistência entre camada analítica e camada persistida.',
];

const ecosystemRules = [
  {
    title: 'Hub',
    text: 'O hub continua sendo o ponto de partida da exploração. Ele mostra o contexto principal da consulta.',
  },
  {
    title: 'Arestas do hub',
    text: 'Toda ligação direta com o hub mostra relacionamento primário, proximidade operacional ou evidência institucional.',
  },
  {
    title: 'Arestas laterais',
    text: 'Quando dois nós descobertos também se relacionam entre si, a aresta lateral é exibida para revelar o ecossistema real e não só uma estrela artificial.',
  },
  {
    title: 'Leitura correta',
    text: 'Um cluster denso sugere ecossistema compartilhado; um conjunto de raios isolados sugere apenas relações pontuais com o hub.',
  },
];

const examples = [
  {
    title: 'Pessoa -> Empresa',
    description: 'Uma pessoa aparece em `dim_pessoas` e também em `fato_transacao_empresas` apontando para a empresa.',
    result: 'O nó pessoa ganha alta relevância; a aresta societária recebe confiança alta porque a evidência da relação é `contrato_social`.',
  },
  {
    title: 'Político -> Mandato',
    description: 'O mandato é encontrado em `fato_politicos_mandatos` e ligado ao político por evidência `eleicao`.',
    result: 'A relação tende a ser forte quando a evidência eleitoral é confirmada e o tipo `mandato` também está alinhado ao contrato central do grafo.',
  },
  {
    title: 'Empresa -> Notícia',
    description: 'A empresa surge em notícia e em tópicos extraídos, sem registro relacional forte no banco.',
    result: 'O nó pode ficar relevante para investigação, porém a relação continua moderada ou fraca se vier só de `cross_reference`.',
  },
];

const cases = [
  {
    title: 'Caso 1: Quadro societário real',
    points: [
      'Entrada: nome de um executivo buscado no Deep Search.',
      'Evidências do nó: `dim_pessoas` + `fato_transacao_empresas`.',
      'Evidência da relação: `contrato_social`.',
      'Leitura correta: alta confiabilidade do vínculo com a empresa.',
    ],
  },
  {
    title: 'Caso 2: Influência política indireta',
    points: [
      'Entrada: nome de um político e um município.',
      'Evidências do nó: `dim_politicos`, `fato_politicos_mandatos`, eventualmente `fato_emendas`.',
      'Evidência da relação: `eleicao` ou relação persistida no banco.',
      'Leitura correta: boa hipótese de influência institucional, mas não prova causalidade econômica.',
    ],
  },
  {
    title: 'Caso 3: Ruído jornalístico',
    points: [
      'Entrada: termo muito amplo que aparece em várias notícias.',
      'Evidências do nó: `dim_noticias` e `fato_noticias_topicos`.',
      'Evidência da relação: `cross_reference`.',
      'Leitura correta: sinal exploratório; precisa de confirmação documental antes de virar assertiva.',
    ],
  },
];

export default function ModeloEstatisticoPage() {
  return (
    <div className="min-h-screen bg-[#0a0e1a] text-slate-200">
      <header className="border-b border-cyan-500/10 bg-[#0f1629]/85 backdrop-blur-xl">
        <div className="mx-auto flex max-w-7xl items-center justify-between px-4 py-3 lg:px-6">
          <div className="flex items-center gap-3">
            <div className="rounded-xl border border-cyan-500/20 bg-cyan-500/10 p-2 text-cyan-300">
              <BookOpen className="h-5 w-5" />
            </div>
            <div>
              <h1 className="text-lg font-semibold text-white">Modelo Estatístico</h1>
              <p className="text-xs text-slate-400">Documentação operacional do grafo e do Deep Search</p>
            </div>
          </div>

          <div className="flex items-center gap-2">
            <Link
              href="/dashboard"
              className="inline-flex items-center gap-1.5 rounded-lg border border-slate-700 bg-slate-900/50 px-3 py-2 text-xs font-medium text-slate-300 transition-colors hover:border-cyan-500/30 hover:text-white"
            >
              <LayoutDashboard className="h-3.5 w-3.5" />
              Dashboard
            </Link>
            <Link
              href="/graph"
              className="inline-flex items-center gap-1.5 rounded-lg border border-purple-500/40 bg-purple-500/10 px-3 py-2 text-xs font-medium text-purple-300 transition-colors hover:bg-purple-500/20"
            >
              <Network className="h-3.5 w-3.5" />
              Graph
            </Link>
          </div>
        </div>
      </header>

      <main className="mx-auto max-w-7xl px-4 py-6 lg:px-6">
        <section className="grid gap-4 lg:grid-cols-[1.4fr_0.9fr]">
          <div className="rounded-3xl border border-cyan-500/15 bg-[radial-gradient(circle_at_top_left,rgba(34,211,238,0.14),transparent_38%),linear-gradient(180deg,rgba(15,22,41,0.96),rgba(9,14,26,0.94))] p-6 shadow-[0_32px_100px_-60px_rgba(34,211,238,0.6)]">
            <div className="inline-flex items-center gap-2 rounded-full border border-cyan-500/20 bg-cyan-500/10 px-3 py-1 text-[11px] font-semibold uppercase tracking-[0.2em] text-cyan-300">
              <Sigma className="h-3.5 w-3.5" />
              Fórmula central
            </div>
            <h2 className="mt-4 text-3xl font-semibold tracking-tight text-white">
              C = 1 - ∏(1 - p_i)
            </h2>
            <p className="mt-4 max-w-3xl text-sm leading-7 text-slate-300">
              O sistema usa um modelo Bayesiano simplificado para combinar evidências independentes.
              Cada fonte contribui com uma probabilidade inicial `p_i`. A confiança final cresce conforme novas
              evidências entram, evitando que uma única fonte fraca domine o resultado.
            </p>
            <div className="mt-6 grid gap-3 md:grid-cols-2">
              <MetricCard
                title="Relevância do nó"
                text="Calculada a partir das fontes que sustentam a existência e a qualidade daquele nó."
              />
              <MetricCard
                title="Confiança da relação"
                text="Calculada a partir das evidências da própria aresta, e não mais da média das pontuações dos nós."
              />
            </div>
          </div>

          <div className="rounded-3xl border border-amber-500/15 bg-[linear-gradient(180deg,rgba(38,26,13,0.86),rgba(15,22,41,0.94))] p-6 shadow-[0_24px_90px_-60px_rgba(245,158,11,0.7)]">
            <div className="inline-flex items-center gap-2 rounded-full border border-amber-500/20 bg-amber-500/10 px-3 py-1 text-[11px] font-semibold uppercase tracking-[0.18em] text-amber-300">
              <FlaskConical className="h-3.5 w-3.5" />
              Leitura prática
            </div>
            <div className="mt-4 space-y-4 text-sm leading-7 text-slate-300">
              <p>
                Um nó com 95% de relevância significa que ele está bem sustentado por fontes confiáveis.
              </p>
              <p>
                Uma relação com 40% de confiança significa que o vínculo ainda é frágil, mesmo que os dois nós isoladamente sejam fortes.
              </p>
              <p>
                Isso evita o erro clássico de tratar “duas entidades confiáveis” como “relação confiável”.
              </p>
            </div>
          </div>
        </section>

        <section className="mt-6 grid gap-4 lg:grid-cols-2">
          <Panel title="O que foi implementado nesta revisão" icon={FlaskConical} tone="cyan">
            <div className="space-y-2">
              {implementationChanges.map((item) => (
                <div key={item} className="rounded-2xl border border-cyan-500/10 bg-cyan-500/5 px-4 py-3 text-sm leading-7 text-slate-300">
                  {item}
                </div>
              ))}
            </div>
          </Panel>

          <Panel title="Como ler o ecossistema do grafo" icon={Network} tone="purple">
            <div className="grid gap-3 sm:grid-cols-2">
              {ecosystemRules.map((item) => (
                <article key={item.title} className="rounded-2xl border border-purple-500/10 bg-purple-500/5 p-4">
                  <h3 className="text-sm font-semibold text-white">{item.title}</h3>
                  <p className="mt-2 text-sm leading-7 text-slate-300">{item.text}</p>
                </article>
              ))}
            </div>
          </Panel>
        </section>

        <section className="mt-6 grid gap-4 lg:grid-cols-2">
          <Panel
            title="Pesos das fontes para relevância dos nós"
            icon={CheckCircle2}
            tone="cyan"
          >
            <div className="overflow-hidden rounded-2xl border border-slate-800">
              <table className="w-full text-left text-xs">
                <thead className="bg-slate-950/40 text-slate-500">
                  <tr>
                    <th className="px-3 py-2 font-semibold">Fonte</th>
                    <th className="px-3 py-2 font-semibold">Peso</th>
                    <th className="px-3 py-2 font-semibold">Leitura</th>
                  </tr>
                </thead>
                <tbody>
                  {sourceWeights.map(([source, weight, label]) => (
                    <tr key={source} className="border-t border-slate-900 text-slate-300">
                      <td className="px-3 py-2 font-mono text-[11px] text-slate-400">{source}</td>
                      <td className="px-3 py-2 font-semibold text-cyan-300">{weight}</td>
                      <td className="px-3 py-2">{label}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </Panel>

          <Panel
            title="Pesos das evidências para confiança das relações"
            icon={Network}
            tone="purple"
          >
            <div className="overflow-hidden rounded-2xl border border-slate-800">
              <table className="w-full text-left text-xs">
                <thead className="bg-slate-950/40 text-slate-500">
                  <tr>
                    <th className="px-3 py-2 font-semibold">Evidência</th>
                    <th className="px-3 py-2 font-semibold">Peso</th>
                    <th className="px-3 py-2 font-semibold">Leitura</th>
                  </tr>
                </thead>
                <tbody>
                  {relationWeights.map(([source, weight, label]) => (
                    <tr key={source} className="border-t border-slate-900 text-slate-300">
                      <td className="px-3 py-2 font-mono text-[11px] text-slate-400">{source}</td>
                      <td className="px-3 py-2 font-semibold text-purple-300">{weight}</td>
                      <td className="px-3 py-2">{label}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </Panel>
        </section>

        <section className="mt-6 grid gap-4 lg:grid-cols-2">
          <Panel title="Vantagens" icon={CheckCircle2} tone="green">
            <ul className="space-y-2 text-sm leading-7 text-slate-300">
              {advantages.map((item) => (
                <li key={item} className="rounded-2xl border border-green-500/10 bg-green-500/5 px-4 py-3">
                  {item}
                </li>
              ))}
            </ul>
          </Panel>

          <Panel title="Problemas e limitações" icon={TriangleAlert} tone="amber">
            <ul className="space-y-2 text-sm leading-7 text-slate-300">
              {problems.map((item) => (
                <li key={item} className="rounded-2xl border border-amber-500/10 bg-amber-500/5 px-4 py-3">
                  {item}
                </li>
              ))}
            </ul>
          </Panel>
        </section>

        <section className="mt-6">
          <Panel title="Exemplos objetivos" icon={BookOpen} tone="cyan">
            <div className="grid gap-4 lg:grid-cols-3">
              {examples.map((example) => (
                <article key={example.title} className="rounded-2xl border border-slate-800 bg-slate-950/25 p-4">
                  <h3 className="text-sm font-semibold text-white">{example.title}</h3>
                  <p className="mt-3 text-sm leading-7 text-slate-400">{example.description}</p>
                  <p className="mt-3 rounded-xl border border-cyan-500/10 bg-cyan-500/5 px-3 py-3 text-sm leading-7 text-slate-300">
                    {example.result}
                  </p>
                </article>
              ))}
            </div>
          </Panel>
        </section>

        <section className="mt-6">
          <Panel title="Estudos de caso" icon={FlaskConical} tone="purple">
            <div className="grid gap-4 lg:grid-cols-3">
              {cases.map((item) => (
                <article key={item.title} className="rounded-2xl border border-purple-500/10 bg-purple-500/5 p-4">
                  <h3 className="text-sm font-semibold text-white">{item.title}</h3>
                  <div className="mt-3 space-y-2 text-sm leading-7 text-slate-300">
                    {item.points.map((point) => (
                      <p key={point} className="rounded-xl bg-slate-950/30 px-3 py-2">
                        {point}
                      </p>
                    ))}
                  </div>
                </article>
              ))}
            </div>
          </Panel>
        </section>

        <section className="mt-6 rounded-3xl border border-slate-800 bg-slate-950/30 p-6">
          <h2 className="text-lg font-semibold text-white">Resumo operacional</h2>
          <div className="mt-4 grid gap-3 md:grid-cols-3">
            <SummaryChip label="Nó forte" text="Fontes confiáveis e consistentes sustentam a entidade." />
            <SummaryChip label="Relação forte" text="A evidência do vínculo é documental ou já consolidada no grafo." />
            <SummaryChip label="Relação fraca" text="Use como hipótese investigativa, não como conclusão final." />
          </div>
          <div className="mt-4 grid gap-3 md:grid-cols-2">
            <SummaryChip label="Topologia em estrela" text="Serve para orientação inicial, mas não revela o ecossistema completo." />
            <SummaryChip label="Topologia em ecossistema" text="Conexões laterais entre vizinhos mostram cadeias de influência, dependência e proximidade real." />
          </div>
        </section>
      </main>
    </div>
  );
}

function Panel({
  title,
  icon: Icon,
  tone,
  children,
}: {
  title: string;
  icon: typeof BookOpen;
  tone: 'cyan' | 'purple' | 'green' | 'amber';
  children: ReactNode;
}) {
  const tones = {
    cyan: 'border-cyan-500/15 bg-cyan-500/5 text-cyan-300',
    purple: 'border-purple-500/15 bg-purple-500/5 text-purple-300',
    green: 'border-green-500/15 bg-green-500/5 text-green-300',
    amber: 'border-amber-500/15 bg-amber-500/5 text-amber-300',
  };

  return (
    <section className="rounded-3xl border border-slate-800 bg-[#0f1629]/88 p-5">
      <div className="mb-4 flex items-center gap-3">
        <div className={`rounded-xl border p-2 ${tones[tone]}`}>
          <Icon className="h-4 w-4" />
        </div>
        <h2 className="text-base font-semibold text-white">{title}</h2>
      </div>
      {children}
    </section>
  );
}

function MetricCard({ title, text }: { title: string; text: string }) {
  return (
    <div className="rounded-2xl border border-slate-800 bg-slate-950/25 p-4">
      <div className="text-sm font-semibold text-white">{title}</div>
      <div className="mt-2 text-sm leading-7 text-slate-400">{text}</div>
    </div>
  );
}

function SummaryChip({ label, text }: { label: string; text: string }) {
  return (
    <div className="rounded-2xl border border-slate-800 bg-slate-900/35 p-4">
      <div className="text-sm font-semibold text-cyan-300">{label}</div>
      <div className="mt-2 text-sm leading-7 text-slate-400">{text}</div>
    </div>
  );
}
