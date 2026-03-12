-- ============================================================
-- EMENDAS TIME SERIES RPCs
-- Engenharia de contexto temporal: evolução, não snapshot.
--
-- Roda no Brasil Data Hub (mnfjkegtynjtgesfphge)
--
-- RPC 8:  "Como evolui o orçamento?"     → série por ano
-- RPC 9:  "Como evolui por tema?"        → série por funcao x ano
-- RPC 10: "Como evolui por autor?"       → série por autor x ano
-- RPC 11: "Como evolui por território?"  → série por UF x ano
-- RPC 12: "Qual a concentração?"         → HHI e top-N share
-- ============================================================

-- RPC 8: SÉRIE TEMPORAL GERAL
-- Responde: "Quanto foi empenhado, liquidado e pago por ano?"
CREATE OR REPLACE FUNCTION get_emendas_time_series(
  p_funcao TEXT DEFAULT NULL,
  p_uf TEXT DEFAULT NULL,
  p_autor TEXT DEFAULT NULL,
  p_tipo_emenda TEXT DEFAULT NULL
)
RETURNS JSON AS $$
  SELECT json_agg(row_order)
  FROM (
    SELECT
      ano,
      COUNT(*) AS total_emendas,
      COALESCE(SUM(valor_empenhado), 0) AS valor_empenhado,
      COALESCE(SUM(valor_liquidado), 0) AS valor_liquidado,
      COALESCE(SUM(valor_pago), 0) AS valor_pago,
      CASE
        WHEN COALESCE(SUM(valor_empenhado), 0) > 0
        THEN ROUND((COALESCE(SUM(valor_pago), 0) / SUM(valor_empenhado) * 100)::numeric, 1)
        ELSE 0
      END AS taxa_execucao
    FROM fato_emendas_parlamentares
    WHERE ano IS NOT NULL
      AND (p_funcao IS NULL OR funcao = p_funcao)
      AND (p_uf IS NULL OR localidade ILIKE '%' || p_uf || '%')
      AND (p_autor IS NULL OR autor ILIKE '%' || p_autor || '%')
      AND (p_tipo_emenda IS NULL OR tipo_emenda = p_tipo_emenda)
    GROUP BY ano
    ORDER BY ano
  ) row_order;
$$ LANGUAGE sql STABLE;

-- RPC 9: SÉRIE POR TEMA (funcao)
-- Responde: "Saúde cresceu ou encolheu nos últimos anos?"
CREATE OR REPLACE FUNCTION get_emendas_funcao_time_series(p_limit INT DEFAULT 8)
RETURNS JSON AS $$
  WITH top_funcoes AS (
    SELECT funcao
    FROM fato_emendas_parlamentares
    WHERE funcao IS NOT NULL
    GROUP BY funcao
    ORDER BY SUM(valor_empenhado) DESC
    LIMIT p_limit
  )
  SELECT json_agg(row_order)
  FROM (
    SELECT
      e.ano,
      e.funcao,
      COUNT(*) AS total_emendas,
      COALESCE(SUM(e.valor_empenhado), 0) AS valor_empenhado,
      COALESCE(SUM(e.valor_pago), 0) AS valor_pago,
      CASE
        WHEN COALESCE(SUM(e.valor_empenhado), 0) > 0
        THEN ROUND((COALESCE(SUM(e.valor_pago), 0) / SUM(e.valor_empenhado) * 100)::numeric, 1)
        ELSE 0
      END AS taxa_execucao
    FROM fato_emendas_parlamentares e
    JOIN top_funcoes tf ON e.funcao = tf.funcao
    WHERE e.ano IS NOT NULL
    GROUP BY e.ano, e.funcao
    ORDER BY e.ano, e.funcao
  ) row_order;
$$ LANGUAGE sql STABLE;

-- RPC 10: SÉRIE POR AUTOR
-- Responde: "Como evoluiu o parlamentar X ao longo dos anos?"
CREATE OR REPLACE FUNCTION get_emendas_autor_time_series(p_autor TEXT)
RETURNS JSON AS $$
  SELECT json_agg(row_order)
  FROM (
    SELECT
      ano,
      COUNT(*) AS total_emendas,
      COALESCE(SUM(valor_empenhado), 0) AS valor_empenhado,
      COALESCE(SUM(valor_liquidado), 0) AS valor_liquidado,
      COALESCE(SUM(valor_pago), 0) AS valor_pago,
      CASE
        WHEN COALESCE(SUM(valor_empenhado), 0) > 0
        THEN ROUND((COALESCE(SUM(valor_pago), 0) / SUM(valor_empenhado) * 100)::numeric, 1)
        ELSE 0
      END AS taxa_execucao,
      COUNT(DISTINCT funcao) AS funcoes_distintas
    FROM fato_emendas_parlamentares
    WHERE autor = p_autor
      AND ano IS NOT NULL
    GROUP BY ano
    ORDER BY ano
  ) row_order;
$$ LANGUAGE sql STABLE;

