"""
HỢP ĐỒNG CHUNG CHO MỘT NGUỒN TỪ KHOÁ.

Thêm một nguồn gợi ý mới (Lazada, Amazon, Coc Coc…) gồm đúng hai bước:
  1. tạo `lib/keywords/providers/<tên>.py` với một lớp kế thừa `KeywordProvider`
  2. thêm một dòng vào `lib/keywords/providers/__init__.py`

Nguồn chỉ phải làm một việc: nhận một cụm từ, trả về danh sách gợi ý. Toàn bộ phần mở
rộng long-tail, giữ nhịp gọi và xử lý lỗi từng phần nằm ở `providers/expand.py`, dùng
chung cho mọi nguồn.
"""

from __future__ import annotations

from abc import ABC, abstractmethod
from dataclasses import dataclass

from .types import SearchContext


@dataclass
class Suggestion:
    """Một gợi ý thô từ nguồn. `score` chỉ có ở nguồn nào tự công bố điểm liên quan."""

    keyword: str
    score: float | None = None
    #: Lượng tìm tương đối 0–100, chỉ có ở nguồn thật sự ĐO được nhu cầu.
    #:
    #: Khác hẳn `score`: `score` là điểm liên quan do sàn tự chấm, còn đây là khối lượng tìm
    #: kiếm. Phân biệt hai thứ là quan trọng, vì chỉ cái sau mới trả lời được câu "có ai tìm
    #: từ này không" — câu mà thứ tự gợi ý của autocomplete hoàn toàn không trả lời được.
    demand: float | None = None
    #: Từ khoá đang tăng nhanh. Đi kèm `demand` là phần trăm tăng chứ không phải khối lượng,
    #: nên hai loại này không bao giờ được xếp chung một thang.
    rising: bool = False
    #: Phần trăm thay đổi so với kỳ trước, cho cụm ở bảng "truy vấn hàng đầu".
    #:
    #: Đây là cột "Thay đổi" của chính giao diện Trends, đi CẶP với `demand`: `demand` nói
    #: cụm này to tới đâu so với cụm to nhất, còn nó nói cụm này đang lên hay xuống. Google
    #: hiện hai con số cạnh nhau vì một mình con nào cũng không đủ — một cụm 100/100 đang
    #: giảm 30% và một cụm 40/100 đang tăng 30% là hai cơ hội rất khác nhau.
    #:
    #: `None` với các cụm ở bảng "đang tăng": ở đó `demand` đã LÀ phần trăm tăng rồi.
    change_percent: float | None = None


