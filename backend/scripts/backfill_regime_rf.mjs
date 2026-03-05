/**
 * Backfill Regime Tributario from Receita Federal — Simples.zip
 *
 * Source: https://dados.rfb.gov.br/CNPJ/dados_abertos_cnpj/Simples.zip
 *
 * CSV format (;-delimited, Latin-1):
 *   CNPJ_BASICO;OPCAO_SIMPLES;DATA_OPCAO_SIMPLES;DATA_EXCLUSAO_SIMPLES;OPCAO_MEI;DATA_OPCAO_MEI;DATA_EXCLUSAO_MEI
 *
 * Phases:
 *   1. Download Simples.zip (~700MB)
 *   2. Extract CSV
 *   3. Stream-parse CSV, match against approved empresas (fast) or ALL (slow)
 *   4. Upsert into fato_regime_tributario
 *
 * Usage:
 *   node scripts/backfill_regime_rf.mjs                       # Approved companies only (~5k, minutes)
 *   node scripts/backfill_regime_rf.mjs --full                # ALL 64M empresas (hours)
 *   node scripts/backfill_regime_rf.mjs --dry-run             # Preview without writing
 *   node scripts/backfill_regime_rf.mjs --skip-download       # Reuse previously downloaded file
 *   node scripts/backfill_regime_rf.mjs --csv=/path/file.csv  # Use specific CSV file
 */

import { createClient } from '@supabase/supabase-js';
import dotenv from 'dotenv';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';
import { createReadStream, existsSync, mkdirSync, statSync } from 'fs';
import { createInterface } from 'readline';
import { execSync } from 'child_process';
import { pipeline } from 'stream/promises';
import { createWriteStream } from 'fs';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
dotenv.config({ path: join(__dirname, '../../.env') });

// ============================================================
// CONFIG
// ============================================================

const DRY_RUN = process.argv.includes('--dry-run');
const FULL_MODE = process.argv.includes('--full');
const SKIP_DOWNLOAD = process.argv.includes('--skip-download');
const CSV_ARG = process.argv.find(a => a.startsWith('--csv='));
const DATA_DIR = join(__dirname, '../../data/rf_downloads');
const ZIP_PATH = join(DATA_DIR, 'Simples.zip');
const BATCH_SIZE = 200; // rows per upsert

// Download sources in priority order (fastest/most reliable first)
const DOWNLOAD_SOURCES = [
  {
    name: 'GitHub Mirror (Sep 2024)',
    url: 'https://github.com/jonathands/dados-abertos-receita-cnpj/releases/download/2024.09/Simples.zip',
  },
  {
    name: 'Receita Federal (official)',
    url: 'https://dados.rfb.gov.br/CNPJ/dados_abertos_cnpj/Simples.zip',
  },
  {
    name: 'Receita Federal (new URL)',
    url: 'https://arquivos.receitafederal.gov.br/dados/cnpj/dados_abertos_cnpj/Simples.zip',
  },
];

const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_KEY);

// ============================================================
// HELPERS
// ============================================================

function log(msg, data = {}) {
  const ts = new Date().toISOString().slice(11, 19);
  const extra = Object.keys(data).length
    ? ' ' + Object.entries(data).map(([k, v]) => `${k}=${v}`).join(' ')
    : '';
  console.log(`[${ts}] ${msg}${extra}`);
}

function formatDate(raw) {
  // YYYYMMDD → YYYY-MM-DD or null
  if (!raw || raw === '0' || raw === '00000000' || raw.length < 8) return null;
  const y = raw.slice(0, 4);
  const m = raw.slice(4, 6);
  const d = raw.slice(6, 8);
  if (y === '0000') return null;
  return `${y}-${m}-${d}`;
}

function inferRegime(row) {
  // row: { simples, dataSimples, dataExclusaoSimples, mei, dataMei, dataExclusaoMei }
  const meiAtivo = row.mei === 'S' && !row.dataExclusaoMei;
  const simplesAtivo = row.simples === 'S' && !row.dataExclusaoSimples;

  if (meiAtivo) return 'MEI';
  if (simplesAtivo) return 'SIMPLES_NACIONAL';

  // Had Simples/MEI but was excluded → likely migrated to Lucro Presumido
  if (row.simples === 'S' || row.mei === 'S') return 'LUCRO_PRESUMIDO';

  // Never opted → can't distinguish Presumido vs Real; default Presumido
  return 'LUCRO_PRESUMIDO';
}

