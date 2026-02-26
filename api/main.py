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
from fastapi import Depends, FastAPI, HTTPException, Query, Request, status
from fastapi.middleware.cors import CORSMiddleware
from pydantic import BaseModel, ConfigDict, EmailStr, Field, field_validator
from supabase import create_client

from api.audit import log_action
from api.auth import (
    ACCESS_TOKEN_EXPIRE_MINUTES,
    TokenData,
    TokenWithRefresh,
    UserLogin,
    UserResponse,
    UserUpdate,
    authenticate_user,
    create_access_token,
    create_password_reset_token,
    create_refresh_token,
    create_set_password_token,
    decode_special_token,
    get_current_user,
    hash_password,
    update_user,
    validate_refresh_token,
)
from api.email_service import (
    send_password_reset_email,
    send_set_password_email,
    send_verification_code_email,
)
from api.encryption import field_encryption
from api.verification import create_verification_code, verify_code
from backend.src.services.person_enrichment import PersonEnrichmentService
from config.settings import settings
from src.database.client import get_supabase

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


@app.post("/auth/login", response_model=TokenWithRefresh, tags=["Auth"])
async def login(user_data: UserLogin, request: Request):
    """User login — returns access + refresh token."""
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
            "is_admin": user.get("is_admin", False),
            "permissions": user.get("permissions", []),
        },
        expires_delta=timedelta(minutes=ACCESS_TOKEN_EXPIRE_MINUTES),
    )

    refresh_token = await create_refresh_token(user["id"])

    await log_action(user["id"], "user.login", f"users/{user['id']}", request=request)

    return {
        "access_token": access_token,
        "refresh_token": refresh_token or "",
        "token_type": "bearer",
    }


@app.get("/auth/me", response_model=UserResponse, tags=["Auth"])
async def get_me(current_user=Depends(get_current_user)):
    """Get current user info"""
    return {
        "id": current_user.user_id or 0,
        "email": current_user.email,
        "name": current_user.name,
        "is_admin": current_user.is_admin,
    }


@app.put("/auth/me", tags=["Auth"])
async def update_me(update_data: UserUpdate, current_user=Depends(get_current_user)):
    """Update current user"""
    result = await update_user(current_user.email, update_data)
    if not result:
        raise HTTPException(status_code=400, detail="Erro ao atualizar usuario")
    return {"message": "Usuario atualizado"}


# ===========================================
# AUTH LEVEL 1 - NEW ENDPOINTS
# ===========================================


class SetPasswordRequest(BaseModel):
    """Schema para definir senha via token."""

    model_config = ConfigDict(str_strip_whitespace=True, extra="forbid")

    token: str
    password: str = Field(min_length=8, max_length=128)

    @field_validator("password")
    @classmethod
    def validate_password_strength(cls, v: str) -> str:
        if not re.search(r"[A-Z]", v):
            raise ValueError("Senha deve ter ao menos 1 letra maiúscula")
        if not re.search(r"[0-9]", v):
            raise ValueError("Senha deve ter ao menos 1 número")
        return v


class VerifyCodeRequest(BaseModel):
    """Schema para verificacao de codigo."""

    model_config = ConfigDict(str_strip_whitespace=True, extra="forbid")

    email: EmailStr
    code: str = Field(min_length=6, max_length=6, pattern=r"^\d{6}$")

    @field_validator("email")
    @classmethod
    def normalize_email(cls, v: str) -> str:
        return v.lower().strip()


class RecoverPasswordRequest(BaseModel):
    """Schema para solicitar recuperacao de senha."""

    model_config = ConfigDict(str_strip_whitespace=True, extra="forbid")

    email: EmailStr

    @field_validator("email")
    @classmethod
    def normalize_email(cls, v: str) -> str:
        return v.lower().strip()


class ResendCodeRequest(BaseModel):
    """Schema para reenvio de codigo."""

    model_config = ConfigDict(str_strip_whitespace=True, extra="forbid")

    email: EmailStr
    code_type: str = Field(default="activation", pattern=r"^(activation|password_reset)$")

    @field_validator("email")
    @classmethod
    def normalize_email(cls, v: str) -> str:
        return v.lower().strip()


