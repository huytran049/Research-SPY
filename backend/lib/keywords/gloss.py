"""
Dịch ngược danh sách từ khoá về tiếng Việt, để ĐỌC.

Tầng này giải quyết đúng một vấn đề: sau khi mở rộng ở thị trường Philippines hay Mỹ, người
dùng nhận về hai, ba trăm cụm mà họ không đọc được. Có lượng tìm, có thứ hạng, có đủ bằng
chứng — và vẫn không quyết được gì, vì không phân biệt nổi cụm nào là người đang mua, cụm
nào là người tò mò, cụm nào là tên một thương hiệu bản địa.

NGUYÊN TẮC CỨNG, và nó định hình mọi thứ bên dưới: **bản dịch chỉ để hiển thị, không bao giờ
để đi tìm và không bao giờ để chấm điểm.** Không có gì ở file này chạm vào `rank.py`. Một
bản dịch sai chỉ làm người đọc hiểu nhầm một dòng, rồi họ nhìn sang thanh lượng tìm ngay bên
cạnh và tự sửa; còn nếu để nó đổi thứ hạng hay sinh ra truy vấn mới thì cái sai lan ra cả
bảng và không còn dấu vết nào để lần ngược.

Cũng vì vậy `label` ở đây KHÔNG thay `KeywordCandidate.intent`. Hai thứ trả lời cùng một câu
hỏi bằng hai loại bằng chứng khác hẳn nhau — một bên là bảng dấu hiệu đếm được ở
`normalize.py`, một bên là phán đoán của mô hình — nên chúng được để cạnh nhau cho người dùng
so, chứ không cái nào ghi đè cái nào.

Chạy thành lượt riêng sau khi bảng đã hiện, đúng lý do Google Trends được tách khỏi
`/api/keywords`: nguồn ngoài hỏng thì phần đã lấy được vẫn phải dùng được.

MỘT MÔ HÌNH DỰ PHÒNG (GLM-4.7-Flash của z.ai) ĐÃ ĐƯỢC DỰNG XONG RỒI GỠ ĐI, ngày 2026-08-12.
Ghi lại để không ai dựng lại rồi phát hiện cùng những điều đó lần nữa.

Nó được thử vì hai lý do đúng: miễn phí không giới hạn ngày (hạn mức Gemini là ~1000 lượt/ngày
dùng chung trong ứng dụng), và là mô hình Trung Quốc bản địa nên có thể dịch tiếng Trung sát hơn.
Đo trên cùng 24 từ khoá và cùng prompt thì cả hai lý do đều không đứng vững:

    nhãn          23,5/24 trung bình, so với 24/24 của Gemini
    độ trễ        ~10s sau khi TẮT chế độ suy nghĩ (mặc định nó bật, và khi bật là 46,8s)
    độ tin cậy    5/6 lượt thành công; bậc miễn phí trả 429 "overloaded" và rớt thẳng kết nối
    ĐỘ SÁT NGHĨA  THUA RÕ, và đây mới là điều quyết định

Chỗ thua nằm ở kiểu sai chứ không ở số lượng sai: GLM lấp chỗ trống bằng chi tiết TỰ NGHĨ RA.
`小香风` thành "đính đá" (thật ra là tweed kiểu Chanel), `茶歇` thành "dáng suông" (thật ra
chiết eo), `盐系` thành "dễ thương" (sai NGƯỢC — 盐系 là nhạt và tối giản, 糖系 mới là ngọt).
Với một cột mà người đọc không biết tiếng Trung để kiểm chứng, bịa trôi chảy nguy hiểm hơn dịch
cụt: không có cách nào phân biệt.

BÀI HỌC THẬT của lần thử đó không phải "GLM kém" mà là: chất lượng dịch ở đây do PROMPT quyết
định, không do mô hình. Nâng Gemini lên `gemini-3.6-flash` cũng sai đúng những cụm ấy mà chậm
gấp năm. Cả ba nhóm lỗi — tên chợ đầu mối, tiếng lóng phong cách, tiếng lóng nghề buôn — biến
mất khi đưa chính câu trả lời vào `MARKET_JARGON`, và biến mất một cách CHẮC CHẮN vì không còn
để mô hình đoán nữa. Xem ghi chú ở bảng đó.
"""

