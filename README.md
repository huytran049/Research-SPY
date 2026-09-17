# Research SPY

> Nền tảng phân tích cơ hội sản phẩm, giúp đội Product và Marketing chuyển dữ liệu phân tán thành quyết định có thể hành động.

Research SPY là sản phẩm nội bộ tôi phát triển chính (**main developer**) cho khoảng **100 người dùng** thuộc Product và Marketing. Thay vì phải mở từng sàn, đối chiếu quảng cáo, xu hướng tìm kiếm và nguồn hàng bằng tay, người dùng thực hiện toàn bộ quy trình nghiên cứu trong một workspace duy nhất.

> **Chỉ muốn chạy thử?** Đọc [QUICKSTART.md](QUICKSTART.md) — mười phút, không cần hiểu phần còn lại.

---

## Quy mô và tác động

- Khoảng **100 người dùng** thuộc Product và Marketing.
- Khoảng **60.000 sản phẩm được quét mỗi ngày** cho Trend Signal Hub.
- Gom quy trình nghiên cứu vốn trải trên nhiều nền tảng về một nơi — từ khám phá sản phẩm đến kiểm chứng nguồn hàng và tín hiệu thị trường.
- Vận hành **production 24/7** trên VPS.

---

## Bài toán giải quyết

Khi đánh giá một ý tưởng sản phẩm, đội ngũ cần trả lời nhanh những câu hỏi:

- Sản phẩm này đang được bán ở đâu, mức giá nào và có tín hiệu nhu cầu không?
- Đối thủ đang chạy nội dung hoặc quảng cáo gì?
- Khách hàng đang tìm kiếm theo những cách nào?
- Có thể tìm được nguồn hàng tương tự ở đâu?
- Đây là tín hiệu ngắn hạn hay một cơ hội đáng theo dõi?

Research SPY kết nối các bước đó thành một quy trình nghiên cứu liền mạch.

---

## Tính năng chính

| Mục | Đường dẫn | Làm gì | Lấy dữ liệu từ |
|---|---|---|---|
| **Sản phẩm & Content** | `/ads` | Top sản phẩm đa sàn, content quảng cáo đang chạy, video theo sản phẩm | Facebook Ads Library, YouTube, video TikTok *(qua Bing)*, Etsy *(qua server)* · **Shopee, TikTok Shop, Amazon, Taobao, 1688, Temu, TikTok/Douyin** *(qua extension)* |
| **Từ khoá** | `/keywords` | Mở rộng từ khoá gốc ra biến thể đang được tìm kiếm, đo xu hướng | Google Suggest, Shopee, TikTok, Google Trends, 1688, Amazon, Douyin |
| **Tìm bằng ảnh** | `/image` | Một tấm ảnh, ra nguồn hàng và giá ở năm sàn | 1688, Alibaba.com, AliExpress, Taobao, Google Lens |
| **Cơ hội** | `/opportunity` | Hỏi đáp về khoảng trống thị trường trên dữ liệu đã thu | Tổng hợp từ ba mục trên |

Ngoài ra có `/guide` — trang hướng dẫn đọc số liệu, **nên đọc trước khi ra quyết định test sản phẩm**.

---

## Vai trò của tôi

Là **main developer**, tôi phụ trách xuyên suốt từ khám phá yêu cầu đến vận hành:

- Trực tiếp làm việc với người dùng, leader và CEO để làm rõ yêu cầu, chọn phạm vi tính năng và đưa quyết định sản phẩm vào triển khai.
- Xây dựng toàn bộ nền tảng: backend, web app, Chrome Extension, hệ thống thu thập dữ liệu, dashboard tín hiệu và trợ lý hỏi đáp.
- Thiết kế backend FastAPI theo kiến trúc adapter, chuẩn hoá giá, doanh số, đánh giá, video, từ khoá và dữ liệu quảng cáo từ nhiều sàn về một mô hình dùng chung cho frontend Next.js.
- Xây dựng Chrome Extension (Manifest V3) và cơ chế long-poll worker relay để thực thi request ngay trong tab đã đăng nhập khi nền tảng chặn request từ VPS; cookie và trạng thái đăng nhập luôn ở lại trong trình duyệt người dùng.
- Phát triển tìm kiếm ảnh: đối chiếu với kho nội bộ bằng CLIP embedding để nhận diện sản phẩm đã từng triển khai, đồng thời tìm nguồn hàng qua 1688, Alibaba, AliExpress, Taobao và Google Lens.
- Xây dựng Trend Signal Hub quét khoảng 60.000 sản phẩm/ngày theo ngành, lưu snapshot 90 ngày và phân loại tín hiệu thành *Bứt tốc, Bùng nổ, Ổn định, Mới nổi* và *Cơ hội*.
- Xây dựng trợ lý hỏi đáp thị trường theo hướng RAG: nhận diện ý định, lọc dữ liệu theo sàn/ngành/khoảng giá trước khi gọi LLM, rồi trả về số liệu và sản phẩm có thể kiểm chứng.
- Triển khai và vận hành dịch vụ 24/7 trên VPS với HTTPS qua Caddy, Cloudflare CDN và CI/CD bằng GitHub Actions; pipeline kiểm tra Python, TypeScript, production build và Chrome Extension trước khi deploy.

