"""
Xếp hạng từ khoá.

Mục tiêu là xếp hạng theo mức độ phù hợp, với Shopee và TikTok là hai nguồn
đối chiếu ngang hàng với Google. Cách làm hiển nhiên nhất — xếp theo số nguồn cùng trả về
đúng một từ khoá — không sống nổi khi gặp dữ liệu thật: trên ba nguồn với một từ gốc thật,
chỉ 2 trong 28 từ khoá trùng nhau nguyên văn, vì mỗi nền tảng viết cùng một khái niệm một kiểu.

Vì vậy sự đồng thuận được đo trên *từng chữ bổ nghĩa*. "quần jean suông ống rộng" (Shopee),
"quần jeans ống rộng" (Google) và "quần jeans nữ ống rộng" (TikTok) đều bỏ phiếu cho hai
chữ "ống" và "rộng"; một từ khoá dựng từ các chữ bổ nghĩa mà nhiều nguồn độc lập cùng nêu
ra thì thật sự có cơ sở.

Mỗi thành phần đều ghi lại lý do, để người dùng kiểm chứng thứ hạng thay vì tin mù.
"""

from __future__ import annotations

import math
from dataclasses import dataclass

from lib.core.jscompat import clamp, jround, to_fixed, unique

from .normalize import Vocabulary, best_display, vocabulary_for
from .providers import KEYWORD_PROVIDERS, NATIVE_SCORE_NOTE, PRIMARY_SOURCE, SOURCE_LABEL

#: Những nguồn được hỏi bằng ngôn ngữ CỦA RIÊNG NÓ, không phải ngôn ngữ của ô Quốc gia.
#:
#: Suy từ chính sổ đăng ký thay vì chép tay một danh sách: thêm một nguồn kiểu Temu về sau mà
#: quên cập nhật ở đây thì kết quả của nó bị loại sạch mà không có lỗi nào phát ra — xem `keep`.
TRANSLATED_SOURCES = frozenset(
    pid for pid, provider in KEYWORD_PROVIDERS.items() if provider.query_market
)
from .types import KeywordCandidate, KeywordScore, SourceHit


#: Ranh giới giữa hai dải điểm.
#:
#: Từ khoá đã ĐO ĐƯỢC nhu cầu nằm ở 55–100; từ khoá chỉ có bằng chứng suy đoán nằm ở 0–54.
#: Chia dải thay vì cộng thưởng là có lý do: bằng chứng hai loại này khác nhau về bản chất,
#: không phải khác nhau về mức độ. "Google Trends đo được X người tìm cụm này" và "cụm này
#: đứng thứ nhất trong ô gợi ý của một tiền tố ta tự bịa" không nằm trên cùng một thang, nên
#: gộp chúng vào một con số rồi so sẽ luôn có lúc cho ra thứ tự vô lý.
#:
#: Nhờ chia dải, cột điểm trên giao diện đơn điệu theo đúng thứ tự hàng — nếu cộng thưởng
#: rồi xếp theo nhiều tầng khoá thì sẽ có hàng trên hiện điểm thấp hơn hàng dưới, và người
#: đọc kết luận ngay là bảng bị lỗi.
MEASURED_FLOOR = 55


def _final_score(base: float, demand: int | None) -> float:
    """Ép điểm thô về đúng dải của loại bằng chứng mà từ khoá này có."""
    if demand is None:
        # Nén tuyến tính xuống dải dưới: giữ nguyên thứ tự tương đối, không tạo thêm điểm bằng nhau.
        return base * (MEASURED_FLOOR - 1) / 100
    # Trong dải trên, chính khối lượng tìm kiếm quyết định; phần suy đoán chỉ còn là chi tiết
    # phân định khi hai từ khoá có lượng tìm ngang nhau.
    return MEASURED_FLOOR + clamp(demand * 0.40 + base * 0.05, 0, 100 - MEASURED_FLOOR)


def _build_modifier_support(
    hits: list[SourceHit], seed: str, vocab: Vocabulary
) -> dict[str, dict[str, None]]:
    """
    Chữ bổ nghĩa nào được những nguồn nào bảo chứng.

    Đây chính là thứ làm cho sự đối chiếu giữa các nguồn đo được, dù chúng không bao giờ thống
    nhất cách viết nguyên văn. Giá trị là `dict` chứ không phải `set` vì các câu giải thích
    điểm số đọc ra theo đúng thứ tự nguồn được gặp.
    """
    support: dict[str, dict[str, None]] = {}
    for hit in hits:
        for modifier in vocab.extract_modifiers(hit.raw, seed):
            support.setdefault(modifier, {})[hit.source] = None
    return support


