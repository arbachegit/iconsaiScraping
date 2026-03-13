-- ============================================================
-- Migration 064: Classificador Determinístico de tema_principal
--
-- Classifica 405K+ notícias sem tema usando regex sobre titulo+resumo.
-- Usa padrões amplos por tema (não apenas sinais específicos).
-- Prioridade: temas específicos > geral.
--
-- Also: adds meio_ambiente to CHECK constraint,
--        adds meio_ambiente to map_tema_taxonomia,
--        creates fn_detect_sinais_batch for bulk signal detection.
--
-- EXECUTED: 2026-03-13
--   - 437,921 noticias classified (100% coverage)
--   - 351,132 noticias with signals detected (80.2%)
--   - 1,326,670 associations created
-- ============================================================

-- 0. PREREQUISITE: extend CHECK constraint
ALTER TABLE dim_noticias DROP CONSTRAINT IF EXISTS chk_noticias_tema_principal;
ALTER TABLE dim_noticias ADD CONSTRAINT chk_noticias_tema_principal
  CHECK (tema_principal IS NULL OR tema_principal IN (
    'economia', 'mercado', 'politica', 'saude', 'educacao',
    'tecnologia', 'infraestrutura', 'energia', 'agricultura',
    'seguranca_publica', 'meio_ambiente', 'geral'
  ));

-- Add meio_ambiente to tema mapping
INSERT INTO map_tema_taxonomia (tema_principal, taxonomia_slug)
VALUES ('meio_ambiente', 'meio_ambiente')
ON CONFLICT (tema_principal) DO NOTHING;

-- 1. FUNÇÃO: classificar tema_principal por regex
CREATE OR REPLACE FUNCTION fn_classify_tema_deterministic(p_titulo TEXT, p_resumo TEXT)
RETURNS TEXT LANGUAGE plpgsql IMMUTABLE AS $$
DECLARE
  texto TEXT;
