"""
Auth package — modular authentication system.

Contains:
  - auth_controller: Auth endpoints (login, set-password, verify, recover, reset, refresh, me, profile)
  - user_controller: Admin user management endpoints
  - auth_service: JWT, password hashing, token management
  - auth_middleware: get_current_user, require_admin dependencies
  - email_service: SMTP email sending
  - verification_service: 6-digit verification codes
  - field_encryption: AES-256 field-level encryption (CPF, phone)
  - audit_service: Action logging
  - seed: Admin user seeding
  - schemas/: Pydantic schemas for auth and user management

Re-exports below provide backwards compatibility for code that imports from api.auth directly.
"""

# Re-export from auth_service (functions + constants)
# Re-export from auth_middleware
from api.auth.auth_middleware import get_current_user, require_admin
from api.auth.auth_service import (
    ACCESS_TOKEN_EXPIRE_MINUTES,
    authenticate_user,
    create_access_token,
    create_password_reset_token,
    create_refresh_token,
    create_set_password_token,
    decode_special_token,
    hash_password,
    update_user,
    validate_refresh_token,
    verify_password,
)

# Re-export schemas (backwards compat)
from api.auth.schemas.auth_schemas import (
    LoginRequest,
    Token,
    TokenData,
    TokenWithRefresh,
    UserResponse,
    UserUpdate,
)

# Backwards-compat alias: old code uses UserLogin, new code uses LoginRequest
UserLogin = LoginRequest

__all__ = [
    "ACCESS_TOKEN_EXPIRE_MINUTES",
    "Token",
    "TokenData",
    "TokenWithRefresh",
    "UserLogin",
    "LoginRequest",
    "UserResponse",
    "UserUpdate",
    "authenticate_user",
    "create_access_token",
    "create_password_reset_token",
    "create_refresh_token",
    "create_set_password_token",
    "decode_special_token",
    "get_current_user",
    "hash_password",
    "require_admin",
    "update_user",
    "validate_refresh_token",
    "verify_password",
]