class KeywordProvider(ABC):
    #: Định danh dùng trong query string và cache key. Không đổi sau khi đã dùng.
    id: str
    #: Tên hiển thị trên giao diện.
    label: str
    #: Nguồn có công bố điểm liên quan của riêng nó không.
    #: Shopee và TikTok có, và điểm đó tham gia vào công thức xếp hạng.
    has_native_score: bool = False
    #: Câu giải thích điểm gốc, hiện trong phần lý do xếp hạng.
    #:
    #: Nằm trên provider chứ không nằm ở `rank.py` vì mỗi nguồn ĐO một thứ khác nhau: 0.52 của
    #: Shopee là điểm liên quan do mô hình của sàn chấm, còn 8 của TikTok là số kênh đã gọi cụm
    #: đó ra. Viết cứng một câu chung ở nơi xếp hạng sẽ mô tả sai một trong hai — và đã sai
    #: thật: câu cũ viết thẳng chữ "Shopee", nên nguồn thứ hai vừa có điểm gốc là lời giải
    #: thích lập tức nói tên nhầm nguồn.
    #:
    #: Nhận `{label}` (tên nguồn) và `{value}` (điểm đã định dạng).
    native_score_note: str = "{label} chấm điểm liên quan {value}"
    #: Nguồn chấm chính — nguồn ĐO được nhu cầu thật, không chỉ gợi ý.
    #:
    #: Đúng một nguồn được đặt cờ này, và nó quyết định hai thứ: rổ ứng viên của bảng xếp hạng
    #: (xem `_primary_pool` ở `lib/keywords/rank.py`) và nguồn được tick sẵn khi mở trang. Đặt
    #: thành cờ trên provider thay vì viết thẳng chuỗi "trends" ở nhiều nơi, để chỉ có một chỗ
    #: duy nhất nói ra điều đó.
    is_primary: bool = False
    #: Các thị trường nguồn này phục vụ. `None` nghĩa là mọi thị trường.
    #: Ví dụ Shopee chạy một tên miền riêng cho mỗi nước và không có mặt ở US.
    markets: list[str] | None = None
    #: Chọn thị trường có thật sự đổi được KẾT QUẢ nguồn này trả về không.
    #:
    #: Khác `markets`, và hai cái không suy ra được nhau. `markets` nói nguồn có PHỤC VỤ nước
    #: đó không; cờ này nói đổi nước thì kết quả có khác đi không.
    #:
    #: TikTok là nguồn duy nhất đặt `False`, và lịch sử của nó giải thích vì sao cần hai cờ
    #: riêng. Endpoint preview không nhận tham số vùng nào — nó trả gợi ý theo IP máy chủ. Ban
    #: đầu nguồn này để `markets = None` và chỉ dựa vào cờ này để giao diện ghi chú; đo
    #: 2026-08-06 cho thấy như vậy là chưa đủ, vì một ghi chú không ngăn được người dùng chọn
    #: Đài Loan rồi nhận về gợi ý tiếng Nhật. Nay `markets` bị thu về đúng thị trường máy chủ
    #: đi ra, còn cờ này ở lại để mô tả đúng bản chất endpoint.
    #:
    #: Lưu ý ô Quốc gia trên giao diện vẫn có tác dụng với nguồn `False`: `expand_with_provider`
    #: dùng `ctx.country` để chọn ngôn ngữ của các tiền tố mở rộng. Nên cờ này để giao diện
    #: GIẢI THÍCH cho đúng, không phải để ẩn ô chọn đi.
    geo_targeted: bool = True
    #: Nguồn này LUÔN được hỏi bằng ngôn ngữ của thị trường nào, bất kể người dùng chọn nước gì.
    #:
    #: `None` (mặc định) nghĩa là hỏi bằng ngôn ngữ của ô Quốc gia — đúng cho mọi sàn có tên
    #: miền riêng từng nước: chọn Việt Nam thì hỏi shopee.vn bằng tiếng Việt.
    #:
    #: Temu thì khác về bản chất chứ không phải khác về cấu hình: nó bán xuyên biên giới qua
    #: MỘT tên miền và ô gợi ý của nó phục vụ bằng tiếng Anh. Hỏi nó bằng tiếng Việt không trả
    #: về bảng rỗng — nó trả về CHÍNH CỤM TA VỪA GÕ, nên bảng trông như có dữ liệu trong khi
    #: không có gì cả (đo 2026-09-05: 13 "từ khoá" thì cả 13 là chuỗi do ta bịa ra để dò).
    #:
    #: Khai ở đây chứ không viết cứng trong `providers/temu.py`, vì nó đổi hành vi của bộ mở
    #: rộng — cả từ gốc lẫn danh sách hậu tố/tiền tố đều phải theo ngôn ngữ này. Xem
    #: `expand_with_provider`.
    query_market: str | None = None

    def query_market_for(self, country: str) -> str | None:
        """
        Ngôn ngữ (theo mã thị trường) để hỏi nguồn này KHI người dùng chọn `country`.

        Mặc định là `query_market` cố định. Nguồn nào nói được nhiều thứ tiếng tuỳ nước thì đè
        hàm này — xem `providers/temu.py`. `None` = hỏi bằng ngôn ngữ của chính ô Quốc gia.
        """
        return self.query_market

    #: Khoảng cách tối thiểu giữa hai lượt gọi của RIÊNG nguồn này, tính bằng mili giây.
    #:
    #: `None` nghĩa là dùng `CALL_DELAY_MS` chung. Nằm trên provider vì sức chịu đựng là thuộc
    #: tính của từng nền tảng chứ không phải của bộ mở rộng: Shopee, TikTok và Amazon đều chạy
    #: tốt ở 700ms, nhưng Taobao đo thấy `ConnectTimeout` ở nhịp đó và chỉ ổn định từ 1200ms.
    #:
    #: Nâng hằng số chung lên 1200 cho cả bốn sẽ khiến ba nguồn kia chậm thêm gần nửa phút mỗi
    #: lượt "Thường" mà không đổi lại được gì.
    call_delay_ms: int | None = None
    #: Nguồn này có chịu được kiểu hỏi lặp "từ gốc + hậu tố" không.
    #:
    #: Các API gợi ý thì có — chúng hoàn thiện tiền tố, nên phải gieo nhiều tiền tố mới lộ
    #: ra long-tail. Google Trends thì không: một lời gọi đã trả về trọn bảng truy vấn liên
    #: quan, nên hỏi lại 19 lần chỉ tổ nhận đúng một kết quả đó 19 lần và lĩnh thêm 429.
    expands_terms: bool = True
    #: Trần số cụm nguồn này được hỏi trong một lượt, bất kể người dùng chọn mức nào.
    #:
    #: `None` là không có trần — đúng cho mọi nguồn gọi HTTP thẳng, nơi một lượt gọi tốn vài
    #: trăm mili-giây. Trần sinh ra cho nguồn đi qua máy-thợ: ở đó một lượt gọi là một lần gõ
    #: vào trang thật và worker xử lý tuần tự. Xem
    #: `providers/temu.py`.
    max_terms: int | None = None
    #: Nguồn muốn nhận CẢ DANH SÁCH cụm trong một lời gọi thay vì từng cụm một.
    #:
    #: Bật cờ này thì `expand_with_provider` gọi `fetch_suggestions_batch` đúng một lần và
    #: KHÔNG gọi `fetch_suggestions` nữa. Dành cho nguồn mà chi phí nằm ở việc DỰNG ngữ cảnh
    #: chứ không ở từng câu hỏi: mở một tab Temu tốn 18 giây, gõ thêm một cụm vào tab đã mở
    #: tốn 1 giây — hỏi 12 lần riêng lẻ là trả tiền mở tab 12 lần.
    batches_terms: bool = False

    async def fetch_suggestions_batch(
        self, terms: list[str], ctx: SearchContext
    ) -> dict[str, list[Suggestion]]:
        """
        Lấy gợi ý cho NHIỀU cụm trong một lời gọi. Chỉ nguồn đặt `batches_terms` mới phải cài.

        Trả về map `cụm gốc -> gợi ý`. Cụm nào nguồn không trả gì thì cứ thiếu khỏi map —
        thiếu một phần vẫn dùng được, và đó cũng là cách `fetch_suggestions` xử lý.
        """
        raise NotImplementedError(
            f"{type(self).__name__} đặt batches_terms nhưng chưa cài fetch_suggestions_batch"
        )

    @abstractmethod
    async def fetch_suggestions(self, term: str, ctx: SearchContext) -> list[Suggestion]:
        """
        Lấy gợi ý cho đúng một cụm từ. Ném lỗi nếu nguồn từ chối.

        `ctx` chở cả ba ô chọn của người dùng, nhưng phần lớn nguồn chỉ cần `ctx.country`:
        `time_range` và `gprop` là khái niệm của riêng Google Trends. Lờ chúng đi là đúng, và
        không có gì phải xin lỗi vì điều đó.
        """