def _assign_source_ranks(
    candidates: list[KeywordCandidate], active_sources: list[str]
) -> dict[str, int]:
    """
    Gán thứ hạng của từng từ khoá bên trong tập kết quả của từng nguồn.

    Mỗi nguồn được xếp theo bằng chứng mạnh nhất mà CHÍNH NÓ có, chứ không theo một thang
    dùng chung: Trends có lượng tìm đo được, Shopee có điểm liên quan tự công bố, còn các
    API gợi ý thì chỉ có thứ tự và mức độ lặp lại. Ép cả ba vào một công thức sẽ khiến hai
    nguồn mạnh bị pha loãng bởi nguồn yếu nhất.

    Trả về số từ khoá mỗi nguồn đóng góp, để giao diện hiển thị được mẫu số.
    """
    totals: dict[str, int] = {}

    for source in active_sources:
        members = [c for c in candidates if source in c.sources]
        if not members:
            continue

        def evidence(candidate: KeywordCandidate, source: str = source) -> tuple[float, ...]:
            hits = [hit for hit in candidate.hits if hit.source == source]
            demand = max(
                (h.demand for h in hits if h.demand is not None and not h.rising), default=-1.0
            )
            native = max((h.native_score for h in hits if h.native_score is not None), default=-1.0)
            # Vị trí nhỏ là tốt, nên đảo dấu để mọi tiêu chí đều "lớn hơn là tốt hơn".
            return (demand, native, -min(h.position for h in hits), len({h.via_term for h in hits}))

        members.sort(key=evidence, reverse=True)
        for rank, candidate in enumerate(members, start=1):
            candidate.source_ranks[source] = rank
        totals[source] = len(members)

    return totals


#: Nền tảng đánh giá chính (`PRIMARY_SOURCE`, nhập từ sổ đăng ký) là nguồn duy nhất đo được
#: nhu cầu thật. Cờ nằm trên chính provider — xem `KeywordProvider.is_primary`.
#:
#: Trọng số của từng nền tảng trong điểm cuối.
#:
#: KHÔNG ngang hàng, và đây là điểm mấu chốt của cả cách xếp hạng. Ba nền tảng trả lời ba
#: câu hỏi khác nhau về chất:
#:
#:   Google  — "bao nhiêu người thật sự tìm cụm này" (lượng tìm đo được, 0–100)
#:   Shopee  — "mô hình của Shopee thấy cụm này liên quan tới đâu" (0.45–0.53, biên độ 0.08)
#:   TikTok  — "cụm này được gọi ra qua bao nhiêu kênh" (2–10 kênh recall)
#:
#: Con số của TikTok là mới, và nó KHÔNG phải lượng tìm dù trông giống một chỉ số nhu cầu:
#: nó đo độ rộng kênh gọi lại, tức "cụm này có thật tới đâu", không phải "bao nhiêu người
#: gõ nó". Nên nó ở lại cùng chiếu với Shopee chứ không được lên chiếu của Google.
#:
#: Cộng ngang hàng ba thứ đó là sai về đơn vị. Đo trên "quần áo nam": cách cộng ngang hàng
#: đẩy `shop quần áo nam` — cụm có lượng tìm cao nhất ngành hàng, 100/100 — ra khỏi top 30,
#: nhường chỗ cho những cụm chỉ mạnh ở hai sàn mà không có tín hiệu nhu cầu nào. Kết quả
#: trông có vẻ "đồng thuận nhiều nguồn" nhưng lại bỏ sót đúng từ khoá đáng làm nhất.
#:
#: Cách chia cụ thể nằm ở `PRIMARY_BAND_FLOOR` bên dưới: Google quyết định dải, hai sàn chỉ
#: được tinh chỉnh bên trong dải.

#: Số từ khoá lấy từ nền tảng chính để làm rổ ứng viên.
#:
#: Rộng hơn số dòng hiển thị (30) là có chủ đích: cần dư chỗ để phần đối chiếu chéo thật sự
#: đổi được thứ tự. Nếu rổ đúng bằng số dòng thì việc đối chiếu chỉ xáo lại trong đúng tập
#: đó và không bao giờ kéo được một từ khoá từ hạng 40 lên hạng 20.
PRIMARY_POOL_SIZE = 50

