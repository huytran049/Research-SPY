"""
NGUỒN TỪ KHOÁ: Temu search suggest — qua MÁY-THỢ, không gọi thẳng.

ĐÂY LÀ NGUỒN DUY NHẤT KHÔNG GỌI HTTP THẲNG, và điều đó là bắt buộc chứ không phải lựa chọn.

Đã đo ba lần, ba thời điểm, cùng một kết luận:

    2026-08-10 (`taobao.py`)  Temu ❌ CAPTCHA ngay trang chủ ("Security Verification")
    2026-09-03 (commit ed8cb33) `/api/poppy/v1/search_suggest` trả `{"intercepted":true}` với
                              MỌI biến thể header/cookie; mở bằng Chrome thật cũng ra trang
                              "Security verification"
    2026-09-03 (lần này)      từ chính VPS: GET → HTTP 500 `error_code 50000`
                              POST → HTTP 403 `error_code 40001`
                              GET `/` → HTTP 200 nhưng body là JS chống bot đã làm rối

IP KHÔNG bị chặn cứng — trang chủ vẫn trả 200. Thứ thiếu là token `anti-content`, do JS của
chính trang sinh ra lúc chạy và xoay liên tục. Viết lại thuật toán ký sẽ hỏng mỗi lần Temu
đổi, nên cách duy nhất bền là để CHÍNH TRANG gọi rồi chộp response — đúng lối mà tab "Sản
phẩm" đã dùng cho Temu từ trước, và chỉ extension trong một trình duyệt thật làm được.

HAI HỆ QUẢ, cả hai đều phải nói ra chứ không được giấu:

1. NGUỒN NÀY CẦN MÁY-THỢ ONLINE. Bảy nguồn kia chạy được cả khi không có trình duyệt nào.
   `app/api/keywords.py::sources` ẩn hẳn Temu khỏi danh sách khi không có thợ, để người dùng
   không chọn được một thứ chắc chắn hỏng.

2. HỎI GỘP MỘT LƯỢT, TRẦN 12 CỤM. Bộ mở rộng hỏi mỗi nguồn 12–45 lượt (`DEPTH_CALLS`). Ở đây
   một lượt là một lần gõ vào trang thật; worker xử lý tuần tự nên các truy vấn rời lẻ có thể
   chiếm worker 3,6–13 phút. Gộp chúng lại còn khoảng 40 giây cho cả lượt. Đổi lại: mức "Thường" và "Sâu" cũng chỉ được
   12 cụm như mức "Nhanh" — cố ý, và `max_terms` là chỗ nói ra điều đó.
"""

from __future__ import annotations

import logging

from lib.core.worker_relay import (
    BATCH_TIMEOUT_S,
    WorkerOffline,
    WorkerTimeout,
    run_on_worker,
    worker_error,
)

from ..provider import KeywordProvider, Suggestion
from ..types import SearchContext

#: Trần số cụm cho một lượt. Trùng với `TEMU_SUGGEST_MAX_TERMS` ở `extension/background.js` —
#: chốt ở cả hai đầu, để một payload méo không biến thành một lượt chiếm máy-thợ mười phút.
_LOG = logging.getLogger("keywords.temu")

#: 4 chứ không phải 12. Mỗi cụm là một lượt gõ vào ô tìm kiếm thật trên máy-thợ — mười hai
#: lượt tốn gần một phút và, đo được, gần như không thêm gợi ý nào so với bốn lượt đầu. Cụm
#: nằm sau trong `build_terms` là những biến thể xa dần từ gốc; ai cần phủ rộng thì đổi mức
#: sâu, còn mặc định nên trả về thứ SÁT nhất.
MAX_TERMS = 4

