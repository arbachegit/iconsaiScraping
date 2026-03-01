"""
Tests for Auth Phase 2 — Module permissions and admin protection.

Tests the middleware layer (requirePermission, require_admin) using
real JWT tokens against the FastAPI app. No external DB needed —
tests hit endpoints that will fail at the DB layer but succeed or
fail at the auth/permission layer first.

Test matrix:
  1. No token → 401/403
  2. Valid token, no permission → 403
  3. Valid token, correct permission → passes auth (may fail at DB = expected)
  4. Non-admin on admin routes → 403
  5. Admin on admin routes → passes auth
  6. Seed user permissions → all 4 present
  7. Invalid permissions rejected by schema
  8. Node.js requirePermission constant validation
"""

from datetime import datetime, timedelta, timezone
from typing import Optional

import pytest
from fastapi.testclient import TestClient
from jose import jwt

from api.auth.auth_middleware import (
    ALGORITHM as TEST_ALGORITHM,
)
from api.auth.auth_middleware import (
    SECRET_KEY as TEST_SECRET,
)
from api.auth.auth_middleware import (
    VALID_PERMISSIONS,
    VALID_ROLES,
    require_admin,
    require_permission,
    require_superadmin,
)
from api.auth.schemas.auth_schemas import TokenData
from api.auth.schemas.user_schemas import (
    VALID_PERMISSIONS as SCHEMA_VALID_PERMISSIONS,
)
from api.auth.schemas.user_schemas import (
    AdminCreateUserDirect,
    AdminUpdateUser,
)
from api.main import app

# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------

client = TestClient(app)


def _make_token(
    email: str = "test@iconsai.ai",
    user_id: int = 999,
    name: str = "Test User",
    is_admin: bool = False,
    permissions: Optional[list] = None,
    expired: bool = False,
    role: str = "user",
) -> str:
    """Generate a valid JWT access token for testing."""
    if permissions is None:
        permissions = []
    exp = datetime.now(timezone.utc) + (
        timedelta(hours=-1) if expired else timedelta(hours=8)
    )
    payload = {
        "sub": email,
        "user_id": user_id,
        "name": name,
        "is_admin": is_admin,
        "permissions": permissions,
        "role": role,
        "type": "access",
        "exp": exp,
    }
    return jwt.encode(payload, TEST_SECRET, algorithm=TEST_ALGORITHM)


def _auth_header(token: str) -> dict:
    return {"Authorization": f"Bearer {token}"}


# ---------------------------------------------------------------------------
# 1. Unauthenticated access → 401 or 403
# ---------------------------------------------------------------------------


class TestUnauthenticated:
    """Requests without a valid token should be rejected."""

    def test_admin_list_users_no_token(self):
        """GET /admin/users without token → 401 or 403."""
        r = client.get("/admin/users")
        assert r.status_code in (401, 403)

    def test_admin_create_user_no_token(self):
        """POST /admin/users without token → 401 or 403."""
        r = client.post("/admin/users", json={
            "name": "X", "email": "x@x.com", "password": "Test1234"
        })
        assert r.status_code in (401, 403)

    def test_expired_token(self):
        """Expired token → 401."""
        token = _make_token(expired=True)
        r = client.get("/admin/users", headers=_auth_header(token))
        assert r.status_code == 401


# ---------------------------------------------------------------------------
# 2. Admin route protection — non-admin gets 403
# ---------------------------------------------------------------------------


class TestAdminProtection:
    """Non-admin users must get 403 on all /admin/* endpoints."""

    def setup_method(self):
        self.token = _make_token(
            is_admin=False,
            permissions=["empresas", "pessoas", "politicos", "noticias"],
        )
        self.headers = _auth_header(self.token)

    def test_list_users_non_admin(self):
        r = client.get("/admin/users", headers=self.headers)
        assert r.status_code == 403
        assert "Admin access required" in r.json().get("detail", "")

    def test_create_user_non_admin(self):
        r = client.post("/admin/users", headers=self.headers, json={
            "name": "Test", "email": "t@t.com", "password": "Test1234",
            "permissions": ["empresas"],
        })
        assert r.status_code == 403

    def test_update_user_non_admin(self):
        r = client.put("/admin/users/1", headers=self.headers, json={
            "name": "New Name",
        })
        assert r.status_code == 403

    def test_delete_user_non_admin(self):
        r = client.delete("/admin/users/1", headers=self.headers)
        assert r.status_code == 403

    def test_permanent_delete_non_admin(self):
        r = client.delete("/admin/users/1/permanent", headers=self.headers)
        assert r.status_code == 403

    def test_invite_user_non_admin(self):
        r = client.post("/admin/users/invite", headers=self.headers, json={
            "name": "Test", "email": "t@t.com", "phone": "+5511999990000",
        })
        assert r.status_code == 403

    def test_smtp_test_non_admin(self):
        r = client.get("/admin/smtp-test", headers=self.headers)
        assert r.status_code == 403