#: Trọng số từng nguồn khi lấy trung bình thứ hạng. Nhỏ hơn là tốt hơn.
#:
#: Amazon nhận đúng trọng số của Shopee: hai nguồn cùng loại bằng chứng (thứ tự trong ô gợi ý
#: của một sàn thương mại điện tử) và không bao giờ cùng bật ở một thị trường, nên cho chúng
#: hai con số khác nhau là tạo ra một sự chênh lệch không có cơ sở nào để giải thích.
RANK_WEIGHT: dict[str, float] = {
    PRIMARY_SOURCE: 0.5,
    "shopee": 0.2,
    "amazon": 0.2,
    "tiktok": 0.2,
}

#: Trọng số cho nguồn chưa liệt kê ở trên.
DEFAULT_RANK_WEIGHT = 0.2

#: Quá hạng này thì mọi thứ hạng đều tính như nhau, và vắng mặt cũng tính đúng bằng đây.
#:
#: Cái cap này làm hai việc bằng một dòng. Thứ nhất, nó chặn kiểu phạt vô lý của trung bình
#: tuyến tính: không có cap, một từ khoá hạng 1 ở Google và hạng 1 ở Shopee nhưng hạng 60 ở
#: TikTok sẽ bị dìm xuống dưới một từ tầm thường hạng 10 ở cả ba nơi — trong khi thực tế nó
#: mạnh hơn hẳn. Hạng 60 với hạng 20 thì đều là "không đáng kể", không cần phân biệt.
#:
#: Thứ hai, nó cho "vắng mặt" một giá trị dùng được. Vắng mặt KHÔNG phải dữ liệu thiếu — ta
#: đã hỏi nguồn đó và nó không trả về từ khoá này — nên coi như đứng ngoài top 20 là đúng
#: nghĩa. Nhờ vậy mọi ô trong bảng đều có số, và các từ khoá so sánh được với nhau dù được
#: tìm ra bởi những nguồn khác nhau.
RANK_CAP = 20

#: Ngưỡng "xếp cao" để một sàn được quyền đưa từ khoá của nó vào rổ ứng viên.
STRONG_RANK = 10


def _capped_rank(candidate: KeywordCandidate, source: str) -> int:
    """Thứ hạng của từ khoá trên một nguồn, đã chặn trần. Vắng mặt tính bằng trần."""
    rank = candidate.source_ranks.get(source)
    return RANK_CAP if rank is None else min(rank, RANK_CAP)


def _mean_rank(candidate: KeywordCandidate, active_sources: list[str]) -> float:
    """
    Trung bình có trọng số của thứ hạng trên các nguồn. NHỎ HƠN LÀ TỐT HƠN.

    Cố ý dùng thứ hạng thô chứ không quy về thang 0–100 rồi cộng. Điểm gộp 0–100 tạo ra cảm
    giác chính xác không có thật — hai từ khoá chênh nhau 0,07% vẫn hiện thành hai con số
    khác nhau, trong khi bản chất chúng ngang nhau. Thứ hạng thì thật: "Google #4, Shopee
    #17, TikTok #1" là thứ người dùng kiểm chứng được, và trung bình của chúng vẫn xếp được
    thứ tự mà không bịa thêm độ mịn.
    """
    numerator = denominator = 0.0
    for source in active_sources:
        weight = RANK_WEIGHT.get(source, DEFAULT_RANK_WEIGHT)
        numerator += weight * _capped_rank(candidate, source)
        denominator += weight
    return numerator / denominator if denominator else float(RANK_CAP)


