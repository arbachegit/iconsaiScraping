#!/usr/bin/env node
/**
 * Bulk Association Populator
 *
 * Crosses noticias (scraping DB) with emendas (brasil-data-hub)
 * via shared taxonomy. Creates associations in fato_associacoes_contextuais.
 *
 * Usage: node backend/scripts/populate-associations-bulk.mjs
 */

import { createClient } from '@supabase/supabase-js';
import dotenv from 'dotenv';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
dotenv.config({ path: join(__dirname, '../../.env') });

const scraping = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_KEY);
const brasilHub = createClient(process.env.BRASIL_DATA_HUB_URL, process.env.BRASIL_DATA_HUB_KEY);

const EMENDAS_PER_SLUG = 20;
const NOTICIAS_BATCH = 5000;

async function main() {
  console.log('=== Bulk Association Populator ===');

  // 1. Load taxonomy mappings
  const [temaRes, funcaoRes] = await Promise.all([
    scraping.from('map_tema_taxonomia').select('tema_principal, taxonomia_slug'),
    scraping.from('map_funcao_taxonomia').select('funcao, taxonomia_slug'),
  ]);

  const temaToSlug = new Map();
  for (const r of temaRes.data || []) temaToSlug.set(r.tema_principal, r.taxonomia_slug);

  const funcaoToSlug = new Map();
  for (const r of funcaoRes.data || []) funcaoToSlug.set(r.funcao, r.taxonomia_slug);

  console.log(`Taxonomy: ${temaToSlug.size} temas, ${funcaoToSlug.size} funcoes`);

  // 2. For each taxonomy slug, get sample emendas from brasil-data-hub
  const slugs = [...new Set([...temaToSlug.values()])];
  const emendasBySlug = new Map();

  for (const slug of slugs) {
    // Find funcoes that map to this slug
    const matchingFuncoes = [];
    for (const [funcao, s] of funcaoToSlug) {
      if (s === slug) matchingFuncoes.push(funcao);
    }

    if (matchingFuncoes.length === 0) {
      console.log(`  ${slug}: no funcao mapping, skipping`);
      continue;
    }

    const { data, error } = await brasilHub
      .from('fato_emendas_parlamentares')
      .select('id, autor, funcao, localidade, ano')
      .in('funcao', matchingFuncoes)
      .order('ano', { ascending: false })
      .limit(EMENDAS_PER_SLUG);

    if (error) {
      console.error(`  ${slug}: error fetching emendas:`, error.message);
      continue;
    }

    emendasBySlug.set(slug, data || []);
    console.log(`  ${slug}: ${(data || []).length} emendas loaded`);
  }

  // 3. Count existing associations to avoid re-processing
  const { count: existingCount } = await scraping
    .from('fato_associacoes_contextuais')
    .select('id', { count: 'exact', head: true })
    .eq('origem_tipo', 'noticia');

  console.log(`\nExisting associations: ${existingCount}`);

  // 4. Process noticias in batches
  let offset = 0;
  let totalCreated = 0;
  let totalProcessed = 0;
  let batchNum = 0;

  while (true) {
    batchNum++;
    const { data: noticias, error: fetchErr } = await scraping
      .from('dim_noticias')
      .select('id, tema_principal, data_publicacao')
      .not('tema_principal', 'is', null)
      .neq('tema_principal', 'geral') // Skip geral — too broad for associations
      .order('data_publicacao', { ascending: false })
      .range(offset, offset + NOTICIAS_BATCH - 1);

    if (fetchErr) {
      console.error('Fetch error:', fetchErr.message);
      break;
    }

    if (!noticias || noticias.length === 0) {
      console.log('No more noticias to process');
      break;
    }

    // Check which already have associations
    const noticiaIds = noticias.map(n => n.id);
    const { data: existing } = await scraping
      .from('fato_associacoes_contextuais')
      .select('origem_id')
      .eq('origem_tipo', 'noticia')
      .in('origem_id', noticiaIds);

    const existingSet = new Set((existing || []).map(e => e.origem_id));
    const newNoticias = noticias.filter(n => !existingSet.has(n.id));

    if (newNoticias.length === 0) {
      offset += NOTICIAS_BATCH;
      console.log(`Batch ${batchNum}: all ${noticias.length} already associated, skipping`);
      continue;
    }

    // Build associations
    const associations = [];
    for (const noticia of newNoticias) {
      const slug = temaToSlug.get(noticia.tema_principal);
      if (!slug) continue;

      const emendas = emendasBySlug.get(slug);
      if (!emendas || emendas.length === 0) continue;

      const pubYear = noticia.data_publicacao
        ? new Date(noticia.data_publicacao).getFullYear()
        : null;

      for (const emenda of emendas) {
        let confianca = 0.5; // base: same theme
        if (pubYear && emenda.ano === pubYear) confianca += 0.15;
        else if (pubYear && Math.abs(emenda.ano - pubYear) <= 1) confianca += 0.05;

        associations.push({
          origem_tipo: 'noticia',
          origem_id: noticia.id,
          destino_tipo: 'emenda',
          destino_id: String(emenda.id),
          tipo_associacao: 'tema_comum',
          taxonomia_slug: slug,
          confianca: Math.min(confianca, 1.0),
          metodo: 'regra',
          evidencia: `Tema: ${slug} | ${emenda.autor || 'N/A'} (${emenda.ano})`,
        });
      }
    }

    // Bulk insert in chunks of 1000 (Supabase limit)
    let created = 0;
    for (let i = 0; i < associations.length; i += 1000) {
      const chunk = associations.slice(i, i + 1000);
      const { error: insertErr } = await scraping
        .from('fato_associacoes_contextuais')
        .upsert(chunk, {
          onConflict: 'origem_tipo,origem_id,destino_tipo,destino_id,tipo_associacao',
          ignoreDuplicates: true,
        });

      if (insertErr) {
        console.error(`Insert error at chunk ${i}:`, insertErr.message);
      } else {
        created += chunk.length;
      }
    }

    totalCreated += created;
    totalProcessed += newNoticias.length;
    offset += NOTICIAS_BATCH;

    console.log(`Batch ${batchNum}: ${newNoticias.length} noticias → ${created} associations (total: ${totalCreated})`);

    // Rate limit
    await new Promise(r => setTimeout(r, 200));
  }

  console.log(`\n=== DONE ===`);
  console.log(`Noticias processed: ${totalProcessed}`);
  console.log(`Associations created: ${totalCreated}`);

  // 5. Final stats
  const { count: finalCount } = await scraping
    .from('fato_associacoes_contextuais')
    .select('id', { count: 'exact', head: true });

  console.log(`Total associations in DB: ${finalCount}`);
}

main().catch(console.error);