#: Temu bán xuyên biên giới bằng MỘT tên miền `temu.com`, khác Shopee (mỗi nước một tên miền).
#:
#: Endpoint gợi ý không nhận tham số vùng nào — nó trả theo phiên của chính máy-thợ. Vì vậy
#: `geo_targeted = False`, giống TikTok: để giao diện GIẢI THÍCH cho đúng chứ không phải để ẩn
#: ô chọn đi.
#:
#: Ô Quốc gia TỪNG có tác dụng gián tiếp — nó chọn ngôn ngữ của các cụm mở rộng — và đó là một
#: cái bẫy chứ không phải một tính năng: chọn Việt Nam thì công cụ đi gõ "tai nghe nữ" vào một
#: ô tìm kiếm phục vụ bằng tiếng Anh. Nay `query_market = "US"` cắt hẳn đường đó.
MARKETS = None


class Temu(KeywordProvider):
    id = "temu"
    label = "Temu"
    #: Endpoint gợi ý không kèm điểm liên quan nào — chỉ có thứ tự. Xếp thuần theo vị trí và
    #: mức độ lặp lại, y như Amazon và Taobao.
    has_native_score = False
    markets = MARKETS
    geo_targeted = False
    #: Hỏi bằng tiếng Anh cho mọi nước TRỪ Việt Nam — xem `query_market_for` ngay dưới.
    query_market = "US"

    def query_market_for(self, country: str) -> str | None:
        """
        Việt Nam → hỏi bằng tiếng Việt; mọi nước khác → tiếng Anh như cũ.

        Chốt 13/09/2026. Phiên Temu trên máy-thợ là TEMU VIETNAM, và đo bằng tay trên chính
        phiên đó: gõ "áo thun" ra 15 gợi ý tiếng Việt ("áo thun tay dài nữ", "áo thun ôm body"…),
        gõ "t shirt" ra 15 gợi ý tiếng Anh. Ghi chú cũ "hỏi bằng tiếng Việt chỉ ra tiếng vọng"
        (05/09) là HỆ QUẢ của lỗi đọc sai `slice_words` bên extension, không phải của Temu —
        lỗi ấy làm MỌI ngôn ngữ ra 0–1 gợi ý, nên tiếng Việt bị đổ oan.
        """
        return None if (country or "").upper() == "VN" else self.query_market

    #: Hỏi gộp: xem ghi chú đầu file.
    batches_terms = True
    max_terms = MAX_TERMS

    async def fetch_suggestions_batch(
        self, terms: list[str], ctx: SearchContext
    ) -> dict[str, list[Suggestion]]:
        """
        Sai một job xuống máy-thợ, nhận về gợi ý của cả danh sách cụm.

        Đổi ba loại hỏng của relay thành ba câu người vận hành làm được gì đó. Gộp chúng lại
        thành một câu chung là cách chắc chắn khiến người ta đi tìm sai chỗ: "không có thợ"
        thì phải đi mở trang `/worker`, còn "hết giờ" thì phải xem máy-thợ có đang kẹt job
        khác không — hai việc khác hẳn nhau.
        """
        try:
            result = await run_on_worker(
                "RS_TEMU_SUGGEST",
                {"terms": terms[:MAX_TERMS], "region": ctx.country},
                timeout_s=BATCH_TIMEOUT_S,
            )
        except WorkerOffline as e:
            raise RuntimeError(f"Temu cần máy-thợ: {e}") from e
        except WorkerTimeout as e:
            raise RuntimeError(f"Temu không kịp trả gợi ý: {e}") from e

        # Thợ NHẬN job nhưng không chạy xong — cờ `__workerError` chở theo lý do thật, nói
        # lại đúng lý do đó thay vì câu chẩn đoán của nhánh `None` bên dưới.
        if (why := worker_error(result)) is not None:
            raise RuntimeError(f"Temu: {why}")

        # `None` KHÔNG phải "dữ liệu lạ" — nó có đúng một nguyên nhân hay gặp, và nói thẳng ra
        # tiết kiệm được một vòng đi tìm nhầm chỗ. Chuỗi đường đi: extension không có handler
        # cho loại job này → `chrome.runtime.lastError` → `content.js` trả `result: null` →
        # trang /worker POST null về. Xảy ra mỗi lần thêm một loại job mới mà quên bấm Reload,
        # vì restart backend không đụng gì tới trình duyệt. Đã mắc đúng lỗi này 2026-09-04.
        if result is None:
            raise RuntimeError(
                "Máy-thợ không trả lời job RS_TEMU_SUGGEST — nhiều khả năng extension chưa nạp "
                "loại job này. Vào chrome://extensions bấm Reload rồi F5 tab Máy thợ."
            )
        if not isinstance(result, dict):
            raise RuntimeError(
                f"Máy-thợ trả về kiểu {type(result).__name__} cho Temu, cần một object"
            )

        # `blocked` kèm `groups` rỗng mới là hỏng thật. Có gợi ý mà vẫn `blocked` nghĩa là
        # extension bị chặn Ở CỤM CUỐI — phần đã lấy được vẫn dùng tốt, vứt đi là phí.
        groups = result.get("groups") or []
        by_term: dict[str, list[Suggestion]] = {}
        for group in groups:
            if not isinstance(group, dict):
                continue
            term = str(group.get("term") or "")
            words = group.get("suggestions") or []
            if not term or not isinstance(words, list):
                continue
            # LOẠI TIẾNG VỌNG: gợi ý trùng đúng cụm ta vừa gõ thì không mang thông tin nào.
            #
            # Endpoint gợi ý của Temu trả lại chính truy vấn trong payload, và `parseTemuSuggest`
            # bên extension nhặt mọi chuỗi nằm dưới các khoá kiểu `query`/`keyword` nên nhặt luôn
            # cả nó. Khi Temu KHÔNG có gợi ý thật — đúng thứ xảy ra khi hỏi bằng tiếng Việt — thì
            # tiếng vọng là thứ duy nhất về, và bảng kết quả đầy những chuỗi do CHÍNH TA bịa ra để
            # dò. Đo 2026-09-05 với từ gốc "tai nghe": 13 "từ khoá" trả về thì cả 13 là cụm ta gõ,
            # gồm cả "tai nghe n", "tai nghe c", "tai nghe d" — không ai tìm những cụm đó cả.
            #
            # Nguy hiểm hơn một bảng rỗng: bảng rỗng thì người dùng biết là không có gì.
            echo = _norm(term)
            by_term[term] = [
                Suggestion(keyword=str(w).strip())
                for w in words
                if isinstance(w, str) and w.strip() and _norm(w) != echo
            ]

        # NÓI RA CẢ KHI "THÀNH CÔNG". Mười hai cụm mà về một gợi ý thì về mặt kỹ thuật là
        # thành công, nên không nhánh nào ném lỗi và phần chẩn đoán của extension chết trong
        # im lặng — trong khi đó đúng là lúc cần đọc nó nhất. Ghi log thay vì ném: một gợi ý
        # thật vẫn là kết quả, không được vứt.
        total = sum(len(v) for v in by_term.values())
        raw = sum(len(g.get("suggestions") or []) for g in groups if isinstance(g, dict))
        # Ghi LUÔN, không chỉ khi thấp: biết "hàm có chạy không" là câu hỏi đầu tiên, và một
        # dòng log mỗi lượt tìm rẻ hơn nhiều so với một vòng đoán.
        # In cả KHOÁ NHÓM lẫn cụm đã gửi: `_expand_batched` tra `by_term.get(term)` theo đúng
        # chuỗi đã gửi, nên chỉ cần extension trả về một biến thể (cắt khoảng trắng, đổi hoa
        # thường) là mọi nhóm rơi hết mà không ai báo gì.
        dbg = result.get("debug") or {}
        _LOG.info("Temu: ô=%r · gõ bằng=%s · lớp gợi ý=%s · focus=%s · hiện=%s · bước cuối=%r",
                  dbg.get("pickedInput"), dbg.get("typedBy"), dbg.get("listbox"),
                  dbg.get("hasFocus"), dbg.get("visible"), dbg.get("stage"))
        _LOG.info("Temu: %d cụm → %d gợi ý thô → %d sau lọc · blocked=%s | gửi=%r | nhận=%r | mẫu=%r",
                  len(terms), raw, total, result.get("blocked"),
                  terms[:3], list(by_term)[:3],
                  [w.keyword for v in by_term.values() for w in v][:5])
        if total < len(terms):
            _LOG.warning("Temu chẩn đoán: %s", _with_debug(result))
            # Mẫu ĐẦY ĐỦ vào log (câu lỗi trên giao diện chỉ giữ 1.200 ký tự). Phần đầu payload
            # toàn `slice_words` nên 1.200 ký tự không bao giờ chạm tới chỗ gợi ý thật nằm.
            _LOG.warning("Temu mẫu payload đầy đủ: %s", dbg.get("sample"))

        # LOẠI MẢNH CỦA CHÍNH TRUY VẤN. `slice_words` — cái tên đã nói — là cách Temu CẮT câu
        # truy vấn thành từ, không phải danh sách gợi ý. Đo 07/09/2026 bằng ba phép thử:
        #
        #     "blueto"        → "blueto"      (gõ dở cũng không có phần hoàn thiện)
        #     "wireless ear"  → "ear"         (một mảnh của chính nó)
        #     "túi xách"      → "handbag"     (bản dịch, vẫn là chính nó)
        #
        # Trả những chuỗi ấy ra như từ khoá là tệ hơn trả rỗng: "ear" trông như một từ khoá
        # thật và sẽ đi tiếp vào mọi bảng phía sau.
        n_fragment = 0
        for term, words in list(by_term.items()):
            whole = _norm(term)
            # CHỈ loại chuỗi NẰM TRONG cụm truy vấn (mảnh của nó), tuyệt đối không loại chuỗi
            # CHỨA cụm truy vấn — đó chính là hình dạng của một gợi ý thật: "áo thun" →
            # "áo thun nam". Bản trước loại cả hai chiều và sẽ vứt sạch phần đọc được từ lớp
            # gợi ý trên màn hình.
            kept = [w for w in words if _norm(w.keyword) not in whole]
            n_fragment += len(words) - len(kept)
            by_term[term] = kept

        # LOẠI CHỮ CỦA GIAO DIỆN. `parseTemuSuggest` bên extension cố ý duyệt cây tìm những
        # khoá NGHE NHƯ từ khoá thay vì bám một đường dẫn cứng — bền trước việc Temu đổi cấu
        # trúc, nhưng đổi lại nó nhặt luôn nhãn tĩnh của trang. Đo 07/09/2026, từ gốc
        # "bluetooth headphones": cả 12 cụm trả về đúng một chuỗi "Explore your interests".
        #
        # Phép thử không cần biết Temu viết nhãn gì: MỘT CHUỖI XUẤT HIỆN Ở MỌI CỤM thì không
        # thể là gợi ý cho cụm nào — mười hai truy vấn khác nhau không có chung một gợi ý duy
        # nhất. Nó chỉ có thể là chữ có sẵn trên trang.
        if len(by_term) > 2:
            # ĐẾM THEO SỐ NHÓM, không đòi có mặt ở TẤT CẢ. Bản trước lấy giao của mọi nhóm,
            # nên chỉ cần một cụm không trả về nhãn đó là nhãn thoát lưới — và "Explore your
            # interests" đã thoát đúng kiểu ấy, rồi đi tiếp thành một "từ khoá".
            # Một chuỗi KHÔNG chứa cụm truy vấn mà xuất hiện ở từ hai cụm trở lên thì không
            # thể là gợi ý cho cụm nào; nó là chữ có sẵn trên trang.
            count: dict[str, int] = {}
            for term, words in by_term.items():
                for w in {_norm(x.keyword) for x in words}:
                    if w not in _norm(term):
                        count[w] = count.get(w, 0) + 1
            everywhere = {w for w, n in count.items() if n >= 2}
            if everywhere:
                _LOG.warning("Temu: bỏ %d chuỗi lặp ở nhiều cụm (chữ của giao diện): %r",
                             len(everywhere), sorted(everywhere)[:3])
                by_term = {t: [w for w in v if _norm(w.keyword) not in everywhere]
                           for t, v in by_term.items()}

        if not any(by_term.values()) and n_fragment:
            # Nói ĐÚNG chuyện đã xảy ra, đừng để nó thành một bảng rỗng không lời. Đây không
            # phải "Temu im lặng" mà là "Temu chỉ vọng lại truy vấn" — hai chuyện khác nhau,
            # và chuyện thứ hai có nghĩa là đường này không cho gợi ý được.
            raise RuntimeError(
                f"Temu chỉ trả lại mảnh của chính truy vấn ({n_fragment} chuỗi), không có gợi "
                f"ý nào. Endpoint `search_suggest` đáp bằng `slice_words` — đó là cách Temu CẮT "
                f"câu tìm thành từ, không phải danh sách gợi ý."
            )

        if not any(by_term.values()):
            # Kèm chẩn đoán của extension vào câu lỗi. Không kèm thì thứ duy nhất hiện lên là
            # "Temu không trả gợi ý nào" — đúng nhưng vô dụng, vì nó không phân biệt được ba
            # nguyên nhân cần ba cách xử khác hẳn: không tìm thấy ô search, trang không gọi
            # endpoint nào, hay gọi rồi mà ta chộp nhầm.
            raise RuntimeError(_with_debug(result))
        return by_term

    async def fetch_suggestions(self, term: str, ctx: SearchContext) -> list[Suggestion]:
        """
        Không dùng tới: `batches_terms` bật nên `expand_with_provider` chỉ gọi bản gộp.

        Vẫn phải cài vì `KeywordProvider` khai nó `@abstractmethod`. Gọi bản gộp cho đúng một
        cụm thay vì `raise`: nếu về sau có nơi nào gọi thẳng hàm này, nó chạy đúng chứ không
        vỡ — chỉ chậm hơn, và chậm thì thấy được còn vỡ thì không.
        """
        return (await self.fetch_suggestions_batch([term], ctx)).get(term, [])