// ============================================================
// PHASE 1: DOWNLOAD
// ============================================================

async function downloadSimples() {
  mkdirSync(DATA_DIR, { recursive: true });

  if (existsSync(ZIP_PATH) && SKIP_DOWNLOAD) {
    const size = statSync(ZIP_PATH).size;
    log('Reusing existing download', { path: ZIP_PATH, sizeMB: (size / 1024 / 1024).toFixed(0) });
    return ZIP_PATH;
  }

  // Try each source until one works
  for (const source of DOWNLOAD_SOURCES) {
    log(`Trying: ${source.name}`, { url: source.url });

    try {
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), 30000); // 30s connect timeout

      const response = await fetch(source.url, {
        signal: controller.signal,
        redirect: 'follow',
      });
      clearTimeout(timeout);

      if (!response.ok) {
        log(`  Failed: HTTP ${response.status}`, { source: source.name });
        continue;
      }

      const contentType = response.headers.get('content-type') || '';
      if (contentType.includes('text/html')) {
        log(`  Skipped: returned HTML page, not a ZIP`, { source: source.name });
        continue;
      }

      const totalBytes = parseInt(response.headers.get('content-length') || '0');
      log(`  Connected! Downloading...`, { sizeMB: (totalBytes / 1024 / 1024).toFixed(0) || '?' });

      const fileStream = createWriteStream(ZIP_PATH);
      const reader = response.body.getReader();
      let downloaded = 0;
      let lastLog = 0;

      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        fileStream.write(Buffer.from(value));
        downloaded += value.length;

        if (downloaded - lastLog > 25 * 1024 * 1024) {
          const pct = totalBytes ? ((downloaded / totalBytes) * 100).toFixed(1) : '?';
          log('  Progress', { MB: (downloaded / 1024 / 1024).toFixed(0), pct: pct + '%' });
          lastLog = downloaded;
        }
      }

      fileStream.end();

      if (downloaded < 1024 * 1024) {
        log(`  File too small (${downloaded} bytes), likely not the real ZIP`, { source: source.name });
        continue;
      }

      log(`Download complete from ${source.name}`, { sizeMB: (downloaded / 1024 / 1024).toFixed(0) });
      return ZIP_PATH;

    } catch (err) {
      const msg = err.name === 'AbortError' ? 'Connection timeout (30s)' : err.message;
      log(`  Failed: ${msg}`, { source: source.name });
      continue;
    }
  }

  throw new Error('All download sources failed. Use --csv= to provide the file manually.');
}

// ============================================================
// PHASE 2: EXTRACT
// ============================================================

function extractZip(zipPath) {
  const extractDir = join(DATA_DIR, 'simples_extracted');
  mkdirSync(extractDir, { recursive: true });

  // Find CSV file if already extracted (name may not end in .csv)
  try {
    const existing = execSync(`ls "${extractDir}" 2>/dev/null || true`, { encoding: 'utf-8' }).trim();
    if (existing) {
      const found = existing.split('\n').find(f => f.toUpperCase().includes('SIMPLES') || f.toUpperCase().includes('K03200'));
      if (found) {
        const csvFile = join(extractDir, found);
        log('Reusing extracted CSV', { path: csvFile });
        return csvFile;
      }
    }
  } catch (e) { /* no files yet */ }

  log('Extracting ZIP (using python3 for ZIP64 support)...');
  execSync(`python3 -c "import zipfile; zipfile.ZipFile('${zipPath}').extractall('${extractDir}')"`, { stdio: 'pipe', timeout: 600000 });

  // Find the extracted CSV (name varies: could be Simples.csv, F.K03200$W.SIMPLES.CSV.D41210, etc)
  const output = execSync(`ls "${extractDir}"`, { encoding: 'utf-8' }).trim();
  const csvFiles = output.split('\n').filter(f =>
    f.toLowerCase().endsWith('.csv') ||
    f.toUpperCase().includes('SIMPLES') ||
    f.toUpperCase().includes('K03200')
  );

  if (csvFiles.length === 0) {
    // Just use the first file in the directory
    const allFiles = output.split('\n').filter(f => f.length > 0);
    if (allFiles.length === 0) throw new Error('No files found after extraction');
    const csvPath = join(extractDir, allFiles[0]);
    log('Using extracted file', { file: allFiles[0] });
    return csvPath;
  }

  const csvPath = join(extractDir, csvFiles[0]);
  log('Extracted CSV', { file: csvFiles[0] });
  return csvPath;
}

