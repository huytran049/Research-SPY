"""
Ký và xác thực JWT cho login username-only.

CHUỖI JWT là "vé thông hành": user gõ username → server tạo vé kèm role → frontend giữ trong
localStorage → mỗi request kèm header `Authorization: Bearer <vé>`. Server không lưu vé, chỉ
xác thực chữ ký — không phải track session tay, không phải revoke.

TTL 7 ngày (JWT_TTL_HOURS) phù hợp cho môi trường phát triển hoặc tin cậy. Muốn ngắn hơn → giảm biến; muốn revoke sớm
→ đổi JWT_SECRET (mọi vé đã cấp cũng bị vô hiệu).

`role` nằm trong payload (không phải query DB mỗi request) — nhanh, nhưng đổi role của user
thì vé cũ vẫn còn hiệu lực tới khi hết hạn. Với yêu cầu thu hồi tức thời, cần lưu trạng thái phiên.
"""

from __future__ import annotations

import time
from typing import Any

import jwt

from .config import env_number, env_string

_JWT_SECRET = env_string("JWT_SECRET")
_JWT_TTL_HOURS = env_number("JWT_TTL_HOURS", 168)  # 7 ngày mặc định
_ALG = "HS256"


class JWTError(Exception):
    """Vé JWT sai chữ ký, hết hạn, hoặc thiếu trường bắt buộc."""


def is_configured() -> bool:
    return bool(_JWT_SECRET)


def sign(user_id: str, username: str, role: str) -> str:
    """Ký một vé mới. TTL đọc từ env, HS256 với SECRET chung server."""
    if not _JWT_SECRET:
        raise JWTError("JWT_SECRET chưa khai trong .env.local")
    now = int(time.time())
    payload = {
        "sub": user_id,
        "username": username,
        "role": role,
        "iat": now,
        "exp": now + int(_JWT_TTL_HOURS * 3600),
    }
    return jwt.encode(payload, _JWT_SECRET, algorithm=_ALG)


def verify(token: str) -> dict[str, Any]:
    """
    Giải vé + kiểm chữ ký + kiểm hạn. Trả payload đã decode.

    Ném JWTError với thông điệp cụ thể (hết hạn / sai chữ ký / thiếu trường) — endpoint tự
    chuyển thành 401 hoặc 403 tuỳ nghĩa.
    """
    if not _JWT_SECRET:
        raise JWTError("JWT_SECRET chưa khai — không thể xác thực")
    try:
        payload = jwt.decode(token, _JWT_SECRET, algorithms=[_ALG])
    except jwt.ExpiredSignatureError:
        raise JWTError("Vé đã hết hạn, đăng nhập lại")
    except jwt.InvalidTokenError as e:
        raise JWTError(f"Vé không hợp lệ: {e}")
    for key in ("sub", "username", "role"):
        if key not in payload:
            raise JWTError(f"Vé thiếu trường {key}")
    return payload