def _norm(text: str) -> str:
    """Khoá so sánh tiếng vọng: chữ thường, gộp khoảng trắng. Đủ cho việc so đúng-bằng."""
    return " ".join(str(text or "").lower().split())


def _with_debug(result: dict) -> str:
    """Ghép câu lỗi của extension với phần chẩn đoán, gọn đủ để đọc trên một dòng giao diện."""
    message = str(result.get("error") or "Temu không trả về gợi ý nào")
    debug = result.get("debug")
    if not isinstance(debug, dict):
        return message
    bits: list[str] = []
    # `stage` đứng đầu vì nó trả lời câu hỏi đầu tiên người đọc đặt ra: kẹt ở đâu.
    if debug.get("stage"):
        bits.append(f"kẹt ở bước: {debug['stage']}")
    if debug.get("ranTerms") is not None:
        bits.append(f"đã gõ {debug['ranTerms']}/{debug.get('terms', '?')} cụm")
    if debug.get("inputFound") is not True and debug.get("inputFound") is not None:
        bits.append(str(debug["inputFound"]))
    urls = debug.get("capUrls") or []
    if urls:
        bits.append("endpoint trang đã gọi: " + ", ".join(str(u) for u in urls[:4]))
    # MẨU PAYLOAD THẬT. Khi endpoint có trả lời mà ta bóc ra toàn chữ giao diện, câu hỏi còn
    # lại là "gợi ý thật nằm ở khoá nào" — và chỉ nhìn vào payload mới trả lời được.
    if debug.get("pickedInput"):
        bits.append(f"đã gõ vào ô: {debug['pickedInput']}")
    if debug.get("listbox") is not None:
        bits.append(f"số phần tử lớp gợi ý sau khi gõ: {debug['listbox']}")
    if debug.get("domScope"):
        bits.append(f"đọc trong khối: {debug['domScope']}")
    if debug.get("sample"):
        bits.append("mẩu payload: " + str(debug["sample"])[:1200])
    return message + (" | " + " | ".join(bits) if bits else "")


temu = Temu()
