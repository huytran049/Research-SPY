"""Phân tích thị trường từ TOÀN BỘ listing đã cào — không hardcode.

Trả lời 5 câu R&D hỏi mỗi ngày:
  · Mùa vụ nào đang tới?      -> theo occasion trong title + lịch đỉnh
  · Ngành hàng nào đang mạnh? -> gộp doanh thu theo category catalog
  · Ngách tiềm năng ở đâu?    -> cầu cao mà ít shop cạnh tranh
  · Sản phẩm nào hot nhất?    -> product type theo doanh thu thật
  · Đối thủ là ai?            -> shop + THỊ PHẦN + họ bán gì ngon

NGUYÊN TẮC: chỉ tính trên listing CÓ ĐƠN (sale-based analysis).
Listing 0 đơn vẫn đếm để ra tỷ lệ "listing chết", nhưng không cộng vào doanh thu.
"""
from __future__ import annotations
import json
import re
from collections import defaultdict
from datetime import date

from .. import db
from ..store import store

# Đỉnh mùa vụ (tháng) — cùng bảng với signals.py
PEAK_MONTH = {
    "Christmas": 12, "Halloween": 10, "Thanksgiving": 11, "Valentine": 2,
    "Easter": 4, "Mother": 5, "Father": 6, "Graduation": 5,
    "Back to school": 8, "Wedding": 6, "Birthday": 0, "Anniversary": 0,
    "Baby": 0, "Memorial": 5, "Pet": 0,
}
# Từ khóa nhận diện mùa vụ trong title
OCCASION_HINTS = {
    "Christmas": ["christmas", "xmas", "santa", "ornament", "holiday"],
    "Halloween": ["halloween", "spooky", "pumpkin", "ghost"],
    "Thanksgiving": ["thanksgiving", "turkey", "grateful", "fall"],
    "Valentine": ["valentine", "love", "heart", "romantic"],
    "Easter": ["easter", "bunny", "egg"],
    "Mother": ["mom", "mother", "mama", "mum"],
    "Father": ["dad", "father", "papa", "grandpa"],
    "Graduation": ["graduation", "graduate", "senior", "class of"],
    "Back to school": ["teacher", "school", "student", "classroom"],
    "Wedding": ["wedding", "bride", "groom", "engagement", "bridal"],
    "Birthday": ["birthday", "bday"],
    "Anniversary": ["anniversary"],
    "Baby": ["baby", "newborn", "nursery", "shower"],
    "Memorial": ["memorial", "sympathy", "loss", "remembrance", "loving memory"],
    "Pet": ["dog", "cat", "pet", "paw", "puppy"],
}

_STOP = {"the", "a", "an", "for", "with", "and", "of", "to", "in", "on", "by",
         "custom", "personalized", "customized", "gift", "gifts", "your", "you"}

# HÀNG KHÔNG PHẢI POD. Crawl theo keyword nên Amazon trả về cả hàng điện tử /
# gia dụng / bán buôn trùng từ khoá; chúng có `bought_past_month` lớn nên đè bẹp
# listing POD. Printway in theo yêu cầu, không bán các mặt hàng này.
_NOT_POD = {
    # điện tử / thiết bị
    "shock collar", "training collar", "candle warmer", "warmer lamp",
    "vacuum", "printer", "camera", "router", "charger", "headphone",
    "earbuds", "speaker", "monitor", "keyboard", "webcam", "projector",
    "air fryer", "blender", "microwave", "heater", "humidifier", "purifier",
    "trimmer", "clipper", "shaver", "massager", "thermometer",
    # vật tư / bao bì bán buôn
    "self sealing", "cellophane", "poly mailer", "bubble mailer",
    "packing tape", "shipping label", "storage bin", "trash bag",
    # tiêu dùng nhanh
    "shampoo", "detergent", "sunscreen", "vitamin", "supplement",
    "battery", "batteries", "light bulb", "led strip",
}


def _is_pod(title: str) -> bool:
    """False nếu title là hàng KHÔNG phải POD (điện tử, bao bì, tiêu dùng nhanh)."""
    t = (title or "").lower()
    return not any(k in t for k in _NOT_POD)


# Trần số bán/tháng cho 1 listing. Etsy không trả sales, code suy từ favorites
# tích luỹ nhiều năm nên listing lâu đời cho số bán vô lý; trần này chặn outlier.
MAX_SALES_MONTH = 5000
# Trần giá: hàng POD trên $500 gần như chắc chắn là nhập sai đơn vị tiền
MAX_PRICE = 500.0


def _sales(r: dict) -> int:
    """Số bán/tháng. Amazon có bought_past_month thật; Etsy chỉ ước lượng."""
    s = r.get("est_sales") or 0
    try:
        raw = json.loads(r.get("raw_json") or "{}")
        real = raw.get("bought_past_month")
        if real:                       # Amazon: số THẬT, tin được, không cần trần
            return int(real)
    except Exception:
        pass
    return min(int(s), MAX_SALES_MONTH)


def _price(r: dict) -> float:
    p = r.get("price") or 0
    return p if 0 < p <= MAX_PRICE else 0.0