def _tiebreak_rank(
    candidate: KeywordCandidate, active_sources: list[str], source_totals: dict[str, int]
) -> float:
    """
    Cùng công thức `_mean_rank` nhưng KHÔNG chặn trần. Chỉ dùng để phân định các thế hoà.

    Cần thiết vì cái trần biến mọi thứ hạng từ 20 trở đi thành một giá trị duy nhất, và điều
    đó đúng khi SO SÁNH sức mạnh nhưng sai khi XẾP THỨ TỰ hiển thị. Đo 2026-07-30 với một mình
    Shopee trên "kem chống nắng": 216 ứng viên thì 197 cùng có `mean_rank` bằng 20,00. Ba tiêu
    chí của `_order` không phân biệt nổi chúng, nên `sorted` ổn định rơi về thứ tự KHÁM PHÁ —
    tức thứ tự các cụm tình cờ được trả về trong hai mươi lăm lượt gọi mở rộng. Hậu quả: từ dòng
    hai mươi trở đi bảng không còn được xếp hạng nữa, và mười một dòng hiện ra không phải mười
    một cụm tốt nhất còn lại mà là mười một cụm được gặp sớm nhất.

    Đặt SAU `mean_rank` trong khoá sắp xếp nên nó không đụng gì tới tác dụng của cái trần: mọi
    cặp mà trần thật sự bảo vệ đều đã khác nhau ở `mean_rank` và không bao giờ đi tới đây.

    Vắng mặt tính bằng "tệ hơn mọi thứ hạng nguồn đó thật sự trả về" thay vì một hằng số bịa
    ra — nguồn trả 216 cụm và nguồn trả 12 cụm thì "không có tên trong danh sách" nặng nhẹ
    khác hẳn nhau.
    """
    numerator = denominator = 0.0
    for source in active_sources:
        weight = RANK_WEIGHT.get(source, DEFAULT_RANK_WEIGHT)
        rank = candidate.source_ranks.get(source)
        numerator += weight * (rank if rank is not None else source_totals.get(source, 0) + 1)
        denominator += weight
    return numerator / denominator if denominator else 0.0


def _native_reason(hit: SourceHit) -> str:
    """
    Câu giải thích điểm gốc, dùng đúng lời của nguồn đã cấp con số ấy.

    Mẫu câu đến từ `KeywordProvider.native_score_note` chứ không viết ở đây, vì mỗi nguồn đo
    một thứ khác nhau — xem chú thích ở `provider.py`.

    Số nguyên hiện dạng nguyên: "gọi ra qua 8 kênh" chứ không phải "qua 8,000 kênh".
    """
    value = float(hit.native_score or 0)
    text = str(int(value)) if value.is_integer() else to_fixed(value, 3)
    template = NATIVE_SCORE_NOTE.get(hit.source, "{label} chấm điểm gốc {value}")
    return template.format(label=SOURCE_LABEL.get(hit.source, hit.source), value=text)


def _rank_breakdown(
    candidate: KeywordCandidate, source_totals: dict[str, int], active_sources: list[str]
) -> str:
    """
    Câu giải thích thứ hạng, để người dùng kiểm chứng thay vì tin mù.

    CHỈ nguồn đo được nhu cầu mới được nêu con số. Các sàn chỉ được nói "có" hoặc "không có",
    đúng bằng thứ chúng thật sự biết.

    Trước đây câu này đọc là "Shopee #2/88, TikTok #3/61", và nó bán một sự chính xác không có
    thật theo hai cách. Thứ nhất, tử số: các sàn là API hoàn thiện tiền tố, nên "thứ hạng" của
    một cụm là sản phẩm phụ của những tiền tố CHÍNH TA gieo, không phải phán quyết của sàn về
    nhu cầu. Thứ hai, mẫu số: 88 chỉ là số cụm mà mấy lượt mở rộng tình cờ nhặt được, đổi độ
    sâu là nó đổi theo — nên "#2/88" và "#2/230" trông như hai mức độ tin cậy khác nhau trong
    khi bằng chứng y hệt.

    Thứ hạng nội bộ vẫn được TÍNH và vẫn tham gia `mean_rank` với trọng số 0,2 — đó là tín hiệu
    yếu nhưng có thật. Chỉ là không đáng in ra thành một con số trông như đo đạc.
    """
    measured: list[str] = []
    present: list[str] = []
    absent: list[str] = []
    for source in active_sources:
        name = SOURCE_LABEL.get(source, source)
        rank = candidate.source_ranks.get(source)
        if rank is None:
            absent.append(name)
        elif source == PRIMARY_SOURCE:
            measured.append(f"{name} #{rank}/{source_totals.get(source, '?')} theo lượng tìm")
        else:
            present.append(name)

    parts = list(measured)
    if present:
        parts.append(f"{' + '.join(present)} cùng gợi ý")
    if absent:
        parts.append(f"{' + '.join(absent)} không có")
    return f"Hạng trung bình {candidate.score.mean_rank:.1f} — " + ", ".join(parts)




@dataclass
class RankedKeywords:
    items: list[KeywordCandidate]
    #: Số từ khoá mỗi nguồn đóng góp, trước khi lọc theo ý định tìm kiếm.
    source_totals: dict[str, int]


