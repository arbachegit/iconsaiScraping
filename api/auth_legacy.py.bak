"""
Authentication module
JWT-based authentication for the IconsAI Scraping API

SECURITY NOTES:
- Passwords are hashed using bcrypt (secure)
- SECRET_KEY must be set via environment variable
- Users are stored in Supabase database
- Refresh tokens stored hashed in database
- Set-password tokens are single-use JWTs (24h)
"""

import hashlib
import re
import secrets
from datetime import datetime, timedelta, timezone
from typing import Optional

import bcrypt
import structlog
from fastapi import Depends, HTTPException, status
from fastapi.security import HTTPAuthorizationCredentials, HTTPBearer
from jose import JWTError, jwt
from pydantic import BaseModel, ConfigDict, EmailStr, Field, field_validator

from config.settings import settings

logger = structlog.get_logger()

# Configuration from settings (NOT hardcoded)
SECRET_KEY = settings.jwt_secret_key
ALGORITHM = settings.jwt_algorithm
ACCESS_TOKEN_EXPIRE_MINUTES = settings.access_token_expire_minutes
REFRESH_TOKEN_EXPIRE_DAYS = settings.refresh_token_expire_days

# Bearer token security
security = HTTPBearer()


class Token(BaseModel):
    access_token: str
    token_type: str


class TokenWithRefresh(BaseModel):
    access_token: str
    refresh_token: str
    token_type: str


class TokenData(BaseModel):
    email: Optional[str] = None
    user_id: Optional[int] = None
    name: Optional[str] = None
    is_admin: bool = False
    permissions: Optional[list] = None


class UserLogin(BaseModel):
    """Schema para login de usuário."""

    model_config = ConfigDict(str_strip_whitespace=True, extra="forbid")

    email: EmailStr
    password: str = Field(min_length=6, max_length=128)

    @field_validator("email")
    @classmethod
    def normalize_email(cls, v: str) -> str:
        return v.lower().strip()


class UserResponse(BaseModel):
    id: int
    email: str
    name: Optional[str]
    is_admin: bool


class UserUpdate(BaseModel):
    """Schema para atualização de usuário."""

    model_config = ConfigDict(str_strip_whitespace=True, extra="forbid")

    name: Optional[str] = Field(default=None, min_length=2, max_length=100)
    email: Optional[EmailStr] = None
    current_password: Optional[str] = Field(default=None, min_length=6)
    new_password: Optional[str] = Field(default=None, min_length=8, max_length=128)

    @field_validator("email")
    @classmethod
    def normalize_email(cls, v: Optional[str]) -> Optional[str]:
        if v is None:
            return v
        return v.lower().strip()

    @field_validator("new_password")
    @classmethod
    def validate_password_strength(cls, v: Optional[str]) -> Optional[str]:
        if v is None:
            return v
        if not re.search(r"[A-Z]", v):
            raise ValueError("Senha deve ter ao menos 1 letra maiúscula")
        if not re.search(r"[0-9]", v):
            raise ValueError("Senha deve ter ao menos 1 número")
        return v


def hash_password(password: str) -> str:
    """
    Hash password using bcrypt (secure).

    bcrypt automatically handles:
    - Salt generation
    - Multiple rounds of hashing
    - Protection against rainbow table attacks
    """
    salt = bcrypt.gensalt(rounds=12)
    return bcrypt.hashpw(password.encode("utf-8"), salt).decode("utf-8")


def verify_password(plain_password: str, hashed_password: str) -> bool:
    """
    Verify password against bcrypt hash.

    Returns True if password matches, False otherwise.
    """
    try:
        return bcrypt.checkpw(plain_password.encode("utf-8"), hashed_password.encode("utf-8"))
    except Exception as e:
        logger.error("password_verify_error", error=str(e))
        return False