from __future__ import annotations

import json
import time
from dataclasses import dataclass, field
from typing import Any, Literal

import httpx

from lib.core.config import env_string
from lib.core.http import post_json
from lib.core.model import CamelModel

from .market import language_chain, language_for

#: Khoá API Gemini. Đọc từ biến môi trường, không bao giờ viết trong mã nguồn.
#:
#: Đặt trong `backend/.env.local` (file này đã nằm trong `.gitignore`):
#:
#:     GEMINI_API_KEY=...
#:
#: Thiếu khoá KHÔNG phải lỗi — cả tầng này lặng lẽ tắt và bảng từ khoá vẫn chạy nguyên vẹn,
#: chỉ là không có cột nghĩa. Xem `gloss_keywords`.
GEMINI_API_KEY = env_string("GEMINI_API_KEY")

#: Model dùng để dịch. Một biến để đổi khi Google đổi tên hoặc khi cần model mạnh hơn.
#:
#: Flash-lite là lựa chọn đúng cho việc này: dịch ba mươi cụm ngắn có sẵn ngữ cảnh là bài
#: dễ nhất trong các bài dịch, và nó rẻ hơn một bậc so với bản Flash đầy đủ trong khi lượt
#: gọi này chạy MỖI LẦN người dùng bấm tìm.
GEMINI_MODEL = env_string("GEMINI_MODEL", "gemini-3.5-flash-lite")

GEMINI_ENDPOINT = "https://generativelanguage.googleapis.com/v1beta/models/{model}:generateContent"

#: Thời gian chờ MỖI LẦN gọi, và số lần thử.
#:
#: Độ trễ của Gemini dao động rất mạnh với cùng một payload — đo 2026-08-04 trên đúng prompt
#: bắc cầu: 9,4s · 16,4s · 39,8s · quá 60s. Không phải do "suy nghĩ" (`thoughtsTokenCount`
#: rỗng) và không phải do prompt dài (222 token vào, 124 token ra); chỉ là phía Google.
#:
#: Nên đợi lâu hơn KHÔNG phải cách sửa: một lượt chờ 120 giây vẫn có thể trượt, và trong lúc
#: đó người dùng ngồi nhìn màn hình. Thử lại thì rẻ hơn nhiều — lần hai thường về trong vài
#: giây, vì độ trễ là chuyện của từng lượt gọi chứ không phải trạng thái kéo dài.
GEMINI_TIMEOUT_MS = 30_000
GEMINI_ATTEMPTS = 2


def _explain(error: RuntimeError) -> str:
    """
    Đổi lỗi HTTP của Gemini thành câu người vận hành làm được gì đó.

    `post_json` ném ra `HTTP 400: {"error":{"code":400,"message":"API key not valid…` — đúng
    thông tin nhưng sai dạng: nó hiện nguyên khối JSON giữa giao diện tiếng Việt, và người đọc
    không rút ra được việc cần làm.

    Câu quan trọng nhất là câu về khoá, vì nó có một cái bẫy: `GEMINI_API_KEY` được đọc MỘT
    LẦN lúc khởi động backend, nên sửa `.env.local` mà không restart thì tiến trình vẫn dùng
    khoá cũ — và triệu chứng là lỗi 400 lặp lại y hệt sau khi "đã đổi khoá rồi".
    """
    text = str(error)
    if "API key not valid" in text or "API_KEY_INVALID" in text:
        return (
            "Khoá GEMINI_API_KEY không hợp lệ. Kiểm tra lại trong backend/.env.local rồi "
            "KHỞI ĐỘNG LẠI backend — khoá chỉ được đọc lúc khởi động, nên sửa file mà không "
            "restart thì vẫn chạy bằng khoá cũ."
        )
    if "HTTP 429" in text or "RESOURCE_EXHAUSTED" in text:
        return "Gemini đang giới hạn tần suất (429) — nghỉ một lát rồi thử lại."
    if "HTTP 404" in text or "NOT_FOUND" in text:
        return f'Không tìm thấy model "{GEMINI_MODEL}" — kiểm tra GEMINI_MODEL trong .env.local.'
    if "PERMISSION_DENIED" in text or "HTTP 403" in text:
        return "Khoá Gemini không có quyền gọi model này — tạo khoá mới ở aistudio.google.com."
    return text


