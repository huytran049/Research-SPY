# Ghi chú phát triển Research SPY

Đọc [README.md](README.md) trước để nắm cấu trúc thư mục. Đây là ghi chú kỹ thuật tôi dùng khi
thêm code mới, nhằm giữ ranh giới giữa hai mảng nghiệp vụ rõ ràng.

---

## Nguyên tắc chung

1. **Đặc thù của một nguồn phải nằm gọn trong file của nguồn đó.** Nếu bạn thấy mình phải
   viết `if platform_id == "facebook"` ở ngoài `lib/ads/platforms/facebook.py`, tức là hợp
   đồng đang thiếu một trường — hãy thêm trường đó vào `lib/ads/platform.py` thay vì rẽ nhánh.

2. **Mục Quảng cáo và mục Từ khoá không import lẫn nhau**, kể cả kiểu dữ liệu. Thứ dùng chung
   thì đặt ở `lib/core/`.

3. **Comment giải thích *vì sao*, không kể lại code đang làm gì.** Đặc biệt: mọi con số đo
   được (giới hạn của endpoint, tỷ lệ kết quả đúng chủ đề, thời gian sống của chữ ký…) phải
   được ghi lại ngay tại chỗ dùng nó. Người sau sẽ không có cách nào đoán ra tại sao
   `MAX_PAGE_SIZE = 20` nếu bạn không viết ra.

4. **Không được để kết quả rỗng im lặng.** Đây là kiểu hỏng nguy hiểm nhất của công cụ này:
   một lưới trống đọc thành "sản phẩm không có nhu cầu". Nguồn nào trả về ít hơn hoặc khác
   với điều người dùng yêu cầu thì phải kèm `notice`, và lỗi thì phải hiện ra `status.ok = False`.

5. **Tầng HTTP phải mỏng.** `app/api/*.py` chỉ đọc query string, gọi `lib/`, và trả JSON.
   Không có logic nghiệp vụ nào ở đó — nhờ vậy thêm nguồn mới không đụng tới route.

---

## Trước khi sửa phần chấm điểm hay xếp hạng

Đọc [`backend/lib/core/jscompat.py`](backend/lib/core/jscompat.py).

Bản này được chuyển từ TypeScript, và bốn chỗ Python khác JavaScript đều im lặng cho ra kết
quả khác nếu viết theo bản năng: `Math.round` làm tròn 0.5 lên còn `round()` của Python làm
tròn về số chẵn; `toFixed` cũng vậy; `new Set` của JS giữ thứ tự chèn còn `set` của Python
thì không (các câu giải thích điểm số đọc theo thứ tự đó); `localeCompare` sắp theo tiếng
Việt còn `sorted()` sắp theo mã ký tự.

Dùng `jround`, `to_fixed`, `unique`, `vi_sort_key` từ module đó thay vì hàm dựng sẵn.

---

## Thêm một nguồn quảng cáo mới

Ví dụ thêm Shopee Ads.

### Bước 1 — tạo `backend/lib/ads/platforms/shopee.py`

Dùng `facebook.py` (nguồn cần trình duyệt để lấy chữ ký) hoặc `tiktok.py` (nguồn có bộ lọc
động) làm mẫu. Khung tối thiểu:

```python
from dataclasses import dataclass
from typing import Literal

from ..platform import (
    AdPlatform,
    HealthProbe,
    MediaPolicy,
    PlatformCapabilities,
    PlatformChoice,
    PlatformOption,
    PlatformSearchInput,
    PlatformSearchOutcome,
)
from ..types import Ad

PLATFORM_ID = "shopee"


@dataclass(frozen=True)
class ShopeeOptions:
    sort_by: Literal["newest", "popular"]


class Shopee(AdPlatform):
    id = PLATFORM_ID
    label = "Shopee Ads"
    capabilities = PlatformCapabilities(keyword_search=True, start_date=False, remote_filters=False)
    options = [
        PlatformOption(
            key="sortBy",
            label="Sắp xếp",
            kind="choice",
            default_value="newest",
            choices=[
                PlatformChoice(value="newest", label="Mới nhất"),
                PlatformChoice(value="popular", label="Phổ biến"),
            ],
        )
    ]
    media = MediaPolicy(host_suffixes=["shopeecdn.com"], referer="https://shopee.vn/")
    health_probe = HealthProbe(keyword="kem", country="VN")

    def parse_options(self, raw: dict[str, str]) -> ShopeeOptions:
        return ShopeeOptions(sort_by="popular" if raw.get("sortBy") == "popular" else "newest")

    async def search(self, request: PlatformSearchInput) -> PlatformSearchOutcome:
        ads: list[Ad] = []
        # … gọi nguồn, ánh xạ về kiểu Ad …
        return PlatformSearchOutcome(ads=ads)


shopee = Shopee()
```