def rank_keywords(
    all_hits: list[SourceHit],
    seed: str,
    active_sources: list[str],
    include_informational: bool,
    country: str,
) -> RankedKeywords:
    source_count = max(1, len(active_sources))
    # Mọi phép phân loại văn bản bên dưới đều đọc theo thị trường này. Không có mặc định:
    # xếp một bảng từ khoá Philippines bằng vốn từ tiếng Việt vẫn chạy trót lọt và trả về
    # một bảng trông bình thường — xem `lib/keywords/normalize.py`.
    vocab = vocabulary_for(country)

    def keep(hit: SourceHit) -> bool:
        """
        Loại kết quả đã trôi khỏi từ gốc — riêng Shopee hay trả về những cụm merchandising
        liên quan lỏng lẻo xen lẫn biến thể thật.

        Bảng "truy vấn hàng đầu" của Trends được miễn phép lọc này, vì nó là hành vi ĐO
        ĐƯỢC: chính những người tìm từ gốc cũng tìm cụm đó. Bằng chứng ấy mạnh hơn phép
        khớp chuỗi — và phép khớp chuỗi lại loại nhầm đúng những cụm giá trị nhất, vì
        `is_on_topic` đòi chữ cuối của từ gốc phải có mặt, nên "shop quần áo" bị đánh rớt
        khỏi từ gốc "quần áo nam" dù nó là truy vấn nhiều lượt tìm nhất ngành hàng.

        Bảng "đang tăng" thì KHÔNG được miễn: nó bám theo sự kiện thời sự, và đã quan sát
        thấy nó trả về "giá vàng hôm nay" lẫn "thế vận hội mùa đông 2026" cho một từ gốc
        thời trang.

        NGUỒN HỎI BẰNG NGÔN NGỮ KHÁC được đối chiếu với CỤM ĐÃ HỎI, không phải với từ gốc.
        Temu luôn được hỏi bằng tiếng Anh (`KeywordProvider.query_market`), nên nó trả về
        "headphone case" trong khi từ gốc là "tai nghe" — hai chuỗi không chia sẻ một chữ nào,
        và phép khớp chuỗi loại sạch. Đo 2026-09-05: Temu trả về từ khoá thật nhưng bảng cuối
        cùng rỗng trơn, `totalFound = 0`.

        `via_term` là cụm ta THẬT SỰ gõ vào Temu ("headphone", "headphone women"), tức nó đã ở
        đúng ngôn ngữ của kết quả — nên nó là mốc đối chiếu đúng, và phép lọc vẫn còn hiệu lực
        thật chứ không bị tắt đi: một cụm Temu trôi khỏi chủ đề vẫn bị loại như thường.
        """
        if hit.demand is not None and not hit.rising:
            return True
        if hit.source in TRANSLATED_SOURCES:
            return vocab.is_on_topic(hit.raw, hit.via_term)
        return vocab.is_on_topic(hit.raw, seed)

    relevant = [hit for hit in all_hits if keep(hit)]

    modifier_support = _build_modifier_support(relevant, seed, vocab)

    # Gom mọi cách viết của cùng một khái niệm vào một nhóm.
    groups: dict[str, list[SourceHit]] = {}
    for hit in relevant:
        key = vocab.normalize(hit.raw)
        if not key:
            continue
        groups.setdefault(key, []).append(hit)

    # Điểm gốc được chuẩn hoá THEO TỪNG NGUỒN, không phải trên một thang dùng chung.
    #
    # Điểm gốc chỉ mang thông tin khi so tương đối trong chính tập kết quả này — Shopee chấm
    # rất sát nhau (~0,45–0,53) nên con số tuyệt đối không nói lên gì. Nhưng chia theo nguồn
    # thì bắt buộc chứ không phải cho gọn: từ khi TikTok cũng công bố điểm gốc, hai thang nằm ở
    # hai thế giới khác nhau — Shopee 0,45–0,53 còn TikTok đếm 2–10 kênh. Chuẩn hoá chung sẽ dồn
    # TOÀN BỘ cụm Shopee xuống đáy thang và xoá sạch thành phần `marketplace` của sàn, chỉ vì
    # một nguồn khác tình cờ dùng đơn vị lớn hơn.
    native_bounds: dict[str, tuple[float, float]] = {}
    for source in {hit.source for hit in relevant if hit.native_score is not None}:
        values = [
            hit.native_score
            for hit in relevant
            if hit.source == source and hit.native_score is not None
        ]
        low = min(values)
        native_bounds[source] = (low, (max(values) - low) or 1)

    candidates: list[KeywordCandidate] = []

    for keyword, hits in groups.items():
        reasons: list[str] = []
        sources = unique(hit.source for hit in hits)
        modifiers = vocab.extract_modifiers(keyword, seed)
        intent = vocab.classify_intent(keyword)
        seasonal = vocab.detect_season(keyword)

        # --- đồng thuận: các chữ bổ nghĩa của từ khoá này được bảo chứng rộng tới đâu ---
        agreement = 0.0
        if modifiers:
            per_modifier = [len(modifier_support.get(m, {})) / source_count for m in modifiers]
            agreement = clamp((sum(per_modifier) / len(per_modifier)) * 100)

            # `max` trả về phần tử lớn nhất *đầu tiên*, giống phần tử đầu sau một lần sort ổn định.
            strongest = max(modifiers, key=lambda m: len(modifier_support.get(m, {})))
            strongest_count = len(modifier_support.get(strongest, {}))
            if strongest_count >= 2:
                backers = [SOURCE_LABEL[s] for s in modifier_support.get(strongest, {})]
                reasons.append(f'Biến thể "{strongest}" được {" + ".join(backers)} cùng gợi ý')
        else:
            reasons.append("Chính là từ khoá gốc — không mở rộng thêm")

        # Trùng nguyên văn ở nhiều nguồn thì hiếm, nhưng là bằng chứng đối chiếu mạnh nhất có thể.
        if len(sources) >= 2:
            agreement = clamp(agreement + 20)
            labels = " + ".join(SOURCE_LABEL[s] for s in sources)
            reasons.append(f"Xuất hiện nguyên văn ở {labels}")

        # --- độ nổi bật: các nguồn xếp nó ở đâu, và nó lặp lại bền tới mức nào ---
        best_position = min(hit.position for hit in hits)
        position_score = clamp(100 * math.exp(-best_position / 4))
        # Lặp lại ở nhiều cụm mở rộng khác nhau nghĩa là liên quan rộng, không phải ngẫu nhiên.
        distinct_terms = len({hit.via_term for hit in hits})
        recurrence_score = clamp(100 * (1 - math.exp(-(distinct_terms - 1) / 2)))
        prominence = clamp(position_score * 0.65 + recurrence_score * 0.35)

        if best_position == 0:
            reasons.append("Đứng đầu danh sách gợi ý của nguồn")
        if distinct_terms >= 3:
            reasons.append(f"Lặp lại ở {distinct_terms} truy vấn mở rộng khác nhau")

        # --- điểm gốc: con số do chính nguồn công bố, mỗi nguồn một thang riêng ---
        #
        # Lấy điểm CAO NHẤT sau khi chuẩn hoá, chứ không phải điểm thô cao nhất: điểm thô của
        # hai nguồn khác đơn vị nên so trực tiếp là vô nghĩa — 8 kênh của TikTok sẽ luôn thắng
        # 0,53 của Shopee dù cụm đó đứng chót bảng TikTok.
        scored = [
            (
                clamp(
                    ((hit.native_score - native_bounds[hit.source][0])
                     / native_bounds[hit.source][1]) * 100
                ),
                hit,
            )
            for hit in hits
            if hit.native_score is not None
        ]
        marketplace = 0.0
        if scored:
            # `key=` là bắt buộc: không có nó, `max` sẽ so tới phần tử thứ hai khi hai điểm bằng
            # nhau, và `SourceHit` không so sánh được — một lỗi chỉ nổ ra khi gặp thế hoà.
            marketplace, best_hit = max(scored, key=lambda pair: pair[0])
            reasons.append(_native_reason(best_hit))

        # --- nhu cầu: khối lượng tìm kiếm thật, khi Trends có nhắc tới từ khoá này ---
        #
        # Đây là thành phần duy nhất trả lời được câu "có ai tìm từ này không". Ba thành
        # phần trên đều chỉ đo mức độ các nguồn *nói về* từ khoá: `prominence` là thứ tự
        # trong ô gợi ý, mà thứ tự đó phản ánh cách autocomplete hoàn thiện tiền tố chứ
        # không phản ánh lượng người tìm. Chính vì thiếu thành phần này mà một cụm như
        # "quần áo nam cao cấp bot boutique" — tên một shop, gần như không ai gõ — từng
        # đứng đầu bảng chỉ vì nó là gợi ý số 1 của một tiền tố ta tự bịa ra.
        measured = [hit for hit in hits if hit.demand is not None and not hit.rising]
        demand: int | None = None
        change_percent: int | None = None
        if measured:
            # `change_percent` phải đến từ ĐÚNG hàng đã cấp `demand`, nên chọn hàng rồi mới
            # đọc hai trường của nó — không phải `max()` riêng từng trường. Cùng một từ khoá
            # có thể được nhiều lượt gọi trả về (các cửa sổ hoặc từ gốc khác nhau), và ghép
            # lượng tìm của hàng này với phần trăm của hàng kia sẽ ra một cặp số chưa từng
            # tồn tại ở bất kỳ đâu trong Trends.
            best = max(measured, key=lambda hit: hit.demand or 0)
            demand = int(clamp(jround(best.demand or 0)))
            if best.change_percent is not None:
                change_percent = jround(best.change_percent)
            reasons.append(f"Google Trends đo lượng tìm {demand}/100 trong nhóm truy vấn liên quan")

        rising = any(hit.rising for hit in hits)
        if rising:
            growth = max((hit.demand or 0) for hit in hits if hit.rising)
            # Trends dùng 5000 làm mã cho nhãn "Đột biến" chứ không phải một phần trăm thật.
            label = "đột biến" if growth >= 5000 else f"+{int(growth)}%"
            reasons.append(f"Google Trends xếp vào nhóm đang tăng ({label})")

        # --- ý định tìm kiếm ---
        total = agreement * 0.45 + prominence * 0.3 + marketplace * 0.15

        if rising:
            total += 8
        if vocab.has_commercial_marker(keyword):
            total += 10
            # Nêu đúng chữ đã kích hoạt chứ không kể ví dụ: với thị trường ngoài Việt Nam,
            # một câu giải thích liệt kê "giá/rẻ/chính hãng" là nói về một bảng từ vựng
            # không hề được dùng để chấm dòng này.
            reasons.append("Có dấu hiệu ý định mua trong từ khoá")
        if intent == "informational":
            # Là truy vấn thật, nhưng không phải ứng viên để test sản phẩm.
            total *= 0.35
            reasons.append("Câu hỏi tìm hiểu, không phải từ khoá mua hàng")
        if seasonal:
            reasons.append(f'Từ khoá theo mùa: "{seasonal}"')

        total = _final_score(clamp(total), demand)

        candidates.append(
            KeywordCandidate(
                keyword=keyword,
                display=best_display([hit.raw for hit in hits]),
                hits=hits,
                sources=sources,
                modifiers=modifiers,
                intent=intent,  # type: ignore[arg-type]
                seasonal=seasonal,
                score=KeywordScore(
                    total=int(clamp(jround(total))),
                    agreement=jround(agreement),
                    prominence=jround(prominence),
                    marketplace=jround(marketplace),
                    demand=demand,
                    change_percent=change_percent,
                    reasons=reasons,
                ),
            )
        )

    # Thứ hạng theo nguồn tính trên TOÀN BỘ ứng viên, trước khi lọc: "thứ 7 trong 160 từ khoá
    # Google trả về" phải đúng với những gì Google thật sự trả về, không phụ thuộc vào việc
    # người dùng có bật hiển thị từ khoá dạng câu hỏi hay không.
    source_totals = _assign_source_ranks(candidates, active_sources)

    # Rổ ứng viên do nền tảng chính quyết định; hai sàn chỉ dùng để đối chiếu chéo, không
    # đóng góp từ khoá của riêng chúng.
    #
    # Đây là điểm khác biệt cốt lõi so với cách gộp trước đây. Shopee và TikTok đều là API
    # hoàn thiện tiền tố, nên chúng chỉ đẻ ra biến thể bắt đầu bằng chính từ gốc — cho chúng
    # quyền đưa ứng viên vào rổ là để cả bảng trôi về đúng vùng long-tail đó, đúng thứ mà
    # công cụ này đang tìm cách thoát ra.
    pool = _primary_pool(candidates, active_sources)

    for candidate in pool:
        candidate.score.mean_rank = round(_mean_rank(candidate, active_sources), 2)
        candidate.score.reasons.insert(0, _rank_breakdown(candidate, source_totals, active_sources))

    filtered = pool if include_informational else [c for c in pool if c.intent == "commercial"]
    return RankedKeywords(
        items=sorted(filtered, key=lambda c: _order(c, active_sources, source_totals)),
        source_totals=source_totals,
    )