async def call_gemini(payload: dict) -> Any:
    """
    Gọi Gemini, thử lại một lần khi hết giờ.

    CHỈ thử lại khi hết giờ. Khoá sai, model sai hay payload sai đều trả lỗi ngay và lặp lại
    chúng chỉ tốn gấp đôi thời gian để nhận cùng một câu trả lời — tệ hơn nữa là đốt gấp đôi
    hạn mức khi nguyên nhân đúng là hạn mức.
    """
    for attempt in range(1, GEMINI_ATTEMPTS + 1):
        try:
            return await post_json(
                GEMINI_ENDPOINT.format(model=GEMINI_MODEL),
                payload,
                headers={"x-goog-api-key": GEMINI_API_KEY},
                timeout_ms=GEMINI_TIMEOUT_MS,
            )
        except httpx.TimeoutException:
            if attempt == GEMINI_ATTEMPTS:
                raise RuntimeError(
                    f"Gemini không trả lời trong {GEMINI_TIMEOUT_MS // 1000}s sau "
                    f"{GEMINI_ATTEMPTS} lần thử — thử lại sau ít phút."
                ) from None
        except RuntimeError as error:
            raise RuntimeError(_explain(error)) from None
    raise RuntimeError("không tới được")  # không xảy ra; giữ cho kiểu trả về kín


#: Số từ khoá mỗi lượt gọi.
#:
#: Cả bảng vào chung một lượt là điểm mấu chốt về chi phí: ba mươi lượt gọi một cụm sẽ trả
#: tiền cho phần hướng dẫn ba mươi lần, trong khi phần hướng dẫn dài hơn hẳn dữ liệu. Trần
#: 60 chỉ để chặn trường hợp người dùng nâng `limit` lên 300.
BATCH_SIZE = 60

#: Bản dịch không cũ đi. Cache lâu để lần tìm lại cùng thị trường là tức thì và không tốn token.
GLOSS_TTL_MS = 24 * 60 * 60 * 1000

#: Vì sao một từ khoá đáng quan tâm, theo cách đọc của mô hình.
#:
#: Bốn nhãn chứ không phải hai như `Intent`, vì hai loại nhiễu chỉ lộ ra khi đọc được ngôn
#: ngữ bản địa: `brand` (tên shop hay thương hiệu địa phương — cụm có lượng tìm thật nhưng
#: không phải cơ hội cho người mới) và `off_topic` (mở rộng theo tiền tố trôi sang ngành hàng
#: khác, thứ mà `is_on_topic` bắt được ở tiếng Việt nhưng bỏ lọt ở tiếng khác).
GlossLabel = Literal["buy", "research", "brand", "off_topic"]


class KeywordGloss(CamelModel):
    """Nghĩa tiếng Việt của một từ khoá nước ngoài."""

    keyword: str
    #: Nghĩa tiếng Việt, ngắn. Rỗng khi mô hình không chắc — giao diện phải để trống chỗ đó
    #: chứ không hiện một phỏng đoán, vì người dùng không có cách nào kiểm chứng nó.
    meaning: str
    label: GlossLabel


@dataclass
class GlossOutcome:
    entries: dict[str, KeywordGloss] = field(default_factory=dict)
    #: Câu nói cho người dùng khi không dịch được. Không phải lỗi hệ thống.
    message: str | None = None
    took_ms: int = 0


