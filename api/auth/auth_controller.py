"""
Auth controller — Authentication endpoints.

Handles: login, set-password, verify, resend-code, recover-password,
         reset-password, refresh, me (GET/PUT), profile/complete.
"""

import re
from datetime import timedelta

import structlog
from fastapi import APIRouter, Depends, HTTPException, Request, status

from api.auth.audit_service import log_action
from api.auth.auth_middleware import get_current_user
from api.auth.auth_service import (
    ACCESS_TOKEN_EXPIRE_MINUTES,
    authenticate_user,
    create_access_token,
    create_password_reset_token,
    create_refresh_token,
    decode_special_token,
    hash_password,
    update_user,
    validate_refresh_token,
)
from api.auth.email_service import (
    send_password_reset_email,
    send_verification_code_email,
)
from api.auth.field_encryption import field_encryption
from api.auth.messaging_service import messaging_service
from api.auth.schemas.auth_schemas import (
    LoginRequest,
    RecoverPasswordRequest,
    RefreshTokenRequest,
    ResendCodeRequest,
    ResetPasswordRequest,
    SetPasswordRequest,
    TokenData,
    TokenWithRefresh,
    UserUpdate,
    VerifyCodeRequest,
)
from api.auth.schemas.user_schemas import UserProfileComplete, UserResponseExpanded
from api.auth.verification_service import create_verification_code, verify_code
from src.database.client import get_supabase

logger = structlog.get_logger()

router = APIRouter(tags=["Auth"])


# ===========================================
# AUTH DIAGNOSTIC
# ===========================================


@router.get("/diagnostic")
async def auth_diagnostic():
    """Diagnostic endpoint to verify auth configuration (no secrets exposed)."""
    from api.auth.auth_service import ALGORITHM, SECRET_KEY
    from config.settings import settings

    supabase = get_supabase()
    user_count = 0
    has_audit_table = False
    has_refresh_table = False

    if supabase:
        try:
            r = supabase.table("users").select("id", count="exact").limit(0).execute()
            user_count = r.count or 0
        except Exception as e:
            user_count = -1
            logger.warning("diagnostic_users_error", error=str(e))
        try:
            supabase.table("audit_logs").select("id").limit(1).execute()
            has_audit_table = True
        except Exception:
            pass
        try:
            supabase.table("refresh_tokens").select("id").limit(1).execute()
            has_refresh_table = True
        except Exception:
            pass

    return {
        "jwt_secret_key_set": bool(SECRET_KEY),
        "jwt_secret_key_length": len(SECRET_KEY) if SECRET_KEY else 0,
        "jwt_algorithm": ALGORITHM,
        "supabase_connected": supabase is not None,
        "supabase_url_set": bool(settings.supabase_url),
        "users_count": user_count,
        "seed_admin_email": settings.seed_admin_email or "(not set)",
        "has_audit_logs_table": has_audit_table,
        "has_refresh_tokens_table": has_refresh_table,
    }


# ===========================================
# AUTH ENDPOINTS
# ===========================================


@router.post("/login", response_model=TokenWithRefresh)
async def login(user_data: LoginRequest, request: Request):
    """User login — returns access + refresh token."""
    client_ip = request.client.host if request.client else "unknown"
    logger.info("login_attempt", email=user_data.email, client_ip=client_ip)

    # Pre-check: Supabase must be available
    if not get_supabase():
        logger.error("login_no_database", msg="Supabase client not available")
        raise HTTPException(
            status_code=status.HTTP_503_SERVICE_UNAVAILABLE,
            detail="Servico temporariamente indisponivel. Tente novamente.",
        )

    try:
        user = await authenticate_user(user_data.email, user_data.password)
        if not user:
            logger.warning("login_failed_credentials", email=user_data.email)
            raise HTTPException(
                status_code=status.HTTP_401_UNAUTHORIZED,
                detail="Email ou senha incorretos",
            )

        if not user.get("is_verified", True):
            logger.warning("login_user_not_verified", email=user_data.email)
            raise HTTPException(
                status_code=status.HTTP_403_FORBIDDEN,
                detail="Conta nao verificada. Verifique seu email.",
            )

        role = user.get("role") or ("superadmin" if user.get("is_admin") else "user")
        is_admin = role in ("superadmin", "admin") or user.get("is_admin", False)

        access_token = create_access_token(
            data={
                "sub": user["email"],
                "user_id": user.get("id"),
                "name": user.get("name"),
                "is_admin": is_admin,
                "permissions": user.get("permissions", []),
                "role": role,
            },
            expires_delta=timedelta(minutes=ACCESS_TOKEN_EXPIRE_MINUTES),
        )

        refresh_token = await create_refresh_token(user["id"])

        try:
            await log_action(user["id"], "user.login", f"users/{user['id']}", request=request)
        except Exception as audit_err:
            logger.warning("login_audit_log_failed", error=str(audit_err))

        logger.info("login_success", email=user_data.email, role=role)
        return {
            "access_token": access_token,
            "refresh_token": refresh_token or "",
            "token_type": "bearer",
        }

    except HTTPException:
        raise
    except Exception as e:
        logger.error(
            "login_unhandled_error",
            error=str(e),
            error_type=type(e).__name__,
            email=user_data.email,
        )
        raise HTTPException(
            status_code=status.HTTP_500_INTERNAL_SERVER_ERROR,
            detail="Erro interno no login. Contate o administrador.",
        )


