"""
Từ vựng chung của MỤC TỪ KHOÁ.

Hoàn toàn tách khỏi mục Quảng cáo (`lib/ads/types.py`) — hai mục không dùng chung kiểu
dữ liệu nào, chỉ dùng chung hạ tầng ở `lib/core`.
"""

from __future__ import annotations

from dataclasses import dataclass
from typing import Literal

from pydantic import Field

from lib.core.model import CamelModel

#: Id nguồn gợi ý, do sổ đăng ký ở `lib/keywords/providers/__init__.py` quyết định.
KeywordSource = str

#: Vì sao một từ khoá đáng quan tâm với người test sản phẩm.
#:
#: Google Suggest vui vẻ trả về "quần jeans là gì" hay "quần jeans mặc với áo gì" — đó là
#: truy vấn thật, nhưng vô dụng khi chọn sản phẩm để test. Tách hai loại ra giúp từ khoá
#: mua hàng nằm trên đầu thay vì bị chôn dưới các câu hỏi tìm hiểu.
Intent = Literal["commercial", "informational"]


class SourceHit(CamelModel):
    """Một lần từ khoá xuất hiện trong danh sách của một nguồn."""

    source: KeywordSource
    #: Vị trí (từ 0) trong danh sách của nguồn đó. Càng nhỏ nghĩa là nguồn xếp càng cao.
    position: int
    #: Cụm ta đã hỏi để lộ ra nó (từ gốc, hoặc từ gốc + một hậu tố khi mở rộng).
    via_term: str
    #: Cách viết gốc của nguồn, trước khi chuẩn hoá.
    raw: str
    #: Shopee có công bố điểm liên quan; hai nguồn còn lại thì không.
    native_score: float | None = None
    #: Lượng tìm tương đối 0–100 do nguồn đo được. Hiện chỉ Google Trends có.
    demand: float | None = None
    #: Từ khoá nằm ở bảng "đang tăng" của Trends. Khi đó `demand` là phần trăm tăng, không
    #: phải khối lượng — nên hai loại không được xếp chung thang.
    rising: bool = False
    #: Cột "Thay đổi" của Trends, đi cặp với `demand`. `None` với cụm ở bảng "đang tăng".
    change_percent: float | None = None


class KeywordScore(CamelModel):
    total: int
    #: Bao nhiêu nguồn cùng công nhận *các biến thể* của từ khoá này, chứ không phải chuỗi
    #: nguyên văn của nó.
    #:
    #: Đo trực tiếp: trên ba nguồn chỉ 2/28 từ khoá trùng nhau nguyên văn, vì Shopee viết
    #: "quần jean suông ống rộng" trong khi Google viết "quần jeans ống rộng". Nếu tính trùng
    #: nguyên văn thì gần như không có gì được xếp hạng.
    agreement: int
    #: Suy từ chính thứ tự sắp xếp của mỗi nguồn.
    prominence: int
    #: Điểm liên quan Shopee công bố, khi có.
    marketplace: int
    #: Lượng tìm tương đối 0–100 đo bởi Google Trends, `None` khi Trends không nhắc tới từ này.
    #:
    #: `None` KHÔNG có nghĩa là không ai tìm — Trends chỉ trả về khoảng năm mươi truy vấn liên
    #: quan cho mỗi từ gốc, nên phần lớn long-tail nằm ngoài tầm nó. Giao diện phải nói "chưa
    #: đo" chứ không hiện số 0.
    demand: int | None = None
    #: Cột "Thay đổi" của Trends cho cụm này — đi CẶP với `demand`, và chỉ có khi `demand` có.
    #:
    #: Hai con số cùng đến từ một hàng trong bảng "Cụm từ tìm kiếm hàng đầu", và giao diện
    #: hiện chúng cạnh nhau đúng như Trends làm. Tách riêng khỏi `TrendSeries.change_percent`:
    #: cái kia do ta tự tính từ chuỗi thời gian đo được (quý cuối so quý đầu), còn cái này là
    #: con số CHÍNH GOOGLE công bố. Hai cách tính khác nhau nên không được lẫn.
    change_percent: int | None = None
    #: Hạng trung bình có trọng số trên các nguồn — thứ quyết định thứ tự hiển thị.
    #:
    #: NHỎ HƠN LÀ TỐT HƠN, khác mọi trường điểm còn lại trong model này. Cố ý dùng thứ hạng
    #: thô thay vì quy về thang 0–100: điểm gộp tạo cảm giác chính xác không có thật, còn
    #: "Google #4, Shopee #17, TikTok #1" là thứ người dùng kiểm chứng được. Nguồn nào không
    #: trả về từ khoá này thì tính bằng `RANK_CAP`. Xem `lib/keywords/rank.py`.
    mean_rank: float = 20.0
    reasons: list[str]