BEGIN
  -- Concatenar titulo + resumo (limpo de HTML)
  texto := lower(coalesce(p_titulo, '') || ' ' || regexp_replace(coalesce(p_resumo, ''), '<[^>]+>', '', 'g'));

  -- SEGURANÇA PÚBLICA (alta precisão: palavras muito específicas)
  IF texto ~* '(pol[íi]cia|delegacia|homic[íi]dio|assassin|latroc[íi]nio|sequestro|pris[ãa]o|preso|detido|apreend|trafic|drogas|arma de fogo|tiroteio|assalto|roubo|furto|facção|milícia|chacina|feminic[íi]dio|estupro|crime organizado|operação policial|batalhão|viatura|BOPE|PM |Polícia Militar|Polícia Civil|Polícia Federal|PF |PRF |Guarda Municipal|penitenci[áa]ri|criminoso|suspeito.*preso|mandado.*pris|flagrante|inquérito policial)' THEN
    RETURN 'seguranca_publica';
  END IF;

  -- SAÚDE
  IF texto ~* '(hospital|SUS|vacinação|vacina|epidemia|pandemia|dengue|sa[úu]de p[úu]blica|m[ée]dico|enfermeiro|UPA|UBS|leito|internação|cirurgia|transplante|ANVISA|plano de sa[úu]de|doen[çc]a|v[íi]rus|surto|[óo]bito|mortalidade|zika|chikungunya|gripe|influenza|covid|coronav[íi]rus|oncolog|câncer|medicamento|farm[áa]cia|posto de sa[úu]de|aten[çc][ãa]o b[áa]sica|sa[úu]de mental|psiquiatr)' THEN
    RETURN 'saude';
  END IF;

  -- EDUCAÇÃO
  IF texto ~* '(escola|universidade|faculdade|ENEM|professor|educa[çc][ãa]o|ensino|MEC|FUNDEB|FIES|ProUni|creche|alfabetiza|matr[íi]cula|merenda|sala de aula|IDEB|PISA|vestibular|concurso p[úu]blico|estudante|aluno|campus|reitoria|bolsa.*estud|novo ensino m[ée]dio|curr[íi]culo|pedag[óo]g)' THEN
    RETURN 'educacao';
  END IF;

  -- ENERGIA
  IF texto ~* '(Petrobras|petr[óo]leo|pr[ée]-sal|g[áa]s natural|energia el[ée]trica|energia renov[áa]vel|energia solar|energia e[óo]lica|hidrel[ée]trica|termel[ée]trica|usina nuclear|ANEEL|leil[ãa]o.*energia|tarifa.*energia|bandeira.*tarif[áa]ria|apag[ãa]o|racionamento|combust[íi]vel|gasolina|etanol|diesel|biocombust[íi]vel|GNV|distribuidora.*energia|concession[áa]ria.*energia|transi[çc][ãa]o energ)' THEN
    RETURN 'energia';
  END IF;

  -- AGRICULTURA
  IF texto ~* '(agroneg[óo]cio|safra|soja|milho|caf[ée]|algod[ãa]o|pecuária|gado|boi|rebanho|Embrapa|MAPA|Conab|exporta[çc][ãa]o.*agr|agricultura familiar|MST|reforma agr[áa]ria|assentamento|irriga[çc][ãa]o|defensivo|agrot[óo]xico|fertilizante|colheita|plantio|semente|cooperativa.*agr|agroind[úu]stria|Plano Safra|cr[ée]dito rural)' THEN
    RETURN 'agricultura';
  END IF;

  -- MEIO AMBIENTE
  IF texto ~* '(desmatamento|floresta|amaz[ôo]nia|IBAMA|ICMBio|meio ambiente|mudan[çc]a clim[áa]tica|aquecimento global|emiss[ãa]o.*carbono|sustentabilidade|sustent[áa]vel|reciclagem|polui[çc][ãa]o|contamina[çc][ãa]o|[áa]rea.*protegida|reserva.*ambiental|bioma|cerrado|pantanal|caatinga|mata atl[âa]ntica|fauna|flora|ext[ãa]o|biodiversidade|licenciamento ambiental|crime ambiental|queimada|inc[êe]ndio.*florestal)' THEN
    RETURN 'meio_ambiente';
  END IF;

  -- INFRAESTRUTURA
  IF texto ~* '(obra|rodovia|ferrovia|metr[ôo]|aeroporto|porto|saneamento|[áa]gua.*esgoto|pavimenta[çc][ãa]o|ponte|viaduto|t[úu]nel|BRT|VLT|mobilidade urbana|transporte p[úu]blico|concess[ãa]o.*rodov|ped[áa]gio|DNIT|habita[çc][ãa]o|Minha Casa|moradia|constru[çc][ãa]o civil|PPP|parceria p[úu]blico|leil[ãa]o.*infra|logística|armazém|silo)' THEN
    RETURN 'infraestrutura';
  END IF;

  -- TECNOLOGIA
  IF texto ~* '(intelig[êe]ncia artificial|IA |startup|tecnologia|digital|software|aplicativo|app |ciberseguran[çc]a|hacker|dados pessoais|LGPD|5G|telecom|internet|fibra [óo]ptica|programa[çc][ãa]o|cloud|nuvem|blockchain|criptomoeda|bitcoin|fintech|big data|machine learning|rob[ôo]tica|automa[çc][ãa]o|inova[çc][ãa]o tecnol|data center|semicondutor|chip|microprocessador)' THEN
    RETURN 'tecnologia';
  END IF;

  -- ECONOMIA (amplo)
  IF texto ~* '(PIB|infla[çc][ãa]o|IPCA|IGP-M|Selic|taxa de juros|Banco Central|COPOM|câmbio|d[óo]lar|desemprego|IBGE|PNAD|emprego formal|CAGED|recessão|supera[çc][ãa]o|d[íi]vida p[úu]blica|d[ée]ficit|super[áa]vit|balan[çc]a comercial|exporta[çc][ãa]o|importa[çc][ãa]o|or[çc]amento|LOA|LDO|PPA|reforma tribut[áa]ria|IBS|CBS|imposto|tributo|arrecada[çc][ãa]o|receita federal|tesouro|t[íi]tulo p[úu]blico|fiscal|arcabou[çc]o|meta fiscal|gasto p[úu]blico|investimento p[úu]blico)' THEN
    RETURN 'economia';
  END IF;

  -- MERCADO
  IF texto ~* '(Ibovespa|B3|bolsa de valores|a[çc][ãa]o.*bolsa|mercado financeiro|investidor|fundo.*investimento|CDB|CDI|renda fixa|renda vari[áa]vel|IPO|abertura de capital|fus[ãa]o|aquisi[çc][ãa]o|M&A|private equity|venture capital|dividendo|lucro l[íi]quido|balan[çc]o.*empresa|EBITDA|valuation|mercado de capitais|CVM|debênture|FII|fundo imobili[áa]rio)' THEN
    RETURN 'mercado';
  END IF;

  -- POLÍTICA (amplo — muita notícia política no Brasil)
  IF texto ~* '(congresso|senado|c[âa]mara dos deputados|deputado|senador|ministro|presidente.*rep[úu]blica|governo federal|planalto|Lula|Bolsonaro|elei[çc][ãa]o|partido|PT |PL |MDB|PP |PSDB|PDT|PSB|PSol|PSD|Uni[ãa]o Brasil|STF|STJ|TSE|TST|TCU|CGU|PGR|procurador-geral|projeto de lei|PEC|medida provis[óo]ria|vota[çc][ãa]o|plen[áa]rio|comiss[ãa]o parlamentar|CPI|emenda parlamentar|coliga[çc][ãa]o|coaliz[ãa]o|base aliada|oposi[çc][ãa]o|governador|prefeito|vereador|câmara municipal|assembleia legislativa)' THEN
    RETURN 'politica';
  END IF;

  -- DEFAULT
  RETURN 'geral';
