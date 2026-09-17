"""
NGUỒN: Shopee — tìm SẢN PHẨM (không phải quảng cáo).

Đây là nguồn client_fetch đầu tiên (Cách A). Lý do bắt buộc phải fetch phía client, không
phải chọn lựa: endpoint tìm sản phẩm `search_items` của Shopee trả **403 cho request ẩn danh
ẩn danh từ server**, kể cả từ một trang trình duyệt đã làm nóng (đã đo 2026-07-28, xem
`lib/keywords/providers/shopee.py`). Nhưng chính trình duyệt của user đã đăng nhập lại gọi
được bình thường — nên server chỉ *dựng lệnh* (`build_request`), extension chạy bằng session
của user, rồi server chuẩn hoá raw (`parse_response`). Cookie không bao giờ rời máy user.

Khác biệt với Facebook/TikTok ở mục ads-spy: hai nguồn đó server tự scrape bằng Playwright.
Shopee thì không thể — nên nó đi đường client_fetch. Cùng một hợp đồng `AdPlatform`, chỉ
khác hiện thực đúng hai method.
"""

from __future__ import annotations

import json
from dataclasses import dataclass
from urllib.parse import quote

from ..platform import (
    AdPlatform,
    HealthProbe,
    MediaPolicy,
    PlatformCapabilities,
    PlatformChoice,
    PlatformOption,
    PlatformSearchInput,
    PlatformSearchOutcome,
    RequestSpec,
)
from ..types import Ad, ClientResponse, CountryCode, Creative

PLATFORM_ID = "shopee"

#: Shopee chạy một tên miền + một region ảnh riêng cho mỗi thị trường.
DOMAIN: dict[str, str] = {
    "VN": "shopee.vn",
    "TH": "shopee.co.th",
    "PH": "shopee.ph",
    "MY": "shopee.com.my",
    "ID": "shopee.co.id",
    "SG": "shopee.sg",
    "TW": "shopee.tw",
    "BR": "shopee.com.br",
    "MX": "shopee.com.mx",
    "CO": "shopee.com.co",
    "CL": "shopee.cl",
}

#: CDN ảnh của Shopee dùng subdomain theo region: down-vn / down-th…
IMG_REGION: dict[str, str] = {
    "VN": "vn", "TH": "th", "PH": "ph", "MY": "my", "ID": "id", "SG": "sg",
    "TW": "tw", "BR": "br", "MX": "mx", "CO": "co", "CL": "cl",
}

#: Tiền tệ theo thị trường, để giao diện định dạng `price` đúng ký hiệu.
CURRENCY: dict[str, str] = {
    "VN": "VND", "TH": "THB", "PH": "PHP", "MY": "MYR", "ID": "IDR", "SG": "SGD",
    "TW": "TWD", "BR": "BRL", "MX": "MXN", "CO": "COP", "CL": "CLP",
}

#: Shopee trả tối đa 60 item mỗi trang; xin lớn hơn bị cắt về 60.
PAGE_SIZE = 60

#: Trần số trang một lần search, chặn việc một tài khoản user bắn quá nhiều request liên tiếp
#: (rủi ro bị Shopee gắn cờ). Đủ 120 sản phẩm là dư cho một trang kết quả.
MAX_PAGES = 2

#: Shopee lưu `price` dưới dạng số nguyên đã nhân 100.000 — chia lại để ra giá thật.
PRICE_SCALE = 100_000

#: `by` của Shopee: cách sắp xếp kết quả tìm.
SORT_BY = {
    "relevancy": "relevancy",
    "sales": "sales",
    "latest": "ctime",
    "price": "price",
}


@dataclass(frozen=True)
class ShopeeOptions:
    #: Cách sắp xếp, một trong khoá của `SORT_BY`. Mặc định "sales" (bán chạy) vì đây là tool
    #: research: top-seller là ứng viên đáng xem nhất, và sort theo relevancy trả về feed
    #: nặng quảng cáo (đo được: nhiều item `adsid`, item_basic rỗng).
    sort: str = "sales"


