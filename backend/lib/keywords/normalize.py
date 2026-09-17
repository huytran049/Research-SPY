"""
Xử lý văn bản phục vụ so sánh từ khoá, theo từng thị trường.

Các nguồn viết cùng một khái niệm theo những cách khác nhau — đo trên một truy vấn thật,
Shopee trả "quần jean suông ống rộng" trong khi Google trả "quần jeans ống rộng" và
TikTok trả "quần jeans nữ ống rộng". Chỉ 2 trong 28 từ khoá trùng nhau nguyên văn giữa
các nguồn. Vì vậy việc so sánh diễn ra trên dạng đã chuẩn hoá, và quan trọng hơn, ở mức
từng chữ bổ nghĩa.

Mọi bảng từ vựng ở đây đều theo ngôn ngữ, và điểm vào là `vocabulary_for(country)` chứ
không phải các hàm rời. Trước đây chúng là hằng số tiếng Việt dùng chung cho mọi thị
trường, và hậu quả không hiện ra thành lỗi mà thành một bảng kết quả trông vẫn bình thường:
chạy `geo=PH` thì không truy vấn nào khớp `INFORMATIONAL_MARKERS`, nên mọi thứ — kể cả
"what is maong pants" — đều được xếp là từ khoá mua hàng, cột mùa vụ luôn rỗng, và phần
điểm ý định lặng lẽ trở thành hằng số.
"""

from __future__ import annotations

import re
import unicodedata
from dataclasses import dataclass
from functools import lru_cache

from lib.core.jscompat import strip_diacritics as _strip_diacritics

from .market import language_chain, merge_by_language

#: Các biến thể chính tả quan sát được trong dữ liệu thật.
#:
#: Cố ý chỉ giới hạn ở chính tả — gộp cả từ đồng nghĩa (kiểu nhập "quần bò" vào "quần jeans")
#: sẽ trộn lẫn những từ khoá cần được xem riêng, vì chúng có lượng tìm và tệp khách
#: hàng khác nhau.
#:
#: Chia theo ngôn ngữ là bắt buộc chứ không phải cho gọn: ba dòng của tiếng Việt quy "sort" và
#: "shot" về "short", và đó là những lỗi gõ có thật của người Việt — nhưng áp lên thị trường
#: nói tiếng Anh thì chúng biến "shot glass" thành "short glass" và "sort by price" thành
#: "short by price", tức là bịa ra những từ khoá chưa ai từng gõ rồi đem đi xếp hạng.
#:
#: `re.ASCII` giữ đúng ngữ nghĩa của `\b` trong JavaScript, nơi ký tự "từ" chỉ gồm [A-Za-z0-9_].
#: Không có cờ này, Python coi cả chữ có dấu là ký tự từ và ranh giới rơi vào chỗ khác.
SPELLING_VARIANTS: dict[str, list[tuple[str, str]]] = {
    "vi": [
        (r"\bjean\b", "jeans"),
        (r"\bjeen\b", "jeans"),
        (r"\bsort\b", "short"),
        (r"\bshot\b", "short"),
        (r"\bsoóc\b", "short"),
        (r"\bbaggy\b", "baggy"),
        (r"\bbig\s*size\b", "bigsize"),
        (r"\bống\s+suông\b", "ống suông"),
    ],
    # Dấu gạch nối sống sót qua `_PUNCTUATION` (xem chú thích ở đó), nên "t-shirt", "tshirt"
    # và "t shirt" là ba nhóm riêng nếu không quy về một.
    "en": [
        (r"\bt-shirt\b", "t shirt"),
        (r"\btshirt\b", "t shirt"),
        (r"\btee\s+shirt\b", "t shirt"),
        (r"\bhoody\b", "hoodie"),
        (r"\bsweat\s+shirt\b", "sweatshirt"),
    ],
}

