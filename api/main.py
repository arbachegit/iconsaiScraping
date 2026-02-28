"""
IconsAI Scraping API - v3.0 (Clean Architecture)
"""

import os
import re
from datetime import datetime, timedelta
from enum import Enum
from pathlib import Path
from typing import Optional

import structlog
from fastapi import Depends, FastAPI, HTTPException, Query, Request
from fastapi.middleware.cors import CORSMiddleware
from pydantic import BaseModel, ConfigDict, Field, field_validator
from slowapi import Limiter, _rate_limit_exceeded_handler
from slowapi.errors import RateLimitExceeded
from slowapi.util import get_remote_address
from supabase import create_client

from api.auth.auth_controller import router as auth_router
from api.auth.auth_middleware import get_current_user
from api.auth.user_controller import router as user_router
from backend.src.services.person_enrichment import PersonEnrichmentService
from config.settings import settings

logger = structlog.get_logger()

# Rate limiter — 100 requests/minute per IP (matches Node.js backend)
limiter = Limiter(key_func=get_remote_address, default_limits=["100/minute"])


# ===========================================
# QUERY PARAM SCHEMAS (Pydantic Validation)
# ===========================================


class CnaeListParams(BaseModel):
    """Schema para listagem de CNAEs."""

    model_config = ConfigDict(str_strip_whitespace=True, extra="forbid")

    search: str = Field(default="", max_length=100)
    limit: int = Field(default=100, ge=1, le=2000)
    offset: int = Field(default=0, ge=0)

    @field_validator("search")
    @classmethod
    def sanitize_search(cls, v: str) -> str:
        """Remove caracteres especiais que podem causar SQL injection via ilike."""
        if not v:
            return ""
        # Remove %, _, \ que são metacaracteres do LIKE/ILIKE
        return re.sub(r"[%_\\]", "", v.strip())[:100]


class EnrichPeopleParams(BaseModel):
    """Schema para enriquecimento de pessoas."""

    model_config = ConfigDict(str_strip_whitespace=True)

    limit: int = Field(default=10, ge=1, le=100)


def get_version() -> str:
    """Read version from VERSION file"""
    version_file = Path(__file__).resolve().parent.parent / "VERSION"
    if version_file.exists():
        return version_file.read_text().strip()
    return "1.0.2026"


APP_VERSION = get_version()

# FastAPI app
app = FastAPI(
    title="IconsAI Scraping API",
    description="API de inteligencia de dados",
    version=APP_VERSION,
    docs_url="/docs",
    redoc_url="/redoc",
)

# Rate limiter
app.state.limiter = limiter
app.add_exception_handler(RateLimitExceeded, _rate_limit_exceeded_handler)

# CORS
app.add_middleware(
    CORSMiddleware,
    allow_origins=settings.parsed_allowed_origins,
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)

# Note: Frontend is served by Next.js container (port 3000)
# Nginx routes / to Next.js, /api/* to backends


# ===========================================
# ROUTERS — Auth + Admin
# ===========================================

app.include_router(auth_router, prefix="/auth", tags=["Auth"])
app.include_router(user_router, prefix="/admin", tags=["Admin"])


# ===========================================
# HEALTH
# ===========================================


@app.get("/health", tags=["System"])
async def health():
    """Health check with API status"""
    apis = {
        "anthropic": bool(settings.anthropic_api_key),
        "openai": bool(settings.openai_api_key),
        "serper": bool(settings.serper_api_key),
        "tavily": bool(settings.tavily_api_key),
        "perplexity": bool(settings.perplexity_api_key),
        "apollo": bool(settings.apollo_api_key),
        "supabase": bool(settings.supabase_url),
    }

    configured = sum(apis.values())
    total = len(apis)

    return {
        "status": "healthy",
        "version": APP_VERSION,
        "git_sha": os.getenv("GIT_SHA", "unknown"),
        "build_date": os.getenv("BUILD_DATE", "unknown"),
        "apis": apis,
        "apis_configured": f"{configured}/{total}",
        "ready": configured >= 3,
    }