def _primary_pool(
    candidates: list[KeywordCandidate], active_sources: list[str]
) -> list[KeywordCandidate]:
    """
    Chọn rổ ứng viên: `PRIMARY_POOL_SIZE` từ khoá có lượng tìm cao nhất của nền tảng chính.

    Chỉ lấy các cụm ở bảng "truy vấn hàng đầu" — chúng là những cụm có lượng tìm ĐO ĐƯỢC. Các
    cụm ở bảng "đang tăng" bị loại khỏi rổ vì chúng mang phần trăm tăng trưởng chứ không phải
    khối lượng, nên không xếp chung thang được, và chúng bám theo sự kiện thời sự.

    Quay về dùng toàn bộ ứng viên trong hai trường hợp: người dùng không bật nền tảng chính,
    hoặc nền tảng chính có bật nhưng lần này không trả về gì (Trends hỏng là chuyện thường —
    nó cần trình duyệt và phiên đăng nhập). Trả bảng rỗng trong khi hai sàn vẫn lấy được vài
    trăm từ khoá là biến một sự cố của một nguồn thành hỏng cả tính năng.
    """
    if PRIMARY_SOURCE not in active_sources:
        return candidates
    measured = [c for c in candidates if c.score.demand is not None]
    if not measured:
        return candidates
    measured.sort(key=lambda c: c.score.demand or 0, reverse=True)
    pool = measured[:PRIMARY_POOL_SIZE]

    # Kết nạp thêm những từ khoá mà MỌI sàn đang bật đều xếp rất cao.
    #
    # Đo trên "quần áo nam" ngày 2026-07-29: rổ thuần Google bỏ lỡ đúng ba từ đạt ngưỡng này,
    # trong đó `quần áo nam boy phố` đứng hạng 2 Shopee và hạng 3 TikTok cùng lúc. Trends
    # không nhắc tới chúng vì lượng tìm trên Google quá thấp — nhưng người mua thì gõ thẳng
    # vào sàn, và đó lại đúng nhóm từ khoá mà seller nhỏ còn cửa cạnh tranh.
    #
    # Chúng được vào rổ chứ không được ưu ái: Google vắng mặt thì lĩnh trần `RANK_CAP`, và
    # chúng tự chìm nếu vị thế trên sàn không đủ mạnh để bù.
    markets = [s for s in active_sources if s != PRIMARY_SOURCE]
    if markets:
        seen = {c.keyword for c in pool}
        for candidate in candidates:
            if candidate.keyword in seen:
                continue
            ranks = [candidate.source_ranks.get(s) for s in markets]
            if all(rank is not None and rank <= STRONG_RANK for rank in ranks):
                pool.append(candidate)
    return pool