END;
$$;

-- 2. FUNÇÃO: classificar tipo_classificacao por heurística
CREATE OR REPLACE FUNCTION fn_classify_tipo_deterministic(p_titulo TEXT, p_resumo TEXT)
RETURNS TEXT LANGUAGE plpgsql IMMUTABLE AS $$
DECLARE
  texto TEXT;
BEGIN
  texto := lower(coalesce(p_titulo, '') || ' ' || regexp_replace(coalesce(p_resumo, ''), '<[^>]+>', '', 'g'));

  -- Investigativa: denúncias, irregularidades, escândalos
  IF texto ~* '(investiga[çc][ãa]o|den[úu]ncia|irregularidade|esc[âa]ndalo|corrup[çc][ãa]o|fraude|lavagem|desvio|superfaturamento|propina|delação|opera[çc][ãa]o.*policial|preso|condenado|mandado|flagrante|CPI|TCU.*irregul)' THEN
    RETURN 'investigativa';
  END IF;

  -- Sinal: alertas e indicadores
  IF texto ~* '(alerta|risco|crise|emerg[êe]ncia|colapso|recorde negativo|queda brusca|disparada|descontrole)' THEN
    RETURN 'sinal';
  END IF;

  -- Tendência: projeções e movimentos
  IF texto ~* '(tend[êe]ncia|previs[ãa]o|projeção|perspectiva|cen[áa]rio|expectativa|estimativa|forecast)' THEN
    RETURN 'tendencia';
  END IF;

  -- Analítica: análises e opinião qualificada
  IF texto ~* '(an[áa]lise|opini[ãa]o|editorial|coluna|artigo|entrevista|avalia[çc][ãa]o|estudo|pesquisa.*mostra|segundo.*especialista|de acordo com.*analista)' THEN
    RETURN 'analitica';
  END IF;

  -- Default: factual
  RETURN 'factual';
END;
$$;

-- 3. FUNÇÃO: batch de detecção de sinais via regex
CREATE OR REPLACE FUNCTION fn_detect_sinais_batch(p_limit INTEGER DEFAULT 10000)
RETURNS TABLE (
  noticias_processadas BIGINT,
  sinais_detectados BIGINT
) LANGUAGE plpgsql AS $$
DECLARE
  v_noticias BIGINT := 0;
  v_sinais BIGINT := 0;
BEGIN
  -- Insert signals for noticias that match keyword patterns
  WITH noticias_batch AS (
    SELECT n.id, lower(coalesce(n.titulo, '') || ' ' || regexp_replace(coalesce(n.resumo, ''), '<[^>]+>', '', 'g')) AS texto
    FROM dim_noticias n
    LEFT JOIN fato_noticias_sinais ns ON ns.noticia_id = n.id
    WHERE n.tema_principal IS NOT NULL
      AND ns.id IS NULL
    LIMIT p_limit
  ),
  matched AS (
    SELECT nb.id AS noticia_id, s.id AS sinal_id
    FROM noticias_batch nb
    CROSS JOIN dim_sinais_contextuais s
    WHERE s.ativo = true
      AND s.keywords_regex IS NOT NULL
      AND nb.texto ~* s.keywords_regex
  ),
  inserted AS (
    INSERT INTO fato_noticias_sinais (noticia_id, sinal_id, confidence, detection_method)
    SELECT noticia_id, sinal_id, 0.70, 'regex'
    FROM matched
    ON CONFLICT (noticia_id, sinal_id) DO NOTHING
    RETURNING id
  )
  SELECT count(DISTINCT m.noticia_id), count(i.id)
  INTO v_noticias, v_sinais
  FROM matched m
  LEFT JOIN inserted i ON true;

  noticias_processadas := v_noticias;
  sinais_detectados := v_sinais;
  RETURN NEXT;
END;
$$;