# ---------------------------------------------------------------------------
# 3. Admin user passes auth layer (may fail at DB — that's OK)
# ---------------------------------------------------------------------------


class TestAdminAccess:
    """Admin users pass the auth layer for list endpoints. DB errors (500) are acceptable."""

    def setup_method(self):
        self.token = _make_token(
            is_admin=True,
            permissions=["empresas", "pessoas", "politicos", "noticias"],
            role="admin",
        )
        self.headers = _auth_header(self.token)

    def test_list_users_admin(self):
        """Admin should pass auth on list — status is 200 or 500 (DB), never 403."""
        r = client.get("/admin/users", headers=self.headers)
        assert r.status_code != 403, "Admin should not get 403 on list_users"

    def test_smtp_test_admin_gets_403(self):
        """Admin (non-superadmin) should get 403 on smtp-test (superadmin-only)."""
        r = client.get("/admin/smtp-test", headers=self.headers)
        assert r.status_code == 403, "Non-superadmin should get 403 on smtp-test"


class TestSuperAdminAccess:
    """SuperAdmin users pass auth on all endpoints."""

    def setup_method(self):
        self.token = _make_token(
            is_admin=True,
            permissions=["empresas", "pessoas", "politicos", "noticias"],
            role="superadmin",
        )
        self.headers = _auth_header(self.token)

    def test_list_users_superadmin(self):
        """SuperAdmin should pass auth on list — 200 or 500 (DB), never 403."""
        r = client.get("/admin/users", headers=self.headers)
        assert r.status_code != 403, "SuperAdmin should not get 403"

    def test_smtp_test_superadmin(self):
        """SuperAdmin should pass auth on smtp-test."""
        r = client.get("/admin/smtp-test", headers=self.headers)
        assert r.status_code != 403, "SuperAdmin should not get 403 on smtp-test"

    def test_create_user_superadmin(self):
        """SuperAdmin should pass auth on create_user — 200 or 400/500, never 403."""
        r = client.post("/admin/users", headers=self.headers, json={
            "name": "Test", "email": "new@test.com", "password": "Test1234",
            "permissions": ["empresas"], "role": "user",
        })
        assert r.status_code != 403, "SuperAdmin should not get 403 on create_user"

    def test_update_user_superadmin(self):
        """SuperAdmin should pass auth on update — 200/404/500, never 403."""
        r = client.put("/admin/users/99999", headers=self.headers, json={
            "name": "Updated",
        })
        assert r.status_code != 403, "SuperAdmin should not get 403 on update_user"

    def test_delete_user_superadmin(self):
        """SuperAdmin should pass auth on delete — 200/404/500, never 403."""
        r = client.delete("/admin/users/99999", headers=self.headers)
        assert r.status_code != 403, "SuperAdmin should not get 403 on delete_user"


class TestAdminCannotWrite:
    """Admin (non-superadmin) cannot create/update/delete users."""

    def setup_method(self):
        self.token = _make_token(
            is_admin=True,
            permissions=["empresas", "pessoas", "politicos", "noticias"],
            role="admin",
        )
        self.headers = _auth_header(self.token)

    def test_create_user_admin_403(self):
        """Admin should get 403 on create_user (superadmin-only)."""
        r = client.post("/admin/users", headers=self.headers, json={
            "name": "Test", "email": "t@t.com", "password": "Test1234",
            "permissions": ["empresas"],
        })
        assert r.status_code == 403

    def test_update_user_admin_403(self):
        """Admin should get 403 on update_user (superadmin-only)."""
        r = client.put("/admin/users/1", headers=self.headers, json={
            "name": "New Name",
        })
        assert r.status_code == 403

    def test_delete_user_admin_403(self):
        """Admin should get 403 on delete_user (superadmin-only)."""
        r = client.delete("/admin/users/1", headers=self.headers)
        assert r.status_code == 403

    def test_permanent_delete_admin_403(self):
        """Admin should get 403 on permanent_delete (superadmin-only)."""
        r = client.delete("/admin/users/1/permanent", headers=self.headers)
        assert r.status_code == 403


