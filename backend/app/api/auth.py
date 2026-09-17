"""
Đăng nhập bằng email thuộc miền được phép kèm hồ sơ người dùng, có bước phê duyệt.

LUỒNG:
  1. POST /api/auth/login { email }
     - email không thuộc miền được phép → 400
     - email CHƯA có trong DB → 200 { needsRegistration: true } → frontend hiện form 3 trường
     - đã có, status=pending  → 403 { pending: true }  → trang chờ
     - đã có, status=rejected → 403 { error }
     - đã có, status=approved + active → 200 { token, user }
  2. POST /api/auth/register { email, fullName, position, bu }
     - đủ 3 trường + đúng domain → tạo bản ghi pending → 202 { pending: true }
  3. Trang chờ POLL lại /login mỗi ~15s. Khi admin duyệt → /login trả token → vào app.

Luồng này dùng email-domain allowlist và phê duyệt thủ công, không xác minh quyền sở hữu email.
Chỉ nên dùng trong môi trường tin cậy. Với triển khai công khai, cần tích hợp SSO hoặc xác minh
OTP trước khi cấp token.
"""

from __future__ import annotations

import logging
import re

from fastapi import APIRouter, Request
from fastapi.responses import JSONResponse
from pydantic import BaseModel, Field

log = logging.getLogger("auth")

from lib.core.bu import BU_CHOICES, fx_green_threshold, normalize_bu
from lib.core.config import env_string
from lib.core.db import supabase_or_none, is_configured as db_ready
from lib.core.jwt_util import sign, JWTError, is_configured as jwt_ready

router = APIRouter(prefix="/api/auth", tags=["auth"])

#: Miền email được phép. Cấu hình bằng `ALLOWED_EMAIL_DOMAIN` trong `.env.local`.
_ALLOWED_DOMAIN = env_string("ALLOWED_EMAIL_DOMAIN", "tntecom.com").lower()
_EMAIL_RE = re.compile(r"^[a-z0-9._%+\-]+@[a-z0-9.\-]+\.[a-z]{2,}$")

#: Các cột trả về cho frontend (không lộ gì nhạy cảm — bảng chỉ có hồ sơ công việc).
_USER_FIELDS = "id, email, full_name, position, bu, role, is_active, status"


class LoginBody(BaseModel):
    email: str = Field(..., min_length=3, max_length=120)


class RegisterBody(BaseModel):
    email: str = Field(..., min_length=3, max_length=120)
    full_name: str = Field(..., alias="fullName", min_length=1, max_length=120)
    position: str = Field(..., min_length=1, max_length=120)
    bu: str = Field(..., min_length=1, max_length=120)

    model_config = {"populate_by_name": True}


def _norm_email(raw: str) -> str:
    return (raw or "").strip().lower()


def _legacy_username(email: str) -> str:
    """
    Sinh giá trị cho cột `username` legacy từ email, thoả CHECK(~ '^[a-z0-9._-]+$').
    Thay mọi ký tự ngoài [a-z0-9._-] (gồm '@') bằng '-'. Đơn ánh gần như tuyệt đối với email
    thông thường (local-part chỉ chữ/số/dấu chấm) nên không đụng UNIQUE.
    """
    return re.sub(r"[^a-z0-9._-]", "-", email.lower())


def _valid_company_email(email: str) -> bool:
    return bool(_EMAIL_RE.match(email)) and email.endswith("@" + _ALLOWED_DOMAIN)


def _config_missing_response():
    return JSONResponse(
        {"error": "Supabase/JWT chưa cấu hình. Xem .env.example mục 'TÀI KHOẢN NGƯỜI DÙNG'."},
        status_code=501,
    )


def _public_user(u: dict) -> dict:
    """Hồ sơ trả cho frontend — kèm displayName ghép sẵn 'Tên · Vị trí · BU'."""
    parts = [u.get("full_name"), u.get("position"), u.get("bu")]
    display = " · ".join([p for p in parts if p]) or u.get("email") or ""
    return {
        "id": u["id"],
        "email": u.get("email"),
        "fullName": u.get("full_name"),
        "position": u.get("position"),
        "bu": u.get("bu"),
        "role": u.get("role"),
        "displayName": display,
        # Ngưỡng xanh MẶC ĐỊNH theo BU, tính ở server chứ không để trang tự tra.
        #
        # Trang Research là một file tĩnh và không có cách nào biết bảng tra BU→ngưỡng; chép
        # bảng ấy sang JavaScript nghĩa là từ nay thêm một BU phải nhớ sửa hai nơi, và nơi
        # quên sửa sẽ hỏng im lặng (người dùng vẫn thấy một con số, chỉ là con số của BU khác).
        # Gửi kèm lúc đăng nhập thì `lib/core/bu.py` vẫn là nơi duy nhất giữ chính sách.
        "fxGreenThreshold": fx_green_threshold(u.get("bu")),
    }


def _domain_error():
    return JSONResponse(
        {"error": f"Chỉ nhận email thuộc miền @{_ALLOWED_DOMAIN}."},
        status_code=400,
    )