class KeywordCandidate(CamelModel):
    #: Dạng đã chuẩn hoá, dùng để gom nhóm và so sánh.
    keyword: str
    #: Cách viết gốc dễ đọc nhất đã gặp.
    display: str
    hits: list[SourceHit]
    #: Các nguồn khác nhau cùng trả về đúng từ khoá này.
    sources: list[KeywordSource]
    #: Những chữ thêm vào so với từ gốc — "suông", "ống rộng", "nam". Xếp hạng làm ở mức này.
    modifiers: list[str]
    intent: Intent
    #: Từ chỉ mùa cần phân tích, ví dụ "mùa hè".
    seasonal: str | None = None
    #: Thứ hạng của từ khoá này TRONG TẬP KẾT QUẢ CỦA TỪNG NGUỒN, đánh số từ 1.
    #:
    #: Không phải `SourceHit.position`. `position` là chỗ đứng trong một lần gọi gợi ý của
    #: một tiền tố cụ thể, mà mỗi lần gọi chỉ trả về khoảng mười mục còn ta hỏi tới hai mươi lăm
    #: tiền tố — nên gần như từ khoá nào cũng từng đứng thứ nhất hoặc thứ hai ở đâu đó, và
    #: cột hiển thị biến thành "#1" ở mọi dòng, không phân biệt được gì.
    #:
    #: Ở đây là thứ hạng thật: sắp toàn bộ từ khoá mà nguồn đó đóng góp theo chính bằng chứng
    #: của nguồn đó, rồi đánh số. "Google #7" nghĩa là đứng thứ bảy trong số các từ khoá
    #: Google trả về cho lần tìm này.
    source_ranks: dict[str, int] = Field(default_factory=dict)
    #: Thứ hạng ĐỂ HIỂN THỊ: đánh số lại 1..N chỉ trong những dòng thật sự hiện ra.
    #:
    #: Tách hẳn khỏi `source_ranks` vì hai con số trả lời hai câu hỏi khác nhau, và gộp chúng
    #: là mất một câu:
    #:
    #:     source_ranks    "Google xếp nó thứ 26 trong 160 cụm Google trả về"  — kiểm được
    #:     display_ranks   "trong 30 dòng bạn đang xem, đây là dòng Google ưu tiên thứ 5"
    #:
    #: Cột hiển thị dùng số thứ hai vì số thứ nhất có LỖ: thứ hạng được gán trên toàn bộ ứng
    #: viên TRƯỚC khi lọc, nên các cụm bị bước lọc câu hỏi gạt ra vẫn giữ chỗ trong dãy số và
    #: bảng đọc thành "#5, #7, #8" — trông y như công cụ đánh rơi mất một dòng.
    #:
    #: Con số kiểm chứng được KHÔNG mất đi: nó chuyển vào tooltip, cùng với mẫu số.
    display_ranks: dict[str, int] = Field(default_factory=dict)
    score: KeywordScore


#: Cửa sổ thời gian mặc định. Cùng chuỗi mà /explore dùng cho "Năm qua".
DEFAULT_TIME_RANGE = "today 12-m"