# ---------------------------------------------------------------------------
# 4. Module permission enforcement (Python auth_middleware)
# ---------------------------------------------------------------------------


class TestRequirePermissionUnit:
    """Unit tests for require_permission dependency factory."""

    def test_valid_permissions(self):
        """All 4 permissions should create a valid dependency."""
        for perm in ["empresas", "pessoas", "politicos", "noticias"]:
            dep = require_permission(perm)
            assert callable(dep)

    def test_invalid_permission_raises(self):
        """Invalid permission name should raise ValueError at definition time."""
        with pytest.raises(ValueError, match="Invalid permission"):
            require_permission("admin")

        with pytest.raises(ValueError, match="Invalid permission"):
            require_permission("superuser")

    def test_valid_permissions_set(self):
        """VALID_PERMISSIONS should contain exactly the 4 module permissions."""
        assert {"empresas", "pessoas", "politicos", "noticias"} == VALID_PERMISSIONS


class TestRequireAdminUnit:
    """Unit tests for require_admin dependency."""

    @pytest.mark.asyncio
    async def test_admin_passes(self):
        """Admin user should pass require_admin."""
        user = TokenData(
            email="admin@iconsai.ai",
            user_id=1,
            name="Admin",
            is_admin=True,
            permissions=["empresas"],
        )
        result = await require_admin(current_user=user)
        assert result.email == "admin@iconsai.ai"

    @pytest.mark.asyncio
    async def test_non_admin_rejected(self):
        """Non-admin user should get 403 from require_admin."""
        from fastapi import HTTPException

        user = TokenData(
            email="user@iconsai.ai",
            user_id=2,
            name="User",
            is_admin=False,
            permissions=["empresas", "pessoas", "politicos", "noticias"],
        )
        with pytest.raises(HTTPException) as exc_info:
            await require_admin(current_user=user)
        assert exc_info.value.status_code == 403
        assert "Admin access required" in exc_info.value.detail


# ---------------------------------------------------------------------------
# 5. Schema validation — reject invalid permissions
# ---------------------------------------------------------------------------


class TestSchemaPermissionValidation:
    """Pydantic schemas should reject invalid permission values."""

    def test_valid_permissions_constant(self):
        """Schema VALID_PERMISSIONS matches middleware VALID_PERMISSIONS."""
        assert SCHEMA_VALID_PERMISSIONS == VALID_PERMISSIONS

    def test_create_user_valid_permissions(self):
        """Valid permissions should be accepted."""
        user = AdminCreateUserDirect(
            name="Test",
            email="test@test.com",
            password="Test1234",
            permissions=["empresas", "noticias"],
        )
        assert set(user.permissions) == {"empresas", "noticias"}

    def test_create_user_invalid_permission(self):
        """Invalid permission should be rejected."""
        with pytest.raises(Exception, match="Invalid permissions"):
            AdminCreateUserDirect(
                name="Test",
                email="test@test.com",
                password="Test1234",
                permissions=["empresas", "admin"],
            )

    def test_create_user_empty_permissions(self):
        """Empty permissions list should be accepted."""
        user = AdminCreateUserDirect(
            name="Test",
            email="test@test.com",
            password="Test1234",
            permissions=[],
        )
        assert user.permissions == []

    def test_update_user_valid_permissions(self):
        """AdminUpdateUser should accept valid permissions."""
        update = AdminUpdateUser(permissions=["politicos", "pessoas"])
        assert set(update.permissions) == {"politicos", "pessoas"}

    def test_update_user_invalid_permission(self):
        """AdminUpdateUser should reject invalid permissions."""
        with pytest.raises(Exception, match="Invalid permissions"):
            AdminUpdateUser(permissions=["noticias", "superuser"])

    def test_update_user_null_permissions(self):
        """AdminUpdateUser with None permissions (no change) should be accepted."""
        update = AdminUpdateUser(name="New Name")
        assert update.permissions is None

    def test_all_four_permissions(self):
        """Creating user with all 4 permissions should work."""
        user = AdminCreateUserDirect(
            name="Full Access",
            email="full@test.com",
            password="Test1234",
            permissions=["empresas", "pessoas", "politicos", "noticias"],
        )
        assert len(user.permissions) == 4

    def test_duplicate_permissions_deduped(self):
        """Duplicate permissions should be deduplicated."""
        user = AdminCreateUserDirect(
            name="Dupe",
            email="dupe@test.com",
            password="Test1234",
            permissions=["empresas", "empresas", "noticias"],
        )
        assert len(user.permissions) == 2