@app.get("/version", tags=["System"])
async def version():
    """Version endpoint for deployment verification"""
    return {
        "version": APP_VERSION,
        "git_sha": os.getenv("GIT_SHA", "unknown"),
        "build_date": os.getenv("BUILD_DATE", "unknown"),
        "service": "iconsai-scraping-api",
    }


# ===========================================
# CNAE ENDPOINTS
# ===========================================


@app.get("/api/cnae", tags=["CNAE"])
@limiter.limit("100/minute")
async def list_cnae(
    request: Request,
    search: str = Query(default="", max_length=100),
    limit: int = Query(default=100, ge=1, le=2000),
    offset: int = Query(default=0, ge=0),
    current_user=Depends(get_current_user),
):
    """
    List CNAEs from raw_cnae table.
    Returns: subclasse, descricao, descricao_secao, descricao_divisao,
             descricao_grupo, descricao_classe
    """
    if not settings.supabase_url or not settings.supabase_service_key:
        raise HTTPException(status_code=500, detail="Supabase not configured")

    # Sanitize search input (remove SQL metacharacters)
    sanitized_search = re.sub(r"[%_\\]", "", search.strip())[:100] if search else ""

    try:
        supabase = create_client(settings.supabase_url, settings.supabase_service_key)

        query = supabase.table("raw_cnae").select(
            "subclasse, codigo, descricao, descricao_secao, "
            "descricao_divisao, descricao_grupo, descricao_classe"
        )

        if sanitized_search:
            # Search in codigo or descricao (sanitized input)
            query = query.or_(
                f"codigo.ilike.%{sanitized_search}%,descricao.ilike.%{sanitized_search}%,"
                f"descricao_secao.ilike.%{sanitized_search}%,descricao_grupo.ilike.%{sanitized_search}%"
            )

        query = query.order("codigo").range(offset, offset + limit - 1)
        result = query.execute()

        return {
            "success": True,
            "data": result.data,
            "count": len(result.data),
            "offset": offset,
            "limit": limit,
        }

    except Exception as e:
        logger.error("list_cnae_error", error=str(e))
        raise HTTPException(status_code=500, detail=str(e))


# ===========================================
# ENRICHMENT ENDPOINTS
# ===========================================


@app.post("/api/enrich/people", tags=["Enrichment"])
@limiter.limit("100/minute")
async def enrich_people(
    request: Request,
    limit: int = Query(default=10, ge=1, le=100),
    current_user=Depends(get_current_user),
):
    """
    Enrich people data using Apollo/Perplexity.
    Requires authentication.
    """
    if not settings.supabase_url or not settings.supabase_service_key:
        raise HTTPException(status_code=500, detail="Supabase not configured")

    if not settings.apollo_api_key and not settings.perplexity_api_key:
        raise HTTPException(status_code=500, detail="Neither Apollo nor Perplexity API configured")

    try:
        # Create Supabase client
        supabase = create_client(settings.supabase_url, settings.supabase_service_key)

        # Get people without enrichment
        result = (
            supabase.table("dim_pessoas")
            .select("id, nome_completo, linkedin_url")
            .is_("raw_apollo_data", "null")
            .limit(limit)
            .execute()
        )

        people = result.data
        if not people:
            return {
                "success": True,
                "message": "No people pending enrichment",
                "stats": {"processed": 0},
            }

        # Create enrichment service
        service = PersonEnrichmentService(
            supabase=supabase,
            apollo_api_key=settings.apollo_api_key,
            perplexity_api_key=settings.perplexity_api_key,
        )

        stats = {"processed": 0, "success": 0, "failed": 0, "linkedin_found": 0}

        for pessoa in people:
            nome = pessoa.get("nome_completo", "Unknown")

            try:
                enrichment = await service.enrich_person(
                    pessoa_id=pessoa["id"],
                    nome=nome,
                    linkedin_url=pessoa.get("linkedin_url"),
                )

                stats["processed"] += 1

                if enrichment["success"]:
                    stats["success"] += 1
                    raw_data = enrichment.get("raw_data", {})
                    linkedin = raw_data.get("linkedin_url") if raw_data else None

                    if linkedin:
                        stats["linkedin_found"] += 1
                        supabase.table("dim_pessoas").update(
                            {
                                "linkedin_url": linkedin,
                                "raw_apollo_data": raw_data,
                            }
                        ).eq("id", pessoa["id"]).execute()
                    else:
                        supabase.table("dim_pessoas").update(
                            {
                                "raw_apollo_data": raw_data,
                            }
                        ).eq("id", pessoa["id"]).execute()
                else:
                    stats["failed"] += 1

            except Exception as e:
                stats["failed"] += 1
                logger.error("enrichment_error", pessoa=nome, error=str(e))

        return {
            "success": True,
            "message": f"Enrichment completed for {stats['processed']} people",
            "stats": stats,
        }

    except Exception as e:
        logger.error("enrich_people_error", error=str(e))
        raise HTTPException(status_code=500, detail=str(e))


