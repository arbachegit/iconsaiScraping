"""
User controller — Admin user management endpoints.

Handles: list users, create user (direct + invite), update, delete,
         resend invite.
"""


import structlog
from fastapi import APIRouter, Depends, HTTPException, Request

from api.auth.audit_service import log_action
from api.auth.auth_middleware import require_admin
from api.auth.auth_service import create_set_password_token, hash_password
from api.auth.email_service import send_set_password_email
from api.auth.field_encryption import field_encryption
from api.auth.schemas.auth_schemas import TokenData
from api.auth.schemas.user_schemas import (
    AdminCreateUserDirect,
    AdminInviteUser,
    AdminUpdateUser,
)
from src.database.client import get_supabase

logger = structlog.get_logger()

router = APIRouter(tags=["Admin"])


# ===========================================
# ADMIN USER MANAGEMENT
# ===========================================


@router.get("/users")
async def list_users(current_user: TokenData = Depends(require_admin)):
    """Lista todos os usuarios."""
    supabase = get_supabase()
    if not supabase:
        raise HTTPException(status_code=500, detail="Supabase not configured")

    try:
        result = supabase.table("users").select("*").order("created_at").execute()

        users = []
        for user in result.data:
            # Decrypt phone if present
            phone_raw = user.get("phone_encrypted") or user.get("phone") or ""
            phone_display = ""
            if phone_raw and field_encryption:
                try:
                    phone_display = field_encryption.decrypt(phone_raw)
                except Exception:
                    phone_display = phone_raw

            # Decrypt CPF if present
            cpf_raw = user.get("cpf_encrypted") or ""
            cpf_display = ""
            if cpf_raw and field_encryption:
                try:
                    cpf_display = field_encryption.decrypt(cpf_raw)
                except Exception:
                    cpf_display = cpf_raw

            users.append({
                "id": user.get("id"),
                "email": user.get("email"),
                "name": user.get("name"),
                "phone": phone_display,
                "cpf": cpf_display,
                "is_admin": user.get("is_admin", False),
                "is_active": user.get("is_active", True),
                "is_verified": user.get("is_verified", True),
                "cep": user.get("cep") or "",
                "logradouro": user.get("logradouro") or "",
                "numero": user.get("numero") or "",
                "complemento": user.get("complemento") or "",
                "bairro": user.get("bairro") or "",
                "cidade": user.get("cidade") or "",
                "uf": user.get("uf") or "",
            })

        return {"users": users}

    except Exception as e:
        logger.error("list_users_error", error=str(e))
        raise HTTPException(status_code=500, detail=str(e))


@router.post("/users")
async def create_user(
    user_data: AdminCreateUserDirect,
    request: Request,
    current_user: TokenData = Depends(require_admin),
):
    """Cria novo usuario com senha (admin only)."""
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
            "email": user_data.email,
            "name": user_data.name,
            "password_hash": hash_password(user_data.password),
            "is_admin": user_data.is_admin,
            "permissions": user_data.permissions,
            "is_active": True,
            "is_verified": True,  # Created with password = already verified
        }

        result = supabase.table("users").insert(new_user).execute()

        if result.data:
            created = result.data[0]
            logger.info("user_created", email=user_data.email, by=current_user.email)

            await log_action(
                current_user.user_id,
                "admin.user_created_direct",
                f"users/{created['id']}",
                details={"email": user_data.email},
                request=request,
            )

            return {"success": True, "user": created}

        raise HTTPException(status_code=500, detail="Erro ao criar usuario")

    except HTTPException:
        raise
    except Exception as e:
        logger.error("create_user_error", error=str(e))
        raise HTTPException(status_code=500, detail=str(e))