def _shop_of(r: dict) -> str | None:
    """Tên shop chuẩn hoá của một dòng raw_listings (dùng chung với unify)."""
    from .unify import _shop_display
    try:
        x = json.loads(r.get("raw_json") or "{}")
    except Exception:
        x = {}
    return _shop_display(x.get("shop_name") or x.get("seller_name")
                         or x.get("brand") or r.get("seller"))


def _shop_url(r: dict) -> str | None:
    try:
        return json.loads(r.get("raw_json") or "{}").get("shop_url")
    except Exception:
        return None


def _image(r: dict) -> str | None:
    try:
        return json.loads(r.get("raw_json") or "{}").get("image")
    except Exception:
        return None


def _pt_index() -> dict[str, dict]:
    idx: dict[str, dict] = {}
    for p in store.product_types:
        for w in (p.get("product_type") or "").lower().split():
            if w not in _STOP:
                idx.setdefault(w, p)
        for a in p.get("aliases") or []:
            for w in a.lower().split():
                if w not in _STOP:
                    idx.setdefault(w, p)
    return idx


def _match_pt(title: str, idx: dict) -> dict | None:
    """Khớp title -> product type. Uỷ quyền cho `ptmatch`, chấm điểm theo cụm
    dài/đặc hiệu và trả None khi không chắc để không gán bừa hàng ngoài catalog.
    """
    from . import ptmatch
    m = ptmatch.match(title or "")
    if not m:
        return None
    name = m.get("product_type") if isinstance(m, dict) else m
    if not name:
        return None
    return next((x for x in store.product_types
                 if x["product_type"] == name), None)


def _match_occasion(title: str) -> str | None:
    """Dùng chung bản của catalogue.py để hai engine gom mùa vụ theo cùng luật."""
    from .catalogue import _match_occasion as _shared
    return _shared(title)