# ---------------------------------------------------------------------------
# 6. Node.js constants consistency check
# ---------------------------------------------------------------------------


class TestNodeJsConstants:
    """Verify that Node.js constants file has matching permissions."""

    def test_constants_file_has_permissions(self):
        """backend/src/constants.js should export the same 4 permissions."""
        from pathlib import Path

        constants_path = Path("backend/src/constants.js")
        if not constants_path.exists():
            pytest.skip("Node.js constants file not found")

        content = constants_path.read_text()

        # Check PERMISSIONS object exists
        assert "PERMISSIONS" in content
        assert "ALL_PERMISSIONS" in content

        # Check all 4 values present
        for perm in ["empresas", "pessoas", "politicos", "noticias"]:
            assert perm in content, f"Permission '{perm}' missing from constants.js"

    def test_middleware_file_has_require_permission(self):
        """backend/src/middleware/auth.js should export requirePermission."""
        from pathlib import Path

        auth_path = Path("backend/src/middleware/auth.js")
        if not auth_path.exists():
            pytest.skip("Node.js auth middleware not found")

        content = auth_path.read_text()
        assert "requirePermission" in content
        assert "403" in content

    def test_index_applies_permissions(self):
        """backend/src/index.js should apply requirePermission to module routes."""
        from pathlib import Path

        index_path = Path("backend/src/index.js")
        if not index_path.exists():
            pytest.skip("Node.js index.js not found")

        content = index_path.read_text()

        # Module routes should have requirePermission
        assert "requirePermission(PERMISSIONS.EMPRESAS)" in content
        assert "requirePermission(PERMISSIONS.PESSOAS)" in content
        assert "requirePermission(PERMISSIONS.NOTICIAS)" in content
        assert "requirePermission(PERMISSIONS.POLITICOS)" in content

        # Stats/geo/atlas should NOT have requirePermission
        lines = content.split("\n")
        for line in lines:
            if "'/stats'" in line and "app.use" in line:
                assert "requirePermission" not in line, "stats should not require permission"
            if "'/geo'" in line and "app.use" in line:
                assert "requirePermission" not in line, "geo should not require permission"
            if "'/atlas'" in line and "app.use" in line:
                assert "requirePermission" not in line, "atlas should not require permission"


# ---------------------------------------------------------------------------
# 7. Frontend permissions consistency check
# ---------------------------------------------------------------------------


class TestFrontendPermissions:
    """Verify frontend permissions.ts has correct constants."""

    def test_permissions_ts_exists(self):
        """apps/web/lib/permissions.ts should exist."""
        from pathlib import Path

        perm_path = Path("apps/web/lib/permissions.ts")
        assert perm_path.exists(), "permissions.ts not found"

    def test_permissions_ts_content(self):
        """permissions.ts should contain all 4 permissions and MODULE_PERMISSIONS map."""
        from pathlib import Path

        content = Path("apps/web/lib/permissions.ts").read_text()

        for perm in ["empresas", "pessoas", "politicos", "noticias"]:
            assert perm in content

        # mandatos and emendas should map to politicos
        assert "mandatos" in content
        assert "emendas" in content
        assert "hasModuleAccess" in content
        assert "MODULE_PERMISSIONS" in content

    def test_dashboard_uses_permissions(self):
        """Dashboard page should import and use hasModuleAccess."""
        from pathlib import Path

        dashboard = Path("apps/web/app/dashboard/page.tsx").read_text()
        assert "hasModuleAccess" in dashboard
        assert "userPermissions" in dashboard

    def test_admin_page_protected(self):
        """Admin page should redirect non-admin users."""
        from pathlib import Path

        admin = Path("apps/web/app/admin/page.tsx").read_text()
        assert "is_admin" in admin or "isAdmin" in admin or "is_admin" in admin
        assert "/dashboard" in admin  # redirect target for non-admins

    def test_admin_page_has_permissions_ui(self):
        """Admin page should have permissions column and checkboxes."""
        from pathlib import Path

        admin = Path("apps/web/app/admin/page.tsx").read_text()
        assert "Permissoes" in admin  # column header
        assert "ALL_PERMISSIONS" in admin  # checkbox iteration
        assert "PERMISSION_INFO" in admin  # label display
        assert "togglePermission" in admin or "toggleEditPermission" in admin

    def test_admin_page_has_role_ui(self):
        """Admin page should have role column and role selector."""
        from pathlib import Path

        admin = Path("apps/web/app/admin/page.tsx").read_text()
        assert "ROLE_INFO" in admin
        assert "isSuperAdmin" in admin
        assert "editRole" in admin or "selectedRole" in admin