#: Những chữ cho thấy người tìm đang tìm hiểu chứ không phải đang mua.
#:
#: So khớp bằng phép chứa chuỗi con, nên mục nào cũng phải chịu được việc nằm giữa một từ
#: khác. Đó là lý do danh sách tiếng Anh không có `"are "` (nó nằm trong "flare jeans") hay
#: `"fall"` (nằm trong "waterfall"), còn `"why "` và `"cách "` thì giữ dấu cách cuối.
INFORMATIONAL_MARKERS: dict[str, list[str]] = {
    "vi": [
        "là gì",
        "là j",
        "nghĩa là",
        "cách ",
        "làm sao",
        "thế nào",
        "như thế nào",
        "có nên",
        "nên ",
        "tại sao",
        "vì sao",
        "mặc với",
        "phối với",
        "kết hợp với",
        "bao nhiêu",
        "được không",
        "có được",
        "bị ",
        "sửa ",
        "giặt",
        "bảo quản",
        "phân biệt",
        "review",
        "đánh giá",
        "wiki",
    ],
    "en": [
        "what is",
        "what are",
        "what's",
        "how to",
        "how do",
        "how does",
        "how long",
        "how many",
        "how much",
        "why ",
        "when to",
        "which is",
        "meaning",
        "definition",
        "difference between",
        " vs ",
        "versus",
        "review",
        "reddit",
        "wiki",
        "guide",
        "tutorial",
        "tips for",
        "diy ",
        "ideas",
        "what to wear",
        "can i ",
        "should i ",
        "is it worth",
        "how to wash",
        "how to style",
        "care for",
    ],
    "tl": [
        "ano ang",
        "ano ba",
        "paano",
        "bakit",
        "kailan",
        "saan ",
        "alin ",
        "ibig sabihin",
        "pagkakaiba",
        "gaano ",
    ],
    "id": [
        "apa itu",
        "cara ",
        "bagaimana",
        "kenapa",
        "mengapa",
        "arti ",
        "perbedaan",
        "berapa ",
        "bedanya",
    ],
    "ms": [
        "apa itu",
        "cara ",
        "bagaimana",
        "kenapa",
        "mengapa",
        "maksud ",
        "perbezaan",
        "berapa ",
    ],
    # Tiếng Trung không có dấu cách giữa từ, nên phép chứa chuỗi con ở đây chặt hơn hẳn các
    # ngôn ngữ khác — không cần mẹo "dấu cách cuối" để tránh dính vào giữa một từ dài.
    "zh-Hant": [
        "是什麼",
        "怎麼",
        "如何",
        "為什麼",
        "哪個好",
        "哪種好",
        "差別",
        "比較",
        "評價",
        "心得",
        "開箱",
        "推薦嗎",
    ],
    # Năm mục cuối vào bảng cùng lúc với nguồn Douyin (2026-08-12), và chúng cần thiết vì Douyin
    # là nguồn `CN` ĐẦU TIÊN trả về truy vấn dạng câu hỏi. Taobao và 1688 là ô tìm kiếm của sàn
    # nên gợi ý của chúng gần như luôn là cụm danh từ; Douyin là nền tảng nội dung nên nó trả về
    # "蓝牙耳机连接不上怎么办", "连衣裙长裙搭配什么鞋", "宠物用品类目好做吗".
    #
    # "什么" THAY CHO "是什么" và "为什么": chữ Hán không có dấu cách nên phép chứa chuỗi con ở
    # đây chặt hơn hẳn tiếng Anh, và cả ba dạng đều bắt được bằng một mục. Hai mục cũ chỉ bắt
    # được câu hỏi ĐÚNG dạng đó, nên "搭配什么鞋" lọt qua — đã đo thấy thật.
    #
    # "吗" là trợ từ nghi vấn đứng cuối câu, nên một mình nó đã đủ nhận ra câu hỏi. An toàn vì
    # nó gần như không xuất hiện trong tên hàng hoá.
    #
    # Bảng `zh-Hant` CỐ Ý không được sửa theo: phép đo này chạy trên Douyin, mà Douyin không
    # phục vụ Đài Loan. Chép sang là mở rộng dựa trên suy luận chứ không dựa trên đo đạc.
    "zh-Hans": [
        "怎么",
        "如何",
        "哪个好",
        "哪种好",
        "差别",
        "比较",
        "评价",
        "心得",
        "开箱",
        "测评",
        "什么",
        "吗",
        "教程",
        "好不好",
        "值得买",
    ],
    # "como " và "qual " giữ dấu cách cuối theo đúng lý do nêu ở đầu bảng: không có nó,
    # "como" nằm gọn trong "comodidade" và "acomodar".
    "pt": [
        "o que é",
        "como ",
        "por que",
        "porque ",
        "qual ",
        "melhor que",
        "diferença entre",
        "vale a pena",
        "quanto custa",
        "resenha",
        "review",
        "tutorial",
        "dicas ",
        "para que serve",
    ],
}