_SCHEMA = {
    "type": "object",
    "properties": {
        "entries": {
            "type": "array",
            "items": {
                "type": "object",
                "properties": {
                    "keyword": {"type": "string"},
                    "meaning": {"type": "string"},
                    "label": {"type": "string", "enum": ["buy", "research", "brand", "off_topic"]},
                },
                "required": ["keyword", "meaning", "label"],
            },
        }
    },
    "required": ["entries"],
}


#: Tiếng lóng ngành và TÊN CHỢ ĐẦU MỐI của từng thị trường, ghép thêm vào prompt.
#:
#: Đây là bản vá cho loại lỗi DUY NHẤT còn lại sau khi đo, và nó không sửa được bằng cách đổi
#: model. Đo 2026-08-12 trên 16 từ khoá tiếng Trung lấy từ Taobao/1688/Douyin:
#:
#:     从 model yếu lên model mạnh   `gemini-3.6-flash` vẫn dịch sai đúng những cụm đó, mà mất
#:                                   16,3s thay vì 3,5s và tiêu 1443 token "suy nghĩ" — trên một
#:                                   lượt gọi chạy MỖI LẦN người dùng bấm tìm
#:     thêm từ điển vào prompt       sửa được ngay, KHÔNG chậm thêm (2,5s so với 2,7s), tốn thêm
#:                                   khoảng 340 token vào
#:
#: Bốn cụm sửa được nhờ khối này: 十三行 ("chợ Thập Hàng" → "chợ Thập Tam Hàng"), 四季青
#: ("chợ Tứ Quý" → "chợ Tứ Quý Thanh"), 尾货 ("hàng tồn kho giá rẻ" → "hàng tồn kho thanh lý"),
#: 一件代发 ("sỉ đầm dropshipping một cái" → "dropship bán sỉ").
#:
#: Lý do gốc rễ: tên chợ đầu mối là DANH TỪ RIÊNG. Mô hình nào cũng đoán chúng bằng cách ghép
#: âm Hán-Việt từng chữ, và với tên ba chữ trở lên thì kiểu đoán ấy rụng mất chữ. Cấp thẳng
#: cái tên đúng là cách duy nhất chắc chắn, và nó rẻ hơn mọi cách khác.
#:
#: NHÓM TỪ LÓNG PHONG CÁCH (盐系, 茶歇, 小香风, 老钱风…) vào bảng sau, 2026-08-12, vì cùng một
#: lý do nhưng lộ ra chậm hơn — chúng dịch ra vẫn TRÔI CHẢY nên không ai nhận ra là sai. Đo
#: trên 20 cụm khó:
#:
#:     盐系    "mộc mạc, dễ thương"      sai NGƯỢC — 盐系 là nhạt/tối giản, 糖系 mới là ngọt
#:     茶歇    "dáng suông"              sai — váy tiệc trà CHIẾT EO, không suông
#:     小香风  "cao cấp, đính đá"        bịa — nó là tweed kiểu Chanel
#:     压箱底  "ít người mua, giá rẻ"    bịa nghĩa xấu — nó là món cất kỹ lâu năm
#:
#: NỚI GIỚI HẠN ĐỘ DÀI KHÔNG PHẢI CÁCH SỬA, đã thử: cho phép 14 chữ giúp 12/20 dòng nhưng làm
#: HỎNG "小香风" — mô hình dùng chỗ trống để viết "phong cách tiểu thư sang chảnh" và đánh rơi
#: mất chữ "Chanel", tức là đổi một từ chính xác lấy một câu nghe hay. Chữ nhiều hơn không phải
#: nghĩa sát hơn; biết trước câu trả lời mới là.
#:
#: CHỈ CÓ `zh-Hans`, vì chỉ thị trường đó được đo. Các thị trường khác cũng gần như chắc chắn
#: có tiếng lóng riêng ("ukay" ở Philippines, "华强北" chỉ là một ví dụ trong hàng chục), nhưng
#: viết bảng cho chúng mà không đo là đoán — và một bản dịch sai do ta gieo vào prompt còn tệ
#: hơn một bản dịch sai do mô hình tự nghĩ ra, vì nó sai NHẤT QUÁN nên không ai nhận ra.
MARKET_JARGON: dict[str, str] = {
    "zh-Hans": (
        "BỐI CẢNH: các từ khoá này lấy từ ô tìm kiếm của Taobao, 1688 và Douyin — tức là chữ "
        "của người MUA SỈ và người BÁN HÀNG Trung Quốc, không phải văn viết. Nhiều cụm là tiếng "
        "lóng ngành hoặc TÊN CHỢ ĐẦU MỐI. Với tên riêng: giữ đúng tên rồi chú thích ngắn nó là "
        "gì; không phiên âm thành một cái tên nghe như địa danh Việt Nam.\n"
        "Một số cụm hay gặp (để hiểu, không phải danh sách đầy đủ):\n"
        "- 一件代发 = dropship (bán không cần ôm hàng) | 拿货 / 一手货源 = lấy sỉ tận gốc\n"
        "- 尾货 = hàng tồn kho thanh lý | 贴牌 / OEM = gia công gắn nhãn riêng\n"
        "- 厂家直供 / 工厂直供 = xưởng bán thẳng | 微商代理 = đại lý bán qua WeChat\n"
        "- 南油 = chợ sỉ quần áo Nam Du (Thâm Quyến) | 十三行 = chợ sỉ Thập Tam Hàng (Quảng Châu)\n"
        "- 四季青 = chợ sỉ Tứ Quý Thanh (Hàng Châu) | 华强北 = chợ điện tử Hoa Cường Bắc (Thâm Quyến)\n"
        "- 显瘦 = tôn dáng gầy | 微胖 = hơi mũm mĩm | 大码 = ngoại cỡ | 爆款 = mẫu bán chạy\n"
        "- 走量 = bán số lượng lớn lãi mỏng | 爆单 = đơn về dồn dập | 断码 = vỡ size, chỉ còn size lẻ\n"
        "- 压箱底 = món cất kỹ lâu năm | 上身效果 = lên người trông thế nào | 买家秀 = ảnh khách thật chụp\n"
        "- 纯欲 = ngây thơ pha gợi cảm | 赫本风 = phong cách Audrey Hepburn | 苎麻 = vải gai (ramie)\n"
        "- 盐系 = mộc, nhạt, tối giản (NGƯỢC với 糖系 ngọt ngào) | 辣妹 = gợi cảm cá tính\n"
        "- 老钱风 = old money, sang kín đáo | 小香风 = tweed kiểu Chanel | 茶歇 = váy tiệc trà, "
        "hoa nhí cổ V chiết eo | 白月光 = trắng tinh khôi, trong trẻo\n"
        "- 妈生感 = đẹp tự nhiên như bẩm sinh | 氛围感 = có thần thái | 显白 = tôn da sáng\n"
        "- 遮肉 = che khuyết điểm | 梨形身材 = dáng quả lê (mông to eo thon)\n"
        "Từ để hỏi của tiếng Trung, dùng để nhận ra nhãn research: 怎么 / 什么 / 吗 / 好不好 / "
        "测评 / 推荐哪个."
    ),
}


