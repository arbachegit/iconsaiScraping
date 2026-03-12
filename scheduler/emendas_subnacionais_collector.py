"""
Emendas Subnacionais Collector
Coleta emendas estaduais e municipais de portais de transparência.

Phase 1 Sources (original):
  - GO Estado: CKAN DataStore API (dadosabertos.go.gov.br)
  - MG Estado: ALMG CSV (mediaserver.almg.gov.br)
  - RJ Capital: Transparência Prefeitura (XLSX)
  - SP Capital: CKAN ODS (dados.prefeitura.sp.gov.br)

Phase 2 Sources (expanded):
  - Tesouro Transparente: CKAN CSV federal (ALL municipalities)
  - Portal da Transparência: Bulk CSV federal (by year, 2015-2026)
  - BA Estado: Assembleia Legislativa da Bahia (CSV)
  - PR Estado: Assembleia Legislativa do Paraná (CSV)
  - BH Municipal: Portal de Dados Abertos BH (CKAN)

Usage:
  python -m scheduler.emendas_subnacionais_collector --source go_estado
  python -m scheduler.emendas_subnacionais_collector --source all
  python -m scheduler.emendas_subnacionais_collector --source tesouro_transparente
  python -m scheduler.emendas_subnacionais_collector --source go_estado --dry-run
  python -m scheduler.emendas_subnacionais_collector --list-sources
"""

import asyncio
import csv
import hashlib
import io
import json
import re
from datetime import datetime
from typing import Any, Dict, List, Optional

import httpx
import structlog
from supabase import Client, create_client

from config.settings import settings

logger = structlog.get_logger()

# =============================================
# SOURCE DEFINITIONS
# =============================================

SOURCES = {
    'go_estado': {
        'name': 'Goiás Estado - Portal de Dados Abertos',
        'esfera': 'estadual',
        'uf': 'GO',
        'municipio': None,
        'url': 'https://dadosabertos.go.gov.br/api/3/action/datastore_search',
        'resource_id': 'da303bdf-8c77-4368-a5c6-ffb6dba4a364',
        'format': 'ckan_json',
    },
    'mg_estado': {
        'name': 'Minas Gerais Estado - ALMG',
        'esfera': 'estadual',
        'uf': 'MG',
        'municipio': None,
        'url': 'https://mediaserver.almg.gov.br/acervo/497/469/2497469.csv',
        'format': 'csv',
    },
    'rj_capital': {
        'name': 'Rio de Janeiro Capital - Transparência',
        'esfera': 'municipal',
        'uf': 'RJ',
        'municipio': 'Rio de Janeiro',
        'codigo_ibge': '3304557',
        'url': 'https://transparencia.prefeitura.rio/wp-content/uploads/sites/100/2023/07/Emendas-Pix-2025-3.xlsx',
        'format': 'xlsx',
    },
    'sp_capital': {
        'name': 'São Paulo Capital - Portal de Dados Abertos',
        'esfera': 'municipal',
        'uf': 'SP',
        'municipio': 'São Paulo',
        'codigo_ibge': '3550308',
        'url': 'https://dados.prefeitura.sp.gov.br/api/3/action/datastore_search',
        'format': 'ckan_json',
        'note': 'Limited to SMADS (social assistance)',
    },
    # =============================================
    # PHASE 2: EXPANDED SOURCES
    # =============================================
    'tesouro_transparente': {
        'name': 'Tesouro Transparente - Emendas Parlamentares (Nacional)',
        'esfera': 'federal',
        'uf': None,  # ALL UFs
        'municipio': None,
        'url': 'https://www.tesourotransparente.gov.br/ckan/dataset/83e419da-1552-46bf-bfc3-05160b2c46c9/resource/66d69917-a5d8-4500-b4b2-ef1f5d062430/download/Emendas-Parlamentares.csv',
        'format': 'csv_tesouro',
    },
    'portal_transparencia_2024': {
        'name': 'Portal da Transparência - Emendas 2024',
        'esfera': 'federal',
        'uf': None,
        'municipio': None,
        'url': 'https://portaldatransparencia.gov.br/download-de-dados/emendas-parlamentares/2024',
        'format': 'csv_portal_transparencia',
        'ano': 2024,
    },
    'portal_transparencia_2025': {
        'name': 'Portal da Transparência - Emendas 2025',
        'esfera': 'federal',
        'uf': None,
        'municipio': None,
        'url': 'https://portaldatransparencia.gov.br/download-de-dados/emendas-parlamentares/2025',
        'format': 'csv_portal_transparencia',
        'ano': 2025,
    },
    'portal_transparencia_2026': {
        'name': 'Portal da Transparência - Emendas 2026',
        'esfera': 'federal',
        'uf': None,
        'municipio': None,
        'url': 'https://portaldatransparencia.gov.br/download-de-dados/emendas-parlamentares/2026',
        'format': 'csv_portal_transparencia',
        'ano': 2026,
    },
    'ba_estado': {
        'name': 'Bahia Estado - Assembleia Legislativa',
        'esfera': 'estadual',
        'uf': 'BA',
        'municipio': None,
        'url': 'https://www.al.ba.gov.br/transparencia/dados-abertos',
        'data_url': 'https://www.al.ba.gov.br/transparencia/emendas-parlamentares/export/csv',
        'format': 'csv_ba',
    },
    'pr_estado': {
        'name': 'Paraná Estado - Assembleia Legislativa',
        'esfera': 'estadual',
        'uf': 'PR',
        'municipio': None,
        'url': 'https://transparencia.alep.pr.gov.br',
        'data_url': 'https://transparencia.alep.pr.gov.br/emendas/export/csv',
        'format': 'csv_pr',
    },
    'bh_municipal': {
        'name': 'Belo Horizonte - Portal de Dados Abertos',
        'esfera': 'municipal',
        'uf': 'MG',
        'municipio': 'Belo Horizonte',
        'codigo_ibge': '3106200',
        'url': 'https://dados.pbh.gov.br/api/3/action/datastore_search',
        'format': 'ckan_json_bh',
    },
}

