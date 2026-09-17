"""
Từ vựng chung của MỤC QUẢNG CÁO.

Mọi nền tảng (Facebook, TikTok, và các nguồn thêm sau) đều ánh xạ dữ liệu thô của mình
về các kiểu ở đây, nhờ vậy tầng chấm điểm và giao diện không bao giờ phải rẽ nhánh theo
nguồn. Mục Từ khoá có từ vựng riêng ở `lib/keywords/types.py` và hai bên không dùng
chung kiểu nào.
"""

from __future__ import annotations

from typing import Literal

from lib.core.model import CamelModel

#: Mã quốc gia ISO-3166 alpha-2, ví dụ 'VN' | 'US' | 'PH'.
CountryCode = str

#: Id nguồn quảng cáo, do sổ đăng ký ở `lib/ads/platforms/__init__.py` quyết định.
PlatformId = str

MediaKind = Literal["video", "image", "none"]


class Creative(CamelModel):
    """Một creative xem/phát được thuộc về một quảng cáo."""

    kind: MediaKind
    #: Link CDN trực tiếp. Có chữ ký và hết hạn nhanh ở mọi nguồn — không bao giờ lưu lại.
    url: str | None = None
    poster_url: str | None = None
    width: int | None = None
    height: int | None = None
    duration_sec: float | None = None


class AdScore(CamelModel):
    """
    Kết quả chấm điểm.

    `cvr_proxy` KHÔNG phải tỷ lệ chuyển đổi. Không nền tảng nào công bố CVR — đó là dữ liệu
    riêng của advertiser. Đây là chỉ số 0-100 suy ra từ độ dài đời quảng cáo, mức độ lặp
    creative và tương tác; giao diện luôn phải ghi rõ đây là ước lượng.
    """

    total: int
    cvr_proxy: int
    content_score: int
    longevity_score: int
    #: Riêng product search (Shopee…): điểm cầu (số bán) và chất lượng (rating). `None` với
    #: quảng cáo, để giao diện hiện đúng ngữ cảnh — sản phẩm không có CVR, quảng cáo không có cầu.
    demand_score: int | None = None
    quality_score: int | None = None
    #: Lý do đọc được, hiện trên giao diện để người dùng tự kiểm chứng con số.
    reasons: list[str]
    #: Điểm dựa trên bao nhiêu dữ liệu thật so với bao nhiêu trường bị thiếu.
    confidence: Literal["high", "medium", "low"]


