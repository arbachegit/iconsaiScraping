"""
User-related Pydantic schemas.

Includes: user CRUD, profile completion, expanded user response.
"""

import re
from typing import List, Optional

from pydantic import BaseModel, ConfigDict, EmailStr, Field, field_validator

VALID_PERMISSIONS = {"empresas", "pessoas", "politicos", "noticias"}
VALID_ROLES = {"superadmin", "admin", "user"}


class AdminInviteUser(BaseModel):
    """Creates user by invite (name + email + phone, no CPF)."""

    model_config = ConfigDict(str_strip_whitespace=True, extra="forbid")

    name: str = Field(..., min_length=2, max_length=200)
    email: EmailStr
    phone: str = Field(..., min_length=10, max_length=20)

    @field_validator("email")
    @classmethod
    def normalize_email(cls, v: str) -> str:
        return v.lower().strip()

    @field_validator("phone")
    @classmethod
    def validate_phone(cls, v: str) -> str:
        clean = re.sub(r"[^\d+]", "", v)
        if not clean.startswith("+55"):
            clean = f"+55{clean.lstrip('+')}"
        digits_only = clean.replace("+", "")
        if len(digits_only) < 12 or len(digits_only) > 13:
            raise ValueError(
                "Telefone deve ter formato brasileiro (+55XXXXXXXXXXX)"
            )
        return clean


class AdminCreateUserDirect(BaseModel):
    """Creates user with direct password."""

    model_config = ConfigDict(str_strip_whitespace=True, extra="forbid")

    name: str = Field(..., min_length=2, max_length=200)
    email: EmailStr
    password: str = Field(..., min_length=8, max_length=128)
    permissions: List[str] = []
    role: str = "user"

    @field_validator("email")
    @classmethod
    def normalize_email(cls, v: str) -> str:
        return v.lower().strip()

    @field_validator("permissions")
    @classmethod
    def validate_permissions(cls, v: List[str]) -> List[str]:
        invalid = set(v) - VALID_PERMISSIONS
        if invalid:
            raise ValueError(
                f"Invalid permissions: {invalid}. Valid: {VALID_PERMISSIONS}"
            )
        return list(set(v))

    @field_validator("role")
    @classmethod
    def validate_role(cls, v: str) -> str:
        if v not in VALID_ROLES:
            raise ValueError(
                f"Invalid role: {v}. Valid: {VALID_ROLES}"
            )
        return v


class AdminUpdateUser(BaseModel):
    """Updates user fields."""

    model_config = ConfigDict(str_strip_whitespace=True, extra="forbid")

    name: Optional[str] = Field(default=None, min_length=2, max_length=200)
    email: Optional[EmailStr] = None
    phone: Optional[str] = Field(default=None, max_length=20)
    cpf: Optional[str] = Field(default=None, max_length=20)
    cep: Optional[str] = Field(default=None, max_length=10)
    logradouro: Optional[str] = Field(default=None, max_length=255)
    numero: Optional[str] = Field(default=None, max_length=20)
    complemento: Optional[str] = Field(default=None, max_length=100)
    bairro: Optional[str] = Field(default=None, max_length=100)
    cidade: Optional[str] = Field(default=None, max_length=100)
    uf: Optional[str] = Field(default=None, max_length=2)
    permissions: Optional[List[str]] = None
    role: Optional[str] = None
    is_active: Optional[bool] = None
    new_password: Optional[str] = Field(default=None, min_length=8, max_length=128)

    @field_validator("permissions")
    @classmethod
    def validate_permissions(cls, v: Optional[List[str]]) -> Optional[List[str]]:
        if v is None:
            return v
        invalid = set(v) - VALID_PERMISSIONS
        if invalid:
            raise ValueError(
                f"Invalid permissions: {invalid}. Valid: {VALID_PERMISSIONS}"
            )
        return list(set(v))

    @field_validator("role")
    @classmethod
    def validate_role(cls, v: Optional[str]) -> Optional[str]:
        if v is None:
            return v
        if v not in VALID_ROLES:
            raise ValueError(
                f"Invalid role: {v}. Valid: {VALID_ROLES}"
            )
        return v

    @field_validator("email")
    @classmethod
    def normalize_email(cls, v: Optional[str]) -> Optional[str]:
        if v is None:
            return v
        return v.lower().strip()


class AdminUserResponse(BaseModel):
    """Response for admin user listing."""

    id: int
    email: str
    name: Optional[str] = None
    is_admin: bool = False
    role: str = "user"
    permissions: List[str] = []
    is_active: bool = True
    is_verified: bool = True


class UserProfileComplete(BaseModel):
    """User completes profile (CPF + address)."""

    model_config = ConfigDict(str_strip_whitespace=True, extra="forbid")

    cpf: str = Field(..., pattern=r"^\d{3}\.?\d{3}\.?\d{3}-?\d{2}$")
    cep: str = Field(..., pattern=r"^\d{5}-?\d{3}$")
    logradouro: str = Field(..., min_length=2, max_length=255)
    numero: str = Field(..., min_length=1, max_length=20)
    complemento: Optional[str] = Field(None, max_length=100)
    bairro: str = Field(..., min_length=2, max_length=100)
    cidade: str = Field(..., min_length=2, max_length=100)
    uf: str = Field(..., pattern=r"^[A-Z]{2}$")


class UserResponseExpanded(BaseModel):
    """Expanded user response with profile_complete flag."""

    id: int
    email: str
    name: Optional[str] = None
    is_admin: bool = False
    role: str = "user"
    permissions: List[str] = []
    is_active: bool = True
    is_verified: bool = True
    profile_complete: bool = False
