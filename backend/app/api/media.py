"""
GET /api/media?url=… — proxy phát media.

Mục tiêu của route này là phát creative trực tiếp trên trình duyệt mà không lưu video, vì ở khối lượng
này lưu là không quản nổi. Hai thứ khiến `<video src>` thẳng không chạy được — CDN của
các nền tảng đều chặn hotlink, và link của họ có chữ ký, hết hạn nhanh — nên request
được chuyển tiếp qua đây kèm Referer phù hợp, không ghi gì xuống đĩa. Header Range được
chuyển tiếp nguyên vẹn để tua video vẫn hoạt động.

DANH SÁCH HOST ĐƯỢC PHÉP LÀ CHỐT AN TOÀN: thiếu nó, route này thành một open proxy mà bất
kỳ ai trong mạng nội bộ cũng trỏ được tới host tuỳ ý. Danh sách được dựng từ khai báo
`media` của từng nguồn trong `lib/ads/platforms`, nên thêm nguồn mới là CDN của nó chạy
ngay mà không phải sửa file này.
"""

from __future__ import annotations

from dataclasses import dataclass
from urllib.parse import urlsplit

from fastapi import APIRouter, Request
from fastapi.responses import Response, StreamingResponse
from starlette.background import BackgroundTask

from lib.ads.platforms import AD_PLATFORMS, PLATFORM_IDS
from lib.core.http import get_client

router = APIRouter(prefix="/api/media")


@dataclass(frozen=True)
class _Allowed:
    suffix: str
    referer: str


ALLOWED: list[_Allowed] = [
    _Allowed(suffix=suffix, referer=AD_PLATFORMS[platform_id].media.referer)
    for platform_id in PLATFORM_IDS
    if AD_PLATFORMS[platform_id].media is not None
    for suffix in AD_PLATFORMS[platform_id].media.host_suffixes  # type: ignore[union-attr]
]

# CDN alicdn KHÔNG còn khai tay ở đây: từ khi 1688 thành một nguồn thật
# (`lib/ads/platforms/ali1688.py`) nó tự khai `MediaPolicy` và danh sách dựng ở trên đã phủ.
# Mục "Giá vốn theo ảnh" dùng chung đúng CDN ấy nên vẫn được phục vụ như cũ.
ALLOWED += [
    # Ảnh bìa video lấy qua nguồn Google (`site:tiktok.com` ở tab Hình ảnh) là bản thu nhỏ do
    # chính Google phục vụ, trên `encrypted-tbnN.gstatic.com` — KHÔNG phải CDN của TikTok. Thiếu
    # dòng này thì proxy trả 403 và cả lưới video Google hiện ra toàn ảnh vỡ, trong khi link
    # video vẫn đúng: một kiểu hỏng trông như "nguồn không có ảnh" chứ không như một lỗi chặn.
    _Allowed(suffix="gstatic.com", referer="https://www.google.com/"),
    # AMAZON và TEMU chạy qua extension nên KHÔNG có mặt trong sổ đăng ký nguồn, và vì thế ảnh
    # của chúng không tự vào được danh sách dựng ở trên. Điều đó không sao với BẢNG kết quả —
    # thẻ Amazon/Temu hiện ảnh thẳng từ CDN, không qua proxy. Nhưng "Giá vốn theo ảnh" thì BẮT
    # BUỘC đi qua đây (`research.js::fetch1688Offers` tải ảnh về rồi mới gửi lên 1688), nên
    # bấm 💰 trên một dòng Amazon/Temu trả về đúng câu "Không tải được ảnh: HTTP 403".
    #
    # Đo 2026-09-10 qua proxy production: `m.media-amazon.com` 403, `img.kwcdn.com` 403, trong
    # khi Shopee/Etsy/1688/Taobao đều qua. Tức là tính năng giá vốn chỉ hỏng ở đúng hai sàn ấy.
    _Allowed(suffix="media-amazon.com", referer="https://www.amazon.com/"),
    _Allowed(suffix="ssl-images-amazon.com", referer="https://www.amazon.com/"),
    _Allowed(suffix="kwcdn.com", referer="https://www.temu.com/"),
    # TikTok Shop lấy từ Kalodata: ảnh sản phẩm/video ở `img.kalocdn.com`, PUBLIC (curl không
    # cookie ra 200). Bảng hiện ảnh thẳng, nhưng 💰 Giá vốn tải ảnh qua đây — thiếu dòng này
    # là "Không tải được ảnh: HTTP 403" đúng ở dòng TikTok Shop, như Amazon/Temu trước kia.
    _Allowed(suffix="kalocdn.com", referer="https://www.kalodata.com/"),
]

#: Header cần giữ nguyên để trình phát biết cách đọc dòng byte. `content-encoding` không có
#: trong bản TypeScript vì `fetch` của Node đã tự giải nén; ở đây byte được chuyển tiếp
#: nguyên trạng nên nhãn nén phải đi cùng, nếu không trình duyệt sẽ đọc byte nén như video.
FORWARDED_HEADERS = [
    "content-type",
    "content-length",
    "content-range",
    "accept-ranges",
    "etag",
    "content-encoding",
]


def _match_host(url: str) -> _Allowed | None:
    """Tìm nguồn sở hữu host này. `None` nghĩa là không nguồn nào — chặn."""
    parts = urlsplit(url)
    if parts.scheme != "https":
        return None
    hostname = (parts.hostname or "").lower()
    for entry in ALLOWED:
        if hostname == entry.suffix or hostname.endswith(f".{entry.suffix}"):
            return entry
    return None


@router.get("")
async def media(request: Request) -> Response:
    target = request.query_params.get("url")
    if not target:
        return Response("missing url", status_code=400)

    try:
        parsed = urlsplit(target)
        if not parsed.scheme or not parsed.netloc:
            raise ValueError("thiếu scheme hoặc host")
    except ValueError:
        return Response("invalid url", status_code=400)

    allowed = _match_host(target)
    if allowed is None:
        return Response("host not allowed", status_code=403)

    headers = {
        "user-agent": request.headers.get("user-agent") or "Mozilla/5.0",
        "referer": allowed.referer,
        "accept": "*/*",
    }
    # Chuyển tiếp Range để trình phát tua được thay vì phải tải cả file.
    incoming_range = request.headers.get("range")
    if incoming_range:
        headers["range"] = incoming_range

    client = get_client()
    try:
        upstream_request = client.build_request("GET", target, headers=headers)
        upstream = await client.send(upstream_request, stream=True, follow_redirects=True)
    except Exception as error:
        return Response(f"upstream fetch failed: {error}", status_code=502)

    if not (200 <= upstream.status_code < 300) and upstream.status_code != 206:
        status = upstream.status_code
        await upstream.aclose()
        # Link ký số hết hạn là trường hợp phổ biến nhất; nói rõ thay vì hiện một player chết.
        hint = " (link đã hết hạn — search lại để lấy link mới)" if status in (403, 410) else ""
        return Response(f"upstream {status}{hint}", status_code=status)

    out: dict[str, str] = {}
    for key in FORWARDED_HEADERS:
        value = upstream.headers.get(key)
        if value:
            out[key] = value
    if "accept-ranges" not in out:
        out["accept-ranges"] = "bytes"
    # Chỉ cache ngắn: link này hết hạn, cache lâu sẽ phục vụ media đã chết.
    out["cache-control"] = "private, max-age=300"

    return StreamingResponse(
        upstream.aiter_raw(),
        status_code=upstream.status_code,
        headers=out,
        background=BackgroundTask(upstream.aclose),
    )