@router.get("/me", response_model=UserResponseExpanded)
async def get_me(current_user: TokenData = Depends(get_current_user)):
    """Get current user info with profile_complete flag."""
    supabase = get_supabase()
    if not supabase:
        return {
            "id": current_user.user_id or 0,
            "email": current_user.email,
            "name": current_user.name,
            "is_admin": current_user.is_admin,
            "role": current_user.role,
            "permissions": current_user.permissions or [],
            "is_active": True,
            "is_verified": True,
            "profile_complete": False,
        }

    try:
        result = (
            supabase.table("users")
            .select("*")
            .eq("id", current_user.user_id)
            .limit(1)
            .execute()
        )
        if result.data:
            user = result.data[0]
            profile_complete = bool(user.get("cpf_encrypted") and user.get("cep"))
            role = user.get("role") or ("superadmin" if user.get("is_admin") else "user")
            return {
                "id": user.get("id"),
                "email": user.get("email"),
                "name": user.get("name"),
                "is_admin": role in ("superadmin", "admin") or user.get("is_admin", False),
                "role": role,
                "permissions": user.get("permissions", []),
                "is_active": user.get("is_active", True),
                "is_verified": user.get("is_verified", True),
                "profile_complete": profile_complete,
            }
    except Exception as e:
        logger.warning("get_me_db_error", error=str(e))

    return {
        "id": current_user.user_id or 0,
        "email": current_user.email,
        "name": current_user.name,
        "is_admin": current_user.is_admin,
        "role": current_user.role,
        "permissions": current_user.permissions or [],
        "is_active": True,
        "is_verified": True,
        "profile_complete": False,
    }


@router.put("/me")
async def update_me(
    update_data: UserUpdate,
    current_user: TokenData = Depends(get_current_user),
):
    """Update current user."""
    result = await update_user(current_user.email, update_data)
    if not result:
        raise HTTPException(status_code=400, detail="Erro ao atualizar usuário")
    return {"message": "Usuário atualizado"}


# ===========================================
# SET PASSWORD / VERIFICATION / RECOVERY
# ===========================================


@router.post("/set-password")
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

    # Build update payload: password + optional profile data
    update_payload = {"password_hash": hash_password(data.password)}

    # Save profile data if provided
    if data.cpf and field_encryption and field_encryption.is_configured:
        try:
            update_payload["cpf_encrypted"] = field_encryption.encrypt_cpf(data.cpf)
        except ValueError as e:
            raise HTTPException(status_code=400, detail=str(e))

    if data.cep:
        update_payload["cep"] = re.sub(r"\D", "", data.cep)
    if data.logradouro:
        update_payload["logradouro"] = data.logradouro
    if data.numero:
        update_payload["numero"] = data.numero
    if data.complemento is not None:
        update_payload["complemento"] = data.complemento
    if data.bairro:
        update_payload["bairro"] = data.bairro
    if data.cidade:
        update_payload["cidade"] = data.cidade
    if data.uf:
        update_payload["uf"] = data.uf

    supabase.table("users").update(update_payload).eq("id", user_id).execute()

    # Generate activation code and send via SMS (+ email as fallback)
    code = await create_verification_code(user_id, "activation")
    if code:
        # Send via SMS (primary channel for codes)
        phone_encrypted = user.get("phone_encrypted") or ""
        if phone_encrypted and field_encryption.is_configured:
            try:
                phone = field_encryption.decrypt(phone_encrypted)
                await messaging_service.send_verification_code(phone, code, user_id)
            except Exception as e:
                logger.warning("set_password_sms_failed", user_id=user_id, error=str(e))

        # Also send via email as secondary channel
        await send_verification_code_email(email, code, "activation")

    await log_action(user_id, "user.password_set", f"users/{user_id}", request=request)

    return {
        "success": True,
        "message": "Senha definida. Codigo de ativacao enviado por SMS.",
        "email": email,
    }


@router.post("/verify")
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


@router.post("/resend-code")
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
            # Send via SMS (primary)
            user_full = supabase.table("users").select("phone_encrypted").eq("id", user["id"]).limit(1).execute()
            phone_encrypted = user_full.data[0].get("phone_encrypted", "") if user_full.data else ""
            if phone_encrypted and field_encryption.is_configured:
                try:
                    phone = field_encryption.decrypt(phone_encrypted)
                    await messaging_service.send_verification_code(phone, code, user["id"])
                except Exception as e:
                    logger.warning("resend_code_sms_failed", user_id=user["id"], error=str(e))

            # Also send via email
            await send_verification_code_email(user["email"], code, data.code_type)

    return {
        "success": True,
        "message": "Se o email estiver cadastrado, um novo codigo sera enviado.",
    }