---

## Công nghệ sử dụng

FastAPI · Next.js · Chrome Extension (Manifest V3) · Playwright · PostgreSQL/SQLite · Caddy · Cloudflare · GitHub Actions

---

## Kiến trúc

### Hai tiến trình chạy song song

| Thư mục | Ngôn ngữ | Việc | Cổng |
|---|---|---|---|
| [backend/](backend/) | Python + FastAPI | Toàn bộ tầng dữ liệu: gọi nguồn, chấm điểm, cache, proxy media | 8000 |
| [frontend/](frontend/) | TypeScript + Next.js | Chỉ giao diện, không chứa logic nghiệp vụ | 3000 |

Trình duyệt chỉ nói chuyện với cổng 3000. Mọi đường `/api/*` được Next chuyển tiếp sang backend (xem [frontend/next.config.mjs](frontend/next.config.mjs)), nên không có CORS và video vẫn phát được từ cùng một origin.

**Một số nguồn chạy trong trình duyệt của người dùng, không phải trên server.** Shopee và TikTok Shop trả 403 cho mọi lượt gọi ẩn danh từ server, nhưng trả dữ liệu bình thường cho chính phiên đăng nhập của người dùng. Phần đó do [extension/](extension/) đảm nhiệm, và cookie không bao giờ rời trình duyệt.

### Nguyên tắc tổ chức

**Mỗi mục lớn có một thư mục riêng ở cả ba tầng** (dữ liệu, giao diện, style) — tách module rõ ràng để dễ mở rộng, dễ đọc commit và dễ onboard người mới. Nhìn đường dẫn một file là biết ngay nó thuộc mục nào.