def analyze(limit: int = 5000) -> dict:
    rows = db.get_listings(limit=limit)
    if not rows:
        return {"available": False, "message": "Chưa có listing. Chạy Crawler trước."}

    idx = _pt_index()
    today = date.today()

    # gom theo từng chiều — chỉ dòng CÓ ĐƠN mới cộng doanh thu
    by_occ: dict[str, dict] = defaultdict(lambda: {"rev": 0.0, "units": 0, "n": 0, "shops": set()})
    by_cat: dict[str, dict] = defaultdict(lambda: {"rev": 0.0, "units": 0, "n": 0, "shops": set()})
    by_pt: dict[str, dict] = defaultdict(lambda: {"rev": 0.0, "units": 0, "n": 0,
                                                  "shops": set(), "prices": [], "top": None})
    by_shop: dict[str, dict] = defaultdict(lambda: {"rev": 0.0, "units": 0, "n": 0,
                                                    "kw": set(), "pt": set(), "best": None,
                                                    "shop_url": None})
    total_rev = 0.0
    n_sold = 0

    # KHỬ TRÙNG. Một sản phẩm cào lại ở nhiều keyword sinh nhiều dòng; cộng hết
    # vào là thổi doanh thu. Đơn vị duy nhất = (sàn, url), giống khoá UNIQUE của
    # raw_listings.
    _seen: set[tuple] = set()
    _dropped = 0

    for r in rows:
        _key = (r.get("platform"), r.get("url"))
        if _key in _seen:
            _dropped += 1
            continue
        _seen.add(_key)
        if not _is_pod(r.get("title") or ""):
            _dropped += 1
            continue
        s = _sales(r)
        price = _price(r)
        rev = s * price
        title = r.get("title") or ""
        # Gom theo TÊN ĐÃ CHUẨN HOÁ, không phải mã thô. Nếu gom theo
        # `seller` thì bảng đối thủ hiện `etsy_shop_25693736`.
        shop = _shop_of(r)
        p = _match_pt(title, idx)
        occ = _match_occasion(title)

        if s > 0:
            n_sold += 1
            total_rev += rev

        if occ:
            d = by_occ[occ]; d["n"] += 1
            if s > 0:
                d["rev"] += rev; d["units"] += s
                if shop: d["shops"].add(shop)
                else: d["n_no_shop"] = d.get("n_no_shop", 0) + 1
        if p:
            for bucket, key in ((by_cat, p["category"]), (by_pt, p["product_type"])):
                d = bucket[key]; d["n"] += 1
                if s > 0:
                    d["rev"] += rev; d["units"] += s
                    if shop: d["shops"].add(shop)
                else: d["n_no_shop"] = d.get("n_no_shop", 0) + 1
            if s > 0:
                d = by_pt[p["product_type"]]
                d["prices"].append(price)
                if not d["top"] or s > d["top"]["sales"]:
                    d["top"] = {"title": title, "sales": s, "price": price,
                                "url": r.get("url"), "image": _image(r), "shop": shop}
        if shop and s > 0:
            d = by_shop[shop]
            d["rev"] += rev; d["units"] += s; d["n"] += 1
            d["kw"].add(r.get("keyword"))
            if p: d["pt"].add(p["product_type"])
            if not d["shop_url"]:
                d["shop_url"] = _shop_url(r)
            if not d["best"] or s > d["best"]["sales"]:
                d["best"] = {"title": title, "sales": s, "price": price,
                             "url": r.get("url"), "image": _image(r)}

    def pack(bucket, extra=None):
        out = []
        for k, v in bucket.items():
            if v["rev"] <= 0:
                continue
            n_shops = len(v.get("shops") or ())      # by_shop không có khóa này
            row = {"name": k, "revenue_30d": round(v["rev"]), "units_30d": v["units"],
                   "n_listings": v["n"],
                   "n_shops": n_shops,
                   # n_shops chỉ đếm listing có tên shop; Amazon phần lớn thiếu
                   # seller nên đây là cận dưới, không phải số thật.
                   "n_shops_is_partial": v.get("n_no_shop", 0) > 0,
                   "listings_without_shop": v.get("n_no_shop", 0),
                   "share_pct": round(v["rev"] / total_rev * 100, 1) if total_rev else 0}
            if extra:
                extra(row, k, v)
            out.append(row)
        return sorted(out, key=lambda x: -x["revenue_30d"])

    # ── MÙA VỤ: kèm số ngày tới đỉnh
    def occ_extra(row, k, v):
        m = PEAK_MONTH.get(k, 0)
        if m:
            yr = today.year if m >= today.month else today.year + 1
            row["days_to_peak"] = (date(yr, m, 15) - today).days
            row["window"] = ("ĐANG MỞ" if 40 <= row["days_to_peak"] <= 100
                             else "CÒN SỚM" if row["days_to_peak"] > 100 else "ĐÃ MUỘN")
        else:
            row["days_to_peak"] = None
            row["window"] = "QUANH NĂM"

    # ── SẢN PHẨM: kèm năng lực xưởng + listing bán chạy nhất
    def pt_extra(row, k, v):
        p = next((x for x in store.product_types if x["product_type"] == k), None)
        if p:
            row["capacity"] = p.get("capacity")
            row["margin_high"] = p.get("margin_high")
            row["difficulty"] = p.get("production_difficulty")
            row["category"] = p.get("category")
        pr = sorted(v["prices"])
        row["price_med"] = pr[len(pr) // 2] if pr else None
        row["top_listing"] = v["top"]

    # ── ĐỐI THỦ: thị phần + họ bán gì ngon
    def shop_extra(row, k, v):
        row["n_keywords"] = len(v["kw"])
        row["product_types"] = sorted(v["pt"])[:4]
        row["best_seller"] = v["best"]
        row["shop_url"] = v.get("shop_url")
        # ảnh đại diện shop = ảnh listing bán chạy nhất của chính shop đó
        row["image"] = (v.get("best") or {}).get("image")

    occasions = pack(by_occ, occ_extra)
    categories = pack(by_cat)
    products = pack(by_pt, pt_extra)
    shops = pack(by_shop, shop_extra)

    # ── NGÁCH TIỀM NĂNG: doanh thu khá mà ÍT shop -> còn chỗ chen chân
    niches = []
    for row in products:
        if row["n_shops"] == 0:
            continue
        rev_per_shop = row["revenue_30d"] / row["n_shops"]
        row2 = dict(row)
        row2["rev_per_shop"] = round(rev_per_shop)
        # listings_per_shop cao cho thấy thị trường tập trung ở một số ít cửa hàng.
        # ôm phần lớn listing), thấp = phân mảnh -> dễ chen chân hơn.
        row2["listings_per_shop"] = round(row["n_listings"] / row["n_shops"], 2)
        # §4 whitespace = cầu − cạnh tranh; ở cấp product type dùng
        # doanh thu/shop làm proxy cầu, số shop làm proxy cạnh tranh.
        import math as _m
        dem = min(100.0, _m.log(max(rev_per_shop, 1)) / _m.log(50000) * 100)
        cmp_ = min(100.0, _m.log(max(row["n_shops"], 1)) / _m.log(80) * 100)
        row2["whitespace"] = round(max(0.0, dem - cmp_), 1)
        # điểm ngách: tiền/shop cao + biên cao + xưởng làm được
        score = rev_per_shop / 1000
        if row.get("capacity") == "in_house":
            score *= 1.4
        score *= (row.get("margin_high") or 0.4) / 0.4
        row2["niche_score"] = round(score, 1)
        niches.append(row2)
    niches.sort(key=lambda x: -x["niche_score"])

    # thị phần top 3 shop
    top3 = sum(s["revenue_30d"] for s in shops[:3])
    return {
        "available": True,
        "summary": {
            "n_listings": len(rows), "n_sold": n_sold,
            "dead_pct": round((1 - n_sold / len(rows)) * 100) if rows else 0,
            "revenue_30d": round(total_rev),
            "n_shops": len(by_shop),
            "top3_share_pct": round(top3 / total_rev * 100, 1) if total_rev else 0,
        },
        "occasions": occasions[:10],
        "categories": categories,
        "products": products[:12],
        "niches": niches[:8],
        "competitors": shops[:12],
    }