@router.post("/recover-password")
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

        # Send via email
        if code:
            await send_verification_code_email(user["email"], code, "password_reset")
        await send_password_reset_email(user["email"], reset_token)

        # Also send code via SMS if phone available
        if code:
            user_full = supabase.table("users").select("phone_encrypted").eq("id", user["id"]).limit(1).execute()
            phone_encrypted = user_full.data[0].get("phone_encrypted", "") if user_full.data else ""
            if phone_encrypted and field_encryption.is_configured:
                try:
                    phone = field_encryption.decrypt(phone_encrypted)
                    await messaging_service.send_password_reset(phone, code, user["id"])
                except Exception as e:
                    logger.warning("recover_password_sms_failed", user_id=user["id"], error=str(e))

        await log_action(
            user["id"],
            "user.password_recovery_requested",
            f"users/{user['id']}",
            request=request,
        )

    # Always return success to prevent email enumeration
    return {
        "success": True,
        "message": "Se o email estiver cadastrado, enviaremos instrucoes por email e SMS.",
    }


@router.post("/reset-password")
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


@router.post("/refresh")
async def refresh_access_token(data: RefreshTokenRequest, request: Request):
    """
    Refresh access token using a valid refresh token.
    The old refresh token is revoked and a new one is issued (rotation).
    """
    try:
        user = await validate_refresh_token(data.refresh_token)
        if not user:
            raise HTTPException(status_code=401, detail="Refresh token invalido ou expirado")

        # Create new access token
        role = user.get("role") or ("superadmin" if user.get("is_admin") else "user")
        is_admin = role in ("superadmin", "admin") or user.get("is_admin", False)

        access_token = create_access_token(
            data={
                "sub": user["email"],
                "user_id": user.get("id"),
                "name": user.get("name"),
                "is_admin": is_admin,
                "permissions": user.get("permissions", []),
                "role": role,
            },
            expires_delta=timedelta(minutes=ACCESS_TOKEN_EXPIRE_MINUTES),
        )

        # Create new refresh token (rotation)
        new_refresh_token = await create_refresh_token(user["id"])

        try:
            await log_action(user["id"], "user.token_refreshed", f"users/{user['id']}", request=request)
        except Exception as audit_err:
            logger.warning("refresh_audit_log_failed", error=str(audit_err))

        return {
            "access_token": access_token,
            "refresh_token": new_refresh_token or "",
            "token_type": "bearer",
        }

    except HTTPException:
        raise
    except Exception as e:
        logger.error(
            "refresh_unhandled_error",
            error=str(e),
            error_type=type(e).__name__,
        )
        raise HTTPException(
            status_code=status.HTTP_500_INTERNAL_SERVER_ERROR,
            detail="Erro interno ao renovar token.",
        )


# ===========================================
# PROFILE COMPLETION
# ===========================================


@router.put("/profile/complete")
async def complete_profile(
    data: UserProfileComplete,
    request: Request,
    current_user: TokenData = Depends(get_current_user),
):
    """
    User completes profile with CPF + address.
    CEP auto-fill is done on the frontend via BrasilAPI.
    """
    supabase = get_supabase()
    if not supabase:
        raise HTTPException(status_code=500, detail="Supabase not configured")

    user_id = current_user.user_id
    if not user_id:
        raise HTTPException(status_code=401, detail="Usuario nao identificado")

    # Encrypt CPF
    if not field_encryption.is_configured:
        logger.warning("profile_complete_no_encryption", user_id=user_id)
        raise HTTPException(
            status_code=500,
            detail="Criptografia nao configurada. Contate o administrador.",
        )

    try:
        cpf_encrypted = field_encryption.encrypt_cpf(data.cpf)
    except ValueError as e:
        raise HTTPException(status_code=400, detail=str(e))

    # Clean CEP
    cep_clean = re.sub(r"\D", "", data.cep)

    updates = {
        "cpf_encrypted": cpf_encrypted,
        "cep": cep_clean,
        "logradouro": data.logradouro,
        "numero": data.numero,
        "complemento": data.complemento,
        "bairro": data.bairro,
        "cidade": data.cidade,
        "uf": data.uf,
    }

    try:
        result = supabase.table("users").update(updates).eq("id", user_id).execute()

        if not result.data:
            raise HTTPException(status_code=500, detail="Erro ao atualizar perfil")

        await log_action(
            user_id,
            "user.profile_completed",
            f"users/{user_id}",
            details={"cep": cep_clean, "cidade": data.cidade, "uf": data.uf},
            request=request,
        )

        logger.info("profile_completed", user_id=user_id, cidade=data.cidade, uf=data.uf)

        return {
            "success": True,
            "message": "Perfil completado com sucesso.",
            "profile_complete": True,
        }

    except HTTPException:
        raise
    except Exception as e:
        logger.error("profile_complete_error", user_id=user_id, error=str(e))
        raise HTTPException(status_code=500, detail="Erro ao completar perfil")
