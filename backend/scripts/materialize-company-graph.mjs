#!/usr/bin/env node

import 'dotenv/config';

import { supabase } from '../src/database/supabase.js';
import { searchCompaniesByName } from '../src/services/company-search.js';
import {
  ensureCompanyGraphMaterialized,
  getCompanyGraphContext,
  getCompanyGraphCoverage,
  evaluateCompanyGraphCoverage,
} from '../src/services/graph-materialization.js';

function parseArgs(argv) {
  const args = {
    companyId: null,
    query: null,
    all: false,
    limit: 25,
    offset: 0,
    force: false,
    auditOnly: false,
  };

  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '--company-id') args.companyId = argv[++i] || null;
    else if (arg === '--query') args.query = argv[++i] || null;
    else if (arg === '--all') args.all = true;
    else if (arg === '--limit') args.limit = Number(argv[++i] || 25);
    else if (arg === '--offset') args.offset = Number(argv[++i] || 0);
    else if (arg === '--force') args.force = true;
    else if (arg === '--audit-only') args.auditOnly = true;
  }

  return args;
}

async function resolveCompanyIds(args) {
  if (args.companyId) {
    return [String(args.companyId)];
  }

  if (args.query) {
    const companies = await searchCompaniesByName({ query: args.query, limit: Math.max(args.limit, 10) });
    return companies.map((company) => String(company.id));
  }

  if (args.all) {
    const { data, error } = await supabase
      .from('dim_empresas')
      .select('id')
      .order('created_at', { ascending: true })
      .range(args.offset, args.offset + Math.max(args.limit, 1) - 1);

    if (error) {
      throw new Error(`Failed to list companies: ${error.message}`);
    }

    return (data || []).map((row) => String(row.id));
  }

  throw new Error('Use --company-id, --query or --all');
}

async function auditCompany(empresaId) {
  const context = await getCompanyGraphContext(empresaId);
  if (!context) {
    return { empresa_id: String(empresaId), found: false };
  }

  const coverage = await getCompanyGraphCoverage(empresaId);
  const evaluation = evaluateCompanyGraphCoverage(context, coverage);

  return {
    empresa_id: String(empresaId),
    found: true,
    empresa: {
      nome: context.nome,
      cnpj: context.empresa.cnpj,
      cidade: context.cidade,
      estado: context.estado,
      cnae_principal: context.cnae_principal,
    },
    source_context: {
      socios: context.socios.length,
    },
    coverage,
    evaluation,
  };
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const companyIds = await resolveCompanyIds(args);

  const results = [];
  for (const empresaId of companyIds) {
    if (args.auditOnly) {
      results.push(await auditCompany(empresaId));
      continue;
    }

    results.push(await ensureCompanyGraphMaterialized(empresaId, { force: args.force }));
  }

  console.log(JSON.stringify({
    success: true,
    total: results.length,
    force: args.force,
    audit_only: args.auditOnly,
    results,
  }, null, 2));
}

main().catch((error) => {
  console.error(JSON.stringify({
    success: false,
    error: error.message,
  }, null, 2));
  process.exit(1);
});