// ============================================================
// PHASE 3: LOAD APPROVED EMPRESA CNPJs
// ============================================================

async function loadApprovedCnpjBases() {
  log('Loading approved empresa CNPJs...');
  const cnpjBases = new Set();
  const cnpjBaseToEmpresaId = new Map();
  let page = 0;

  while (true) {
    const from = page * 1000;
    const { data, error } = await supabase
      .from('fato_transacao_empresas')
      .select('empresa_id, dim_empresas!inner(id, cnpj)')
      .range(from, from + 999);

    if (error) { log('ERROR loading approved', { error: error.message }); break; }
    if (!data || data.length === 0) break;

    for (const row of data) {
      const cnpj = row.dim_empresas?.cnpj;
      if (!cnpj || cnpj.length < 8) continue;
      const base = cnpj.slice(0, 8);
      cnpjBases.add(base);
      // Map base → empresa_id (take the first match if multiple establishments)
      if (!cnpjBaseToEmpresaId.has(base)) {
        cnpjBaseToEmpresaId.set(base, row.dim_empresas.id);
      }
    }

    if (data.length < 1000) break;
    page++;
  }

  log('Approved CNPJs loaded', { unique_bases: cnpjBases.size, total_empresas: cnpjBaseToEmpresaId.size });
  return { cnpjBases, cnpjBaseToEmpresaId };
}

// ============================================================
// PHASE 3b: LOAD EXISTING REGIME RECORDS
// ============================================================

async function loadExistingRegime() {
  log('Loading existing fato_regime_tributario records...');
  const existing = new Set();

  const { data, error } = await supabase
    .from('fato_regime_tributario')
    .select('empresa_id')
    .eq('ativo', true)
    .limit(50000);

  if (error) { log('ERROR loading regime', { error: error.message }); return existing; }
  for (const r of data || []) existing.add(r.empresa_id);

  log('Existing regime records', { count: existing.size });
  return existing;
}

// ============================================================
// PHASE 3c: LOAD raw_cnae LOOKUP
// ============================================================

async function loadCnaeLookup() {
  log('Loading CNAE lookup table...');
  const cnaeLookup = new Map(); // codigo_numerico → id

  let page = 0;
  while (true) {
    const from = page * 1000;
    const { data, error } = await supabase
      .from('raw_cnae')
      .select('id, codigo, codigo_numerico')
      .range(from, from + 999);

    if (error || !data || data.length === 0) break;
    for (const r of data) {
      if (r.codigo_numerico) cnaeLookup.set(r.codigo_numerico, r.id);
      if (r.codigo) cnaeLookup.set(r.codigo, r.id);
    }
    if (data.length < 1000) break;
    page++;
  }

  log('CNAE lookup loaded', { entries: cnaeLookup.size });
  return cnaeLookup;
}

// ============================================================
// PHASE 4: PARSE CSV + MATCH + UPSERT
// ============================================================