#: Những chữ cho thấy ý định mua — được cộng thêm một chút điểm khi xếp hạng.
COMMERCIAL_MARKERS: dict[str, list[str]] = {
    "vi": [
        "giá",
        "rẻ",
        "sale",
        "giảm giá",
        "mua",
        "shop",
        "chính hãng",
        "cao cấp",
        "loại 1",
        "xuất khẩu",
        "freeship",
        "order",
        "sỉ",
        "combo",
    ],
    "en": [
        "price",
        "cheap",
        "sale",
        "discount",
        "deal",
        "coupon",
        "promo",
        "buy ",
        "shop ",
        "for sale",
        "near me",
        "free shipping",
        "wholesale",
        "bulk",
        "outlet",
        "clearance",
        "under $",
        "best price",
        "authentic",
        "official store",
    ],
    "tl": [
        "magkano",
        "presyo",
        "mura",
        "murang",
        "cod",
        "onhand",
        "on hand",
        "legit",
        "budget",
        "pabili",
        "tipid",
    ],
    "id": [
        "harga",
        "murah",
        "termurah",
        "grosir",
        "diskon",
        "promo",
        "gratis ongkir",
        "cod",
        "original",
        "terlaris",
    ],
    "ms": [
        "harga",
        "murah",
        "termurah",
        "borong",
        "diskaun",
        "promosi",
        "cod",
        "original",
        "terlaris",
    ],
    "zh-Hant": [
        "便宜",
        "特價",
        "優惠",
        "免運",
        "現貨",
        "正品",
        "團購",
        "批發",
        "折扣",
        "價格",
        "官方",
        "福利品",
    ],
    "zh-Hans": [
        "便宜",
        "特价",
        "优惠",
        "包邮",
        "现货",
        "正品",
        "团购",
        "批发",
        "折扣",
        "价格",
        "旗舰店",
        "工厂",
    ],
    "pt": [
        "preço",
        "barato",
        "mais barato",
        "promoção",
        "desconto",
        "oferta",
        "frete grátis",
        "atacado",
        "comprar",
        "cupom",
        "original",
        "loja oficial",
    ],
}

#: Từ chỉ mùa theo ngôn ngữ — phần dùng chung cho mọi nước nói ngôn ngữ đó.
SEASON_MARKERS: dict[str, list[str]] = {
    "vi": ["mùa hè", "mùa đông", "mùa thu", "mùa xuân", "hè", "đông", "tết", "noel", "giáng sinh"],
    "en": [
        "christmas",
        "summer",
        "winter",
        "spring",
        "autumn",
        "halloween",
        "valentine",
        "new year",
        "black friday",
        "cyber monday",
        "back to school",
        "9.9",
        "10.10",
        "11.11",
        "12.12",
    ],
    "tl": ["pasko", "ber months", "tag-ulan", "tag-init", "undas", "bagong taon"],
    "id": ["lebaran", "idul fitri", "ramadhan", "ramadan", "natal", "tahun baru", "musim hujan", "harbolnas"],
    "ms": ["hari raya", "raya", "ramadan", "natal", "tahun baru", "musim hujan"],
    "zh-Hant": ["聖誕", "過年", "新年", "夏天", "冬天", "春天", "秋天", "情人節", "母親節", "父親節"],
    "zh-Hans": ["圣诞", "过年", "新年", "夏天", "冬天", "春天", "秋天", "情人节", "母亲节", "父亲节"],
    # CẢNH BÁO NAM BÁN CẦU: Brazil đảo ngược lịch mùa. "verão" là tháng 12–2 và "inverno" là
    # tháng 6–8, ngược hẳn với mọi thị trường khác trong bảng này. Nhãn mùa vụ ở đây vẫn đúng
    # vì nó chỉ NHẬN DIỆN chữ, nhưng bất kỳ chỗ nào sau này suy ra "sắp tới mùa nào" từ tháng
    # hiện tại đều phải tách Brazil ra, nếu không sẽ khuyên nhập áo khoác đúng lúc Brazil vào hè.
    "pt": [
        "natal",
        "ano novo",
        "black friday",
        "carnaval",
        "festa junina",
        "dia das mães",
        "dia dos pais",
        "verão",
        "inverno",
        "volta às aulas",
    ],
}