class Ad(CamelModel):
    """Bản ghi quảng cáo đã chuẩn hoá."""

    id: str
    platform: PlatformId
    #: Tên advertiser / brand đúng như nền tảng hiển thị.
    advertiser: str
    #: Nội dung quảng cáo chính. TikTok chỉ công bố caption.
    body: str
    title: str | None = None
    cta_text: str | None = None
    landing_url: str | None = None
    #: Link về đúng quảng cáo đó trên nền tảng gốc, để kiểm chứng bằng tay.
    permalink: str | None = None
    creatives: list[Creative] = []
    #: Unix giây. Facebook có công bố; TikTok thì không.
    started_at: int | None = None
    ended_at: int | None = None
    #: Số ngày quảng cáo đã chạy. Đây là chỉ báo gián tiếp tốt nhất cho "sản phẩm này thật sự
    #: bán được" — không ai trả tiền tiếp cho quảng cáo đang lỗ. Bỏ trống với những nền tảng
    #: không công bố ngày bắt đầu (xem `capabilities.start_date`).
    days_active: int | None = None
    is_active: bool | None = None
    #: Số biến thể creative trong cùng một nhóm. Nhiều = advertiser đang test/scale mạnh.
    variant_count: int | None = None
    #: Riêng Facebook.
    page_like_count: int | None = None
    #: Riêng TikTok: tỷ lệ click, theo Creative Center công bố.
    ctr_percent: float | None = None
    #: Riêng TikTok: lượt thích trên creative.
    like_count: int | None = None
    #: Lượt xem / bình luận / chia sẻ của một VIDEO (TikTok, YouTube). Ba trường này vốn chỉ tồn
    #: tại phía giao diện — extension nhét thẳng vào thẻ — nên nguồn nào chạy ở server (YouTube,
    #: TikTok qua Bing) không có chỗ chở chúng về, và thẻ của nó hiện trống trong khi thẻ TikTok
    #: bên cạnh có đủ số. Giao diện đã đọc đúng ba tên này rồi (`tkInfoHTML`), chỉ thiếu ở model.
    play_count: int | None = None
    comment_count: int | None = None
    share_count: int | None = None
    #: Riêng TikTok: chỉ số chi phí tương đối (không phải số tiền).
    cost_index: float | None = None
    industry: str | None = None
    objective: str | None = None
    #: Giá niêm yết. Có ở các sàn thương mại điện tử (Shopee/Amazon…), vắng ở ads-spy
    #: (Facebook/TikTok Creative Center) — nên để trống thay vì 0 khi nguồn không công bố.
    price: float | None = None
    #: Mã tiền tệ ISO-4217, ví dụ 'VND' | 'THB'. Đi kèm `price` để giao diện định dạng đúng.
    currency: str | None = None
    #: `price` chỉ là GIÁ SÀN (giá của biến thể rẻ nhất), không phải giá phải trả.
    #:
    #: Sàn nào có biến thể (size, màu, combo) thì trên thẻ tìm kiếm chúng chỉ hiện MỘT con số:
    #: cái rẻ nhất. Đo 2026-09-08 trên Etsy listing 1657090788 — API trả `price` 6,70 GBP và
    #: `has_variations: true`, còn trang bán ghi rõ "187.313₫**+**". Người bán còn cố ý gắn một
    #: biến thể rẻ tiền (dây buộc, sticker) để tụt xuống đầu bảng sắp theo giá.
    #:
    #: Cờ này KHÔNG sửa con số — nó chỉ nói rằng con số ấy là cận dưới, để giao diện ghi "từ X"
    #: thay vì để người dùng đọc thành giá bán. Sai kiểu này im lặng: bảng vẫn đẹp, cột giá vẫn
    #: có số, chỉ là số đó không mua được cái gì.
    price_is_from: bool = False
    #: Số lượng đã bán (tổng luỹ kế) nếu sàn công bố. Tín hiệu nhu cầu trực tiếp nhất cho
    #: product search — mạnh hơn cả đời quảng cáo, vì là con số bán thật chứ không phải suy luận.
    sold_count: int | None = None
    #: Số bán trong ~30 ngày gần nhất. Quan trọng hơn tổng luỹ kế để đo "đang hot bây giờ":
    #: một sản phẩm bán 700/tháng đáng research hơn cái tổng 400k nhưng nhịp gần đây đã nguội.
    monthly_sold: int | None = None
    #: LƯỢT XEM trang sản phẩm, khi sàn công bố. Chỉ số cầu duy nhất mà Etsy cho ở cấp
    #: LISTING — đo 2026-09-08 trên 120 listing: `views` có ở 57 (47%), `num_favorers` chỉ 41
    #: (34%). Không phải số bán, nên không được đặt vào `sold_count` hay `monthly_sold`.
    view_count: int | None = None
    #: `sold_count` là số của SHOP, không phải của sản phẩm này.
    #:
    #: Etsy cố tình giấu số bán theo từng listing — không có trường nào. Thứ gần nhất là
    #: `shop.transaction_sold_count` (đo: có ở 90% listing, trung vị 827 đơn), và nó nói về
    #: cả shop. Đặt con số ấy vào cột "Tổng bán" mà không nói gì thì nó nằm cạnh số bán THẬT
    #: của Shopee/Temu và bị đọc như cùng một loại.
    sold_is_shop: bool = False
    #: Điểm đánh giá trung bình (0-5) nếu sàn công bố.
    rating: float | None = None
    #: `rating` là điểm của SHOP, không phải của sản phẩm này.
    #:
    #: Etsy CÓ đường lấy rating theo listing (`listings/{id}/reviews`) — đã thử chạy được —
    #: nhưng vô dụng: một shop 24.722 đánh giá trải trên 100 listing, mỗi listing đúng MỘT
    #: review. Rating tính từ một review là con số vô nghĩa. Nên vẫn dùng điểm shop, chỉ cần
    #: nói ra đó là điểm shop. 1688 cũng vậy (dùng `tradeService` của shop).
    rating_is_shop: bool = False
    #: Số lượt đánh giá — quyết định độ tin của `rating` (rating cao mà 3 review thì chưa chắc).
    rating_count: int | None = None
    #: Tỉ lệ khách QUAY LẠI mua (回头率), theo phần trăm. Riêng 1688 — sàn sỉ nên đây là tín
    #: hiệu mạnh: người mua đi mua lại một mã hàng là người bán lẻ đang bán được, không phải
    #: khách lẻ mua thử. Không sàn nào khác công bố, nên vắng ở mọi nguồn còn lại.
    repurchase_rate: float | None = None
    #: Link "tìm sản phẩm tương tự / cùng mẫu" trên chính sàn đó, khi sàn có sẵn một đường như
    #: vậy. Không suy ra được từ `permalink`: 1688 trả `sameDesignUrl` đã kèm vân tay ảnh của
    #: chính chào hàng ấy, thứ không dựng lại được từ phía mình.
    similar_url: str | None = None
    countries: list[CountryCode] = []
    platforms: list[str] | None = None
    #: Khung nhúng của sàn có phát được video này không.
    #:
    #:   None   chưa kiểm (nguồn không có cách kiểm — xem `platforms/douyinvideo.py`)
    #:   True   đã hỏi và sàn nói còn
    #:   False  đã hỏi và sàn nói không
    #:
    #: `False` KHÔNG dùng để LOẠI thẻ. Một quảng cáo đã gỡ vẫn là dữ liệu research thật: ảnh
    #: bìa, tiêu đề, tài khoản, lượt xem đều còn nguyên và đều trả lời được câu "có ai đang
    #: bán món này không". Chỉ mục Bing giữ ảnh bìa của riêng nó nên ảnh vẫn hiện sau khi
    #: video biến mất — đo 2026-09-10 trên id `7653092931838037268`: oEmbed trả 400 còn
    #: `ts1.mm.bing.net` vẫn trả 200 image/jpeg.
    #:
    #: Việc duy nhất của cờ này là để giao diện ĐỪNG VẼ NÚT ▶ lên thẻ ấy — một nút ▶ mở ra
    #: "Video currently unavailable" tốn của người dùng một cú bấm mới biết là không có gì.
    playable: bool | None = None
    #: Do `lib/ads/scoring.py` điền vào.
    score: AdScore | None = None
    #: Độ trùng ẢNH (0-100) khi quảng cáo này được lọc qua luồng "tìm video theo ảnh sản phẩm"
    #: (`lib/ads/imagematch.py`). 100 = poster y hệt ảnh sản phẩm nguồn. Vắng ở search thường.
    match_score: int | None = None
    #: Cụm từ khoá có xuất hiện trong phần chữ ĐỌC ĐƯỢC của quảng cáo không (tiêu đề, nội dung,
    #: CTA, tên nhà quảng cáo). Do `lib/ads/relevance.py` điền vào ở `search.py`.
    #:
    #: `False` KHÔNG có nghĩa là quảng cáo rác: cụm từ có thể nằm trong ảnh, hoặc Facebook khớp
    #: nó ở trang đích mà ta không đọc được. Nó chỉ được dùng để XẾP quảng cáo ấy xuống dưới và
    #: để giao diện ghi chú — không bao giờ để loại bỏ. Xem lập luận ở `relevance.py`.
    phrase_hit: bool | None = None