async function parseCsvAndUpsert(csvPath, cnpjBaseToEmpresaId, existingRegime) {
  log('Parsing Simples CSV...', { path: csvPath, mode: FULL_MODE ? 'FULL' : 'APPROVED_ONLY' });

  const fileStream = createReadStream(csvPath, { encoding: 'latin1' });
  const rl = createInterface({ input: fileStream, crlfDelay: Infinity });

  let lineNumber = 0;
  let matched = 0;
  let skippedExisting = 0;
  let skippedNoMatch = 0;
  let inserted = 0;
  let errors = 0;
  let batch = [];
  const startTime = Date.now();

  for await (const line of rl) {
    lineNumber++;

    // Skip header if present
    if (lineNumber === 1 && (line.includes('CNPJ') || line.includes('cnpj'))) {
      log('Skipping header row');
      continue;
    }

    // Parse: CNPJ_BASICO;OPCAO_SIMPLES;DATA_OPCAO;DATA_EXCLUSAO;OPCAO_MEI;DATA_OPCAO_MEI;DATA_EXCLUSAO_MEI
    const cols = line.split(';');
    if (cols.length < 5) continue;

    const strip = s => (s || '').trim().replace(/^"|"$/g, '');
    const cnpjBase = strip(cols[0]).padStart(8, '0');
    const simples = strip(cols[1]).toUpperCase();
    const dataSimples = formatDate(strip(cols[2]));
    const dataExclusaoSimples = formatDate(strip(cols[3]));
    const mei = strip(cols[4]).toUpperCase();
    const dataMei = formatDate(strip(cols[5]));
    const dataExclusaoMei = formatDate(strip(cols[6]));

    // Match against target set
    let empresaId;
    if (FULL_MODE) {
      // In full mode, we'll need to resolve cnpjBase → empresa_id later
      // For now, only process if we have the mapping
      empresaId = cnpjBaseToEmpresaId.get(cnpjBase);
      if (!empresaId) {
        skippedNoMatch++;
        continue;
      }
    } else {
      // Approved-only mode
      empresaId = cnpjBaseToEmpresaId.get(cnpjBase);
      if (!empresaId) {
        skippedNoMatch++;
        continue;
      }
    }

    // Skip if already has regime
    if (existingRegime.has(empresaId)) {
      skippedExisting++;
      continue;
    }

    matched++;

    const row = { simples, dataSimples, dataExclusaoSimples, mei, dataMei, dataExclusaoMei };
    const regime = inferRegime(row);

    batch.push({
      empresa_id: empresaId,
      regime_tributario: regime,
      simples_optante: simples === 'S',
      simples_desde: dataSimples,
      mei_optante: mei === 'S',
      mei_desde: dataMei,
      data_inicio: dataSimples || dataMei || null,
      data_fim: null,
      ativo: true,
      motivo_exclusao: dataExclusaoSimples ? 'Exclusao Simples: ' + dataExclusaoSimples : (dataExclusaoMei ? 'Exclusao MEI: ' + dataExclusaoMei : null),
    });

    // Flush batch
    if (batch.length >= BATCH_SIZE) {
      if (!DRY_RUN) {
        const result = await upsertBatch(batch);
        inserted += result.ok;
        errors += result.err;
      } else {
        inserted += batch.length;
      }
      batch = [];
    }

    // Progress every 500k lines
    if (lineNumber % 500000 === 0) {
      const elapsed = ((Date.now() - startTime) / 1000).toFixed(0);
      log('Progress', {
        lines: lineNumber.toLocaleString(),
        matched,
        inserted,
        skippedExisting,
        skippedNoMatch: skippedNoMatch.toLocaleString(),
        errors,
        elapsed: elapsed + 's'
      });
    }
  }

  // Final batch
  if (batch.length > 0) {
    if (!DRY_RUN) {
      const result = await upsertBatch(batch);
      inserted += result.ok;
      errors += result.err;
    } else {
      inserted += batch.length;
    }
  }

  const elapsed = ((Date.now() - startTime) / 1000).toFixed(0);
  log('=== PARSE COMPLETE ===', {
    totalLines: lineNumber.toLocaleString(),
    matched,
    inserted,
    skippedExisting,
    skippedNoMatch: skippedNoMatch.toLocaleString(),
    errors,
    elapsed: elapsed + 's'
  });

  return { lineNumber, matched, inserted, errors, skippedExisting };
}

// ============================================================
// UPSERT BATCH
// ============================================================

async function upsertBatch(batch) {
  let ok = 0;
  let err = 0;

  // Supabase upsert — use empresa_id + ativo as conflict key
  // Since there's no unique constraint on (empresa_id, ativo), we insert and handle dupes
  const { data, error } = await supabase
    .from('fato_regime_tributario')
    .insert(batch)
    .select('id');

  if (error) {
    // Try one by one to identify problematic rows
    for (const row of batch) {
      const { error: singleErr } = await supabase
        .from('fato_regime_tributario')
        .insert([row]);

      if (singleErr) {
        err++;
        if (err <= 5) log('Insert error', { empresa_id: row.empresa_id, error: singleErr.message });
      } else {
        ok++;
      }
    }
  } else {
    ok = batch.length;
  }

  return { ok, err };
}

// ============================================================
// FULL MODE: LOAD ALL dim_empresas CNPJs
// ============================================================