class ResetPasswordRequest(BaseModel):
    """Schema para redefinir senha."""

    model_config = ConfigDict(str_strip_whitespace=True, extra="forbid")

    token: str
    new_password: str = Field(min_length=8, max_length=128)
    code: str = Field(min_length=6, max_length=6, pattern=r"^\d{6}$")

    @field_validator("new_password")
    @classmethod
    def validate_password_strength(cls, v: str) -> str:
        if not re.search(r"[A-Z]", v):
            raise ValueError("Senha deve ter ao menos 1 letra maiúscula")
        if not re.search(r"[0-9]", v):
            raise ValueError("Senha deve ter ao menos 1 número")
        return v


class RefreshTokenRequest(BaseModel):
    """Schema para renovar access token."""

    model_config = ConfigDict(extra="forbid")

    refresh_token: str


@app.post("/auth/admin/create-user", tags=["Auth Level 1"])
async def admin_create_user_flow(
    request: Request,
    name: str = Query(..., min_length=2, max_length=100),
    email: EmailStr = Query(...),
    cpf: Optional[str] = Query(default=None),
    phone: Optional[str] = Query(default=None),
    current_user: TokenData = Depends(get_current_user),
):
    """
    Admin creates a user WITHOUT password.
    Sends set-password token via email.
    """
    if not current_user.is_admin:
        raise HTTPException(status_code=403, detail="Acesso negado. Requer administrador.")

    supabase = get_supabase()
    if not supabase:
        raise HTTPException(status_code=500, detail="Supabase not configured")

    normalized_email = email.lower().strip()

    # Check if email already exists
    existing = supabase.table("users").select("id").eq("email", normalized_email).execute()
    if existing.data:
        raise HTTPException(status_code=400, detail="Email ja cadastrado")

    # Encrypt sensitive fields
    cpf_encrypted = None
    phone_encrypted = None
    if cpf and field_encryption.is_configured:
        try:
            cpf_encrypted = field_encryption.encrypt_cpf(cpf)
        except ValueError as e:
            raise HTTPException(status_code=400, detail=str(e))
    if phone and field_encryption.is_configured:
        try:
            phone_encrypted = field_encryption.encrypt_phone(phone)
        except ValueError as e:
            raise HTTPException(status_code=400, detail=str(e))

    # Create user without password (password_hash placeholder)
    new_user = {
        "email": normalized_email,
        "name": name,
        "password_hash": "",  # No password yet
        "is_admin": False,
        "permissions": [],
        "is_active": True,
        "is_verified": False,
        "cpf_encrypted": cpf_encrypted,
        "phone_encrypted": phone_encrypted,
    }

    try:
        result = supabase.table("users").insert(new_user).execute()
        if not result.data:
            raise HTTPException(status_code=500, detail="Erro ao criar usuario")

        created_user = result.data[0]
        user_id = created_user["id"]

        # Generate set-password token
        set_pwd_token = create_set_password_token(user_id, normalized_email)

        # Send email
        await send_set_password_email(normalized_email, name, set_pwd_token)

        # Audit log
        await log_action(
            current_user.user_id,
            "admin.user_created",
            f"users/{user_id}",
            details={"email": normalized_email},
            request=request,
        )

        logger.info("admin_user_created", email=normalized_email, by=current_user.email)

        return {
            "success": True,
            "user_id": user_id,
            "email": normalized_email,
            "message": "Usuario criado. Email enviado com token para definir senha.",
        }

    except HTTPException:
        raise
    except Exception as e:
        logger.error("admin_create_user_error", error=str(e))
        raise HTTPException(status_code=500, detail="Erro interno ao criar usuario")


@app.post("/auth/set-password", tags=["Auth Level 1"])
async def set_password(data: SetPasswordRequest, request: Request):
    """
    User sets initial password using a set-password token.
    After setting password, a 6-digit activation code is sent.
    """
    payload = decode_special_token(data.token, "set_password")
    if not payload:
        raise HTTPException(status_code=400, detail="Token invalido ou expirado")

    user_id = payload.get("user_id")
    email = payload.get("sub")

    if not user_id or not email:
        raise HTTPException(status_code=400, detail="Token malformado")

    supabase = get_supabase()
    if not supabase:
        raise HTTPException(status_code=500, detail="Supabase not configured")

    # Verify user exists and has no password yet
    user_result = supabase.table("users").select("*").eq("id", user_id).execute()
    if not user_result.data:
        raise HTTPException(status_code=404, detail="Usuario nao encontrado")

    user = user_result.data[0]
    if user.get("is_verified"):
        raise HTTPException(status_code=400, detail="Usuario ja verificado")

    # Set password
    supabase.table("users").update(
        {"password_hash": hash_password(data.password)}
    ).eq("id", user_id).execute()

    # Generate and send activation code
    code = await create_verification_code(user_id, "activation")
    if code:
        await send_verification_code_email(email, code, "activation")

    await log_action(user_id, "user.password_set", f"users/{user_id}", request=request)

    return {
        "success": True,
        "message": "Senha definida. Codigo de ativacao enviado para o email.",
        "email": email,
    }


