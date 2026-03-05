"""
Auth-related Pydantic schemas.

Includes: login, set-password, verify, recover, reset, refresh, tokens, user response.
"""

import re
from typing import Optional

from pydantic import BaseModel, ConfigDict, EmailStr, Field, field_validator


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
    role: str = "user"
    tenant_id: Optional[str] = None


class LoginRequest(BaseModel):
    """Schema para login de usuario."""

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
    role: str = "user"


class UserUpdate(BaseModel):
    """Schema para atualizacao de usuario."""

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
            raise ValueError("Senha deve ter ao menos 1 letra maiuscula")
        if not re.search(r"[0-9]", v):
            raise ValueError("Senha deve ter ao menos 1 numero")
        return v


class SetPasswordRequest(BaseModel):
    """Schema para definir senha via token (with optional profile data)."""

    model_config = ConfigDict(str_strip_whitespace=True, extra="forbid")

    token: str
    password: str = Field(min_length=8, max_length=128)
    cpf: Optional[str] = Field(default=None, pattern=r"^\d{3}\.?\d{3}\.?\d{3}-?\d{2}$")
    cep: Optional[str] = Field(default=None, pattern=r"^\d{5}-?\d{3}$")
    logradouro: Optional[str] = Field(default=None, min_length=2, max_length=255)
    numero: Optional[str] = Field(default=None, min_length=1, max_length=20)
    complemento: Optional[str] = Field(default=None, max_length=100)
    bairro: Optional[str] = Field(default=None, min_length=2, max_length=100)
    cidade: Optional[str] = Field(default=None, min_length=2, max_length=100)
    uf: Optional[str] = Field(default=None, pattern=r"^[A-Z]{2}$")

    @field_validator("password")
    @classmethod
    def validate_password_strength(cls, v: str) -> str:
        if not re.search(r"[A-Z]", v):
            raise ValueError("Senha deve ter ao menos 1 letra maiuscula")
        if not re.search(r"[0-9]", v):
            raise ValueError("Senha deve ter ao menos 1 numero")
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
            raise ValueError("Senha deve ter ao menos 1 letra maiuscula")
        if not re.search(r"[0-9]", v):
            raise ValueError("Senha deve ter ao menos 1 numero")
        return v


class RefreshTokenRequest(BaseModel):
    """Schema para renovar access token."""

    model_config = ConfigDict(extra="forbid")

    refresh_token: str