# ---------------------------------------------------------------------------
# 8. Role system tests
# ---------------------------------------------------------------------------


class TestRoleSystem:
    """Tests for the 3-level role system (superadmin, admin, user)."""

    def test_valid_roles_set(self):
        """VALID_ROLES should contain exactly 3 roles."""
        assert {"superadmin", "admin", "user"} == VALID_ROLES

    def test_token_data_has_role(self):
        """TokenData should accept role field."""
        user = TokenData(
            email="test@test.com",
            user_id=1,
            name="Test",
            is_admin=True,
            permissions=["empresas"],
            role="superadmin",
        )
        assert user.role == "superadmin"

    def test_token_data_default_role(self):
        """TokenData role should default to 'user'."""
        user = TokenData(email="test@test.com", user_id=1, name="Test")
        assert user.role == "user"

    @pytest.mark.asyncio
    async def test_require_superadmin_passes(self):
        """SuperAdmin should pass require_superadmin."""
        user = TokenData(
            email="super@iconsai.ai",
            user_id=1,
            name="Super",
            is_admin=True,
            permissions=["empresas"],
            role="superadmin",
        )
        result = await require_superadmin(current_user=user)
        assert result.role == "superadmin"

    @pytest.mark.asyncio
    async def test_require_superadmin_rejects_admin(self):
        """Admin should get 403 from require_superadmin."""
        from fastapi import HTTPException

        user = TokenData(
            email="admin@iconsai.ai",
            user_id=2,
            name="Admin",
            is_admin=True,
            permissions=["empresas", "pessoas", "politicos", "noticias"],
            role="admin",
        )
        with pytest.raises(HTTPException) as exc_info:
            await require_superadmin(current_user=user)
        assert exc_info.value.status_code == 403
        assert "SuperAdmin" in exc_info.value.detail

    @pytest.mark.asyncio
    async def test_require_superadmin_rejects_user(self):
        """Regular user should get 403 from require_superadmin."""
        from fastapi import HTTPException

        user = TokenData(
            email="user@iconsai.ai",
            user_id=3,
            name="User",
            is_admin=False,
            permissions=["empresas"],
            role="user",
        )
        with pytest.raises(HTTPException) as exc_info:
            await require_superadmin(current_user=user)
        assert exc_info.value.status_code == 403


class TestRoleSchemaValidation:
    """Schema validation for role field."""

    def test_create_user_valid_role(self):
        """Valid roles should be accepted."""
        for role in ["superadmin", "admin", "user"]:
            user = AdminCreateUserDirect(
                name="Test",
                email="test@test.com",
                password="Test1234",
                role=role,
            )
            assert user.role == role

    def test_create_user_invalid_role(self):
        """Invalid role should be rejected."""
        with pytest.raises(Exception, match="Invalid role"):
            AdminCreateUserDirect(
                name="Test",
                email="test@test.com",
                password="Test1234",
                role="moderator",
            )

    def test_update_user_valid_role(self):
        """AdminUpdateUser should accept valid role."""
        update = AdminUpdateUser(role="admin")
        assert update.role == "admin"

    def test_update_user_invalid_role(self):
        """AdminUpdateUser should reject invalid role."""
        with pytest.raises(Exception, match="Invalid role"):
            AdminUpdateUser(role="owner")

    def test_update_user_null_role(self):
        """AdminUpdateUser with None role (no change) should be accepted."""
        update = AdminUpdateUser(name="New Name")
        assert update.role is None

    def test_create_user_default_role(self):
        """Default role should be 'user'."""
        user = AdminCreateUserDirect(
            name="Test",
            email="test@test.com",
            password="Test1234",
        )
        assert user.role == "user"


class TestNodeJsRoles:
    """Verify Node.js backend has role constants."""

    def test_constants_has_roles(self):
        """backend/src/constants.js should export ROLES."""
        from pathlib import Path

        constants_path = Path("backend/src/constants.js")
        if not constants_path.exists():
            pytest.skip("Node.js constants file not found")

        content = constants_path.read_text()
        assert "ROLES" in content
        assert "superadmin" in content
        assert "admin" in content

    def test_middleware_extracts_role(self):
        """backend/src/middleware/auth.js should extract role from JWT."""
        from pathlib import Path

        auth_path = Path("backend/src/middleware/auth.js")
        if not auth_path.exists():
            pytest.skip("Node.js auth middleware not found")

        content = auth_path.read_text()
        assert "role" in content