@app.post("/auth/verify", tags=["Auth Level 1"])
async def verify_account(data: VerifyCodeRequest, request: Request):
    """
    Verify account with 6-digit code.
    Activates the user account.
    """
    supabase = get_supabase()
    if not supabase:
        raise HTTPException(status_code=500, detail="Supabase not configured")

    # Find user
    user_result = (
        supabase.table("users")
        .select("id, is_verified")
        .eq("email", data.email)
        .limit(1)
        .execute()
    )
    if not user_result.data:
        raise HTTPException(status_code=404, detail="Usuario nao encontrado")

    user = user_result.data[0]
    if user.get("is_verified"):
        return {"success": True, "message": "Conta ja verificada."}

    # Verify code
    is_valid = await verify_code(user["id"], data.code, "activation")
    if not is_valid:
        raise HTTPException(status_code=400, detail="Codigo invalido ou expirado")

    # Activate account
    supabase.table("users").update({"is_verified": True}).eq("id", user["id"]).execute()

    await log_action(user["id"], "user.verified", f"users/{user['id']}", request=request)

    return {"success": True, "message": "Conta ativada com sucesso."}


@app.post("/auth/resend-code", tags=["Auth Level 1"])
async def resend_code(data: ResendCodeRequest, request: Request):
    """Resend verification code. Always returns success to prevent enumeration."""
    supabase = get_supabase()
    if not supabase:
        raise HTTPException(status_code=500, detail="Supabase not configured")

    user_result = (
        supabase.table("users")
        .select("id, email")
        .eq("email", data.email)
        .eq("is_active", True)
        .limit(1)
        .execute()
    )

    if user_result.data:
        user = user_result.data[0]
        code = await create_verification_code(user["id"], data.code_type)
        if code:
            await send_verification_code_email(user["email"], code, data.code_type)

    return {
        "success": True,
        "message": "Se o email estiver cadastrado, um novo codigo sera enviado.",
    }


@app.post("/auth/recover-password", tags=["Auth Level 1"])
async def recover_password(data: RecoverPasswordRequest, request: Request):
    """
    Request password recovery.
    Sends a reset token + 6-digit code via email.
    Always returns success to prevent email enumeration.
    """
    supabase = get_supabase()
    if not supabase:
        raise HTTPException(status_code=500, detail="Supabase not configured")

    user_result = (
        supabase.table("users")
        .select("id, email")
        .eq("email", data.email)
        .eq("is_active", True)
        .limit(1)
        .execute()
    )

    if user_result.data:
        user = user_result.data[0]
        # Generate reset token
        reset_token = create_password_reset_token(user["id"], user["email"])

        # Generate verification code
        code = await create_verification_code(user["id"], "password_reset")

        if code:
            await send_verification_code_email(user["email"], code, "password_reset")
        await send_password_reset_email(user["email"], reset_token)

        await log_action(
            user["id"], "user.password_recovery_requested", f"users/{user['id']}", request=request
        )

    # Always return success to prevent email enumeration
    return {
        "success": True,
        "message": "Se o email estiver cadastrado, enviaremos instrucoes de recuperacao.",
    }


@app.post("/auth/reset-password", tags=["Auth Level 1"])
async def reset_password(data: ResetPasswordRequest, request: Request):
    """
    Reset password with token + 6-digit verification code.
    """
    payload = decode_special_token(data.token, "password_reset")
    if not payload:
        raise HTTPException(status_code=400, detail="Token invalido ou expirado")

    user_id = payload.get("user_id")
    if not user_id:
        raise HTTPException(status_code=400, detail="Token malformado")

    # Verify the 6-digit code
    is_valid = await verify_code(user_id, data.code, "password_reset")
    if not is_valid:
        raise HTTPException(status_code=400, detail="Codigo invalido ou expirado")

    supabase = get_supabase()
    if not supabase:
        raise HTTPException(status_code=500, detail="Supabase not configured")

    # Update password
    supabase.table("users").update(
        {"password_hash": hash_password(data.new_password)}
    ).eq("id", user_id).execute()

    await log_action(user_id, "user.password_reset", f"users/{user_id}", request=request)

    return {"success": True, "message": "Senha redefinida com sucesso."}