### Bước 2 — đăng ký ở `backend/lib/ads/platforms/__init__.py`

```python
from .shopee import shopee

AD_PLATFORMS: dict[str, AdPlatform] = {
    "facebook": facebook,
    "tiktok": tiktok,
    "shopee": shopee,        # ← chỉ một dòng này
}
```

### Xong. Những thứ tự động hoạt động:

* chip chọn nguồn trên giao diện
* các ô điều khiển riêng của nguồn (dựng từ `options`)
* chấm trạng thái ở `/api/ads/health`
* proxy media cho CDN của nguồn (từ `media.host_suffixes`)
* cache key, gộp kết quả, xếp hạng luân phiên giữa các nguồn

**Không phải sửa:** route, component, CSS, `.env`, `lib/core/*`.

### Vài điểm cần chú ý

* **Nếu nguồn cần chữ ký từ JS phía client**, đừng viết lại thuật toán ký — nó sẽ hỏng mỗi
  lần nền tảng đổi. Khai báo một `SessionRecipe` (xem `lib/core/browser.py`) để mở một trang
  thật, nhặt vật liệu từ request đã ký, rồi phát lại. Cả Facebook và TikTok đều làm vậy.
* **Mọi request ra ngoài phải đi qua `schedule()`** của `lib/core/rate_limit.py`. Một nguồn bị
  chặn tốn kém hơn nhiều so với một nguồn chạy chậm.
* **`capabilities` phải khai báo trung thực.** Giao diện dựa vào nó để không hứa với người
  dùng những thứ nguồn không có. Nguồn không công bố ngày bắt đầu chạy thì `start_date=False`
  — phần chấm điểm sẽ tự hạ độ tin cậy thay vì bịa ra một con số.
* **Giới hạn tần suất là của riêng nguồn**, đọc từ biến môi trường ngay trong file nguồn
  (xem `MIN_INTERVAL_MS` trong `tiktok.py`). Đừng thêm vào `lib/core/config.py`.
* **Nguồn có bộ lọc động** thì đặt `supports_filters = True` và ghi đè `fetch_filters`.
* Thêm biến môi trường mới thì **nhớ ghi vào `backend/.env.example`** — đó là tài liệu duy
  nhất về chúng.

---

## Thêm một nguồn từ khoá mới

Nhẹ hơn nhiều: nguồn chỉ phải nhận một cụm từ và trả về danh sách gợi ý. Phần mở rộng
long-tail, giữ nhịp gọi và xử lý lỗi từng phần đã có sẵn ở `providers/expand.py`.

`backend/lib/keywords/providers/lazada.py`:

```python
from urllib.parse import quote

from lib.core.http import get_json

from ..provider import KeywordProvider, Suggestion
from ..types import SearchContext


class Lazada(KeywordProvider):
    id = "lazada"
    label = "Lazada"
    has_native_score = False
    markets = ["VN", "TH", "PH"]   # để None nếu phục vụ mọi thị trường

    async def fetch_suggestions(self, term: str, ctx: SearchContext) -> list[Suggestion]:
        payload = await get_json(f"https://…?q={quote(term, safe='')}&loc={ctx.country}")
        return [Suggestion(keyword=k) for k in (payload.get("items") or [])]


lazada = Lazada()
```