# Database-backed user authentication
async def get_user_from_db(email: str) -> Optional[dict]:
    """
    Get user from Supabase database.
    """
    try:
        from src.database.client import get_supabase

        client = get_supabase()
        if client:
            result = (
                client.table("users")
                .select("*")
                .eq("email", email)
                .eq("is_active", True)
                .limit(1)
                .execute()
            )

            if result.data:
                logger.info("user_found_db", email=email)
                return result.data[0]
    except Exception as e:
        logger.warning("db_user_lookup_failed", error=str(e))

    return None


def create_access_token(data: dict, expires_delta: Optional[timedelta] = None) -> str:
    to_encode = data.copy()
    if expires_delta:
        expire = datetime.now(timezone.utc) + expires_delta
    else:
        expire = datetime.now(timezone.utc) + timedelta(minutes=ACCESS_TOKEN_EXPIRE_MINUTES)
    to_encode.update({"exp": expire, "type": "access"})
    encoded_jwt = jwt.encode(to_encode, SECRET_KEY, algorithm=ALGORITHM)
    return encoded_jwt


def create_set_password_token(user_id: int, email: str) -> str:
    """
    Create a JWT token for setting the initial password.

    Valid for 24 hours. Type: 'set_password'.
    """
    expire = datetime.now(timezone.utc) + timedelta(hours=24)
    to_encode = {
        "sub": email,
        "user_id": user_id,
        "type": "set_password",
        "exp": expire,
    }
    return jwt.encode(to_encode, SECRET_KEY, algorithm=ALGORITHM)


def create_password_reset_token(user_id: int, email: str) -> str:
    """
    Create a JWT token for password reset.

    Valid for 1 hour. Type: 'password_reset'.
    """
    expire = datetime.now(timezone.utc) + timedelta(hours=1)
    to_encode = {
        "sub": email,
        "user_id": user_id,
        "type": "password_reset",
        "exp": expire,
    }
    return jwt.encode(to_encode, SECRET_KEY, algorithm=ALGORITHM)


async def create_refresh_token(user_id: int) -> Optional[str]:
    """
    Create a refresh token and store its hash in the database.

    Valid for REFRESH_TOKEN_EXPIRE_DAYS.

    Returns:
        The raw refresh token string, or None if storage fails.
    """
    from src.database.client import get_supabase

    raw_token = secrets.token_urlsafe(64)
    token_hash = hashlib.sha256(raw_token.encode("utf-8")).hexdigest()
    expires_at = (
        datetime.now(timezone.utc) + timedelta(days=REFRESH_TOKEN_EXPIRE_DAYS)
    ).isoformat()

    client = get_supabase()
    if not client:
        logger.warning("refresh_token_no_db")
        return None

    try:
        client.table("refresh_tokens").insert(
            {
                "user_id": user_id,
                "token_hash": token_hash,
                "expires_at": expires_at,
            }
        ).execute()
        logger.info("refresh_token_created", user_id=user_id)
        return raw_token
    except Exception as e:
        logger.error("refresh_token_store_failed", error=str(e))
        return None


async def validate_refresh_token(raw_token: str) -> Optional[dict]:
    """
    Validate a refresh token and return the associated user.

    Args:
        raw_token: The raw refresh token string.

    Returns:
        User dict if valid, None otherwise.
    """
    from src.database.client import get_supabase

    token_hash = hashlib.sha256(raw_token.encode("utf-8")).hexdigest()
    now = datetime.now(timezone.utc).isoformat()

    client = get_supabase()
    if not client:
        return None

    try:
        result = (
            client.table("refresh_tokens")
            .select("*")
            .eq("token_hash", token_hash)
            .is_("revoked_at", "null")
            .gte("expires_at", now)
            .limit(1)
            .execute()
        )

        if not result.data:
            logger.warning("refresh_token_invalid")
            return None

        token_row = result.data[0]
        user_id = token_row["user_id"]

        # Revoke the used refresh token (rotation)
        client.table("refresh_tokens").update(
            {"revoked_at": now}
        ).eq("id", token_row["id"]).execute()

        # Get user
        user_result = (
            client.table("users")
            .select("*")
            .eq("id", user_id)
            .eq("is_active", True)
            .limit(1)
            .execute()
        )

        if not user_result.data:
            return None

        return user_result.data[0]

    except Exception as e:
        logger.error("refresh_token_validate_failed", error=str(e))
        return None


