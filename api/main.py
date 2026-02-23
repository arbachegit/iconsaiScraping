"""
IconsAI Scraping API - v3.0 (Clean Architecture)
"""

import os
import re
from datetime import datetime, timedelta
from enum import Enum
from pathlib import Path
from typing import List, Optional

import structlog
from fastapi import Depends, FastAPI, HTTPException, Query, status
from fastapi.middleware.cors import CORSMiddleware
from pydantic import BaseModel, ConfigDict, EmailStr, Field, field_validator
from supabase import create_client

from api.auth import (
    ACCESS_TOKEN_EXPIRE_MINUTES,
    Token,
    TokenData,
    UserLogin,
    UserResponse,
    UserUpdate,
    authenticate_user,
    create_access_token,
    get_current_user,
    hash_password,
    update_user,
)
from backend.src.services.person_enrichment import PersonEnrichmentService
from config.settings import settings

logger = structlog.get_logger()


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
# AUTH ENDPOINTS
# ===========================================


@app.post("/auth/login", response_model=Token, tags=["Auth"])
async def login(user_data: UserLogin):
    """User login"""
    user = await authenticate_user(user_data.email, user_data.password)
    if not user:
        raise HTTPException(
            status_code=status.HTTP_401_UNAUTHORIZED,
            detail="Email ou senha incorretos",
        )

    access_token = create_access_token(
        data={
            "sub": user["email"],
            "user_id": user.get("id"),
            "name": user.get("name"),
            "role": user.get("role", "user"),
            "permissions": user.get("permissions", []),
        },
        expires_delta=timedelta(minutes=ACCESS_TOKEN_EXPIRE_MINUTES),
    )

    return {"access_token": access_token, "token_type": "bearer"}


@app.get("/auth/me", response_model=UserResponse, tags=["Auth"])
async def get_me(current_user=Depends(get_current_user)):
    """Get current user info"""
    return {
        "id": current_user.user_id or 0,
        "email": current_user.email,
        "name": current_user.name,
        "role": current_user.role or "user",
    }