# ===========================================
# STATS ENDPOINTS (Dashboard Badges)
# ===========================================


class StatsCategory(str, Enum):
    """Categorias de estatisticas."""

    EMPRESAS = "empresas"
    PESSOAS = "pessoas"
    POLITICOS = "politicos"
    NOTICIAS = "noticias"


class StatsHistoryResponse(BaseModel):
    """Schema de resposta do historico."""

    categoria: str
    data: list
    total_atual: int
    crescimento_percentual: float
    primeiro_registro: Optional[str]
    ultimo_registro: Optional[str]


def _get_safe_count(client, table: str) -> int:
    """Safe count that handles empty/missing tables."""
    try:
        r = client.from_(table).select("id", count="estimated", head=True).execute()
        return r.count or 0
    except Exception:
        return 0


def _get_all_counts(supabase_client, brasil_data_hub_client):
    """Get all current counts from all sources."""
    empresas = _get_safe_count(supabase_client, "dim_empresas")
    pessoas = _get_safe_count(supabase_client, "dim_pessoas")
    noticias = _get_safe_count(supabase_client, "dim_noticias")

    politicos = 0
    mandatos = 0
    emendas = 0
    if brasil_data_hub_client:
        politicos = _get_safe_count(brasil_data_hub_client, "dim_politicos")
        mandatos = _get_safe_count(brasil_data_hub_client, "fato_politicos_mandatos")
        emendas = _get_safe_count(brasil_data_hub_client, "fato_emendas_parlamentares")

    return {
        "empresas": empresas,
        "pessoas": pessoas,
        "politicos": politicos,
        "mandatos": mandatos,
        "emendas": emendas,
        "noticias": noticias,
    }


def _get_clients():
    """Get Supabase clients."""
    supabase_client = create_client(settings.supabase_url, settings.supabase_service_key)
    brasil_data_hub_client = None
    if settings.brasil_data_hub_url and settings.brasil_data_hub_key:
        brasil_data_hub_client = create_client(
            settings.brasil_data_hub_url, settings.brasil_data_hub_key
        )
    return supabase_client, brasil_data_hub_client


# Mapeamento categoria → (source, table)
# Mapeamento categoria → (source, table, created_at_column)
# NOTA: dim_pessoas (não fato_pessoas) é a tabela real de pessoas
# brasil-data-hub usa 'criado_em' em vez de 'created_at'
CATEGORY_TABLE_MAP = {
    "empresas": ("local", "dim_empresas", "created_at"),
    "pessoas": ("local", "dim_pessoas", "created_at"),
    "noticias": ("local", "dim_noticias", "created_at"),
    "politicos": ("brasil_data_hub", "dim_politicos", "criado_em"),
    "mandatos": ("brasil_data_hub", "fato_politicos_mandatos", "criado_em"),
    "emendas": ("brasil_data_hub", "fato_emendas_parlamentares", "criado_em"),
}


