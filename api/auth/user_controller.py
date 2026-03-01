"""
User controller — Admin user management endpoints.

Handles: list users, create user (direct + invite), update, delete,
         resend invite.
"""


import structlog
from fastapi import APIRouter, Depends, HTTPException, Request

from api.auth.audit_service import log_action
from api.auth.auth_middleware import require_admin, require_superadmin
from api.auth.auth_service import create_set_password_token, hash_password
from api.auth.email_service import send_set_password_email
from api.auth.field_encryption import field_encryption
from api.auth.messaging_service import messaging_service
from api.auth.schemas.auth_schemas import TokenData
from api.auth.schemas.user_schemas import (
    AdminCreateUserDirect,
    AdminInviteUser,
    AdminUpdateUser,
)
from config.settings import settings
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

            role = user.get("role", "user")
            users.append({
                "id": user.get("id"),
                "email": user.get("email"),
                "name": user.get("name"),
                "phone": phone_display,
                "cpf": cpf_display,
                "is_admin": role in ("superadmin", "admin"),
                "role": role,
                "permissions": user.get("permissions", []),
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
    current_user: TokenData = Depends(require_superadmin),
):
    """Cria novo usuario com senha. Apenas SuperAdmin."""
    supabase = get_supabase()
    if not supabase:
        raise HTTPException(status_code=500, detail="Supabase not configured")

    # Only superadmin can create admin/superadmin users
    if user_data.role in ("admin", "superadmin") and current_user.role != "superadmin":
        raise HTTPException(status_code=403, detail="Apenas SuperAdmin pode criar administradores")

    # Nobody can create another superadmin
    if user_data.role == "superadmin":
        raise HTTPException(status_code=403, detail="Nao e possivel criar outro SuperAdmin")

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

        role = user_data.role
        is_admin = role in ("superadmin", "admin")

        # Admin role gets all permissions automatically
        permissions = user_data.permissions
        if role == "admin":
            permissions = ["empresas", "pessoas", "politicos", "mandatos", "emendas", "noticias"]

        # Criar usuario
        new_user = {
            "email": user_data.email,
            "name": user_data.name,
            "password_hash": hash_password(user_data.password),
            "permissions": permissions,
            "role": role,
            "is_admin": is_admin,
            "is_active": True,
            "is_verified": True,  # Created with password = already verified
        }

        result = supabase.table("users").insert(new_user).execute()

        if result.data:
            created = result.data[0]
            logger.info("user_created", email=user_data.email, role=role, by=current_user.email)

            await log_action(
                current_user.user_id,
                "admin.user_created_direct",
                f"users/{created['id']}",
                details={"email": user_data.email, "role": role},
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
    Creates a user by invite (name + email + phone, no password).
    Sends set-password link via Email + WhatsApp, and verification code via SMS.
    """
    supabase = get_supabase()
    if not supabase:
        raise HTTPException(status_code=500, detail="Supabase not configured")

    normalized_email = user_data.email.lower().strip()

    # Guard: only superadmin can set role != "user"
    if user_data.role != "user" and current_user.role != "superadmin":
        raise HTTPException(status_code=403, detail="Apenas SuperAdmin pode definir role diferente de usuario")

    # Nobody can invite as superadmin
    if user_data.role == "superadmin":
        raise HTTPException(status_code=403, detail="Nao e possivel convidar como SuperAdmin")

    # Check if email already exists
    existing = supabase.table("users").select("id").eq("email", normalized_email).execute()
    if existing.data:
        raise HTTPException(status_code=400, detail="Email ja cadastrado")

    # Encrypt phone (now required)
    phone_encrypted = None
    if field_encryption.is_configured:
        try:
            phone_encrypted = field_encryption.encrypt_phone(user_data.phone)
        except ValueError as e:
            raise HTTPException(status_code=400, detail=str(e))

    # Determine role, permissions, is_admin
    role = user_data.role
    is_admin = role in ("superadmin", "admin")
    all_perms = ["empresas", "pessoas", "politicos", "mandatos", "emendas", "noticias"]
    permissions = all_perms if role == "admin" else user_data.permissions

    # Create user without password
    new_user = {
        "email": normalized_email,
        "name": user_data.name,
        "password_hash": "",  # No password yet
        "permissions": permissions,
        "role": role,
        "is_admin": is_admin,
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
        set_password_url = f"{settings.app_base_url}/set-password?token={set_pwd_token}"

        # Send Email (set-password link)
        try:
            await send_set_password_email(
                normalized_email, user_data.name, set_pwd_token
            )
        except Exception as email_err:
            logger.warning("invite_email_failed", email=normalized_email, error=str(email_err))

        # Send WhatsApp + SMS (invite with link)
        try:
            await messaging_service.send_invite(
                user_data.phone, user_data.name, set_password_url, user_id
            )
        except Exception as msg_err:
            logger.warning("invite_messaging_failed", phone=user_data.phone, error=str(msg_err))

        # Audit log
        await log_action(
            current_user.user_id,
            "user.invited",
            f"users/{user_id}",
            details={"email": normalized_email},
            request=request,
        )

        logger.info("user_invited", email=normalized_email, by=current_user.email)

        return {
            "success": True,
            "user_id": user_id,
            "email": normalized_email,
            "message": "Usuario criado. Convite enviado por email, WhatsApp e SMS.",
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
    """Resend set-password invite via email + WhatsApp for an unverified user."""
    supabase = get_supabase()
    if not supabase:
        raise HTTPException(status_code=500, detail="Supabase not configured")

    try:
        result = (
            supabase.table("users")
            .select("id, email, name, is_verified, phone_encrypted")
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
        set_password_url = f"{settings.app_base_url}/set-password?token={set_pwd_token}"

        # Send email
        try:
            await send_set_password_email(
                user["email"], user.get("name", ""), set_pwd_token
            )
        except Exception as email_err:
            logger.warning("resend_invite_email_failed", email=user["email"], error=str(email_err))

        # Send WhatsApp if phone available
        phone_encrypted = user.get("phone_encrypted") or ""
        if phone_encrypted and field_encryption.is_configured:
            try:
                phone = field_encryption.decrypt(phone_encrypted)
                await messaging_service.send_invite(
                    phone, user.get("name", ""), set_password_url, user["id"]
                )
            except Exception as msg_err:
                logger.warning("resend_invite_messaging_failed", user_id=user_id, error=str(msg_err))

        # Audit log
        await log_action(
            current_user.user_id,
            "user.resend_invite",
            f"users/{user_id}",
            details={"email": user["email"]},
            request=request,
        )

        logger.info("resend_invite", email=user["email"], by=current_user.email)

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
        role = user.get("role", "user")
        return {
            "id": user.get("id"),
            "email": user.get("email"),
            "name": user.get("name"),
            "is_admin": role in ("superadmin", "admin"),
            "role": role,
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
    current_user: TokenData = Depends(require_superadmin),
):
    """Atualiza usuario. Apenas SuperAdmin."""
    supabase = get_supabase()
    if not supabase:
        raise HTTPException(status_code=500, detail="Supabase not configured")

    try:
        # Verificar se usuario existe
        existing = supabase.table("users").select("*").eq("id", user_id).execute()
        if not existing.data:
            raise HTTPException(status_code=404, detail="Usuario nao encontrado")

        target_user = existing.data[0]

        # Cannot edit another superadmin (only self for limited fields)
        if target_user.get("role") == "superadmin" and user_id != current_user.user_id:
            raise HTTPException(status_code=403, detail="Nao e possivel editar outro SuperAdmin")

        # Cannot change role to superadmin
        if user_data.role == "superadmin":
            raise HTTPException(status_code=403, detail="Nao e possivel promover a SuperAdmin")

        # Cannot downgrade superadmin role
        if target_user.get("role") == "superadmin" and user_data.role is not None and user_data.role != "superadmin":
            raise HTTPException(status_code=403, detail="Nao e possivel rebaixar o SuperAdmin")

        # Montar updates
        updates = {}
        if user_data.name is not None:
            updates["name"] = user_data.name
        if user_data.email is not None:
            # Check if email already taken
            email_check = supabase.table("users").select("id").eq("email", user_data.email).execute()
            if email_check.data and email_check.data[0]["id"] != user_id:
                raise HTTPException(status_code=400, detail="Email ja cadastrado por outro usuario")
            updates["email"] = user_data.email
        if user_data.phone is not None:
            if field_encryption.is_configured and user_data.phone:
                updates["phone_encrypted"] = field_encryption.encrypt_phone(user_data.phone)
            elif user_data.phone:
                updates["phone_encrypted"] = user_data.phone
        if user_data.cpf is not None:
            if field_encryption.is_configured and user_data.cpf:
                updates["cpf_encrypted"] = field_encryption.encrypt_cpf(user_data.cpf)
            elif user_data.cpf:
                updates["cpf_encrypted"] = user_data.cpf
        if user_data.cep is not None:
            updates["cep"] = user_data.cep
        if user_data.logradouro is not None:
            updates["logradouro"] = user_data.logradouro
        if user_data.numero is not None:
            updates["numero"] = user_data.numero
        if user_data.complemento is not None:
            updates["complemento"] = user_data.complemento
        if user_data.bairro is not None:
            updates["bairro"] = user_data.bairro
        if user_data.cidade is not None:
            updates["cidade"] = user_data.cidade
        if user_data.uf is not None:
            updates["uf"] = user_data.uf
        if user_data.permissions is not None:
            updates["permissions"] = user_data.permissions
        if user_data.role is not None:
            updates["role"] = user_data.role
            updates["is_admin"] = user_data.role in ("superadmin", "admin")
            # Admin gets all permissions automatically
            if user_data.role == "admin":
                updates["permissions"] = ["empresas", "pessoas", "politicos", "mandatos", "emendas", "noticias"]
        if user_data.is_active is not None:
            updates["is_active"] = user_data.is_active
        if user_data.new_password:
            updates["password_hash"] = hash_password(user_data.new_password)

        if not updates:
            raise HTTPException(status_code=400, detail="Nenhum campo para atualizar")

        result = supabase.table("users").update(updates).eq("id", user_id).execute()

        if result.data:
            logger.info("user_updated", user_id=user_id, fields=list(updates.keys()), by=current_user.email)

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
    current_user: TokenData = Depends(require_superadmin),
):
    """Desativa usuario (soft delete). Apenas SuperAdmin."""
    supabase = get_supabase()
    if not supabase:
        raise HTTPException(status_code=500, detail="Supabase not configured")

    try:
        # Verificar se usuario existe
        existing = supabase.table("users").select("email, role").eq("id", user_id).execute()
        if not existing.data:
            raise HTTPException(status_code=404, detail="Usuario nao encontrado")

        # Nao permitir auto-exclusao
        if existing.data[0]["email"] == current_user.email:
            raise HTTPException(status_code=400, detail="Nao pode desativar a si mesmo")

        # Proteger superadmin
        if existing.data[0].get("role") == "superadmin":
            raise HTTPException(status_code=403, detail="SuperAdmin nao pode ser desativado")

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
    current_user: TokenData = Depends(require_superadmin),
):
    """Remove usuario permanentemente do banco (hard delete). Apenas SuperAdmin."""
    supabase = get_supabase()
    if not supabase:
        raise HTTPException(status_code=500, detail="Supabase not configured")

    try:
        # Nao permitir auto-exclusao
        existing = supabase.table("users").select("email, role").eq("id", user_id).execute()
        if not existing.data:
            raise HTTPException(status_code=404, detail="Usuario nao encontrado")
        if existing.data[0]["email"] == current_user.email:
            raise HTTPException(status_code=400, detail="Nao pode excluir a si mesmo")

        # Proteger superadmin
        if existing.data[0].get("role") == "superadmin":
            raise HTTPException(status_code=403, detail="SuperAdmin nao pode ser excluido")

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


@router.get("/smtp-test")
async def smtp_test(current_user: TokenData = Depends(require_superadmin)):
    """Diagnostico email — testa envio via Resend."""
    from config.settings import settings

    result = {
        "provider": "resend",
        "resend_api_key_set": bool(settings.resend_api_key),
        "email_from": settings.email_from,
        "is_configured": bool(settings.resend_api_key),
    }

    if not result["is_configured"]:
        return {**result, "status": "NOT_CONFIGURED", "error": "RESEND_API_KEY missing"}

    try:
        import resend

        resend.api_key = settings.resend_api_key
        email_resp = resend.Emails.send({
            "from": f"IconsAI <{settings.email_from}>",
            "to": [current_user.email],
            "subject": "IconsAI - Teste de Email",
            "html": "<h2>Email de teste</h2><p>Se voce recebeu este email, o Resend esta funcionando.</p>",
        })
        return {**result, "status": "OK", "resend_id": email_resp.get("id"), "sent_to": current_user.email, "error": None}
    except Exception as e:
        return {
            **result,
            "status": "FAILED",
            "error": f"{type(e).__name__}: {e}",
        }
