"""
Auth middleware - FastAPI dependencies for authentication and authorization.
"""

from typing import Callable

import structlog
from fastapi import Depends, HTTPException, status
from fastapi.security import HTTPAuthorizationCredentials, HTTPBearer
from jose import JWTError, jwt

from api.auth.schemas.auth_schemas import TokenData
from config.settings import settings

logger = structlog.get_logger()

SECRET_KEY = settings.jwt_secret_key
ALGORITHM = settings.jwt_algorithm

VALID_PERMISSIONS = {"empresas", "pessoas", "politicos", "noticias"}
VALID_ROLES = {"superadmin", "admin", "user"}

security = HTTPBearer()


async def get_current_user(
    credentials: HTTPAuthorizationCredentials = Depends(security),
) -> TokenData:
    """Dependency that extracts and validates the current user from JWT."""
    credentials_exception = HTTPException(
        status_code=status.HTTP_401_UNAUTHORIZED,
        detail="Could not validate credentials",
        headers={"WWW-Authenticate": "Bearer"},
    )
    try:
        token = credentials.credentials
        payload = jwt.decode(token, SECRET_KEY, algorithms=[ALGORITHM])

        token_type = payload.get("type", "access")
        if token_type != "access":
            raise credentials_exception

        email: str = payload.get("sub")
        user_id: int = payload.get("user_id")
        name: str = payload.get("name")
        is_admin: bool = payload.get("is_admin", False)
        permissions: list = payload.get("permissions", [])
        role: str = payload.get("role", "user")
        if email is None:
            raise credentials_exception
        # Backwards compat: derive role from is_admin if role missing in old tokens
        if role == "user" and is_admin:
            role = "superadmin"
        token_data = TokenData(
            email=email,
            user_id=user_id,
            name=name,
            is_admin=is_admin,
            permissions=permissions,
            role=role,
        )
    except JWTError:
        raise credentials_exception
    return token_data


async def require_admin(
    current_user: TokenData = Depends(get_current_user),
) -> TokenData:
    """
    FastAPI dependency that checks if the current user is an admin.
    Returns 403 Forbidden if is_admin is False.
    """
    if not current_user.is_admin:
        logger.warning(
            "admin_access_denied",
            user=current_user.email,
            user_id=current_user.user_id,
        )
        raise HTTPException(
            status_code=status.HTTP_403_FORBIDDEN,
            detail="Admin access required",
        )
    return current_user


async def require_superadmin(
    current_user: TokenData = Depends(get_current_user),
) -> TokenData:
    """
    FastAPI dependency that checks if the current user is a superadmin.
    Returns 403 Forbidden if role is not superadmin.
    """
    if current_user.role != "superadmin":
        logger.warning(
            "superadmin_access_denied",
            user=current_user.email,
            user_id=current_user.user_id,
            role=current_user.role,
        )
        raise HTTPException(
            status_code=status.HTTP_403_FORBIDDEN,
            detail="SuperAdmin access required",
        )
    return current_user


def require_permission(permission: str) -> Callable:
    """
    FastAPI dependency factory that checks if the current user has a specific permission.
    Returns 403 Forbidden if the user does not have the required permission.

    Usage:
        @router.get("/endpoint", dependencies=[Depends(require_permission("empresas"))])
    """
    if permission not in VALID_PERMISSIONS:
        raise ValueError(
            f"Invalid permission: {permission}. Valid: {VALID_PERMISSIONS}"
        )

    async def _check_permission(
        current_user: TokenData = Depends(get_current_user),
    ) -> TokenData:
        if permission not in (current_user.permissions or []):
            logger.warning(
                "permission_denied",
                user=current_user.email,
                required=permission,
                has=current_user.permissions,
            )
            raise HTTPException(
                status_code=status.HTTP_403_FORBIDDEN,
                detail=f"Permission '{permission}' required",
            )
        return current_user

    return _check_permission