@app.post("/auth/refresh", tags=["Auth Level 1"])
async def refresh_access_token(data: RefreshTokenRequest, request: Request):
    """
    Refresh access token using a valid refresh token.
    The old refresh token is revoked and a new one is issued (rotation).
    """
    user = await validate_refresh_token(data.refresh_token)
    if not user:
        raise HTTPException(status_code=401, detail="Refresh token invalido ou expirado")

    # Create new access token
    access_token = create_access_token(
        data={
            "sub": user["email"],
            "user_id": user.get("id"),
            "name": user.get("name"),
            "is_admin": user.get("is_admin", False),
            "permissions": user.get("permissions", []),
        },
        expires_delta=timedelta(minutes=ACCESS_TOKEN_EXPIRE_MINUTES),
    )

    # Create new refresh token (rotation)
    new_refresh_token = await create_refresh_token(user["id"])

    await log_action(user["id"], "user.token_refreshed", f"users/{user['id']}", request=request)

    return {
        "access_token": access_token,
        "refresh_token": new_refresh_token or "",
        "token_type": "bearer",
    }


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


class AdminUserCreate(BaseModel):
    """Schema para criacao de usuario."""

    model_config = ConfigDict(str_strip_whitespace=True, extra="forbid")

    name: str = Field(min_length=2, max_length=100)
    email: EmailStr
    password: str = Field(min_length=6, max_length=128)
    is_admin: bool = False
    permissions: List[str] = Field(default_factory=list)

    @field_validator("email")
    @classmethod
    def normalize_email(cls, v: str) -> str:
        return v.lower().strip()


class AdminUserUpdate(BaseModel):
    """Schema para atualizacao de usuario."""

    model_config = ConfigDict(str_strip_whitespace=True, extra="forbid")

    name: Optional[str] = Field(default=None, min_length=2, max_length=100)
    is_admin: Optional[bool] = None
    permissions: Optional[List[str]] = None
    is_active: Optional[bool] = None
    new_password: Optional[str] = Field(default=None, min_length=6, max_length=128)


class AdminUserResponse(BaseModel):
    """Schema de resposta de usuario."""

    id: int
    email: str
    name: Optional[str]
    is_admin: bool
    permissions: List[str]
    is_active: bool


def require_admin(current_user: TokenData = Depends(get_current_user)) -> TokenData:
    """Dependency que requer is_admin == True."""
    if not current_user.is_admin:
        raise HTTPException(
            status_code=status.HTTP_403_FORBIDDEN,
            detail="Acesso negado. Requer permissao de administrador.",
        )
    return current_user