@router.post("/users/invite")
async def invite_user(
    user_data: AdminInviteUser,
    request: Request,
    current_user: TokenData = Depends(require_admin),
):
    """
    Admin creates a user by invite (name + email + phone, no password).
    Sends set-password token via email.
    """
    supabase = get_supabase()
    if not supabase:
        raise HTTPException(status_code=500, detail="Supabase not configured")

    normalized_email = user_data.email.lower().strip()

    # Check if email already exists
    existing = supabase.table("users").select("id").eq("email", normalized_email).execute()
    if existing.data:
        raise HTTPException(status_code=400, detail="Email ja cadastrado")

    # Encrypt phone if provided
    phone_encrypted = None
    if user_data.phone and field_encryption.is_configured:
        try:
            phone_encrypted = field_encryption.encrypt_phone(user_data.phone)
        except ValueError as e:
            raise HTTPException(status_code=400, detail=str(e))

    # Create user without password
    new_user = {
        "email": normalized_email,
        "name": user_data.name,
        "password_hash": "",  # No password yet
        "is_admin": False,
        "permissions": [],
        "is_active": True,
        "is_verified": False,
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

        # Send email — propagate failure to the admin
        try:
            email_sent = await send_set_password_email(
                normalized_email, user_data.name, set_pwd_token
            )
        except Exception as email_err:
            logger.error(
                "invite_email_failed",
                email=normalized_email,
                user_id=user_id,
                error=str(email_err),
            )
            raise HTTPException(
                status_code=502,
                detail=f"Usuario criado (ID {user_id}), mas falha ao enviar email: {email_err}",
            )

        if not email_sent:
            raise HTTPException(
                status_code=502,
                detail=f"Usuario criado (ID {user_id}), mas falha ao enviar email. Tente reenviar o convite.",
            )

        # Audit log
        await log_action(
            current_user.user_id,
            "admin.user_invited",
            f"users/{user_id}",
            details={"email": normalized_email},
            request=request,
        )

        logger.info("admin_user_invited", email=normalized_email, by=current_user.email)

        return {
            "success": True,
            "user_id": user_id,
            "email": normalized_email,
            "message": "Usuario criado. Email enviado com token para definir senha.",
        }

    except HTTPException:
        raise
    except Exception as e:
        logger.error("invite_user_error", error=str(e))
        raise HTTPException(status_code=500, detail="Erro interno ao criar usuario")


@router.post("/users/{user_id}/resend-invite")
async def resend_invite(
    user_id: int,
    request: Request,
    current_user: TokenData = Depends(require_admin),
):
    """Resend set-password invite email for an unverified user."""
    supabase = get_supabase()
    if not supabase:
        raise HTTPException(status_code=500, detail="Supabase not configured")

    try:
        result = (
            supabase.table("users")
            .select("id, email, name, is_verified")
            .eq("id", user_id)
            .limit(1)
            .execute()
        )
        if not result.data:
            raise HTTPException(status_code=404, detail="Usuario nao encontrado")

        user = result.data[0]

        if user.get("is_verified"):
            raise HTTPException(status_code=400, detail="Usuario ja esta verificado")

        # Generate new set-password token
        set_pwd_token = create_set_password_token(user["id"], user["email"])

        # Send email — propagate failure to the admin
        try:
            email_sent = await send_set_password_email(
                user["email"], user.get("name", ""), set_pwd_token
            )
        except Exception as email_err:
            logger.error(
                "resend_invite_email_failed",
                email=user["email"],
                user_id=user_id,
                error=str(email_err),
            )
            raise HTTPException(
                status_code=502,
                detail=f"Falha ao enviar email: {email_err}",
            )

        if not email_sent:
            raise HTTPException(
                status_code=502,
                detail="Falha ao enviar email. Verifique configuracao SMTP.",
            )

        # Audit log
        await log_action(
            current_user.user_id,
            "admin.resend_invite",
            f"users/{user_id}",
            details={"email": user["email"]},
            request=request,
        )

        logger.info("admin_resend_invite", email=user["email"], by=current_user.email)

        return {
            "success": True,
            "message": f"Convite reenviado para {user['email']}.",
        }

    except HTTPException:
        raise
    except Exception as e:
        logger.error("resend_invite_error", error=str(e))
        raise HTTPException(status_code=500, detail="Erro ao reenviar convite")


@router.get("/users/{user_id}")
async def get_user_by_id(
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
            "is_verified": user.get("is_verified", True),
        }

    except HTTPException:
        raise
    except Exception as e:
        logger.error("get_user_error", error=str(e))
        raise HTTPException(status_code=500, detail=str(e))


@router.put("/users/{user_id}")
async def update_admin_user(
    user_id: int,
    user_data: AdminUpdateUser,
    request: Request,
    current_user: TokenData = Depends(require_admin),
):
    """Atualiza usuario (admin only)."""
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

            await log_action(
                current_user.user_id,
                "admin.user_updated",
                f"users/{user_id}",
                details={"fields": list(updates.keys())},
                request=request,
            )

            return {"success": True, "user": result.data[0]}

        raise HTTPException(status_code=500, detail="Erro ao atualizar usuario")

    except HTTPException:
        raise
    except Exception as e:
        logger.error("update_user_error", error=str(e))
        raise HTTPException(status_code=500, detail=str(e))


@router.delete("/users/{user_id}")
async def delete_user(
    user_id: int,
    request: Request,
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

            await log_action(
                current_user.user_id,
                "admin.user_deactivated",
                f"users/{user_id}",
                request=request,
            )

            return {"success": True, "message": "Usuario desativado"}

        raise HTTPException(status_code=404, detail="Usuario nao encontrado")

    except HTTPException:
        raise
    except Exception as e:
        logger.error("delete_user_error", error=str(e))
        raise HTTPException(status_code=500, detail=str(e))


@router.delete("/users/{user_id}/permanent")
async def permanent_delete_user(
    user_id: int,
    request: Request,
    current_user: TokenData = Depends(require_admin),
):
    """Remove usuario permanentemente do banco (hard delete)."""
    supabase = get_supabase()
    if not supabase:
        raise HTTPException(status_code=500, detail="Supabase not configured")

    try:
        # Nao permitir auto-exclusao
        existing = supabase.table("users").select("email").eq("id", user_id).execute()
        if not existing.data:
            raise HTTPException(status_code=404, detail="Usuario nao encontrado")
        if existing.data[0]["email"] == current_user.email:
            raise HTTPException(status_code=400, detail="Nao pode excluir a si mesmo")

        # Hard delete
        supabase.table("users").delete().eq("id", user_id).execute()

        logger.info("user_permanent_deleted", user_id=user_id, by=current_user.email)

        await log_action(
            current_user.user_id,
            "admin.user_permanent_deleted",
            f"users/{user_id}",
            details={"email": existing.data[0]["email"]},
            request=request,
        )

        return {"success": True, "message": "Usuario removido permanentemente"}

    except HTTPException:
        raise
    except Exception as e:
        logger.error("permanent_delete_user_error", error=str(e))
        raise HTTPException(status_code=500, detail=str(e))
