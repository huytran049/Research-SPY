"""
Chấm điểm ứng viên sản phẩm.

Ràng buộc trung thực quan trọng nhất: không nguồn nào công bố tỷ lệ chuyển đổi. CVR là
dữ liệu riêng của advertiser. Thứ quan sát được là advertiser đã trả tiền cho quảng cáo
đó bao lâu, họ đang thử bao nhiêu biến thể creative, và creative đó tương tác ra sao.
`cvr_proxy` gộp những thứ đó lại thành một ước lượng, và ở mọi nơi nó xuất hiện đều phải
ghi rõ là ước lượng — người dùng hiểu nhầm nó là CVR đo được sẽ ra quyết định chi tiền
dựa trên một con số không tồn tại.

Mỗi thành phần đều trả về lý do của mình, để người dùng kiểm chứng thay vì tin mù.
"""

from __future__ import annotations

import math
from dataclasses import dataclass

from lib.core.jscompat import average, clamp, jround, vi_thousands

from .types import Ad, AdScore


@dataclass
class _Part:
    score: float
    reason: str


def _longevity(ad: Ad) -> _Part | None:
    """
    Đời quảng cáo: đã chạy được bao lâu.

    Đây là tín hiệu công khai mạnh nhất cho thấy sản phẩm thật sự bán được. Advertiser
    không trả tiền tiếp cho quảng cáo lỗ, nên một quảng cáo còn sống sau nhiều tháng ngụ ý
    offer đó có chuyển đổi — đúng cái suy luận thay cho CVR mà ta không nhìn thấy được.
    """
    if ad.days_active is None:
        return None
    d = ad.days_active
    # Bão hoà quanh mốc 90 ngày: quá một quý thì dài thêm cũng không nói thêm được gì.
    score = clamp(jround(100 * (1 - math.exp(-d / 35))))
    if d >= 90:
        reason = f"Chạy {d} ngày — ads sống lâu, gần như chắc chắn đang có lãi"
    elif d >= 30:
        reason = f"Chạy {d} ngày — đã qua giai đoạn test, tín hiệu tốt"
    elif d >= 7:
        reason = f"Chạy {d} ngày — còn mới, chưa đủ dài để kết luận"
    else:
        reason = f"Chạy {d} ngày — quá mới, có thể vẫn đang test"
    return _Part(score, reason)


def _iteration(ad: Ad) -> _Part | None:
    """Lặp creative: nhiều biến thể trong một nhóm nghĩa là có ngân sách thật đứng sau."""
    if ad.variant_count is None or ad.variant_count < 1:
        return None
    n = ad.variant_count
    score = clamp(jround(100 * (1 - math.exp(-(n - 1) / 4))))
    if n == 1:
        return _Part(score, "1 biến thể creative — chưa thấy dấu hiệu scale")
    return _Part(score, f"{n} biến thể creative — advertiser đang test/scale nghiêm túc")


def _click_through(ad: Ad) -> _Part | None:
    """CTR, hiện chỉ TikTok có. Giá trị của Creative Center thực tế đều dưới 1%."""
    if ad.ctr_percent is None:
        return None
    ctr = ad.ctr_percent
    # Coi 0,5% là mạnh với video in-feed, vì đó là nơi các quảng cáo này chạy.
    score = clamp(jround((ctr / 0.5) * 100))
    if ctr >= 0.5:
        reason = f"CTR {_num(ctr)}% — hook rất mạnh, content đáng học"
    elif ctr >= 0.2:
        reason = f"CTR {_num(ctr)}% — trên trung bình"
    else:
        reason = f"CTR {_num(ctr)}% — hook yếu hoặc target rộng"
    return _Part(score, reason)


def _engagement(ad: Ad) -> _Part | None:
    """Tương tác. Thang log vì lượt thích trải dài nhiều bậc độ lớn."""
    if ad.like_count is None:
        return None
    likes = ad.like_count
    score = clamp(jround((math.log10(max(1, likes)) / 5) * 100))
    return _Part(score, f"{vi_thousands(likes)} lượt thích trên creative")


def _num(value: float) -> str:
    """Số như JS in ra: bỏ đuôi `.0` để "CTR 1%" không thành "CTR 1.0%"."""
    if isinstance(value, float) and value.is_integer():
        return str(int(value))
    return str(value)


def _content(ad: Ad) -> tuple[float, list[str]]:
    """Đánh giá mức độ hữu ích của creative đối với quá trình nghiên cứu sản phẩm."""
    reasons: list[str] = []
    videos = sum(1 for c in ad.creatives if c.kind == "video")
    images = sum(1 for c in ad.creatives if c.kind == "image")
    score = 0.0

    if videos > 0:
        score += 60
        reasons.append(f"{videos} video content — dùng được làm tư liệu test")
    elif images > 0:
        score += 25
        reasons.append(f"{images} ảnh, không có video — hạn chế để dựng content")
    else:
        reasons.append("Không lấy được media — chỉ có text")

    body_length = len(ad.body.strip())
    if body_length >= 200:
        score += 25
        reasons.append("Bài viết dài, đủ chi tiết để tham khảo cấu trúc content")
    elif body_length >= 50:
        score += 15
    elif body_length > 0:
        score += 5
        reasons.append("Nội dung text rất ngắn")

    if ad.landing_url:
        score += 15
        reasons.append("Có landing page để phân tích offer")

    return clamp(score), reasons


