/*
 * Trang research đầy đủ — mở dạng full tab.
 *
 * Lấy nhiều TỪ KHOÁ cùng lúc (mỗi từ khoá nhiều trang, sort bán chạy) qua service worker,
 * chuẩn hoá theo format 2026, XẾP HẠNG theo công thức backend (cầu 60% + chất lượng 40%),
 * rồi hiện một bảng gộp có cột Từ khoá + Sàn để so sánh. Chấm điểm phản chiếu
 * `backend/lib/ads/scoring.py::_score_product` — sửa một bên nhớ sửa bên kia.
 *
 * Đa sàn: Shopee (Cách A, fetch trong tab đăng nhập), TikTok Shop (Kalodata, phiên kalodata.com),
 * Amazon (công khai, scrape DOM),
 * Etsy/Facebook (qua backend). Thêm sàn = viết một adapter fetch/parse riêng trong fetchFor + thêm
 * domain vào host_permissions; cột "Sàn" đã sẵn cho việc đó.
 */

/*
 * ĐÓNG GÓI TOÀN BỘ FILE TRONG MỘT HÀM. Bắt buộc, không phải cho gọn:
 *
 * Trình duyệt Chrome tự tạo sẵn `window.chrome` cho mọi trang. Ở phạm vi script, `const chrome`
 * đụng đúng cái tên đó và ném `Identifier 'chrome' has already been declared` — lỗi xảy ra lúc
 * KHỞI TẠO script, nên KHÔNG một dòng nào trong file chạy. Triệu chứng rất dễ chẩn đoán nhầm:
 * trang vẫn hiện đủ tab, đủ cột, đủ chữ (tất cả là HTML tĩnh), chỉ có điều bấm gì cũng không
 * phản ứng. Đã đo 2026-08-24, và đó là lý do có hai dòng này.
 *
 * Trong phạm vi hàm thì `const chrome` chỉ che đi biến toàn cục, hợp lệ. Không thụt lề lại phần
 * bên dưới, cố ý: giữ file khác bản gốc đúng những chỗ buộc phải khác.
 */
