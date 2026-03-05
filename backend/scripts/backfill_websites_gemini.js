#!/usr/bin/env node

/**
 * Backfill company websites using Google Gemini
 *
 * Finds companies in dim_empresas with NULL/empty website
 * and attempts to fill them using Gemini AI.
 *
 * Usage:
 *   node scripts/backfill_websites_gemini.js            # execute updates
 *   node scripts/backfill_websites_gemini.js --dry-run   # preview only
 */

import { createClient } from '@supabase/supabase-js';
import { findCompanyWebsite } from '../src/services/gemini.js';
import dotenv from 'dotenv';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
dotenv.config({ path: join(__dirname, '../.env') });

const DRY_RUN = process.argv.includes('--dry-run');
const BATCH_SIZE = 50;
const DELAY_MS = 200; // respect Gemini rate limits

const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_KEY
);

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

async function fetchCompaniesWithoutWebsite(offset, limit) {
  const { data, error } = await supabase
    .from('dim_empresas')
    .select('id, nome_fantasia, razao_social, cidade, estado')
    .or('website.is.null,website.eq.')
    .range(offset, offset + limit - 1);

  if (error) {
    console.error('Error fetching companies:', error.message);
    return [];
  }
  return data || [];
}

async function updateWebsite(id, website) {
  const { error } = await supabase
    .from('dim_empresas')
    .update({ website })
    .eq('id', id);

  if (error) {
    console.error(`Error updating ${id}:`, error.message);
    return false;
  }
  return true;
}

async function main() {
  console.log('=== Backfill Websites via Gemini ===');
  console.log(`Mode: ${DRY_RUN ? 'DRY RUN (no updates)' : 'LIVE (will update DB)'}`);
  console.log('');

  if (!process.env.GEMINI_API_KEY) {
    console.error('GEMINI_API_KEY not set in .env — aborting');
    process.exit(1);
  }

  let offset = 0;
  let totalProcessed = 0;
  let totalFound = 0;
  let totalNotFound = 0;
  let totalErrors = 0;

  while (true) {
    const batch = await fetchCompaniesWithoutWebsite(offset, BATCH_SIZE);
    if (batch.length === 0) break;

    console.log(`\n--- Batch ${Math.floor(offset / BATCH_SIZE) + 1} (${batch.length} companies) ---`);

    for (const company of batch) {
      const name = company.nome_fantasia || company.razao_social;
      if (!name) {
        totalProcessed++;
        continue;
      }

      process.stdout.write(`[${totalProcessed + 1}] ${name.substring(0, 50).padEnd(50)} ... `);

      try {
        const website = await findCompanyWebsite(name, company.cidade, company.estado);

        if (website) {
          totalFound++;
          if (DRY_RUN) {
            console.log(`FOUND: ${website} (dry-run, not saved)`);
          } else {
            const ok = await updateWebsite(company.id, website);
            console.log(ok ? `SAVED: ${website}` : `FOUND but SAVE FAILED: ${website}`);
          }
        } else {
          totalNotFound++;
          console.log('not found');
        }
      } catch (err) {
        totalErrors++;
        console.log(`ERROR: ${err.message}`);
      }

      totalProcessed++;
      await sleep(DELAY_MS);
    }

    offset += BATCH_SIZE;
  }

  console.log('\n=== Summary ===');
  console.log(`Total processed: ${totalProcessed}`);
  console.log(`Websites found:  ${totalFound}`);
  console.log(`Not found:       ${totalNotFound}`);
  console.log(`Errors:          ${totalErrors}`);
  if (DRY_RUN) {
    console.log('\n(Dry run — no changes were saved. Remove --dry-run to apply.)');
  }
}

main().catch(err => {
  console.error('Fatal error:', err);
  process.exit(1);
});