def _order(
    candidate: KeywordCandidate, active_sources: list[str], source_totals: dict[str, int]
) -> tuple[int, float, int, float]:
    """
    Thứ tự hiển thị. Sắp TĂNG DẦN — thứ hạng nhỏ là tốt.

    Tiêu chí đầu là hạng trung bình có trọng số trên các nguồn. Khi hai từ khoá bằng nhau ở
    đó, lượng tìm đo được phân định (đảo dấu để nhiều hơn thì đứng trước).

    Tiêu chí cuối là thứ hạng KHÔNG chặn trần, và nó tồn tại vì hai tiêu chí trên để lại
    những thế hoà rất lớn: `RANK_CAP` gộp mọi hạng từ 20 trở đi thành một, nên với một nguồn
    duy nhất thì gần như cả bảng bằng điểm nhau. Thiếu nó, `sorted` ổn định rơi về thứ tự
    khám phá và phần đuôi bảng không còn được xếp hạng — xem `_tiebreak_rank`.

    Từ khoá dạng câu hỏi luôn xuống cuối — chúng là truy vấn thật nhưng không phải ứng viên
    để test sản phẩm.
    """
    score = candidate.score
    return (
        0 if candidate.intent == "commercial" else 1,
        score.mean_rank,
        -(score.demand or 0),
        _tiebreak_rank(candidate, active_sources, source_totals),
    )