class AdSearchParams(CamelModel):
    """Tham số tìm kiếm dùng chung cho mọi nền tảng."""

    keyword: str
    platforms: list[PlatformId]
    countries: list[CountryCode]
    #: Chỉ giữ quảng cáo có video phát được. Lọc sau khi lấy dữ liệu.
    video_only: bool = False
    #: Số ngày chạy tối thiểu. Loại luôn quảng cáo không có ngày bắt đầu khi > 0.
    #: Để `float` vì đây thuần tuý là một ngưỡng so sánh, và `Number()` của JS không cắt phần
    #: thập phân — `minDaysActive=30.7` phải loại quảng cáo chạy đúng 30 ngày, y như bản cũ.
    min_days_active: float = 0
    limit: int = 30
    #: Tuỳ chọn riêng của từng nền tảng, dạng thô từ query string.
    #: Ví dụ: `{'tiktok': {'period': '30'}, 'facebook': {'matchMode': 'exact'}}`.
    #: Mỗi nền tảng tự kiểm tra phần của mình — xem `AdPlatform.parse_options`.
    platform_options: dict[PlatformId, dict[str, str]] = {}
    #: True cho luồng khớp-ảnh (`/api/ads/match-image`): nguồn nới lọc từ khoá văn bản vì
    #: ẢNH (CLIP) mới là bộ lọc chính. Không đến từ query string — do route match-image tự bật.
    relax_keyword: bool = False
    #: Từ khoá RIÊNG cho một số nguồn, đè lên `keyword`. Nguồn nào không có tên ở đây thì
    #: vẫn dùng `keyword`.
    #:
    #: Sinh ra vì một cụm KHÔNG hợp với mọi nguồn. Từ tiêu đề sản phẩm, Gemini rút hai cụm:
    #: `broad` ("tai nghe bluetooth") và `specific` ("tai nghe redmi buds 6 play"). Facebook
    #: BẮT BUỘC dùng broad — đo 2026-09-08: cụm specific chỉ ra 1 quảng cáo trên toàn Ad
    #: Library, cụm broad ra 892. Nhưng các nguồn VIDEO thì ngược hẳn, và ngược rất nặng:
    #:
    #:     cụm dùng để tìm      TikTok (Bing)      YouTube
    #:     broad                 0/30 đúng SP       1/30 đúng SP
    #:     specific             28/30              25/30
    #:
    #: Ép cả hai loại dùng chung một cụm nghĩa là phải chọn: hoặc Facebook rỗng, hoặc lưới
    #: video toàn thứ không liên quan. Đây là chỗ để khỏi phải chọn.
    keyword_by_platform: dict[PlatformId, str] = {}