def _score_product(ad: Ad) -> AdScore:
    """
    Chấm điểm ỨNG VIÊN SẢN PHẨM (Shopee…), khác hẳn quảng cáo.

    Với sản phẩm ta có con số bán THẬT, nên không cần suy ra CVR. Hai trụ:
      - Cầu (60%): đang bán được tới đâu — ưu tiên số bán/tháng (nhu cầu HIỆN TẠI) hơn tổng
        luỹ kế. Một sản phẩm 700 bán/tháng đáng research hơn cái tổng 400k đã nguội.
      - Chất lượng (40%): rating cao + đủ review = khách hài lòng, ít hoàn hàng.
    Kèm cờ "bão hoà / đang lên" so nhịp bán gần đây với tổng.
    """
    reasons: list[str] = []
    monthly, historical = ad.monthly_sold, ad.sold_count

    # --- Cầu ---
    if monthly is not None:
        demand = clamp(jround(math.log10(max(1, monthly)) / 4 * 100))  # ~10k/tháng ≈ 100
        if monthly >= 1000:
            reasons.append(f"{vi_thousands(monthly)} bán/tháng — cầu rất mạnh, đang chạy tốt")
        elif monthly >= 100:
            reasons.append(f"{vi_thousands(monthly)} bán/tháng — cầu ổn định")
        else:
            reasons.append(f"{vi_thousands(monthly)} bán/tháng — cầu còn thấp")
    elif historical is not None and not ad.sold_is_shop:
        demand = clamp(jround(math.log10(max(1, historical)) / 5.5 * 100))
        reasons.append(f"{vi_thousands(historical)} đã bán (tổng) — không có số theo tháng để đo đà")
    elif ad.view_count is not None:
        # LƯỢT XEM, không phải số bán. Thang thấp hơn hẳn hai nhánh trên và đó là chủ ý: xem
        # không phải mua. Đo trên Etsy 2026-09-08, trung vị lượt xem (khác 0) là 65 còn đỉnh
        # là 102.167 — nên ~10k lượt xem mới chạm 100, cùng bậc với "10k bán/tháng" ở nhánh
        # đầu chỉ khi nhân thêm một bậc. Cho một sản phẩm 65 lượt xem ăn điểm cầu ngang một
        # sản phẩm 65 đơn/tháng là nói dối về thị trường.
        demand = clamp(jround(math.log10(max(1, ad.view_count)) / 5 * 100))
        reasons.append(f"{vi_thousands(ad.view_count)} lượt xem — sàn không cho số bán theo sản phẩm")
    elif historical is not None:
        # Chỉ còn số bán của SHOP. Dùng được, nhưng phải hạ thang: một shop bán 800 đơn không
        # nói được sản phẩm ĐANG XEM bán bao nhiêu — nó có thể là mẫu ế nhất trong 68 mẫu.
        demand = clamp(jround(math.log10(max(1, historical)) / 7 * 100))
        reasons.append(f"Shop đã bán {vi_thousands(historical)} — số của SHOP, không phải của sản phẩm này")
    elif ad.repurchase_rate is not None:
        # 回头率 của 1688: % khách QUAY LẠI mua. Không phải số bán, nhưng trên một sàn sỉ thì
        # nó trả lời gần đúng câu hỏi ấy — người mua lại là người bán lẻ đang bán được hàng.
        # Chỉ dùng khi không còn gì khác; với 1688 thì `monthly` gần như luôn có (đo 2026-09-09:
        # 300/300 mục), nên nhánh này hầu như chỉ là lưới đỡ.
        demand = clamp(ad.repurchase_rate)
        reasons.append(f"{_num(ad.repurchase_rate)}% khách quay lại mua — sàn không cho số bán")
    else:
        demand = 0.0
        reasons.append("Không có dữ liệu số bán — không đo được cầu")

    # --- Chất lượng ---
    if ad.rating is not None:
        base = clamp(jround((ad.rating - 3.0) / 2.0 * 100))  # 3.0★→0, 5.0★→100
        # `rating_count = None` và `= 0` KHÔNG cùng nghĩa, và gộp chúng lại là một lỗi im lặng.
        # `0` là "sàn có đếm, và đếm được không review" → chiết khấu đúng. `None` là "sàn KHÔNG
        # công bố số review" — 1688 chỉ cho điểm dịch vụ tổng hợp của shop, không kèm số đếm.
        # Chiết khấu một điểm 4,5★ xuống 0 chỉ vì không có con số đi kèm là bịa ra một kết luận
        # từ chỗ trống: mọi mục 1688 sẽ có `quality = 0` trong khi sàn nói rõ shop 4,5 sao.
        # `research.js::score` đã xử đúng chỗ này từ trước ("1688 → tin luôn"); đây là chép lại
        # cho khớp, để hai bên chấm cùng một sản phẩm ra cùng một điểm.
        count = ad.rating_count
        trust = 1.0 if count is None else min(1.0, math.log10(count + 1) / 2)  # ~100 review = đủ tin
        quality = clamp(jround(base * trust))
        ai = "của SHOP" if ad.rating_is_shop else ""
        dem = f" từ {vi_thousands(count)} đánh giá" if count is not None else ""
        reasons.append(f"{_num(ad.rating)}★{dem}{' ' + ai if ai else ''}")
    else:
        quality = 0.0
        reasons.append("Chưa có đánh giá — chưa đo được chất lượng")

    # --- Cờ đà / bão hoà ---
    if monthly is not None and historical:
        annual_share = monthly * 12 / max(1, historical)
        if annual_share >= 0.5:
            reasons.append("Đang lên: nhịp bán gần đây cao so với tổng")
        elif annual_share <= 0.05 and historical > 5000:
            reasons.append("Cảnh báo bão hoà: tổng bán lớn nhưng nhịp gần đây thấp")

    total = clamp(jround(demand * 0.6 + quality * 0.4))
    signals = sum(1 for x in (monthly, ad.rating) if x is not None)
    # Nguồn không công bố số review (`None`) thì không tự khoe "high" được — có điểm mà không
    # biết điểm ấy dựa trên bao nhiêu người thì đó đúng là còn thiếu dữ liệu, và `medium` nói
    # thật hơn. Đây là chỗ DUY NHẤT `None` vẫn bị coi như thiếu, và là chủ ý.
    confidence = (
        "high" if signals >= 2 and (ad.rating_count or 0) >= 50 else "medium" if signals >= 1 else "low"
    )

    return AdScore(
        total=int(total),
        cvr_proxy=0,
        content_score=0,
        longevity_score=0,
        demand_score=int(demand),
        quality_score=int(quality),
        reasons=reasons,
        confidence=confidence,  # type: ignore[arg-type]
    )