@app.get("/api/stats/current", tags=["Stats"])
@limiter.limit("100/minute")
async def get_current_stats(request: Request):
    """
    Retorna contagens atuais + today_inserts + % crescimento vs dia anterior.
    Usado pelos badges do dashboard.
    """
    if not settings.supabase_url or not settings.supabase_service_key:
        raise HTTPException(status_code=500, detail="Supabase not configured")

    try:
        supabase_client, brasil_data_hub_client = _get_clients()
        counts = _get_all_counts(supabase_client, brasil_data_hub_client)

        from datetime import date as date_type

        hoje = date_type.today()
        ontem = hoje - timedelta(days=1)

        # Buscar historico de ontem
        historico_ontem = supabase_client.from_("stats_historico").select("*").eq(
            "data", ontem.isoformat()
        ).execute()

        ontem_dict = {}
        for row in historico_ontem.data or []:
            ontem_dict[row["categoria"]] = row["total"]

        # Montar resposta com crescimento
        stats = []
        for cat, total in counts.items():
            total_ontem = ontem_dict.get(cat, total)
            today_inserts = max(0, total - total_ontem)
            crescimento = ((total - total_ontem) / total_ontem) * 100 if total_ontem > 0 else 0.0

            stats.append({
                "categoria": cat,
                "total": total,
                "total_ontem": total_ontem,
                "today_inserts": today_inserts,
                "crescimento_percentual": round(crescimento, 2),
            })

        return {
            "success": True,
            "stats": stats,
            "data_referencia": hoje.isoformat(),
            "online": True,
            "proxima_atualizacao_segundos": 300,
            "timestamp": datetime.now().isoformat(),
        }

    except Exception as e:
        logger.error("get_current_stats_error", error=str(e))
        raise HTTPException(status_code=500, detail=str(e))


@app.get("/api/stats/history", tags=["Stats"])
@limiter.limit("100/minute")
async def get_stats_history(
    request: Request,
    categoria: Optional[str] = Query(default=None, description="Filtrar por categoria"),
    limit: int = Query(default=365, ge=1, le=1000),
):
    """
    Retorna historico CUMULATIVO de estatisticas para graficos.
    Cada point.value = total acumulado naquela data.
    Grafico cumulativo: monotonicamente crescente, nunca plato.
    """
    if not settings.supabase_url or not settings.supabase_service_key:
        raise HTTPException(status_code=500, detail="Supabase not configured")

    try:
        supabase_client, brasil_data_hub_client = _get_clients()

        query = supabase_client.from_("stats_historico").select("*").order("data", desc=False)

        if categoria:
            query = query.eq("categoria", categoria)

        query = query.limit(limit)
        result = query.execute()

        # Agrupar por categoria
        raw_by_category = {}
        for row in result.data or []:
            cat = row["categoria"]
            if cat not in raw_by_category:
                raw_by_category[cat] = []
            raw_by_category[cat].append({
                "data": row["data"],
                "total": row["total"],
            })

        # Obter contagens atuais para today_inserts
        counts = _get_all_counts(supabase_client, brasil_data_hub_client)
        from datetime import date as date_type
        hoje_iso = date_type.today().isoformat()

        # Montar resposta no formato esperado pelo frontend
        historico = {}
        for cat, accumulated in raw_by_category.items():
            # Preencher gaps de datas (carry forward last known total)
            filled = _fill_date_gaps_cumulative(accumulated)

            # Today's inserts = current live count - last snapshot total
            last_snapshot_total = accumulated[-1]["total"] if accumulated else 0
            current_total = counts.get(cat, 0)
            today_inserts = max(0, current_total - last_snapshot_total)

            # Garantir hoje na serie com contagem live
            if filled and filled[-1]["data"] == hoje_iso:
                filled[-1]["value"] = max(filled[-1]["value"], current_total)
            elif filled:
                # Preencher gap ate hoje
                from datetime import date as date_cls
                last_date = date_cls.fromisoformat(filled[-1]["data"])
                today_date = date_cls.fromisoformat(hoje_iso)
                last_val = filled[-1]["value"]
                d = last_date + timedelta(days=1)
                while d < today_date:
                    filled.append({"data": d.isoformat(), "value": last_val})
                    d += timedelta(days=1)
                filled.append({"data": hoje_iso, "value": current_total})

            # Period growth = newest - oldest
            period_growth = 0
            if len(filled) >= 2:
                period_growth = filled[-1]["value"] - filled[0]["value"]

            historico[cat] = {
                "unit": "registros",
                "timezone": "America/Sao_Paulo",
                "today": today_inserts,
                "periodTotal": period_growth,
                "points": filled,
            }

        return {
            "success": True,
            "historico": historico,
            "categorias": list(historico.keys()),
            "total_registros": len(result.data or []),
            "timestamp": datetime.now().isoformat(),
        }

    except Exception as e:
        logger.error("get_stats_history_error", error=str(e))
        raise HTTPException(status_code=500, detail=str(e))