# Data source registration for compliance (fontes_dados table)
DATA_SOURCE_REGISTRATIONS = {
    'go_estado': {
        'nome': 'Portal de Dados Abertos de Goiás - Emendas Parlamentares',
        'categoria': 'politico',
        'fonte_primaria': 'Assembleia Legislativa de Goiás',
        'url': 'https://dadosabertos.go.gov.br',
        'formato': 'JSON',
        'api_key_necessaria': False,
        'confiabilidade': 'alta',
        'cobertura_temporal': '2019-presente',
        'observacoes': 'CKAN DataStore API - Emendas parlamentares estaduais de Goiás',
    },
    'mg_estado': {
        'nome': 'ALMG - Emendas Parlamentares de Minas Gerais',
        'categoria': 'politico',
        'fonte_primaria': 'Assembleia Legislativa de Minas Gerais',
        'url': 'https://mediaserver.almg.gov.br',
        'formato': 'CSV',
        'api_key_necessaria': False,
        'confiabilidade': 'alta',
        'cobertura_temporal': '2019-presente',
        'observacoes': 'CSV direto do servidor da ALMG - atualização bimestral',
    },
    'rj_capital': {
        'nome': 'Transparência Rio - Emendas Impositivas PIX',
        'categoria': 'politico',
        'fonte_primaria': 'Prefeitura do Rio de Janeiro',
        'url': 'https://transparencia.prefeitura.rio',
        'formato': 'XLSX',
        'api_key_necessaria': False,
        'confiabilidade': 'alta',
        'cobertura_temporal': '2022-presente',
        'observacoes': 'Planilha XLSX com emendas impositivas PIX da Câmara Municipal do Rio',
    },
    'sp_capital': {
        'nome': 'Portal de Dados Abertos SP - Emendas SMADS',
        'categoria': 'politico',
        'fonte_primaria': 'Prefeitura de São Paulo',
        'url': 'https://dados.prefeitura.sp.gov.br',
        'formato': 'ODS/JSON',
        'api_key_necessaria': False,
        'confiabilidade': 'alta',
        'cobertura_temporal': '2021-presente',
        'observacoes': 'CKAN API - Emendas parlamentares da SMADS (assistência social)',
    },
    'tesouro_transparente': {
        'nome': 'Tesouro Transparente - Emendas Parlamentares (Nacional)',
        'categoria': 'politico',
        'fonte_primaria': 'Tesouro Nacional / Secretaria do Tesouro Nacional',
        'url': 'https://www.tesourotransparente.gov.br',
        'formato': 'CSV',
        'api_key_necessaria': False,
        'confiabilidade': 'alta',
        'cobertura_temporal': '2015-presente',
        'observacoes': 'CKAN CSV direto - Emendas parlamentares federais de TODOS os municípios brasileiros. Dados do SIOP/LOA.',
    },
    'portal_transparencia_2024': {
        'nome': 'Portal da Transparência - Emendas Parlamentares (Bulk CSV)',
        'categoria': 'politico',
        'fonte_primaria': 'Controladoria-Geral da União (CGU)',
        'url': 'https://portaldatransparencia.gov.br',
        'formato': 'CSV (ZIP)',
        'api_key_necessaria': False,
        'confiabilidade': 'alta',
        'cobertura_temporal': '2015-presente',
        'observacoes': 'Download em massa por ano - emendas federais com detalhamento de empenhos, liquidações e pagamentos.',
    },
    'portal_transparencia_2025': {
        'nome': 'Portal da Transparência - Emendas 2025',
        'categoria': 'politico',
        'fonte_primaria': 'Controladoria-Geral da União (CGU)',
        'url': 'https://portaldatransparencia.gov.br',
        'formato': 'CSV (ZIP)',
        'api_key_necessaria': False,
        'confiabilidade': 'alta',
        'cobertura_temporal': '2025',
        'observacoes': 'Download em massa 2025 - emendas federais.',
    },
    'portal_transparencia_2026': {
        'nome': 'Portal da Transparência - Emendas 2026',
        'categoria': 'politico',
        'fonte_primaria': 'Controladoria-Geral da União (CGU)',
        'url': 'https://portaldatransparencia.gov.br',
        'formato': 'CSV (ZIP)',
        'api_key_necessaria': False,
        'confiabilidade': 'alta',
        'cobertura_temporal': '2026',
        'observacoes': 'Download em massa 2026 - emendas federais.',
    },
    'ba_estado': {
        'nome': 'Assembleia Legislativa da Bahia - Emendas Parlamentares',
        'categoria': 'politico',
        'fonte_primaria': 'Assembleia Legislativa da Bahia (ALBA)',
        'url': 'https://www.al.ba.gov.br',
        'formato': 'CSV',
        'api_key_necessaria': False,
        'confiabilidade': 'alta',
        'cobertura_temporal': '2019-presente',
        'observacoes': 'Emendas parlamentares estaduais da Bahia - portal de transparência ALBA.',
    },
    'pr_estado': {
        'nome': 'Assembleia Legislativa do Paraná - Emendas Parlamentares',
        'categoria': 'politico',
        'fonte_primaria': 'Assembleia Legislativa do Paraná (ALEP)',
        'url': 'https://transparencia.alep.pr.gov.br',
        'formato': 'CSV',
        'api_key_necessaria': False,
        'confiabilidade': 'alta',
        'cobertura_temporal': '2019-presente',
        'observacoes': 'Emendas parlamentares estaduais do Paraná - portal de transparência ALEP.',
    },
    'bh_municipal': {
        'nome': 'Portal de Dados Abertos BH - Emendas Parlamentares',
        'categoria': 'politico',
        'fonte_primaria': 'Prefeitura de Belo Horizonte',
        'url': 'https://dados.pbh.gov.br',
        'formato': 'JSON',
        'api_key_necessaria': False,
        'confiabilidade': 'alta',
        'cobertura_temporal': '2019-presente',
        'observacoes': 'CKAN API - Emendas parlamentares da Câmara Municipal de Belo Horizonte.',
    },
}