#: Cách phân biệt bốn nhãn, viết dài hơn hẳn một dòng — và đó là chỗ đáng viết dài nhất.
#:
#: Đo 2026-08-12 trên 24 từ khoá tiếng Trung: định nghĩa cũ (mỗi nhãn một mệnh đề trong ngoặc)
#: cho 20/24, khối này cho 24/24 — và NHANH HƠN (3,4s so với 4,2s), vì mô hình không còn phải
#: cân nhắc những ca mập mờ.
#:
#: Cả bốn lỗi của bản cũ đều cùng một kiểu: `research` bị hiểu thành "cụm mà TÔI phải nghĩ mới
#: hiểu". Nên "连衣裙贴牌" (váy gia công nhãn riêng) và "连衣裙一件代发" (váy bán dropship) — hai
#: truy vấn của người đang đi nhập hàng, tức là đang định mua — bị gán `research` chỉ vì chúng
#: là tiếng lóng ngành. Phép thử "gõ cụm này ra một trang đầy sản phẩm hay ra một trang bài
#: viết" chữa đúng chỗ đó, vì nó hỏi về KẾT QUẢ chứ không hỏi về độ khó hiểu của chữ.
#:
#: Nằm ở đây, dùng chung cho MỌI thị trường: cách phân biệt bốn nhãn không phụ thuộc ngôn ngữ.
#: Riêng danh sách từ để hỏi thì có — nó nằm trong `MARKET_JARGON` của từng thị trường.
LABEL_RULES = (
    "QUY TẮC GÁN NHÃN (đọc kỹ, đây là chỗ hay sai nhất):\n"
    "- buy: từ khoá MÔ TẢ MỘT MÓN HÀNG. Tính cả mô tả kiểu dáng, chất liệu, đối tượng dùng, "
    "phong cách, giá, nguồn hàng, cách lấy sỉ. Phép thử: gõ cụm này ra một trang đầy SẢN PHẨM "
    "thì là buy — kể cả khi cụm đó là tiếng lóng ngành và nghe khó hiểu.\n"
    "- research: từ khoá là CÂU HỎI, hoặc đòi một lời khuyên, so sánh, hướng dẫn, đánh giá. "
    "Phép thử: gõ ra một trang đầy BÀI VIẾT hay VIDEO giải thích. Không có dấu hiệu hỏi thì "
    "KHÔNG phải research.\n"
    "- brand: có tên một thương hiệu, một shop hoặc một sàn cụ thể.\n"
    "- off_topic: không thuộc ngành hàng đang nghiên cứu."
)


