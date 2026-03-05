/**
 * GUIA DE OTIMIZACAO: Backend Queries para dim_empresas (64M+)
 *
 * Este arquivo documenta as mudancas necessarias no backend
 * apos aplicar optimize_dim_empresas.sql no Supabase SQL Editor.
 *
 * NAO EXECUTAR DIRETAMENTE. Usar como referencia para editar os arquivos.
 */

// =============================================
// 1. hybrid-search.js → textSearch()
// ANTES: ILIKE direto via PostgREST (seq scan em 64M rows)
// DEPOIS: RPC function search_empresas (usa GIN trigram index)
// =============================================

// ANTES (hybrid-search.js:30-53):
/*
let dbQuery = supabase
  .from('dim_empresas')
  .select('id, cnpj, razao_social, nome_fantasia, cidade, estado, descricao')
  .or(`nome_fantasia.ilike.%${cleanQuery}%,razao_social.ilike.%${cleanQuery}%,descricao.ilike.%${cleanQuery}%`)
  .limit(limit);
*/

// DEPOIS:
/*
const { data, error } = await supabase.rpc('search_empresas', {
  p_query: cleanQuery,
  p_cidade: filters.cidade || null,
  p_estado: filters.estado || null,
  p_limit: limit
});
*/


// =============================================
// 2. search-orchestrator.js → estimateCompanyCardinality()
// ANTES: COUNT(exact) com ILIKE → TIMEOUT 8s+
// DEPOIS: RPC count_empresas_estimate (max 10K, nunca timeout)
// =============================================

// ANTES (search-orchestrator.js:375-405):
/*
let query = supabase
  .from('dim_empresas')
  .select('id', { count: 'exact', head: true })
  .or(`razao_social.ilike.%${escapedName}%,nome_fantasia.ilike.%${escapedName}%`);
const { count } = await query;
*/

// DEPOIS:
/*
const { data: countResult, error } = await supabase.rpc('count_empresas_estimate', {
  p_query: searchName,
  p_cidade: cidade || null,
  p_estado: null
});
const dbCount = countResult || 0;
*/


// =============================================
// 3. hybrid-search.js → relationalSearch()
// ANTES: ILIKE para encontrar seeds (seq scan)
// DEPOIS: RPC search_empresas para seeds
// =============================================

// ANTES (hybrid-search.js:140-147):
/*
const { data: seeds } = await supabase
  .from('dim_empresas')
  .select('id')
  .or(`nome_fantasia.ilike.%${cleanQuery}%,razao_social.ilike.%${cleanQuery}%`)
  .limit(5);
*/

// DEPOIS:
/*
const { data: seeds } = await supabase.rpc('search_empresas', {
  p_query: cleanQuery,
  p_limit: 5
});
*/


// =============================================
// 4. supabase.js → listCompanies()
// NOTA: O cache in-memory atual funciona bem para ~5K approved companies.
// NAO precisa mudar. Mas se quiser buscar diretamente no DB:
// =============================================

// ALTERNATIVA (sem cache, usando search_empresas):
/*
const { data, error } = await supabase.rpc('search_empresas', {
  p_query: nome || '',
  p_cidade: cidade || null,
  p_estado: null,
  p_limit: limit
});
*/


// =============================================
// 5. PAGINACAO: Substituir OFFSET por Keyset
// Qualquer endpoint que use .range(from, to) em dim_empresas
// =============================================

// ANTES:
/*
const { data } = await supabase
  .from('dim_empresas')
  .select('*')
  .order('created_at', { ascending: false })
  .range(offset, offset + limit - 1);  // OFFSET 1000000 = LENTO
*/

// DEPOIS (keyset pagination):
/*
const { data } = await supabase.rpc('paginate_empresas', {
  p_last_created_at: lastCreatedAt || null,
  p_last_id: lastId || null,
  p_estado: estado || null,
  p_situacao: situacao || null,
  p_limit: limit
});

// Frontend guarda o ultimo created_at e id para a proxima pagina
const lastItem = data[data.length - 1];
// nextPage: p_last_created_at = lastItem.created_at, p_last_id = lastItem.id
*/


// =============================================
// 6. SELECT * → SELECT especifico
// NUNCA usar .select('*') em dim_empresas com 64M rows
// =============================================

// ANTES:
/*
.select('*')  // Puxa TODOS os campos incluindo raw_cnpj_data (JSONB grande)
*/

// DEPOIS:
/*
.select('id, cnpj, razao_social, nome_fantasia, cidade, estado, situacao_cadastral')
*/