def score_ad(ad: Ad) -> AdScore:
    # Sản phẩm sàn TMĐT có con số bán/giá thật → chấm theo cầu + chất lượng, không phải CVR ước lượng.
    if ad.price is not None or ad.sold_count is not None or ad.monthly_sold is not None:
        return _score_product(ad)

    reasons: list[str] = []

    long_part = _longevity(ad)
    iter_part = _iteration(ad)
    ctr_part = _click_through(ad)
    eng_part = _engagement(ad)
    content_score, content_reasons = _content(ad)

    for part in (long_part, iter_part, ctr_part, eng_part):
        if part is not None:
            reasons.append(part.reason)
    reasons.extend(content_reasons)

    # Ước lượng CVR: nghiêng về đời quảng cáo, thứ gần bằng chứng "đang kiếm được tiền" nhất.
    # CTR và tương tác nói về creative chứ không nói về offer, nên đóng góp ít hơn.
    cvr_parts: list[tuple[float, float]] = []
    if long_part is not None:
        cvr_parts.append((long_part.score, 0.55))
    if iter_part is not None:
        cvr_parts.append((iter_part.score, 0.2))
    if ctr_part is not None:
        cvr_parts.append((ctr_part.score, 0.15))
    if eng_part is not None:
        cvr_parts.append((eng_part.score, 0.1))

    total_weight = sum(weight for _, weight in cvr_parts)
    cvr_proxy = (
        clamp(jround(sum(value * weight for value, weight in cvr_parts) / total_weight))
        if total_weight > 0
        else 0
    )

    longevity_score = long_part.score if long_part is not None else 0

    # Độ tin cậy bám theo lượng bằng chứng thật đứng sau ước lượng, để một điểm dựng từ một
    # trường yếu không được trình bày với cùng uy tín như điểm dựng từ bốn trường.
    signal_count = sum(1 for part in (long_part, iter_part, ctr_part, eng_part) if part is not None)
    confidence = "high" if signal_count >= 3 else "medium" if signal_count == 2 else "low"

    if long_part is None:
        reasons.append("Không có ngày bắt đầu (nguồn này không công bố) — độ tin cậy thấp hơn")

    total = clamp(jround(average([cvr_proxy, content_score, cvr_proxy])))

    return AdScore(
        total=int(total),
        cvr_proxy=int(cvr_proxy),
        content_score=int(content_score),
        longevity_score=int(longevity_score),
        reasons=reasons,
        confidence=confidence,  # type: ignore[arg-type]
    )


def score_and_rank(ads: list[Ad]) -> list[Ad]:
    """Chấm điểm cả lô và sắp xếp tốt nhất lên đầu."""
    scored = [ad.model_copy(update={"score": score_ad(ad)}) for ad in ads]
    # `sorted` của Python ổn định, giống `Array.prototype.sort` của V8: hai quảng cáo cùng
    # điểm giữ nguyên thứ tự nguồn trả về.
    return sorted(scored, key=lambda ad: ad.score.total if ad.score else 0, reverse=True)
