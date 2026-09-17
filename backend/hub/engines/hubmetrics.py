"""Chỉ số cơ hội cho một keyword, tính trên listing đã cào.

Theo các công thức chỉ số của dashboard:
competition đếm theo shop_id, favorite_rate = favorers/views,
whitespace = demand − competition + 0.3·trend, và opportunity_shown =
opportunity × confidence/100.
"""
from __future__ import annotations
import json
import re
import statistics
from collections import Counter
from datetime import datetime, timezone

from .. import db
from ..store import store
from . import market

PERSO_HINTS = ("personalized", "custom", "name", "photo", "monogram")


def _raw(r: dict) -> dict:
    try:
        return json.loads(r.get("raw_json") or "{}")
    except Exception:
        return {}


def _norm_pct(x: float, arr: list[float]) -> float:
    """Percentile của x trong arr, 0..100."""
    if not arr:
        return 0.0
    below = sum(1 for v in arr if v < x)
    return round(100 * below / len(arr), 1)


def _minmax(x: float, lo: float, hi: float) -> float:
    if hi == lo:
        return 0.0
    return round(100 * max(0.0, min(1.0, (x - lo) / (hi - lo))), 1)


def _clamp(v, lo=0.0, hi=100.0):
    return max(lo, min(hi, v))


def _age_days(r: dict) -> float | None:
    ts = _raw(r).get("created_ts")
    if not ts:
        return None
    return (datetime.now(timezone.utc).timestamp() - ts) / 86400