def _jargon_for(country: str) -> str:
    """Khối tiếng lóng của thị trường, hoặc chuỗi rỗng. Đi theo chuỗi ngôn ngữ như mọi bảng khác."""
    for language in language_chain(country):
        block = MARKET_JARGON.get(language)
        if block:
            return f"\n\n{block}"
    return ""


def _prompt(keywords: list[str], seed: str, country: str) -> str:
    """
    Ba ràng buộc trong này đều đến từ cách bảng được đọc, không phải từ sở thích văn phong.

    Trả lại NGUYÊN VĂN `keyword`: kết quả được ghép về đúng dòng bằng chuỗi này, nên mô hình
    "sửa" chính tả một cụm là dòng đó mất nghĩa. Giới hạn độ dài: chỗ hiển thị là một dòng
    phụ dưới từ khoá, câu dài sẽ đẩy vỡ bảng. Và cho phép để trống: một phỏng đoán về tiếng
    Tagalog trông y hệt một bản dịch chắc chắn, mà người đọc thì không có cách nào phân biệt.

    Khối tiếng lóng của thị trường đứng CUỐI, sau danh sách từ khoá — xem `MARKET_JARGON`.
    """
    listing = "\n".join(f"- {k}" for k in keywords)
    return (
        f"Bạn giúp một người Việt bán hàng đọc danh sách từ khoá tìm kiếm thu được ở thị "
        f"trường {country}. Họ không đọc được ngôn ngữ của thị trường này.\n\n"
        f'Ngành hàng đang nghiên cứu: "{seed}"\n\n'
        f"Với MỖI từ khoá dưới đây, trả về:\n"
        f"- keyword: chép lại NGUYÊN VĂN, không sửa chính tả, không đổi thứ tự chữ\n"
        f"- meaning: nghĩa tiếng Việt, tối đa 8 chữ, dịch theo cách người mua hàng hiểu "
        f"(không dịch từ điển máy móc). Để CHUỖI RỖNG nếu bạn không chắc.\n"
        f"- label: buy | research | brand | off_topic\n\n"
        f"{LABEL_RULES}\n\n"
        f"Danh sách:\n{listing}"
        f"{_jargon_for(country)}"
    )