def decode_special_token(token: str, expected_type: str) -> Optional[dict]:
    """
    Decode a special-purpose JWT (set_password, password_reset).

    Args:
        token: The JWT string.
        expected_type: Expected token type ('set_password' or 'password_reset').

    Returns:
        Decoded payload if valid and type matches, None otherwise.
    """
    try:
        payload = jwt.decode(token, SECRET_KEY, algorithms=[ALGORITHM])
        if payload.get("type") != expected_type:
            logger.warning("token_type_mismatch", expected=expected_type, got=payload.get("type"))
            return None
        return payload
    except JWTError as e:
        logger.warning("special_token_decode_failed", error=str(e))
        return None


async def authenticate_user(email: str, password: str) -> Optional[dict]:
    """
    Authenticate user by email and password.

    1. Gets user from database
    2. Verifies password using bcrypt

    Note: is_verified check is done in the login endpoint
    to provide a specific error message.
    """
    user = await get_user_from_db(email)
    if not user:
        logger.warning("auth_user_not_found", email=email)
        return None

    if not verify_password(password, user["password_hash"]):
        logger.warning("auth_invalid_password", email=email)
        return None

    logger.info("auth_success", email=email, is_admin=user.get("is_admin", False))
    return user


async def get_current_user(
    credentials: HTTPAuthorizationCredentials = Depends(security),
) -> TokenData:
    credentials_exception = HTTPException(
        status_code=status.HTTP_401_UNAUTHORIZED,
        detail="Could not validate credentials",
        headers={"WWW-Authenticate": "Bearer"},
    )
    try:
        token = credentials.credentials
        payload = jwt.decode(token, SECRET_KEY, algorithms=[ALGORITHM])

        # Only accept access tokens for general auth
        token_type = payload.get("type", "access")
        if token_type != "access":
            raise credentials_exception

        email: str = payload.get("sub")
        user_id: int = payload.get("user_id")
        name: str = payload.get("name")
        is_admin: bool = payload.get("is_admin", False)
        permissions: list = payload.get("permissions", [])
        if email is None:
            raise credentials_exception
        token_data = TokenData(email=email, user_id=user_id, name=name, is_admin=is_admin, permissions=permissions)
    except JWTError:
        raise credentials_exception
    return token_data


async def update_user(current_email: str, update_data: UserUpdate) -> Optional[dict]:
    """
    Update user data in database.

    Returns updated user or None if validation fails.
    """
    try:
        from src.database.client import get_supabase

        client = get_supabase()
        if not client:
            logger.warning("db_not_available_update_user")
            return None

        # Get current user
        result = client.table("users").select("*").eq("email", current_email).limit(1).execute()

        if not result.data:
            return None

        user = result.data[0]
        updates = {"updated_at": datetime.now(timezone.utc).isoformat()}

        # Verify current password if changing password
        if update_data.new_password:
            if not update_data.current_password:
                return None
            if not verify_password(update_data.current_password, user["password_hash"]):
                return None
            updates["password_hash"] = hash_password(update_data.new_password)

        # Update name
        if update_data.name:
            updates["name"] = update_data.name

        # Update email
        if update_data.email and update_data.email != current_email:
            # Check if new email already exists
            existing = client.table("users").select("id").eq("email", update_data.email).execute()
            if existing.data:
                return None
            updates["email"] = update_data.email

        # Apply updates
        result = client.table("users").update(updates).eq("email", current_email).execute()

        if result.data:
            logger.info("user_updated", email=current_email)
            return result.data[0]

    except Exception as e:
        logger.error("update_user_error", error=str(e))

    return None