@app.get("/api/stats/diagnostic", tags=["Stats"])
@limiter.limit("100/minute")
async def get_stats_diagnostic(request: Request):
    """
    Diagnostico: contagem, latencia e erros por categoria + status do cache.
    """
    try:
        supabase_client, brasil_data_hub_client = _get_clients()
        results = {}

        for cat, (source, table, _col) in CATEGORY_TABLE_MAP.items():
            client = brasil_data_hub_client if source == "brasil_data_hub" else supabase_client
            if not client:
                results[cat] = {"table": table, "count": 0, "error": "no client configured", "latency_ms": 0}
                continue

            import time
            start = time.time()
            try:
                resp = client.from_(table).select("id", count="estimated").limit(0).execute()
                count_val = resp.count if resp.count is not None else 0
                results[cat] = {
                    "table": table,
                    "count": count_val,
                    "error": None,
                    "latency_ms": round((time.time() - start) * 1000),
                    "client": source,
                }
            except Exception as err:
                results[cat] = {
                    "table": table,
                    "count": 0,
                    "error": str(err),
                    "latency_ms": round((time.time() - start) * 1000),
                }

        # Historico count por categoria
        hist_resp = supabase_client.from_("stats_historico").select("categoria").order(
            "data", desc=True
        ).limit(100).execute()

        hist_count = {}
        for row in hist_resp.data or []:
            cat = row["categoria"]
            hist_count[cat] = hist_count.get(cat, 0) + 1

        return {
            "success": True,
            "categories": results,
            "stats_historico_rows": hist_count,
        }

    except Exception as e:
        logger.error("get_stats_diagnostic_error", error=str(e))
        raise HTTPException(status_code=500, detail=str(e))


def _fill_date_gaps_cumulative(points: list) -> list:
    """
    Preenche gaps de datas carregando o ultimo total conhecido.
    Input: [{data: 'YYYY-MM-DD', total: int}] sorted asc.
    Output: [{data: 'YYYY-MM-DD', value: int}] sem gaps.
    """
    if not points:
        return []
    if len(points) == 1:
        return [{"data": points[0]["data"], "value": points[0]["total"]}]

    from datetime import date as date_cls

    date_map = {p["data"]: p["total"] for p in points}
    start = date_cls.fromisoformat(points[0]["data"])
    end = date_cls.fromisoformat(points[-1]["data"])

    result = []
    current = start
    last_known = points[0]["total"]

    while current <= end:
        d_str = current.isoformat()
        if d_str in date_map:
            last_known = date_map[d_str]
        result.append({"data": d_str, "value": last_known})
        current += timedelta(days=1)

    return result


