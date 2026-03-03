import { createClient } from '@supabase/supabase-js';
import { readFileSync } from 'fs';
import dotenv from 'dotenv';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
dotenv.config({ path: join(__dirname, '../../.env') });

const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_KEY);

// Cache stats
const cache = JSON.parse(readFileSync(join(__dirname, '.cep_cache.json'), 'utf8'));
const totalCeps = Object.keys(cache).length;
const found = Object.values(cache).filter(v => v !== null).length;
console.log('=== CACHE CEP ===');
console.log('Total CEPs:', totalCeps);
console.log('Resolvidos:', found, '(' + ((found / totalCeps) * 100).toFixed(1) + '%)');

// Amostra preenchidas
const { data: preenchidas } = await supabase
  .from('dim_empresas')
  .select('cnpj, codigo_ibge, codigo_ibge_uf, latitude, longitude')
  .not('codigo_ibge', 'is', null)
  .limit(5);

console.log('\n=== AMOSTRA PREENCHIDAS ===');
for (const e of preenchidas || []) {
  console.log(` ${e.cnpj} -> ibge:${e.codigo_ibge} uf:${e.codigo_ibge_uf} lat:${e.latitude} lng:${e.longitude}`);
}

// Amostra ainda sem ibge
const { data: semIbge } = await supabase
  .from('dim_empresas')
  .select('cnpj, cep')
  .is('codigo_ibge', null)
  .limit(10);

console.log('\n=== AINDA SEM IBGE ===');
console.log('Amostra:', (semIbge || []).length, 'registros');
for (const e of (semIbge || []).slice(0, 5)) {
  console.log(` ${e.cnpj} cep:${e.cep}`);
}

if (!semIbge || semIbge.length === 0) {
  console.log('\n*** TODAS AS EMPRESAS TEM CODIGO_IBGE PREENCHIDO! ***');
}