def compute(keyword: str) -> dict:
    rows = db.listings_by_keyword(keyword, 400)
    if not rows:
        return {"available": False, "keyword": keyword,
                "message": "Chưa cào listing cho từ khóa này."}

    # ── §1 tiền xử lý: bỏ listing chết, khử trùng
    seen: set = set()
    clean: list[dict] = []
    for r in rows:
        ext = _raw(r).get("listing_id") or _raw(r).get("asin") or r.get("url")
        if ext and ext in seen:
            continue
        if ext:
            seen.add(ext)
        # listing chết (Etsy): không lượt xem lẫn lượt thích
        if r.get("platform") == "etsy" and not _raw(r).get("views") and not r.get("favorites"):
            continue
        clean.append(r)
    dropped = len(rows) - len(clean)

    et = [r for r in clean if r.get("platform") == "etsy"]
    am = [r for r in clean if r.get("platform") == "amazon"]

    # ── §2 độ tin cậy nguồn
    trow = db.get_trend(keyword)
    sources_present = (1 if et else 0) + (1 if am else 0) + (1 if trow else 0)
    nulls, tot = 0, 0
    for r in clean:
        for v in (r.get("price"),
                  _raw(r).get("views") or _raw(r).get("bought_past_month"),
                  _raw(r).get("created_ts")):
            tot += 1
            if v in (None, "", 0):
                nulls += 1
    null_rate = nulls / tot if tot else 1.0
    # fresh_share: ta chưa lưu FETCH_TIER -> coi dữ liệu vừa cào là tươi
    fresh_share = 1.0
    confidence = round(100 * (0.5 * (sources_present / 3) + 0.3 * (1 - null_rate)
                              + 0.2 * fresh_share))

    # ── §3 cầu (proxy)
    views_arr = [_raw(r).get("views") or 0 for r in et]
    fav_arr = [r.get("favorites") or 0 for r in et]
    views_sum, fav_sum = sum(views_arr), sum(fav_arr)
    favorite_rate = round(fav_sum / views_sum, 4) if views_sum else None

    amz_sales = [_raw(r).get("bought_past_month") or 0 for r in am]
    sales_sum = sum(amz_sales)

    etsy_demand = _minmax(views_sum, 500, 500_000) if et else None
    amz_demand = _minmax(sales_sum, 50, 20_000) if am else None
    parts = [x for x in (etsy_demand, amz_demand) if x is not None]
    demand_proxy = round(sum(parts) / len(parts), 1) if parts else 0.0

    # ── §4 cạnh tranh — ĐẾM THEO SHOP_ID (điểm mấu chốt)
    total_listings = len(clean)
    shops = {r.get("seller") for r in clean if r.get("seller")}
    num_shops = len(shops)
    listings_per_shop = round(total_listings / num_shops, 2) if num_shops else 0

    top10 = sorted(clean, key=lambda r: r.get("rank") or 999)[:10]
    barrier_amz = [r.get("reviews") or 0 for r in top10 if r.get("platform") == "amazon"]
    barrier_etsy = [r.get("favorites") or 0 for r in top10 if r.get("platform") == "etsy"]
    barrier = statistics.median(barrier_amz) if barrier_amz else (
        statistics.median(barrier_etsy) if barrier_etsy else 0)

    competition = round(_clamp(
        0.5 * _minmax(num_shops, 1, 80)
        + 0.3 * _minmax(barrier, 0, 3000)
        + 0.2 * _minmax(listings_per_shop, 1, 8)), 1)

    # ── §9 xu hướng
    disc = [d for d in db.list_discovered(limit=3000) if d["keyword"] == keyword]
    trend_change = disc[0].get("change_percent") if disc else None
    trend_norm = _minmax(trend_change, -50, 300) if trend_change is not None else 0.0
    is_breakout = bool(trend_change and trend_change > 500)
    trend_status = ("TĂNG" if (trend_change or 0) >= 15 else
                    "ỔN ĐỊNH" if (trend_change or 0) > 0 else "GIẢM")

    # ── §4 khoảng trống
    whitespace = round(_clamp(demand_proxy - competition + 0.3 * trend_norm), 1)

    # ── §5 giá
    prices = sorted([r.get("price") for r in clean if r.get("price")])
    # Làm tròn 2 chữ số ngay tại nguồn để tránh sai số dấu phẩy động của median.
    price_median = round(statistics.median(prices), 2) if prices else None
    price_p25 = prices[len(prices) // 4] if prices else None
    price_p75 = prices[len(prices) * 3 // 4] if prices else None
    price_fit = 100.0 if price_median else 0.0   # chưa có price_target -> coi median là chuẩn

    # ── §6 tuổi listing & momentum
    ages = [a for a in (_age_days(r) for r in clean) if a is not None]
    share_new_90d = round(sum(1 for a in ages if a <= 90) / len(ages), 3) if ages else None
    share_new_180d = round(sum(1 for a in ages if a <= 180) / len(ages), 3) if ages else None
    momentum = None
    if ages:
        top_new = sum(1 for r in top10
                      if (_age_days(r) or 999) <= 90)
        momentum = round(top_new / len(top10), 3)

    # ── §7 cơ cấu nguồn
    share_etsy = round(len(et) / total_listings, 3) if total_listings else 0
    strong_platform = "etsy" if (etsy_demand or 0) >= (amz_demand or 0) else "amazon"

    # ── §8 cá nhân hoá — dùng cờ THẬT, fallback về title
    flags = [_raw(r).get("is_personalizable") for r in clean]
    flags = [f for f in flags if f is not None]
    if flags:
        perso_rate = round(sum(1 for f in flags if f) / len(flags), 3)
        perso_src = "etsy (seller khai)"
    else:
        perso_rate = round(sum(
            1 for r in clean
            if any(k in (r.get("title") or "").lower() for k in PERSO_HINTS)
        ) / total_listings, 3) if total_listings else 0
        perso_src = "suy từ title"

    # ── §12 điểm cơ hội
    opportunity = _clamp(round(
        0.32 * demand_proxy + 0.25 * trend_norm + 0.22 * whitespace
        + 0.12 * price_fit + 0.09 * (perso_rate * 100) - 0.20 * competition))
    opportunity_shown = round(opportunity * confidence / 100)
    verdict = ("NÊN VÀO" if opportunity_shown >= 70 else
               "CÂN NHẮC" if opportunity_shown >= 50 else "CHƯA NÊN")
    level = "go" if opportunity_shown >= 70 else ("hot" if opportunity_shown >= 50 else "stop")

    # ── §12 chín tiêu chí pass/fail
    checks = [
        {"k": "demand", "label": "Cầu", "value": demand_proxy,
         "pass": demand_proxy >= 60, "tag": "Proxy", "has": True},
        {"k": "trend", "label": "Xu hướng", "value": trend_change,
         "pass": (trend_change or 0) >= 15, "tag": "Thật", "has": trend_change is not None},
        {"k": "whitespace", "label": "Khoảng trống", "value": whitespace,
         "pass": whitespace >= 55, "tag": "Thật", "has": True},
        {"k": "competition", "label": "Cạnh tranh", "value": competition,
         "pass": competition <= 55, "tag": "Thật", "has": True},
        {"k": "price", "label": "Giá phù hợp", "value": price_median,
         "pass": bool(price_median), "tag": "Thật", "has": bool(price_median)},
        {"k": "perso", "label": "Cá nhân hoá", "value": perso_rate,
         "pass": perso_rate >= 0.40, "tag": "Thật", "has": True},
    ]
    # 3 chỉ số năng lực — lấy từ catalog product type
    idx = market._pt_index()
    pt = None
    for r in sorted(clean, key=lambda x: -(market._sales(x))):
        pt = market._match_pt(r.get("title") or "", idx)
        if pt:
            break
    # _econ=="unknown": có trên menu Catalog nhưng chưa có số sản xuất -> bỏ qua.
    if pt and pt.get("_econ") != "unknown" and price_median:
        cost = pt.get("base_cost_usd") or 0
        ship = 2.0 if cost < 2 else (3.2 if cost < 5 else (4.5 if cost < 9 else 6.0))
        margin_pct = round((price_median - cost - ship - price_median * 0.095) / price_median, 3)
        days = {1: 3, 2: 5, 3: 7, 4: 10, 5: 14}.get(pt["production_difficulty"], 7)
        if pt.get("capacity") != "in_house":
            days += 2
        pfit = _clamp((85 if pt.get("capacity") == "in_house" else 55)
                      - (pt["production_difficulty"] - 1) * 5)
        checks += [
            {"k": "margin", "label": "Biên lợi nhuận", "value": margin_pct,
             "pass": margin_pct >= 0.55, "tag": "Catalog", "has": True},
            {"k": "pfit", "label": "Khớp năng lực", "value": pfit,
             "pass": pfit >= 70, "tag": "Catalog", "has": True},
            {"k": "turnaround", "label": "Thời gian SX", "value": days,
             "pass": days <= 7, "tag": "Catalog", "has": True},
        ]
    else:
        for k, lb in (("margin", "Biên lợi nhuận"), ("pfit", "Khớp năng lực"),
                      ("turnaround", "Thời gian SX")):
            checks.append({"k": k, "label": lb, "value": None, "pass": False,
                           "tag": "Catalog", "has": False})

    n_has = sum(1 for c in checks if c["has"])
    n_pass = sum(1 for c in checks if c["has"] and c["pass"])

    # ── §13 rủi ro — luật điều kiện, điền số thật
    risks = []
    if share_new_180d and share_new_180d >= 0.50:
        risks.append({"level": "warn", "text":
                      f"Cung tăng nhanh: listing dưới 6 tháng chiếm {share_new_180d:.0%}, "
                      "cạnh tranh sẽ dày lên trong 1–2 quý."})
    if not am or not et:
        risks.append({"level": "info", "text":
                      f"Chỉ có dữ liệu {'Etsy' if et else 'Amazon'} — "
                      "đọc theo hướng, không theo con số tuyệt đối."})
    if listings_per_shop >= 4:
        risks.append({"level": "warn", "text":
                      f"Chợ tập trung: mỗi shop ~{listings_per_shop:.0f} listing — "
                      "cần điểm khác biệt để chen chân."})
    if confidence < 50:
        risks.append({"level": "danger", "text":
                      f"Nguồn mỏng ({sources_present}/3, null {null_rate:.0%}) — "
                      "điểm chỉ mang tính tham khảo."})
    if is_breakout:
        risks.append({"level": "info", "text":
                      "Google Trends xếp Breakout — nền so sánh gần 0, "
                      "là tín hiệu MỚI chứ chưa phải tăng trưởng đã kiểm chứng."})

    # ── Histogram cho bốn biểu đồ phân phối của dashboard ──
    def _bucket(vals, edges, labels):
        out = [0] * len(labels)
        for v in vals:
            for i, e in enumerate(edges):
                if v < e:
                    out[i] += 1
                    break
            else:
                out[-1] += 1
        tot = sum(out) or 1
        return [{"k": labels[i], "n": out[i], "pct": round(out[i] / tot * 100, 1)}
                for i in range(len(labels))]

    def _bucket_desc(vals, edges, labels):
        """Chia nhóm theo ngưỡng giảm dần — nhóm đầu là giá trị lớn nhất.

        Dùng cho tuổi listing để đọc như trục thời gian (cũ nhất bên trái).
        """
        out = [0] * len(labels)
        for v in vals:
            for i, e in enumerate(edges):
                if v >= e:
                    out[i] += 1
                    break
            else:
                out[-1] += 1
        tot = sum(out) or 1
        return [{"k": labels[i], "n": out[i], "pct": round(out[i] / tot * 100, 1)}
                for i in range(len(labels))]

    # 1. Phân bố giá listing — PRICE_USD, Etsy + Amazon
    hist_price = _bucket(prices, [25, 35, 45, 55],
                         ["<$25", "$25–35", "$35–45", "$45–55", ">$55"])
    # 2. Phân bố favorite-rate — favorers/views, proxy của cầu
    frs = []
    for r in et:
        v = _raw(r).get("views") or 0
        if v:
            frs.append((r.get("favorites") or 0) / v * 100)
    hist_fav = _bucket(frs, [2, 5, 8, 12],
                       ["<2%", "2–5%", "5–8%", "8–12%", ">12%"])
    # 3. Tuổi listing — đọc như timeline trái -> phải: cũ nhất trái, mới nhất phải.
    hist_age = _bucket_desc(ages, [730, 365, 180, 90, 30],
                            ["> 2 năm", "1–2 năm", "6–12 tháng",
                             "3–6 tháng", "1–3 tháng", "< 1 tháng"])
    # 4. Cơ cấu nguồn — số listing theo sàn
    src_split = [{"k": "Etsy", "n": len(et)}, {"k": "Amazon", "n": len(am)}]

    # ── §2 Xu hướng tìm kiếm theo thời gian (chuỗi 12 điểm)
    series = []
    if trow:
        try:
            series = json.loads(trow["series_json"])
        except Exception:
            series = []

    # ── §11 Có ổn định quanh năm? — hệ số biến thiên của chuỗi Trends.
    seasonality = None
    if len(series) >= 8:
        mean = sum(series) / len(series)
        if mean:
            sd = statistics.pstdev(series)
            cv = sd / mean
            seasonality = {
                "cv": round(cv, 2),
                "label": ("THEO MÙA RÕ" if cv >= 0.45 else
                          "HƠI THEO MÙA" if cv >= 0.25 else "GẦN EVERGREEN"),
                "note": ("Cầu dồn vào vài tháng — phải canh cửa sổ launch."
                         if cv >= 0.45 else
                         "Cầu rải quanh năm, ít áp lực mùa vụ."),
                "peak_idx": series.index(max(series)),
            }

    # ── §12 Sub-niche nào nên làm trước? — n-gram từ title CÓ ĐƠN
    from collections import Counter
    _STOP = {"the", "a", "an", "for", "with", "and", "of", "to", "in", "on", "by",
             "custom", "personalized", "customized", "gift", "gifts", "your"}
    grams: Counter = Counter()
    sold_rows = [r for r in clean if market._sales(r) > 0]
    for r in sold_rows:
        w = [x for x in re.findall(r"[a-z]+", (r.get("title") or "").lower())
             if x not in _STOP and len(x) > 2]
        for i in range(len(w) - 1):
            grams[w[i] + " " + w[i + 1]] += 1
    subniches = [{"k": g, "n": n, "pct": round(n / max(len(sold_rows), 1) * 100, 1)}
                 for g, n in grams.most_common(6) if n >= 2]

    # ── §13 Từ khóa bên trong — tag seller tự gắn
    tagc: Counter = Counter()
    for r in clean:
        t = r.get("tags")
        if not t:
            continue
        try:
            for x in (json.loads(t) if isinstance(t, str) else t):
                x = str(x).strip().lower()
                if x and x != keyword:
                    tagc[x] += 1
        except Exception:
            pass
    inner_keywords = [{"k": k, "n": n} for k, n in tagc.most_common(10)]

    # ── §14 Dự báo 30 ngày — ngoại suy hướng Trends.
    # Tài liệu tự ghi confidence thấp: chỉ nói HƯỚNG, không phải doanh số.
    forecast = None
    if series and trend_change is not None:
        last = series[-1]
        proj = last * (1 + (trend_change / 100) * (30 / 365))
        forecast = {"last": round(last, 1), "proj_30d": round(proj, 1),
                    "delta_pct": round((proj - last) / last * 100, 1) if last else 0,
                    "confidence": "thấp",
                    "note": "Ngoại suy hướng Trends — chỉ báo hướng, không phải lượng đơn."}

    # ── §16 Xưởng làm được không · Turnaround (so với đối thủ THẬT)
    comp_days = [_raw(r).get("processing_max") for r in clean]
    comp_days = [d for d in comp_days if d]
    workshop = None
    if pt and pt.get("_econ") != "unknown":
        mine = {1: 3, 2: 5, 3: 7, 4: 10, 5: 14}.get(pt["production_difficulty"], 7)
        if pt.get("capacity") != "in_house":
            mine += 2
        med_comp = statistics.median(comp_days) if comp_days else None
        workshop = {
            "product_type": pt["product_type"],
            "capacity": pt.get("capacity"),
            "difficulty": pt.get("production_difficulty"),
            "material": (pt.get("materials") or [None])[0],
            "our_days": mine,
            "competitor_days": round(med_comp) if med_comp is not None else None,
            "n_competitor": len(comp_days),
            "faster": (mine < med_comp) if med_comp is not None else None,
        }

    # ── §10 Niche đang lên hay đang chết? — kết luận 1 dòng từ Trends + tuổi listing
    lifecycle = None
    if trend_change is not None:
        tc = trend_change
        new180 = share_new_180d or 0
        if tc >= 25 and new180 >= 0.30:
            lc, note = "ĐANG MỞ", "Cầu tăng mạnh và nhiều listing mới — chợ đang mở rộng."
        elif tc >= 15:
            lc, note = "ĐANG LÊN", "Cầu tăng đều, chưa có dấu hiệu bão hoà."
        elif tc > 0 and new180 >= 0.50:
            lc, note = "BÃO HOÀ", "Cầu chững nhưng cung vẫn đổ vào — cạnh tranh sẽ dày lên."
        elif tc > 0:
            lc, note = "ỔN ĐỊNH", "Cầu đi ngang — làm được nhưng không có sóng."
        else:
            lc, note = "ĐANG CHẾT", "Cầu giảm — không nên mở listing mới."
        lifecycle = {"label": lc, "note": note, "trend_pct": tc,
                     "share_new_180d": new180}

    # ── §15 Vì sao — ghép các số hạng đóng góp lớn nhất vào điểm
    terms = [
        ("cầu", 0.32 * demand_proxy, f"cầu-proxy {demand_proxy:.0f}"),
        ("xu hướng", 0.25 * trend_norm, f"Trends {trend_change:+.0f}%" if trend_change is not None else "Trends"),
        ("khoảng trống", 0.22 * whitespace, f"khoảng trống {whitespace:.0f}"),
        ("giá", 0.12 * price_fit, f"giá median ${price_median}" if price_median else "giá"),
        ("cá nhân hoá", 0.09 * perso_rate * 100, f"cá nhân hoá {perso_rate*100:.0f}%"),
    ]
    top_terms = sorted(terms, key=lambda x: -x[1])[:3]
    why = [t[2] for t in top_terms if t[1] > 5]
    if competition <= 45:
        why.append(f"cạnh tranh còn thoáng ({num_shops} shop)")
    reason = " · ".join(why) if why else "chưa đủ tín hiệu để kết luận"

    # ── §8 Khám phá 3 sàn — nguồn nào nuôi được chỉ số nào
    explore = [
        {"src": "Google Trends", "ok": bool(trow),
         "feeds": "xu hướng · dự báo · mùa vụ",
         "n": len(series) if trow else 0, "unit": "điểm chuỗi"},
        {"src": "Etsy", "ok": bool(et),
         "feeds": "views · favorers · tuổi listing · cá nhân hoá · lead time",
         "n": len(et), "unit": "listing"},
        {"src": "Amazon", "ok": bool(am),
         "feeds": "rating · review · số bán thật",
         "n": len(am), "unit": "listing"},
    ]

    # ── NGUỒN CHÉO: các trường Etsy đã có trong DB nhưng chưa khai thác.
    cross = {}

    # quantity (97%) — tồn kho seller khai. Tồn thấp mà bán được = xoay vòng nhanh.
    qs = [_raw(r).get("quantity") for r in clean]
    qs = [q for q in qs if q]
    if qs:
        med_q = statistics.median(qs)
        # `quantity` trên Etsy là số seller tự khai (hàng made-to-order thường
        # để 999), nên diễn giải lại sau khi biết tỷ lệ made-to-order bên dưới.
        cross["stock"] = {
            "median": round(med_q),
            "label": "SỐ SELLER KHAI",
            "note": f"Trung vị {round(med_q)} sp/listing — số seller tự điền, "
                    "không phải tồn kho thật.",
        }

    # when_made (88%) — xác nhận đây có phải sân POD không
    wm = [_raw(r).get("when_made") for r in clean]
    wm = [w for w in wm if w]
    if wm:
        mto = sum(1 for w in wm if w == "made_to_order") / len(wm)
        cross["pod_share"] = {
            "rate": round(mto, 3),
            "label": "SÂN POD" if mto >= 0.6 else ("PHA TRỘN" if mto >= 0.3 else "HÀNG SẴN"),
            "note": (f"{mto*100:.0f}% listing là làm-theo-đơn — "
                     + ("đúng mô hình Printway." if mto >= 0.6
                        else "một phần là hàng có sẵn, cạnh tranh giá.")),
        }
        # Sân làm-theo-đơn thì `quantity` chỉ là mức trần seller tự đặt.
        if "stock" in cross and mto >= 0.6:
            cross["stock"]["note"] = (
                f"Trung vị {cross['stock']['median']} sp/listing — nhưng {mto*100:.0f}% "
                "là làm-theo-đơn nên đây là mức trần seller tự đặt, không phải tồn thật.")

    # has_variations (65%) — sản phẩm nhiều biến thể thường bán tốt hơn
    hv = [_raw(r).get("has_variations") for r in clean]
    hv = [v for v in hv if v is not None]
    if hv:
        rate = sum(1 for v in hv if v) / len(hv)
        cross["variations"] = {
            "rate": round(rate, 3),
            "note": (f"{rate*100:.0f}% listing có biến thể (size/màu/chất liệu) — "
                     + ("cần chuẩn bị nhiều SKU." if rate >= 0.5
                        else "phần lớn bán một phiên bản duy nhất.")),
        }

    # materials (39%) — chất liệu seller khai, đối chiếu năng lực xưởng
    matc: Counter = Counter()
    for r in clean:
        for mt in (_raw(r).get("materials") or []):
            mt = str(mt).strip().lower()
            if mt:
                matc[mt] += 1
    if matc:
        tot_m = sum(matc.values())
        cross["materials"] = [{"k": k, "n": n, "pct": round(n / tot_m * 100, 1)}
                              for k, n in matc.most_common(6)]

    # taxonomy_id (88%) — phân loại chuẩn của Etsy, dùng đo độ thuần của keyword
    tx = [_raw(r).get("taxonomy_id") for r in clean]
    tx = [t for t in tx if t]
    if tx:
        top_tx, top_n = Counter(tx).most_common(1)[0]
        cross["purity"] = {
            "rate": round(top_n / len(tx), 3),
            "n_categories": len(set(tx)),
            "note": (f"{top_n/len(tx)*100:.0f}% listing cùng một phân loại Etsy — "
                     + ("keyword thuần, dễ nhắm." if top_n / len(tx) >= 0.6
                        else "keyword bị pha nhiều loại sản phẩm khác nhau.")),
        }

    # ── §17 Phạm vi phân tích
    scope = {
        "n_etsy": len(et), "n_amazon": len(am), "n_total": total_listings,
        "dropped": dropped, "has_trends": bool(trow),
        "sources": [n for n, ok in (("Etsy", et), ("Amazon", am), ("Google Trends", trow)) if ok],
    }

    return {
        "available": True, "keyword": keyword,
        "charts": {"price": hist_price, "favorite_rate": hist_fav,
                   "age": hist_age, "source": src_split, "series": series},
        "lifecycle": lifecycle, "reason": reason, "explore": explore,
        "cross": cross,
        "seasonality": seasonality, "subniches": subniches,
        "inner_keywords": inner_keywords, "forecast": forecast,
        "workshop": workshop, "scope": scope,
        "confidence": confidence, "sources_present": sources_present,
        "null_rate": round(null_rate, 3), "dropped": dropped,
        "opportunity": opportunity, "opportunity_shown": opportunity_shown,
        "verdict": verdict, "level": level,
        "n_pass": n_pass, "n_has": n_has, "n_total": len(checks),
        "checks": checks, "risks": risks,
        "metrics": {
            "demand_proxy": demand_proxy, "favorite_rate": favorite_rate,
            "views_sum": views_sum, "fav_sum": fav_sum, "sales_sum": sales_sum,
            "competition": competition, "num_shops": num_shops,
            "total_listings": total_listings, "listings_per_shop": listings_per_shop,
            "barrier": barrier, "whitespace": whitespace,
            "price_median": price_median, "price_p25": price_p25, "price_p75": price_p75,
            "share_new_90d": share_new_90d, "share_new_180d": share_new_180d,
            "momentum": momentum, "share_etsy": share_etsy,
            "strong_platform": strong_platform,
            "perso_rate": perso_rate, "perso_src": perso_src,
            "trend_change_pct": trend_change, "trend_norm": trend_norm,
            "trend_status": trend_status, "is_breakout": is_breakout,
            "product_type": (pt or {}).get("product_type"),
        },
    }