Rồi thêm một dòng vào `backend/lib/keywords/providers/__init__.py`. Chip nguồn trên giao
diện, cột "Bảng xếp hạng", cache và xếp hạng đều tự nhận nguồn mới. Chip cũng tự tắt ở
những thị trường không có trong `markets`.

`ctx` chở cả ba ô chọn của người dùng, nhưng phần lớn nguồn chỉ cần `ctx.country`:
`ctx.time_range` và `ctx.gprop` là khái niệm riêng của Google Trends. Lờ chúng đi là đúng.
Nếu nguồn của bạn CÓ đọc chúng thì nhớ đưa cả ba vào khoá cache của nguồn — xem
`providers/trends_related.py`, nơi thiếu chúng sẽ khiến "24 giờ qua" nhận nguyên bảng
của "Năm qua".

---

## Sửa kiểu dữ liệu trả về API

Kiểu tồn tại ở hai nơi và **phải sửa cả hai**:

| Sửa gì | Sửa ở đâu |
|---|---|
| Trường mới của quảng cáo | `backend/lib/ads/types.py` **và** `frontend/lib/ads/types.ts` |
| Trường mới của từ khoá | `backend/lib/keywords/types.py` **và** `frontend/lib/keywords/types.ts` |

Bên Python đặt tên `snake_case`; `lib/core/model.py` tự đổi sang `camelCase` khi ra JSON, nên
bên TypeScript viết `camelCase`. Trường `None` bị bỏ hẳn khỏi JSON (giống `undefined` của JS)
— giao diện phân biệt "vắng mặt" với "có và bằng 0", nên đừng đổi hành vi đó.

---

## Trước khi commit

```bash
# frontend/
npm run typecheck                        # bắt buộc
npm run build                            # bắt buộc nếu có động vào app/ hoặc components/

# backend/  (cần backend đang chạy ở cổng 8000)
python scripts/smoke/ads.py              # nếu có động vào lib/ads
python scripts/smoke/keywords.py         # nếu có động vào lib/keywords
python scripts/smoke/ui.py               # nếu có động vào components/ (cần cả frontend đang chạy)
python scripts/audit/keyword_sources.py  # nếu có động vào provider từ khoá
```

Smoke test gọi thật ra các nền tảng, nên hơi chậm và có thể trượt vì nguồn đang giới hạn tần
suất — đọc thông báo lỗi trước khi kết luận là code sai.

---

## Quy ước commit

Một commit nên nằm gọn trong một mục. Tiền tố cho biết nó động vào đâu:

```
ads: thêm nguồn Shopee Ads
ads(tiktok): sửa lỗi phân trang khi ngành hàng rỗng
keywords: thêm nguồn gợi ý Lazada
keywords(rank): hạ điểm từ khoá dạng câu hỏi
core: tăng thời gian chờ làm nóng trình duyệt
api: thêm tham số lọc cho /api/ads/search
ui: gộp thanh trạng thái nguồn vào page header
docs: cập nhật hướng dẫn thêm nguồn
```

Nhánh: `feat/<mô-tả-ngắn>`, `fix/<mô-tả-ngắn>`. Không commit thẳng vào `main`.

---

## Style code

### Python (backend)

Chưa cấu hình formatter riêng. Quy ước đang dùng xuyên suốt:

* `from __future__ import annotations` ở đầu mọi module
* kiểu chú thích đầy đủ cho tham số và giá trị trả về công khai
* chiều rộng dòng ~100 ký tự
* docstring cho module và cho hàm công khai; comment nội bộ giải thích *vì sao*
* dùng `RuntimeError` với câu tiếng Việt đọc được cho người vận hành — thông báo đó lên thẳng
  giao diện

### TypeScript (frontend)

Đang theo mặc định của Next.js:

* không dấu chấm phẩy cuối câu lệnh
* nháy đơn cho chuỗi
* chiều rộng dòng ~110 ký tự
* dấu phẩy cuối trong danh sách nhiều dòng

### Cả hai

Comment và chuỗi hiển thị cho người dùng viết bằng **tiếng Việt**; tên biến, hàm, kiểu viết
bằng **tiếng Anh**.