async def _call_gemini(keywords: list[str], seed: str, country: str) -> list[KeywordGloss]:
    payload = {
        "contents": [{"parts": [{"text": _prompt(keywords, seed, country)}]}],
        "generationConfig": {
            "responseMimeType": "application/json",
            "responseSchema": _SCHEMA,
            # Dịch là việc cần lặp lại được: cùng một từ khoá phải cho cùng một nghĩa ở
            # lượt tìm sau, nếu không người dùng sẽ thấy bảng "đổi ý" giữa hai lần chạy
            # giống hệt nhau và mất tin vào cả cột.
            "temperature": 0,
        },
    }
    data = await call_gemini(payload)

    try:
        text = data["candidates"][0]["content"]["parts"][0]["text"]
    except (KeyError, IndexError, TypeError) as error:
        # Gemini chặn phản hồi thì trả về `candidates` rỗng kèm `promptFeedback`, chứ không
        # trả lỗi HTTP — nên phải nói ra, không thì nó đọc thành "dịch xong, không có gì".
        raise RuntimeError(f"Gemini trả về phản hồi không đọc được ({error})") from error

    parsed = json.loads(text)
    return [KeywordGloss(**entry) for entry in parsed.get("entries", [])]




async def gloss_keywords(keywords: list[str], seed: str, country: str) -> GlossOutcome:
    """
    Dịch một danh sách từ khoá về tiếng Việt.

    Không dịch gì với thị trường nói tiếng Việt: dịch tiếng Việt sang tiếng Việt vừa tốn
    token vừa cho ra một cột lặp lại đúng chữ ở cột bên cạnh. Bảng ngôn ngữ nằm ở
    `lib/keywords/market.py` và là nguồn sự thật duy nhất, nên giao diện KHÔNG tự đoán
    thị trường nào cần dịch — nó cứ hỏi, và câu trả lời rỗng ở đây là câu trả lời đúng.

    Không có khoá API cũng không phải lỗi. Cả tính năng này là phần thêm vào: bảng từ khoá
    đã đầy đủ bằng chứng trước khi có nó, và một thông báo nói rõ cần đặt biến nào thì hữu
    ích hơn một lỗi 500.
    """
    started_at = time.monotonic()

    if language_for(country) == "vi":
        # Im lặng, KHÔNG kèm câu giải thích. Thị trường Việt Nam là trường hợp thường gặp
        # nhất, và ở đó việc không dịch là điều hiển nhiên — nói ra chỉ là một dòng chữ thừa
        # nằm dưới mọi bảng, mỗi lượt tìm.
        return GlossOutcome()
    if not GEMINI_API_KEY:
        return GlossOutcome(message="Chưa cấu hình GEMINI_API_KEY nên chưa dịch được nghĩa")

    unique = list(dict.fromkeys(k for k in (k.strip() for k in keywords) if k))[:BATCH_SIZE]
    if not unique:
        return GlossOutcome()

    try:
        entries = await _call_gemini(unique, seed, country)
    except Exception as error:
        return GlossOutcome(
            message=f"Không dịch được nghĩa: {error}",
            took_ms=round((time.monotonic() - started_at) * 1000),
        )

    # Ghép về đúng dòng bằng chuỗi đã gửi đi. Mô hình vẫn có thể trả về một cụm không nằm
    # trong danh sách hỏi — bỏ qua thay vì tin, vì một dòng lạ chen vào bảng sẽ không có
    # lượng tìm, không có thứ hạng, và trông y như một lỗi của phần xếp hạng.
    asked = {k.lower(): k for k in unique}
    matched: dict[str, KeywordGloss] = {}
    for entry in entries:
        original = asked.get(entry.keyword.strip().lower())
        if original is not None:
            matched[original] = KeywordGloss(
                keyword=original, meaning=entry.meaning.strip(), label=entry.label
            )

    missing = len(unique) - len(matched)
    return GlossOutcome(
        entries=matched,
        message=f"{missing} từ khoá chưa có nghĩa" if missing else None,
        took_ms=round((time.monotonic() - started_at) * 1000),
    )