def _search_url(domain: str, keyword: str, sort: str, page: int) -> str:
    """Một trang của endpoint nội bộ `search_items`."""
    query = [
        ("by", SORT_BY.get(sort, "relevancy")),
        ("keyword", keyword),
        ("limit", str(PAGE_SIZE)),
        ("newest", str(page * PAGE_SIZE)),
        ("order", "desc"),
        ("page_type", "search"),
        ("scenario", "PAGE_GLOBAL_SEARCH"),
        ("version", "2"),
    ]
    encoded = "&".join(f"{k}={quote(str(v), safe='')}" for k, v in query)
    return f"https://{domain}/api/v4/search/search_items?{encoded}"


def _image_url(country: str, image_hash: str | None) -> str | None:
    if not image_hash:
        return None
    region = IMG_REGION.get(country.upper(), "vn")
    return f"https://down-{region}.img.susercontent.com/file/{image_hash}"


def _first_int(*values: object) -> int | None:
    for v in values:
        if isinstance(v, int):
            return v
    return None


def _first_num(*values: object) -> float | None:
    for v in values:
        if isinstance(v, (int, float)) and v > 0:
            return float(v)
    return None


def _normalise(item: dict, country: CountryCode, domain: str) -> Ad | None:
    """
    Một item của Shopee search → `Ad`.

    Đo 2026-08: Shopee đã BỎ `item_basic` (giờ null) và chuyển product data sang
    `item_card_displayed_asset` (tên, ảnh) + `item_data` (giá, số bán, shop). Hàm này đọc
    format mới trước, rồi rơi về `item_basic` cũ — để không vỡ khi Shopee đổi qua lại.
    """
    basic = item.get("item_basic") if isinstance(item.get("item_basic"), dict) else {}
    asset = item.get("item_card_displayed_asset") if isinstance(item.get("item_card_displayed_asset"), dict) else {}
    idata = item.get("item_data") if isinstance(item.get("item_data"), dict) else {}

    itemid = item.get("itemid") or basic.get("itemid")
    shopid = item.get("shopid") or basic.get("shopid")
    if itemid is None or shopid is None:
        return None
    itemid, shopid = str(itemid), str(shopid)

    name = asset.get("name") or basic.get("name") or ""

    images = asset.get("images") if isinstance(asset.get("images"), list) else []
    image_hash = asset.get("image") or (images[0] if images else None) or basic.get("image")
    image = _image_url(country, image_hash if isinstance(image_hash, str) else None)
    creatives = [Creative(kind="image", url=image)] if image else []

    # Giá đơn vị ×100000. item_data là số sạch nhất; rồi tới asset; rồi format cũ.
    display_price = idata.get("item_card_display_price") if isinstance(idata.get("item_card_display_price"), dict) else {}
    asset_price = asset.get("display_price") if isinstance(asset.get("display_price"), dict) else {}
    raw_price = _first_num(display_price.get("price"), asset_price.get("price"), basic.get("price"))
    price = raw_price / PRICE_SCALE if raw_price is not None else None

    # Số đã bán: tổng luỹ kế + nhịp theo tháng (tách riêng vì scoring ưu tiên nhịp gần đây).
    sold_block = idata.get("item_card_display_sold_count") if isinstance(idata.get("item_card_display_sold_count"), dict) else {}
    sold = _first_int(sold_block.get("historical_sold_count"), basic.get("historical_sold"), basic.get("sold"))
    monthly = _first_int(sold_block.get("monthly_sold_count"))

    # Rating: item_data.item_rating = {rating_star, rating_count: [tổng, 1★, 2★, ...]}.
    rating_block = idata.get("item_rating") if isinstance(idata.get("item_rating"), dict) else {}
    raw_rating = rating_block.get("rating_star")
    rating = float(raw_rating) if isinstance(raw_rating, (int, float)) and raw_rating > 0 else None
    rc = rating_block.get("rating_count")
    rating_count = rc[0] if isinstance(rc, list) and rc and isinstance(rc[0], int) else None

    shop_data = idata.get("shop_data") if isinstance(idata.get("shop_data"), dict) else {}
    advertiser = shop_data.get("shop_name") or asset.get("shop_location") or basic.get("shop_location") or "Shopee"

    return Ad(
        id=itemid,
        platform=PLATFORM_ID,
        # "advertiser" ở product search mang nghĩa người bán: tên shop khi có, không thì vị trí.
        advertiser=advertiser if isinstance(advertiser, str) else "Shopee",
        body=name if isinstance(name, str) else "",
        title=name if isinstance(name, str) else None,
        permalink=f"https://{domain}/product/{shopid}/{itemid}",
        creatives=creatives,
        price=price,
        currency=CURRENCY.get(country.upper()),
        sold_count=sold,
        monthly_sold=monthly,
        rating=rating,
        rating_count=rating_count,
        countries=[country],
    )