@app.put("/auth/me", tags=["Auth"])
async def update_me(update_data: UserUpdate, current_user=Depends(get_current_user)):
    """Update current user"""
    result = await update_user(current_user.email, update_data)
    if not result:
        raise HTTPException(status_code=400, detail="Erro ao atualizar usuario")
    return {"message": "Usuario atualizado"}


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
async def list_cnae(
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
async def enrich_people(
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
# ADMIN ENDPOINTS
# ===========================================


class UserRole(str, Enum):
    """Roles de usuario do sistema."""

    USER = "user"
    ADMIN = "admin"
    SUPER_ADMIN = "super_admin"


class AdminUserCreate(BaseModel):
    """Schema para criacao de usuario."""

    model_config = ConfigDict(str_strip_whitespace=True, extra="forbid")

    name: str = Field(min_length=2, max_length=100)
    email: EmailStr
    password: str = Field(min_length=6, max_length=128)
    role: UserRole = Field(default=UserRole.USER)
    permissions: List[str] = Field(default_factory=list)

    @field_validator("email")
    @classmethod
    def normalize_email(cls, v: str) -> str:
        return v.lower().strip()


class AdminUserUpdate(BaseModel):
    """Schema para atualizacao de usuario."""

    model_config = ConfigDict(str_strip_whitespace=True, extra="forbid")

    name: Optional[str] = Field(default=None, min_length=2, max_length=100)
    role: Optional[UserRole] = None
    permissions: Optional[List[str]] = None
    is_active: Optional[bool] = None
    new_password: Optional[str] = Field(default=None, min_length=6, max_length=128)


class AdminUserResponse(BaseModel):
    """Schema de resposta de usuario."""

    id: int
    email: str
    name: Optional[str]
    role: str
    permissions: List[str]
    is_active: bool


def require_admin(current_user: TokenData = Depends(get_current_user)) -> TokenData:
    """Dependency que requer role super_admin."""
    if current_user.role != "super_admin":
        raise HTTPException(
            status_code=status.HTTP_403_FORBIDDEN,
            detail="Acesso negado. Requer permissao de administrador.",
        )
    return current_user


@app.get("/admin/users", tags=["Admin"])
async def list_users(current_user: TokenData = Depends(require_admin)):
    """Lista todos os usuarios."""
    if not settings.supabase_url or not settings.supabase_service_key:
        raise HTTPException(status_code=500, detail="Supabase not configured")

    try:
        supabase = create_client(settings.supabase_url, settings.supabase_service_key)
        result = supabase.table("users").select("*").order("created_at").execute()

        users = []
        for user in result.data:
            users.append({
                "id": user.get("id"),
                "email": user.get("email"),
                "name": user.get("name"),
                "role": user.get("role", "user"),
                "permissions": user.get("permissions", []),
                "is_active": user.get("is_active", True),
            })

        return {"users": users}

    except Exception as e:
        logger.error("list_users_error", error=str(e))
        raise HTTPException(status_code=500, detail=str(e))


@app.post("/admin/users", tags=["Admin"])
async def create_user(
    user_data: AdminUserCreate,
    current_user: TokenData = Depends(require_admin),
):
    """Cria novo usuario."""
    if not settings.supabase_url or not settings.supabase_service_key:
        raise HTTPException(status_code=500, detail="Supabase not configured")

    try:
        supabase = create_client(settings.supabase_url, settings.supabase_service_key)

        # Verificar se email ja existe
        existing = (
            supabase.table("users")
            .select("id")
            .eq("email", user_data.email.lower())
            .execute()
        )
        if existing.data:
            raise HTTPException(status_code=400, detail="Email ja cadastrado")

        # Criar usuario
        new_user = {
            "email": user_data.email,  # Já normalizado pelo validator
            "name": user_data.name,
            "password_hash": hash_password(user_data.password),
            "role": user_data.role.value,  # Enum para string
            "permissions": user_data.permissions,
            "is_active": True,
        }

        result = supabase.table("users").insert(new_user).execute()

        if result.data:
            logger.info("user_created", email=user_data.email, by=current_user.email)
            return {"success": True, "user": result.data[0]}

        raise HTTPException(status_code=500, detail="Erro ao criar usuario")

    except HTTPException:
        raise
    except Exception as e:
        logger.error("create_user_error", error=str(e))
        raise HTTPException(status_code=500, detail=str(e))


@app.get("/admin/users/{user_id}", tags=["Admin"])
async def get_user(
    user_id: int,
    current_user: TokenData = Depends(require_admin),
):
    """Busca usuario por ID."""
    if not settings.supabase_url or not settings.supabase_service_key:
        raise HTTPException(status_code=500, detail="Supabase not configured")

    try:
        supabase = create_client(settings.supabase_url, settings.supabase_service_key)
        result = supabase.table("users").select("*").eq("id", user_id).execute()

        if not result.data:
            raise HTTPException(status_code=404, detail="Usuario nao encontrado")

        user = result.data[0]
        return {
            "id": user.get("id"),
            "email": user.get("email"),
            "name": user.get("name"),
            "role": user.get("role", "user"),
            "permissions": user.get("permissions", []),
            "is_active": user.get("is_active", True),
        }

    except HTTPException:
        raise
    except Exception as e:
        logger.error("get_user_error", error=str(e))
        raise HTTPException(status_code=500, detail=str(e))


@app.put("/admin/users/{user_id}", tags=["Admin"])
async def update_admin_user(
    user_id: int,
    user_data: AdminUserUpdate,
    current_user: TokenData = Depends(require_admin),
):
    """Atualiza usuario."""
    if not settings.supabase_url or not settings.supabase_service_key:
        raise HTTPException(status_code=500, detail="Supabase not configured")

    try:
        supabase = create_client(settings.supabase_url, settings.supabase_service_key)

        # Verificar se usuario existe
        existing = supabase.table("users").select("id").eq("id", user_id).execute()
        if not existing.data:
            raise HTTPException(status_code=404, detail="Usuario nao encontrado")

        # Montar updates
        updates = {}
        if user_data.name is not None:
            updates["name"] = user_data.name
        if user_data.role is not None:
            updates["role"] = user_data.role.value  # Enum para string
        if user_data.permissions is not None:
            updates["permissions"] = user_data.permissions
        if user_data.is_active is not None:
            updates["is_active"] = user_data.is_active
        if user_data.new_password:
            updates["password_hash"] = hash_password(user_data.new_password)

        if not updates:
            raise HTTPException(status_code=400, detail="Nenhum campo para atualizar")

        result = supabase.table("users").update(updates).eq("id", user_id).execute()

        if result.data:
            logger.info("user_updated", user_id=user_id, by=current_user.email)
            return {"success": True, "user": result.data[0]}

        raise HTTPException(status_code=500, detail="Erro ao atualizar usuario")

    except HTTPException:
        raise
    except Exception as e:
        logger.error("update_user_error", error=str(e))
        raise HTTPException(status_code=500, detail=str(e))


@app.delete("/admin/users/{user_id}", tags=["Admin"])
async def delete_user(
    user_id: int,
    current_user: TokenData = Depends(require_admin),
):
    """Desativa usuario (soft delete)."""
    if not settings.supabase_url or not settings.supabase_service_key:
        raise HTTPException(status_code=500, detail="Supabase not configured")

    try:
        supabase = create_client(settings.supabase_url, settings.supabase_service_key)

        # Nao permitir auto-exclusao
        existing = supabase.table("users").select("email").eq("id", user_id).execute()
        if existing.data and existing.data[0]["email"] == current_user.email:
            raise HTTPException(status_code=400, detail="Nao pode desativar a si mesmo")

        # Soft delete - apenas desativar
        result = (
            supabase.table("users")
            .update({"is_active": False})
            .eq("id", user_id)
            .execute()
        )

        if result.data:
            logger.info("user_deactivated", user_id=user_id, by=current_user.email)
            return {"success": True, "message": "Usuario desativado"}

        raise HTTPException(status_code=404, detail="Usuario nao encontrado")

    except HTTPException:
        raise
    except Exception as e:
        logger.error("delete_user_error", error=str(e))
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


@app.get("/api/stats/current", tags=["Stats"])
async def get_current_stats():
    """
    Retorna contagens atuais + % crescimento vs dia anterior.
    Usado pelos badges do dashboard.
    """
    if not settings.supabase_url or not settings.supabase_service_key:
        raise HTTPException(status_code=500, detail="Supabase not configured")

    try:
        supabase = create_client(settings.supabase_url, settings.supabase_service_key)

        # Cliente Brasil Data Hub (politicos)
        brasil_data_hub = None
        if settings.brasil_data_hub_url and settings.brasil_data_hub_key:
            brasil_data_hub = create_client(
                settings.brasil_data_hub_url, settings.brasil_data_hub_key
            )

        # Contagens atuais
        empresas_result = supabase.from_("dim_empresas").select(
            "id", count="exact", head=True
        ).execute()
        pessoas_result = supabase.from_("fato_pessoas").select(
            "id", count="exact", head=True
        ).execute()
        noticias_result = supabase.from_("fato_noticias").select(
            "id", count="exact", head=True
        ).execute()

        # Politicos do Brasil Data Hub
        politicos_count = 0
        if brasil_data_hub:
            politicos_result = brasil_data_hub.from_("dim_politicos").select(
                "id", count="exact", head=True
            ).execute()
            politicos_count = politicos_result.count or 0

        # Buscar dados de ontem para calcular crescimento
        from datetime import date, timedelta

        hoje = date.today()
        ontem = hoje - timedelta(days=1)

        # Buscar historico de ontem
        historico_ontem = supabase.from_("stats_historico").select("*").eq(
            "data", ontem.isoformat()
        ).execute()

        ontem_dict = {}
        for row in historico_ontem.data or []:
            ontem_dict[row["categoria"]] = row["total"]

        # Montar resposta com crescimento
        stats = []
        categorias = [
            ("empresas", empresas_result.count or 0),
            ("pessoas", pessoas_result.count or 0),
            ("politicos", politicos_count),
            ("noticias", noticias_result.count or 0),
        ]

        for cat, total in categorias:
            total_ontem = ontem_dict.get(cat, total)
            if total_ontem > 0:
                crescimento = ((total - total_ontem) / total_ontem) * 100
            else:
                crescimento = 0.0

            stats.append({
                "categoria": cat,
                "total": total,
                "total_ontem": total_ontem,
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
async def get_stats_history(
    categoria: Optional[str] = Query(default=None, description="Filtrar por categoria"),
    limit: int = Query(default=365, ge=1, le=1000),
):
    """
    Retorna historico completo de estatisticas para graficos.
    """
    if not settings.supabase_url or not settings.supabase_service_key:
        raise HTTPException(status_code=500, detail="Supabase not configured")

    try:
        supabase = create_client(settings.supabase_url, settings.supabase_service_key)

        query = supabase.from_("stats_historico").select("*").order("data", desc=False)

        if categoria:
            query = query.eq("categoria", categoria)

        query = query.limit(limit)
        result = query.execute()

        # Agrupar por categoria
        historico_por_categoria = {}
        for row in result.data or []:
            cat = row["categoria"]
            if cat not in historico_por_categoria:
                historico_por_categoria[cat] = []
            historico_por_categoria[cat].append({
                "data": row["data"],
                "total": row["total"],
            })

        return {
            "success": True,
            "historico": historico_por_categoria,
            "categorias": list(historico_por_categoria.keys()),
            "total_registros": len(result.data or []),
            "timestamp": datetime.now().isoformat(),
        }

    except Exception as e:
        logger.error("get_stats_history_error", error=str(e))
        raise HTTPException(status_code=500, detail=str(e))


@app.post("/api/stats/snapshot", tags=["Stats"])
async def create_stats_snapshot():
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

        # Contagens atuais
        empresas = supabase.from_("dim_empresas").select(
            "id", count="exact", head=True
        ).execute()
        pessoas = supabase.from_("fato_pessoas").select(
            "id", count="exact", head=True
        ).execute()
        noticias = supabase.from_("fato_noticias").select(
            "id", count="exact", head=True
        ).execute()

        politicos_count = 0
        if brasil_data_hub:
            politicos = brasil_data_hub.from_("dim_politicos").select(
                "id", count="exact", head=True
            ).execute()
            politicos_count = politicos.count or 0

        # Upsert para cada categoria
        snapshots = [
            {"data": hoje.isoformat(), "categoria": "empresas", "total": empresas.count or 0},
            {"data": hoje.isoformat(), "categoria": "pessoas", "total": pessoas.count or 0},
            {"data": hoje.isoformat(), "categoria": "politicos", "total": politicos_count},
            {"data": hoje.isoformat(), "categoria": "noticias", "total": noticias.count or 0},
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