class EmendasSubnacionaisCollector:
    """Collector for subnational parliamentary amendments."""

    def __init__(self):
        self._bdh: Optional[Client] = None
        if settings.has_brasil_data_hub:
            self._bdh = create_client(
                settings.brasil_data_hub_url,
                settings.brasil_data_hub_key,
            )
        self._main_supabase: Optional[Client] = None
        if settings.has_supabase:
            self._main_supabase = create_client(
                settings.supabase_url,
                settings.supabase_service_key,
            )
        self._http = httpx.AsyncClient(
            timeout=60.0,
            headers={
                'User-Agent': 'IconsAI-Collector/1.0 (scraping.iconsai.ai)',
            },
        )
        self._stats = {
            'fetched': 0,
            'inserted': 0,
            'skipped': 0,
            'errors': 0,
        }

    async def close(self):
        await self._http.aclose()

    # =============================================
    # MAIN ENTRY POINTS
    # =============================================

    async def collect_source(self, source_key: str, dry_run: bool = False) -> Dict[str, Any]:
        """Collect emendas from a single source."""
        if source_key not in SOURCES:
            raise ValueError(f"Unknown source: {source_key}. Available: {list(SOURCES.keys())}")

        source = SOURCES[source_key]
        logger.info('collect_source_start', source=source_key, name=source['name'])

        self._stats = {'fetched': 0, 'inserted': 0, 'skipped': 0, 'errors': 0}

        try:
            # Dispatch to appropriate collector
            fmt = source['format']
            if fmt == 'ckan_json':
                records = await self._collect_ckan(source_key, source)
            elif fmt == 'csv':
                records = await self._collect_csv(source_key, source)
            elif fmt == 'xlsx':
                records = await self._collect_xlsx(source_key, source)
            elif fmt == 'csv_tesouro':
                records = await self._collect_csv_tesouro(source_key, source)
            elif fmt == 'csv_portal_transparencia':
                records = await self._collect_portal_transparencia(source_key, source)
            elif fmt == 'csv_ba':
                records = await self._collect_csv_generic(source_key, source, self._normalize_ba)
            elif fmt == 'csv_pr':
                records = await self._collect_csv_generic(source_key, source, self._normalize_pr)
            elif fmt == 'ckan_json_bh':
                records = await self._collect_ckan_bh(source_key, source)
            else:
                raise ValueError(f"Unsupported format: {fmt}")

            self._stats['fetched'] = len(records)
            logger.info('records_fetched', source=source_key, count=len(records))

            if not dry_run and self._bdh and records:
                await self._upsert_records(records)

            # Register data source for compliance
            if not dry_run and self._bdh and source_key in DATA_SOURCE_REGISTRATIONS:
                await self._register_source(source_key)

        except Exception as e:
            logger.error('collect_source_error', source=source_key, error=str(e))
            self._stats['errors'] += 1

        result = {
            'source': source_key,
            'name': source['name'],
            'dry_run': dry_run,
            **self._stats,
        }
        logger.info('collect_source_complete', **result)
        return result

    async def collect_all(self, dry_run: bool = False) -> List[Dict[str, Any]]:
        """Collect emendas from all configured sources."""
        results = []
        for source_key in SOURCES:
            try:
                result = await self.collect_source(source_key, dry_run=dry_run)
                results.append(result)
            except Exception as e:
                logger.error('collect_all_source_error', source=source_key, error=str(e))
                results.append({'source': source_key, 'error': str(e)})
            # Rate limiting between sources
            await asyncio.sleep(2)
        return results

    # =============================================
    # COLLECTORS BY FORMAT
    # =============================================

    async def _collect_ckan(self, source_key: str, source: dict) -> List[dict]:
        """Collect from CKAN DataStore API with pagination."""
        records = []
        offset = 0
        limit = 1000  # CKAN default page size

        while True:
            params = {
                'resource_id': source['resource_id'],
                'limit': limit,
                'offset': offset,
            }

            resp = await self._http.get(source['url'], params=params)
            resp.raise_for_status()
            data = resp.json()

            result = data.get('result', {})
            raw_records = result.get('records', [])

            if not raw_records:
                break

            for raw in raw_records:
                record = self._normalize_ckan_go(raw, source) if source_key == 'go_estado' else self._normalize_ckan_sp(raw, source)
                if record:
                    records.append(record)

            total = result.get('total', 0)
            offset += limit

            logger.debug('ckan_page_fetched', source=source_key, offset=offset, total=total, page_records=len(raw_records))

            if offset >= total:
                break

            await asyncio.sleep(0.5)

        return records

    async def _collect_csv(self, source_key: str, source: dict) -> List[dict]:
        """Collect from direct CSV download."""
        resp = await self._http.get(source['url'])
        resp.raise_for_status()

        # Detect encoding (ALMG uses latin-1 typically)
        content = resp.content
        try:
            text = content.decode('utf-8')
        except UnicodeDecodeError:
            text = content.decode('latin-1')

        reader = csv.DictReader(io.StringIO(text), delimiter=';')
        records = []

        for row in reader:
            record = self._normalize_mg(row, source)
            if record:
                records.append(record)

        return records

    async def _collect_xlsx(self, source_key: str, source: dict) -> List[dict]:
        """Collect from XLSX download (requires openpyxl)."""
        try:
            import openpyxl
        except ImportError:
            logger.error('openpyxl_not_installed', hint='pip install openpyxl')
            return []

        resp = await self._http.get(source['url'])
        resp.raise_for_status()

        wb = openpyxl.load_workbook(io.BytesIO(resp.content), read_only=True)
        ws = wb.active
        records = []

        rows = list(ws.iter_rows(values_only=True))
        if not rows:
            return []

        # Find header row (first row where multiple cells have text values)
        header_idx = 0
        for i, row in enumerate(rows):
            non_none = sum(1 for v in row if v is not None)
            if non_none >= 5:
                header_idx = i
                break

        headers = [str(h).strip().lower() if h else f'col_{i}' for i, h in enumerate(rows[header_idx])]

        for row in rows[header_idx + 1:]:
            # Skip empty rows or rows with all None/asterisk
            if all(v is None or str(v).strip() == '*' for v in row):
                continue
            row_dict = dict(zip(headers, row, strict=False))
            record = self._normalize_rj(row_dict, source)
            if record:
                records.append(record)

        wb.close()
        return records

    async def _collect_csv_tesouro(self, source_key: str, source: dict) -> List[dict]:
        """Collect from Tesouro Transparente CKAN CSV (large file, ALL municipalities).

        CSV columns (typical Tesouro Transparente):
        Ano, Autor, Tipo Autor, Partido, UF, Localidade, Código IBGE,
        Tipo Emenda, Número Emenda, Função, Subfunção, Programa, Ação,
        Natureza Despesa, Valor Empenhado, Valor Liquidado, Valor Pago
        """
        logger.info('tesouro_csv_download_start', url=source['url'])

        # Large file — stream download
        async with self._http.stream('GET', source['url'], follow_redirects=True, timeout=300.0) as resp:
            resp.raise_for_status()
            content = b''
            async for chunk in resp.aiter_bytes(chunk_size=1024 * 64):
                content += chunk

        # Detect encoding
        try:
            text = content.decode('utf-8')
        except UnicodeDecodeError:
            text = content.decode('latin-1')

        logger.info('tesouro_csv_downloaded', size_mb=round(len(content) / 1024 / 1024, 1))

        # Parse CSV (semicolon separated typical for Brazilian gov)
        delimiter = ';' if ';' in text[:2000] else ','
        reader = csv.DictReader(io.StringIO(text), delimiter=delimiter)
        records = []

        for row in reader:
            record = self._normalize_tesouro(row, source)
            if record:
                records.append(record)

        return records

    async def _collect_portal_transparencia(self, source_key: str, source: dict) -> List[dict]:
        """Collect from Portal da Transparência bulk CSV download (ZIP file).

        The download URL returns a ZIP containing one or more CSV files.
        """
        import zipfile

        logger.info('portal_transparencia_download_start', url=source['url'], ano=source.get('ano'))

        try:
            resp = await self._http.get(source['url'], follow_redirects=True, timeout=300.0)
            resp.raise_for_status()
        except httpx.HTTPStatusError as e:
            logger.warning('portal_transparencia_download_failed', status=e.response.status_code, url=source['url'])
            return []

        records = []
        try:
            zf = zipfile.ZipFile(io.BytesIO(resp.content))
            for name in zf.namelist():
                if name.endswith('.csv'):
                    raw_bytes = zf.read(name)
                    try:
                        text = raw_bytes.decode('utf-8')
                    except UnicodeDecodeError:
                        text = raw_bytes.decode('latin-1')

                    delimiter = ';' if ';' in text[:2000] else ','
                    reader = csv.DictReader(io.StringIO(text), delimiter=delimiter)

                    for row in reader:
                        record = self._normalize_portal_transparencia(row, source)
                        if record:
                            records.append(record)

                    logger.info('portal_csv_parsed', file=name, records=len(records))
            zf.close()
        except zipfile.BadZipFile:
            # Maybe it's a direct CSV, not a ZIP
            logger.info('portal_transparencia_not_zip_trying_csv')
            try:
                text = resp.content.decode('utf-8')
            except UnicodeDecodeError:
                text = resp.content.decode('latin-1')

            delimiter = ';' if ';' in text[:2000] else ','
            reader = csv.DictReader(io.StringIO(text), delimiter=delimiter)
            for row in reader:
                record = self._normalize_portal_transparencia(row, source)
                if record:
                    records.append(record)

        return records

    async def _collect_csv_generic(self, source_key: str, source: dict, normalizer) -> List[dict]:
        """Generic CSV collector with custom normalizer function.

        Tries data_url first, falls back to main url.
        """
        url = source.get('data_url', source['url'])
        logger.info('csv_generic_download', source=source_key, url=url)

        try:
            resp = await self._http.get(url, follow_redirects=True, timeout=120.0)
            resp.raise_for_status()
        except (httpx.HTTPStatusError, httpx.ConnectError) as e:
            logger.warning('csv_generic_download_failed', source=source_key, error=str(e))
            # Try scraping the transparency page for download links
            return await self._scrape_transparency_page(source_key, source, normalizer)

        content = resp.content
        try:
            text = content.decode('utf-8')
        except UnicodeDecodeError:
            text = content.decode('latin-1')

        delimiter = ';' if ';' in text[:2000] else ','
        reader = csv.DictReader(io.StringIO(text), delimiter=delimiter)
        records = []

        for row in reader:
            record = normalizer(row, source)
            if record:
                records.append(record)

        return records

    async def _scrape_transparency_page(self, source_key: str, source: dict, normalizer) -> List[dict]:
        """Fallback: scrape transparency page for CSV download links."""
        logger.info('scrape_transparency_page', source=source_key, url=source['url'])

        try:
            from bs4 import BeautifulSoup
        except ImportError:
            logger.error('beautifulsoup4_not_installed', hint='pip install beautifulsoup4')
            return []

        try:
            resp = await self._http.get(source['url'], follow_redirects=True, timeout=60.0)
            resp.raise_for_status()
        except Exception as e:
            logger.warning('scrape_page_failed', source=source_key, error=str(e))
            return []

        soup = BeautifulSoup(resp.text, 'html.parser')
        records = []

        # Look for CSV/XLSX download links containing 'emenda'
        for link in soup.find_all('a', href=True):
            href = link['href']
            text = link.get_text(strip=True).lower()
            if ('emenda' in text or 'emenda' in href.lower()) and \
               (href.endswith('.csv') or href.endswith('.xlsx') or 'download' in href.lower()):
                full_url = href if href.startswith('http') else source['url'].rstrip('/') + '/' + href.lstrip('/')
                logger.info('found_download_link', source=source_key, url=full_url)
                try:
                    dl_resp = await self._http.get(full_url, follow_redirects=True, timeout=120.0)
                    dl_resp.raise_for_status()
                    try:
                        text_content = dl_resp.content.decode('utf-8')
                    except UnicodeDecodeError:
                        text_content = dl_resp.content.decode('latin-1')

                    delimiter = ';' if ';' in text_content[:2000] else ','
                    reader = csv.DictReader(io.StringIO(text_content), delimiter=delimiter)
                    for row in reader:
                        record = normalizer(row, source)
                        if record:
                            records.append(record)
                    if records:
                        break
                except Exception as e:
                    logger.warning('download_link_failed', url=full_url, error=str(e))
                    continue

        return records

    async def _collect_ckan_bh(self, source_key: str, source: dict) -> List[dict]:
        """Collect from Belo Horizonte CKAN DataStore API.

        BH portal uses standard CKAN but may have different resource IDs.
        We search for emendas datasets first.
        """
        base_url = source['url'].replace('/datastore_search', '')

        # First, search for emendas package
        search_url = base_url.replace('action/datastore_search', 'action/package_search')
        try:
            resp = await self._http.get(search_url, params={'q': 'emendas parlamentares', 'rows': 5})
            resp.raise_for_status()
            data = resp.json()
        except Exception as e:
            logger.warning('bh_ckan_search_failed', error=str(e))
            return []

        resource_ids = []
        for pkg in data.get('result', {}).get('results', []):
            for res in pkg.get('resources', []):
                if res.get('datastore_active') or res.get('format', '').upper() in ('CSV', 'JSON'):
                    resource_ids.append(res['id'])

        if not resource_ids:
            logger.warning('bh_no_emendas_resources_found')
            return []

        records = []
        for rid in resource_ids[:3]:  # Limit to first 3 resources
            source_copy = dict(source)
            source_copy['resource_id'] = rid
            page_records = await self._collect_ckan(source_key, source_copy)
            records.extend(page_records)

        return records

    # =============================================
    # NORMALIZERS (raw → standard schema)
    # =============================================

    def _normalize_ckan_go(self, raw: dict, source: dict) -> Optional[dict]:
        """Normalize CKAN record from GO Portal de Dados Abertos."""
        try:
            # GO CKAN columns: Deputado, Partido, NEmenda, Valor, FuncaoProgramatica, etc.
            autor = raw.get('Deputado') or raw.get('deputado') or raw.get('DEPUTADO', '')
            partido = raw.get('Partido') or raw.get('partido') or raw.get('PARTIDO', '')
            numero = raw.get('NEmenda') or raw.get('nemenda') or raw.get('NEMENDA', '')
            valor_str = raw.get('Valor') or raw.get('valor') or raw.get('VALOR', '0')
            descricao = raw.get('DescricaoEmenda') or raw.get('descricaoemenda') or raw.get('Descricao') or ''
            funcao = raw.get('FuncaoProgramatica') or raw.get('funcaoprogramatica') or ''
            ano_raw = raw.get('Ano') or raw.get('ano') or raw.get('ANO')
            beneficiario = raw.get('Beneficiario') or raw.get('beneficiario') or ''

            # Parse valor
            valor = self._parse_valor(valor_str)
            ano = int(ano_raw) if ano_raw else datetime.now().year

            # Generate unique code — use _id from CKAN if available
            _id = raw.get('_id', '')
            if numero:
                codigo = f"GO-{numero}-{ano}"
            elif _id:
                codigo = f"GO-{_id}"
            else:
                # Fallback: hash of all identifying fields
                h = hashlib.md5(f"{autor}{descricao}{valor_str}{beneficiario}".encode()).hexdigest()[:10]
                codigo = f"GO-{h}-{ano}"

            return {
                'codigo_emenda': codigo,
                'numero_emenda': str(numero) if numero else None,
                'esfera': source['esfera'],
                'uf': source['uf'],
                'municipio': source.get('municipio'),
                'codigo_ibge': source.get('codigo_ibge'),
                'autor': autor.strip() if autor else None,
                'partido': partido.strip() if partido else None,
                'tipo_autor': 'deputado_estadual',
                'tipo': 'individual',
                'descricao': descricao.strip() if descricao else None,
                'funcao': funcao.strip() if funcao else None,
                'beneficiario': beneficiario.strip() if beneficiario else None,
                'ano': ano,
                'valor_aprovado': valor,
                'fonte': 'go_ckan',
                'fonte_url': source['url'],
                'dados_extras': json.dumps({k: str(v) for k, v in raw.items() if v}),
            }
        except Exception as e:
            logger.warning('normalize_go_error', error=str(e), raw_keys=list(raw.keys()))
            return None

    def _normalize_ckan_sp(self, raw: dict, source: dict) -> Optional[dict]:
        """Normalize CKAN record from SP Portal de Dados Abertos."""
        try:
            autor = raw.get('Autor') or raw.get('autor') or raw.get('Parlamentar') or ''
            numero = raw.get('Emenda') or raw.get('emenda') or raw.get('NumeroEmenda') or ''
            valor_str = raw.get('Valor') or raw.get('valor') or '0'
            descricao = raw.get('Objeto') or raw.get('objeto') or raw.get('Descricao') or ''
            ano_raw = raw.get('Ano') or raw.get('ano')

            valor = self._parse_valor(valor_str)
            ano = int(ano_raw) if ano_raw else datetime.now().year

            codigo = f"SP-MUN-{numero}-{ano}" if numero else f"SP-MUN-{autor[:20]}-{ano}-{hash(descricao) % 10000}"

            return {
                'codigo_emenda': codigo,
                'numero_emenda': str(numero) if numero else None,
                'esfera': source['esfera'],
                'uf': source['uf'],
                'municipio': source['municipio'],
                'codigo_ibge': source.get('codigo_ibge'),
                'autor': autor.strip() if autor else None,
                'tipo_autor': 'vereador',
                'tipo': 'individual',
                'descricao': descricao.strip() if descricao else None,
                'ano': ano,
                'valor_aprovado': valor,
                'fonte': 'sp_ckan',
                'fonte_url': source['url'],
                'dados_extras': json.dumps({k: str(v) for k, v in raw.items() if v}),
            }
        except Exception as e:
            logger.warning('normalize_sp_error', error=str(e))
            return None

    def _normalize_mg(self, raw: dict, source: dict) -> Optional[dict]:
        """Normalize CSV record from ALMG (Minas Gerais).

        Real ALMG columns:
        'Ano da Indicação', 'Número da Indicação', 'Indicador de Impositividade',
        'Tipo de Indicação', 'Status da Indicação', 'Autor', 'Tipo de autoria',
        'Função Descrição', 'Descrição da Indicação', 'Município ',
        'Nome Beneficiário', 'Número do CNPJ do Beneficiário',
        'Valor Indicado', 'Valor Utilizado', 'Valor Empenhado no Ano', 'Valor Pago Atualizado'
        """
        try:
            autor = raw.get('Autor', '').strip()
            numero = raw.get('Número da Indicação', '').strip()
            ano_raw = raw.get('Ano da Indicação', '')
            tipo_autoria = raw.get('Tipo de autoria', '').strip()
            tipo_indicacao = raw.get('Tipo de Indicação', '').strip()
            descricao = raw.get('Descrição da Indicação', '').strip()
            funcao = raw.get('Função Descrição', '').strip()
            municipio_destino = raw.get('Município ', '').strip()  # Note: trailing space in header
            beneficiario = raw.get('Nome Beneficiário', '').strip()
            cnpj_benef = raw.get('Número do CNPJ do Beneficiário', '').strip()
            natureza = raw.get('Grupo de Despesa Descrição', '').strip()

            valor_indicado = self._parse_valor(raw.get('Valor Indicado', '0'))
            valor_empenhado = self._parse_valor(raw.get('Valor Empenhado no Ano', '0'))
            valor_pago = self._parse_valor(raw.get('Valor Pago Atualizado', '0'))

            ano = int(ano_raw) if ano_raw else datetime.now().year

            if not numero:
                return None  # Skip rows without identification

            codigo = f"MG-{numero}-{ano}"

            return {
                'codigo_emenda': codigo,
                'numero_emenda': numero,
                'esfera': source['esfera'],
                'uf': source['uf'],
                'municipio': municipio_destino if municipio_destino else None,
                'codigo_ibge': source.get('codigo_ibge'),
                'autor': autor if autor else None,
                'partido': None,  # Not in ALMG CSV
                'tipo_autor': 'deputado_estadual' if tipo_autoria == 'INDIVIDUAL' else tipo_autoria.lower() if tipo_autoria else 'deputado_estadual',
                'tipo': tipo_indicacao.lower() if tipo_indicacao else 'individual',
                'descricao': descricao if descricao else None,
                'funcao': funcao if funcao else None,
                'natureza_despesa': natureza if natureza else None,
                'beneficiario': beneficiario if beneficiario else None,
                'cnpj_beneficiario': cnpj_benef if cnpj_benef else None,
                'ano': ano,
                'valor_aprovado': valor_indicado,
                'valor_empenhado': valor_empenhado,
                'valor_pago': valor_pago,
                'fonte': 'mg_almg',
                'fonte_url': source['url'],
                'dados_extras': json.dumps({
                    'status': raw.get('Status da Indicação', ''),
                    'impositiva': raw.get('Indicador de Impositividade', ''),
                    'unidade_orcamentaria': raw.get('Unidade Orçamentária Descrição', ''),
                    'macrorregiao': raw.get('Macrorregião de Planejamento', ''),
                }),
            }
        except Exception as e:
            logger.warning('normalize_mg_error', error=str(e))
            return None

    def _normalize_rj(self, raw: dict, source: dict) -> Optional[dict]:
        """Normalize XLSX record from RJ Transparência.

        Real RJ XLSX columns (row 6 is header):
        'transferência especial - ano', 'nº emenda', 'parlamentar', 'gnd',
        'valor total da emenda', 'código da unidade', 'órgão', 'objeto',
        'ano \nempenho', 'empenho', 'valor\nempenho', 'empresa',
        'liquidado', 'pago', 'cnpj'
        """
        try:
            autor = raw.get('parlamentar', '')
            numero = raw.get('nº emenda', '') or raw.get('n\u00ba emenda', '')
            valor_total_str = raw.get('valor total da emenda', '0')
            descricao = raw.get('objeto', '')
            orgao = raw.get('órgão', '') or raw.get('\u00f3rg\u00e3o', '')
            gnd = raw.get('gnd', '')  # Grupo Natureza Despesa
            ano_raw = raw.get('transferência especial - ano', '') or raw.get('transfer\u00eancia especial - ano', '')
            empresa = raw.get('empresa', '')
            cnpj = raw.get('cnpj', '')
            valor_empenho_str = raw.get('valor\nempenho', '0')
            liquidado_str = raw.get('liquidado', '0')
            pago_str = raw.get('pago', '0')

            if not autor or str(autor).strip() == '*':
                return None

            valor_total = self._parse_valor(valor_total_str)
            valor_empenho = self._parse_valor(valor_empenho_str)
            valor_liquidado = self._parse_valor(liquidado_str)
            valor_pago = self._parse_valor(pago_str)
            ano = int(float(str(ano_raw))) if ano_raw else 2025

            numero_str = str(numero).strip() if numero else ''
            codigo = f"RJ-MUN-{numero_str}-{ano}" if numero_str else f"RJ-MUN-{str(autor)[:20]}-{ano}"

            return {
                'codigo_emenda': codigo,
                'numero_emenda': numero_str if numero_str else None,
                'esfera': source['esfera'],
                'uf': source['uf'],
                'municipio': source['municipio'],
                'codigo_ibge': source.get('codigo_ibge'),
                'autor': str(autor).strip(),
                'tipo_autor': 'parlamentar_federal',  # These are federal transfers to Rio
                'tipo': 'transferencia_especial',
                'descricao': str(descricao).strip() if descricao else None,
                'natureza_despesa': str(gnd).strip() if gnd else None,
                'beneficiario': str(empresa).strip() if empresa and str(empresa) != '*' else None,
                'cnpj_beneficiario': str(cnpj).strip() if cnpj and str(cnpj) != '*' else None,
                'ano': ano,
                'valor_aprovado': valor_total,
                'valor_empenhado': valor_empenho,
                'valor_liquidado': valor_liquidado,
                'valor_pago': valor_pago,
                'fonte': 'rj_transparencia',
                'fonte_url': source['url'],
                'dados_extras': json.dumps({
                    'orgao': str(orgao) if orgao else None,
                }),
            }
        except Exception as e:
            logger.warning('normalize_rj_error', error=str(e))
            return None

    def _normalize_tesouro(self, raw: dict, source: dict) -> Optional[dict]:
        """Normalize Tesouro Transparente CSV record.

        Typical columns (semicolon-separated):
        Ano, Autor da Emenda, Tipo Autor, Partido Autor, UF Autor,
        Numero Emenda, Tipo Emenda, Funcao, Subfuncao, Programa, Acao,
        Localidade (Município/UF), Codigo IBGE Localidade,
        Natureza Despesa, Valor Empenhado, Valor Liquidado, Valor Pago
        """
        try:
            # Try multiple possible column name patterns
            autor = self._get_field(raw, ['Autor da Emenda', 'Autor', 'AUTOR DA EMENDA', 'autor_emenda'])
            tipo_autor = self._get_field(raw, ['Tipo Autor', 'TIPO AUTOR', 'tipo_autor'])
            partido = self._get_field(raw, ['Partido Autor', 'Partido', 'PARTIDO', 'partido_autor'])
            uf = self._get_field(raw, ['UF Autor', 'UF', 'uf_autor', 'UF_AUTOR'])
            numero = self._get_field(raw, ['Numero Emenda', 'Número Emenda', 'NUMERO EMENDA', 'numero_emenda', 'NR_EMENDA'])
            tipo_emenda = self._get_field(raw, ['Tipo Emenda', 'TIPO EMENDA', 'tipo_emenda'])
            funcao = self._get_field(raw, ['Funcao', 'Função', 'FUNCAO', 'funcao'])
            subfuncao = self._get_field(raw, ['Subfuncao', 'Subfunção', 'SUBFUNCAO', 'subfuncao'])
            programa = self._get_field(raw, ['Programa', 'PROGRAMA', 'programa'])
            acao = self._get_field(raw, ['Acao', 'Ação', 'ACAO', 'acao'])
            localidade = self._get_field(raw, ['Localidade', 'LOCALIDADE', 'localidade', 'Municipio', 'Município'])
            cod_ibge = self._get_field(raw, ['Codigo IBGE', 'Código IBGE', 'CODIGO_IBGE', 'codigo_ibge', 'Codigo IBGE Localidade'])
            natureza = self._get_field(raw, ['Natureza Despesa', 'NATUREZA DESPESA', 'natureza_despesa'])
            ano_raw = self._get_field(raw, ['Ano', 'ANO', 'ano', 'Exercicio', 'Exercício'])

            val_empenhado = self._parse_valor(self._get_field(raw, ['Valor Empenhado', 'VALOR EMPENHADO', 'valor_empenhado', 'VL_EMPENHADO']))
            val_liquidado = self._parse_valor(self._get_field(raw, ['Valor Liquidado', 'VALOR LIQUIDADO', 'valor_liquidado', 'VL_LIQUIDADO']))
            val_pago = self._parse_valor(self._get_field(raw, ['Valor Pago', 'VALOR PAGO', 'valor_pago', 'VL_PAGO']))

            ano = int(ano_raw) if ano_raw and str(ano_raw).strip().isdigit() else datetime.now().year

            if not numero:
                # Generate unique code from hash
                h = hashlib.md5(f"{autor}{localidade}{tipo_emenda}{ano}{val_empenhado}".encode()).hexdigest()[:12]
                codigo = f"TT-{h}-{ano}"
            else:
                codigo = f"TT-{str(numero).strip()}-{ano}"

            return {
                'codigo_emenda': codigo,
                'numero_emenda': str(numero).strip() if numero else None,
                'esfera': 'federal',
                'uf': str(uf).strip() if uf else None,
                'municipio': str(localidade).strip() if localidade else None,
                'codigo_ibge': str(cod_ibge).strip() if cod_ibge else None,
                'autor': str(autor).strip() if autor else None,
                'partido': str(partido).strip() if partido else None,
                'tipo_autor': str(tipo_autor).strip().lower() if tipo_autor else None,
                'tipo': str(tipo_emenda).strip().lower() if tipo_emenda else None,
                'funcao': str(funcao).strip() if funcao else None,
                'subfuncao': str(subfuncao).strip() if subfuncao else None,
                'programa': str(programa).strip() if programa else None,
                'acao': str(acao).strip() if acao else None,
                'natureza_despesa': str(natureza).strip() if natureza else None,
                'ano': ano,
                'valor_empenhado': val_empenhado,
                'valor_liquidado': val_liquidado,
                'valor_pago': val_pago,
                'fonte': 'tesouro_transparente',
                'fonte_url': source['url'],
            }
        except Exception as e:
            logger.warning('normalize_tesouro_error', error=str(e))
            return None

    def _normalize_portal_transparencia(self, raw: dict, source: dict) -> Optional[dict]:
        """Normalize Portal da Transparência bulk CSV record.

        Portal da Transparência columns (semicolon-separated, latin-1):
        Ano, Código Emenda, Número Emenda, Tipo Emenda, Autor Emenda,
        Código Função, Função, Código Subfunção, Subfunção,
        Código Programa, Programa, Código Ação, Ação,
        Código Localidade, Localidade, UF,
        Valor Empenhado, Valor Liquidado, Valor Pago, Valor Restos Inscritos
        """
        try:
            autor = self._get_field(raw, ['Autor Emenda', 'Autor da Emenda', 'AUTOR_EMENDA', 'Nome Autor da Emenda'])
            codigo_emenda = self._get_field(raw, ['Código Emenda', 'Codigo Emenda', 'CODIGO_EMENDA', 'Código da Emenda'])
            numero = self._get_field(raw, ['Número Emenda', 'Numero Emenda', 'NUMERO_EMENDA', 'Número da Emenda'])
            tipo_emenda = self._get_field(raw, ['Tipo Emenda', 'TIPO_EMENDA', 'Tipo da Emenda'])
            funcao = self._get_field(raw, ['Função', 'Funcao', 'FUNCAO', 'Nome Função'])
            subfuncao = self._get_field(raw, ['Subfunção', 'Subfuncao', 'SUBFUNCAO', 'Nome Subfunção'])
            programa = self._get_field(raw, ['Programa', 'PROGRAMA', 'Nome Programa'])
            acao = self._get_field(raw, ['Ação', 'Acao', 'ACAO', 'Nome Ação'])
            localidade = self._get_field(raw, ['Localidade', 'LOCALIDADE', 'Nome Localidade'])
            uf = self._get_field(raw, ['UF', 'UF Localidade', 'Sigla UF'])
            cod_ibge = self._get_field(raw, ['Código Localidade', 'Codigo Localidade', 'CODIGO_LOCALIDADE'])
            ano_raw = self._get_field(raw, ['Ano', 'ANO', 'Ano da Emenda', 'Exercício'])

            val_empenhado = self._parse_valor(self._get_field(raw, ['Valor Empenhado', 'VALOR_EMPENHADO']))
            val_liquidado = self._parse_valor(self._get_field(raw, ['Valor Liquidado', 'VALOR_LIQUIDADO']))
            val_pago = self._parse_valor(self._get_field(raw, ['Valor Pago', 'VALOR_PAGO']))
            val_restos = self._parse_valor(self._get_field(raw, ['Valor Restos Inscritos', 'Valor Resto a Pagar Inscrito']))

            ano = int(ano_raw) if ano_raw and str(ano_raw).strip().isdigit() else source.get('ano', datetime.now().year)

            if not codigo_emenda and not numero:
                return None  # Skip rows without identification

            codigo = str(codigo_emenda).strip() if codigo_emenda else f"PT-{str(numero).strip()}-{ano}"

            return {
                'codigo_emenda': f"PT-{codigo}-{ano}",
                'numero_emenda': str(numero).strip() if numero else None,
                'esfera': 'federal',
                'uf': str(uf).strip() if uf else None,
                'municipio': str(localidade).strip() if localidade else None,
                'codigo_ibge': str(cod_ibge).strip() if cod_ibge else None,
                'autor': str(autor).strip() if autor else None,
                'tipo': str(tipo_emenda).strip().lower() if tipo_emenda else None,
                'funcao': str(funcao).strip() if funcao else None,
                'subfuncao': str(subfuncao).strip() if subfuncao else None,
                'programa': str(programa).strip() if programa else None,
                'acao': str(acao).strip() if acao else None,
                'ano': ano,
                'valor_empenhado': val_empenhado,
                'valor_liquidado': val_liquidado,
                'valor_pago': val_pago,
                'fonte': 'portal_transparencia',
                'fonte_url': source['url'],
                'dados_extras': json.dumps({
                    'valor_restos_inscritos': val_restos,
                }) if val_restos else None,
            }
        except Exception as e:
            logger.warning('normalize_portal_transparencia_error', error=str(e))
            return None

    def _normalize_ba(self, raw: dict, source: dict) -> Optional[dict]:
        """Normalize Bahia Assembly CSV record."""
        try:
            autor = self._get_field(raw, ['Autor', 'Deputado', 'Parlamentar', 'AUTOR'])
            numero = self._get_field(raw, ['Número', 'Numero', 'Nr Emenda', 'NUMERO', 'Nº Emenda'])
            ano_raw = self._get_field(raw, ['Ano', 'ANO', 'Exercício', 'Exercicio'])
            descricao = self._get_field(raw, ['Descrição', 'Descricao', 'Objeto', 'DESCRICAO'])
            funcao = self._get_field(raw, ['Função', 'Funcao', 'FUNCAO'])
            municipio = self._get_field(raw, ['Município', 'Municipio', 'MUNICIPIO', 'Localidade'])
            valor_str = self._get_field(raw, ['Valor', 'Valor Aprovado', 'Valor Indicado', 'VALOR'])
            partido = self._get_field(raw, ['Partido', 'PARTIDO'])
            beneficiario = self._get_field(raw, ['Beneficiário', 'Beneficiario', 'BENEFICIARIO'])
            val_empenhado = self._parse_valor(self._get_field(raw, ['Valor Empenhado', 'Empenhado']))
            val_pago = self._parse_valor(self._get_field(raw, ['Valor Pago', 'Pago']))

            ano = int(ano_raw) if ano_raw and str(ano_raw).strip().isdigit() else datetime.now().year
            valor = self._parse_valor(valor_str)

            if not numero and not autor:
                return None

            codigo = f"BA-{str(numero).strip()}-{ano}" if numero else f"BA-{hashlib.md5(f'{autor}{descricao}{ano}'.encode()).hexdigest()[:10]}-{ano}"

            return {
                'codigo_emenda': codigo,
                'numero_emenda': str(numero).strip() if numero else None,
                'esfera': source['esfera'],
                'uf': source['uf'],
                'municipio': str(municipio).strip() if municipio else None,
                'autor': str(autor).strip() if autor else None,
                'partido': str(partido).strip() if partido else None,
                'tipo_autor': 'deputado_estadual',
                'tipo': 'individual',
                'descricao': str(descricao).strip() if descricao else None,
                'funcao': str(funcao).strip() if funcao else None,
                'beneficiario': str(beneficiario).strip() if beneficiario else None,
                'ano': ano,
                'valor_aprovado': valor,
                'valor_empenhado': val_empenhado,
                'valor_pago': val_pago,
                'fonte': 'ba_alba',
                'fonte_url': source['url'],
                'dados_extras': json.dumps({k: str(v) for k, v in raw.items() if v}),
            }
        except Exception as e:
            logger.warning('normalize_ba_error', error=str(e))
            return None

    def _normalize_pr(self, raw: dict, source: dict) -> Optional[dict]:
        """Normalize Paraná Assembly CSV record."""
        try:
            autor = self._get_field(raw, ['Autor', 'Deputado', 'Parlamentar', 'AUTOR'])
            numero = self._get_field(raw, ['Número', 'Numero', 'Nr Emenda', 'NUMERO', 'Nº Emenda', 'Nº'])
            ano_raw = self._get_field(raw, ['Ano', 'ANO', 'Exercício'])
            descricao = self._get_field(raw, ['Descrição', 'Descricao', 'Objeto', 'DESCRICAO', 'Finalidade'])
            funcao = self._get_field(raw, ['Função', 'Funcao', 'FUNCAO'])
            municipio = self._get_field(raw, ['Município', 'Municipio', 'MUNICIPIO', 'Localidade'])
            valor_str = self._get_field(raw, ['Valor', 'Valor Aprovado', 'Valor da Emenda', 'VALOR'])
            partido = self._get_field(raw, ['Partido', 'PARTIDO'])
            beneficiario = self._get_field(raw, ['Beneficiário', 'Beneficiario', 'Entidade', 'BENEFICIARIO'])
            val_empenhado = self._parse_valor(self._get_field(raw, ['Valor Empenhado', 'Empenhado']))
            val_pago = self._parse_valor(self._get_field(raw, ['Valor Pago', 'Pago']))

            ano = int(ano_raw) if ano_raw and str(ano_raw).strip().isdigit() else datetime.now().year
            valor = self._parse_valor(valor_str)

            if not numero and not autor:
                return None

            codigo = f"PR-{str(numero).strip()}-{ano}" if numero else f"PR-{hashlib.md5(f'{autor}{descricao}{ano}'.encode()).hexdigest()[:10]}-{ano}"

            return {
                'codigo_emenda': codigo,
                'numero_emenda': str(numero).strip() if numero else None,
                'esfera': source['esfera'],
                'uf': source['uf'],
                'municipio': str(municipio).strip() if municipio else None,
                'autor': str(autor).strip() if autor else None,
                'partido': str(partido).strip() if partido else None,
                'tipo_autor': 'deputado_estadual',
                'tipo': 'individual',
                'descricao': str(descricao).strip() if descricao else None,
                'funcao': str(funcao).strip() if funcao else None,
                'beneficiario': str(beneficiario).strip() if beneficiario else None,
                'ano': ano,
                'valor_aprovado': valor,
                'valor_empenhado': val_empenhado,
                'valor_pago': val_pago,
                'fonte': 'pr_alep',
                'fonte_url': source['url'],
                'dados_extras': json.dumps({k: str(v) for k, v in raw.items() if v}),
            }
        except Exception as e:
            logger.warning('normalize_pr_error', error=str(e))
            return None

    # =============================================
    # HELPERS
    # =============================================

    def _get_field(self, row: dict, candidates: List[str]) -> Optional[str]:
        """Get field value trying multiple column name candidates."""
        for key in candidates:
            val = row.get(key)
            if val is not None and str(val).strip():
                return str(val).strip()
        return None

    def _parse_valor(self, val: Any) -> Optional[float]:
        """Parse Brazilian currency value to float."""
        if val is None:
            return None
        if isinstance(val, (int, float)):
            return float(val)
        s = str(val).strip()
        if not s or s == '0':
            return 0.0
        # Remove R$, spaces
        s = s.replace('R$', '').replace(' ', '').strip()
        # Brazilian format: 1.234.567,89 → 1234567.89
        if ',' in s and '.' in s:
            s = s.replace('.', '').replace(',', '.')
        elif ',' in s:
            s = s.replace(',', '.')
        try:
            return float(s)
        except ValueError:
            return None

    async def _upsert_records(self, records: List[dict]):
        """Upsert records into fato_emendas_subnacionais in batches."""
        # Deduplicate by unique key (fonte, codigo_emenda, ano) — keep last occurrence
        seen = {}
        for r in records:
            key = (r.get('fonte'), r.get('codigo_emenda'), r.get('ano'))
            seen[key] = r
        records = list(seen.values())
        logger.info('records_deduplicated', original=len(records) + (len(records) - len(seen)), unique=len(records))

        batch_size = 500
        for i in range(0, len(records), batch_size):
            batch = records[i:i + batch_size]
            try:
                result = (
                    self._bdh.table('fato_emendas_subnacionais')
                    .upsert(batch, on_conflict='fonte,codigo_emenda,ano')
                    .execute()
                )
                inserted = len(result.data) if result.data else 0
                self._stats['inserted'] += inserted
                logger.info('batch_upserted', batch=i // batch_size + 1, count=inserted)
            except Exception as e:
                self._stats['errors'] += len(batch)
                logger.error('batch_upsert_error', batch=i // batch_size + 1, error=str(e))

    async def _register_source(self, source_key: str):
        """Register data source in fontes_dados for compliance (main Supabase instance)."""
        reg = DATA_SOURCE_REGISTRATIONS.get(source_key)
        if not reg or not self._main_supabase:
            return
        try:
            self._main_supabase.table('fontes_dados').upsert(
                {
                    **reg,
                    'data_primeira_coleta': datetime.now().isoformat(),
                    'data_ultima_atualizacao': datetime.now().isoformat(),
                    'periodicidade': 'mensal',
                },
                on_conflict='nome',
            ).execute()
            logger.info('source_registered', source=source_key)
        except Exception as e:
            logger.warning('source_registration_failed', source=source_key, error=str(e))


# =============================================
# CLI
# =============================================

async def main():
    import argparse

    parser = argparse.ArgumentParser(
        description='IconsAI - Emendas Subnacionais Collector'
    )
    parser.add_argument(
        '--source',
        type=str,
        choices=list(SOURCES.keys()) + ['all'],
        required=True,
        help='Source to collect from (or "all" for all sources)',
    )
    parser.add_argument(
        '--dry-run',
        action='store_true',
        help='Fetch data but do not save to database',
    )
    parser.add_argument(
        '--list-sources',
        action='store_true',
        help='List all available sources and exit',
    )

    args = parser.parse_args()

    if args.list_sources:
        print('\nAvailable sources:')
        print('-' * 60)
        for key, src in SOURCES.items():
            print(f"  {key:15s}  {src['name']}")
            print(f"  {'':15s}  Esfera: {src['esfera']} | UF: {src['uf']} | Format: {src['format']}")
            print()
        return

    collector = EmendasSubnacionaisCollector()

    try:
        if args.source == 'all':
            results = await collector.collect_all(dry_run=args.dry_run)
            print('\n=== Collection Summary ===')
            total_fetched = 0
            total_inserted = 0
            for r in results:
                status = f"fetched={r.get('fetched', 0)}, inserted={r.get('inserted', 0)}"
                if r.get('error'):
                    status = f"ERROR: {r['error']}"
                print(f"  {r['source']:15s}  {status}")
                total_fetched += r.get('fetched', 0)
                total_inserted += r.get('inserted', 0)
            print(f"\n  TOTAL: fetched={total_fetched}, inserted={total_inserted}")
        else:
            result = await collector.collect_source(args.source, dry_run=args.dry_run)
            print(f"\nResult: {json.dumps(result, indent=2)}")
    finally:
        await collector.close()


if __name__ == '__main__':
    asyncio.run(main())