async function loadAllCnpjBases() {
  log('Loading ALL dim_empresas CNPJs (this may take a while for 64M rows)...');
  const cnpjBaseToEmpresaId = new Map();
  let page = 0;
  let total = 0;
  const startTime = Date.now();

  while (true) {
    const from = page * 1000;
    const { data, error } = await supabase
      .from('dim_empresas')
      .select('id, cnpj')
      .not('cnpj', 'is', null)
      .range(from, from + 999);

    if (error) {
      // Timeout on 64M rows is expected at some point
      log('Query error (may be timeout)', { page, error: error.message });
      break;
    }
    if (!data || data.length === 0) break;

    for (const row of data) {
      if (!row.cnpj || row.cnpj.length < 8) continue;
      const base = row.cnpj.slice(0, 8);
      if (!cnpjBaseToEmpresaId.has(base)) {
        cnpjBaseToEmpresaId.set(base, row.id);
      }
    }

    total += data.length;
    if (data.length < 1000) break;
    page++;

    if (page % 1000 === 0) {
      const elapsed = ((Date.now() - startTime) / 1000).toFixed(0);
      log('Loading empresas', { pages: page, total: total.toLocaleString(), mapSize: cnpjBaseToEmpresaId.size.toLocaleString(), elapsed: elapsed + 's' });
    }
  }

  const elapsed = ((Date.now() - startTime) / 1000).toFixed(0);
  log('All CNPJs loaded', { total: total.toLocaleString(), uniqueBases: cnpjBaseToEmpresaId.size.toLocaleString(), elapsed: elapsed + 's' });
  return cnpjBaseToEmpresaId;
}

// ============================================================
// MAIN
// ============================================================

async function main() {
  console.log('='.repeat(60));
  console.log(' BACKFILL REGIME TRIBUTARIO — Receita Federal Simples.zip');
  console.log('='.repeat(60));
  log('Config', {
    mode: FULL_MODE ? 'FULL (all 64M)' : 'APPROVED_ONLY (~5k)',
    dryRun: DRY_RUN,
    skipDownload: SKIP_DOWNLOAD,
  });

  // Step 1: Get CSV path
  let csvPath;
  if (CSV_ARG) {
    csvPath = CSV_ARG.split('=')[1];
    if (!existsSync(csvPath)) throw new Error(`CSV file not found: ${csvPath}`);
    log('Using provided CSV', { path: csvPath });
  } else {
    // Download + Extract
    const zipPath = await downloadSimples();
    csvPath = extractZip(zipPath);
  }

  const csvSize = statSync(csvPath).size;
  log('CSV file ready', { sizeMB: (csvSize / 1024 / 1024).toFixed(0) });

  // Step 2: Load target CNPJs
  let cnpjBaseToEmpresaId;
  if (FULL_MODE) {
    cnpjBaseToEmpresaId = await loadAllCnpjBases();
  } else {
    const result = await loadApprovedCnpjBases();
    cnpjBaseToEmpresaId = result.cnpjBaseToEmpresaId;
  }

  if (cnpjBaseToEmpresaId.size === 0) {
    log('ERROR: No target CNPJs found. Aborting.');
    process.exit(1);
  }

  // Step 3: Load existing regime records (to skip)
  const existingRegime = await loadExistingRegime();

  // Step 4: Parse CSV and upsert
  const result = await parseCsvAndUpsert(csvPath, cnpjBaseToEmpresaId, existingRegime);

  // Summary
  console.log('\n' + '='.repeat(60));
  console.log(' SUMMARY');
  console.log('='.repeat(60));
  console.log(`  Mode:             ${FULL_MODE ? 'FULL' : 'APPROVED_ONLY'}`);
  console.log(`  Dry Run:          ${DRY_RUN}`);
  console.log(`  CSV Lines:        ${result.lineNumber.toLocaleString()}`);
  console.log(`  Target empresas:  ${cnpjBaseToEmpresaId.size.toLocaleString()}`);
  console.log(`  Matched:          ${result.matched.toLocaleString()}`);
  console.log(`  Inserted:         ${result.inserted.toLocaleString()}`);
  console.log(`  Skipped existing: ${result.skippedExisting}`);
  console.log(`  Errors:           ${result.errors}`);
  console.log('='.repeat(60));

  if (DRY_RUN) {
    console.log('\n  ** DRY RUN — no data was written. Remove --dry-run to execute. **\n');
  }
}

main().catch(err => {
  console.error('FATAL:', err.message);
  process.exit(1);
});