#: Từ chỉ mùa riêng của từng nước, xét TRƯỚC phần theo ngôn ngữ.
#:
#: Mùa vụ là chuyện của lịch chứ không phải của ngôn ngữ, và đây là chỗ khác biệt đó lộ ra rõ
#: nhất: Mỹ và Anh cùng nói tiếng Anh nhưng "thanksgiving" thì Anh không có, còn "boxing day"
#: thì Mỹ không có. Philippines không có mùa đông nhưng có mùa Giáng sinh dài nhất thế giới,
#: bắt đầu từ tháng 9 — nên với thị trường đó, một từ khoá gắn "pasko" vào tháng 9 là tín
#: hiệu thật, không phải nhiễu.
SEASON_MARKERS_BY_MARKET: dict[str, list[str]] = {
    "US": ["thanksgiving", "black friday", "prom", "4th of july", "memorial day", "labor day"],
    "GB": ["boxing day", "bank holiday", "half term", "bonfire night"],
    "AU": ["boxing day", "anzac day"],
    "CA": ["boxing day", "thanksgiving"],
    "PH": ["undas", "araw ng mga patay"],
    # Ngày lễ mua sắm của hai thị trường Shopee ngoài Đông Nam Á. "雙11"/"雙12" là cách viết
    # của Đài Loan cho hai ngày mà Việt Nam gọi là 11.11 và 12.12 — cùng sự kiện, khác chữ,
    # nên phải liệt kê riêng chứ bảng tiếng Anh không bắt được.
    "TW": ["雙11", "雙12", "中秋", "端午", "農曆新年", "開學"],
    "BR": ["carnaval", "festa junina", "dia das crianças", "black friday"],
    # "618" là lễ mua sắm giữa năm của Trung Quốc, ngang tầm 11.11 — không nước nào khác có,
    # và nó là con số nên phải nằm ở bảng riêng của nước chứ không suy ra được từ ngôn ngữ.
    "CN": ["618", "双11", "双12", "双十一", "双十二", "春节", "中秋", "开学季"],
}

#: Giới từ mở đầu phần đuôi bổ nghĩa trong tiếng Anh.
#:
#: Cần để tìm được danh từ chính: với "jeans for women" thì chữ cuối là "women", trong khi
#: thứ định nghĩa chủ đề là "jeans". Xem `Vocabulary.is_on_topic`.
_EN_TAIL_WORDS = frozenset(
    {"for", "with", "without", "under", "over", "in", "on", "at", "by", "from", "to", "and", "or", "near"}
)

_WHITESPACE = re.compile(r"\s+")
#: Dấu gạch nối CỐ Ý không có trong này: nó phân biệt nghĩa ở nhiều từ khoá thật ("t-shirt"
#: khác "t shirt" về cách viết chứ không về nghĩa, nhưng "co-ord" mất gạch thì thành "co ord").
#: Việc quy các cách viết có gạch về một dạng thuộc về `SPELLING_VARIANTS`, nơi từng cặp được
#: liệt kê rõ.
_PUNCTUATION = re.compile(r"[\"'`,.!?;:()\[\]]")
#: Cùng một dải ký tự với bản TypeScript: A-Z, Đ, và dải U+00C0–U+1EF8.
#: Dải đó gồm cả chữ thường có dấu ("à" là U+00E0), nên nó phạt luôn cả từ nhiều dấu — giữ
#: nguyên như bản gốc để danh sách hiển thị không đổi thứ tự sau khi chuyển ngôn ngữ.
_UPPERISH = re.compile("[A-ZĐÀ-Ỹ]")


def strip_diacritics(text: str) -> str:
    """Dạng không dấu, chỉ dùng để khớp lỏng — không bao giờ dùng để hiển thị."""
    return _strip_diacritics(text)


def _stem_en(word: str) -> str:
    """
    Bỏ hậu tố số nhiều tiếng Anh, đủ dùng cho phép khớp chủ đề.

    Không phải bộ tách gốc từ đầy đủ và không cần phải thế: nơi duy nhất gọi nó chỉ hỏi
    "từ gốc có xuất hiện trong từ khoá này không", mà ở đó "jeans" phải khớp được "jean
    shorts" còn "dresses" phải khớp được "dress". Sai vài trường hợp hiếm ("glasses" thành
    "glasse") chỉ làm phép khớp chặt hơn một chút, không tạo ra kết quả sai.
    """
    if len(word) > 4 and word.endswith(("ses", "xes", "zes", "ches", "shes")):
        return word[:-2]
    if len(word) > 3 and word.endswith("s") and not word.endswith("ss"):
        return word[:-1]
    return word