@app.get("/admin/users", tags=["Admin"])
async def list_users(current_user: TokenData = Depends(require_admin)):
    """Lista todos os usuarios."""
    supabase = get_supabase()
    if not supabase:
        raise HTTPException(status_code=500, detail="Supabase not configured")

    try:
        result = supabase.table("users").select("*").order("created_at").execute()

        users = []
        for user in result.data:
            users.append({
                "id": user.get("id"),
                "email": user.get("email"),
                "name": user.get("name"),
                "is_admin": user.get("is_admin", False),
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
    supabase = get_supabase()
    if not supabase:
        raise HTTPException(status_code=500, detail="Supabase not configured")

    try:
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
            "is_admin": user_data.is_admin,
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
    supabase = get_supabase()
    if not supabase:
        raise HTTPException(status_code=500, detail="Supabase not configured")

    try:
        result = supabase.table("users").select("*").eq("id", user_id).execute()

        if not result.data:
            raise HTTPException(status_code=404, detail="Usuario nao encontrado")

        user = result.data[0]
        return {
            "id": user.get("id"),
            "email": user.get("email"),
            "name": user.get("name"),
            "is_admin": user.get("is_admin", False),
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
    supabase = get_supabase()
    if not supabase:
        raise HTTPException(status_code=500, detail="Supabase not configured")

    try:
        # Verificar se usuario existe
        existing = supabase.table("users").select("id").eq("id", user_id).execute()
        if not existing.data:
            raise HTTPException(status_code=404, detail="Usuario nao encontrado")

        # Montar updates
        updates = {}
        if user_data.name is not None:
            updates["name"] = user_data.name
        if user_data.is_admin is not None:
            updates["is_admin"] = user_data.is_admin
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
    supabase = get_supabase()
    if not supabase:
        raise HTTPException(status_code=500, detail="Supabase not configured")

    try:
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
    noticias = _get_safe_count(supabase_client, "fato_noticias")

    politicos = 0
    mandatos = 0
    if brasil_data_hub_client:
        politicos = _get_safe_count(brasil_data_hub_client, "dim_politicos")
        mandatos = _get_safe_count(brasil_data_hub_client, "fato_politicos_mandatos")

    return {
        "empresas": empresas,
        "pessoas": pessoas,
        "politicos": politicos,
        "mandatos": mandatos,
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
    "noticias": ("local", "fato_noticias", "created_at"),
    "politicos": ("brasil_data_hub", "dim_politicos", "criado_em"),
    "mandatos": ("brasil_data_hub", "fato_politicos_mandatos", "criado_em"),
}


@app.get("/api/stats/current", tags=["Stats"])
async def get_current_stats():
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
async def get_stats_history(
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
async def backfill_stats_history(
    days: int = Query(default=30, ge=7, le=365),
):
    """
    Popula stats_historico com dados retroativos.
    Estrategia:
    1. Conta insercoes diarias via created_at nas tabelas fonte
    2. Calcula totais acumulados de tras pra frente
    3. Upsert tudo em stats_historico
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

        for cat, (source, table) in CATEGORY_TABLE_MAP.items():
            client = supabase_client if source == "local" else brasil_data_hub_client
            if not client:
                results[cat] = {"skipped": True, "reason": "no client"}
                continue

            # Contar insercoes diarias via created_at
            daily_inserts = []
            for d_str in dates:
                # Sao Paulo midnight = 03:00 UTC
                day_start = f"{d_str}T03:00:00.000Z"
                next_day = (date_cls.fromisoformat(d_str) + timedelta(days=1)).isoformat()
                day_end = f"{next_day}T03:00:00.000Z"

                try:
                    r = (
                        client.from_(table)
                        .select("id", count="exact", head=True)
                        .gte("created_at", day_start)
                        .lt("created_at", day_end)
                        .execute()
                    )
                    daily_inserts.append({"date": d_str, "count": r.count or 0})
                except Exception:
                    daily_inserts.append({"date": d_str, "count": 0})

            # Calcular totais acumulados de tras pra frente
            current_total = counts.get(cat, 0)
            snapshots = []
            running_total = current_total

            # Do mais recente ao mais antigo
            for entry in reversed(daily_inserts):
                snapshots.append({
                    "data": entry["date"],
                    "categoria": cat,
                    "total": running_total,
                })
                running_total = max(0, running_total - entry["count"])

            # Upsert todos
            for snap in snapshots:
                try:
                    supabase_client.from_("stats_historico").upsert(
                        snap, on_conflict="data,categoria"
                    ).execute()
                    total_upserted += 1
                except Exception as e:
                    logger.warning("backfill_upsert_failed", snap=snap, error=str(e))

            oldest = snapshots[-1] if snapshots else None
            newest = snapshots[0] if snapshots else None
            results[cat] = {
                "days": len(snapshots),
                "currentTotal": current_total,
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

        # Contagens atuais - use safe_count to handle empty/missing tables
        def safe_count(client, table):
            try:
                r = client.from_(table).select("id", count="estimated", head=True).execute()
                return r.count or 0
            except Exception:
                return 0

        empresas_count = safe_count(supabase, "dim_empresas")
        pessoas_count = safe_count(supabase, "dim_pessoas")
        noticias_count = safe_count(supabase, "fato_noticias")

        politicos_count = 0
        mandatos_count = 0
        if brasil_data_hub:
            politicos_count = safe_count(brasil_data_hub, "dim_politicos")
            mandatos_count = safe_count(brasil_data_hub, "fato_politicos_mandatos")

        # Upsert para cada categoria
        snapshots = [
            {"data": hoje.isoformat(), "categoria": "empresas", "total": empresas_count},
            {"data": hoje.isoformat(), "categoria": "pessoas", "total": pessoas_count},
            {"data": hoje.isoformat(), "categoria": "politicos", "total": politicos_count},
            {"data": hoje.isoformat(), "categoria": "mandatos", "total": mandatos_count},
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