def _supa_error(e: Exception, where: str) -> JSONResponse:
    """Một lời gọi Supabase ném lỗi. Ghi traceback đầy đủ ra log service, và trả JSON có
    chi tiết (thay vì 500 trơ) để giao diện + chẩn đoán đọc được lý do thật — thường là
    thiếu cột (migration chưa chạy) hoặc sai key. Không trả secret; thông báo từ PostgREST chỉ
    chứa tên cột hoặc bảng. Bản triển khai công khai nên thay chi tiết này bằng mã lỗi chung."""
    log.exception("Supabase '%s' lỗi: %s", where, e)
    return JSONResponse(
        {"error": f"Lỗi truy vấn dữ liệu người dùng ({where}): {e}"},
        status_code=502,
    )


@router.post("/login")
async def login(body: LoginBody) -> JSONResponse:
    if not (db_ready() and jwt_ready()):
        return _config_missing_response()

    email = _norm_email(body.email)
    if not _valid_company_email(email):
        return _domain_error()

    supa = supabase_or_none()
    try:
        existing = supa.table("users").select(_USER_FIELDS).eq("email", email).limit(1).execute()
    except Exception as e:
        return _supa_error(e, "login-select")
    rows = existing.data or []

    if not rows:
        # Chưa đăng ký → frontend hiện form Tên/Vị trí/BU. KHÔNG tạo bản ghi ở đây (chờ /register
        # có đủ hồ sơ mới tạo) — tránh rác email trống hồ sơ nếu user bỏ ngang.
        return JSONResponse({"needsRegistration": True, "email": email})

    user = rows[0]
    status = user.get("status") or "pending"
    if not user.get("is_active", True):
        return JSONResponse({"error": "Tài khoản đã bị khoá — liên hệ admin."}, status_code=403)
    if status == "pending":
        return JSONResponse(
            {"pending": True, "message": "Yêu cầu đang chờ quản trị viên duyệt."},
            status_code=403,
        )
    if status == "rejected":
        return JSONResponse(
            {"error": "Yêu cầu truy cập đã bị từ chối. Liên hệ quản trị viên nếu cần."},
            status_code=403,
        )

    try:
        supa.table("users").update({"last_login_at": "now()"}).eq("id", user["id"]).execute()
    except Exception as e:
        return _supa_error(e, "login-update")
    try:
        token = sign(user_id=str(user["id"]), username=user.get("email") or "", role=user["role"])
    except JWTError as e:
        return JSONResponse({"error": str(e)}, status_code=500)

    return JSONResponse({"token": token, "user": _public_user(user)})


@router.post("/register")
async def register(body: RegisterBody) -> JSONResponse:
    """Gửi yêu cầu truy cập: đủ email đúng domain + Tên + Vị trí + BU → tạo bản ghi pending."""
    if not (db_ready() and jwt_ready()):
        return _config_missing_response()

    email = _norm_email(body.email)
    if not _valid_company_email(email):
        return _domain_error()
    full_name = body.full_name.strip()
    position = body.position.strip()
    if not (full_name and position and body.bu.strip()):
        return JSONResponse({"error": "Phải nhập đủ Tên, Vị trí và BU."}, status_code=400)
    # BU phải là MỘT MÃ trong danh sách chốt, không phải chữ người dùng tự gõ. Ô trên giao diện
    # đã là ô chọn, nhưng kiểm lại ở đây vì giao diện không phải một chốt chặn — và vì từ nay
    # BU quyết định ngưỡng xanh, nên một cách viết lạ sẽ lặng lẽ áp sai chính sách cho người ấy.
    bu = normalize_bu(body.bu)
    if bu is None:
        return JSONResponse(
            {"error": f"BU phải là một trong: {', '.join(BU_CHOICES)}."}, status_code=400
        )

    supa = supabase_or_none()
    # Đã tồn tại rồi → không tạo trùng, báo trạng thái hiện tại để frontend chuyển đúng màn.
    try:
        existing = supa.table("users").select("status").eq("email", email).limit(1).execute()
    except Exception as e:
        return _supa_error(e, "register-select")
    if existing.data:
        st = existing.data[0].get("status") or "pending"
        if st == "approved":
            return JSONResponse({"error": "Email đã được duyệt — bấm đăng nhập."}, status_code=409)
        return JSONResponse(
            {"pending": True, "message": "Yêu cầu đã tồn tại và đang chờ duyệt."},
            status_code=202,
        )

    try:
        supa.table("users").insert({
            # Cột `username` cũ còn 3 ràng buộc legacy: NOT NULL + UNIQUE + CHECK(~ '^[a-z0-9._-]+$').
            # Đặt = email ĐÃ LÀM SẠCH (thay @ và ký tự lạ bằng '-') để qua cả CHECK lẫn NOT NULL mà
            # vẫn unique theo email. Định danh thật của luồng mới là `email`; username chỉ để thoả legacy.
            "username": _legacy_username(email),
            "email": email,
            "full_name": full_name,
            "position": position,
            "bu": bu,
            "role": "user",
            "status": "pending",
            "is_active": True,
        }).execute()
    except Exception as e:
        return JSONResponse({"error": f"Không gửi được yêu cầu: {e}"}, status_code=400)

    return JSONResponse(
        {
            "pending": True,
            "message": f'Đã gửi yêu cầu cho "{email}". Chờ quản trị viên (Vương Anh) duyệt.',
        },
        status_code=202,
    )


@router.get("/me")
async def me(request: Request) -> JSONResponse:
    user = getattr(request.state, "user", None)
    if not user:
        return JSONResponse({"error": "Chưa đăng nhập"}, status_code=401)
    return JSONResponse({"user": user})


@router.post("/logout")
async def logout() -> JSONResponse:
    return JSONResponse({"ok": True})