```
backend/
├── app/                     # TẦNG HTTP — mỏng, không chứa logic nghiệp vụ
│   ├── main.py              #   dựng FastAPI, đóng trình duyệt khi tắt
│   └── api/
│       ├── ads.py           #   /api/ads/{platforms,search,ingest,match-image,video-keywords}
│       ├── keywords.py      #   /api/keywords{,/sources,/markets,/gloss,/bridge}
│       ├── imagesearch.py   #   /api/imagesearch — một ảnh, năm sàn
│       ├── opportunity.py   #   /api/opportunity/ask
│       └── media.py         #   proxy phát video, có danh sách host cho phép
│
└── lib/
    ├── core/                # HẠ TẦNG DÙNG CHUNG — không biết Facebook/TikTok là gì
    │   ├── config.py        #   cấu hình chung (cache, timeout, user-agent), nạp .env
    │   ├── cache.py         #   cache TTL trong bộ nhớ
    │   ├── rate_limit.py    #   hàng đợi giữ nhịp gọi ra ngoài
    │   ├── browser.py       #   kho phiên trình duyệt, chạy theo "recipe" nguồn tự khai
    │   ├── http.py          #   gọi JSON cho nguồn không cần trình duyệt
    │   ├── model.py         #   nền chung cho kiểu đi ra API (đổi tên trường sang camelCase)
    │   ├── auth.py          #   hồ phiên đăng nhập Google: chọn, phạt, thưởng
    │   ├── mtop.py          #   ký request cho cổng MTOP của Alibaba
    │   ├── store.py         #   kho trên đĩa cho kết quả tra cứu tốn kém
    │   └── jscompat.py      #   những chỗ Python khác JavaScript  ← ĐỌC KHI SỬA ĐIỂM SỐ
    │
    ├── ads/                 # ===== MỤC QUẢNG CÁO =====
    │   ├── platform.py      #   HỢP ĐỒNG một nguồn quảng cáo phải thoả  ← đọc file này trước
    │   ├── platforms/
    │   │   ├── __init__.py  #   SỔ ĐĂNG KÝ — nơi duy nhất sửa khi thêm nguồn
    │   │   ├── facebook.py  #   fetch phía SERVER
    │   │   ├── tiktok.py    #   fetch phía SERVER
    │   │   ├── youtube.py   #   fetch phía SERVER (API chính thức, cần YOUTUBE_API_KEY)
    │   │   ├── etsy.py      #   fetch phía SERVER (API chính thức, cần ETSY_*)
    │   │   └── shopee.py    #   fetch phía CLIENT — server dựng lệnh, extension chạy
    │   ├── types.py         #   Ad, AdScore, RequestSpec/ClientJob (hợp đồng với extension)
    │   ├── scoring.py       #   quảng cáo chấm theo đời sống, sản phẩm chấm theo cầu và chất lượng
    │   ├── relevance.py     #   cụm từ có nằm trong chữ đọc được không — XẾP HẠNG, không lọc
    │   ├── imagematch.py    #   khớp ảnh bằng pHash (trùng gần như từng điểm ảnh)
    │   ├── clipmatch.py     #   khớp ảnh bằng CLIP (cùng sản phẩm dù khác góc chụp)
    │   ├── keyword_extract.py  # tiêu đề sản phẩm dài thành cụm từ khoá ngắn (Gemini)
    │   └── search.py        #   điều phối hai pha: server fetch, rồi extension nộp raw về
    │
    ├── imagesearch/         # ===== MỤC TÌM BẰNG ẢNH =====
    │   ├── ali.py  alibaba.py  aliexpress.py  taobao.py  lens.py
    │   ├── types.py         #   ImageMatch, ImageSearchResult (sáu tầng giá)
    │   └── search.py        #   điều phối năm nguồn, cache cả danh sách rồi lọc lúc đọc
    │
    └── keywords/            # ===== MỤC TỪ KHOÁ =====
        ├── provider.py      #   HỢP ĐỒNG một nguồn từ khoá phải thoả
        ├── providers/
        │   ├── __init__.py  #   SỔ ĐĂNG KÝ — nơi duy nhất sửa khi thêm nguồn
        │   ├── expand.py    #   bộ máy mở rộng long-tail, dùng chung mọi nguồn
        │   └── trends_related.py  shopee.py  amazon.py  tiktok.py
        ├── market.py        #   thị trường nào nói ngôn ngữ nào (một bản duy nhất)
        ├── normalize.py     #   vốn từ + quy tắc văn bản THEO THỊ TRƯỜNG
        ├── gloss.py         #   dịch nghĩa về tiếng Việt để ĐỌC (Gemini) — không chạm xếp hạng
        ├── bridge.py        #   bắc cầu từ gốc: Gemini đề cử cách gọi, Trends chấm điểm
        └── types.py  rank.py  trends.py  search.py

frontend/
├── app/
│   ├── ads/page.tsx         # trang Quảng cáo (server component, hỏi backend danh sách nguồn)
│   ├── keywords/page.tsx    # trang Từ khoá
│   ├── image/page.tsx       # trang Tìm bằng ảnh
│   ├── opportunity/page.tsx # trang Cơ hội
│   ├── guide/page.tsx       # trang Hướng dẫn
│   └── page.tsx             # chuyển hướng về /ads
├── components/
│   ├── keywords/            # KeywordResearch, KeywordTable, SeedTrend, TrendChart, Dropdown
│   ├── imagesearch/         # ImageSearchWorkspace
│   └── layout/              # Sidebar, BackendDown
├── public/
│   └── research/            # TRANG RESEARCH — HTML/JS thuần, nhúng nguyên vào /ads
├── lib/
│   ├── api.ts               # địa chỉ backend cho server component
│   ├── ads/                 # kiểu dữ liệu + extension.ts (cầu nối tới extension)
│   ├── keywords/            # kiểu dữ liệu, gương của backend/lib/keywords/types.py
│   └── imagesearch/         # kiểu dữ liệu, gương của backend/lib/imagesearch/types.py
└── styles/                  # CSS tách theo đúng ranh giới trên: ads.css, keywords.css, …

extension/                   # ===== EXTENSION CHROME (MV3) =====
├── manifest.json            # quyền theo tên miền, content script cho web app
├── background.js            # service worker: chạy fetch TRONG tab của sàn, nên same-origin
├── content.js               # cầu nối web app với service worker qua postMessage
├── page-hook.js             # chộp phản hồi mà chính trang tự gọi (Taobao, Temu)
├── similar-hook.js          # tương tự, cho trang "sản phẩm tương tự" của Shopee
└── popup.*                  # tự test một sàn, không cần web app

gtrends/                     # gói Google Trends TÁCH RỜI — copy sang dự án khác được
docs/                        # ghi chép nghiên cứu nguồn dữ liệu, không phải phần mềm chạy
```