#: `country` cho phạm vi "Toàn thế giới".
#:
#: Trends thể hiện toàn cầu bằng cách BỎ HẲN tham số `geo` chứ không bằng một mã riêng. Ở đây
#: nó vẫn cần một tên: chuỗi rỗng đi qua bốn tầng thì có tầng đọc ra thành "chưa chọn", và
#: `expand_with_provider` cần một giá trị nói được rằng Shopee không phục vụ phạm vi này.
WORLDWIDE = "WORLD"


@dataclass(frozen=True)
class SearchContext:
    """
    Ba ô chọn của giao diện Google Trends: tìm Ở ĐÂU, TRONG BAO LÂU, trên KHO DỮ LIỆU NÀO.

    Gói thành một vật thay vì ba tham số rời vì chúng luôn đi cùng nhau qua bốn tầng, và vì
    chỉ hai trong ba có nghĩa với mọi nguồn: Shopee và TikTok chỉ đọc `country`, còn
    `time_range` và `gprop` là khái niệm riêng của Trends. Một vật có tài liệu nói rõ điều đó
    thì tốt hơn ba tham số mà hai cái luôn bị lờ đi ở hai nguồn trên ba.
    """

    country: str = "VN"
    #: Chuỗi cửa sổ của Trends: `now 1-H`, `now 7-d`, `today 12-m`, `all`, hoặc một khoảng
    #: tuỳ chỉnh dạng `2025-01-01 2025-12-31`.
    time_range: str = DEFAULT_TIME_RANGE
    #: Kho dữ liệu của Trends: rỗng = Tìm kiếm trên web, `images`, `news`, `froogle`
    #: (Google Mua sắm), `youtube`.
    gprop: str = ""


class KeywordSearchParams(CamelModel):
    seed: str
    country: str
    sources: list[KeywordSource]
    #: Số cụm mở rộng hỏi mỗi nguồn. Nhiều hơn = nhiều long-tail hơn, chậm hơn.
    #: Chỉ còn một mức; xem `search.py`. Giữ `Literal` để đổi lại là một dòng.
    depth: Literal["quick"]
    include_informational: bool
    limit: int
    time_range: str = DEFAULT_TIME_RANGE
    gprop: str = ""

    @property
    def context(self) -> SearchContext:
        return SearchContext(country=self.country, time_range=self.time_range, gprop=self.gprop)


class KeywordSourceStatus(CamelModel):
    source: str
    ok: bool
    count: int
    calls: int
    took_ms: int
    message: str | None = None


class KeywordResult(CamelModel):
    seed: str
    keywords: list[KeywordCandidate]
    #: Bao nhiêu ứng viên còn lại sau khi lọc, trước khi cắt theo giới hạn hiển thị.
    #: Thiếu con số này thì giao diện báo "300 từ khoá" bất kể tìm được 300 hay 500, và người
    #: dùng không có cách nào biết kết quả đã bị cắt.
    total_found: int
    #: Mỗi nguồn đóng góp bao nhiêu từ khoá — mẫu số của `KeywordCandidate.source_ranks`.
    #: Nhờ nó giao diện nói được "thứ 7 trong 160" thay vì một con số treo lơ lửng.
    source_totals: dict[str, int] = Field(default_factory=dict)
    statuses: list[KeywordSourceStatus]
    #: Lời nhắc khi chính TỪ GỐC là thứ sai, không phải nguồn nào hỏng.
    #:
    #: Tách hẳn khỏi `KeywordSourceStatus.message`: những dòng kia nói "nguồn này gặp chuyện
    #: gì", còn dòng này nói "câu hỏi bạn vừa đặt không có câu trả lời". Đo 2026-08-04, từ gốc
    #: "áo khoác" ở thị trường Philippines: Google trả về bảng rỗng — và đó là câu trả lời
    #: ĐÚNG, vì người Philippines không gõ tiếng Việt. Cùng lúc đó "jacket" ở chính thị trường
    #: ấy cho 49 cụm. Không có dòng này thì bảng rỗng đọc thành "công cụ hỏng", và người dùng
    #: đi sửa thứ không hỏng.
    seed_notice: str | None = None
    cached: bool