class Shopee(AdPlatform):
    id = PLATFORM_ID
    label = "Shopee"
    #: `client_fetch=True` là điểm định tuyến: `search.py` sẽ không tự gọi mà giao lệnh cho
    #: extension. `start_date=False` vì sản phẩm không có "ngày bắt đầu chạy" như quảng cáo.
    capabilities = PlatformCapabilities(
        keyword_search=True, start_date=False, remote_filters=False, client_fetch=True
    )
    countries = list(DOMAIN.keys())
    options = [
        PlatformOption(
            key="sort",
            label="Sắp xếp",
            hint=(
                "Mặc định “Bán chạy” — top-seller là ứng viên research đáng xem nhất, và tránh "
                "được feed nặng quảng cáo của sort liên quan."
            ),
            kind="choice",
            default_value="sales",
            choices=[
                PlatformChoice(value="sales", label="Bán chạy"),
                PlatformChoice(value="relevancy", label="Liên quan"),
                PlatformChoice(value="latest", label="Mới nhất"),
                PlatformChoice(value="price", label="Giá"),
            ],
        ),
    ]
    media = MediaPolicy(
        host_suffixes=["susercontent.com", "shopee.vn"],
        referer="https://shopee.vn/",
    )
    health_probe = HealthProbe(keyword="áo thun", country="VN")

    def parse_options(self, raw: dict[str, str]) -> ShopeeOptions:
        sort = (raw.get("sort") or "").strip()
        return ShopeeOptions(sort=sort if sort in SORT_BY else "sales")

    def build_request(self, request: PlatformSearchInput) -> list[RequestSpec]:
        country = request.country.upper()
        domain = DOMAIN.get(country)
        if not domain:
            raise RuntimeError(f"Shopee không hoạt động ở {country}")

        options: ShopeeOptions = request.options
        pages = min(MAX_PAGES, max(1, -(-request.limit // PAGE_SIZE)))  # ceil(limit/PAGE_SIZE)

        specs: list[RequestSpec] = []
        for page in range(pages):
            specs.append(
                RequestSpec(
                    url=_search_url(domain, request.keyword, options.sort, page),
                    method="GET",
                    # Endpoint nội bộ đòi hai header này; referer đặt để khớp origin của trang search.
                    headers={
                        "x-api-source": "pc",
                        "x-requested-with": "XMLHttpRequest",
                        "referer": f"https://{domain}/search?keyword={quote(request.keyword, safe='')}",
                    },
                    tag=f"page-{page}",
                )
            )
        return specs

    def parse_response(
        self, request: PlatformSearchInput, responses: list[ClientResponse]
    ) -> PlatformSearchOutcome:
        country = request.country
        domain = DOMAIN.get(country.upper(), "shopee.vn")

        out: list[Ad] = []
        seen: set[str] = set()
        blocked = False
        for response in responses:
            # 403 nghĩa là session của user không qua được cửa Shopee (chưa đăng nhập / hết hạn).
            # Nói thẳng ra để giao diện hướng user đăng nhập lại, thay vì hiện lưới rỗng im lặng.
            if response.status == 403:
                blocked = True
                continue
            try:
                parsed = json.loads(response.text)
            except ValueError:
                continue
            items = (parsed or {}).get("items")
            if not isinstance(items, list):
                items = ((parsed or {}).get("data") or {}).get("items") or []
            for item in items:
                if not isinstance(item, dict):
                    continue
                ad = _normalise(item, country, domain)
                if ad is None or ad.id in seen:
                    continue
                seen.add(ad.id)
                out.append(ad)

        notice = None
        if blocked and not out:
            notice = (
                "Shopee trả 403 — extension chưa đăng nhập Shopee hoặc phiên đã hết hạn. "
                "Hãy mở shopee.vn và đăng nhập, rồi tìm lại."
            )
        return PlatformSearchOutcome(ads=out[: request.limit], notice=notice)


shopee = Shopee()