-- RPC 11: SÉRIE POR TERRITÓRIO (UF dos favorecidos)
-- Responde: "Como evoluem os recursos para cada UF?"
CREATE OR REPLACE FUNCTION get_emendas_destino_time_series(p_limit INT DEFAULT 10)
RETURNS JSON AS $$
  WITH top_ufs AS (
    SELECT uf_favorecido AS uf
    FROM fato_emendas_favorecidos
    WHERE uf_favorecido IS NOT NULL
    GROUP BY uf_favorecido
    ORDER BY SUM(valor_recebido) DESC
    LIMIT p_limit
  )
  SELECT json_agg(row_order)
  FROM (
    SELECT
      f.ano,
      f.uf_favorecido AS uf,
      COUNT(*) AS total_repasses,
      COALESCE(SUM(f.valor_recebido), 0) AS valor_total
    FROM fato_emendas_favorecidos f
    JOIN top_ufs tu ON f.uf_favorecido = tu.uf
    WHERE f.ano_exercicio IS NOT NULL
    GROUP BY f.ano_exercicio, f.uf_favorecido
    ORDER BY f.ano_exercicio, f.uf_favorecido
  ) row_order;
$$ LANGUAGE sql STABLE;

-- RPC 12: CONCENTRAÇÃO E DISPERSÃO
-- Responde: "O orçamento está concentrado ou bem distribuído?"
CREATE OR REPLACE FUNCTION get_emendas_concentration()
RETURNS JSON AS $$
  WITH
  -- Concentração por autor (top 10 share)
  autor_totals AS (
    SELECT
      autor,
      SUM(valor_empenhado) AS total
    FROM fato_emendas_parlamentares
    WHERE valor_empenhado > 0
    GROUP BY autor
  ),
  autor_stats AS (
    SELECT
      COUNT(*) AS total_autores,
      SUM(total) AS valor_total,
      (SELECT SUM(total) FROM (
        SELECT total FROM autor_totals ORDER BY total DESC LIMIT 10
      ) t) AS top10_valor,
      (SELECT SUM(total) FROM (
        SELECT total FROM autor_totals ORDER BY total DESC LIMIT 50
      ) t) AS top50_valor
    FROM autor_totals
  ),
  -- Concentração por UF (beneficiários)
  uf_totals AS (
    SELECT
      uf_favorecido AS uf,
      SUM(valor_recebido) AS total
    FROM fato_emendas_favorecidos
    WHERE uf_favorecido IS NOT NULL AND valor_recebido > 0
    GROUP BY uf_favorecido
  ),
  uf_stats AS (
    SELECT
      COUNT(*) AS total_ufs,
      SUM(total) AS valor_total,
      (SELECT SUM(total) FROM (
        SELECT total FROM uf_totals ORDER BY total DESC LIMIT 5
      ) t) AS top5_valor
    FROM uf_totals
  ),
  -- Concentração por funcao
  funcao_totals AS (
    SELECT
      funcao,
      SUM(valor_empenhado) AS total
    FROM fato_emendas_parlamentares
    WHERE funcao IS NOT NULL AND valor_empenhado > 0
    GROUP BY funcao
  ),
  funcao_stats AS (
    SELECT
      COUNT(*) AS total_funcoes,
      SUM(total) AS valor_total,
      (SELECT SUM(total) FROM (
        SELECT total FROM funcao_totals ORDER BY total DESC LIMIT 3
      ) t) AS top3_valor
    FROM funcao_totals
  )
  SELECT json_build_object(
    'autor', json_build_object(
      'total_autores', (SELECT total_autores FROM autor_stats),
      'top10_share', CASE
        WHEN (SELECT valor_total FROM autor_stats) > 0
        THEN ROUND(((SELECT top10_valor FROM autor_stats) / (SELECT valor_total FROM autor_stats) * 100)::numeric, 1)
        ELSE 0
      END,
      'top50_share', CASE
        WHEN (SELECT valor_total FROM autor_stats) > 0
        THEN ROUND(((SELECT top50_valor FROM autor_stats) / (SELECT valor_total FROM autor_stats) * 100)::numeric, 1)
        ELSE 0
      END
    ),
    'territorio', json_build_object(
      'total_ufs', (SELECT total_ufs FROM uf_stats),
      'top5_share', CASE
        WHEN (SELECT valor_total FROM uf_stats) > 0
        THEN ROUND(((SELECT top5_valor FROM uf_stats) / (SELECT valor_total FROM uf_stats) * 100)::numeric, 1)
        ELSE 0
      END
    ),
    'tema', json_build_object(
      'total_funcoes', (SELECT total_funcoes FROM funcao_stats),
      'top3_share', CASE
        WHEN (SELECT valor_total FROM funcao_stats) > 0
        THEN ROUND(((SELECT top3_valor FROM funcao_stats) / (SELECT valor_total FROM funcao_stats) * 100)::numeric, 1)
        ELSE 0
      END
    )
  );
$$ LANGUAGE sql STABLE;