@dataclass(frozen=True)
class Vocabulary:
    """
    Vốn từ và quy tắc văn bản của một thị trường.

    Gói thành một vật thay vì truyền mã ngôn ngữ vào từng hàm vì hai lý do. Thứ nhất, các
    biểu thức chính quy được biên dịch đúng một lần cho mỗi thị trường thay vì mỗi lần gọi,
    mà một lượt xếp hạng gọi chúng vài nghìn lần. Thứ hai, và quan trọng hơn: không có tham
    số mặc định nào để quên. Mọi nơi cần phân loại văn bản đều buộc phải nói nó đang làm việc
    ở thị trường nào — đúng thứ mà bản trước thiếu.
    """

    country: str
    language: str
    _variants: tuple[tuple[re.Pattern[str], str], ...]
    _informational: tuple[str, ...]
    _commercial: tuple[str, ...]
    #: Đã sắp từ dài tới ngắn để "mùa hè" thắng "hè" và "black friday" thắng "friday".
    _seasons: tuple[str, ...]

    def normalize(self, text: str) -> str:
        """Về chữ thường, chuẩn NFC, gộp khoảng trắng, quy đổi biến thể chính tả."""
        out = _WHITESPACE.sub(" ", unicodedata.normalize("NFC", text).lower()).strip()
        # Bỏ dấu câu mà các nguồn thêm vào tuỳ tiện, nhưng giữ nguyên chữ cái có dấu.
        out = _WHITESPACE.sub(" ", _PUNCTUATION.sub(" ", out)).strip()
        for pattern, replacement in self._variants:
            out = pattern.sub(replacement, out)
        return out

    def extract_modifiers(self, keyword: str, seed: str) -> list[str]:
        """
        Những chữ mà từ khoá thêm vào so với từ gốc.

        "quần jeans" + "quần jeans nữ ống rộng" cho ra ["nữ", "ống", "rộng"] — chính là phần
        phân biệt ứng viên này với ứng viên khác, và là mức mà sự đồng thuận giữa các nguồn
        thật sự đo được.
        """
        # Tiếng Trung không đặt dấu cách giữa từ, nên tách theo dấu cách sẽ coi "洋裝連身裙" là
        # MỘT chữ bổ nghĩa — tức là chính nó, không phải phần chênh so với từ gốc. Khi ấy
        # `agreement` mất hết ý nghĩa: không từ khoá nào chia sẻ chữ bổ nghĩa với từ khoá nào.
        #
        # Cách vá không cần bộ tách từ: bỏ chính chuỗi từ gốc ra khỏi từ khoá, phần còn lại là
        # thứ nó thêm vào. "洋裝連身裙" − "洋裝" = "連身裙". Vẫn thô — "夏天韓版" không tách được
        # thành "夏天" và "韓版" — nhưng thô mà đúng hướng thì hơn hẳn sai hoàn toàn.
        if self.language.startswith("zh"):
            seed_text = self.normalize(seed)
            rest = self.normalize(keyword)
            if seed_text:
                rest = rest.replace(seed_text, " ")
            return [token for token in rest.split(" ") if token]

        seed_tokens = {token for token in self.normalize(seed).split(" ") if token}
        return [token for token in self.normalize(keyword).split(" ") if token and token not in seed_tokens]

    def head_token(self, seed: str) -> str | None:
        """
        Chữ trong từ gốc mà một từ khoá bắt buộc phải nhắc lại để được coi là cùng chủ đề.

        Tiếng Việt lấy chữ CUỐI: "jeans" trong "quần jeans" mới là thứ định nghĩa chủ đề, còn
        chữ đầu chỉ là từ phân loại chung ("quần") và đòi nó thì cái gì cũng lọt.

        Tiếng Anh cũng lấy chữ cuối, nhưng phải cắt phần đuôi giới từ trước. "jeans for women"
        có chữ cuối là "women", và đòi "women" xuất hiện sẽ đánh rớt "wide leg jeans" — một
        biến thể đúng chủ đề — trong khi vẫn cho "shoes for women" đi qua. Cắt từ "for" trở đi
        thì danh từ chính trở lại đúng vị trí cuối.
        """
        # Ngưỡng độ dài phụ thuộc chữ viết. Với chữ Latin, token một ký tự là nhiễu ("áo m",
        # "jeans a"). Với chữ Hán thì ngược lại — rất nhiều mặt hàng là từ MỘT chữ: 包 (túi),
        # 鞋 (giày), 襪 (tất). Giữ ngưỡng 2 cho tiếng Trung sẽ làm `tokens` rỗng, `head_token`
        # trả `None`, và `is_on_topic` luôn đúng — tức là tắt hẳn bộ lọc chủ đề, đúng lúc
        # Shopee hay trộn cụm merchandising vào nhất.
        min_length = 1 if self.language.startswith("zh") else 2
        tokens = [t for t in strip_diacritics(self.normalize(seed)).split(" ") if len(t) >= min_length]
        if not tokens:
            return None
        # Tiếng Trung lấy chữ ĐẦU, ngược với hai nhánh dưới. Khi truy vấn tiếng Trung có dấu
        # cách thì danh từ hàng hoá đứng trước và phần bổ nghĩa theo sau — "洋裝 正韓",
        # "洋裝 夏天韓版 顯瘦" đều là kết quả đo thật từ `shopee.tw`. Lấy chữ cuối ở đây sẽ đòi
        # "顯瘦" (dáng tôn gầy) phải có mặt, và đánh rớt mọi biến thể đúng chủ đề khác.
        #
        # Không đi qua `_stem_en`: chữ Hán không có hậu tố số nhiều để cắt.
        if self.language.startswith("zh"):
            return tokens[0]
        if self.language != "vi":
            head_part = []
            for token in tokens:
                if token in _EN_TAIL_WORDS:
                    break
                head_part.append(token)
            tokens = head_part or tokens
            return _stem_en(tokens[-1])
        return tokens[-1]

    def is_on_topic(self, keyword: str, seed: str) -> bool:
        """Từ khoá này có thật sự liên quan tới từ gốc không?"""
        head = self.head_token(seed)
        if head is None:
            return True
        return head in strip_diacritics(self.normalize(keyword))

    def classify_intent(self, keyword: str) -> str:
        k = self.normalize(keyword)
        if any(marker in k for marker in self._informational):
            return "informational"
        return "commercial"

    def has_commercial_marker(self, keyword: str) -> bool:
        k = self.normalize(keyword)
        return any(marker in k for marker in self._commercial)

    def detect_season(self, keyword: str) -> str | None:
        """Từ chỉ mùa có trong từ khoá, nếu có."""
        k = self.normalize(keyword)
        for marker in self._seasons:
            if marker in k:
                return marker
        return None