@app.post("/api/stats/backfill", tags=["Stats"])
@limiter.limit("100/minute")
async def backfill_stats_history(
    request: Request,
    days: int = Query(default=30, ge=7, le=365),
):
    """
    Popula stats_historico com dados retroativos (acumulacao PARA FRENTE).

    Estrategia matematicamente correta:
    1. Conta insercoes diarias via created_at/criado_em nas tabelas fonte
    2. Calcula total base = total_atual - soma_insercoes_no_periodo
    3. Acumula para frente: dia_N = dia_N-1 + insercoes_dia_N
    4. Ultimo dia = contagem REAL atual (mostra reducoes por dedup)

    Isto garante que:
    - Bulk imports aparecem como saltos reais no grafico
    - Reducoes (deduplicacao) aparecem como queda real
    - O grafico e matematicamente honesto
    """
    if not settings.supabase_url or not settings.supabase_service_key:
        raise HTTPException(status_code=500, detail="Supabase not configured")

    try:
        supabase_client, brasil_data_hub_client = _get_clients()
        counts = _get_all_counts(supabase_client, brasil_data_hub_client)

        from datetime import date as date_cls

        hoje = date_cls.today()
        dates = [(hoje - timedelta(days=i)).isoformat() for i in range(days - 1, -1, -1)]

        results = {}
        total_upserted = 0

        for cat, (source, table, col) in CATEGORY_TABLE_MAP.items():
            client = supabase_client if source == "local" else brasil_data_hub_client
            if not client:
                results[cat] = {"skipped": True, "reason": "no client"}
                continue

            # 1. Contar insercoes diarias via created_at/criado_em
            daily_inserts = []
            for d_str in dates:
                # Sao Paulo midnight = 03:00 UTC
                day_start = f"{d_str}T03:00:00.000Z"
                next_day = (date_cls.fromisoformat(d_str) + timedelta(days=1)).isoformat()
                day_end = f"{next_day}T03:00:00.000Z"

                try:
                    # 'planned' usa EXPLAIN (considera WHERE, muito mais rapido que 'exact')
                    # Para tabelas 64M+ rows, 'exact' causa timeout no Supabase
                    r = (
                        client.from_(table)
                        .select("id", count="planned", head=True)
                        .gte(col, day_start)
                        .lt(col, day_end)
                        .execute()
                    )
                    daily_inserts.append({"date": d_str, "count": r.count or 0})
                except Exception:
                    daily_inserts.append({"date": d_str, "count": 0})

            # 2. Calcular total base (antes do periodo)
            current_total = counts.get(cat, 0)
            total_period_inserts = sum(di["count"] for di in daily_inserts)
            starting_total = max(0, current_total - total_period_inserts)

            # 3. Acumular PARA FRENTE (matematicamente correto)
            snapshots = []
            running = starting_total
            for entry in daily_inserts:
                running += entry["count"]
                snapshots.append({
                    "data": entry["date"],
                    "categoria": cat,
                    "total": running,
                })

            # 4. Ultimo dia = contagem REAL atual (mostra reducao por dedup)
            if snapshots:
                snapshots[-1]["total"] = current_total

            # 5. Upsert todos
            for snap in snapshots:
                try:
                    supabase_client.from_("stats_historico").upsert(
                        snap, on_conflict="data,categoria"
                    ).execute()
                    total_upserted += 1
                except Exception as e:
                    logger.warning("backfill_upsert_failed", snap=snap, error=str(e))

            oldest = snapshots[0] if snapshots else None
            newest = snapshots[-1] if snapshots else None
            results[cat] = {
                "days": len(snapshots),
                "currentTotal": current_total,
                "totalPeriodInserts": total_period_inserts,
                "startingTotal": starting_total,
                "oldestDate": oldest["data"] if oldest else None,
                "oldestTotal": oldest["total"] if oldest else None,
                "newestDate": newest["data"] if newest else None,
                "newestTotal": newest["total"] if newest else None,
            }

            logger.info("backfill_category", categoria=cat, **results[cat])

        logger.info("stats_backfill_complete", total_upserted=total_upserted, days=days)

        return {
            "success": True,
            "message": f"Backfill completo: {total_upserted} registros em {days} dias",
            "days": days,
            "totalUpserted": total_upserted,
            "results": results,
            "timestamp": datetime.now().isoformat(),
        }

    except Exception as e:
        logger.error("backfill_error", error=str(e))
        raise HTTPException(status_code=500, detail=str(e))