class PlatformStatus(CamelModel):
    platform: PlatformId
    ok: bool
    #: Số quảng cáo nguồn này trả về cho truy vấn hiện tại.
    count: int
    #: Có giá trị khi nguồn lỗi hoặc trả kết quả kém hơn yêu cầu — hiện lên giao diện thay
    #: cho một danh sách rỗng im lặng.
    message: str | None = None
    took_ms: int


# ---------------------------------------------------------------------------
# Fetch phía client (Cách A) — nguồn chạy bằng session đăng nhập của user
# ---------------------------------------------------------------------------
#
# Một số sàn (Shopee, TikTok Shop…) trả 403 cho request ẩn danh từ server, nhưng lại trả
# dữ liệu bình thường cho chính trình duyệt user đã đăng nhập. Với các nguồn này, server chỉ
# *dựng* lệnh fetch (`RequestSpec`) rồi để extension chạy bằng cookie của user; raw trả về
# (`ClientResponse`) được gửi ngược lên server để `parse_response` chuẩn hoá. Cookie KHÔNG bao
# giờ rời trình duyệt user — đây là điểm khác cốt lõi so với "gửi cookie về server".


class RequestSpec(CamelModel):
    """Một lệnh fetch để extension thực thi bằng session đăng nhập của user."""

    url: str
    method: str = "GET"
    headers: dict[str, str] = {}
    body: str | None = None
    #: Nhãn để `parse_response` ghép đúng response với spec đã gửi (ví dụ 'page-1').
    tag: str | None = None


class ClientResponse(CamelModel):
    """Kết quả của một `RequestSpec`, do extension trả về sau khi fetch."""

    tag: str | None = None
    status: int
    text: str


class ClientJob(CamelModel):
    """
    Việc server giao cho extension: chạy các spec này bằng session của user.

    Đi trong `AdSearchResult.pending`. Extension chạy xong sẽ nộp lại một `ClientSubmission`.
    """

    platform: PlatformId
    country: CountryCode
    requests: list[RequestSpec] = []


class ClientSubmission(CamelModel):
    """Extension nộp lại raw responses cho một cặp (nguồn, quốc gia)."""

    platform: PlatformId
    country: CountryCode
    responses: list[ClientResponse] = []


class AdSearchResult(CamelModel):
    ads: list[Ad]
    statuses: list[PlatformStatus]
    #: True khi kết quả lấy từ cache thay vì gọi mới.
    cached: bool
    #: Từ khoá THỰC SỰ đã dùng để search. Khi đầu vào là `title` (tiêu đề SP dài), đây là cụm
    #: Gemini rút ra — để giao diện hiện "đang tìm bằng từ khoá nào". `None` với search thường.
    keyword: str | None = None
    #: Việc cần extension chạy (Cách A). Rỗng khi mọi nguồn fetch phía server, hoặc khi nguồn
    #: client_fetch đã trúng cache và không phải gọi lại. Giao diện đọc danh sách này để biết
    #: có cần nhờ extension fetch tiếp rồi POST về `/api/ads/ingest` hay không.
    pending: list[ClientJob] = []