@lru_cache(maxsize=None)
def vocabulary_for(country: str) -> Vocabulary:
    """
    Vốn từ của một thị trường. Rẻ khi gọi lại — mỗi thị trường chỉ dựng một lần cho cả tiến trình.
    """
    code = country.upper()
    chain = language_chain(code)
    variants = tuple(
        (re.compile(pattern, re.ASCII), replacement)
        for language in chain
        for pattern, replacement in SPELLING_VARIANTS.get(language, ())
    )
    # Mục riêng của nước đứng trước mục theo ngôn ngữ, rồi cả hai được sắp lại từ dài tới ngắn:
    # phép so khớp trả về mục ĐẦU TIÊN trúng, nên "black friday" phải được xét trước "friday"
    # và "mùa hè" trước "hè", nếu không nhãn hiện ra sẽ luôn là mảnh ngắn hơn.
    seasons = SEASON_MARKERS_BY_MARKET.get(code, []) + merge_by_language(SEASON_MARKERS, code)
    return Vocabulary(
        country=code,
        language=chain[0],
        _variants=variants,
        _informational=tuple(merge_by_language(INFORMATIONAL_MARKERS, code)),
        _commercial=tuple(merge_by_language(COMMERCIAL_MARKERS, code)),
        _seasons=tuple(sorted(dict.fromkeys(seasons), key=len, reverse=True)),
    )


def best_display(raws: list[str]) -> str:
    """Chọn cách viết gốc dễ nhìn nhất trong số các biến thể của cùng một từ khoá chuẩn hoá."""
    if not raws:
        return ""
    # Ưu tiên chữ thường tự nhiên hơn là VIẾT HOA hay Viết Hoa Từng Chữ, sau đó chọn ngắn hơn.
    scored = [
        (raw, len(_UPPERISH.findall(raw)) / max(1, len(raw)) * 10 + len(raw) / 100) for raw in raws
    ]
    scored.sort(key=lambda item: item[1])
    return scored[0][0].strip()