@app.post("/api/stats/snapshot", tags=["Stats"])
@limiter.limit("100/minute")
async def create_stats_snapshot(request: Request):
    """
    Cria um snapshot das estatisticas atuais.
    Chamado pelo cron job a cada 5 minutos.
    """
    if not settings.supabase_url or not settings.supabase_service_key:
        raise HTTPException(status_code=500, detail="Supabase not configured")

    try:
        supabase = create_client(settings.supabase_url, settings.supabase_service_key)

        # Cliente Brasil Data Hub
        brasil_data_hub = None
        if settings.brasil_data_hub_url and settings.brasil_data_hub_key:
            brasil_data_hub = create_client(
                settings.brasil_data_hub_url, settings.brasil_data_hub_key
            )

        from datetime import date

        hoje = date.today()

        # Contagens atuais - use safe_count to handle empty/missing tables
        def safe_count(client, table):
            try:
                r = client.from_(table).select("id", count="estimated", head=True).execute()
                return r.count or 0
            except Exception:
                return 0

        empresas_count = safe_count(supabase, "dim_empresas")
        pessoas_count = safe_count(supabase, "dim_pessoas")
        noticias_count = safe_count(supabase, "dim_noticias")

        politicos_count = 0
        mandatos_count = 0
        emendas_count = 0
        if brasil_data_hub:
            politicos_count = safe_count(brasil_data_hub, "dim_politicos")
            mandatos_count = safe_count(brasil_data_hub, "fato_politicos_mandatos")
            emendas_count = safe_count(brasil_data_hub, "fato_emendas_parlamentares")

        # Upsert para cada categoria
        snapshots = [
            {"data": hoje.isoformat(), "categoria": "empresas", "total": empresas_count},
            {"data": hoje.isoformat(), "categoria": "pessoas", "total": pessoas_count},
            {"data": hoje.isoformat(), "categoria": "politicos", "total": politicos_count},
            {"data": hoje.isoformat(), "categoria": "mandatos", "total": mandatos_count},
            {"data": hoje.isoformat(), "categoria": "emendas", "total": emendas_count},
            {"data": hoje.isoformat(), "categoria": "noticias", "total": noticias_count},
        ]

        for snap in snapshots:
            # Upsert - atualiza se existe, insere se nao
            supabase.from_("stats_historico").upsert(
                snap, on_conflict="data,categoria"
            ).execute()

        logger.info("stats_snapshot_created", date=hoje.isoformat(), snapshots=snapshots)

        return {
            "success": True,
            "message": "Snapshot criado com sucesso",
            "data": hoje.isoformat(),
            "snapshots": snapshots,
        }

    except Exception as e:
        logger.error("create_stats_snapshot_error", error=str(e))
        raise HTTPException(status_code=500, detail=str(e))


# ===========================================
# STARTUP
# ===========================================


@app.on_event("startup")
async def startup():
    logger.info("api_starting", version=APP_VERSION)

    # Seed super admin from env vars
    try:
        from api.seed import seed_super_admin

        await seed_super_admin()
    except Exception as e:
        logger.warning("seed_admin_startup_failed", error=str(e))

    # Iniciar cron job de stats snapshot (a cada 5 min)
    try:
        from api.cron.stats_snapshot import stats_snapshot_job

        stats_snapshot_job.start()
        logger.info("stats_snapshot_cron_started")
    except Exception as e:
        logger.warning("stats_snapshot_cron_failed", error=str(e))


@app.on_event("shutdown")
async def shutdown():
    """Para cron jobs no shutdown."""
    try:
        from api.cron.stats_snapshot import stats_snapshot_job

        stats_snapshot_job.stop()
        logger.info("stats_snapshot_cron_stopped")
    except Exception as e:
        logger.warning("stats_snapshot_cron_stop_failed", error=str(e))


if __name__ == "__main__":
    import uvicorn

    uvicorn.run(app, host="0.0.0.0", port=8000)