(function () {
/*
 * ĐƯỜNG VỀ TRANG LOGIN, TỰ SUY RA — không gõ cứng.
 *
 * Webtool sống ở `tntecom.com/research`, nên trang login là `/research/login` chứ không phải
 * `/login`. File này là JavaScript thường, không qua bundler, nên KHÔNG import được `withBase()`
 * của lib/basePath.ts. Gõ cứng `/research/login` thì thành bản sao thứ hai của giá trị cấu hình,
 * và lần nào đó ai đổi `basePath` trong next.config.mjs sẽ không ai nhớ tới dòng này.
 *
 * Thay vào đó suy ra từ chính địa chỉ của iframe. Trang này luôn được nhúng ở
 * `<base>/research/index.html` (xem app/(dashboard)/ads/page.tsx), nên đi ngược lên một cấp
 * rồi rẽ sang `login` là ra đúng đích, ở MỌI base path — kể cả khi không có base path nào:
 *
 *   /research/research/index.html  →  ../login  →  /research/login
 *   /research/index.html           →  ../login  →  /login
 *
 * Dùng `window.top` chứ không phải `window`: cần đá cả khung ngoài về login, không chỉ iframe.
 */
const LOGIN_URL = new URL('../login', location.href).pathname;
/*
 * ===========================================================================
 * AUTH GATE — chưa đăng nhập thì đá về /login/.
 *
 * Kiểm cả `rs_token` (cấu hình Supabase, có JWT) và `rs_username` (chế độ chỉ-localStorage
 * khi backend chưa cấu hình Supabase, login page tự set fallback). Thiếu cả hai → chưa đăng
 * nhập → redirect. Đặt Ở ĐẦU FILE để không code nào chạy trước khi có user.
 * ===========================================================================
 */
if (!localStorage.getItem('rs_token') && !localStorage.getItem('rs_email')) {
  window.top.location.replace(LOGIN_URL);
  return;
}

// Tên user + đăng xuất + link Admin nay nằm ở SIDEBAR (khung Next bọc ngoài iframe), không ở
// header trang này nữa — nhờ vậy chúng hiện ở MỌI tab, không riêng tab Sản phẩm. Xem
// components/layout/Sidebar.tsx.

// Helper gọi backend có kèm JWT (nếu có). Dùng chung cho mọi fetch tới /api/* sau này.
window.rsAuthFetch = async function (url, options = {}) {
  const token = localStorage.getItem('rs_token');
  const headers = Object.assign({}, options.headers || {});
  if (token) headers['Authorization'] = 'Bearer ' + token;
  const r = await fetch(url, Object.assign({}, options, { headers }));
  // 401 = token hết hạn hoặc sai → về login.
  if (r.status === 401) {
    // Kèm 'rs_bu' + 'rs_bu_thresh': ngưỡng xanh là chính sách của MỘT NGƯỜI, không phải thiết
    // lập của cái máy — xem `Sidebar.tsx::logout`.
    ['rs_token', 'rs_email', 'rs_display', 'rs_role', 'rs_user_id', 'rs_username', 'rs_bu', 'rs_bu_thresh'].forEach((k) => localStorage.removeItem(k));
    window.top.location.replace(LOGIN_URL);
    throw new Error('Phiên đã hết hạn');
  }
  return r;
};

// Fire-and-forget analytics tracker. Backend tự xử user_id từ JWT; không có JWT vẫn track ẩn danh.
window.rsTrack = function (eventType, meta) {
  try {
    const body = JSON.stringify({ event_type: eventType, meta: meta || {} });
    const token = localStorage.getItem('rs_token');
    fetch('/api/analytics/track', {
      method: 'POST',
      headers: Object.assign(
        { 'Content-Type': 'application/json' },
        token ? { 'Authorization': 'Bearer ' + token } : {},
      ),
      body,
      keepalive: true,  // cho phép request hoàn tất khi user điều hướng đi
    }).catch(() => {});
  } catch (e) {}
};

/*
 * ===========================================================================
 * LỚP GIẢ LẬP API EXTENSION  —  phần DUY NHẤT khác bản chạy trong extension
 * ===========================================================================
 *
 * Trang này vốn là một trang của extension (`chrome-extension://…/results.html`) nên gọi được
 * thẳng `chrome.runtime` và `chrome.tabs`. Giờ nó là một trang web bình thường trong webtool,
 * và trang web thì KHÔNG có hai API đó.
 *
 * Thay vì sửa 16 chỗ gọi rải khắp 1.300 dòng bên dưới, ở đây dựng lại đúng hai API ấy bằng
 * cầu `postMessage` mà `extension/content.js` đang lắng nghe. Toàn bộ phần còn lại của file
 * giữ nguyên từng ký tự so với `extension/results.js` — đó là chủ đích: giao diện và hành vi
 * không được phép lệch đi chỉ vì đổi chỗ ở.
 *
 * `const chrome` ở phạm vi script che đi `window.chrome` mà trình duyệt tự tạo (một object
 * gần như rỗng với trang thường). Cố ý: mọi lượt gọi bên dưới đi vào cầu này.
 *
 * KHÔNG CÓ EXTENSION thì mỗi lượt gọi trả về `null` sau 30 giây. Không phải giá trị tuỳ tiện:
 * mọi chỗ gọi bên dưới đều đã kiểm `!res || !res.ok` hoặc `(r && r.items) || []` sẵn, nên
 * `null` đi qua đúng những nhánh báo lỗi mà tác giả đã viết, thay vì ném TypeError.
 */
const RS_PAGE = 'research-spy';
const RS_EXT = 'research-spy-ext';

/*
 * PHẢI lớn hơn ngân sách của MỌI lệnh trong `background.js`, không phải một con số cho đẹp.
 *
 * `chrome.runtime.sendMessage` thật không có timeout — nó chờ service worker bao lâu cũng được.
 * Con số ở đây chỉ là lưới an toàn phòng khi extension chết giữa chừng, nên nó phải nằm TRÊN
 * lệnh chậm nhất, không phải dưới. Ngân sách đo được (2026-08-24):
 *
 *     searchTiktok          120.000 ms   ← chậm nhất
 *     searchDouyin          120.000 ms
 *     searchTiktokCreative   45.000 ms
 *     mọi lệnh sàn còn lại  ≤ 18.000 ms
 *
 * Cộng thêm thời gian mở tab và chờ trang tải trước khi vào vòng lặp → chọn 240 giây.
 *
 * ĐÃ SAI MỘT LẦN Ở ĐÂY: đặt 30 giây thì Shopee/1688/Taobao/Amazon vẫn chạy (đều dưới 18 giây)
 * nên trông như mọi thứ bình thường, còn đúng ba nguồn VIDEO thì luôn rỗng. Rỗng IM LẶNG, vì
 * hết giờ trả `null` mà nhánh báo lỗi của trang là `if (tk && tk.blocked && tk.error)` — `null`
 * trượt qua hết. Người dùng chỉ thấy "Không có video", không phân biệt được với thật sự không có.
 */
const RS_TIMEOUT_MS = 240000;
let _rsSeq = 0;

function rsSend(msg) {
  return new Promise((resolve) => {
    const id = `rs-page-${Date.now()}-${_rsSeq++}`;
    const timer = setTimeout(() => {
      window.removeEventListener('message', onMessage);
      // Ít nhất phải để lại dấu vết. Trang xử `null` như "không có kết quả", nên nếu không có
      // dòng này thì một lượt hết giờ trông y hệt một lượt trả về rỗng.
      console.warn(`[research] ${msg && msg.type} không có trả lời sau ${RS_TIMEOUT_MS / 1000}s — extension còn sống không?`);
      resolve(relayFailure(`quá ${RS_TIMEOUT_MS / 1000}s chưa có dữ liệu.`));
    }, RS_TIMEOUT_MS);

    function onMessage(event) {
      if (event.source !== window) return;
      const d = event.data;
      if (!d || d.source !== RS_EXT || d.id !== id) return;
      clearTimeout(timer);
      window.removeEventListener('message', onMessage);
      resolve(d.result);
    }

    window.addEventListener('message', onMessage);
    window.postMessage({ source: RS_PAGE, type: 'CALL', id, msg }, '*');
  });
}

/**
 * RELAY: không có extension trên MÁY NÀY, nhưng có một máy-thợ (trình duyệt khác đã cài
 * extension + đăng nhập sàn, ở IP dân cư) đang online. Khi đó mọi lệnh `RS_*` được đẩy qua
 * `/api/relay/submit` tới máy-thợ thay vì `postMessage` cục bộ. Bật ở `DOMContentLoaded` bên
 * dưới, chỉ khi PING cục bộ trượt MÀ `/api/relay/status` báo có thợ.
 *
 * `relaySend` trả về ĐÚNG hình dạng như `rsSend`: chính object mà `background.js` trả cho lệnh
 * đó (vd Shopee: { ok, texts, videoItems, blocked, error }), nên phần parse phía dưới không
 * phân biệt được nó tới từ extension cục bộ hay từ máy-thợ.
 */
let RELAY_MODE = false;

/**
 * Hình dạng "hỏng có nói lý do".
 *
 * `why` HIỆN LÊN MÀN HÌNH, nên nó nói bằng tiếng của người dùng ("quá 240s chưa có dữ liệu")
 * chứ không phải tiếng của hệ thống ("extension không trả lời RS_TIKTOK"). Chi tiết kỹ thuật
 * vẫn còn đủ ở `console.warn` ngay trên — đúng chỗ của người đi sửa, không phải chỗ của người
 * đang tìm sản phẩm.
 *
 * Trả `null` là cách chắc chắn làm mất lý do: mọi nơi đọc kết quả đều viết `(x && x.items) || []`,
 * nên một lượt hết giờ trông y hệt một lượt thật sự không có kết quả — người dùng chỉ thấy
 * "Không có video". `blocked` + `error` là đúng hình dạng mà `background.js` dùng khi một nguồn
 * bị chặn, nên các nhánh `if (tk && tk.blocked && tk.error)` sẵn có hiện ra ngay, không phải sửa.
 */
function relayFailure(why) {
  return { ok: false, blocked: true, error: why, items: [] };
}

async function relaySend(msg) {
  try {
    // rsAuthFetch kèm JWT: khi backend bật auth, /submit đòi đăng nhập (máy-thợ chạy trên IP dân
    // cư đã đăng nhập sàn, không mở cho ẩn danh). 401 → về login, đúng như mọi lệnh khác.
    const r = await window.rsAuthFetch('/api/relay/submit', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(msg),
    });
    let j = null;
    try { j = await r.json(); } catch (e) { /* backend restart → text, không phải JSON */ }
    if (j && j.ok) return j.result;
    // 503 = chưa có máy-thợ, 504 = thợ không kịp trả — HAI việc phải đi sửa khác hẳn nhau, nên
    // đừng gộp chúng (và gộp cả với "không có kết quả") thành một dấu lặng.
    const chiTiet = (j && j.error) || `HTTP ${r.status}`;
    console.warn(`[research] relay ${msg && msg.type} hỏng:`, chiTiet);
    // 503 = chưa có máy-thợ. Câu gốc của backend ("Chưa có máy-thợ nào online. Mở trang /worker
    // trên máy đã cài extension") là lời dặn cho QUẢN TRỊ, hiện lên trang tìm sản phẩm thì người dùng
    // không làm gì được với nó. Chi tiết vẫn nằm ở console ngay trên cho người đi sửa.
    const why = r.status === 503 ? 'chưa lấy được dữ liệu — thử lại sau ít phút.' : chiTiet;
    return relayFailure(why);
  } catch (e) {
    console.warn('[research] relay lỗi:', e);
    return relayFailure('không kết nối được nguồn dữ liệu');
  }
}

/** Gửi một lệnh tới extension — cục bộ (postMessage) hoặc qua máy-thợ (relay). */
function dispatch(msg) {
  return RELAY_MODE ? relaySend(msg) : rsSend(msg);
}

const chrome = {
  runtime: {
    sendMessage(msg, callback) {
      dispatch(msg).then((result) => { if (callback) callback(result); });
    },
  },
  // `tabs.create` ĐÃ GỠ, 2026-09-08. Nơi gọi duy nhất là chỗ bấm chip nước lúc chưa đăng
  // nhập — nó đẩy người dùng sang trang sàn giữa chừng, mà dấu ✕ kích hoạt cú đẩy đó thường
  // là báo động giả. Không còn ai mở tab từ mã nữa; mọi link người dùng bấm đều là thẻ <a>
  // thật trong bảng kết quả.
  //
  // Nếu sau này cần mở tab từ mã, ĐỪNG dùng `window.open(url, '_blank', 'noopener')`: theo
  // chuẩn nó trả `null` NHƯNG TAB VẪN MỞ, nên `if (!win)` sẽ kêu "trình duyệt đã chặn cửa sổ
  // bật lên" mỗi lần bấm trong khi tab mở ra ngay sau lưng thông báo đó (đã sập đúng vậy
  // 2026-08-24). Dùng một thẻ <a target="_blank" rel="noopener"> tạm là xong.
  cookies: {
    // Trang web KHÔNG đọc được cookie đăng nhập của các sàn, kể cả khi cùng miền: chúng đều là
    // HttpOnly. Phải nhờ service worker, nơi duy nhất có quyền `cookies`.
    //
    // Thiếu hàm này thì lượt gọi ném TypeError, bị `catch` của trang nuốt và thành `false` —
    // và vì `research()` bỏ qua sàn nào có `loginStatus === false`, Shopee với TikTok Shop sẽ
    // im lặng không bao giờ chạy. Đã sập đúng vào đó một lần, 2026-08-24.
    get({ url, name }, callback) {
      dispatch({ type: 'RS_COOKIE', url, name }).then((r) => callback((r && r.cookie) || null));
    },
  },
};

/** Extension đã cài và trả lời chưa. Trang tự hỏi lúc nạp để báo sớm thay vì để người dùng chờ. */
async function rsExtensionReady() {
  const resp = await Promise.race([
    rsSend({ type: 'RS_PING' }),
    new Promise((r) => setTimeout(() => r(null), 2000)),
  ]);
  return !!(resp && resp.ok);
}

// Quyết định đi đường nào: extension cục bộ, hay relay tới máy-thợ. PHẢI await xong TRƯỚC khi
// gọi `refreshLogin()` lần đầu — nếu không, login check ban đầu chạy lúc RELAY_MODE còn false,
// đi đường local (không extension) và trả ✕ cho mọi sàn. Gọi ở cuối file: `detectMode().then(refreshLogin)`.
async function detectMode() {
  // 1) Có extension NGAY TRÊN MÁY NÀY → dùng thẳng, không cần relay.
  if (await rsExtensionReady()) return;

  // 2) Đi đường vòng được thì ĐI IM LẶNG.
  //
  // Bản trước hỏi `/api/relay/status` đúng MỘT LẦN lúc tải trang: thợ offline thì giữ đường cục bộ
  // (không có extension) suốt phiên, và dựng một băng đỏ "Các sàn cần đăng nhập... tạm thời chưa dùng
  // được. Thử lại sau ít phút." Câu đó sai hai lần: người dùng chưa làm gì đã bị báo lỗi, và "thử lại
  // sau ít phút" không bao giờ thành — thợ có online lại thì trang vẫn kẹt đường cũ tới khi F5.
  // Chủ dự án bỏ băng đó ngày 15/09/2026.
  //
  // Đi relay vô điều kiện thì tự lành: thợ online lúc nào, lượt bấm Research kế tiếp chạy được lúc
  // đó. Thợ đang vắng thì kiểm tra đăng nhập trả `undefined` (dấu …, không chặn Research — xem
  // `checkLogin`), còn lượt tìm thật thì từng sàn tự báo lại đúng lúc người dùng bấm.
  RELAY_MODE = true;
}

const DOMAIN = { VN: 'shopee.vn', TH: 'shopee.co.th', PH: 'shopee.ph', MY: 'shopee.com.my', ID: 'shopee.co.id', SG: 'shopee.sg', TW: 'shopee.tw', BR: 'shopee.com.br', MX: 'shopee.com.mx', CO: 'shopee.com.co', CL: 'shopee.cl' };
const IMG_REGION = { VN: 'vn', TH: 'th', PH: 'ph', MY: 'my', ID: 'id', SG: 'sg', TW: 'tw', BR: 'br', MX: 'mx', CO: 'co', CL: 'cl' };
const CURRENCY = { VN: 'VND', TH: 'THB', PH: 'PHP', MY: 'MYR', ID: 'IDR', SG: 'SGD', TW: 'TWD', BR: 'BRL', MX: 'MXN', CO: 'COP', CL: 'CLP' };
const COUNTRY = { VN: 'Việt Nam', TH: 'Thái Lan', ID: 'Indonesia', MY: 'Malaysia', PH: 'Philippines', SG: 'Singapore', TW: 'Đài Loan', BR: 'Brazil', MX: 'Mexico', CO: 'Colombia', CL: 'Chile', US: 'Mỹ', GB: 'Anh', DE: 'Đức', JP: 'Nhật', FR: 'Pháp', IT: 'Ý', ES: 'TBN', CA: 'Canada' };
const FLAG = { VN: '🇻🇳', TH: '🇹🇭', ID: '🇮🇩', MY: '🇲🇾', PH: '🇵🇭', SG: '🇸🇬', TW: '🇹🇼', BR: '🇧🇷', MX: '🇲🇽', CO: '🇨🇴', CL: '🇨🇱', US: '🇺🇸', GB: '🇬🇧', DE: '🇩🇪', JP: '🇯🇵', FR: '🇫🇷', IT: '🇮🇹', ES: '🇪🇸', CA: '🇨🇦' };
// Amazon: sàn CÔNG KHAI (không login) — mỗi nước 1 domain, fetch thẳng + parse HTML.
const AMZ_DOMAIN = { US: 'amazon.com', GB: 'amazon.co.uk', DE: 'amazon.de', JP: 'amazon.co.jp', FR: 'amazon.fr', IT: 'amazon.it', ES: 'amazon.es', CA: 'amazon.ca' };
const AMZ_CUR = { US: 'USD', GB: 'GBP', DE: 'EUR', FR: 'EUR', IT: 'EUR', ES: 'EUR', JP: 'JPY', CA: 'CAD' };
// TikTok Shop: dữ liệu từ KALODATA, thay cho Seller Center `product/opportunity` từ 2026-09-14.
//
// Seller Center chỉ chạy được ở nước nào người dùng có tài khoản người bán, và chỉ trả "sản phẩm
// tiềm năng" chứ không có doanh thu thật. Kalodata dùng MỘT phiên đăng nhập (kalodata.com trên
// máy có extension, hoặc máy-thợ) cho cả 15 nước, và trả số bán + doanh thu theo ngày cho từng
// sản phẩm lẫn từng video. Đặc tả: `docs/kalodata-api.md`; lõi gọi mạng: `extension/kalodata.js`.
//
// THỨ TỰ NƯỚC: VN, PH trước — xem ghi chú ở `PLATFORMS`. Nước đầu là nước chọn sẵn.
const KD_REGIONS = ['VN', 'PH', 'TH', 'ID', 'MY', 'SG', 'US', 'GB', 'MX', 'BR', 'DE', 'FR', 'IT', 'ES', 'JP'];
// Một phiên cho mọi nước → mọi nước "đăng nhập" ở cùng một nơi. `LOGIN`/`renderRegions` đọc bảng
// này để biết nước nào cần kiểm đăng nhập.
const KD_DOMAIN = Object.fromEntries(KD_REGIONS.map((c) => [c, 'www.kalodata.com']));
const TT_CUR = { PH: 'PHP', VN: 'VND', TH: 'THB', ID: 'IDR', MY: 'MYR', SG: 'SGD', US: 'USD', GB: 'GBP', MX: 'MXN', BR: 'BRL', DE: 'EUR', FR: 'EUR', IT: 'EUR', ES: 'EUR', JP: 'JPY' };
// Tỉ giá xấp xỉ về USD — để quy GMV các sàn/nước về cùng thang khi chấm "chất" (không phụ thuộc
// đơn vị tiền). Chỉ dùng cho chuẩn hoá điểm, không phải giá trị tài chính chính xác.
const FX_USD = { PHP: 0.017, VND: 0.00004, THB: 0.028, IDR: 0.000062, MYR: 0.22, SGD: 0.74, USD: 1, GBP: 1.27, EUR: 1.08, JPY: 0.0068, BRL: 0.18, MXN: 0.052 };
// Sàn chạy ở BACKEND (secret/scrape phía server): Etsy, Facebook.
//
// RỖNG là cố ý: trang này giờ nằm trong webtool, nên `/api/...` đi cùng origin và được
// `frontend/next.config.mjs` chuyển tiếp sang FastAPI. Nhờ vậy đổi tên miền lúc deploy
// không phải sửa file này — khác hẳn bản cũ trỏ cứng vào localhost:8000.
const BACKEND = '';
const PF_LABEL = { etsy: 'Etsy', facebook: 'Facebook', tiktok: 'TikTok', douyin: 'Douyin 抖音', youtube: 'YouTube', ali1688: '1688' };
const PRICE_SCALE = 100000;

// Modal Giá vốn — QUY VỀ ¥ TRUNG: giá bán đối thủ (tiền sàn) → ₫ → ¥, rồi so với giá vốn 1688 (vốn
// là ¥). Cần HAI tỉ giá: ¥→₫ (chung, ~3900) và [tiền sàn]→₫ (riêng từng nước; VN = 1). Ngưỡng %
// chung. User chỉnh ở modal, lưu localStorage: rs_cost_cny_vnd (¥→₫) + rs_cost_curvnd_<CUR> ([nước]→₫).
const CNY_VND_DEFAULT = 3900;
const CUR_VND_DEFAULTS = { VND: 1, PHP: 494, THB: 730, MYR: 5900, IDR: 1.6, SGD: 19400, TWD: 820, USD: 26000, GBP: 33000, EUR: 28000, BRL: 4800, MXN: 1400, JPY: 175 };
const COST_THRESH_DEFAULT = 30;
function cnyVnd() { try { const v = parseFloat(localStorage.getItem('rs_cost_cny_vnd')); if (v > 0) return v; } catch (e) {} return CNY_VND_DEFAULT; }
function curVnd(cur) {
  cur = cur || 'VND';
  // ¥ VÀ CNY LÀ CÙNG MỘT ĐỒNG TIỀN — nhân dân tệ. `cnyVnd()` đã giữ tỉ giá của nó rồi, nên
  // trả về đúng con số ấy thay vì đi tra `CUR_VND_DEFAULTS`.
  //
  // Thiếu dòng này là một lỗi im lặng và rất to: `CUR_VND_DEFAULTS` KHÔNG có khoá 'CNY', nên
  // nó rơi xuống mặc định 1 — tức là ¥1 = ₫1. Hậu quả ở `sellToCny`: giá bán của một dòng
  // 1688/Taobao bị chia cho 3.900 lần nữa, và cột "% giá bán" phồng lên gần bốn nghìn lần.
  // Bảng vẫn đẹp, vẫn có số, chỉ là không dòng 1688/Taobao nào còn xanh nổi.
  if (cur === 'CNY') return cnyVnd();
  try { const v = parseFloat(localStorage.getItem('rs_cost_curvnd_' + cur)); if (v > 0) return v; } catch (e) {}
  return CUR_VND_DEFAULTS[cur] != null ? CUR_VND_DEFAULTS[cur] : 1;
}
// NGƯỠNG XANH RƠI THEO BA BẬC, và thứ tự này là toàn bộ ý nghĩa của nó:
//
//   1. `rs_cost_thresh`  người dùng TỰ đặt trong modal Giá vốn        → luôn thắng
//   2. `rs_bu_thresh`    mặc định theo BU, server gửi lúc đăng nhập   → BU1 20%, còn lại 30%
//   3. `COST_THRESH_DEFAULT`                                          → chưa đăng nhập
//
// Bậc 1 phải đứng trên bậc 2, nếu không thì mỗi lần đăng nhập lại là thiết lập riêng của
// người dùng bị nuốt mất mà không có gì báo. Bậc 2 do `backend/lib/core/bu.py` tính chứ
// không tra ở đây — chép bảng BU→ngưỡng sang JavaScript nghĩa là thêm một BU phải nhớ sửa
// hai nơi, và nơi quên sửa sẽ hỏng im lặng (vẫn hiện một con số, chỉ là của BU khác).
function costThresh() {
  try {
    const rieng = parseFloat(localStorage.getItem('rs_cost_thresh'));
    if (rieng > 0) return rieng;
    const theoBu = parseFloat(localStorage.getItem('rs_bu_thresh'));
    if (theoBu > 0) return theoBu;
  } catch (e) { /* trình duyệt chặn localStorage → dùng mặc định */ }
  return COST_THRESH_DEFAULT;
}
// Giá bán đối thủ (tiền sàn) → quy ¥: price × ([nước]→₫) ÷ (¥→₫). Null nếu thiếu/không hợp lệ.
function sellToCny(cur, price) {
  if (price == null || !(price > 0)) return null;
  const cv = curVnd(cur), cy = cnyVnd();
  if (!(cv > 0) || !(cy > 0)) return null;
  return (price * cv) / cy;
}

// Cấu hình sàn: active = đã có adapter; regions = mảng nước (có region), [] = nội địa/toàn cầu
// (không chọn region), 'any' = lọc mọi nước (Facebook). Region động theo sàn đang chọn.
//
// THỨ TỰ NƯỚC LÀ CÓ CHỦ Ý: Việt Nam trước, rồi Philippines, rồi phần còn lại. Đây là hai thị
// trường đang làm thật, và thứ tự này không chỉ để đỡ phải tìm — nước ĐẦU TIÊN chính là nước
// được chọn sẵn khi bấm vào một sàn lần đầu (xem chỗ chọn sàn ở `renderPlatforms`). Đảo thứ
// tự là đảo luôn mặc định, nên đừng sắp lại theo bảng chữ cái cho "gọn".
const PLATFORMS = {
  shopee: { label: 'Shopee', active: true, regions: ['VN', 'PH', 'TH', 'ID', 'MY', 'SG', 'TW', 'BR', 'MX', 'CO', 'CL'] },
  tiktok: { label: 'TikTok Shop', active: true, regions: KD_REGIONS }, // dữ liệu Kalodata — xem `KD_REGIONS`
  // Facebook nằm CHUNG hàng chọn sàn như mọi nguồn khác. Trước đây nó bị tách ra một tab
  // riêng ("Content (FB Ads)") vì dữ liệu khác hẳn — quảng cáo đang chạy, không có giá,
  // không có lượt bán. Nhưng `fetchBackend` vốn đã chuẩn hoá nó về đúng hình dạng sản phẩm
  // và backend đã tự chấm điểm theo đời quảng cáo, nên nó chạy được ngay trong bảng chung.
  // Facebook ẩn khỏi chọn sàn tìm sản phẩm (theo yêu cầu) — luồng video FB (VID_SOURCES) vẫn giữ.
  // facebook: { label: 'Facebook', active: true, backend: true, regions: ['VN', 'US', 'GB', 'DE', 'FR', 'BR'] },
  amazon: { label: 'Amazon', active: true, regions: ['US', 'GB', 'DE', 'JP', 'FR', 'IT', 'ES', 'CA'] },
  // `searchMarket` = NƯỚC dùng để DỊCH từ khoá, cho sàn không có cột nước.
  //
  // Không có nước KHÔNG có nghĩa là không có ngôn ngữ, mà bản trước lại suy ra đúng như thế:
  // region '_' bị loại khỏi danh sách dịch, nên ô "Tự dịch từ khoá" tuy vẫn tích nhưng KHÔNG
  // làm gì cho ba sàn này — đúng ba sàn cần dịch nhất, vì không sàn nào nói tiếng Việt.
  //
  // Đo 2026-09-10 qua API production:
  //     etsy    "tai nghe" → 0 kết quả  ·  "earphones" → 5
  //     ali1688 "tai nghe" → 1 kết quả  ·  "蓝牙耳机"    → 10
  etsy: { label: 'Etsy', active: true, backend: true, regions: [], searchMarket: 'US' },
  taobao: { label: 'Taobao', active: true, experimental: true, regions: [], searchMarket: 'CN' },
  // 1688 chạy Ở SERVER (`backend/lib/ads/platforms/ali1688.py`), không qua tab: đo 2026-09-09
  // từ VPS, 15/15 lượt, trung vị ~1s. Nhờ vậy nó thoát hàng đợi tab dùng chung và chạy được cả
  // khi KHÔNG có máy-thợ nào online. Đường extension vẫn còn, làm DỰ PHÒNG — xem `fetch1688`.
  // Taobao thì KHÔNG port được: cổng h5search trả Baxia (RGV587) 100% lượt từ IP datacenter.
  ali1688: { label: '1688 (giá sỉ)', active: true, backend: true, regions: [], searchMarket: 'CN' },
  temu: { label: 'Temu', active: true, experimental: true, regions: ['US', 'GB', 'DE', 'FR', 'JP'] }, // gõ-search-trong-tab để bắn API rồi chộp
};

const loginStatus = {}; // "pf:CODE" -> true | false | undefined
// Mặc định KHÔNG chọn sàn nào — người dùng tự bấm sàn muốn chạy (chọn 1 → chạy 1, chọn nhiều →
// chạy nhiều). Trước đây Shopee được chọn sẵn; bỏ để khởi đầu là một bảng trắng, không giả định.
const selectedPlatforms = new Set();
// Sàn cần đăng nhập (Cách A) → check tức thì qua một cookie đặc trưng của phiên. Sàn công khai
// (Amazon) không có ở đây. Thêm sàn login = thêm 1 dòng {domain, cookie, ok}.
const LOGIN = {
  shopee: { domain: DOMAIN, cookie: 'SPC_U', ok: (v) => v && v !== '-' },
  // Kalodata không lộ cookie có tên ổn định để đọc — hỏi thẳng phiên qua một endpoint KHÔNG trừ
  // credit (`/user/features`, xem `extension/kalodata.js::kdStatus`).
  tiktok: { domain: KD_DOMAIN, status: 'RS_KD_STATUS' },
};
// Region chọn theo TỪNG sàn — key "pf:CODE". Mỗi sàn có bộ region riêng (Shopee 11 nước, Amazon
// 8 nước…) nên KHÔNG dùng chung một tập region; nhờ vậy Shopee-VN và Amazon-US độc lập với nhau.
// Rỗng lúc đầu — chưa có sàn nào được chọn nên chưa có nước. Khi user chọn một sàn có region,
// `updateRegionSection` tự thêm nước đầu tiên của sàn đó (giữ tối thiểu 1 nước/sàn để chạy được).
const selectedRegions = new Set();
function curOf(p) { return p.currency || CURRENCY[p.region] || 'VND'; }

// Các sàn (tab Sản phẩm) đang chọn mà CÓ region — để gom nhóm region theo sàn.
function regionPlatforms() {
  return [...selectedPlatforms].filter((p) => {
    const cfg = PLATFORMS[p];
    return cfg && Array.isArray(cfg.regions) && cfg.regions.length;
  });
}

function renderPlatforms() {
  const box = document.getElementById('platforms');
  if (!box) return;
  box.innerHTML = '';
  for (const [id, cfg] of Object.entries(PLATFORMS)) {
    const rg = cfg.regions === 'any' ? 'mọi nước' : (cfg.regions.length ? `${cfg.regions.length} nước` : 'nội địa/không region');
    const chip = document.createElement('button');
    chip.className = 'rgchip' + (cfg.active ? '' : ' dim');
    chip.dataset.pf = id;
    chip.dataset.on = selectedPlatforms.has(id) ? '1' : '0';
    chip.innerHTML = `<span class="tick" aria-hidden>✓</span>${esc(cfg.label)}`;
    chip.title = `${cfg.label} · ${rg}${cfg.active ? '' : ' — chưa hỗ trợ'}`;
    box.appendChild(chip);
  }
}

// Region đổi theo sàn: mỗi sàn có region là một NHÓM riêng. Giữ tối thiểu 1 region/sàn.
function updateRegionSection() {
  const pfs = regionPlatforms();
  const section = document.getElementById('regionSection');
  if (!pfs.length) { if (section) section.style.display = 'none'; return; } // Taobao/1688/Etsy → ẩn region
  if (section) section.style.display = ''; // trả về display của CSS (.step là block)
  // Bỏ region của sàn không còn được chọn.
  for (const key of [...selectedRegions]) if (!pfs.includes(key.split(':')[0])) selectedRegions.delete(key);
  // Mỗi sàn có region phải giữ tối thiểu 1 (mặc định nước đầu) để nó còn chạy được.
  for (const pf of pfs) {
    if (!PLATFORMS[pf].regions.some((c) => selectedRegions.has(`${pf}:${c}`))) selectedRegions.add(`${pf}:${PLATFORMS[pf].regions[0]}`);
  }
  renderRegions();
}

/**
 * Check đăng nhập qua cookie đặc trưng của sàn (Shopee: SPC_U), hoặc hỏi thẳng phiên với sàn
 * đăng nhập một lần cho mọi nước (TikTok Shop: phiên Kalodata — `checkLoginByStatus`).
 *
 * BA trạng thái, không phải hai — và đây là chỗ đã sai:
 *
 *     true       đọc được cookie, còn hạn  → đã đăng nhập
 *     false      đọc được, KHÔNG có cookie → chưa đăng nhập
 *     undefined  KHÔNG ĐỌC ĐƯỢC           → chưa biết
 *
 * Bản trước gộp hai cái sau làm một: mọi lỗi đều thành `false`. Mà lượt hỏi này đi qua máy-thợ,
 * nên chỉ cần thợ bận, hết giờ, hay mạng chớp một cái là nước ấy hiện ✕ — trong khi máy-thợ vẫn
 * đang đăng nhập shopee.vn bình thường. Người dùng thấy ✕ thì tin là mình chưa đăng nhập, còn
 * `research()` thì BỎ QUA sàn có `loginStatus === false`, nên một lần chớp mạng thành ra một sàn
 * không bao giờ chạy.
 *
 * `undefined` hiện dấu … và KHÔNG chặn `research()` — chưa biết thì cứ thử, sàn tự báo lại.
 */
async function checkLogin(pf, code) {
  const spec = LOGIN[pf];
  const domain = spec && spec.domain[code];
  if (!domain) return undefined;
  if (spec.status) return checkLoginByStatus(spec.status);
  try {
    const r = await dispatch({ type: 'RS_COOKIE', url: `https://${domain}/`, name: spec.cookie });
    if (!r || r.ok === false || r.blocked) return undefined; // hỏi không tới nơi
    const c = r.cookie;
    return !!(c && c.value && spec.ok(c.value));
  } catch (e) {
    return undefined;
  }
}
/*
 * PHIÊN CHUNG CHO MỌI NƯỚC — hỏi một lần, dùng cho cả loạt.
 *
 * `refreshLogin` gọi `checkLogin` cho TỪNG nước. Với Kalodata đó là 15 lượt hỏi giống hệt nhau,
 * đi chung hàng đợi với lượt crawl người dùng đang chờ (và qua máy-thợ thì còn chậm hơn). Nhớ
 * đúng một lời hứa trong 30 giây: các nước sau đợi chung câu trả lời của nước đầu.
 *
 * Ba trạng thái như `checkLogin`: `loggedIn` null (lỗi mạng) → undefined, KHÔNG thành ✕.
 */
const _phienChung = {};
function checkLoginByStatus(type) {
  const nho = _phienChung[type];
  if (nho && Date.now() - nho.at < 30000) return nho.p;
  const p = dispatch({ type })
    .then((r) => {
      if (!r || r.ok === false || r.blocked) return undefined;
      return r.loggedIn === true ? true : r.loggedIn === false ? false : undefined;
    })
    .catch(() => undefined);
  _phienChung[type] = { at: Date.now(), p };
  return p;
}
let _dangCheckLogin = false;

async function refreshLogin({ tuDong = false } = {}) {
  if (_dangCheckLogin) return; // lượt trước chưa xong — chồng lên nhau chỉ làm hàng đợi nghẽn
  // Lượt TỰ ĐỘNG nhường đường cho lượt Research đang chạy: mỗi lần kiểm là 11-19 lượt hỏi, và
  // chúng đi chung một hàng đợi với chính cú crawl mà người dùng đang ngồi chờ. Bấm ⟳ tay thì
  // vẫn chạy — đó là người dùng chủ động đổi ý ưu tiên.
  if (tuDong && $('go') && $('go').disabled) return;
  _dangCheckLogin = true;
  try {
    renderRegions();
    for (const pf of regionPlatforms()) {
      if (!LOGIN[pf]) continue; // sàn công khai (Amazon) không cần check
      for (const code of PLATFORMS[pf].regions) {
        if (!LOGIN[pf].domain[code]) continue;
        loginStatus[`${pf}:${code}`] = await checkLogin(pf, code);
        renderRegions();
      }
    }
  } finally {
    _dangCheckLogin = false;
  }
}

/*
 * TỰ KIỂM TRA LẠI, ĐỀU ĐẶN.
 *
 * Trạng thái đăng nhập là của MÁY KHÁC (máy-thợ), nên nó đổi mà trang này không hề hay biết:
 * ai đó đăng nhập lại, phiên hết hạn, thợ vừa online. Trước đây chỉ hỏi đúng một lần lúc mở
 * trang, nên một dấu ✕ chụp được từ lúc đó nằm lại đấy cả buổi — kể cả sau khi máy-thợ đã đăng
 * nhập xong. Nút ⟳ có sẵn, nhưng phải biết mà bấm mới dùng được.
 *
 * KHÔNG chạy khi tab đang ẩn: mỗi lượt là 11-19 lần hỏi máy-thợ, và một tab để quên trong nền
 * cả ngày sẽ ăn hết lượt của người đang thật sự dùng. Quay lại tab thì hỏi lại ngay.
 */
const LOGIN_RECHECK_MS = 60_000;
setInterval(() => {
  if (document.visibilityState === 'visible') void refreshLogin({ tuDong: true });
}, LOGIN_RECHECK_MS);
document.addEventListener('visibilitychange', () => {
  if (document.visibilityState === 'visible') void refreshLogin({ tuDong: true });
});

// Vẽ nước theo NHÓM sàn, dùng đúng dáng chip của bước 1 — chọn nước và chọn sàn là cùng một
// thao tác, nên không bắt người dùng học hai kiểu điều khiển.
//
// Từng thử ô thả xuống "+ Thêm nước" để đỡ rối khi Shopee có 11 nước. Bỏ, vì nó giấu mất thứ
// đang có: nhìn vào không biết ngay còn chọn được nước nào, phải mở ra mới thấy. Chip hiện hết
// thì tốn hai hàng, nhưng đọc một lượt là xong.
/*
 * Nước của MỘT sàn = một nút gọn + một bảng thả xuống có cuộn.
 *
 * `rgOpen` giữ sàn nào đang mở, và nó phải là BIẾN NGOÀI hàm chứ không phải trạng thái nằm
 * trong DOM: `refreshLogin` gọi `renderRegions()` lại sau MỖI nước nó kiểm (11-19 lượt, mỗi
 * lượt một lần vẽ). Nếu trạng thái mở nằm trong DOM thì bảng đang mở sẽ tự đóng giữa chừng
 * ngay dưới tay người dùng.
 */
let rgOpen = null;

function renderRegions() {
  const box = document.getElementById('regions');
  if (!box) return;
  box.innerHTML = '';
  const pfs = regionPlatforms();
  if (rgOpen && !pfs.includes(rgOpen)) rgOpen = null; // sàn vừa bị bỏ chọn

  for (const pf of pfs) {
    const cfg = PLATFORMS[pf];
    const chon = cfg.regions.filter((c) => selectedRegions.has(`${pf}:${c}`));
    const mo = rgOpen === pf;

    // Câu trả lời nằm SẴN trên nút: một nước thì hiện tên nước, nhiều thì đếm. Người dùng
    // không phải mở ra mới biết mình đang chọn gì.
    const tomTat = chon.length === 0
      ? 'chọn nước'
      : chon.length === 1
        ? `${FLAG[chon[0]] || ''} ${COUNTRY[chon[0]] || chon[0]}`
        : `${chon.length} nước`;
    // Cảnh báo trên nút chỉ tính các nước ĐANG CHỌN — một nước chưa đăng nhập mà không ai
    // chọn thì không phải việc của người dùng lúc này.
    const loi = chon.some((c) => LOGIN[pf] && LOGIN[pf].domain[c] && loginStatus[`${pf}:${c}`] === false);

    const wrap = document.createElement('div');
    wrap.className = 'rgsel';
    wrap.dataset.pf = pf;
    wrap.innerHTML =
      `<button class="rgtrigger" data-pf="${pf}" aria-expanded="${mo}" aria-haspopup="listbox">` +
      `<span class="rgname">${esc(cfg.label)}</span>` +
      `<span class="rgval">${esc(tomTat)}</span>` +
      (loi ? '<span class="no" title="Có nước đang chọn chưa đăng nhập">✕</span>' : '') +
      '<i aria-hidden>▾</i></button>';

    if (mo) {
      const panel = document.createElement('div');
      panel.className = 'rgpanel';
      const list = cfg.regions.map((code) => {
        const canLogin = !!(LOGIN[pf] && LOGIN[pf].domain[code]);
        const st = loginStatus[`${pf}:${code}`];
        const badge = !canLogin
          ? '<span class="sub" title="Sàn công khai, không cần đăng nhập">🌐</span>'
          : st === true ? '<span class="ok" title="Đã đăng nhập">✓</span>'
            : st === false ? '<span class="no" title="Chưa đăng nhập">✕</span>'
              : '<span class="sub" title="Đang kiểm tra…">…</span>';
        const on = selectedRegions.has(`${pf}:${code}`);
        return `<button class="rgopt" role="option" aria-selected="${on}" data-pf="${pf}" data-code="${code}" data-on="${on ? '1' : '0'}">` +
          `<span class="tick" aria-hidden>✓</span>` +
          `<span class="rgflag">${FLAG[code] || ''}</span>` +
          `<span class="rgcty">${esc(COUNTRY[code] || code)}</span>${badge}</button>`;
      }).join('');
      panel.innerHTML =
        `<div class="rglist" role="listbox">${list}</div>` +
        '<div class="rgfoot">' +
        '<span>Tick nước muốn chạy</span>' +
        '<button class="rgdone">Xong</button></div>';
      wrap.appendChild(panel);
    }
    box.appendChild(wrap);
  }
}
const PAGE_SIZE = 60;

const $ = (id) => document.getElementById(id);
let rows = [];
let sortKey = 'score';

function esc(s) { return String(s == null ? '' : s).replace(/</g, '&lt;').replace(/"/g, '&quot;'); }
function setStatus(msg, kind) { $('statusText').textContent = msg; $('status').className = 'status' + (kind ? ' ' + kind : ''); }
function fmtInt(n) { return typeof n === 'number' ? n.toLocaleString('vi-VN') : '—'; }
// Đồng tiền nào có KÝ HIỆU mà cả tool đã dùng sẵn thì viết bằng ký hiệu ấy, không viết mã ISO.
//
// Chỉ có CNY, và nó có mặt ở đây vì một lý do cụ thể: cột "Giá vốn 1688" viết `¥13`, còn cột
// "Giá đối thủ" ngay bên cạnh lại viết `13 CNY` cho ĐÚNG cùng một đồng tiền trên cùng một
// dòng. Người đọc bảng không có cách nào biết đó là một thứ, và sẽ đi tìm tỉ giá giữa hai
// cái không tồn tại. (`curTuChu` đã coi `¥` là CNY từ trước — chỗ này chỉ nói cho khớp.)
const CUR_SYMBOL = { CNY: '¥' };
function fmtPrice(v, cur) {
  if (v == null) return '—';
  const so = v.toLocaleString('vi-VN');
  return CUR_SYMBOL[cur] ? CUR_SYMBOL[cur] + so : so + ' ' + cur;
}

/**
 * GIÁ ĐEM RA DÙNG — cận TRÊN khi sàn có trả, không thì con số duy nhất nó cho.
 *
 * Sàn nào cũng chỉ đưa MỘT con số lên thẻ tìm kiếm, và con số đó là của biến thể RẺ NHẤT. Một
 * listing áo có thể kèm biến thể 1-2k (dây buộc, sticker, "mẫu thử") — cố ý, để tụt lên đầu
 * bảng sắp theo giá; bấm vào chọn đúng cái áo thì 99k.
 *
 * Nên khi có cả cặp min/max, cái đáng đọc là MAX: nó gần với giá phải trả cho món hàng thật.
 *
 * MỘT hàm cho cả ba chỗ — hiện, sắp xếp, và so với giá vốn. Tách ra ba chỗ tự tính là kiểu lỗi
 * khó thấy nhất: cột hiện 99k mà sort lại xếp theo 2k, nhìn ra đúng như bảng bị sắp sai.
 */
function giaDung(p) {
  if (p.priceMax != null) return p.priceMax;
  return p.price != null ? p.price : null;
}

/**
 * Ô GIÁ.
 *
 *   có cả min/max  →  99.000 VND  +  dòng nhỏ "thấp nhất 2.000 VND"
 *   chỉ biết là cận dưới  →  "từ 6,7 GBP"   (Etsy `has_variations`, TikTok `recommend_price_low`)
 *   giá đơn        →  50 USD               (như cũ)
 *
 * Giữ lại cận dưới ở dòng nhỏ chứ không vứt: khoảng cách giữa hai đầu chính là dấu hiệu người
 * bán đang gắn biến thể mồi — 2k↔99k nói nhiều hơn bất kỳ con số đơn nào.
 */
/*
 * BA Ô CHỈ SỐ — mỗi ô tự nói con số của nó là của AI.
 *
 * Cùng một cột, các sàn đưa những thứ khác nhau về bản chất. Để chúng nằm cạnh nhau không nhãn
 * là mời người đọc so sánh sai:
 *
 *   Bán/tháng   Shopee/Amazon = số bán thật · Etsy = LƯỢT XEM (sàn giấu số bán theo sản phẩm)
 *   Tổng bán    Shopee/Temu   = số bán thật · Etsy = số bán của cả SHOP
 *   Rating      Shopee/Amazon = của sản phẩm · Etsy/1688 = của SHOP
 *
 * Một shop 4,9★ vẫn bán được mẫu tệ, và một shop 800 đơn không nói gì về mẫu đang xem — nó có
 * thể là mẫu ế nhất trong 68 mẫu.
 */
function demandCell(p) {
  if (p.monthly != null) return `<td class="num">${fmtInt(p.monthly)}</td>`;
  if (p.views != null) {
    return `<td class="num"><span title="Lượt xem trang sản phẩm — sàn này không công bố số bán theo sản phẩm">${fmtInt(p.views)}</span>` +
      `<div class="sub">lượt xem</div></td>`;
  }
  return '<td class="num">—</td>';
}

function soldCell(p) {
  if (p.sold == null) return '<td class="num">—</td>';
  const nhan = p.soldIsShop ? '<div class="sub" title="Tổng đã bán của cả SHOP, không phải của sản phẩm này">của shop</div>' : '';
  return `<td class="num">${fmtInt(p.sold)}${nhan}</td>`;
}

function ratingCell(p) {
  if (p.rating == null) return '<td class="num">—</td>';
  const so = p.ratingCount != null ? fmtInt(p.ratingCount) : '';
  const nhan = p.ratingIsShop
    ? `<div class="sub" title="Điểm trung bình của SHOP — sàn này không có rating theo từng sản phẩm">${so ? so + ' · ' : ''}shop</div>`
    : (so ? `<div class="sub">${so}</div>` : '');
  return `<td class="num">${p.rating.toFixed(1)}★${nhan}</td>`;
}

function priceCell(p) {
  const cur = curOf(p);
  const co = p.priceMax != null;
  const chinh = co
    ? fmtPrice(p.priceMax, cur)
    : p.price == null ? '—' : (p.priceFrom ? 'từ ' : '') + fmtPrice(p.price, cur);
  // Ô TRỐNG PHẢI TỰ NÓI VÌ SAO. Một dấu "—" trần đọc thành "tool không lấy được", trong khi
  // phần lớn trường hợp là SÀN không hiện giá: hàng hết, hàng "See options", hoặc — đo được
  // trên Amazon 2026-09-08 — món đó không giao tới nước mà sàn đang nhận diện. Ở những dòng
  // ấy không có giá nào để lấy, và điền đại con số gần nhất trên trang là điền giá của một
  // sản phẩm khác.
  const tip = co
    ? 'Giá của biến thể ĐẮT NHẤT — sàn chỉ hiện cái rẻ nhất trên thẻ tìm kiếm.'
    : p.price == null
      ? 'Sàn không hiện giá cho sản phẩm này — thường là hết hàng, phải chọn phiên bản, hoặc không giao tới nước đang chọn. Bấm vào tên để xem trên sàn.'
      : p.priceFrom
        ? 'Giá của biến thể rẻ nhất — sản phẩm chính thường cao hơn. Bấm vào tên để xem giá thật.'
        : '';
  const phu = co && p.price != null && p.price < p.priceMax
    ? `<div class="sub">thấp nhất ${esc(fmtPrice(p.price, cur))}</div>`
    : '';
  const gach = p.strike ? `<div class="sub strike">${fmtInt(p.strike)}</div>` : '';
  return `<span class="price"${tip ? ` title="${esc(tip)}"` : ''}>${esc(chinh)}</span>${phu}${gach}`;
}

// 1234 → "1,2K" · 12345 → "12,3K" · 1234567 → "1,2M". Số nhỏ giữ nguyên (dễ đọc).
function fmtCompact(n) {
  if (typeof n !== 'number' || !isFinite(n) || n < 0) return '';
  if (n < 1000) return String(n);
  if (n < 1_000_000) return (n / 1000).toFixed(n < 10_000 ? 1 : 0).replace('.', ',') + 'K';
  return (n / 1_000_000).toFixed(n < 10_000_000 ? 1 : 0).replace('.', ',') + 'M';
}
// Unix giây → "hôm nay" / "hôm qua" / "N ngày trước" / "N tháng trước" / "N năm trước".
function fmtRelDate(unixSec) {
  if (typeof unixSec !== 'number' || unixSec < 1_000_000_000) return '';
  const days = Math.max(0, Math.floor((Date.now() / 1000 - unixSec) / 86400));
  if (days === 0) return 'hôm nay';
  if (days === 1) return 'hôm qua';
  if (days < 30) return days + ' ngày trước';
  if (days < 365) return Math.floor(days / 30) + ' tháng trước';
  return Math.floor(days / 365) + ' năm trước';
}
function imageUrl(region, hash) { return hash ? `https://down-${IMG_REGION[region] || 'vn'}.img.susercontent.com/file/${hash}` : ''; }
// Gỡ lớp proxy `/api/media?url=` để lấy lại URL CDN GỐC — backend /match-image cần url thật của
// ảnh sản phẩm (nó tự bọc Referer khi tải). Ảnh Shopee/Amazon vốn đã là url gốc nên trả nguyên.
function rawImg(url) {
  const pfx = `${BACKEND}/api/media?url=`;
  return url && url.startsWith(pfx) ? decodeURIComponent(url.slice(pfx.length)) : (url || '');
}
function clamp(v) { return Math.max(0, Math.min(100, Math.round(v))); }
function compactNum(n) { return n >= 1e6 ? (n / 1e6).toFixed(1).replace(/\.0$/, '') + 'M' : n >= 1e3 ? Math.round(n / 1e3) + 'k' : String(Math.round(n)); }
// Dòng phụ dưới điểm: sàn có GMV (TikTok Shop) → "cầu · GMV"; sàn có rating → "cầu · chất".
// GMV XÉT TRƯỚC: Kalodata trả CẢ rating lẫn doanh thu, và "chất" của TikTok Shop tính theo doanh
// thu (xem `score`) — dòng phụ phải gọi đúng tên thứ đã dùng để chấm.
function scoreSub(p) {
  if (p.gmv != null) return `cầu ${p.score.demand} · GMV ${compactNum(p.gmv)}`;    // TikTok Shop
  if (p.rating != null) {
    const base = `cầu ${p.score.demand} · chất ${p.score.quality}`; // Shopee/Amazon/1688
    return p.repurchase != null ? `${base} · quay lại ${p.repurchase}%` : base; // 1688 thêm 回头率
  }
  return `cầu ${p.score.demand}`;
}

// Giá vốn = giá thấp nhất trong danh sách sản phẩm tương tự. Tính lười theo từng dòng.
const costCache = {}; // itemid -> số (đã /PRICE_SCALE) hoặc 'none'

// Giá vốn 1688 lấy từ MODAL (tìm theo ảnh) — cột "Giá vốn 1688" ở bảng chính đọc cái này.
// Key = URL ảnh gốc của dòng (rawImg), khớp với data-img nút 💰 và ảnh dùng để tra 1688.
// Value = giá sỉ rẻ nhất (¥/CNY). Bảng quy ra ₫ + % theo tỉ giá/ngưỡng hiện tại (costRate/costThresh).
const cost1688 = {}; // imgUrl -> giá ¥ rẻ nhất

// Ô cột "Giá vốn 1688": hiện ₫ (¥×tỉ giá) + % (₫/giá bán). Dưới ngưỡng → class 'cheap' (xanh).
// Chưa tra (chưa bấm 💰 dòng đó) → '—'. Trả { html, cheap } để tô cả ô.
function cost1688Cell(p) {
  const cny = cost1688[rawImg(p.image)];
  // Chưa tra (undefined) hoặc đã tra nhưng không ra ('none') → '—'. Chỉ số ¥ mới tính ₫/%.
  if (typeof cny !== 'number') return { html: '<span class="sub" title="Bấm 💰 Giá vốn ở cột Thao tác, hoặc nút Giá vốn hàng loạt">—</span>', cheap: false };
  const thresh = costThresh();
  const sellCny = sellToCny(curOf(p), giaDung(p)); // giá bán đối thủ quy về ¥ (qua ₫) — cùng con số cột Giá bán đang hiện
  const ratio = sellCny ? (cny / sellCny) * 100 : null; // % = giá vốn ¥ ÷ giá bán ¥
  const cheap = ratio != null && ratio < thresh;
  const ratioHtml = ratio != null ? `<div class="costratio${cheap ? ' cheap' : ''}">${ratio.toFixed(1)}% giá bán</div>` : '';
  const tip = sellCny ? `giá bán đối thủ ≈ ¥${sellCny.toFixed(1)}` : 'giá vốn 1688 rẻ nhất';
  return { html: `<span class="price" title="${tip}">¥${cny}</span>${ratioHtml}`, cheap };
}
function cost1688Td(p) { const c = cost1688Cell(p); return `<td class="num costcell${c.cheap ? ' cheap' : ''}">${c.html}</td>`; }

// Gom mọi trường `price` (giá bán, đơn vị ×100000) trong JSON find_similar rồi lấy min.
function collectPrices(node, out) {
  if (!node || typeof node !== 'object') return;
  if (Array.isArray(node)) { for (const x of node) collectPrices(x, out); return; }
  for (const k in node) {
    const v = node[k];
    if (k === 'price' && typeof v === 'number' && v > 100000) out.push(v);
    else if (v && typeof v === 'object') collectPrices(v, out);
  }
}

function costValueHtml(cost, price, cur) {
  let note = '';
  if (price && cost < price) note = `<div class="sub" style="color:var(--good)">biên ${Math.round((1 - cost / price) * 100)}%</div>`;
  else if (price && cost >= price) note = '<div class="sub" style="color:var(--disc)">≥ giá bán</div>';
  return `<span class="price" title="Giá vốn = rẻ nhất từ Sản phẩm tương tự">${fmtPrice(cost, cur)}</span>${note}`;
}

function costCellHtml(p) {
  const c = costCache[p.itemid];
  if (typeof c === 'number') return costValueHtml(c, giaDung(p), curOf(p)); // giá vốn từ find_similar — so với đúng số cột Giá bán đang hiện
  if (c === 'none') return '<span class="sub">—</span>';
  return '<span class="sub">…</span>'; // đang/chờ batch tính
}

function productById(itemid) { return rows.find((p) => p.itemid === itemid); }

function searchUrl(domain, keyword, offset) {
  const q = new URLSearchParams({ by: 'sales', keyword, limit: String(PAGE_SIZE), newest: String(offset), order: 'desc', page_type: 'search', scenario: 'PAGE_GLOBAL_SEARCH', version: '2' });
  return `https://${domain}/api/v4/search/search_items?${q.toString()}`;
}

// Dò link VIDEO trong item sản phẩm (không cần biết field chính xác): duyệt cây, bắt URL video
// (.mp4/.m3u8/cloud.video/…). Trả '' nếu response search không có video (chỉ ở trang chi tiết).
function findVideoUrl(o, depth) {
  depth = depth || 0;
  if (o == null || depth > 6) return '';
  if (typeof o === 'string') {
    return /^(https?:)?\/\//.test(o) && /\.mp4(\?|$)|\.m3u8|cloud\.video|\/video\/|video_url|\/vod\//i.test(o) ? (o.indexOf('//') === 0 ? 'https:' + o : o) : '';
  }
  if (Array.isArray(o)) { for (var i = 0; i < o.length; i++) { var v = findVideoUrl(o[i], depth + 1); if (v) return v; } return ''; }
  if (typeof o === 'object') {
    for (var k in o) { if (/video/i.test(k)) { var vk = findVideoUrl(o[k], depth + 1); if (vk) return vk; } }
    for (var k2 in o) { var v2 = findVideoUrl(o[k2], depth + 1); if (v2) return v2; }
  }
  return '';
}

// Shopee: SP có video (nút ▶ trên thumbnail) → dữ liệu video nằm trong `video_info_list` (ở
// item_card_displayed_asset / item_basic / item_data). URL mp4 thường ở default_format.url.
// Tìm nhánh video_info_list bất kỳ trong item, ưu tiên URL trông như video, rồi mới URL đầu tiên.
function shopeeVideoUrl(it) {
  let best = '', first = '';
  (function walk(o, d) {
    if (o == null || d > 7) return;
    if (Array.isArray(o)) { o.forEach((x) => walk(x, d + 1)); return; }
    if (typeof o !== 'object') return;
    for (const k in o) {
      if (/video[_-]?info[_-]?list|videoInfoList/i.test(k) && o[k]) {
        (function grab(v, dd) {
          if (v == null || dd > 5) return;
          if (typeof v === 'string' && /^(https?:)?\/\//.test(v)) {
            const u = v.indexOf('//') === 0 ? 'https:' + v : v;
            if (/\.mp4|\/vod\/|\.m3u8|video/i.test(u)) { if (!best) best = u; }
            else if (!first) first = u;
            return;
          }
          if (Array.isArray(v)) v.forEach((x) => grab(x, dd + 1));
          else if (typeof v === 'object') for (const kk in v) grab(v[kk], dd + 1);
        })(o[k], 0);
      }
      walk(o[k], d + 1);
    }
  })(it, 0);
  return best || first || findVideoUrl(it);
}

function parseItem(it, region, domain) {
  const asset = it.item_card_displayed_asset || {};
  const idata = it.item_data || {};
  const basic = it.item_basic || {};
  const itemid = it.itemid || idata.itemid, shopid = it.shopid || idata.shopid;
  if (itemid == null || shopid == null) return null;

  const dp = idata.item_card_display_price || asset.display_price || {};
  const rawPrice = dp.price ?? basic.price;
  const price = typeof rawPrice === 'number' && rawPrice > 0 ? rawPrice / PRICE_SCALE : null;
  // GIÁ TRÊN THẺ LÀ GIÁ CỦA BIẾN THỂ RẺ NHẤT.
  //
  // Một listing áo có thể kèm một biến thể 1-2k (dây, sticker, "mẫu thử") — cố ý, để tụt lên
  // đầu bảng sắp theo giá. Thẻ tìm kiếm chỉ hiện con số ấy, còn bấm vào chọn đúng cái áo thì
  // lên 99k. Cột giá của tool đọc y hệt thẻ, nên nó chép lại đúng cái bẫy đó.
  //
  // Shopee có kèm cận trên hay không thì TÙY response, nên đọc theo kiểu "có thì dùng": tìm cặp
  // min/max ở cả `item_basic` lẫn khối giá của thẻ. Không có thì mọi thứ giữ nguyên như cũ —
  // thêm chỗ này không làm hỏng lượt nào đang chạy được.
  const soGia = (v) => (typeof v === 'number' && v > 0 ? v / PRICE_SCALE : null);
  const min = soGia(basic.price_min ?? dp.price_min);
  const max = soGia(basic.price_max ?? dp.price_max);
  const priceMax = max != null && min != null && max > min ? max : null;
  const rawStrike = dp.strikethrough_price;
  const strike = typeof rawStrike === 'number' && rawStrike > 0 ? rawStrike / PRICE_SCALE : null;
  let discount = typeof dp.discount === 'number' ? dp.discount : null;
  if (discount == null && strike && price && strike > price) discount = Math.round((1 - price / strike) * 100);

  const sc = idata.item_card_display_sold_count || {};
  const monthly = typeof sc.monthly_sold_count === 'number' ? sc.monthly_sold_count : null;
  const sold = sc.historical_sold_count ?? basic.historical_sold ?? basic.sold ?? null;

  const rb = idata.item_rating || {};
  const rating = typeof rb.rating_star === 'number' && rb.rating_star > 0 ? rb.rating_star : null;
  const ratingCount = Array.isArray(rb.rating_count) && typeof rb.rating_count[0] === 'number' ? rb.rating_count[0] : null;

  const catid = idata.catid || (Array.isArray((idata.global_cat || {}).catid) ? idata.global_cat.catid[0] : null);

  return {
    platform: 'Shopee', region, currency: CURRENCY[region],
    itemid: String(itemid), shopid: String(shopid), catid,
    name: asset.name || basic.name || '',
    image: imageUrl(region, asset.image || (Array.isArray(asset.images) ? asset.images[0] : '') || basic.image),
    price, priceMax, priceFrom: priceMax != null, strike, discount, monthly, sold, rating, ratingCount,
    videoUrl: shopeeVideoUrl(it), // video sản phẩm Shopee (video_info_list) nếu SP có ▶
    shop: (idata.shop_data || {}).shop_name || asset.shop_location || '',
    isAd: !!it.adsid,
    link: `https://${domain}/product/${shopid}/${itemid}`,
    similarUrl: catid ? `https://${domain}/find_similar_products?catid=${catid}&itemid=${itemid}&shopid=${shopid}` : `https://${domain}/product/${shopid}/${itemid}`,
  };
}

// Chấm điểm sản phẩm — soi gương backend _score_product.
function score(p) {
  let demand, quality;
  if (p.monthly != null) demand = clamp(Math.log10(Math.max(1, p.monthly)) / 4 * 100);
  else if (p.sold != null) demand = clamp(Math.log10(Math.max(1, p.sold)) / 5.5 * 100);
  else if (p.ratingCount != null) demand = clamp(Math.log10(Math.max(1, p.ratingCount)) / 5 * 100); // Amazon: số review làm proxy cầu (không có sold)
  else if (p.repurchase != null) demand = clamp(p.repurchase); // 1688: 回头率 (% khách quay lại) làm proxy cầu
  else demand = 0;
  if (p.gmv != null) {
    // TikTok Shop: "chất" = doanh thu 30 ngày (Kalodata), quy về USD để so được giữa các nước,
    // rồi log10 (doanh thu trải nhiều bậc). Mốc: $100→25, $1k→50, $10k→75, $100k→100.
    //
    // ĐỨNG TRƯỚC rating: rating TikTok gần như ai cũng 4,7-4,9★ nên không phân biệt được gì,
    // còn một sản phẩm 5★ mà 0 đồng doanh thu thì không được chấm "chất" 100. Sàn khác không
    // gắn `gmv`, nên thứ tự này không đổi điểm của Shopee/Amazon/1688.
    const usd = p.gmv * (FX_USD[curOf(p)] || 0.02);
    quality = clamp((Math.log10(Math.max(1, usd)) - 1) / 4 * 100);
  } else if (p.rating != null) {
    const base = clamp((p.rating - 3.0) / 2.0 * 100);
    // Shopee/Amazon/Etsy: chiết khấu theo số review. 1688 (điểm shop tổng hợp, không có ratingCount) → tin luôn.
    const trust = p.ratingCount != null ? Math.min(1, Math.log10((p.ratingCount || 0) + 1) / 2) : 1;
    quality = clamp(base * trust);
  } else quality = 0;
  return { total: clamp(demand * 0.6 + quality * 0.4), demand, quality };
}

function sendFetch(requests) {
  return new Promise((resolve) => chrome.runtime.sendMessage({ type: 'RS_FETCH', requests }, (r) => resolve((r && r.responses) || [])));
}

// Lấy sản phẩm Shopee cho MỘT từ khoá. Trả {products, blocked}.
// CÁCH NHANH (mặc định): fetch same-origin search_items NGAY TRONG tab shopee đã đăng nhập
// (RS_FETCH → fetchInTab). Tab chỉ ở trang chính `https://{domain}/`, KHÔNG điều hướng tới /search —
// nên 1 tab/region, trả JSON thẳng ~1-2s. Nếu Shopee 403 (siết anti-bot) mới hạ xuống cách điều
// hướng /search (searchShopeeNav) làm dự phòng.
async function fetchKeyword(keyword, region, count) {
  const domain = DOMAIN[region];
  const seen = new Set();
  const products = [];
  let rawItemCount = 0, hardBlock = false, blockMsg = '';
  const pages = Math.max(1, Math.ceil(count / PAGE_SIZE));
  for (let page = 0; page < pages; page++) {
    const url = searchUrl(domain, keyword, page * PAGE_SIZE);
    const res = await sendFetch([{ url, method: 'GET', headers: { 'x-api-source': 'pc' }, tag: 'shopee' }]);
    const r = res && res[0];
    if (!r) break;
    // Không mở được tab đăng nhập → không phải 403, báo rõ để user mở shopee.vn.
    if (/^NO_TAB|^INJECT_FAIL/.test(String(r.text || ''))) {
      return { products: [], blocked: true, notice: 'Shopee: chưa mở được tab shopee — mở shopee.vn (đăng nhập) rồi bấm lại.' };
    }
    if (r.status === 403 || r.status === 401) { hardBlock = true; break; } // siết anti-bot → thử cách điều hướng
    let data; try { data = JSON.parse(r.text); } catch { continue; }
    if (data.error && data.error !== 0) { hardBlock = true; break; } // JSON báo lỗi (login/verify) → dự phòng
    const items = data.items || (data.data || {}).items || [];
    rawItemCount += items.length;
    for (const it of items) {
      const p = parseItem(it, region, domain);
      if (!p || seen.has(p.itemid)) continue;
      seen.add(p.itemid);
      p.keyword = keyword;
      p.score = score(p);
      products.push(p);
      if (products.length >= count) break;
    }
    if (products.length >= count || items.length === 0) break;
  }
  if (products.length) return { products, blocked: false };

  // Fetch thẳng bị chặn/rỗng → DỰ PHÒNG: điều hướng tab tới /search cho trang tự gọi (chậm hơn).
  if (hardBlock || !rawItemCount) {
    const nav = await fetchKeywordNav(keyword, region, count);
    if (nav.products.length || nav.blocked) return nav;
  }
  const notice = rawItemCount > 0
    ? `Shopee: có ${rawItemCount} item thô nhưng parse ra 0 — Shopee vừa đổi cấu trúc dữ liệu.`
    : `Shopee: chưa lấy được sản phẩm — kiểm tra đăng nhập ${DOMAIN[region] || 'shopee.vn'} rồi thử lại.`;
  return { products: [], blocked: false, notice };
}

// DỰ PHÒNG: cách điều hướng tab tới /search?keyword (background searchShopee) — dùng khi fetch thẳng
// bị 403. Chậm hơn (chờ render + cuộn) nên chỉ chạy khi cách nhanh thất bại.
async function fetchKeywordNav(keyword, region, count) {
  const domain = DOMAIN[region];
  const res = await new Promise((r) => chrome.runtime.sendMessage({ type: 'RS_SHOPEE', keyword, domain }, (x) => r(x)));
  if (!res || !res.ok) return { products: [], blocked: false, notice: 'Shopee: không lấy được dữ liệu — thử lại.' };
  if (res.blocked) return { products: [], blocked: true, notice: `Shopee: ${res.error || 'bị chặn / chưa đăng nhập'}` };
  const videoMap = {};
  for (const v of (res.videoItems || [])) videoMap[String(v.itemid)] = v.url;
  const seen = new Set();
  const products = [];
  let rawItemCount = 0;
  for (const text of (res.texts || [])) {
    let data; try { data = JSON.parse(text); } catch { continue; }
    const items = data.items || (data.data || {}).items || [];
    rawItemCount += items.length;
    for (const it of items) {
      const p = parseItem(it, region, domain);
      if (!p || seen.has(p.itemid)) continue;
      if (videoMap[p.itemid]) p.videoUrl = videoMap[p.itemid];
      seen.add(p.itemid);
      p.keyword = keyword;
      p.score = score(p);
      products.push(p);
      if (products.length >= count) break;
    }
    if (products.length >= count) break;
  }
  let notice;
  if (!products.length) {
    notice = rawItemCount > 0
      ? `Shopee: có ${rawItemCount} item thô nhưng parse ra 0 — Shopee vừa đổi cấu trúc dữ liệu.`
      : (res.error || 'Shopee: chưa lấy được sản phẩm — thử lại (để tab shopee tự cuộn, đừng rời).');
  }
  return { products, blocked: false, notice };
}

/**
 * Ký hiệu/mã tiền trên thẻ → mã ISO. `null` nếu không nhận ra (nơi gọi giữ mặc định của nước).
 *
 * Cần vì Amazon đổi tiền theo địa chỉ giao hàng nó đoán từ IP, không theo tên miền. Máy-thợ
 * ngồi ở Việt Nam nên amazon.com trả "VND 693,173" — xem ghi chú ở `background.js`.
 */
const CUR_KY_HIEU = [
  [/(^|[^A-Z])VND([^A-Z]|$)|₫/i, 'VND'], [/(^|[^A-Z])USD([^A-Z]|$)/i, 'USD'],
  [/(^|[^A-Z])GBP([^A-Z]|$)|£/i, 'GBP'], [/(^|[^A-Z])EUR([^A-Z]|$)|€/i, 'EUR'],
  [/(^|[^A-Z])JPY([^A-Z]|$)|￥/i, 'JPY'], [/(^|[^A-Z])CAD([^A-Z]|$)|CA\$|(^|[^A-Z])C\$/i, 'CAD'],
  [/(^|[^A-Z])AUD([^A-Z]|$)|(^|[^A-Z])A\$/i, 'AUD'], [/(^|[^A-Z])SGD([^A-Z]|$)|(^|[^A-Z])S\$/i, 'SGD'],
  [/(^|[^A-Z])THB([^A-Z]|$)|฿/i, 'THB'], [/(^|[^A-Z])PHP([^A-Z]|$)|₱/i, 'PHP'],
  [/(^|[^A-Z])IDR([^A-Z]|$)|Rp/i, 'IDR'], [/(^|[^A-Z])MYR([^A-Z]|$)|RM/i, 'MYR'],
  [/(^|[^A-Z])TWD([^A-Z]|$)|NT\$/i, 'TWD'], [/(^|[^A-Z])BRL([^A-Z]|$)|(^|[^A-Z])R\$/i, 'BRL'],
  [/(^|[^A-Z])MXN([^A-Z]|$)/i, 'MXN'], [/¥/, 'CNY'],
  [/\$/, 'USD'], // để CUỐI: mọi ký hiệu có '$' ở trên đã bắt trước
];
function curTuChu(text) {
  const t = String(text || '');
  if (!t) return null;
  for (const [re, ma] of CUR_KY_HIEU) if (re.test(t)) return ma;
  return null;
}

// --- Amazon (công khai, không login) — background điều hướng tab tới trang search, đọc DOM ---
async function fetchAmazon(keyword, region, count) {
  const domain = AMZ_DOMAIN[region];
  if (!domain) return { products: [], blocked: false };
  const cur = AMZ_CUR[region] || 'USD';
  const url = `https://www.${domain}/s?k=${encodeURIComponent(keyword)}`;
  const res = await new Promise((r) => chrome.runtime.sendMessage({ type: 'RS_AMAZON', domain, url }, (x) => r(x)));
  if (!res || !res.ok || res.blocked) return { products: [], blocked: true };
  const products = (res.items || []).slice(0, count).map((it) => ({
    platform: 'Amazon', region, currency: curTuChu(it.priceText) || cur,
    itemid: it.asin, shopid: '', catid: null,
    name: it.name, image: it.image,
    price: it.price, priceMax: it.priceMax || null, priceFrom: !!it.priceMax, strike: it.strike,
    discount: it.strike && it.price && it.strike > it.price ? Math.round((1 - it.price / it.strike) * 100) : null,
    monthly: it.monthly, sold: null, rating: it.rating, ratingCount: it.ratingCount, // cầu: "bought/tháng" nếu có, không thì số review
    shop: '', isAd: it.isAd,
    link: `https://www.${domain}/dp/${it.asin}`,
    similarUrl: `https://www.${domain}/dp/${it.asin}`,
  }));
  return { products, blocked: false };
}

// --- Sàn BACKEND (Etsy: API key; Facebook: scrape) — extension gọi /api/ads/search của backend ---
async function fetchBackend(platform, keyword, region, count, countryOverride) {
  // `'_'` = sàn KHÔNG chia theo nước (Etsy, 1688). Backend vẫn cần một mã nước để đặt vào
  // `ad.countries` và làm khoá cache, nên phải điền một cái gì đó — mặc định 'US'. Nguồn nào
  // biết rõ mình thuộc nước nào thì nói ra bằng `countryOverride`: 1688 là sàn sỉ nội địa
  // Trung, dán nhãn 'US' cho nó là ghi sai vào dữ liệu chỉ vì một giá trị mặc định.
  const country = countryOverride || (region === '_' ? 'US' : region);
  const params = new URLSearchParams({ keyword, platforms: platform, countries: country, limit: String(count) });
  let data;
  try {
    const r = await fetch(`${BACKEND}/api/ads/search?${params.toString()}`);
    data = await r.json();
    if (!r.ok) return { products: [], blocked: false, notice: (data && data.error) || 'Chưa lấy được dữ liệu — thử lại sau ít phút.' };
  } catch (e) {
    return { products: [], blocked: false, backendDown: true };
  }
  const products = (data.ads || []).slice(0, count).map((ad) => {
    const cr = (ad.creatives || []).find((c) => c.url || c.posterUrl) || {};
    const imgRaw = cr.posterUrl || cr.url || '';
    return {
      platform: PF_LABEL[platform] || platform, region: region === '_' ? '' : region, currency: ad.currency,
      itemid: ad.id, shopid: '', catid: null,
      name: ad.title || ad.body || '',
      image: imgRaw ? `${BACKEND}/api/media?url=${encodeURIComponent(imgRaw)}` : '',
      price: ad.price ?? null, priceFrom: !!ad.priceIsFrom, strike: null, discount: null,
      // Sàn nào không cho số bán theo sản phẩm (Etsy) thì cột "cầu" là LƯỢT XEM. Giữ ở một
      // trường riêng chứ không nhét vào `monthly`, để ô còn biết mình đang hiện cái gì mà ghi
      // đúng nhãn — chép lượt xem vào ô "bán/tháng" là đúng cái lỗi vừa đi sửa ở Amazon.
      monthly: ad.monthlySold ?? null, views: ad.viewCount ?? null,
      sold: ad.soldCount ?? null, soldIsShop: !!ad.soldIsShop,
      rating: ad.rating ?? null, ratingCount: ad.ratingCount ?? null, ratingIsShop: !!ad.ratingIsShop,
      daysActive: ad.daysActive ?? null, // cho tab Content (FB: đời quảng cáo)
      // 回头率 của 1688 — vắng ở mọi nguồn khác, nên `?? null` chứ không phải giá trị mặc định.
      repurchase: ad.repurchaseRate ?? null,
      // Video sản phẩm nếu nguồn có (Etsy trả .mp4 thật). Thiếu dòng này thì nút ▶ của bảng
      // không bao giờ hiện cho nguồn server, dù creative video đã về tới nơi.
      videoUrl: (ad.creatives || []).find((c) => c.kind === 'video' && c.url)?.url || '',
      shop: ad.advertiser || '', isAd: false,
      // `similarUrl` KHÔNG suy được từ `permalink`: 1688 trả `sameDesignUrl` đã kèm vân tay ảnh
      // của chính chào hàng đó. Nguồn nào không có thì mới rơi về trang sản phẩm như cũ.
      link: ad.permalink || '#', similarUrl: ad.similarUrl || ad.permalink || '#',
      // Dùng điểm do BACKEND chấm (FB chấm theo đời quảng cáo; Etsy theo favorites) — đừng re-score.
      score: ad.score ? { total: ad.score.total, demand: ad.score.demandScore ?? ad.score.cvrProxy ?? 0, quality: ad.score.qualityScore ?? ad.score.contentScore ?? 0 } : undefined,
    };
  });
  const notice = (data.statuses || []).map((s) => s.message).filter(Boolean)[0] || null;
  // `ok` = nguồn có CHẠY được không, tách khỏi "chạy được nhưng không có hàng". Hai cái đó
  // trông giống hệt nhau ở `products.length === 0`, và nơi cần phân biệt là chỗ quyết định có
  // hạ xuống đường dự phòng hay không — xem `fetch1688`.
  const ok = (data.statuses || []).some((st) => st.ok);
  return { products, blocked: false, notice, ok };
}

// --- TikTok Shop — KALODATA, qua extension (hoặc máy-thợ). Một phiên cho mọi nước ---
//
// Lõi gọi mạng nằm ở `extension/kalodata.js`; ở đây chỉ gửi lệnh, cache và chuẩn hoá. Mỗi sản
// phẩm Kalodata trả sẵn số bán + doanh thu trong khoảng ngày lọc (30 ngày), rating, số creator,
// hoa hồng, ngày lên sàn. Số liệu là ƯỚC LƯỢNG của Kalodata, không phải số TikTok công bố
// (`docs/nghien-cuu-nguon-du-lieu.md` mục 5).

// MỖI TRANG `searchList` = MỘT LƯỢT CREDIT của gói (gói hiện tại: 10 lượt tìm/ngày). Nên ô "60 SP"
// KHÔNG được hiểu thành 6 trang: trần 3 trang (30 SP) cho mỗi (từ khoá × nước). Cỡ trang cố định 10
// vì gói chặn cỡ lớn hơn bằng paywall "Exceeded pagination limit" (đo 2026-09-08).
const KD_PAGE_SIZE = 10;
const KD_RESEARCH_MAX_PAGES = 3;
// Kalodata chốt số theo NGÀY (khoảng lọc kết ở hôm qua) — chạy lại cùng từ khoá trong ngày chỉ
// đốt credit để nhận về đúng bảng cũ. Cache trong trình duyệt 12 giờ.
const KD_CACHE_MS = 12 * 60 * 60 * 1000;
const KD_CACHE_PREFIX = 'rs_kd1:';

function kdCacheGet(key) {
  try {
    const raw = localStorage.getItem(KD_CACHE_PREFIX + key);
    if (!raw) return null;
    const v = JSON.parse(raw);
    if (!v || Date.now() - v.at > KD_CACHE_MS) { localStorage.removeItem(KD_CACHE_PREFIX + key); return null; }
    return v.data;
  } catch (e) { return null; }
}

function kdCacheSet(key, data) {
  const ghi = () => localStorage.setItem(KD_CACHE_PREFIX + key, JSON.stringify({ at: Date.now(), data }));
  try { ghi(); } catch (e) {
    // Đầy hạn mức localStorage → dọn toàn bộ cache Kalodata rồi thử lại đúng một lần.
    try {
      for (let i = localStorage.length - 1; i >= 0; i--) {
        const k = localStorage.key(i);
        if (k && k.startsWith(KD_CACHE_PREFIX)) localStorage.removeItem(k);
      }
      ghi();
    } catch (e2) { /* không lưu được thì thôi — lần sau gọi lại */ }
  }
}

/**
 * Gửi `RS_KD_PRODUCT` / `RS_KD_VIDEO`. Trả { items, total, error, auth, notes, cached }.
 *
 * CACHE CẢ LƯỢT RỖNG, không cache lượt LỖI: rỗng cũng đã tốn một lượt credit và gọi lại vẫn
 * rỗng; còn lỗi (chưa đăng nhập, máy-thợ bận) thì lần sau phải được thử lại thật.
 */
async function fetchKalodata(kind, keyword, region, pages) {
  const kw = String(keyword || '').trim();
  // `toLowerCase` GIỮ dấu tiếng Việt — "giày" và "giấy" vẫn là hai khoá khác nhau.
  const key = `${kind}:${region}:${pages}:${kw.toLowerCase()}`;
  const hit = kdCacheGet(key);
  if (hit) return Object.assign({ items: [], notes: [] }, hit, { cached: true });

  const type = kind === 'product' ? 'RS_KD_PRODUCT' : 'RS_KD_VIDEO';
  const r = await new Promise((res) => chrome.runtime.sendMessage({ type, opts: { country: region, keyword: kw, pages, days: 30 } }, (x) => res(x)));
  if (!r) return { items: [], notes: [], error: 'extension không trả lời', blocked: true };
  const out = {
    items: Array.isArray(r.items) ? r.items : [],
    total: r.total ?? null,
    notes: Array.isArray(r.notes) ? r.notes : [],
    error: r.error || (r.ok === false ? 'không lấy được dữ liệu Kalodata' : null),
    auth: !!r.auth,
    blocked: !!r.blocked,
  };
  if (!out.error) kdCacheSet(key, { items: out.items, total: out.total, notes: out.notes });
  return out;
}

/**
 * Chuỗi tiền Kalodata đã rút gọn ("₫330,00k", "$12.34", "Rp1,2jt") → số.
 *
 * KHÔNG DÙNG CHO DOANH THU — chuỗi đó mất chữ số ("₫3,56tr"), số thô là `revenue_raw`. Chỉ
 * dùng cho GIÁ, thứ API không trả số thô nào khác, và giá thì chuỗi còn đủ chữ số có nghĩa.
 */
function kdMoney(s) {
  if (typeof s === 'number') return s > 0 ? s : null;
  const m = String(s == null ? '' : s).match(/(\d[\d.,]*)\s*(tỷ|tỉ|tr|jt|rb|k|m|b)?/i);
  if (!m) return null;
  let so = m[1];
  const hau = (m[2] || '').toLowerCase();
  const cham = so.lastIndexOf('.'), phay = so.lastIndexOf(',');
  if (cham >= 0 && phay >= 0) {
    // Có cả hai dấu: dấu đứng SAU là dấu thập phân.
    so = phay > cham ? so.replace(/\./g, '').replace(',', '.') : so.replace(/,/g, '');
  } else if (cham >= 0 || phay >= 0) {
    const phan = so.split(phay >= 0 ? ',' : '.');
    // Một dấu, đúng 3 chữ số phía sau, không hậu tố → phân cách nghìn ("Rp12.345"). Còn lại là thập phân.
    const nghin = phan.length > 2 || (!hau && phan[phan.length - 1].length === 3);
    so = nghin ? phan.join('') : phan.slice(0, -1).join('') + '.' + phan[phan.length - 1];
  }
  const nhan = { k: 1e3, rb: 1e3, tr: 1e6, jt: 1e6, m: 1e6, 'tỷ': 1e9, 'tỉ': 1e9, b: 1e9 }[hau] || 1;
  const v = parseFloat(so) * nhan;
  return isFinite(v) && v > 0 ? Math.round(v * 100) / 100 : null;
}

function parseKalodataProduct(it, region) {
  const id = String(it.id || '');
  const sale = typeof it.sale === 'number' ? it.sale : null;
  const lo = kdMoney(it.min_real_price), hi = kdMoney(it.max_real_price), unit = kdMoney(it.unit_price);
  let gmv = typeof it.revenue_raw === 'number' ? it.revenue_raw : null;
  // ĐƠN VỊ CỦA `revenue_trend` MỚI ĐO Ở VN (đồng, không có tiền lẻ). Nước dùng tiền lẻ có thể trả
  // theo cent — đối chiếu với giá đơn vị chính API ghi: lệch đúng cỡ ×100 thì quy lại.
  if (gmv && sale && unit) {
    const lech = gmv / sale / unit;
    if (lech > 50 && lech < 200) gmv = gmv / 100;
  }
  const price = lo || unit || (gmv && sale ? Math.round((gmv / sale) * 100) / 100 : null);
  const rating = typeof it.product_rating === 'number' && it.product_rating > 0 ? it.product_rating : null;
  // Kalodata không trả tên shop ở trang tìm kiếm — dòng phụ dưới tên dùng cho thứ nó CÓ và
  // người research hay hỏi: bao nhiêu creator đang bán, hoa hồng bao nhiêu, lên sàn từ khi nào.
  const phu = [
    typeof it.creator_num === 'number' ? `${fmtInt(it.creator_num)} creator` : '',
    it.commission_rate ? `hoa hồng ${it.commission_rate}` : '',
    it.launch_date ? `lên sàn ${it.launch_date}` : '',
  ].filter(Boolean).join(' · ');
  const link = id ? `https://www.tiktok.com/view/product/${id}` : '#';
  return {
    platform: 'TikTok Shop', region, currency: TT_CUR[region] || 'USD',
    itemid: id, shopid: '', catid: it.ter_cate_id || it.sec_cate_id || null,
    name: it.product_title || '',
    image: it.image || (id ? `https://img.kalocdn.com/tiktok.product/${id}/cover.png` : ''),
    price, priceMax: hi && lo && hi > lo ? hi : null, priceFrom: false, strike: null, discount: null,
    // `sale` là số bán TRONG khoảng lọc 30 ngày — đúng nghĩa cột Bán/tháng. Không có tổng luỹ kế.
    monthly: sale, sold: null,
    rating, ratingCount: null,
    // Giữ cả 0: sản phẩm không doanh thu phải được chấm "chất" 0, không rơi sang nhánh rating.
    gmv: gmv != null && gmv >= 0 ? gmv : null,
    shop: phu, isAd: false,
    link, similarUrl: link,
  };
}

async function fetchTiktok(keyword, region, count) {
  const tag = `TikTok Shop ${region}`;
  if (!KD_REGIONS.includes(region)) return { products: [], blocked: false, notice: `${tag}: Kalodata không có nước này` };
  const pages = Math.min(KD_RESEARCH_MAX_PAGES, Math.max(1, Math.ceil(count / KD_PAGE_SIZE)));
  const r = await fetchKalodata('product', keyword, region, pages);
  const products = r.items.map((it) => parseKalodataProduct(it, region)).filter((p) => p.itemid).slice(0, count);
  if (r.error) {
    // Chưa đăng nhập / máy-thợ hỏng → `blocked`, để `research()` hạ dấu ✓ về "chưa biết" rồi hỏi lại.
    return { products, blocked: !!(r.auth || r.blocked), notice: `${tag}: ${r.error}` };
  }
  const ghi = [];
  if (!r.cached && count > pages * KD_PAGE_SIZE) ghi.push(`Kalodata lấy tối đa ${pages * KD_PAGE_SIZE} SP (mỗi trang trừ 1 lượt credit)`);
  ghi.push(...r.notes);
  if (!products.length) ghi.push('Kalodata không có sản phẩm khớp — thử từ khoá bằng ngôn ngữ nước đó');
  return { products, blocked: false, notice: ghi.length ? `${tag}: ${ghi.join('; ')}` : null };
}

/**
 * Bản ghi `/video/searchList` → thẻ video của cửa sổ Video.
 *
 * FIELD ĐÃ ĐO trên response thật 2026-09-14 (VN, "tai nghe"): id, description (KHÔNG có `title`),
 * handle, creator_uid, follower_count ("15,4k"), views ("55,01k" — CHUỖI), views_trend [30],
 * revenue ("₫1,02tỉ"), revenue_trend, revenue_raw (số thực), sale, publish_date
 * ("2026/01/26 01:02:24"), duration, ad, ad_view_ratio (">90%"), ad_cpa, ad2Cost, ad2Roas, gpm…
 * Vẫn đọc qua vài tên ứng viên vì đây là API nội bộ, đổi tên lúc nào không báo; thiếu thì để trống,
 * không bịa số — `fillTiktokStats` điền tim/lượt xem thật từ trang nhúng của TikTok.
 */
function kdPick(o, keys) {
  for (const k of keys) if (o[k] != null && o[k] !== '') return o[k];
  return null;
}

function kdUnix(v) {
  if (typeof v === 'number') return v > 1e12 ? Math.floor(v / 1000) : v;
  if (typeof v === 'string' && v) { const t = Date.parse(v); return isFinite(t) ? Math.floor(t / 1000) : null; }
  return null;
}

function kalodataVideoAd(v, region) {
  const id = String(v.id || '');
  const handle = String(kdPick(v, ['creator_handle', 'handle', 'unique_id', 'creator_unique_id', 'author_unique_id']) || '').replace(/^@/, '');
  const nick = kdPick(v, ['creator_nickname', 'nickname', 'creator_name', 'author_name']);
  const viewsRaw = kdPick(v, ['views', 'view_count', 'play_count', 'video_views']);
  const views = typeof viewsRaw === 'number'
    ? viewsRaw
    : Array.isArray(v.views_trend) ? v.views_trend.reduce((s, x) => s + (typeof x === 'number' ? x : 0), 0) : null;
  const chu = v.description || v.title || '';
  return {
    platform: 'tiktok', id, viaKalodata: true,
    advertiser: handle ? '@' + handle : (nick || 'TikTok Shop'),
    title: chu, body: chu,
    // Không có tên tài khoản thì trỏ trang NHÚNG: link `@x/video/{id}` mở trong tab thật bị TikTok
    // đá về trang chung (đo 2026-09-08, `extension-kalodata/background.js::ttCanonical`).
    permalink: handle ? `https://www.tiktok.com/@${handle}/video/${id}` : `https://www.tiktok.com/embed/v2/${id}`,
    regionTag: region, langMatch: 'neutral',
    playCount: views,
    startedAt: kdUnix(kdPick(v, ['publish_date', 'create_time', 'post_time', 'publish_time', 'created_at'])),
    gmv: typeof v.revenue_raw === 'number' ? v.revenue_raw : null,
    // Chuỗi đã format sẵn theo tiền nước đó — HIỆN nguyên văn thì đúng, chỉ đừng parse nó.
    gmvText: typeof v.revenue === 'string' ? v.revenue : null,
    saleCount: typeof v.sale === 'number' ? v.sale : null,
    // Hai chuỗi Kalodata đã format sẵn — chỉ HIỆN, không tính toán gì trên chúng.
    followerText: typeof v.follower_count === 'string' || typeof v.follower_count === 'number' ? String(v.follower_count) : null,
    adViewText: typeof v.ad_view_ratio === 'string' && v.ad_view_ratio && v.ad_view_ratio !== '0%' ? v.ad_view_ratio : null,
    creatives: [{ kind: 'video', posterUrl: v.image || (id ? `https://img.kalocdn.com/tiktok.video/${id}/cover.png` : '') }],
  };
}

// --- 1688 ĐƯỜNG DỰ PHÒNG — background gọi API mtop JSON trong tab h5api. Không region ---
//
// KHÔNG còn là đường chính: `fetch1688` bên dưới đi thẳng ra server trước. Giữ lại vì chặn
// theo IP là thứ bật lên bất cứ lúc nào mà không báo trước, và khi nó bật thì đường qua tab
// vẫn chạy — trình duyệt user đi từ IP dân cư. Cùng lối Shopee đang làm: đường nhanh → 403 →
// hạ xuống đường điều hướng.
async function fetch1688Extension(keyword, count) {
  const res = await new Promise((r) => chrome.runtime.sendMessage({ type: 'RS_1688', keyword, count }, (x) => r(x)));
  if (!res || !res.ok) return { products: [], blocked: false, notice: '1688: không lấy được dữ liệu — thử lại.' };
  if (res.blocked) return { products: [], blocked: true, notice: `1688: bị chặn tạm (${res.error || 'rate-limit'}) — thử lại sau` };
  const products = (res.items || []).slice(0, count).map((it) => ({
    platform: '1688', region: '', currency: 'CNY',
    itemid: String(it.id), shopid: '', catid: null,
    name: it.name, image: it.image,
    price: it.price, strike: null, discount: null, // giá sỉ (giá vốn); 1688 không công khai giảm giá
    // `rating` ở 1688 là điểm dịch vụ của SHOP (`tradeService`), không phải của sản phẩm —
    // 1688 không có rating theo sản phẩm. Gắn cờ để ô rating gọi đúng tên nó.
    monthly: it.monthly, sold: it.sold, rating: it.rating, ratingCount: null, ratingIsShop: true, repurchase: it.repurchase,
    videoUrl: it.videoUrl || '', // video sản phẩm nếu response search có
    shop: it.shop, isAd: false,
    link: `https://detail.1688.com/offer/${it.id}.html`,
    similarUrl: it.similar || `https://detail.1688.com/offer/${it.id}.html`, // link tìm sản phẩm cùng mẫu (sameDesignUrl)
  }));
  // Hiện LÝ DO thật khi rỗng (thay vì để lọt vào thông báo chung chung) — vd token/limit/không có SP.
  if (!products.length) return { products: [], blocked: false, notice: `1688: ${res.error || 'không có sản phẩm cho từ khoá này'}` };
  return { products, blocked: false };
}

// --- 1688 (giá sỉ Trung, công khai) — SERVER trước, extension dự phòng. Không region ---
//
// 1688 là một trong hai sàn duy nhất của nhóm "phải chạy trong trình duyệt" mà KHÔNG cần đăng
// nhập — nó chỉ cần một chữ ký md5 tự tính được. Đo 2026-09-09 từ VPS (IP datacenter, chính
// cái IP mà Facebook Ad Library trả 0 kết quả): 15/15 lượt thành công, trung vị 996ms, 300/300
// mục đủ trường. Chi tiết trong docstring `backend/lib/ads/platforms/ali1688.py`.
//
// Lợi ích chính không nằm ở tốc độ một lượt mà ở việc giảm tải hàng đợi tab: worker xử lý tuần tự,
// nên mỗi nguồn chuyển sang server sẽ giải phóng hàng đợi cho các nguồn còn lại. Và 1688
// giờ chạy được cả khi không có máy-thợ nào online — trước đây không thợ là sàn này tắt hẳn.
//
// CHỈ hạ xuống extension khi server THẤT BẠI, không hạ khi server chạy được mà từ khoá không
// có hàng: hạ lúc ấy chỉ tốn thêm một lượt tab để nhận về đúng một danh sách rỗng.
async function fetch1688(keyword, count) {
  const may = await fetchBackend('ali1688', keyword, '_', count, 'CN');
  if (may.ok && !may.backendDown) return may;
  const tab = await fetch1688Extension(keyword, count);
  // Nói ra là đã phải đi đường vòng, và vì sao. Một lượt chậm hơn hẳn mà không có lời giải
  // thích thì lần sau không ai truy được nó chậm ở đâu.
  const vi = may.notice || (may.backendDown ? 'backend không trả lời' : 'server không lấy được');
  const ghi = `1688: server hỏng (${vi}) — đã lấy qua trình duyệt`;
  return { ...tab, notice: tab.notice ? `${ghi}. ${tab.notice}` : ghi };
}

// --- Taobao (Cách A "ký sinh": trang tự gọi h5search đã ký + x5sec, extension chộp response). Không region ---
async function fetchTaobao(keyword, count) {
  const res = await new Promise((r) => chrome.runtime.sendMessage({ type: 'RS_TAOBAO', keyword, count }, (x) => r(x)));
  if (!res || !res.ok) return { products: [], blocked: false, notice: 'Taobao: không lấy được dữ liệu — thử lại.' };
  if (res.blocked) return { products: [], blocked: true, notice: `Taobao: ${res.error || 'bị chặn'}` };
  if (res.raw) { console.log('[RS] Taobao raw (chưa map được field):', res.raw); return { products: [], blocked: false, notice: 'Taobao: bắt được response nhưng chưa khớp field — xem Console (F12) gửi dev' }; }
  const products = (res.items || []).slice(0, count).map((it) => ({
    platform: 'taobao', region: '', currency: 'CNY',
    itemid: String(it.id), shopid: '', catid: null,
    name: it.name, image: it.image,
    price: it.price, strike: null, discount: null,
    monthly: it.monthly, sold: null, rating: null, ratingCount: null,
    videoUrl: it.videoUrl || '', // video sản phẩm nếu response search có
    shop: it.shop, isAd: false,
    link: `https://item.taobao.com/item.htm?id=${it.id}`,
    similarUrl: `https://s.taobao.com/search?q=${encodeURIComponent(it.name || keyword)}`,
  }));
  return { products, blocked: false };
}

// --- Temu (Cách A "ký sinh": trang tự gọi /api/poppy/v1/search kèm anti-content, extension chộp response) ---
const TEMU_CUR = { US: 'USD', GB: 'GBP', DE: 'EUR', FR: 'EUR', JP: 'JPY' };
async function fetchTemu(keyword, region, count) {
  const res = await new Promise((r) => chrome.runtime.sendMessage({ type: 'RS_TEMU', keyword, count }, (x) => r(x)));
  if (!res || !res.ok) return { products: [], blocked: false, notice: 'Temu: không lấy được dữ liệu — thử lại.' };
  if (res.blocked) return { products: [], blocked: true, notice: `Temu: ${res.error || 'bị chặn'}` };
  if (res.raw) { console.log('[RS] Temu raw (chưa map được field):', res.raw); return { products: [], blocked: false, notice: 'Temu: bắt được response nhưng chưa khớp field — xem Console (F12) gửi dev' }; }
  const products = (res.items || []).slice(0, count).map((it) => ({
    platform: 'temu', region: region || '', currency: it.currency || TEMU_CUR[region] || 'USD',
    itemid: String(it.id), shopid: '', catid: null,
    name: it.name, image: it.image,
    price: it.price, strike: null, discount: null,
    monthly: null, sold: it.sold, rating: it.rating, ratingCount: null, // Temu: "11K+ sold" = tổng bán; không có số tháng
    videoUrl: it.videoUrl || '', // video sản phẩm (có sẵn trong response)
    shop: '', isAd: false,
    link: `https://www.temu.com/goods.html?goods_id=${it.id}`,
    similarUrl: `https://www.temu.com/search_result.html?search_key=${encodeURIComponent(it.name || keyword)}`,
  }));
  return { products, blocked: false };
}

function fetchFor(platform, keyword, region, count) {
  if (platform === 'amazon') return fetchAmazon(keyword, region, count);
  if (platform === 'tiktok') return fetchTiktok(keyword, region, count);
  if (platform === 'ali1688') return fetch1688(keyword, count); // server trước, extension dự phòng
  if (platform === 'taobao') return fetchTaobao(keyword, count);
  if (platform === 'temu') return fetchTemu(keyword, region, count);
  if (PLATFORMS[platform] && PLATFORMS[platform].backend) return fetchBackend(platform, keyword, region, count);
  return fetchKeyword(keyword, region, count); // shopee
}

// Dịch một keyword sang ngôn ngữ của từng region qua backend (Gemini). FAIL-SAFE: lỗi/mạng →
// trả {} để research() dùng nguyên keyword gốc (không bao giờ chặn lượt tìm vì dịch hỏng).
async function translateForRegions(keyword, regions) {
  try {
    const url = `${BACKEND}/api/keywords/translate?keyword=${encodeURIComponent(keyword)}&regions=${encodeURIComponent(regions.join(','))}`;
    const r = await fetch(url);
    if (!r.ok) return {};
    const d = await r.json().catch(() => ({}));
    return d.terms || {};
  } catch (e) { return {}; }
}

async function research() {
  const keywords = $('kw').value.split(',').map((s) => s.trim()).filter(Boolean);
  const count = Number($('count').value);
  const activePf = [...selectedPlatforms].filter((p) => PLATFORMS[p]?.active);
  if (!activePf.length) { setStatus('Chọn ít nhất 1 sàn đang hỗ trợ.', 'err'); return; }
  if (!keywords.length) { setStatus('Nhập ít nhất 1 từ khoá.', 'err'); return; }
  // Mỗi sàn chỉ chạy region nó phục vụ; Shopee thì region đó phải đã đăng nhập.
  // Gom (sàn × region) HỢP LỆ trước — để biết cần dịch keyword sang những region (ngôn ngữ) nào.
  const combos = [];
  const skipLI = [];
  for (const pf of activePf) {
    const cfg = PLATFORMS[pf];
    const hasReg = Array.isArray(cfg.regions) && cfg.regions.length;
    // Sàn không region (Etsy) → chạy 1 lần với '_'; sàn có region → lấy đúng region đã chọn CHO SÀN ĐÓ.
    const pfRegions = hasReg ? cfg.regions.filter((c) => selectedRegions.has(`${pf}:${c}`)) : ['_'];
    for (const region of pfRegions) {
      if (LOGIN[pf] && loginStatus[`${pf}:${region}`] === false) { skipLI.push(`${pf}:${region}`); continue; }
      combos.push({ pf, region });
    }
  }
  if (!combos.length) { setStatus('Không có (sàn × region) hợp lệ. Sàn có region thì phải chọn region của nó.', 'err'); return; }

  // TỰ DỊCH keyword theo ngôn ngữ của từng region (giữ tên hãng/model). SEARCH bằng bản dịch,
  // nhưng NHÃN (nhóm/lọc) giữ keyword GỐC.
  //
  // Sàn KHÔNG có cột nước (region '_') vẫn có ngôn ngữ riêng, lấy từ `PLATFORMS[pf].searchMarket`
  // — xem ghi chú ở đó để biết bản trước đã bỏ sót gì.
  $('go').disabled = true;
  const wantTranslate = $('autoTranslate') && $('autoTranslate').checked;
  const marketOf = (pf, region) => (region && region !== '_' ? region : (PLATFORMS[pf].searchMarket || ''));
  const regionSet = [...new Set(combos.map((c) => marketOf(c.pf, c.region)).filter(Boolean))];
  const trans = {}; // kw gốc -> { region: từ khoá đã dịch }
  let translatedAny = false;
  if (wantTranslate && regionSet.length) {
    setStatus('Đang dịch từ khoá theo ngôn ngữ sàn…');
    for (const kw of keywords) {
      trans[kw] = await translateForRegions(kw, regionSet);
      if (Object.values(trans[kw]).some((t) => t && t !== kw)) translatedAny = true;
    }
  }

  const jobs = [];
  for (const { pf, region } of combos) {
    for (const kw of keywords) {
      const thiTruong = marketOf(pf, region);
      const searchKw = (thiTruong && trans[kw] && trans[kw][thiTruong]) ? trans[kw][thiTruong] : kw;
      jobs.push({ pf, region, kw: searchKw, kwLabel: kw });
    }
  }

  setStatus(`Đang chạy ${jobs.length} truy vấn (sàn × region × từ khoá)${translatedAny ? ' · đã dịch theo sàn' : ''}…`);

  const all = [];
  let backendDown = false;
  const notices = [];

  // Chạy các SÀN song song, nhưng job trong cùng một sàn thì tuần tự — giữ nhịp giãn chống ban
  // của Shopee (Cách A) và tab nền dùng-lại của Amazon, mà vẫn để Shopee/Amazon/backend chạy chồng.
  const byPf = new Map();
  for (const j of jobs) { if (!byPf.has(j.pf)) byPf.set(j.pf, []); byPf.get(j.pf).push(j); }
  const groups = await Promise.all([...byPf.values()].map(async (group) => {
    const out = [];
    for (const j of group) out.push({ j, r: await fetchFor(j.pf, j.kw, j.region, count) });
    return out;
  }));

  for (const { j, r } of groups.flat()) {
    if (r.backendDown) backendDown = true;
    if (r.notice) notices.push(r.notice);
    // Sàn chặn lượt crawl KHÔNG chứng minh được là chưa đăng nhập — nó cũng có thể là chống
    // bot, là mạng chớp, là thợ bận. Ghi thẳng `false` như bản trước là dán một dấu ✕ sai lên
    // nước đó, và vì `research()` bỏ qua sàn có `false`, cái ✕ ấy tự khoá luôn sàn cho các lượt
    // sau. Hạ về "chưa biết" rồi đi hỏi lại cho chắc.
    if (r.blocked && LOGIN[j.pf]) loginStatus[`${j.pf}:${j.region}`] = undefined;
    for (const p of r.products) { p.keyword = j.kwLabel || j.kw; if (!p.score) p.score = score(p); }
    all.push(...r.products);
  }
  $('go').disabled = false;
  renderRegions();
  void refreshLogin(); // vừa có sàn bị chặn → hỏi lại trạng thái thật thay vì đoán (crawl đã xong)

  if (!all.length) {
    // Câu cuối cùng phải nói về ĐÚNG những sàn vừa chạy. Bản trước ghi cứng "Shopee: kiểm tra
    // đăng nhập; Amazon: có thể bị chặn" cho mọi trường hợp — chạy mỗi Facebook cũng hiện y
    // như vậy, tức là chỉ người dùng đi sửa hai thứ không liên quan gì tới lượt tìm của họ.
    const daChay = [...new Set(jobs.map((j) => j.pf))];
    const ten = daChay.map((pf) => (PLATFORMS[pf] && PLATFORMS[pf].label) || pf).join(', ');
    const goiY = [];
    if (daChay.some((pf) => LOGIN[pf])) goiY.push('sàn cần đăng nhập thì kiểm lại phiên');
    if (daChay.includes('amazon')) goiY.push('Amazon có thể đang bị chặn tạm/captcha');
    const msg = backendDown
      ? 'Không gọi được backend — Etsy/Facebook cần nó. Kiểm cửa sổ backend còn chạy không, rồi tải lại trang.'
      : notices.length
        ? notices.join(' · ') // hiện lý do thật từ backend (vd Etsy chưa có key)
        : `Không có kết quả từ ${ten}${goiY.length ? ' — ' + goiY.join('; ') : ''}.`;
    setStatus(msg, 'err');
    $('table').style.display = 'none';
    return;
  }

  rows = all;
  const kwset = [...new Set(all.map((p) => p.keyword))];
  $('kwfilter').innerHTML = '<option value="__all">Tất cả</option>' + kwset.map((k) => `<option value="${esc(k)}">${esc(k)}</option>`).join('');
  $('filterWrap').style.display = kwset.length > 1 ? 'inline' : 'none';

  const pfset = [...new Set(all.map((p) => p.platform))];
  const ads = all.filter((p) => p.isAd).length;
  const skipNote = skipLI.length ? ` · bỏ ${skipLI.join('/')}` : '';
  const noticeNote = notices.length ? ' · ' + [...new Set(notices)].join(' · ') : '';
  setStatus(`${all.length} SP · ${pfset.join('+')} · ${kwset.length} từ khoá · ${ads} qc${skipNote} · xếp theo điểm.${noticeNote}`, 'ok');
  render();
  // Giá vốn tạm ẩn (trang find_similar 403 khi replay). Bật lại khi có cách ký.
}

function scoreClass(v) { return v >= 65 ? 'hi' : v >= 40 ? 'mid' : 'lo'; }

function render() {
  const kwPick = $('kwfilter').value || '__all';

  let list = rows.filter((p) => kwPick === '__all' || p.keyword === kwPick);
  list.sort((a, b) => {
    switch (sortKey) {
      case 'name': return a.name.localeCompare(b.name);
      case 'platform': return a.platform.localeCompare(b.platform);
      case 'price': return (giaDung(b) || 0) - (giaDung(a) || 0); // theo đúng số đang hiện
      case 'discount': return (b.discount || 0) - (a.discount || 0);
      case 'rating': return (b.rating || 0) - (a.rating || 0);
      case 'monthly': return (b.monthly || 0) - (a.monthly || 0);
      case 'sold': return (b.sold || 0) - (a.sold || 0);
      default: return b.score.total - a.score.total;
    }
  });

  // Dựng toàn bộ HTML một lần rồi gán một phát — tránh reflow mỗi dòng khi bảng dài (120+ SP).
  // Handler hover/click gắn theo uỷ quyền trên #rows nên không bị ảnh hưởng khi thay innerHTML.
  $('rows').innerHTML = list.map((p, i) =>
    `<tr>` +
    `<td class="num rank">${i + 1}</td>` +
    `<td class="num"><span class="score ${scoreClass(p.score.total)}">${p.score.total}</span>` +
    `<div class="bar"><i style="width:${p.score.total}%"></i></div>` +
    `<div class="sub">${scoreSub(p)}</div></td>` +
    `<td><div class="prod">` +
    `<img class="thumb" src="${p.image}" data-full="${p.image}" loading="lazy" alt="" />` +
    `<div><a class="name" href="${p.link}" target="_blank" rel="noreferrer">${esc(p.name)}${p.isAd ? '<span class="adtag">Ad</span>' : ''}</a>` +
    `${p.videoUrl ? ` <a class="hasvid" href="${esc(p.videoUrl)}" target="_blank" rel="noreferrer" title="Sản phẩm có video — bấm để xem">▶</a>` : ''}` +
    `<div class="shop">${esc(p.shop)}</div></div></div></td>` +
    // NƯỚC NÓI MỘT LẦN. Trước đây ô này in cả cờ LẪN mã nước: `Amazon 🇺🇸 US`. Windows không
    // vẽ được emoji cờ (nó dựng từ hai chữ cái vùng), nên trên đúng cái máy người dùng đang
    // ngồi nó tụt xuống thành hai chữ thường và ô đọc ra "Amazon us US" — nhìn như lỗi dữ liệu.
    // Chỗ khác dùng cờ thì nó đi kèm TÊN nước ("🇻🇳 Việt Nam") nên không trùng; riêng ô này
    // trùng ở mọi hệ điều hành, chỉ là Windows làm nó lộ ra.
    `<td><span class="pill">${esc(p.platform)}${p.region ? ' · ' + esc(p.region) : ''}</span></td>` +
    `${demandCell(p)}${soldCell(p)}${ratingCell(p)}` +
    `<td class="num">${priceCell(p)}</td>` +
    cost1688Td(p) +
    `<td><button class="sim cost" data-img="${esc(rawImg(p.image))}" data-name="${esc(p.name)}" data-price="${giaDung(p) != null ? giaDung(p) : ''}" data-cur="${esc(curOf(p))}">💰 Giá vốn</button> ` +
    `<button class="sim vid" data-img="${esc(rawImg(p.image))}" data-name="${esc(p.name)}" data-region="${esc(p.region || '')}">🎬 Video</button></td>` +
    `</tr>`
  ).join('');
  $('table').style.display = list.length ? 'table' : 'none';
  $('costAll').style.display = list.length ? '' : 'none'; // nút giá vốn hàng loạt chỉ hiện khi có list
}

// ---- Hover ảnh: phóng to bám theo con trỏ ----
const zoom = $('zoom');
const zoomImg = zoom.querySelector('img');
function positionZoom(x, y) {
  const w = 332, h = 332, pad = 18;
  let left = x + pad, top = y + pad;
  if (left + w > window.innerWidth) left = x - w - pad;
  if (top + h > window.innerHeight) top = Math.max(pad, window.innerHeight - h - pad);
  zoom.style.left = left + 'px';
  zoom.style.top = top + 'px';
}
$('rows').addEventListener('mouseover', (e) => {
  const img = e.target.closest('img.thumb');
  if (!img || !img.dataset.full) return;
  zoomImg.src = img.dataset.full;
  zoom.style.display = 'block';
  positionZoom(e.clientX, e.clientY);
});
$('rows').addEventListener('mousemove', (e) => { if (zoom.style.display === 'block') positionZoom(e.clientX, e.clientY); });
$('rows').addEventListener('mouseout', (e) => { if (e.target.closest('img.thumb')) zoom.style.display = 'none'; });

// ---- Click trong bảng: "Giá vốn" (tìm bằng ảnh trên 1688) hoặc "Video" (modal video khớp ảnh) ----
$('rows').addEventListener('click', (e) => {
  const cost = e.target.closest('button.cost');
  if (cost) {
    const sell = cost.dataset.price !== '' && cost.dataset.price != null ? Number(cost.dataset.price) : null;
    openCostModal({ img: cost.dataset.img, name: cost.dataset.name, sell, cur: cost.dataset.cur || 'VND' });
    return;
  }
  const vid = e.target.closest('button.vid');
  if (vid) {
    openVideoModal({ img: vid.dataset.img, name: vid.dataset.name, region: vid.dataset.region });
    return;
  }
});

// ===== MODAL GIÁ VỐN — tìm bằng ẢNH sản phẩm trên 1688, lấy chào hàng RẺ NHẤT (giá sỉ ¥ = giá vốn) =====
// Dùng lại endpoint /api/imagesearch (mục Tìm bằng ảnh), chỉ hỏi nguồn '1688'. Ảnh của dòng là URL
// → tải bytes qua proxy /api/media (tránh CORS) → gửi multipart. `sourcing` trả về = bảng 1688.
let costToken = 0; // chống race: mỗi lần mở gắn token, chỉ render kết quả của token mới nhất.
// Ngữ cảnh modal hiện tại — giữ để đổi tỉ giá/ngưỡng thì tính lại % ngay, KHÔNG fetch lại 1688.
let costOffers = [];      // các chào hàng 1688 đã lấy (mỗi cái là một nguồn nhập)
let costSell = null;      // giá bán đối thủ (VND) của dòng đang xét — mẫu số của %
let costCur = 'VND';      // tiền tệ của giá bán; chỉ tính % khi = VND (tỉ giá là ¥→₫)
// Không có gì để nói thì ẨN HẲN cái thanh, đừng để lại một dải trống.
// `.status` có padding 13px và một đường kẻ dưới, nên rỗng mà vẫn hiện thì trông như thanh
// đang tải dở — đúng cảm giác "trang bị lỗi" mà nó sinh ra để tránh.
function setCostStatus(msg, kind) {
  const bar = $('costStatus');
  $('costStatusText').textContent = msg || '';
  bar.className = 'status' + (kind ? ' ' + kind : '');
  bar.hidden = !msg;
}
function closeCostModal() {
  $('costModal').classList.remove('on');
  $('costGrid').innerHTML = '';
  $('costHeadline').innerHTML = '';
  $('costTitle').textContent = '';
  $('costControls').hidden = true;
  costOffers = [];
  setCostStatus('');
}

// Lõi tra giá vốn 1688 theo ẢNH — DÙNG CHUNG cho modal (mở chi tiết một dòng) và batch (cả bảng).
// KHÔNG đụng DOM, không token. Trả { offers, min, error, identity, cached }: offers đã lọc phụ
// kiện + sắp giá tăng dần (rẻ nhất đầu), min = offers[0]. nameHint giúp Gemini lọc đúng loại SP.
async function fetch1688Offers(imgUrl, nameHint) {
  let blob;
  try {
    const ir = await fetch(proxyMedia(imgUrl));
    if (!ir.ok) throw new Error('HTTP ' + ir.status);
    blob = await ir.blob();
  } catch (e) { return { offers: [], min: null, error: 'Không tải được ảnh: ' + e.message }; }

  let data;
  try {
    const form = new FormData();
    const type = /^image\/(jpeg|png|webp)$/.test(blob.type) ? blob.type : 'image/jpeg';
    const typed = blob.type === type ? blob : new Blob([blob], { type });
    form.append('file', typed, 'product.' + type.split('/')[1]);
    form.append('geo', 'VN');
    form.append('sources', '1688');
    const r = await fetch(`${BACKEND}/api/imagesearch`, { method: 'POST', body: form });
    data = await r.json().catch(() => ({}));
    if (!r.ok) return { offers: [], min: null, error: (data && data.error) || 'Chưa lấy được dữ liệu — thử lại sau ít phút.' };
  } catch (e) { return { offers: [], min: null, error: 'Lỗi gọi tìm-bằng-ảnh: ' + e.message }; }

  let offers = (data.sourcing || [])
    .filter((o) => o.priceValue != null && !o.isAccessory)
    .sort((a, b) => a.priceValue - b.priceValue);

  // Lọc theo Gemini: tìm bằng ảnh trả về hàng NHÌN GIỐNG, rẻ nhất có thể là món KHÁC loại. Hỏi
  // model tiêu đề nào ĐÚNG loại rồi chỉ lấy rẻ nhất trong số đó. Thiếu khoá/model lỗi → giữ nguyên.
  if (offers.length > 1) {
    try {
      const productHint = (data.identity && data.identity.product) || nameHint || '';
      const rr = await fetch(`${BACKEND}/api/cost/rank`, {
        method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ product: productHint, titles: offers.map((o) => o.title || '') }),
      });
      const rj = await rr.json().catch(() => ({}));
      if (Array.isArray(rj.relevant) && rj.relevant.length) {
        const keep = new Set(rj.relevant);
        const filtered = offers.filter((_, idx) => keep.has(idx)); // giữ thứ tự giá tăng dần
        if (filtered.length) offers = filtered;
      }
    } catch (e) { /* Gemini lỗi/không cấu hình → giữ nguyên, lấy rẻ nhất */ }
  }
  return {
    offers, min: offers[0] || null,
    error: offers.length ? null : (data.message || '1688 không tìm thấy hàng khớp ảnh này.'),
    identity: data.identity, cached: data.cached,
  };
}

async function openCostModal(p) {
  const my = ++costToken;
  costSell = (p.sell != null && isFinite(p.sell) && p.sell > 0) ? p.sell : null;
  costCur = p.cur || 'VND';
  costOffers = [];
  $('costTitle').textContent = p.name || '(không tên)';
  $('costHeadline').innerHTML = '';
  $('costGrid').innerHTML = '';
  $('costControls').hidden = true;
  $('costModal').classList.add('on');
  setCostStatus('Đang tìm giá vốn trên 1688 theo ảnh…');

  const res = await fetch1688Offers(p.img, p.name);
  if (my !== costToken) return; // user đã mở dòng khác trong lúc chờ → bỏ kết quả cũ
  if (!res.offers.length) { setCostStatus(res.error || '1688 không tìm thấy hàng khớp ảnh này.', 'err'); return; }
  const offers = res.offers;
  if (res.identity && res.identity.product) $('costTitle').textContent = res.identity.product;

  const min = offers[0];
  costOffers = offers;
  // Ghi giá vốn 1688 rẻ nhất về store theo ảnh dòng → cột "Giá vốn 1688" ở bảng chính hiện ngay.
  if (p.img != null && min.priceValue != null) { cost1688[p.img] = min.priceValue; render(); }
  $('costHeadline').innerHTML = `Giá vốn nhỏ nhất <b>${esc(min.price || ('¥' + min.priceValue))}</b>`;
  const cy = cnyVnd();
  // DÒNG TRẠNG THÁI KHI CHẠY XONG: ĐỂ TRỐNG.
  //
  // Bản trước ghi cả một dòng phép tính — "12 chào hàng 1688. ¥→₫ = 3.900 · giá bán 980.000
  // VND ≈ ¥251.3 · % = giá vốn ÷ giá bán". Mọi mẩu trong đó đều đã có mặt ngay trên màn hình:
  // số chào hàng = số thẻ đang hiện, hai tỉ giá là hai ô nhập ngay bên cạnh (sửa được), giá
  // bán là cột người dùng vừa bấm vào. Nó chỉ đọc lại thành tiếng cái đang thấy, bằng giọng
  // của công thức.
  //
  // Giữ lại ĐÚNG một câu, và chỉ khi nó giải thích một chỗ TRỐNG: dòng thiếu giá bán thì cột %
  // không có gì, im lặng ở đó đọc thành "tool hỏng".
  const sellCny = sellToCny(costCur, costSell); // giá bán đối thủ quy về ¥
  if (costSell != null && sellCny) setCostStatus('');
  else setCostStatus('Dòng này không có giá bán nên chưa tính được %.');

  // Nạp 2 ô tỉ giá: ¥→₫ (chung) + [nước]→₫ (ẩn nếu sàn VN vì =1). Rồi ngưỡng, hiện controls, dựng card.
  $('costRate').value = cy;
  const curWrap = $('costCurRateWrap');
  // Ẩn với VND (=1) và với CNY (ô "¥→₫" ngay trên CHÍNH LÀ nó — xem `curVnd`). Hiện cả hai ô
  // cho một dòng tính bằng ¥ là bày ra hai tỉ giá cho cùng một đồng tiền, và người dùng sẽ
  // sửa nhầm ô không có tác dụng.
  if (costCur === 'VND' || costCur === 'CNY') {
    curWrap.hidden = true;
  } else {
    curWrap.hidden = false;
    $('costCurRateLabel').textContent = costCur + '→₫';
    $('costCurRate').value = curVnd(costCur);
  }
  $('costThresh').value = costThresh();
  $('costControls').hidden = false;
  renderCostCards();
}

// Dựng lại các card 1688 theo TỈ GIÁ + NGƯỠNG hiện tại (KHÔNG fetch lại). Mỗi card = một nguồn
// nhập: hiện giá quy ₫ và % = (giá 1688 × tỉ giá) ÷ giá bán đối thủ. Dưới ngưỡng → class 'cheap' (xanh).
function renderCostCards() {
  const tInput = parseFloat($('costThresh').value);
  const thresh = tInput > 0 ? tInput : costThresh();
  // Giá bán đối thủ quy ¥ (đọc tỉ giá từ localStorage qua cnyVnd/curVnd — onCostCtrlChange đã lưu).
  const sellCny = sellToCny(costCur, costSell);
  $('costGrid').innerHTML = costOffers.map((o, i) => {
    const ratio = (sellCny && o.priceValue != null) ? (o.priceValue / sellCny) * 100 : null; // % = chào hàng ¥ ÷ giá bán ¥
    const cheap = ratio != null && ratio < thresh;
    const ratioHtml = ratio != null ? `<div class="cratio">${ratio.toFixed(1)}% giá bán</div>` : '';
    return (
      `<a class="ccard${cheap ? ' cheap' : ''}" href="${esc(o.link)}" target="_blank" rel="noreferrer">` +
      `<div class="media">${o.thumbnail ? `<img src="${esc(proxyMedia(o.thumbnail))}" loading="lazy" alt="" />` : ''}` +
      `${i === 0 ? '<span class="mbadge">Rẻ nhất</span>' : ''}</div>` +
      `<div class="cbody">` +
      `<div class="cost-price">${esc(o.price || ('¥' + o.priceValue))}</div>` +
      ratioHtml +
      `<div class="ccopy">${esc(o.title || '')}</div>` +
      `<div class="cmeta">${[o.supplier, o.location, o.sold != null ? 'đã bán ' + fmtInt(o.sold) : o.note]
        .filter(Boolean).map(esc).join(' · ')}</div>` +
      `</div></a>`
    );
  }).join('');
}

// Nút "Giá vốn hàng loạt": tra 1688 theo ẢNH cho MỌI dòng đang hiện (bỏ dòng đã có / đã thử),
// điền dần cột "Giá vốn 1688". Song song tối đa 3 để nhanh mà không dội backend. Bấm 💰 từng dòng
// vẫn mở modal chi tiết như cũ.
let costBatchRunning = false;
async function runCost1688Batch() {
  if (costBatchRunning) return;
  const kwPick = $('kwfilter').value || '__all';
  const list = rows.filter((p) => kwPick === '__all' || p.keyword === kwPick);
  // Chỉ tra dòng CHƯA có kết quả (undefined/null). 'none' = đã thử không ra → không tra lại loạt.
  const targets = list.filter((p) => rawImg(p.image) && cost1688[rawImg(p.image)] == null);
  if (!targets.length) { setStatus('Mọi sản phẩm đang hiện đã tra giá vốn 1688 rồi.', 'ok'); return; }

  costBatchRunning = true;
  const btn = $('costAll');
  const total = targets.length; let done = 0, ok = 0, idx = 0;
  const CONC = 2;         // nhẹ tay: bắn 1688 dồn dập dễ dính risk-control (FAIL_SYS_ILLEGAL_ACCESS)
  let blocked = false;    // 1688 chặn IP → dừng loạt, giữ dòng chưa tra để thử lại sau
  // Nhãn nút thành spinner + tiến độ NGAY khi bấm (lần fetch đầu vài giây, đừng để user tưởng lỗi).
  function setBtnRunning() { if (btn) { btn.disabled = true; btn.innerHTML = `<span class="rs-spin"></span>Đang tính… ${done}/${total}`; } }
  setBtnRunning();
  setStatus(`Đang tra giá vốn 1688 cho ${total} sản phẩm…`);
  async function worker() {
    while (idx < targets.length && !blocked) {
      const p = targets[idx++];
      const key = rawImg(p.image);
      try {
        const res = await fetch1688Offers(key, p.name);
        if (res.min && res.min.priceValue != null) { cost1688[key] = res.min.priceValue; ok++; }
        else if (res.error && /ILLEGAL|非法|FAIL_SYS/i.test(res.error)) { blocked = true; break; } // dừng ngay khi bị chặn
        else cost1688[key] = 'none'; // đã thử, không ra → khỏi tra lại ở lần loạt sau
      } catch (e) { cost1688[key] = 'none'; }
      done++;
      setBtnRunning();
      setStatus(`Đang tính giá vốn 1688: ${done}/${total}… (${ok} ra kết quả)`);
      render(); // điền cột dần
      await new Promise((r) => setTimeout(r, 500)); // giãn nhịp cho 1688 đỡ gắn cờ
    }
  }
  try {
    await Promise.all(Array.from({ length: Math.min(CONC, targets.length) }, worker));
    if (blocked) setStatus(`1688 tạm chặn (risk-control 非法请求) sau ${done}/${total}. Đợi vài phút rồi bấm lại, hoặc tra lẻ từng dòng. Đã lấy ${ok} món.`, 'err');
    else setStatus(`Xong giá vốn 1688: ${ok}/${total} sản phẩm ra kết quả. Bấm 💰 một dòng để xem nguồn 1688 chi tiết.`, 'ok');
  } finally {
    costBatchRunning = false;
    if (btn) { btn.disabled = false; btn.textContent = '💰 Giá vốn hàng loạt'; }
    render();
  }
}
$('costAll').addEventListener('click', runCost1688Batch);

$('costClose').addEventListener('click', closeCostModal);
$('costModal').addEventListener('click', (e) => { if (e.target === $('costModal')) closeCostModal(); }); // bấm nền tối để đóng
document.addEventListener('keydown', (e) => { if (e.key === 'Escape' && $('costModal').classList.contains('on')) closeCostModal(); });

// Chỉnh tỉ giá / ngưỡng → lưu localStorage (giữ cho lần sau) rồi tính lại % + tô màu ngay, không fetch lại.
function onCostCtrlChange() {
  const r = parseFloat($('costRate').value);      // ¥→₫ (chung)
  const cr = parseFloat($('costCurRate').value);  // [nước]→₫ (riêng từng nước)
  const t = parseFloat($('costThresh').value);
  try {
    if (r > 0) localStorage.setItem('rs_cost_cny_vnd', String(r));
    if (cr > 0 && costCur !== 'VND') localStorage.setItem('rs_cost_curvnd_' + costCur, String(cr));
    if (t > 0) localStorage.setItem('rs_cost_thresh', String(t));
  } catch (e) { /* storage bị chặn — vẫn tính lại theo giá trị đang gõ */ }
  renderCostCards();
  render(); // cột "Giá vốn 1688" ở bảng chính cũng đổi theo tỉ giá/ngưỡng mới
}
$('costRate').addEventListener('input', onCostCtrlChange);
$('costCurRate').addEventListener('input', onCostCtrlChange);
$('costThresh').addEventListener('input', onCostCtrlChange);

// Giá vốn NHANH: một tab find_similar duy nhất → gọi recommend_post cho top N cùng lúc trong tab
// đó (nếu trang tự ký fetch). Nhanh hơn nhiều lần mở tab từng sản phẩm.
let costRunning = false;
async function runCostBatch(n) {
  if (costRunning) return;
  const targets = [...rows]
    .sort((a, b) => b.score.total - a.score.total)
    .filter((p) => p.platform === 'Shopee' && p.catid && costCache[p.itemid] === undefined) // giá vốn find_similar chỉ có ở Shopee
    .slice(0, n);
  if (!targets.length) return;

  costRunning = true;
  $('calcTop').disabled = true;
  targets.forEach((p) => { costCache[p.itemid] = 'pending'; });
  render();
  setStatus(`Đang tính giá vốn cho ${targets.length} sản phẩm (1 tab find_similar)…`);

  try {
    const seedUrl = targets[0].similarUrl;
    const payload = targets.map((p) => ({ itemid: p.itemid, shopid: p.shopid, catid: p.catid }));
    const res = await new Promise((r) => chrome.runtime.sendMessage({ type: 'RS_COST_BATCH', seedUrl, products: payload }, (x) => r(x)));
    const results = (res && res.results) || {};

    let ok = 0, forbidden = 0;
    for (const p of targets) {
      const r = results[p.itemid];
      let cost = null;
      if (r && r.status === 200 && r.text) {
        try { const arr = []; collectPrices(JSON.parse(r.text), arr); if (arr.length) cost = Math.min(...arr) / PRICE_SCALE; } catch (e) {}
      }
      if (r && r.status === 403) forbidden++;
      if (cost != null) ok++;
      costCache[p.itemid] = cost == null ? 'none' : cost;
    }
    render();
    if (ok === 0 && forbidden > 0) {
      setStatus('Giá vốn: tất cả bị 403 — trang find_similar KHÔNG tự ký fetch của mình. Báo dev để đổi cách.', 'err');
    } else {
      setStatus(`Giá vốn: ${ok}/${targets.length} ok${forbidden ? `, ${forbidden} bị 403` : ''}.`, 'ok');
    }
  } finally {
    costRunning = false;
    $('calcTop').disabled = false;
  }
}

// ---- Sort khi bấm tiêu đề cột ----
document.querySelectorAll('th[data-k]').forEach((th) => {
  th.addEventListener('click', () => {
    sortKey = th.dataset.k;
    document.querySelectorAll('th').forEach((h) => h.classList.remove('sorted'));
    th.classList.add('sorted');
    render();
  });
});

$('go').addEventListener('click', research);
$('kw').addEventListener('keydown', (e) => { if (e.key === 'Enter') research(); });
$('kwfilter').addEventListener('change', render);
$('refreshLogin').addEventListener('click', () => void refreshLogin());
$('regions').addEventListener('click', (e) => {
  // CHẶN NỔI BỌT, và đây là một cái bẫy đã sập chứ không phải đề phòng suông.
  //
  // Bộ lắng nghe "bấm ra ngoài thì đóng" nằm ở `document`, tức là chạy SAU chỗ này. Nhưng chỗ
  // này vẽ lại toàn bộ `#regions`, nên tới lượt nó thì `e.target` đã bị gỡ khỏi tài liệu —
  // `closest('#regions')` trên một node mồ côi trả về `null`, và nó kết luận là bấm ra ngoài.
  // Kết quả: bảng mở ra rồi đóng lại ngay trong cùng một cú bấm, nhìn như nút không ăn.
  e.stopPropagation();

  // --- mở / đóng bảng của một sàn ---
  const trigger = e.target.closest('.rgtrigger');
  if (trigger) {
    const pf = trigger.dataset.pf;
    rgOpen = rgOpen === pf ? null : pf; // bấm lại chính nó = đóng
    renderRegions();
    return;
  }
  if (e.target.closest('.rgdone')) { rgOpen = null; renderRegions(); return; }

  const opt = e.target.closest('.rgopt');
  if (!opt) return;
  const pf = opt.dataset.pf, code = opt.dataset.code;
  // BẤM CHỈ ĐỂ CHỌN NƯỚC. Trước đây nước nào đang ✕ thì bấm vào sẽ mở thẳng trang sàn —
  // người dùng định chọn Thái Lan lại bị đẩy sang shopee.vn, mà lựa chọn thì không đổi.
  const key = `${pf}:${code}`;
  // TICK LÀ BẬT/TẮT, không có chế độ nào cả. Tick một nước ra một, tick mấy nước ra mấy.
  if (selectedRegions.has(key)) {
    // Không để một sàn trống hết nước — muốn bỏ hẳn sàn thì bỏ chọn nó ở hàng SÀN.
    if (PLATFORMS[pf].regions.some((c) => c !== code && selectedRegions.has(`${pf}:${c}`))) selectedRegions.delete(key);
  } else {
    selectedRegions.add(key);
  }
  // GIỮ BẢNG MỞ: không biết được người dùng đã tick xong hay còn tick tiếp, nên đừng đoán.
  // Đóng bằng bấm ra ngoài / Esc / "Xong" — ba lối đó đều có sẵn.
  renderRegions();
});

// Bấm ra ngoài hoặc Esc thì đóng — hai lối thoát mà người dùng thử theo phản xạ, và nếu không
// có thì bảng nằm lì che mất phần bên dưới.
document.addEventListener('click', (e) => {
  if (rgOpen && !e.target.closest('#regions')) { rgOpen = null; renderRegions(); }
});
document.addEventListener('keydown', (e) => {
  if (e.key === 'Escape' && rgOpen) { rgOpen = null; renderRegions(); }
});
$('platforms').addEventListener('click', (e) => {
  const chip = e.target.closest('.rgchip');
  if (!chip) return;
  const id = chip.dataset.pf, cfg = PLATFORMS[id];
  if (!cfg || !cfg.active) return; // sàn chưa hỗ trợ → không chọn được
  // Chọn tự do: bấm để bật/tắt. Được phép bỏ hết (bảng trắng) — Research sẽ nhắc "chọn ít nhất
  // 1 sàn". Số sàn đang bật quyết định chạy 1 hay nhiều, không cần công tắc chế độ.
  if (selectedPlatforms.has(id)) selectedPlatforms.delete(id);
  else selectedPlatforms.add(id);
  renderPlatforms();
  updateRegionSection();
  refreshLogin();
});

// Khởi tạo: vẽ chip sàn + region theo sàn + check đăng nhập.
// ?kw đến từ HAI nơi: popup của extension, và nút "Tìm sản phẩm" ở tab Keyword — nút đó gọi
// `/ads?keyword=...` rồi `app/(dashboard)/ads/page.tsx` chuyền tiếp vào src của iframe này.
// Chỉ ĐIỀN sẵn, không tự bấm Research: mỗi lượt là một loạt crawl thật lên các sàn.
renderPlatforms();
updateRegionSection();
const _kw = new URLSearchParams(location.search).get('kw');
if (_kw) $('kw').value = _kw;
// Xác định extension/relay TRƯỚC, rồi mới kiểm tra đăng nhập (để chạy đúng đường). KHÔNG tự research.
detectMode().then(refreshLogin);

// ===== TAB CONTENT (Facebook Ads) + TAB TÌM BẰNG ẢNH =====
// ===== MODAL VIDEO — "video quảng cáo khớp ẢNH sản phẩm" cho một dòng ở tab Sản phẩm =====
// Gọi backend /api/ads/match-image: seed keyword (tên SP) lấy ứng viên Facebook/TikTok, rồi backend
// so pHash poster video với ẢNH sản phẩm, chỉ trả video TRÙNG ảnh. Cần backend chạy.
let vidToken = 0; // chống race: mỗi lần mở gắn một token, chỉ render kết quả của token mới nhất.
// Douyin có TOKEN RIÊNG. Dùng chung `vidToken` thì bấm 🎥 Douyin sẽ bump token và giết luôn lượt
// TikTok đang chạy — mà TikTok chạy tới hơn hai phút, nên gần như lần nào bấm Douyin giữa chừng
// cũng mất sạch phần TikTok, đúng ngược với ý "gộp thêm vào grid, không xoá TikTok/FB đã có".
let vidDyToken = 0;
let vidState = null; // { p, usedKw, fbAds, marketAds } — giữ FB/Sàn để đổi NƯỚC chỉ tải lại TikTok.

function proxyMedia(url) { return url ? `${BACKEND}/api/media?url=${encodeURIComponent(url)}` : ''; }
function setVidStatus(msg, kind) { $('vidStatusText').textContent = msg; $('vidStatus').className = 'status' + (kind ? ' ' + kind : ''); }
// Đóng cửa sổ là dọn SẠCH: lưới, hàng lọc, danh sách trong bộ nhớ, và cả lớp phủ phát nếu
// đang mở. Bỏ sót cái nào thì lần mở sau sẽ thấy thoáng qua kết quả của sản phẩm trước.
function closeVideoModal() {
  // Bấm đóng là HUỶ, không chỉ là giấu. Không bump token thì lượt tải TikTok/Douyin đang bay
  // (tới hơn hai phút) vẫn về đích và ghi trạng thái + lưới của SẢN PHẨM CŨ vào cửa sổ — thấy
  // rõ nhất ở dòng “Không có video cho …” mang tên một sản phẩm khác cái đang mở.
  vidToken++;
  closeTkPlayer();
  $('vidModal').classList.remove('on');
  $('vidGrid').innerHTML = '';
  $('vidFilter').innerHTML = '';
  vidAll = [];
  vidShown = [];
  vidPick = 'all';
  vidState = null;
  vidDyToken++;
}

async function openVideoModal(p) {
  const my = ++vidToken;
  // Xoá state của SP trước ngay từ đầu: `vidState` là thứ mà nút Douyin và ô chọn nước đọc,
  // và trong quãng chờ Gemini + Facebook (có thể hàng chục giây) cửa sổ đã mở rồi.
  vidState = null;
  vidAll = [];
  vidShown = [];
  $('vidFilter').innerHTML = '';
  $('vidTitle').textContent = p.name || '(không tên)';
  $('vidGrid').innerHTML = '';
  $('vidModal').classList.add('on');

  setVidStatus('Đang lọc từ khoá (Gemini) và lấy video quảng cáo…');

  // Facebook Ad Library nhận country; dùng region của SP nếu là mã 2 chữ, không thì VN.
  const region = /^[A-Z]{2}$/.test((p.region || '').toUpperCase()) ? p.region.toUpperCase() : 'VN';
  fillVidRegions(region); // ô chọn NƯỚC cho TikTok — mặc định = nước của SP

  // Gửi TIÊU ĐỀ sản phẩm (p.name): backend gọi Gemini rút thành từ khoá ĐÚNG LOẠI + mã model
  // (vd "tai nghe gaming chụp tai B39") rồi mới search FB. SP không có tên → rơi về ô tìm kiếm.
  //
  // BA NGUỒN, TẤT CẢ CHẠY Ở SERVER. Trước đây chỗ này chỉ xin `facebook`, nên khi máy-thợ hỏng
  // là cửa sổ trống trơn — và nó đã hỏng im lặng suốt (máy-thợ ngồi đợi `/api/graphql` mà trang
  // Ad Library không còn gọi nữa). Hai nguồn thêm vào đây không cần extension, không cần
  // máy-thợ, không cần đăng nhập:
  //
  //   youtube      đọc trang kết quả YouTube — đo 2026-09-08 từ VPS: 40 video, đủ ảnh bìa + view
  //   tiktokvideo  video TikTok thật, tìm qua Bing — đo: 77 video cho "tai nghe bluetooth"
  //   douyinvideo  Douyin qua Bing, hỏi bằng cụm TIẾNG TRUNG — đo: 20 video
  //   etsy         video SẢN PHẨM do người bán quay (Etsy trả thẳng file .mp4)
  //
  // TikTok Creative Center (`tiktok`) VẪN ĐỨNG NGOÀI: không có TIKTOK_COOKIE thì nó không search
  // được theo từ khoá và trả top-ads cả nước, tức là rác không liên quan sản phẩm.
  const params = new URLSearchParams({
    platforms: 'facebook,youtube,tiktokvideo,douyinvideo,etsy',
    countries: region, limit: '60', videoOnly: 'true',
  });
  if (p.name) params.set('title', p.name);
  else params.set('keyword', ($('kw') && $('kw').value || '').trim());

  let data;
  try {
    const r = await fetch(`${BACKEND}/api/ads/search?${params.toString()}`);
    data = await r.json();
    if (my !== vidToken) return; // đã mở modal khác → bỏ kết quả cũ
    if (!r.ok) { setVidStatus((data && data.error) || 'Chưa lấy được dữ liệu — thử lại sau ít phút.', 'err'); return; }
  } catch (e) {
    if (my !== vidToken) return;
    setVidStatus('Chưa lấy được video quảng cáo — thử lại sau ít phút.', 'err');
    return;
  }

  // `tiktokvideo`/`douyinvideo` LÀ TikTok và Douyin, chỉ khác đường tìm. Đổi tên nguồn NGAY TẠI
  // ĐÂY để mọi thứ phía sau — chip lọc, `vidMerge`, player nhúng — thấy đúng một nền tảng.
  // Quan trọng nhất là `vidMerge`: nó bỏ trùng theo `platform:id`, nên để nguyên tên riêng thì
  // cùng một video tìm được bằng hai đường (Bing và máy-thợ) sẽ hiện thành hai thẻ.
  const DOI_TEN = { tiktokvideo: 'tiktok', douyinvideo: 'douyin' };
  const server = (data.ads || []).map((a) => (
    a && DOI_TEN[a.platform] ? { ...a, platform: DOI_TEN[a.platform], viaBing: true } : a
  ));
  const fbAds = server.filter((a) => a && a.platform === 'facebook');
  const ytAds = server.filter((a) => a && a.platform === 'youtube');
  const bingTk = server.filter((a) => a && a.viaBing && a.platform === 'tiktok');
  const bingDy = server.filter((a) => a && a.viaBing && a.platform === 'douyin');
  // Video SẢN PHẨM do chính người bán quay. Chip "Sàn" trước đây chỉ lấy được từ `rows` — tức
  // là chỉ có khi người dùng đã chạy một lượt tìm sản phẩm trước đó, và chỉ với sàn nào chở
  // sẵn `videoUrl`. Nên nó gần như luôn bằng 0. Nguồn này đi thẳng từ TỪ KHOÁ.
  const sanAds = server.filter((a) => a && !a.viaBing && a.platform !== 'facebook' && a.platform !== 'youtube');
  const usedKw = data.keyword || '(từ khoá)';

  // LÝ DO MỘT NGUỒN RỖNG, lấy từ `statuses` mà backend vẫn trả kèm nhưng cửa sổ này chưa từng
  // đọc. Không giới hạn ở Facebook nữa: giờ có ba nguồn server, và mỗi cái rỗng vì một lý do
  // phải đi sửa một chỗ khác (trình duyệt không mở được, Bing đổi bố cục, YouTube chặn IP…).
  // Hiện trần "YouTube 0" là bắt người dùng đoán, đúng cái bẫy mà chỗ này sinh ra để chống.
  const NHAN = { facebook: 'FB', youtube: 'YouTube', tiktokvideo: 'TikTok' };
  const srvNote = (data.statuses || [])
    .filter((st) => st && st.message && !st.count)
    .map((st) => ` · ${NHAN[st.platform] || st.platform}: ${st.message}`)
    .join('');

  // Video SẢN PHẨM từ SÀN TMĐT: lấy thẳng từ list đã search (rows) — SP nào có videoUrl (Shopee/
  // Taobao/1688/Temu). Không phụ thuộc NƯỚC TikTok nên tính một lần, giữ nguyên khi đổi nước.
  const marketAds = (Array.isArray(rows) ? rows : [])
    .filter((x) => x && x.videoUrl)
    .map((x) => {
      // Temu… videoUrl là FILE mp4 → nhúng phát; Shopee videoUrl là TRANG SP → chỉ link (video
      // Shopee chỉ xem ở trang chi tiết, backend sau này trỏ vào link đó lấy video).
      const isFile = /\.mp4|\.m3u8|\/video\//i.test(x.videoUrl);
      return {
        platform: String(x.platform || 'sàn').toLowerCase(),
        advertiser: x.shop || x.platform || '', title: x.name, body: x.name,
        permalink: x.link || x.videoUrl,
        creatives: [isFile ? { kind: 'video', url: x.videoUrl, posterUrl: x.image || '' } : { kind: 'image', posterUrl: x.image || '' }],
      };
    });

  // Lưu FB + Sàn + region GỐC (của SP) để đổi NƯỚC TikTok chỉ tải lại phần TikTok. `homeRegion`
  // dùng để quyết định mode: chọn khác nước SP → auto hashtag-only (đỡ cá nhân hoá theo account/IP).
  vidState = { p, usedKw, fbAds, ytAds, bingTk, bingDy, sanAds, marketAds, homeRegion: region, srvNote };

  // VẼ NGAY PHẦN ĐÃ CÓ, đừng chờ TikTok.
  //
  // Facebook về sau vài giây; TikTok thì phải mở tab, gõ chữ, cuộn — hàng chục giây, và còn
  // một lượt lấy thống kê nữa phía sau. Chờ đủ cả hai rồi mới vẽ nghĩa là người dùng nhìn màn
  // hình trống suốt quãng ấy, trong khi thứ họ hỏi ("có ai đang chạy quảng cáo món này không")
  // thì Facebook đã trả lời xong rồi.
  const san = sanAds.concat(marketAds);
  renderVideos(vidMerge(fbAds, bingTk, bingDy, ytAds, san));
  setVidStatus(
    `Facebook ${fbAds.length} · TikTok ${bingTk.length} · YouTube ${ytAds.length}` +
    ` · Douyin ${bingDy.length} · Sàn ${san.length}${srvNote} — đang tìm thêm TikTok…`,
    srvNote ? 'err' : '',
  );

  await loadModalTiktok(region);
}

/**
 * Gộp nhiều danh sách thẻ, bỏ trùng theo (nguồn, id) và GIỮ NGUYÊN thứ tự xuất hiện đầu tiên.
 *
 * Cần vì một video TikTok có thể tới từ NHIỀU đường: Kalodata, Google (`site:tiktok.com`), Bing,
 * và lượt tìm thật trong tab TikTok. Mỗi đường chở một phần số đo — Kalodata có doanh thu/số bán,
 * tab TikTok có tim/bình luận — nên giữ bản NẶNG hơn rồi CHÉP SANG những số bản kia có mà nó thiếu.
 * Doanh thu nặng nhất: nó là thứ duy nhất không đường nào khác lấy được.
 */
const VID_MERGE_FIELDS = ['likeCount', 'commentCount', 'shareCount', 'playCount', 'startedAt', 'gmv', 'gmvText', 'saleCount'];
function vidMerge(...lists) {
  const by = new Map();
  const weight = (x) => (x.likeCount != null) + (x.playCount != null) + (x.startedAt != null) + (x.gmv != null ? 3 : 0);
  for (const list of lists) {
    for (const ad of list || []) {
      const key = `${ad.platform}:${ad.id || ad.permalink}`;
      const old = by.get(key);
      if (!old) { by.set(key, ad); continue; }
      const [giu, kia] = weight(ad) > weight(old) ? [ad, old] : [old, ad];
      for (const f of VID_MERGE_FIELDS) if (giu[f] == null && kia[f] != null) giu[f] = kia[f];
      if (kia.viaKalodata) giu.viaKalodata = true;
      by.set(key, giu); // Map giữ vị trí của khoá cũ — thứ tự xuất hiện đầu tiên không đổi
    }
  }
  return [...by.values()];
}

//: region → `hl` của Google. `gl` thì dùng thẳng mã nước. Thiếu tên ở đây → tiếng Anh.
const GOOGLE_HL = {
  VN: 'vi', TH: 'th', ID: 'id', MY: 'ms', PH: 'tl', SG: 'en', TW: 'zh-TW',
  US: 'en', GB: 'en', BR: 'pt-BR', MX: 'es', CO: 'es', CL: 'es', CN: 'zh-CN',
};

/**
 * VIDEO QUA GOOGLE — `site:tiktok.com` / `site:douyin.com` ở tab Hình ảnh.
 *
 * CHẠY TRƯỚC hai nguồn kia, và đó là điểm chính. Lượt tìm thật trong tab TikTok tốn tới hơn hai
 * phút (mở tab, gõ, cuộn) và cần phiên đăng nhập của máy-thợ; Google chỉ là một lần tải trang.
 * Đo 2026-09-06 với “tai nghe bluetooth pro 3”: 62 link video ngay trang đầu, kèm caption và ảnh
 * bìa. Nên người dùng thấy lưới video trong vài giây thay vì nhìn màn hình trống suốt hai phút,
 * còn nguồn chậm hơn thì gộp thêm vào sau — đúng khuôn mà Facebook đã dùng ở `openVideoModal`.
 *
 * Trả về mảng thẻ đã chuẩn hoá (rỗng nếu hỏng) và một ghi chú lý do — không ném lỗi, vì đây là
 * nguồn phụ trợ: nó hỏng thì hai nguồn kia vẫn phải được chạy.
 */
async function fetchGoogleVideos(site, keyword, region) {
  const platform = site === 'douyin' ? 'douyin' : 'tiktok';
  try {
    const g = await new Promise((res) => chrome.runtime.sendMessage({
      type: 'RS_GOOGLE_VIDEOS', site, keyword,
      hl: GOOGLE_HL[region] || 'en', gl: region, count: 60,
    }, (x) => res(x)));
    const items = (g && g.items) || [];
    const ads = items.map((it) => ({
      platform, id: it.id,
      advertiser: it.author || (platform === 'douyin' ? 'Douyin' : 'TikTok'),
      title: it.name, body: it.name,
      permalink: it.videoUrl,
      langMatch: platform === 'douyin' ? 'match' : 'neutral',
      regionTag: region,
      viaGoogle: true,
      // Douyin không có player nhúng công khai → chỉ ảnh bìa + link, như nhánh Douyin sẵn có.
      creatives: [{ kind: platform === 'douyin' ? 'image' : 'video', posterUrl: it.image || '' }],
    }));
    const note = (g && g.error) ? ' · Google: ' + g.error : '';
    return { ads, note };
  } catch (e) {
    return { ads: [], note: ' · Google: chưa lấy được' };
  }
}

// Danh sách NƯỚC cho ô chọn TikTok — dịch keyword/hashtag theo ngôn ngữ nước này (backend _REGION_LANG).
const TIKTOK_REGIONS = ['VN', 'TH', 'ID', 'MY', 'PH', 'SG', 'TW', 'US', 'GB', 'BR', 'MX', 'CO', 'CL'];
function fillVidRegions(selected) {
  const sel = $('vidRegion');
  if (!sel) return;
  const regs = TIKTOK_REGIONS.includes(selected) ? TIKTOK_REGIONS : [selected, ...TIKTOK_REGIONS];
  sel.innerHTML = regs.map((r) => `<option value="${r}"${r === selected ? ' selected' : ''}>${FLAG[r] || ''} ${COUNTRY[r] || r}</option>`).join('');
  sel.value = selected;
}

// Tải phần TikTok theo NƯỚC đã chọn: backend Gemini dịch keyword + hashtag sang ngôn ngữ nước đó,
// extension lặp search + dedup link, rồi render CHUNG với FB + Sàn (đã có trong vidState). Đổi ô
// nước = gọi lại hàm này (FB/Sàn giữ nguyên, chỉ TikTok đổi).
async function loadModalTiktok(region) {
  const st = vidState;
  if (!st) return;
  const my = ++vidToken; // đổi nước = huỷ lần tải TikTok trước (chống race)
  // `vidState === st` là chốt thứ hai, phòng khi cửa sổ đã chuyển sang SP khác: token một mình
  // không đủ nếu về sau có thêm đường gọi nào khác không đi qua `openVideoModal`.
  const alive = () => my === vidToken && vidState === st;
  const p = st.p, usedKw = st.usedKw;

  // MỘT cụm, MỘT lượt tìm.
  //
  // Bản trước gom 3-4 từ khoá cộng 5-7 hashtag rồi chạy tới sáu lượt tìm nối nhau, mỗi lượt là
  // một lần mở tab, gõ chữ, cuộn — người dùng ngồi chờ mấy phút cho một sản phẩm. Mà các cụm
  // thêm ("tai nghe redmi chính hãng", "đánh giá redmi buds 6 play") chỉ là biến tấu quanh cùng
  // một thứ, nên chúng kéo về gần đúng nhóm video mà cụm đầu đã kéo về.
  //
  // Backend giờ trả đúng một cụm đã dịch sang tiếng của nước đang chọn (`/api/ads/video-keywords`).
  // Hỏng thì rơi về `usedKw` — cụm brand+model mà Gemini rút từ tiêu đề ở bước trước.
  let tkTerm = usedKw;
  try {
    const vkParams = new URLSearchParams({ title: p.name || usedKw, region });
    const vr = await fetch(`${BACKEND}/api/ads/video-keywords?${vkParams.toString()}`);
    if (!alive()) return;
    if (vr.ok) {
      const vk = await vr.json();
      const first = (Array.isArray(vk.keywords) ? vk.keywords : []).map((x) => String(x || '').trim()).filter(Boolean)[0];
      if (first) tkTerm = first;
    }
  } catch (e) { /* backend lỗi → dùng usedKw */ }

  const flag = FLAG[region] || '', country = COUNTRY[region] || region;

  // BƯỚC 0 — KALODATA: video TikTok CÓ GẮN GIỎ HÀNG, kèm doanh thu và số bán mà chính video ấy
  // mang về trong 30 ngày (ước lượng của Kalodata). Một lượt API, nhanh hơn Google, và trả lời
  // thẳng câu cửa sổ này hỏi — video nào đang BÁN được món này — thay vì chỉ "video nào nhắc tới".
  // Tốn MỘT lượt credit cho mỗi (cụm × nước) nên đi qua cùng cache 12 giờ với bảng sản phẩm.
  st.kdAds = [];
  st.kdNote = '';
  if (KD_REGIONS.includes(region)) {
    setVidStatus(`FB ${st.fbAds.length} · YouTube ${(st.ytAds || []).length} · đang lấy video bán hàng TikTok ${flag} từ Kalodata “${tkTerm}”…`);
    const kd = await fetchKalodata('video', tkTerm, region, 1);
    if (!alive()) return;
    // Xếp theo doanh thu: thẻ đầu lưới là video bán được nhiều nhất, đúng thứ người research tìm.
    st.kdAds = kd.items.map((v) => kalodataVideoAd(v, region)).filter((a) => a.id).sort((a, b) => (b.gmv || 0) - (a.gmv || 0));
    if (kd.error) st.kdNote = ' · Kalodata: ' + kd.error;
    else if (!st.kdAds.length) st.kdNote = ` · Kalodata: không có video bán hàng cho “${tkTerm}”`;
    if (st.kdAds.length) {
      const som = vidMerge(st.kdAds, st.fbAds, st.bingTk || [], st.bingDy || [], st.ytAds || [], st.sanAds || [], st.marketAds);
      renderVideos(som);
      void fillTiktokStats(som, my);
    }
  } else {
    st.kdNote = ` · Kalodata không có ${country}`;
  }

  // BƯỚC 1 — GOOGLE. Vài giây, không đăng nhập, không cá nhân hoá. Vẽ ngay khi có.
  setVidStatus(`Kalodata ${st.kdAds.length}${st.kdNote} · FB ${st.fbAds.length} · TikTok ${(st.bingTk || []).length} · YouTube ${(st.ytAds || []).length} · Douyin ${(st.bingDy || []).length} · Sàn ${(st.sanAds || []).length + st.marketAds.length} · đang hỏi Google “${tkTerm}”…`);
  const g = await fetchGoogleVideos('tiktok', tkTerm, region);
  if (!alive()) return;
  st.gAds = g.ads;
  if (g.ads.length) {
    // MỘT danh sách dùng cho cả hai việc: `fillTiktokStats` vẽ lại lưới bằng đúng mảng nó nhận,
    // nên đưa nó mỗi phần Google là xoá mất Facebook và Sàn đang hiện.
    const som = vidMerge(st.kdAds, st.fbAds, st.bingTk || [], g.ads, st.bingDy || [], st.ytAds || [], st.sanAds || [], st.marketAds);
    renderVideos(som);
    void fillTiktokStats(som, my); // tim/xem/ngày đăng lấy từ backend, không cần extension
    void fillDouyinStats(som, my);
  }

  // BƯỚC 2 — lượt tìm THẬT trong tab TikTok. Chậm (tới hơn hai phút) nhưng thấy được cả những
  // video Google chưa lập chỉ mục, nên vẫn chạy — chỉ là chạy sau, và gộp thêm vào lưới đã có.
  setVidStatus(`Google ${g.ads.length}${g.note} · đang tìm TikTok ${flag} ${country} · “${tkTerm}”… (tool tự cuộn)`);
  let tkItems = [], tkNote = '', tkCounts = null, tkMode = null;
  try {
    const tk = await new Promise((res) => chrome.runtime.sendMessage({ type: 'RS_TIKTOK', keyword: tkTerm, keywords: [tkTerm], region, mode: 'mixed', count: 100 }, (x) => res(x)));
    if (!alive()) return;
    tkItems = (tk && tk.items) || [];
    tkCounts = (tk && tk.counts) || null;
    tkMode = (tk && tk.mode) || 'mixed';
    if (tk && tk.blocked && tk.error) tkNote = ' · TikTok: ' + tk.error;
  } catch (e) { tkNote = ' · TikTok: chưa lấy được'; }

  // Chuẩn hoá item TikTok về dạng "ad" để render chung; permalink = LINK VIDEO THẬT.
  // langMatch chuyển sang creative để renderVideos gắn badge (không đổi thứ tự — đã sort ở background).
  // likeCount + createdAt: chỉ có khi parseTiktokTexts chộp được API (không DOM), nên có thể null.
  const tkAds = tkItems.map((it) => ({
    platform: 'tiktok', id: it.id, advertiser: it.author || 'TikTok', title: it.name, body: it.name,
    permalink: it.videoUrl, langMatch: it.langMatch || 'neutral', regionTag: region,
    likeCount: it.likeCount || null,
    commentCount: it.commentCount || null,
    playCount: it.playCount || null,
    startedAt: it.createdAt || null,
    creatives: [{ kind: 'video', posterUrl: it.image || '' }],
  }));

// TikTok Ads (Creative Center) ĐÃ GỠ khỏi đây, 2026-08-24.
  //
  // Không phải vì hỏng — sau khi sửa thì nó chộp được 18 quảng cáo thật, đủ video và ảnh bìa.
  // Gỡ vì nó không trả lời được câu hỏi của cửa sổ này. Request tìm-theo-từ-khoá của Creative
  // Center có chữ ký (`user-sign`) phủ cả query string, nên từ đây chỉ đọc được ~20 Top Ads của
  // cả nước rồi lọc phía mình. Đo: "kem chống nắng" 0/18, "tai nghe" 0/18, "áo" 7/18 — và 7 kia
  // chỉ vì "áo" là chuỗi con quá phổ biến. Tức là gần như luôn rỗng, mà vẫn tốn một lượt mở tab
  // cộng tải lại trang.
  //
  // `RS_TIKTOK_CC` vẫn còn ở `extension/background.js` cùng toàn bộ ghi chú đo đạc, phòng khi
  // sau này Creative Center mở đường tìm không cần ký.
  const ccAds = [];

  st.tkAds = tkAds; // lưu để nút 🎥 Douyin có thể gộp thêm mà không xoá TikTok đang có
  st.ccAds = ccAds;
  // CC lên đầu (country filter thật) → TikTok tìm thật → Google → Douyin → sàn. Thẻ của lượt
  // tìm thật đứng trước thẻ Google vì nó chở sẵn tim/lượt xem; `vidMerge` bỏ phần trùng.
  const all = vidMerge(st.kdAds, st.fbAds, ccAds, tkAds, st.bingTk || [], st.gAds || [], st.dyAds || [], st.bingDy || [], st.ytAds || [], st.sanAds || [], st.marketAds);
  if (!all.length) {
    // Rỗng vì HỎNG và rỗng vì THẬT SỰ KHÔNG CÓ là hai câu trả lời khác nhau. `tkNote`/`srvNote`
    // có chữ nghĩa là đã hỏng ở đâu đó — đừng khuyên "thử nước khác", đổi nước không sửa được
    // một máy-thợ đang offline.
    const why = `${st.kdNote || ''}${st.srvNote || ''}${g.note}${tkNote}`;
    setVidStatus(
      why
        ? `Không lấy được video cho "${usedKw}" ${flag} ${country}:${why}`
        : `Không có video cho "${usedKw}" ${flag} ${country}. Thử nước khác hoặc SP khác.`,
      'err',
    );
    return;
  }
  // Nhắc rõ vì sao có video khác ngôn ngữ: TikTok cá nhân hoá theo account/IP, không theo URL.
  const langBreak = tkCounts
    ? ` (khớp ${flag} ${tkCounts.match} · trung tính ${tkCounts.neutral} · khác ngôn ngữ ${tkCounts.other})`
    : '';
  const ccBreak = ccAds.length ? ` · CC ${flag}${ccAds.length}` : '';
  setVidStatus(`${all.length} video · "${usedKw}" · Kalodata ${st.kdAds.length}${st.kdNote || ''} · Google ${(st.gAds || []).length} · Bing ${(st.bingTk || []).length} · TikTok ${flag}${country} ${tkItems.length} · ${tkMode || modeLabel}${langBreak}${ccBreak} · FB ${st.fbAds.length} · YouTube ${(st.ytAds || []).length} · Douyin ${(st.bingDy || []).length} · Sàn ${(st.sanAds || []).length + st.marketAds.length}${st.srvNote || ''}${g.note}${tkNote}`, 'ok');
  renderVideos(all);
  // Vẽ xong rồi mới đi lấy tim/bình luận/lượt xem — xem ghi chú ở `fillTiktokStats`. Không
  // `await`: lưới đã dùng được ngay, số điền vào sau.
  void fillTiktokStats(all, my);
  void fillDouyinStats(all, my);
}

/**
 * Bổ sung tim / bình luận / chia sẻ / LƯỢT XEM cho các thẻ TikTok.
 *
 * ĐI QUA BACKEND, KHÔNG QUA EXTENSION. Backend đọc trang nhúng của chính TikTok bằng Chrome
 * thật — không cần đăng nhập, không cần extension, và cache sáu giờ theo từng video nên lượt
 * sau gần như tức thì (đo: 3 video mất 7,8 giây lần đầu, 1,8 giây lần sau).
 *
 * Bản trước giao việc này cho extension. Nó chạy được về lý thuyết nhưng KHÔNG kiểm được bằng
 * máy — Chrome 151 bỏ `--load-extension` — nên mỗi lần hỏng chỉ còn cách đoán. Đường qua
 * backend thì đo được từ đầu đến cuối, và đó là lý do đổi.
 *
 * Chạy SAU khi đã vẽ lưới và vẽ lại khi có số: người dùng thấy video ngay, số điền vào sau.
 */
async function fillTiktokStats(ads, token) {
  // `== null` chứ không `!a.likeCount`: video có ĐÚNG 0 tim là một phép đo hợp lệ, dùng
  // `!` thì nó rơi vào nhánh "chưa có" và bị đi hỏi lại ở mọi lượt vẽ.
  const ids = ads.filter((a) => a.platform === 'tiktok' && a.id && a.likeCount == null).map((a) => a.id);
  if (!ids.length) return;
  let data;
  try {
    const r = await fetch(`${BACKEND}/api/ads/tiktok-stats?ids=${encodeURIComponent(ids.join(','))}`);
    data = await r.json();
    if (!r.ok) throw new Error((data && data.error) || `HTTP ${r.status}`);
  } catch (e) {
    // Không có số thì thôi, nhưng NÓI RA. Một hàng thống kê trống mà không lời giải đọc thành
    // "video này không ai xem" — sai, và sai theo hướng làm người dùng bỏ qua video tốt.
    if (token === vidToken) setVidStatus($('vidStatusText').textContent + ' · chưa lấy được lượt tim', 'err');
    return;
  }
  if (token !== vidToken) return; // lượt tìm khác đã chen vào — bỏ kết quả cũ

  let co = 0;
  for (const ad of ads) {
    const st = data.stats && data.stats[ad.id];
    if (!st) continue;
    co++;
    ad.likeCount = st.likeCount ?? ad.likeCount;
    ad.commentCount = st.commentCount ?? ad.commentCount;
    ad.shareCount = st.shareCount ?? ad.shareCount;
    ad.playCount = st.playCount ?? ad.playCount;
    ad.startedAt = ad.startedAt || st.createdAt || null;
  }
  if (co) renderVideos(ads);
  if (co < ids.length) {
    // Nói rõ thiếu bao nhiêu. Video riêng tư hoặc đã xoá thì đọc không ra, và đó là chuyện
    // bình thường — nhưng im lặng thì người dùng tưởng công cụ hỏng.
    setVidStatus(`${$('vidStatusText').textContent} · thống kê ${co}/${ids.length} video`, co ? 'ok' : 'err');
  }
}

/**
 * Bổ sung tim / bình luận / LƯỢT LƯU cho các thẻ Douyin.
 *
 * Tách khỏi `fillTiktokStats` vì Douyin trả BỘ SỐ KHÁC — không có chia sẻ, không có lượt xem,
 * đổi lại có lượt lưu. Gộp hai đường vào một hàm sẽ phải bịa ánh xạ giữa hai bộ số khác nghĩa.
 *
 * BẢNG SỐ Ở ĐÂY SẼ THƯA, và đó là giới hạn của Douyin chứ không phải lỗi: họ siết endpoint
 * player, lúc hụt thì trả về một trang trắng. Nên ô trống nghĩa là "Douyin không trả lần này",
 * còn số 0 mới là số thật. Cache sáu giờ theo từng id ở backend khiến các lượt sau nhặt dần
 * những video đã đọc được.
 */
async function fillDouyinStats(ads, token) {
  const ids = ads.filter((a) => a.platform === 'douyin' && a.id && a.likeCount == null).map((a) => a.id);
  if (!ids.length) return;
  let data;
  try {
    const r = await fetch(`${BACKEND}/api/ads/douyin-stats?ids=${encodeURIComponent(ids.join(','))}`);
    data = await r.json();
    if (!r.ok) throw new Error((data && data.error) || `HTTP ${r.status}`);
  } catch (e) {
    return; // không có số thì thôi; dòng trạng thái đã đủ dài, đừng thêm một câu nữa
  }
  if (token !== vidToken) return;

  let co = 0;
  for (const ad of ads) {
    const st = data.stats && data.stats[ad.id];
    if (!st) continue;
    co++;
    ad.likeCount = st.likeCount ?? ad.likeCount;
    ad.commentCount = st.commentCount ?? ad.commentCount;
    ad.collectCount = st.collectCount ?? ad.collectCount;
  }
  if (co) renderVideos(ads);
}

/**
 * Nguồn của một thẻ, dùng cho hàng lọc. Gom "sàn" thành MỘT nhóm: Shopee, Taobao, 1688, Temu
 * đều là video sản phẩm lấy từ trang bán hàng, người dùng đọc chúng như một loại.
 */
function vidSource(ad) {
  // Video Kalodata là TikTok, nhưng là loại người research tìm nhất — video ĐANG BÁN hàng, có
  // doanh thu — nên có chip riêng thay vì chìm giữa hàng trăm video TikTok nhắc tới từ khoá.
  if (ad.viaKalodata) return 'kalodata';
  const pf = String(ad.platform || '').toLowerCase();
  if (pf === 'facebook' || pf === 'tiktok' || pf === 'douyin' || pf === 'youtube') return pf;
  return 'market';
}

const VID_SOURCES = [
  { id: 'all', label: 'Tất cả' },
  { id: 'kalodata', label: 'TikTok bán hàng' },
  { id: 'facebook', label: 'Facebook' },
  { id: 'tiktok', label: 'TikTok' },
  { id: 'youtube', label: 'YouTube' },
  { id: 'douyin', label: 'Douyin' },
  { id: 'market', label: 'Sàn' },
];

/**
 * Link player NHÚNG của một thẻ, hoặc '' nếu nguồn đó không có player công khai.
 *
 * Thay cho phép thử `ad.platform === 'tiktok'` rải khắp nơi. Cái đó đúng khi cửa sổ chỉ có
 * đúng một nguồn xem-được; giờ YouTube cũng nhúng được, mà nó lại là nguồn ĐÔNG video nhất —
 * để nguyên thì thẻ YouTube chỉ còn là ảnh bìa tĩnh, xem được duy nhất bằng cách mở tab mới.
 *
 * Douyin CŨNG nhúng được — xem ghi chú ngay trong thân hàm. Dòng cũ ở đây nói ngược lại
 * ("không mở player cho người ngoài") và đã sai từ 2026-09-09.
 *
 * MỘT THẺ CÓ ▶ LÀ MỘT LỜI HỨA. Chỉ trả về link nhúng cho nguồn ĐÃ XEM TẬN MẮT là phát được;
 * nguồn nào chưa kiểm thì để rơi xuống ảnh bìa + link, vì một nút ▶ mở ra "Video currently
 * unavailable" còn tệ hơn một tấm ảnh tĩnh — người dùng mất một cú bấm mới biết là không có gì.
 *
 * Hàm này chỉ trả lời "SÀN NÀY có player nhúng không". Còn "VIDEO NÀY còn phát được không" là
 * câu khác, do backend hỏi và trả về ở `ad.playable` — xem chỗ dùng trong `vidCard`. Thẻ chết
 * KHÔNG bị loại khỏi lưới, nó chỉ mất nút ▶ và được dán nhãn.
 */
function vidEmbed(ad) {
  if (!ad || !ad.id) return '';
  if (ad.platform === 'tiktok') return `https://www.tiktok.com/embed/v2/${encodeURIComponent(ad.id)}`;
  if (ad.platform === 'youtube') return `https://www.youtube.com/embed/${encodeURIComponent(ad.id)}`;
  // Douyin CÓ player nhúng chính thức, và nó nhận thẳng `aweme_id` mình đang có. Đo 2026-09-09:
  // trả 200, KHÔNG có `X-Frame-Options` cũng không có `frame-ancestors`, và nhúng thử vào chính
  // trang này thì chạy. Ghi chú cũ ("Douyin không mở player cho người ngoài") đã hết đúng.
  //
  // Nhúng từ TRÌNH DUYỆT NGƯỜI DÙNG nên không dính chỗ Douyin siết server của mình: mỗi người
  // mở một video một lúc, bằng IP của chính họ.
  if (ad.platform === 'douyin') return `https://open.douyin.com/player/video?vid=${encodeURIComponent(ad.id)}&autoplay=0`;
  return '';
}

let vidAll = [];       // toàn bộ thẻ đang có, chưa lọc
let vidShown = [];     // phần đang hiện — cũng là danh sách để bấm ‹ › trong lớp phủ
let vidPick = 'all';

/** Vẽ hàng lọc. Chip bằng 0 VẪN HIỆN — xem ghi chú CSS `.vfilter`. */
function drawVidFilter() {
  const box = $('vidFilter');
  if (!box) return;
  const dem = {};
  for (const ad of vidAll) dem[vidSource(ad)] = (dem[vidSource(ad)] || 0) + 1;
  box.innerHTML = VID_SOURCES
    .map((s) => {
      const n = s.id === 'all' ? vidAll.length : (dem[s.id] || 0);
      return `<button data-src="${s.id}" data-on="${vidPick === s.id ? 1 : 0}">${s.label}<b>${n}</b></button>`;
    })
    .join('');
}

function drawVidGrid() {
  const grid = $('vidGrid');
  grid.innerHTML = '';
  vidShown = vidPick === 'all' ? vidAll.slice() : vidAll.filter((a) => vidSource(a) === vidPick);
  if (!vidShown.length) {
    // Một CÂU, không phải một ô trống. Ô trống đọc thành "hỏng"; câu này nói rõ là nguồn ấy
    // không có gì, và đó là một thông tin.
    grid.innerHTML = `<p class="sub">Không có video nào từ nguồn này.</p>`;
    return;
  }
  for (let i = 0; i < vidShown.length; i++) grid.appendChild(vidCard(vidShown[i], i));
}

/**
 * Một con số thống kê CỦA CHÍNH VIDEO ẤY. Không cộng gộp gì cả — mỗi thẻ đọc đúng trường của
 * mình.
 *
 * SỐ 0 VẪN HIỆN, chỉ trường VẮNG MẶT mới ẩn. Hai chuyện khác hẳn nhau và giao diện phải phân
 * biệt được: "0 bình luận" là một phép đo — video ấy thật sự không ai bình luận, và đó là
 * thông tin đáng giá khi chọn video để bắt chước. Còn trường vắng mặt nghĩa là đọc không ra
 * (video riêng tư, đã xoá, hoặc hết hạn giờ), và bịa ra số 0 cho nó là nói dối.
 *
 * Rút gọn về K/M cho mọi cỡ: bốn ô số đứng cạnh nhau trong một thẻ hẹp, viết đủ "41.400.000"
 * thì vỡ hàng. Số đầy đủ nằm trong phần chú khi rê chuột.
 */
function stat(icon, ten, v) {
  if (typeof v !== 'number' || v < 0) return '';
  return `<span title="${ten}: ${v.toLocaleString('vi-VN')}">${icon}<span class="n">${fmtCompact(v)}</span></span>`;
}

/**
 * Số đo BÁN HÀNG của video (chỉ có ở thẻ Kalodata): số đơn và doanh thu 30 ngày video mang về.
 * Doanh thu hiện nguyên chuỗi Kalodata đã format theo tiền nước đó ("₫3,56tr") — hiện thì đúng,
 * chỉ không được parse.
 */
function kdSaleStats(ad) {
  return stat('🛒', 'Đơn bán qua video (30 ngày, ước lượng Kalodata)', ad.saleCount) +
    (ad.gmvText
      ? `<span title="Doanh thu video mang về trong 30 ngày — ước lượng Kalodata">💰<span class="n">${esc(ad.gmvText)}</span></span>`
      : '') +
    (ad.followerText
      ? `<span title="Người theo dõi tài khoản đăng video (Kalodata)">👥<span class="n">${esc(ad.followerText)}</span></span>`
      : '') +
    // Tỉ lệ lượt xem đến từ QUẢNG CÁO: video ">90%" là video được đẩy bằng tiền, không phải tự viral —
    // hai loại cần đọc khác nhau khi chọn content để làm theo.
    (ad.adViewText
      ? `<span title="Tỉ lệ lượt xem đến từ quảng cáo (Kalodata)">📣<span class="n">${esc(ad.adViewText)}</span><span class="k">từ QC</span></span>`
      : '');
}

function vidCard(ad, idx) {
  const creatives = ad.creatives || [];
  const video = creatives.find((c) => c.kind === 'video' && c.url);
  const poster = (video && video.posterUrl) ||
    (creatives.find((c) => c.posterUrl) || {}).posterUrl ||
    (creatives.find((c) => c.url) || {}).url || '';

  // HÀNG THỐNG KÊ riêng, tách khỏi hàng nhãn. Đây là thứ người dùng quét mắt qua để chọn
  // video đáng xem, nên nó không được lẫn vào giữa tên sàn và ngày tháng.
  const stats =
    kdSaleStats(ad) +
    stat('❤️', 'Lượt tim', ad.likeCount) +
    stat('💬', 'Bình luận', ad.commentCount) +
    stat('↗', 'Chia sẻ', ad.shareCount) +
    // Douyin KHÔNG có chia sẻ và KHÔNG có lượt xem — player của họ đưa lượt LƯU vào đúng chỗ
    // TikTok để chia sẻ. Cho nó một ô riêng thay vì nhét vào ô chia sẻ cho đủ hàng: hai thứ
    // khác nghĩa, và một con số đặt nhầm tên thì tệ hơn một ô trống.
    stat('🔖', 'Lượt lưu', ad.collectCount) +
    stat('▶', 'Lượt xem', ad.playCount);
  // Facebook không có tương tác nào (Ads Library không công bố — đo 2026-08-18), chỉ có số
  // người theo dõi Trang. Nói rõ đó là follower chứ không phải like của bài.
  const fbFollow = !stats && ad.pageLikeCount
    ? `<span title="Người theo dõi Trang Facebook — KHÔNG phải tương tác của quảng cáo này">👥<span class="n">${fmtCompact(ad.pageLikeCount)}</span><span class="k">theo dõi</span></span>`
    : '';

  const days = ad.daysActive != null ? `<span title="Số ngày quảng cáo đã chạy">${ad.daysActive} ngày chạy</span>` : '';
  const posted = ad.startedAt ? `<span title="Ngày đăng / bắt đầu chạy">📅 ${fmtRelDate(ad.startedAt)}</span>` : '';
  const match = typeof ad.matchScore === 'number' ? `<span class="mbadge">🎯 ${ad.matchScore}% khớp ảnh</span>` : '';
  const langBadge = (ad.langMatch === 'other' && ad.regionTag)
    ? `<span class="mbadge langoff" title="Mô tả không phải tiếng ${COUNTRY[ad.regionTag] || ad.regionTag} — TikTok trả theo account/IP của bạn">⚠ khác ngôn ngữ</span>`
    : '';

  const nhan = PF_LABEL[ad.platform] || ad.platform || 'video';
  // `playable === false` = sàn ĐÃ TRẢ LỜI rằng video không còn (backend hỏi oEmbed —
  // `lib/ads/bingvideo.py`). `undefined`/`null` là CHƯA KIỂM, và phải đối xử như phát được:
  // nguồn nào không có cách kiểm (Douyin) mà bị coi là chết thì cả lưới mất nút ▶.
  //
  // THẺ VẪN Ở LẠI. Ảnh bìa do chính Bing phục vụ nên nó sống lâu hơn video — đo 2026-09-10:
  // video trả oEmbed 400 mà `ts1.mm.bing.net` vẫn trả 200 image/jpeg. Ảnh bìa + tiêu đề +
  // tài khoản + lượt xem vẫn trả lời được câu "có ai đang bán món này không", nên bỏ thẻ đi
  // là vứt dữ liệu research thật chỉ vì một nút bấm không dùng được.
  const chetRoi = ad.playable === false;
  const nhung = chetRoi ? '' : vidEmbed(ad);
  let media;
  if (nhung) {
    // Chỗ giữ khi CHƯA có ảnh bìa để trống chữ: tên nguồn đã nằm ở `.pill` dưới thân thẻ rồi,
    // in thêm một lần nữa ngay trên ảnh là nói hai lần cùng một thứ trên một thẻ ba dòng.
    media =
      (poster ? `<img src="${esc(poster)}" loading="lazy" alt="" referrerpolicy="no-referrer">` : '<div class="tk-ph"></div>') +
      `<button class="play-overlay" data-idx="${idx}" aria-label="Phát video ${esc(nhan)}"><span>▶</span></button>`;
  } else if (video && video.url && !chetRoi) {
    media = `<video controls preload="none" ${poster ? `poster="${esc(proxyMedia(poster))}"` : ''} src="${esc(proxyMedia(video.url))}"></video>`;
  } else {
    // Không có player: chỉ ảnh bìa. Với thẻ đã chết thì kèm một nhãn nói ĐÚNG chuyện gì xảy
    // ra — thiếu nhãn, một thẻ không có nút ▶ đọc thành "tool lấy thiếu", trong khi sự thật
    // là chính sàn đã gỡ video còn ảnh bìa thì vẫn là ảnh bìa thật của nó.
    media =
      (poster ? `<img src="${esc(proxyMedia(poster))}" loading="lazy" alt="">` : '<div class="tk-ph"></div>') +
      (chetRoi ? `<span class="mbadge langoff" title="Sàn đã gỡ hoặc chuyển riêng tư video này. Ảnh bìa lấy từ chỉ mục Bing nên vẫn còn.">⚠ không phát được</span>` : '');
  }

  const el = document.createElement('div');
  el.className = 'ccard';
  el.innerHTML =
    `<div class="media">${match}${langBadge}${media}</div>` +
    `<div class="cbody">` +
    `<div class="cadv">${esc(ad.advertiser || '—')}</div>` +
    `<div class="ccopy">${esc(ad.title || ad.body || '')}</div>` +
    ((stats || fbFollow) ? `<div class="cstats">${stats}${fbFollow}</div>` : '') +
    `<div class="cmeta"><span class="pill">${esc(PF_LABEL[ad.platform] || ad.platform)}</span>${posted}${days}</div>` +
    (ad.permalink ? `<a class="clink" href="${esc(ad.permalink)}" target="_blank" rel="noreferrer">${nhung ? `Mở trên ${esc(nhan)} ↗` : 'Xem quảng cáo ↗'}</a>` : '') +
    `</div>`;
  return el;
}

function renderVideos(ads) {
  vidAll = ads || [];
  // Nguồn đang lọc có thể vừa biến mất (đổi nước, đổi sản phẩm) — về "Tất cả" thay vì để
  // người dùng nhìn một lưới trống mà không hiểu vì sao.
  if (vidPick !== 'all' && !vidAll.some((a) => vidSource(a) === vidPick)) vidPick = 'all';
  drawVidFilter();
  drawVidGrid();
}

/*
 * CỬA CHO MÁY CHẠY THỬ. Lộ đúng một hàm vẽ và danh sách đang hiện, không lộ gì để sửa dữ liệu.
 *
 * Có nó vì phần cửa sổ video chỉ chạy được khi extension đã bơm kết quả TikTok vào, mà Chrome
 * 151 thì không cho nạp extension trong máy tự động — không có cửa này thì toàn bộ hàng lọc,
 * hàng thống kê và lớp phủ phát KHÔNG kiểm được bằng máy, chỉ còn cách nhìn bằng mắt.
 */
window.__rsVid = {
  render: renderVideos,
  // Tự truyền mã lượt hiện tại: `fillTiktokStats` bỏ qua kết quả của lượt cũ, nên gọi
  // trần từ ngoài sẽ luôn rơi vào nhánh ấy.
  fill: (ads) => fillTiktokStats(ads, vidToken),
  get shown() { return vidShown; },
};

$('vidFilter').addEventListener('click', (e) => {
  const b = e.target.closest('button[data-src]');
  if (!b) return;
  vidPick = b.getAttribute('data-src');
  drawVidFilter();
  drawVidGrid();
});

// ===== LỚP PHỦ PHÁT VIDEO =====
//
// Bấm ▶ mở player ở một lớp phủ riêng, KHÔNG nhét iframe vào ô ảnh của thẻ. Ô ấy là hình vuông
// cỡ ba trăm pixel, còn player TikTok là khung dọc có chiều cao tối thiểu — nhét vào đó thì nó
// cắt cụt hoặc rơi về màn hình "Watch more exciting videos on TikTok".
//
// Đã đo: `embed/v2`, `embed` và `player/v1` đều trả 200, không có `X-Frame-Options` cũng không
// có `frame-ancestors`. Nhúng chưa bao giờ bị chặn; chỉ là cái khung quá nhỏ.
//
// Lớp phủ mang theo THÔNG TIN VIDEO bên cạnh và hai nút ‹ › để đi tiếp — trước đây muốn biết
// đang xem của ai, bao nhiêu tim, thì phải đóng ra tìm lại đúng cái thẻ vừa bấm.
let tkAt = -1; // vị trí trong `vidShown` của video đang phát

function tkInfoHTML(ad) {
  const stats =
    kdSaleStats(ad) +
    stat('❤️', 'Lượt tim', ad.likeCount) +
    stat('💬', 'Bình luận', ad.commentCount) +
    stat('↗', 'Chia sẻ', ad.shareCount) +
    stat('🔖', 'Lượt lưu', ad.collectCount) +
    stat('▶', 'Lượt xem', ad.playCount);
  return (
    `<h3>${esc(ad.advertiser || '—')}</h3>` +
    (stats ? `<div class="cstats">${stats}</div>` : '') +
    `<div class="desc">${esc(ad.title || ad.body || '')}</div>` +
    (ad.startedAt ? `<div class="sub">📅 ${fmtRelDate(ad.startedAt)}</div>` : '') +
    (ad.permalink ? `<a href="${esc(ad.permalink)}" target="_blank" rel="noreferrer">Mở trên ${esc(PF_LABEL[ad.platform] || ad.platform || 'nguồn')} ↗</a>` : '')
  );
}

function openTkPlayer(idx) {
  const ad = vidShown[idx];
  const src = vidEmbed(ad);
  if (!src) return;
  tkAt = idx;
  const khung = $('tkFrame');
  khung.innerHTML = '';
  const f = document.createElement('iframe');
  f.src = src;
  f.allow = 'autoplay; encrypted-media; fullscreen';
  f.setAttribute('scrolling', 'no');
  khung.appendChild(f);
  $('tkInfo').innerHTML = tkInfoHTML(ad);

  // Chỉ đi tới thẻ NHÚNG ĐƯỢC khác — thẻ Facebook/Sàn/Douyin không có player để nhảy sang.
  const co = (d) => {
    for (let i = idx + d; i >= 0 && i < vidShown.length; i += d) {
      if (vidEmbed(vidShown[i])) return i;
    }
    return -1;
  };
  $('tkPrev').disabled = co(-1) < 0;
  $('tkNext').disabled = co(1) < 0;
  $('tkPlay').classList.add('on');
}

function tkStep(d) {
  for (let i = tkAt + d; i >= 0 && i < vidShown.length; i += d) {
    if (vidEmbed(vidShown[i])) { openTkPlayer(i); return; }
  }
}

function closeTkPlayer() {
  $('tkPlay').classList.remove('on');
  // XOÁ HẲN iframe chứ không chỉ ẩn: để nguyên thì video chạy tiếp và tiếng vẫn phát sau lưng
  // một lớp phủ đã đóng — người dùng không có cách nào tắt ngoài việc tải lại trang.
  $('tkFrame').innerHTML = '';
  $('tkInfo').innerHTML = '';
  tkAt = -1;
}

$('vidGrid').addEventListener('click', (e) => {
  const btn = e.target.closest('.play-overlay[data-idx]');
  if (!btn) return;
  openTkPlayer(Number(btn.getAttribute('data-idx')));
});
$('tkPlayClose').addEventListener('click', closeTkPlayer);
$('tkPrev').addEventListener('click', () => tkStep(-1));
$('tkNext').addEventListener('click', () => tkStep(1));
// Bấm ra nền tối cũng đóng — nhưng chỉ khi bấm đúng cái nền, không phải bấm trong player.
$('tkPlay').addEventListener('click', (e) => { if (e.target === $('tkPlay')) closeTkPlayer(); });
document.addEventListener('keydown', (e) => {
  if (!$('tkPlay').classList.contains('on')) return;
  if (e.key === 'Escape') closeTkPlayer();
  else if (e.key === 'ArrowLeft') tkStep(-1);
  else if (e.key === 'ArrowRight') tkStep(1);
});

$('vidClose').addEventListener('click', closeVideoModal);
// Đổi NƯỚC TikTok → dịch keyword + hashtag sang ngôn ngữ nước đó rồi tìm lại (FB/Sàn giữ nguyên).
$('vidRegion').addEventListener('change', (e) => { if (vidState) loadModalTiktok(e.target.value); });
$('vidDouyin').addEventListener('click', () => { if (vidState) loadModalDouyin(); });

// Bấm 🎥 Douyin: backend Gemini dịch tiêu đề SP sang từ khoá/hashtag TIẾNG TRUNG (region=CN), gửi
// cho background search Douyin. Chạy tách khỏi TikTok — user chủ động bấm (Douyin hay verify, đừng
// tự chạy mỗi lần mở modal). Kết quả gộp thêm vào grid, không xoá TikTok/FB đã có.
async function loadModalDouyin() {
  const st = vidState;
  if (!st) return;
  const p = st.p, usedKw = st.usedKw;
  const my = ++vidDyToken;
  const alive = () => my === vidDyToken && vidState === st;

  // MỘT cụm, dịch sang tiếng Trung (CN) — cùng lý do như TikTok: mỗi cụm là một lượt mở tab,
  // gõ, cuộn, và Douyin còn hay chen màn xác minh 滑块 giữa chừng.
  let dyTerm = usedKw;
  try {
    const vkParams = new URLSearchParams({ title: p.name || usedKw, region: 'CN' });
    const vr = await fetch(`${BACKEND}/api/ads/video-keywords?${vkParams.toString()}`);
    if (!alive()) return;
    if (vr.ok) {
      const vk = await vr.json();
      const first = (Array.isArray(vk.keywords) ? vk.keywords : []).map((x) => String(x || '').trim()).filter(Boolean)[0];
      if (first) dyTerm = first;
    }
  } catch (e) { /* backend lỗi → dùng usedKw (tiếng Việt, Douyin vẫn thử) */ }

  // GOOGLE TRƯỚC, y như nhánh TikTok — và ở Douyin thì đáng giá hơn nữa: lượt tìm thật trên
  // douyin.com hay chen màn xác minh 滑块 phải có người ngồi kéo, còn Google thì không.
  setVidStatus(`Đang hỏi Google “${dyTerm}” (site:douyin.com)…`);
  const gd = await fetchGoogleVideos('douyin', dyTerm, 'CN');
  if (!alive()) return;
  st.dyAds = vidMerge(st.dyAds || [], gd.ads);
  if (gd.ads.length) renderVideos(vidMerge(st.kdAds || [], st.fbAds, st.tkAds || [], st.gAds || [], st.dyAds, st.marketAds));

  setVidStatus(`Google ${gd.ads.length}${gd.note} · đang lấy Douyin (抖音) cho “${dyTerm}”… (nếu ra 滑块 verify, kéo trong tab)`);
  let dyItems = [], dyNote = '';
  try {
    const dy = await new Promise((res) => chrome.runtime.sendMessage({ type: 'RS_DOUYIN', keyword: dyTerm, keywords: [dyTerm], anchor: dyTerm, count: 60 }, (x) => res(x)));
    if (!alive()) return;
    dyItems = (dy && dy.items) || [];
    if (dy && dy.blocked && dy.error) dyNote = ' · Douyin: ' + dy.error;
  } catch (e) { dyNote = ' · Douyin: chưa lấy được'; }

  // Chuẩn hoá Douyin item về "ad" — Douyin video KHÔNG có player embed public như TikTok, nên chỉ
  // hiện poster + link mở trên Douyin. platform='douyin' để card không dính nhánh play-overlay TikTok.
  // likeCount + createdAt: chỉ có khi parseDouyinTexts chộp được API, có thể null.
  const dyAds = dyItems.map((it) => ({
    platform: 'douyin', id: it.id, advertiser: it.author || 'Douyin', title: it.name, body: it.name,
    permalink: it.videoUrl, langMatch: 'match', regionTag: 'CN',
    likeCount: it.likeCount || null,
    commentCount: it.commentCount || null,
    startedAt: it.createdAt || null,
    creatives: [{ kind: 'image', posterUrl: it.image || '' }],
  }));

  // Gộp thêm vào grid: thẻ của lượt tìm thật đứng TRƯỚC thẻ Google vì nó chở sẵn tim/ngày đăng,
  // và `vidMerge` giữ bản đầy hơn khi hai đường cùng trả về một video.
  st.dyAds = vidMerge(dyAds, st.dyAds || []);
  const all = vidMerge(st.kdAds || [], st.fbAds, st.tkAds || [], st.gAds || [], st.dyAds, st.marketAds);
  // "Douyin 0" trần trụi trông giống một lượt còn đang chạy. Có `dyNote` thì đó là lý do hỏng;
  // không có mà vẫn rỗng thì nói thẳng là tìm không ra, kèm cụm đã tìm để người dùng tự đánh giá.
  const dyTotal = st.dyAds.length;
  setVidStatus(
    dyTotal
      ? `${all.length} video · Douyin ${dyTotal} (Google ${gd.ads.length} · tìm thật ${dyItems.length})${gd.note}${dyNote}`
      : `${all.length} video · Douyin${gd.note}${dyNote || ` không tìm thấy video nào cho “${dyTerm}”.`}`,
    dyTotal ? 'ok' : 'err',
  );
  renderVideos(all);
}
$('vidModal').addEventListener('click', (e) => { if (e.target === $('vidModal')) closeVideoModal(); });
window.addEventListener('keydown', (e) => { if (e.key === 'Escape' && $('vidModal').classList.contains('on')) closeVideoModal(); });

})();