### Quy tắc phụ thuộc

```
lib/ads  ──┐
           ├──►  lib/core        (một chiều, không bao giờ ngược lại)
lib/keywords ┘

lib/ads  ✗  lib/keywords        (hai mục KHÔNG import lẫn nhau, kể cả kiểu dữ liệu)

frontend  ──►  backend qua HTTP  (giao diện không chứa logic nghiệp vụ nào)
```

Hai mục dùng chung đúng ba thứ: cache, hàng đợi rate-limit, và cấu hình chung — không dùng chung kiểu dữ liệu nào. `lib/keywords/providers/tiktok.py` và `lib/ads/platforms/tiktok.py` trùng tên nhưng là hai file không liên quan: một cái đọc gợi ý tìm kiếm, một cái đọc thư viện quảng cáo.

**Kiểu dữ liệu tồn tại ở hai nơi.** `frontend/lib/*/types.ts` là bản mô tả hình dạng JSON mà `backend/lib/*/types.py` phát ra. TypeScript không kiểm tra được qua ranh giới HTTP, nên hai file cố ý giữ đúng thứ tự trường: sửa bên Python thì sửa luôn bên TypeScript.

---

## Chạy dự án

Cài một lần:

```bash
cd backend
python -m pip install -r requirements.txt
python -m playwright install chromium
cp .env.example .env.local        # tuỳ chọn — chạy được mà không cần sửa gì

cd ../frontend
npm install
```

Chạy hằng ngày: **nhấp đúp `start.bat`** ở thư mục gốc (bật cả hai tiến trình rồi mở trình duyệt). Muốn chạy tay hoặc đọc log một bên thì dùng hai terminal:

```bash
# cửa sổ 1 — backend
cd backend
python -m uvicorn app.main:app --port 8000

# cửa sổ 2 — frontend
cd frontend
npm run dev                       # http://localhost:3000
```

> **Đừng thêm `--reload` cho backend trên Windows.** Cờ đó khiến uvicorn chuyển sang `WindowsSelectorEventLoopPolicy`, loop không sinh được tiến trình con nên Playwright chết ngay khi khởi động — mất cả Google Trends lẫn toàn bộ mục Quảng cáo. Sửa backend thì tắt rồi bật lại bằng tay. (`--workers` dính đúng lỗi này.)

Lệnh khác:

```bash
# backend/
python -m uvicorn app.main:app --host 0.0.0.0 --port 8000   # mở cổng cho cả LAN
python scripts/smoke/ads.py             # test đầu-cuối mục Quảng cáo
python scripts/smoke/keywords.py        # test đầu-cuối mục Từ khoá
python scripts/smoke/ui.py              # mở trình duyệt thật, click hết các nút, bắt lỗi client
python scripts/audit/keyword_sources.py # đối chiếu độc lập: dữ liệu tool có khớp nguồn gốc không

# frontend/
npm run build                           # build production
npm run start                           # chạy bản build, mở cổng 3000 cho cả LAN
npm run typecheck                       # tsc --noEmit
```

Xem [QUICKSTART.md](QUICKSTART.md) để cài đặt bản local; ghi chú phát triển bổ sung ở [CONTRIBUTING.md](CONTRIBUTING.md).

---

## Thêm một nguồn mới

Xem hướng dẫn đầy đủ kèm ví dụ ở **[CONTRIBUTING.md](CONTRIBUTING.md)**. Tóm tắt:

- **Nguồn quảng cáo mới** (Shopee Ads, Google Ads, Lazada…): tạo `backend/lib/ads/platforms/<tên>.py` kế thừa lớp `AdPlatform` ở [backend/lib/ads/platform.py](backend/lib/ads/platform.py), rồi thêm một dòng vào `backend/lib/ads/platforms/__init__.py`. Không phải sửa route, giao diện, proxy media hay file cấu hình nào.
- **Nguồn từ khoá mới**: tạo `backend/lib/keywords/providers/<tên>.py` theo `backend/lib/keywords/provider.py`, thêm một dòng vào `backend/lib/keywords/providers/__init__.py`.

---

## Giới hạn cần biết (quan trọng)

Ba điều này ảnh hưởng trực tiếp tới việc đọc số liệu — trang `/guide` giải thích kỹ hơn:

1. **"CVR ước lượng" không phải CVR thật.** Không nền tảng công khai nào cung cấp tỷ lệ chuyển đổi; đó là dữ liệu riêng trong tài khoản advertiser. Con số này suy ra từ số ngày quảng cáo đã chạy (55%), số biến thể creative (20%), CTR (15%) và tương tác (10%). Nó vẫn được tính vì **thứ tự thẻ dựa vào nó**, nhưng cố ý KHÔNG hiện trên thẻ quảng cáo. Thẻ **sản phẩm sàn** thì có hiện điểm và là điểm khác: *cầu* (số bán) và *chất lượng* (rating cùng số lượt đánh giá) — con số sàn công bố chứ không phải suy luận. Xem `backend/lib/ads/scoring.py`.

2. **TikTok không search được theo từ khoá.** Creative Center chỉ mở chức năng này cho tài khoản đã đăng nhập; phiên ẩn danh nhận về *0 kết quả kèm mã thành công* — trông hệt như "sản phẩm không có nhu cầu". Khi gặp trường hợp này, công cụ chuyển sang duyệt Top Ads theo CTR và **luôn kèm thông báo nói rõ**.

3. **Không có lượng search tuyệt đối.** Con số đó chỉ nằm trong Google Ads Keyword Planner và cần tài khoản quảng cáo đang tiêu tiền. Cột "Lượng tìm" vẽ **hình dạng** nhu cầu theo thời gian lấy từ Google Trends, kèm tháng cao điểm — dùng để chọn thời điểm test và so tính mùa vụ, không thay số liệu khi tính ngân sách.

4. **Ba ô Quốc gia / Thời gian / Loại tìm kiếm áp cho CẢ hai việc** — tìm ra từ khoá và vẽ đường lượng tìm. Đó là ba ô của chính Google Trends, nên đổi chúng là đổi câu hỏi chứ không phải đổi hiển thị. Mặc định: **Việt Nam · Năm qua · Tìm kiếm trên web**.

**Chưa dùng proxy.** Tìm kiếm đa quốc gia chạy qua bộ lọc quốc gia của chính nền tảng — bạn thấy những gì một người ở Việt Nam nhìn thấy khi lọc theo nước đó, không phải những gì người bản địa nước đó nhìn thấy.

---

## Vận hành

- **Chạy một tiến trình backend dùng chung.** Cache và phiên trình duyệt giữ trong bộ nhớ; khởi nhiều worker sẽ nhân số request ra ngoài và dễ khiến nguồn dữ liệu giới hạn truy cập.
- **Không lưu video.** Media phát xuyên qua `/api/media`, không ghi xuống đĩa. Link CDN có chữ ký và hết hạn sau vài giờ — mở lại hôm sau thì search lại để lấy link mới.
- **Chấm đỏ ở thanh trạng thái** nghĩa là nguồn đó đang có vấn đề, có thể nền tảng đã đổi cấu trúc. File cần sửa khi đó là `backend/lib/ads/platforms/<tên nguồn>.py` và không file nào khác.
- **Trang báo "Chưa kết nối được tầng dữ liệu"** nghĩa là backend Python chưa chạy, không phải công cụ hỏng. Bật lại `python -m uvicorn app.main:app` trong `backend/` rồi tải lại trang.

---

*Đây là sản phẩm nội bộ; repository này được dùng để thể hiện phạm vi thiết kế và phát triển của cá nhân tôi.*