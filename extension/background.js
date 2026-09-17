/*
 * Service worker — điều phối fetch, nhưng KHÔNG tự gọi mạng.
 *
 * Bài học đo được: fetch thẳng từ service worker là CROSS-ORIGIN (chrome-extension:// →
 * shopee.vn) nên Shopee trả 403 dù đã đăng nhập — request không đến từ trang shopee.vn.
 * Cách đúng: chạy fetch NGAY TRONG tab shopee.vn qua executeScript(world:'MAIN'). Khi ấy
 * request là same-origin, mang theo cookie + ngữ cảnh trang y như chính Shopee tự gọi.
 *
 * Nếu chưa có tab của sàn, tự mở một tab nền (cookie theo domain nên vẫn đăng nhập sẵn).
 */

const VERSION = '0.5.1';

// TikTok Shop qua KALODATA (sản phẩm + video bán hàng) — lõi tách riêng, xem đầu file kalodata.js.
// Service worker cổ điển (manifest không khai `type: module`) nên `importScripts` chạy được.
importScripts('kalodata.js');

const SHOPEE_DOMAINS = ['shopee.vn', 'shopee.co.th', 'shopee.ph', 'shopee.com.my', 'shopee.co.id', 'shopee.sg', 'shopee.tw', 'shopee.com.br', 'shopee.com.mx', 'shopee.com.co', 'shopee.cl'];
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function hostOf(url) {
  try { return new URL(url).host; } catch { return null; }
}

// Đăng ký hook document_start (MAIN world) cho trang find_similar — để nó bọc fetch TRƯỚC khi
// trang gọi recommend_post. Đăng ký một lần; gọi lại an toàn.
async function ensureHook() {
  try {
    const existing = await chrome.scripting.getRegisteredContentScripts({ ids: ['rs-similar-hook'] });
    if (existing.length) return;
    await chrome.scripting.registerContentScripts([{
      id: 'rs-similar-hook',
      matches: SHOPEE_DOMAINS.map((d) => `https://${d}/find_similar_products*`),
      js: ['similar-hook.js'],
      runAt: 'document_start',
      world: 'MAIN',
    }]);
  } catch (e) { /* đã đăng ký hoặc lỗi nhẹ — bỏ qua */ }
}
ensureHook();

// Đăng ký hook CHUNG (page-hook.js) cho Taobao/Tmall/Temu — chộp response search mà chính trang tự gọi
// (ta không tự ký được mtop x5sec / anti-content của họ). Cài document_start world MAIN. Gọi lại an toàn.
const PAGE_HOOK_MATCHES = [
  'https://*.taobao.com/*', 'https://*.tmall.com/*', 'https://*.temu.com/*', 'https://*.facebook.com/*',
  'https://trends.google.com/*', 'https://trends.google.com.vn/*',
];
async function ensurePageHook() {
  try {
    const existing = await chrome.scripting.getRegisteredContentScripts({ ids: ['rs-page-hook'] });
    // ĐÃ ĐĂNG KÝ THÌ VẪN PHẢI SO DANH SÁCH HOST, không được `return` sớm.
    //
    // Bản đăng ký cũ sống trong hồ sơ Chrome, không sống theo file: máy-thợ đang chạy đã có
    // `rs-page-hook` với bốn host cũ, nên thêm host mới vào mảng này mà thoát sớm thì hook
    // KHÔNG BAO GIỜ chạy trên host mới — và triệu chứng là "job chạy nhưng không chộp được gì",
    // đúng kiểu lỗi tốn cả buổi để tìm.
    if (existing.length) {
      const have = new Set(existing[0].matches || []);
      if (PAGE_HOOK_MATCHES.every((m) => have.has(m))) return;
      await chrome.scripting.unregisterContentScripts({ ids: ['rs-page-hook'] });
    }
    await chrome.scripting.registerContentScripts([{
      id: 'rs-page-hook',
      matches: PAGE_HOOK_MATCHES,
      js: ['page-hook.js'],
      runAt: 'document_start',
      world: 'MAIN',
    }]);
  } catch (e) { /* đã đăng ký hoặc lỗi nhẹ — bỏ qua */ }
}
ensurePageHook();

// Chạy TRONG trang find_similar: trả response recommend_post mà hook chộp được, và một fallback
// đọc giá thấp nhất từ DOM (phòng khi hook lỡ nhịp). Giá DOM là VND thật; giá trong JSON ×100000.
function scrapeSimilar() {
  const captured = window.__rsCaptured || null;
  let domMin = null;
  try {
    // textContent (không cần layout — tab nền không paint nên innerText có thể rỗng).
    const text = document.body ? document.body.textContent : '';
    const re = /₫\s?([\d.]+)/g;
    let m; const vals = [];
    while ((m = re.exec(text))) { const n = Number(m[1].replace(/\./g, '')); if (n >= 1000) vals.push(n); }
    if (vals.length) domMin = Math.min(...vals);
  } catch (e) {}
  return { captured, domMin };
}

// Mở tab nền tới trang find_similar, để JS Shopee tự gọi (đã ký) recommend_post, chộp response
// qua hook. Trả {text, domMin}: ưu tiên text (JSON đầy đủ), fallback domMin (giá VND từ DOM).
async function findSimilar(url) {
  await ensureHook();
  const tab = await chrome.tabs.create({ url, active: false });
  try {
    await waitForComplete(tab.id, 12000);
    const deadline = Date.now() + 15000;
    let domMin = null;
    while (Date.now() < deadline) {
      await sleep(700);
      try {
        const out = await chrome.scripting.executeScript({ target: { tabId: tab.id }, world: 'MAIN', func: scrapeSimilar });
        const r = out && out[0] && out[0].result;
        if (r) {
          if (r.captured) return { text: r.captured, domMin: null };
          if (typeof r.domMin === 'number') domMin = r.domMin;
        }
      } catch (e) { /* trang chưa sẵn sàng */ }
    }
    return { text: '', domMin };
  } finally {
    try { await chrome.tabs.remove(tab.id); } catch (e) {}
  }
}

async function findTab(host) {
  const tabs = await chrome.tabs.query({ url: `https://${host}/*` });
  return tabs.find((t) => t.id != null) || null;
}

// FACEBOOK AD LIBRARY qua máy-thợ. FB soft-block playwright (headless LẪN headed) trên VPS —
// trả 200 kèm 0 kết quả — nhưng Chrome THẬT của máy-thợ ra >50k. Không tự ký được query GraphQL
// của FB, nên KÝ SINH: điều hướng tab tới URL Ad Library của keyword → chính trang bắn
// AdLibrarySearchPaginationQuery (đã ký) → page-hook.js chộp RESPONSE (lọc ad_archive_id) →
// trả text thô về backend parse. Cuộn để lấy thêm trang (best-effort; tab nền có thể không kích hoạt).
function fbSearchUrl(kw, country, activeStatus, searchType) {
  const p = new URLSearchParams({
    active_status: activeStatus === 'all' ? 'all' : 'active',
    ad_type: 'all',
    country: country || 'VN',
    media_type: 'all',
    q: kw || '',
    search_type: searchType || 'keyword_exact_phrase',
  });
  return 'https://www.facebook.com/ads/library/?' + p.toString();
}

async function fbAdLibrary(payload) {
  await ensurePageHook();
  const url = fbSearchUrl(payload.keyword, payload.country, payload.activeStatus, payload.searchType);
  const tab = await chrome.tabs.create({ url, active: false });
  const pages = [];
  const seen = new Set();
  try {
    await waitForComplete(tab.id, 20000);
    const maxPages = Math.max(1, Math.min(6, Number(payload.maxPages) || 4));
    const deadline = Date.now() + 45000;
    let scrolls = 0;
    while (Date.now() < deadline && pages.length < maxPages) {
      await sleep(1200);
      let cap = [];
      try {
        const out = await chrome.scripting.executeScript({
          target: { tabId: tab.id }, world: 'MAIN',
          func: () => (window.__rsCap || []).filter((c) => c.url.indexOf('/api/graphql') !== -1),
        });
        cap = (out && out[0] && out[0].result) || [];
      } catch (e) { /* trang chưa sẵn sàng */ }
      for (const c of cap) {
        const key = c.ts + ':' + (c.text ? c.text.length : 0);
        if (seen.has(key)) continue;
        seen.add(key);
        pages.push(c.text);
      }
      // Cuộn để FB bắn trang tiếp (chỉ khi còn thiếu). Tab nền không paint nên có thể không kích
      // hoạt intersection-observer của FB — chấp nhận best-effort, ít nhất luôn có trang đầu.
      if (pages.length < maxPages && scrolls < maxPages + 2) {
        scrolls++;
        try {
          await chrome.scripting.executeScript({
            target: { tabId: tab.id }, world: 'MAIN',
            func: () => window.scrollTo(0, document.body ? document.body.scrollHeight : 20000),
          });
        } catch (e) {}
      }
    }
    // KHÔNG CHỘP ĐƯỢC GÌ THÌ PHẢI NÓI ĐƯỢC VÌ SAO. Đo 2026-09-06 từ máy-thợ: job chạy hết 45 giây
    // rồi trả về 0 trang cho MỌI từ khoá, kể cả "kem chống nắng" — trong khi cùng truy vấn đó mở
    // bằng Chrome thường ra ~7.500 kết quả và trang có gọi `/api/graphql` năm lần. Tức lỗi nằm ở
    // môi trường của tab này, và bốn số dưới đây tách được bốn nguyên nhân:
    //
    //   hooked=false   page-hook.js không chạy trên tab → xem `ensurePageHook` / bấm Reload
    //   gql=0          trang KHÔNG hề gọi /api/graphql → tab nền không paint nên React của FB
    //                  chưa bao giờ đi xin dữ liệu (đúng thứ đã xảy ra với Google Trends)
    //   gql>0, cap=0   có gọi mà hook không bắt được → FB đổi cách gọi, `NEEDLES` cần sửa
    //   bodyLen nhỏ    không phải trang Ad Library — chặn, đăng nhập, hoặc checkpoint
    let debug = null;
    if (!pages.length) {
      try {
        const out = await chrome.scripting.executeScript({
          target: { tabId: tab.id }, world: 'MAIN',
          func: () => ({
            hooked: !!window.__rsCapHooked,
            cap: (window.__rsCap || []).length,
            gql: performance.getEntriesByType('resource').filter((e) => e.name.indexOf('/api/graphql') !== -1).length,
            vis: document.visibilityState,
            title: document.title,
            bodyLen: document.body ? document.body.innerText.length : 0,
            url: location.href.slice(0, 160),
          }),
        });
        debug = (out && out[0] && out[0].result) || null;
      } catch (e) { debug = { error: String(e) }; }
    }
    return debug ? { pages, debug } : { pages };
  } finally {
    try { await chrome.tabs.remove(tab.id); } catch (e) {}
  }
}

/**
 * VIDEO QUA GOOGLE — `site:tiktok.com <cụm>` ở tab HÌNH ẢNH.
 *
 * VÌ SAO CÓ ĐƯỜNG NÀY, bên cạnh `searchTiktok` đã có: đường TikTok trực tiếp phải mở tab, gõ
 * chữ, cuộn, và nó cần phiên đăng nhập TikTok của máy-thợ — nên nó chậm (ngân sách 120 giây),
 * hay dính màn xác minh, và kết quả bị cá nhân hoá theo account/IP của chính máy-thợ. Google
 * thì chỉ là MỘT lần tải trang, không đăng nhập gì cả.
 *
 * Đo 2026-09-06, `site:tiktok.com tai nghe bluetooth pro 3` ở tab Hình ảnh: 62 link video khác
 * nhau ngay trang đầu, kèm caption đầy đủ trong `img[alt]` và ảnh bìa. Độ khớp 9/12 dòng đầu
 * đúng sản phẩm; 3 dòng lệch là "AirPods Pro 3" — cùng cụm "Pro 3", đúng loại nhầm lẫn mà
 * `relevance.py` sinh ra để xếp xuống chứ không xoá.
 *
 * PHẢI ĐI QUA ĐÂY, KHÔNG FETCH THẲNG TỪ SERVER ĐƯỢC. Đo cùng ngày từ VPS: mọi truy vấn đều trả
 * HTTP 200 kèm đúng ~93KB một trang chuyển hướng bằng JS, không có lấy một thẻ `<h3>` — Google
 * chỉ phục vụ kết quả cho trình duyệt chạy JS. Cùng họ với Trends và Lens.
 *
 * ĐỌC BẰNG DOM, không cần `page-hook.js`: kết quả nằm sẵn trong trang, khác Taobao/Temu/FB nơi
 * phải chộp response đã ký.
 */
const GOOGLE_VIDEO_SITES = {
  // Chuỗi này đi qua `new RegExp` trong trang, nên dấu gạch chéo phải nhân đôi ở đây.
  // Nhóm 1 = tác giả (Douyin không có trong link nên để nhóm rỗng), nhóm 2 = id video.
  tiktok: { host: 'tiktok.com', re: 'tiktok\\.com/@([\\w.\\-]+)/video/(\\d+)' },
  douyin: { host: 'douyin.com', re: 'douyin\\.com/(?:video|note)/()(\\d+)' },
};

function googleVideoUrl(site, keyword, hl, gl) {
  const p = new URLSearchParams({
    q: `site:${site} ${keyword || ''}`.trim(),
    udm: '2', // tab Hình ảnh — ảnh bìa video được lập chỉ mục ở đây, và mỗi ảnh trỏ về trang video
    hl: hl || 'vi',
    gl: gl || 'VN',
  });
  return 'https://www.google.com/search?' + p.toString();
}

async function searchGoogleVideos(payload) {
  const which = GOOGLE_VIDEO_SITES[String(payload.site || 'tiktok')];
  if (!which) return { items: [], blocked: false, error: `Google: không hỗ trợ site ${payload.site}` };
  const keyword = String(payload.keyword || '').trim();
  if (!keyword) return { items: [], blocked: false, error: 'Google: thiếu từ khoá.' };
  const target = Math.min(120, Math.max(12, Number(payload.count) || 40));

  const tab = await keptTab('googlevid');
  try {
    await chrome.tabs.update(tab.id, { url: googleVideoUrl(which.host, keyword, payload.hl, payload.gl) });
    await waitForComplete(tab.id, 25000);
    // `complete` của Chrome nói tài liệu đã tải xong, KHÔNG nói lưới ảnh đã dựng — Google dựng
    // nó bằng JS sau đó. Đọc ngay lúc ấy hay ra tay không, mà lượt đọc thứ hai thì phải chờ
    // thêm một vòng cuộn. Một nhịp ngắn ở đây rẻ hơn nhiều.
    await sleep(1500);

    // Hai lượt đọc, có cuộn ở giữa: lưới ảnh của Google tải thêm khi cuộn, và một lượt cuộn là
    // đủ để gấp đôi số dòng mà không kéo dài job.
    const items = {};
    let notice = '';
    for (let pass = 0; pass < 2; pass++) {
      if (pass) {
        try {
          await chrome.scripting.executeScript({
            target: { tabId: tab.id },
            func: () => window.scrollTo(0, document.body ? document.body.scrollHeight : 20000),
          });
        } catch (e) {}
        await sleep(1800);
      }
      let out = null;
      try {
        out = await chrome.scripting.executeScript({
          target: { tabId: tab.id },
          args: [which.re],
          func: (reSrc) => {
            const re = new RegExp(reSrc);
            const rows = [];
            document.querySelectorAll('a[href]').forEach((a) => {
              const m = a.href.match(re);
              if (!m) return;
              // Ảnh và caption nằm trong cùng ô kết quả với thẻ <a>; leo lên vài bậc là đủ,
              // không cần biết tên class của Google (chúng đổi liên tục).
              let box = a, img = null;
              for (let i = 0; i < 4 && box; i++) {
                img = box.querySelector && box.querySelector('img');
                if (img) break;
                box = box.parentElement;
              }
              rows.push({
                id: m[2],
                author: m[1] || '',
                videoUrl: a.href.split('?')[0],
                name: (img && img.alt) || (a.textContent || '').trim(),
                image: (img && img.src && img.src.indexOf('data:') !== 0) ? img.src : '',
              });
            });
            // Chỉ nhận đúng câu chặn của Google. "bất thường" trần trụi thì quá rộng — nó nằm
            // được trong chính caption của một video bất kỳ, và khi đó ta báo nhầm là bị chặn.
            const body = document.body ? document.body.innerText : '';
            return {
              rows,
              blocked: /unusual traffic|lưu lượng truy cập bất thường|recaptcha/i.test(body),
            };
          },
        });
      } catch (e) { /* trang chưa sẵn sàng — thử lại ở lượt sau */ }
      const res = (out && out[0] && out[0].result) || null;
      if (!res) continue;
      if (res.blocked) {
        // Google đòi xác minh: nói thẳng, và ĐƯA TAB RA TRƯỚC để người vận hành giải được.
        await focusTab(tab.id);
        notice = 'Google đòi xác minh (unusual traffic) — giải captcha trong tab rồi bấm lại.';
        break;
      }
      for (const r of res.rows) if (r.id && !items[r.id]) items[r.id] = r;
      if (Object.keys(items).length >= target) break;
    }

    const list = Object.values(items).slice(0, target);
    if (!list.length) {
      return {
        items: [],
        blocked: !!notice,
        error: notice || `Google không trả link ${which.host} nào cho “${keyword}”.`,
      };
    }
    return { items: list, blocked: false, error: notice || undefined };
  } catch (e) {
    return { items: [], blocked: false, error: String(e) };
  }
}

// GOOGLE TRENDS qua máy-thợ. Cùng một nguyên nhân với Ad Library, nhưng triệu chứng tinh vi hơn
// nên khó thấy hơn nhiều: Chromium do Playwright dựng KHÔNG bị chặn — nó vẫn trả HTTP 200 kèm dữ
// liệu thật — mà bị phục vụ một bản NGHÈO HƠN. Đo 2026-09-05 trên "sạc điện thoại", cùng máy cùng
// tài khoản: playwright ra 23 dòng, không có bảng "đang tăng", và trong JSON KHÔNG có trường phần
// trăm thay đổi; Chrome thật của máy-thợ ra 50 dòng kèm đủ cột "Thay đổi".
//
// Đây là kiểu hỏng tệ nhất trong họ soft-block: không có lỗi nào để bắt, bảng vẫn hiện ra, số vẫn
// đúng — chỉ thiếu hơn nửa dữ liệu. Ba lượt fetch liên tiếp còn trả ba danh sách khác nhau.
//
// KÝ SINH y như FB: điều hướng tab tới /trends/explore của từ khoá, để CHÍNH TRANG xin widget bằng
// token của nó, page-hook chộp response, trả text thô về backend parse.
const TRENDS_WIDGET = '/trends/api/widgetdata/relatedsearches';
const TRENDS_FRAMES = '/TrendsUi/data/batchexecute';

/**
 * Gom những gì page-hook chộp được trong MỘT tab, cho tới khi có hàng hoặc hết ngân sách.
 *
 * `needle` chọn loại response; `extra` là phép lọc thêm (trang cũ phải loại widget "Chủ đề liên
 * quan", trang mới thì không cần). Trả về mảng text thô — backend là nơi hiểu chúng, còn ở đây
 * cố ý KHÔNG parse: mọi hiểu biết về hình dạng payload nằm đúng một chỗ.
 */
async function trendsCollect(tabId, needle, extra, budgetMs, stopOnFirst) {
  const out = [];
  const seen = new Set();
  const deadline = Date.now() + budgetMs;
  while (Date.now() < deadline) {
    await sleep(1200);
    let cap = [];
    try {
      const res = await chrome.scripting.executeScript({
        target: { tabId }, world: 'MAIN',
        func: (n, want) => (window.__rsCap || [])
          .filter((c) => c.url.indexOf(n) !== -1 && (!want || decodeURIComponent(c.url).indexOf(want) !== -1))
          .map((c) => ({ ts: c.ts, text: c.text })),
        args: [needle, extra || ''],
      });
      cap = (res && res[0] && res[0].result) || [];
    } catch (e) { /* trang chưa sẵn sàng */ }
    for (const c of cap) {
      const key = c.ts + ':' + (c.text ? c.text.length : 0);
      if (seen.has(key)) continue;
      seen.add(key);
      out.push(c.text);
    }
    // DỪNG SỚM CHỈ KHI needle đã chỉ đúng một response.
    //
    // Trang cũ: needle là `relatedsearches`, bắt được cái nào là đúng cái đó ⇒ dừng luôn.
    // Trang MỚI: mọi RPC đều đi qua cùng một endpoint `batchexecute`, nên response ĐẦU TIÊN là
    // `DqDTgb` — RPC khởi tạo trang, bắn ngay lúc tải, không chứa bảng nào. Đo 2026-09-05: dừng
    // sớm ở đây cho ra đúng một frame 162 KB không hề có chuỗi từ gốc trong đó, và cả đường đi
    // trông như "Google không trả bảng" trong khi thật ra ta bỏ đi trước khi nó kịp trả.
    // Nên trang mới phải gom HẾT ngân sách rồi để backend chọn.
    if (stopOnFirst && out.length) break;
    // Cả hai bảng nằm CUỐI trang và chỉ được xin khi cuộn tới.
    //
    // `window.scrollTo` MỘT MÌNH LÀ KHÔNG ĐỦ, và đây là chỗ đã trượt một lượt. Đo 2026-09-05 sau
    // khi đã mở cửa sổ được vẽ: trang bắn `g4kJzf` (biểu đồ, cũng lazy) hai lần — tức cơ chế
    // "hiện ra thì mới xin" đã chạy — nhưng bảng thì không bao giờ tới. Trang mới cuộn trong một
    // KHUNG CON, nên cuộn cửa sổ không nhúc nhích được gì. Lúc dò bằng Playwright không lộ ra
    // khác biệt này vì `mouse.wheel` cuộn đúng thứ nằm dưới con trỏ, bất kể nó là khung nào.
    //
    // Nên đánh cả ba đường một lượt: cuộn cửa sổ, cuộn MỌI phần tử cuộn được, và bắn một sự kiện
    // wheel thật vào giữa màn hình. Rẻ, và không phải đoán trúng khung nào là khung đúng.
    //
    // Cuộn TỪNG NẤC rồi mới xuống đáy: trang dựng thẻ theo kiểu cuộn tới đâu xin tới đó, nên nhảy
    // thẳng xuống đáy có thể bỏ qua đúng thẻ nằm giữa.
    try {
      await chrome.scripting.executeScript({
        target: { tabId }, world: 'MAIN',
        func: (step) => {
          const frac = (step % 6) / 5;
          try {
            const h = document.body ? document.body.scrollHeight : 20000;
            window.scrollTo(0, Math.round(h * frac));
          } catch (e) {}
          // Khung cuộn bên trong — TỐI ĐA BA CÁI, và đây là giới hạn phải có chứ không phải cho
          // gọn. Bản trước quét `querySelectorAll('*')` rồi gán `scrollTop` cho MỌI phần tử cao
          // hơn phần nhìn thấy. Trên trang Trends, số đó lên tới hàng trăm, mỗi lần gán lại bắn
          // một sự kiện scroll và trang chạy xử lý cho từng cái — đủ để khoá luôn renderer.
          //
          // Hậu quả đo được ngày 2026-09-05: `chrome.scripting.executeScript` KHÔNG BAO GIỜ trả
          // về, nên handler treo và máy-thợ im lặng suốt hai lượt — log backend không có lấy một
          // `POST /api/relay/result` nào. Bản trước đó, không có đoạn quét này, POST bình thường.
          //
          // Ba khung là đủ: trang chỉ có một khung cuộn thật, hai cái còn lại là dự phòng.
          try {
            const nodes = document.querySelectorAll('div,main,section');
            let found = 0;
            for (let i = 0; i < nodes.length && found < 3; i++) {
              const el = nodes[i];
              if (el.scrollHeight > el.clientHeight + 400) {
                el.scrollTop = Math.round((el.scrollHeight - el.clientHeight) * frac);
                found++;
              }
            }
          } catch (e) {}
        },
        args: [Math.round((Date.now() - (deadline - budgetMs)) / 1200)],
      });
    } catch (e) {}
  }
  return out;
}

/**
 * Frame này có vẻ chở bảng truy vấn liên quan không?
 *
 * Phép thử nằm ở ĐÂY chứ không để backend quyết, vì nó quyết định một việc chỉ extension làm được:
 * có cần quay về trang cũ ngay trong cùng job hay không. Backend chỉ nhận được kết quả sau khi mọi
 * cánh cửa đã đóng.
 *
 * HAI điều kiện, thiếu cái nào cũng nhận nhầm. Đo 2026-09-05 trên "jeans": trang mới bắn `qrLOJd`
 * 1,7 KB CÓ chứa từ gốc — đó là RPC phân giải truy vấn, không phải bảng. Còn `DqDTgb` thì 162 KB
 * nhưng KHÔNG hề nhắc từ gốc — RPC khởi tạo trang. Nên vừa phải nhắc từ gốc, vừa phải đủ lớn.
 *
 * Dò ở BA dạng chuỗi: payload nằm trong chuỗi JSON lồng trong phong bì JSON, nên tiếng Việt bị
 * escape rồi escape thêm lần nữa. Tìm thẳng "điện thoại" trong text thô sẽ luôn trượt.
 */
function trendsLooksLikeTable(text, seed) {
  if (!text || text.length < 5000) return false;
  const raw = String(seed || '');
  if (!raw) return text.length > 20000;
  const esc = raw.replace(/[^\x00-\x7F]/g, (c) => '\\u' + c.charCodeAt(0).toString(16).padStart(4, '0'));
  return [raw, esc, esc.split('\\').join('\\\\')].some((form) => text.indexOf(form) !== -1);
}

/**
 * Bọc `trendsRelated` bằng một hạn cứng, và trả về NHỮNG GÌ ĐÃ GOM ĐƯỢC khi hết hạn.
 *
 * VÌ SAO CẦN: đo 2026-09-05, log backend cho thấy máy-thợ hỏi job đều đặn nhưng KHÔNG hề có một
 * `POST /api/relay/result` nào trong suốt 120 giây — tức handler im lặng luôn, không phải chạy
 * chậm. Một handler im lặng là kiểu hỏng đắt nhất ở đây: backend chỉ biết "hết giờ", còn nguyên
 * nhân thật thì không để lại dấu vết nào.
 *
 * Nên hạn này KHÔNG phải để tối ưu tốc độ; nó để bảo đảm LUÔN có câu trả lời kèm mẫu vật. Đặt
 * dưới hạn của trang máy-thợ (110s) để bên bỏ cuộc trước vẫn là bên biết vì sao mình bỏ cuộc.
 */
function trendsRelatedGuarded(payload) {
  const partial = { responses: [], frames: [] };
  // Nhịp giữ service worker sống nằm ở `withHeartbeat` — cùng một helper với TikTok/Douyin/FB,
  // vì cả bốn job đều dài và đều có quãng ngồi chờ trang tải mà MV3 tính là "rảnh".
  const guard = new Promise((resolve) =>
    setTimeout(() => resolve({ ...partial, error: 'hết ngân sách trong extension' }), 95000)
  );
  return withHeartbeat(Promise.race([
    trendsRelated(payload, partial).catch((e) => ({ ...partial, error: String(e) })),
    guard,
  ]));
}

async function trendsRelated(payload, partial) {
  const bag = partial || { responses: [], frames: [] };
  await ensurePageHook();
  const url = String(payload.url || '');
  const legacyUrl = String(payload.legacyUrl || '');
  if (!url.startsWith('https://trends.google.')) {
    return { responses: [], frames: [], error: 'url không phải Google Trends' };
  }

  // CỬA SỔ RIÊNG, KHÔNG PHẢI TAB NỀN — và đây là khác biệt quyết định, không phải chuyện gọn gàng.
  //
  // Đo 2026-09-05 bằng tab nền: trang mới chỉ bắn `DqDTgb`, `Tnt4U`, `qrLOJd` — toàn RPC khởi tạo,
  // không có cái nào chở bảng, dù đã cuộn suốt 28 giây. Chrome KHÔNG vẽ tab nền, mà giao diện mới
  // dựng thẻ theo tầm nhìn: không vẽ thì không thẻ nào lọt vào tầm nhìn, nên trang chẳng có lý do
  // gì để đi xin bảng. Cuộn một trang cao 0 pixel là cuộn vào hư không.
  //
  // `focused: false` nên nó KHÔNG cướp chuột và bàn phím của người đang dùng máy — cửa sổ vẫn hiện
  // và vẫn được vẽ, chỉ là không nổi lên trên. Đủ để trang chịu dựng thẻ, và không làm phiền.
  //
  // Ad Library dùng tab nền được vì FB trả dữ liệu ngay từ request đầu, không đợi cuộn.
  const win = await chrome.windows.create({ url, focused: false, width: 1280, height: 900 });
  const tab = win.tabs && win.tabs[0];
  if (!tab) return { responses: [], frames: [], error: 'không mở được cửa sổ' };
  try {
    // TRANG MỚI trước. Nó là trang DUY NHẤT có cột "Thay đổi" — nhưng chỉ hiện với một số tài
    // khoản, nên không được coi việc nó im lặng là hỏng.
    await waitForComplete(tab.id, 20000);
    const frames = await trendsCollect(tab.id, TRENDS_FRAMES, '', 30000, false);
    bag.frames = frames;
    if (frames.some((t) => trendsLooksLikeTable(t, payload.seed))) return { responses: [], frames };

    // Không có gì ⇒ tài khoản này chưa được phục vụ bảng ở trang mới. Về TRANG CŨ, vẫn trong
    // cùng một job và vẫn bằng Chrome thật: 25 dòng không kèm cột Thay đổi vẫn hơn hẳn việc
    // rơi về Playwright, vốn còn ít dòng hơn nữa.
    if (!legacyUrl) return { responses: [], frames };
    await chrome.tabs.update(tab.id, { url: legacyUrl });
    await waitForComplete(tab.id, 20000);
    const responses = await trendsCollect(tab.id, TRENDS_WIDGET, '"keywordType":"QUERY"', 20000, true);
    bag.responses = responses;
    // Trả kèm cả frame của trang mới: chúng vô dụng để dựng bảng, nhưng là mẫu vật chẩn đoán —
    // backend cất lại khi không đọc được gì, và đó là thứ nói cho ta biết trang mới đã bắn gì.
    return { responses, frames };
  } finally {
    try { await chrome.windows.remove(win.id); } catch (e) {}
  }
}

function waitForComplete(tabId, timeoutMs = 12000) {
  return new Promise((resolve) => {
    const timer = setTimeout(() => {
      chrome.tabs.onUpdated.removeListener(listener);
      resolve();
    }, timeoutMs);
    function listener(id, info) {
      if (id === tabId && info.status === 'complete') {
        clearTimeout(timer);
        chrome.tabs.onUpdated.removeListener(listener);
        resolve();
      }
    }
    chrome.tabs.onUpdated.addListener(listener);
  });
}

// ============================================================================
// KHO TAB DÙNG CHUNG — giữ tab, nhưng KHÔNG giữ trang
// ============================================================================
//
// Mỗi sàn cần MỘT tab sống lâu: mở tab mất vài giây, và tab nền thừa hưởng cookie đăng nhập
// của hồ sơ nên không phải đăng nhập lại. Nhưng "giữ tab" từng bị hiểu thành "giữ luôn trang
// cuối cùng": đo trên máy thợ ngày 2026-09-03, Chrome chạy liền 6 ngày ngốn 1.66 GB, trong đó
// hai renderer nặng nhất là 301 MB và 282 MB — chính là trang kết quả Amazon và Douyin của lần
// chạy từ mấy hôm trước, vẫn còn nguyên DOM, ảnh và timer JS.
//
// Nên tách làm hai việc:
//   `coolTab`  — xong job thì đưa tab về trang trống. Renderer được giải phóng NGAY, tab vẫn
//                còn, và phiên đăng nhập KHÔNG mất: cookie nằm ở hồ sơ Chrome chứ không nằm ở
//                tab. Không tốn thêm lần tải nào, vì mọi job đều điều hướng lại từ đầu.
//   `reapTabs` — tab rảnh quá lâu thì đóng hẳn. Các hàm dưới tự mở lại khi cần.
//
// VÌ SAO GHI RA `storage.session` CHỨ KHÔNG ĐỂ BIẾN MODULE: service worker của MV3 bị treo sau
// khoảng 30 giây rảnh, biến module mất theo — nhưng tab thì không. Bản trước giữ tab id trong
// biến, nên mỗi lần service worker sống lại nó mở tab MỚI và bỏ rơi tab cũ. `storage.session`
// sống theo phiên trình duyệt nên qua được đúng khe đó.
const TAB_STORE = 'rs-kept-tabs';        // slot -> { id, usedAt }
const TAB_IDLE_MS = 10 * 60_000;         // rảnh quá lâu → đóng hẳn
const TAB_REAP_ALARM = 'rs-reap-tabs';

async function storeRead() {
  try { const o = await chrome.storage.session.get(TAB_STORE); return o[TAB_STORE] || {}; }
  catch (e) { return {}; }
}
async function storeWrite(store) {
  try { await chrome.storage.session.set({ [TAB_STORE]: store }); } catch (e) {}
}

/** Tab đang giữ ở slot này, hoặc null nếu chưa có / đã bị đóng. Có chạm `usedAt`. */
async function slotTab(slot) {
  const store = await storeRead();
  const rec = store[slot];
  if (!rec || rec.id == null) return null;
  let tab = null;
  try { tab = await chrome.tabs.get(rec.id); } catch (e) { tab = null; }
  if (!tab) { delete store[slot]; await storeWrite(store); return null; }
  store[slot] = { id: rec.id, usedAt: Date.now() };
  await storeWrite(store);
  return tab;
}

async function slotSet(slot, tabId) {
  const store = await storeRead();
  store[slot] = { id: tabId, usedAt: Date.now() };
  await storeWrite(store);
}

/**
 * Tab nền thường trú của một sàn. Mở ở `about:blank` — nơi gọi tự điều hướng tới URL của mình.
 *
 * Thay cho tám hàm `amazonTab/ali1688Tab/...` gần như giống hệt nhau trước đây; khác biệt duy
 * nhất giữa chúng là cái biến giữ id, mà đó chính là thứ nay đã nằm trong kho chung.
 */
async function keptTab(slot) {
  const existing = await slotTab(slot);
  if (existing) return existing;
  const tab = await chrome.tabs.create({ url: 'about:blank', active: false });
  await slotSet(slot, tab.id);
  return tab;
}

/**
 * Hạ nhiệt: đưa tab về `url` (mặc định trang trống) sau khi đã lấy xong kết quả.
 *
 * Gọi ở nơi điều phối chứ không nằm trong từng hàm tìm kiếm, để job lỗi hay job bị ném ngoại
 * lệ cũng được dọn — đó mới là những lần hay để lại trang nặng nhất.
 *
 * Nuốt lỗi có chủ đích: hạ nhiệt hụt không phải lý do làm hỏng một kết quả đã lấy được.
 */
async function coolTab(slot, url = 'about:blank') {
  try {
    const store = await storeRead();
    const rec = store[slot];
    if (!rec || rec.id == null) return;
    const tab = await chrome.tabs.get(rec.id);
    if (!tab) return;
    if ((tab.url || '') !== url) await chrome.tabs.update(rec.id, { url });
  } catch (e) {}
}

/**
 * Bọc một lượt chạy: giữ tab khỏi bị dọn khi đang dùng, rồi hạ nhiệt lúc xong.
 *
 * Cờ bận là bắt buộc chứ không phải cho chắc: `reapTabs` chạy mỗi phút, mà một lượt Douyin
 * hay TikTok nhiều cụm từ hoàn toàn có thể lâu hơn `TAB_IDLE_MS`. Thiếu cờ này thì người dọn
 * sẽ đóng đúng cái tab job đang dùng dở, và job chết oan — một lỗi chỉ hiện ra ở những lượt
 * tìm dài, tức là đúng những lượt đắt nhất.
 *
 * GIỮ TRONG BỘ NHỚ chứ không ghi ra `storage.session`, khác với phần còn lại của kho: cổng
 * `sendResponse` đang mở giữ cho service worker sống suốt lượt chạy, nên `Set` này chắc chắn
 * còn. Mà nếu service worker có chết thật thì job cũng chết theo — lúc ấy cờ bay đi cùng là
 * đúng, tab bỏ hoang phải được dọn chứ không phải được tha.
 */
const busySlots = new Set();
function withCooldown(slot, running, coolUrl) {
  busySlots.add(slot);
  return running.finally(() => {
    busySlots.delete(slot);
    return coolTab(slot, coolUrl);
  });
}

/**
 * Đóng hẳn những tab đã rảnh quá `TAB_IDLE_MS`.
 *
 * BỎ QUA TAB ĐANG HIỆN TRƯỚC: `navAndCapture` cố ý đưa tab ra trước khi vướng slider, và tab
 * xác minh mở ra chính là để người vận hành ngồi giải. Đóng mất tab người ta đang nhìn là cách
 * chắc chắn nhất để việc dọn dẹp bị tắt đi. Mỗi cửa sổ chỉ có một tab hiện trước nên ngoại lệ
 * này không đáng kể.
 */
async function reapTabs() {
  const store = await storeRead();
  const now = Date.now();
  let changed = false;
  for (const slot of Object.keys(store)) {
    const rec = store[slot];
    if (!rec || rec.id == null) { delete store[slot]; changed = true; continue; }
    if (busySlots.has(slot)) continue;
    if (now - (rec.usedAt || 0) < TAB_IDLE_MS) continue;
    let tab = null;
    try { tab = await chrome.tabs.get(rec.id); } catch (e) { tab = null; }
    if (tab && tab.active) continue;
    if (tab) { try { await chrome.tabs.remove(rec.id); } catch (e) {} }
    delete store[slot];
    changed = true;
  }
  if (changed) await storeWrite(store);
}

// `setInterval` không dùng được: service worker MV3 bị treo giữa chừng và hẹn giờ chết theo.
// `alarms` là đồng hồ duy nhất đánh thức được service worker đã ngủ.
// Tạo CÓ ĐIỀU KIỆN: mã ở tầng ngoài này chạy lại mỗi lần service worker thức dậy, mà
// `alarms.create` trùng tên thì đặt lại lịch từ đầu. Cứ tạo vô điều kiện thì một máy bận
// (thức dậy liên tục dưới một phút) sẽ đẩy lùi báo thức mãi và không bao giờ dọn.
chrome.alarms.get(TAB_REAP_ALARM).then((a) => {
  if (!a) chrome.alarms.create(TAB_REAP_ALARM, { periodInMinutes: 1 });
});
chrome.alarms.onAlarm.addListener((a) => { if (a.name === TAB_REAP_ALARM) reapTabs(); });

// Người vận hành tự tay đóng tab thì quên nó đi ngay, đừng đợi `chrome.tabs.get` ném lỗi.
chrome.tabs.onRemoved.addListener(async (tabId) => {
  const store = await storeRead();
  let changed = false;
  for (const slot of Object.keys(store)) {
    if (store[slot] && store[slot].id === tabId) { delete store[slot]; changed = true; }
  }
  if (changed) await storeWrite(store);
});

/**
 * MỘT tab xác minh cho mỗi sàn, dùng lại thay vì mở thêm.
 *
 * Bản trước gọi thẳng `tabs.create({active:true})` mỗi lần sàn bắt kéo slider. Trên máy một
 * người thì không sao; trên worker dùng chung, mười lượt tìm bị chặn sẽ tạo mười cửa sổ không
 * tự đóng. Chỉ cần xác minh một lần vì cookie được lưu theo hồ sơ trình duyệt.
 *
 * Vẫn `active: true` có chủ đích: mở lén ở tab nền thì không ai biết mà giải.
 */
async function openVerifyTab(slot, url) {
  const existing = await slotTab(slot);
  if (existing) {
    try { await chrome.tabs.update(existing.id, { url, active: true }); return; } catch (e) {}
  }
  try {
    const tab = await chrome.tabs.create({ url, active: true });
    await slotSet(slot, tab.id);
  } catch (e) {}
}

/**
 * Tab đang ở đúng origin của `host`, để `fetchInTab` gọi được same-origin.
 *
 * Ba nguồn, theo thứ tự: tab của chính ta (kể cả khi đang nằm ở trang trống sau khi hạ nhiệt —
 * phải đưa về đúng origin trước, nếu không fetch thành cross-origin và sàn trả 403), rồi tab
 * của sàn mà người dùng đang tự mở, cuối cùng mới mở tab mới.
 *
 * Tab mượn của người dùng KHÔNG được ghi vào kho: nó không phải của ta nên không được hạ nhiệt
 * hay đóng.
 */
async function ensureTab(host) {
  const slot = `site:${host}`;
  const kept = await slotTab(slot);
  if (kept) {
    if (hostOf(kept.url || '') !== host) {
      await chrome.tabs.update(kept.id, { url: `https://${host}/`, active: false });
      await waitForComplete(kept.id);
    }
    return kept;
  }
  const existing = await findTab(host);
  if (existing) return existing;
  const tab = await chrome.tabs.create({ url: `https://${host}/`, active: false });
  await slotSet(slot, tab.id);
  await waitForComplete(tab.id);
  return tab;
}

// Chạy trong context TRANG (MAIN world) — đây là chỗ fetch trở thành same-origin.
async function fetchInTab(tabId, requests) {
  const injected = await chrome.scripting.executeScript({
    target: { tabId },
    world: 'MAIN',
    args: [requests],
    func: async (reqs) => {
      const out = [];
      for (let i = 0; i < reqs.length; i++) {
        const r = reqs[i];
        if (i > 0) await new Promise((res) => setTimeout(res, 400 + Math.floor(Math.random() * 500)));
        try {
          const resp = await fetch(r.url, {
            method: r.method || 'GET',
            headers: r.headers || {},
            body: r.body || undefined,
            credentials: 'include',
          });
          out.push({ tag: r.tag ?? null, status: resp.status, text: await resp.text() });
        } catch (e) {
          out.push({ tag: r.tag ?? null, status: 0, text: String(e) });
        }
      }
      return out;
    },
  });
  return (injected && injected[0] && injected[0].result) || [];
}

async function handleFetch(requests) {
  // Nhóm theo host để chạy trong đúng tab của từng sàn.
  const byHost = new Map();
  for (const r of requests || []) {
    const host = hostOf(r.url);
    if (!host) continue;
    if (!byHost.has(host)) byHost.set(host, []);
    byHost.get(host).push(r);
  }

  const all = [];
  for (const [host, reqs] of byHost) {
    let tab;
    try {
      tab = await ensureTab(host);
    } catch (e) {
      for (const r of reqs) all.push({ tag: r.tag ?? null, status: 0, text: `NO_TAB:${host}` });
      continue;
    }
    if (!tab || tab.id == null) {
      for (const r of reqs) all.push({ tag: r.tag ?? null, status: 0, text: `NO_TAB:${host}` });
      continue;
    }
    try {
      all.push(...(await fetchInTab(tab.id, reqs)));
    } catch (e) {
      for (const r of reqs) all.push({ tag: r.tag ?? null, status: 0, text: `INJECT_FAIL:${String(e)}` });
    }
  }
  return all;
}

// NHANH: mở MỘT tab find_similar (seed) để nạp bộ ký của Shopee, rồi từ chính tab đó gọi
// recommend_post cho NHIỀU sản phẩm. Nếu trang tự ký fetch → lấy giá vốn cả loạt trong 1 tab.
// Trả map itemid -> {status, text}.
async function costBatch(seedUrl, products) {
  await ensureHook();
  const tab = await chrome.tabs.create({ url: seedUrl, active: false });
  try {
    await waitForComplete(tab.id, 12000);
    // Chờ trang gọi xong recommend_post đầu tiên (bằng chứng bộ ký đã sẵn), tối đa ~10s.
    const deadline = Date.now() + 10000;
    while (Date.now() < deadline) {
      await sleep(700);
      try {
        const out = await chrome.scripting.executeScript({ target: { tabId: tab.id }, world: 'MAIN', func: () => !!window.__rsCaptured });
        if (out && out[0] && out[0].result) break;
      } catch (e) {}
    }
    // Bắn recommend_post cho tất cả sản phẩm từ ngay trong tab (dùng fetch của trang → được ký).
    const out = await chrome.scripting.executeScript({
      target: { tabId: tab.id }, world: 'MAIN', args: [products],
      func: async (items) => {
        const map = {};
        for (const p of items) {
          try {
            const body = JSON.stringify({
              offset: 0, limit: 30, section: 'find_similar_product_pd_sec', bundle: 'find_similar_product_pd',
              itemid: Number(p.itemid), shopid: Number(p.shopid), catid: Number(p.catid), item_card: 2,
            });
            const r = await fetch('/api/v4/recommend/recommend_post', {
              method: 'POST', headers: { 'content-type': 'application/json' }, body, credentials: 'include',
            });
            map[p.itemid] = { status: r.status, text: r.status === 200 ? await r.text() : '' };
          } catch (e) { map[p.itemid] = { status: 0, text: String(e) }; }
          await new Promise((z) => setTimeout(z, 200));
        }
        return map;
      },
    });
    return (out && out[0] && out[0].result) || {};
  } finally {
    try { await chrome.tabs.remove(tab.id); } catch (e) {}
  }
}

// Amazon: SW fetch trần bị captcha. Cách chắc: điều hướng MỘT tab nền riêng tới trang search
// (Amazon render SSR → tab load như user thật), rồi đọc sản phẩm từ DOM.
const amazonTab = () => keptTab('amazon');

/*
 * ĐẶT TIỀN TỆ TỪ NGUỒN, thay vì đoán ở đầu bên kia.
 *
 * Amazon đổi tiền theo địa chỉ giao hàng nó ĐOÁN TỪ IP, không theo tên miền. Máy-thợ ngồi ở
 * Việt Nam nên amazon.com trả "VND 693,173" chứ không phải "$26.65" — và bảng thì gắn nhãn
 * USD cứng theo tên miền, tức mọi giá lệch hai vạn sáu nghìn lần mà không có dấu hiệu nào
 * trên màn hình.
 *
 * Amazon nhớ lựa chọn ấy ở cookie `i18n-prefs`. Đo 2026-09-08, cùng truy vấn `razer blackshark
 * v2 x` từ IP Việt Nam:
 *
 *     không cookie          giá VND, 15/21 thẻ có giá
 *     i18n-prefs=USD        giá USD ($39.99, $71.99…), 15/16 thẻ có giá
 *
 * Hỏi đúng thứ mình cần rẻ hơn nhiều so với đoán xem mình vừa nhận được thứ gì.
 */
const AMZ_CUR_COOKIE = {
  'amazon.com': 'USD', 'amazon.co.uk': 'GBP', 'amazon.de': 'EUR', 'amazon.fr': 'EUR',
  'amazon.it': 'EUR', 'amazon.es': 'EUR', 'amazon.co.jp': 'JPY', 'amazon.ca': 'CAD',
};
async function amazonDatTienTe(domain) {
  const cur = AMZ_CUR_COOKIE[domain];
  if (!cur) return;
  try {
    await chrome.cookies.set({
      url: `https://www.${domain}/`, domain: `.${domain}`, path: '/',
      name: 'i18n-prefs', value: cur,
      expirationDate: Math.floor(Date.now() / 1000) + 31536000,
    });
  } catch (e) { /* thiếu quyền hoặc Amazon từ chối — `curTuChu` bên research.js vẫn đỡ được */ }
}

async function amazonSearch(domain, url) {
  try {
    await amazonDatTienTe(domain);
    const tab = await amazonTab();
    await chrome.tabs.update(tab.id, { url });
    await waitForComplete(tab.id, 15000);
    await sleep(1000); // để kết quả render
    const out = await chrome.scripting.executeScript({
      target: { tabId: tab.id },
      func: () => {
        const body = document.body ? document.body.textContent.slice(0, 4000) : '';
        const captcha = /Enter the characters|not a robot|Type the characters|Sorry, we just need/i.test(body);
        const items = [];
        const seen = new Set();
        // Đọc số tiền theo mọi locale: "$1,234.56" · "1.299,00 €" · "￥1,299". Xác định dấu thập
        // phân là dấu (. hoặc ,) đứng trước 1–2 chữ số cuối; phần còn lại là dấu phân cách nghìn.
        const money = (s) => {
          const m = s && s.match(/[\d.,]+/);
          if (!m) return null;
          let t = m[0];
          const dec = t.match(/[.,](\d{1,2})$/);
          t = dec ? t.slice(0, -dec[0].length).replace(/[.,]/g, '') + '.' + dec[1] : t.replace(/[.,]/g, '');
          const n = parseFloat(t);
          return isFinite(n) && n > 0 ? n : null;
        };
        // Giá hiện tại: ưu tiên .a-offscreen (đủ định dạng), fallback .a-price-whole+fraction, rồi
        // bất kỳ .a-offscreen nào có số — để dòng không buy-box vẫn ra giá thay vì "—".
        // Giá kèm NGUYÊN VĂN chuỗi, vì loại tiền phải đọc từ chính chuỗi đó (Amazon đổi tiền
        // theo IP, không theo tên miền — xem `curTuChu` bên research.js). Trả `{n, text}`.
        const priceInfo = (el) => {
          const off = el.querySelector('.a-price:not(.a-text-price) .a-offscreen') || el.querySelector('.a-price .a-offscreen');
          let n = off && money(off.textContent);
          if (n) return { n: n, text: off.textContent.trim() };
          const whole = el.querySelector('.a-price-whole');
          if (whole) {
            const frac = el.querySelector('.a-price-fraction');
            const t = whole.textContent + (frac ? '.' + frac.textContent : '');
            n = money(t);
            if (n) return { n: n, text: t };
          }
          // BỐ CỤC THẺ KHÔNG DÙNG COMPONENT `.a-price` — có thật, không phải thẻ hết hàng.
          //
          // Đo 2026-09-08 trên `amazon.com/s?k=razer blackshark v2 x`: 6/21 thẻ không bóc được
          // giá. Soi ra là HAI loại khác hẳn nhau, và gộp chúng làm một là lý do trước giờ
          // không ai sửa:
          //
          //   3 thẻ  giá HIỆN RÕ trên màn hình ("VND 2,712,585") nhưng nằm trong một <span>
          //          `a-color-base` trần — `.a-price` và `.a-offscreen` đều bằng 0. Đây là lỗi
          //          của ta, và nhánh dưới đây vớt lại.
          //   3 thẻ  thật sự không có giá nào trên thẻ (hàng "See options" / hết hàng). `—` là
          //          câu trả lời ĐÚNG, không được bịa số.
          //
          // Chỉ nhận node mà TOÀN BỘ chữ của nó là một con số có ký hiệu tiền — như vậy không
          // vớt nhầm "50mm", "7.1 Surround", "70 Hr". Bỏ qua node nằm trong `.a-text-price`
          // (giá gạch) để không lấy giá niêm yết thay cho giá bán.
          const CUR = /^(?:VND|USD|EUR|GBP|JPY|CAD|AUD|SGD|THB|PHP|IDR|MYR|TWD|BRL|MXN|US\$|C\$|A\$|S\$|NT\$|R\$|RM|Rp|[$£€¥₫])\s?[\d.,]+$/;
          for (const node of el.querySelectorAll('span, div')) {
            const t = (node.textContent || '').trim();
            if (!CUR.test(t) || node.closest('.a-text-price')) continue;
            n = money(t);
            if (n) return { n: n, text: t };
          }
          for (const o of el.querySelectorAll('.a-offscreen')) {
            n = money(o.textContent);
            if (n) return { n: n, text: o.textContent.trim() };
          }
          return { n: null, text: '' };
        };
        const els = document.querySelectorAll('div[data-asin][data-component-type="s-search-result"], div.s-result-item[data-asin]');
        for (const el of els) {
          const asin = el.getAttribute('data-asin');
          if (!asin || seen.has(asin)) continue;
          const t = el.querySelector('h2 span') || el.querySelector('h2 a') || el.querySelector('h2');
          const name = t ? t.textContent.trim() : '';
          if (!name) continue;
          seen.add(asin);
          const gia = priceInfo(el);
          const price = gia.n;
          const se = el.querySelector('.a-price.a-text-price .a-offscreen');
          const strike = se ? money(se.textContent) : null;
          const im = el.querySelector('img.s-image');
          const image = im ? im.getAttribute('src') : '';
          const re = el.querySelector('.a-icon-alt');
          const rating = re ? (parseFloat((re.textContent.match(/([\d.]+)/) || [])[1]) || null) : null;
          // Số review ĐẦY ĐỦ nằm ở container ratings-count → aria-label của <a> (vd "44,268 ratings").
          // Strip mọi ký tự không phải số → chạy cho mọi region (US "44,268", IT "1.257 recensioni"…).
          let ratingCount = null;
          const rcComp = el.querySelector('[data-csa-c-content-id="alf-customer-ratings-count-component"]');
          if (rcComp) {
            const a = rcComp.querySelector('a[aria-label]');
            let n = parseInt(((a && a.getAttribute('aria-label')) || '').replace(/[^0-9]/g, ''));
            if (!n) n = parseInt((rcComp.textContent || '').replace(/[^0-9]/g, ''));
            if (n) ratingCount = n;
          }
          if (ratingCount == null) {
            const a2 = el.querySelector('a.s-underline-text[aria-label]');
            if (a2) { const n = parseInt((a2.getAttribute('aria-label') || '').replace(/[^0-9]/g, '')); if (n) ratingCount = n; }
          }
          if (ratingCount == null) {
            const und = el.querySelector('a.s-underline-text, .s-underline-text');
            if (und) { const n = parseInt((und.textContent || '').replace(/[^0-9]/g, '')); if (n) ratingCount = n; }
          }
          // Cầu thật của Amazon: "X+ bought in past month" (1K+ → 1000).
          let monthly = null;
          const bm = (el.textContent || '').match(/([\d.,]+)\s*([KkMm])?\+?\s*bought in past month/i);
          if (bm) { let n = parseFloat(bm[1].replace(/,/g, '')); const u = (bm[2] || '').toLowerCase(); if (u === 'k') n *= 1000; else if (u === 'm') n *= 1e6; monthly = Math.round(n) || null; }
          const isAd = el.getAttribute('data-component-type') === 'sp-sponsored-result' || !!el.querySelector('.puis-sponsored-label-text');
          // TIỀN TỆ ĐỌC TỪ CHÍNH THẺ, không suy từ tên miền.
          //
          // Đo 2026-09-08 trên `amazon.com/s?k=men t shirt` từ IP Việt Nam: thẻ ghi
          // "VND 693,173", KHÔNG phải "$26.65". Amazon đổi tiền theo địa chỉ giao hàng đoán từ
          // IP, mà `research.js` thì gán cứng amazon.com = USD — nên mọi giá bị dán nhãn sai,
          // lệch tới hai vạn sáu nghìn lần. Không có gì trên màn hình cho thấy sai: cột giá vẫn
          // là một con số, chỉ là con số của một loại tiền khác.
          const priceText = gia.text;
          // Thẻ có KHOẢNG giá ("12,99 - 19,99"): hai `.a-price` không gạch. `price` ở trên lấy
          // cái đầu = cận DƯỚI, nên phải nói ra là còn cận trên, đừng để nó thành "giá bán".
          const dsGia = [...el.querySelectorAll('.a-price:not(.a-text-price) .a-offscreen')]
            .map((o) => money(o.textContent)).filter((x) => x);
          const priceMax = dsGia.length > 1 ? Math.max(...dsGia) : null;
          items.push({ asin, name, price, priceText, priceMax, strike, image, rating, ratingCount, monthly, isAd });
        }
        return { captcha, items };
      },
    });
    const r = (out && out[0] && out[0].result) || { captcha: false, items: [] };
    return { items: r.items, blocked: r.captcha && !r.items.length };
  } catch (e) {
    return { items: [], blocked: false, error: String(e) };
  }
}

// 1688 (giá sỉ Trung) — gọi API nội bộ mtop JSON (h5api.m.1688.com) NGAY TRONG tab world:MAIN.
// Trang React s.1688.com/www.1688.com đá về login.taobao.com khi phiên "lạnh"; nhưng endpoint mtop
// trả JSON sản phẩm KỂ CẢ ẩn danh (không cần đăng nhập). Chữ ký = md5(token&t&appKey&data), với
// token = cookie _m_h5_tk (đọc được same-site ở origin h5api.m.1688.com). Không region.
const ali1688Tab = () => keptTab('ali1688');
/**
 * `executeScript` nhung CO HAN GIO. Tra `null` khi qua han thay vi treo mai.
 *
 * Vi sao can: mot `func` tra Promise ma tab dieu huong giua chung thi ngu canh trang bi
 * huy va Promise khong bao gio settle. `await` tran se dung im cho toi khi trang may-tho
 * het gio, roi bao 'extension chua tra loi' — mot cau khong he chi ve phia thu pham.
 * Da mat mot buoi vi dung no o buoc sap xep cua Shopee.
 */
async function execCoHan(opts, hanMs) {
  let hetGio;
  const dongHo = new Promise((r) => { hetGio = setTimeout(() => r('__QUA_HAN__'), hanMs); });
  try {
    const kq = await Promise.race([chrome.scripting.executeScript(opts), dongHo]);
    return kq === '__QUA_HAN__' ? null : kq;
  } catch (e) {
    return null;
  } finally {
    clearTimeout(hetGio);
  }
}

async function search1688(keyword, count) {
  try {
    const tab = await ali1688Tab();
    // h5api.m.1688.com KHÔNG redirect login (khác www/s.1688.com) và là nơi cookie _m_h5_tk same-origin.
    await chrome.tabs.update(tab.id, { url: 'https://h5api.m.1688.com/h5/mtop.relationrecommend.wirelessrecommend.recommend/2.0/' });
    await waitForComplete(tab.id, 12000);
    const out = await execCoHan({
      target: { tabId: tab.id },
      world: 'MAIN',
      args: [keyword, count || 20],
      func: async (keyword, count) => {
        // md5 thuần JS (mtop ký sign = md5(token&t&appKey&data)).
        function md5(s){function L(k,d){return(k<<d)|(k>>>(32-d))}function K(G,k){var I,d,F,H,x;F=(G&2147483648);H=(k&2147483648);I=(G&1073741824);d=(k&1073741824);x=(G&1073741823)+(k&1073741823);if(I&d){return(x^2147483648^F^H)}if(I|d){if(x&1073741824){return(x^3221225472^F^H)}else{return(x^1073741824^F^H)}}else{return(x^F^H)}}function r(d,F,k){return(d&F)|((~d)&k)}function q(d,F,k){return(d&k)|(F&(~k))}function p(d,F,k){return(d^F^k)}function n(d,F,k){return(F^(d|(~k)))}function u(G,F,aa,Z,k,H,I){G=K(G,K(K(r(F,aa,Z),k),I));return K(L(G,H),F)}function f(G,F,aa,Z,k,H,I){G=K(G,K(K(q(F,aa,Z),k),I));return K(L(G,H),F)}function D(G,F,aa,Z,k,H,I){G=K(G,K(K(p(F,aa,Z),k),I));return K(L(G,H),F)}function t(G,F,aa,Z,k,H,I){G=K(G,K(K(n(F,aa,Z),k),I));return K(L(G,H),F)}function e(G){var Z;var F=G.length;var x=F+8;var k=(x-(x%64))/64;var I=(k+1)*16;var aa=Array(I-1);var d=0;var H=0;while(H<F){Z=(H-(H%4))/4;d=(H%4)*8;aa[Z]=(aa[Z]|(G.charCodeAt(H)<<d));H++}Z=(H-(H%4))/4;d=(H%4)*8;aa[Z]=aa[Z]|(128<<d);aa[I-2]=F<<3;aa[I-1]=F>>>29;return aa}function B(x){var k="",F="",G,d;for(d=0;d<=3;d++){G=(x>>>(d*8))&255;F="0"+G.toString(16);k=k+F.substr(F.length-2,2)}return k}function J(k){k=k.replace(/\r\n/g,"\n");var d="";for(var F=0;F<k.length;F++){var x=k.charCodeAt(F);if(x<128){d+=String.fromCharCode(x)}else{if((x>127)&&(x<2048)){d+=String.fromCharCode((x>>6)|192);d+=String.fromCharCode((x&63)|128)}else{d+=String.fromCharCode((x>>12)|224);d+=String.fromCharCode(((x>>6)&63)|128);d+=String.fromCharCode((x&63)|128)}}}return d}var C=[];var P,h,E,v,g,Y,X,W,V;var S=7,Q=12,N=17,M=22;var A=5,z=9,y=14,w=20;var o=4,m=11,l=16,j=23;var U=6,T=10,R=15,O=21;s=J(s);C=e(s);Y=1732584193;X=4023233417;W=2562383102;V=271733878;for(P=0;P<C.length;P+=16){h=Y;E=X;v=W;g=V;Y=u(Y,X,W,V,C[P+0],S,3614090360);V=u(V,Y,X,W,C[P+1],Q,3905402710);W=u(W,V,Y,X,C[P+2],N,606105819);X=u(X,W,V,Y,C[P+3],M,3250441966);Y=u(Y,X,W,V,C[P+4],S,4118548399);V=u(V,Y,X,W,C[P+5],Q,1200080426);W=u(W,V,Y,X,C[P+6],N,2821735955);X=u(X,W,V,Y,C[P+7],M,4249261313);Y=u(Y,X,W,V,C[P+8],S,1770035416);V=u(V,Y,X,W,C[P+9],Q,2336552879);W=u(W,V,Y,X,C[P+10],N,4294925233);X=u(X,W,V,Y,C[P+11],M,2304563134);Y=u(Y,X,W,V,C[P+12],S,1804603682);V=u(V,Y,X,W,C[P+13],Q,4254626195);W=u(W,V,Y,X,C[P+14],N,2792965006);X=u(X,W,V,Y,C[P+15],M,1236535329);Y=f(Y,X,W,V,C[P+1],A,4129170786);V=f(V,Y,X,W,C[P+6],z,3225465664);W=f(W,V,Y,X,C[P+11],y,643717713);X=f(X,W,V,Y,C[P+0],w,3921069994);Y=f(Y,X,W,V,C[P+5],A,3593408605);V=f(V,Y,X,W,C[P+10],z,38016083);W=f(W,V,Y,X,C[P+15],y,3634488961);X=f(X,W,V,Y,C[P+4],w,3889429448);Y=f(Y,X,W,V,C[P+9],A,568446438);V=f(V,Y,X,W,C[P+14],z,3275163606);W=f(W,V,Y,X,C[P+3],y,4107603335);X=f(X,W,V,Y,C[P+8],w,1163531501);Y=f(Y,X,W,V,C[P+13],A,2850285829);V=f(V,Y,X,W,C[P+2],z,4243563512);W=f(W,V,Y,X,C[P+7],y,1735328473);X=f(X,W,V,Y,C[P+12],w,2368359562);Y=D(Y,X,W,V,C[P+5],o,4294588738);V=D(V,Y,X,W,C[P+8],m,2272392833);W=D(W,V,Y,X,C[P+11],l,1839030562);X=D(X,W,V,Y,C[P+14],j,4259657740);Y=D(Y,X,W,V,C[P+1],o,2763975236);V=D(V,Y,X,W,C[P+4],m,1272893353);W=D(W,V,Y,X,C[P+7],l,4139469664);X=D(X,W,V,Y,C[P+10],j,3200236656);Y=D(Y,X,W,V,C[P+13],o,681279174);V=D(V,Y,X,W,C[P+0],m,3936430074);W=D(W,V,Y,X,C[P+3],l,3572445317);X=D(X,W,V,Y,C[P+6],j,76029189);Y=D(Y,X,W,V,C[P+9],o,3654602809);V=D(V,Y,X,W,C[P+12],m,3873151461);W=D(W,V,Y,X,C[P+15],l,530742520);X=D(X,W,V,Y,C[P+2],j,3299628645);Y=t(Y,X,W,V,C[P+0],U,4096336452);V=t(V,Y,X,W,C[P+7],T,1126891415);W=t(W,V,Y,X,C[P+14],R,2878612391);X=t(X,W,V,Y,C[P+5],O,4237533241);Y=t(Y,X,W,V,C[P+12],U,1700485571);V=t(V,Y,X,W,C[P+3],T,2399980690);W=t(W,V,Y,X,C[P+10],R,4293915773);X=t(X,W,V,Y,C[P+1],O,2240044497);Y=t(Y,X,W,V,C[P+8],U,1873313359);V=t(V,Y,X,W,C[P+15],T,4264355552);W=t(W,V,Y,X,C[P+6],R,2734768916);X=t(X,W,V,Y,C[P+13],O,1309151649);Y=t(Y,X,W,V,C[P+4],U,4149444226);V=t(V,Y,X,W,C[P+11],T,3174756917);W=t(W,V,Y,X,C[P+2],R,718787259);X=t(X,W,V,Y,C[P+9],O,3951481745);Y=K(Y,h);X=K(X,E);W=K(W,v);V=K(V,g)}return(B(Y)+B(X)+B(W)+B(V)).toLowerCase()}
        const appKey = '12574478';
        const api = 'mtop.relationrecommend.WirelessRecommend.recommend';
        const base = 'https://h5api.m.1688.com/h5/mtop.relationrecommend.wirelessrecommend.recommend/2.0/';
        const pageSize = Math.min(60, Math.max(10, count || 20));
        // sortType 'va_rmdarkgmv30rt' = xếp theo GMV 30 ngày ↓ — vừa nổi hàng bán chạy, vừa LỘ số bán
        // (sort 'booked' trả bookedCount toàn "0"; sort này mới có bookedCount thật + afterPrice "已售…件").
        const params = JSON.stringify({ keywords: keyword, beginPage: 1, pageSize, method: 'getOfferList', verticalProductFlag: 'pcmarket', searchScene: 'pcOfferSearch', charset: 'GBK', sortType: 'va_rmdarkgmv30rt' });
        const data = JSON.stringify({ appId: '32517', params });
        const tok = () => { const m = document.cookie.match(/_m_h5_tk=([^;_]+)/); return m ? m[1] : ''; };
        const mkurl = () => { const ts = Date.now().toString(); const sign = md5(tok() + '&' + ts + '&' + appKey + '&' + data); return base + '?jsv=2.5.1&appKey=' + appKey + '&t=' + ts + '&sign=' + sign + '&api=' + api + '&v=2.0&type=originaljson&dataType=json&data=' + encodeURIComponent(data); };
        // Thử tối đa 3 lần: lần đầu có thể FAIL_SYS_TOKEN (token rỗng/hết hạn) nhưng server SET LẠI cookie
        // _m_h5_tk → lần sau ký đúng. Đây là nhịp chuẩn của mtop, chống lỗi token chập chờn giữa các lần search.
        let j = null, lastRet = 'no-response', lastParsed = null;
        for (let attempt = 0; attempt < 3; attempt++) {
          let txt = '';
          try { txt = await (await fetch(mkurl(), { credentials: 'include' })).text(); }
          catch (e) { return { items: [], blocked: false, error: 'fetch: ' + e }; }
          try { lastParsed = JSON.parse(txt); } catch (e) { lastParsed = null; }
          lastRet = (lastParsed && lastParsed.ret && lastParsed.ret[0]) || 'no-json';
          if (/SUCCESS/i.test(lastRet)) { j = lastParsed; break; }
          await new Promise((res) => setTimeout(res, 400)); // cookie vừa được set/refresh → thử lại
        }
        if (!j) {
          const spam = /ILLEGAL|RGV587|SPAM|FLOW|punish|限流/i.test(lastRet);
          const validate = /VALIDATE/i.test(lastRet); // FAIL_SYS_USER_VALIDATE = bắt kéo slider (Baxia)
          return { items: [], blocked: spam || validate, error: lastRet, verifyUrl: (lastParsed && lastParsed.data && lastParsed.data.url) || '' };
        }
        // Dò link video trong item (chạy IN-PAGE nên không dùng được rsFindVideoUrl của background).
        function _vid(o, dp) { dp = dp || 0; if (o == null || dp > 5) return ''; if (typeof o === 'string') { return /^(https?:)?\/\//.test(o) && /\.mp4(\?|$)|\.m3u8|cloud\.video|\/video\//i.test(o) ? (o.indexOf('//') === 0 ? 'https:' + o : o) : ''; } if (Array.isArray(o)) { for (var i = 0; i < o.length; i++) { var v = _vid(o[i], dp + 1); if (v) return v; } return ''; } if (typeof o === 'object') { for (var k in o) { var vv = _vid(o[k], dp + 1); if (vv) return vv; } } return ''; }
        const raw = ((((j.data || {}).data || {}).OFFER || {}).items) || [];
        // RỖNG MÀ KHÔNG BÁO GÌ LÀ KIỂU HỎNG TỆ NHẤT. mtop trả SUCCESS nhưng đường dẫn
        // `data.data.OFFER.items` rỗng thì có ba nguyên nhân không phân biệt được từ ngoài:
        // từ khoá thật sự không có hàng, 1688 đổi hình dạng phản hồi, hoặc phiên bị hạ quyền
        // (đăng nhập hỏng thì mtop vẫn SUCCESS nhưng trả danh sách trống). Khai ra hình dạng
        // thật để lần sau khỏi phải sửa mù.
        if (!raw.length) {
          // `data.data.OFFER` CÓ TỒN TẠI (đo 2026-09-11) nhưng `.items` rỗng — nên soi thẳng
          // vào OFFER: khoá nào, mảng nào dài bao nhiêu. Đây là chỗ duy nhất còn mù.
          const off = ((((j.data || {}).data || {}).OFFER) || {});
          const mang = Object.keys(off).filter((k) => Array.isArray(off[k]))
                             .map((k) => k + '[' + off[k].length + ']');
          return { items: [], blocked: false,
                   error: 'OFFER.keys=' + JSON.stringify(Object.keys(off))
                        + ' mang=' + JSON.stringify(mang)
                        + ' tail=' + JSON.stringify(off).slice(0, 220) };
        }
        const items = [];
        // KHAI RA HÌNH DẠNG THẬT khi bóc hụt. Đo 2026-09-11: `d.offerId` còn đúng chỗ nhưng
        // `priceInfo`, `bookedCount`, `afterPrice`, `shop` đều vắng — 1688 đã đổi cấu trúc.
        // Không có mẫu này thì mỗi lần sàn đổi lại tốn một vòng sửa mù.
        if (raw.length && raw[0] && raw[0].data) {
          const d0 = raw[0].data;
          const rut = {};
          for (const k of Object.keys(d0)) {
            const v = d0[k];
            rut[k] = (v && typeof v === 'object') ? ('{' + Object.keys(v).slice(0, 6).join(',') + '}')
                                                  : String(v).slice(0, 24);
          }
          var _mauD = JSON.stringify(rut).slice(0, 900);
        }
        for (const it of raw) {
          const d = it && it.data;
          if (!d || !d.offerId) continue;
          const price = parseFloat(String((d.priceInfo && d.priceInfo.price) || '').replace(/[^0-9.]/g, '')) || null;
          // Số bán: bookedCount = thành giao ~30 ngày (BÁN/THÁNG); afterPrice.text "已售10万+件" = tổng đã bán (TỔNG BÁN).
          const monthly = parseInt(String(d.bookedCount || '').replace(/[^0-9]/g, ''), 10) || null; // bán ~30 ngày (chính xác)
          // afterPrice.text: "已售X+件" = đã bán của CHÍNH shop này (tích luỹ, làm tròn xuống 100+/300+/…).
          // "全网X+件" = toàn sàn cho mẫu đó — KHÔNG phải shop này → BỎ, tránh thổi phồng tổng bán.
          let sold = null;
          const apt = String((d.afterPrice && d.afterPrice.text) || '');
          if (/已售/.test(apt)) {
            const sm = apt.match(/([\d.]+)\s*(万)?/);
            if (sm) { sold = parseFloat(sm[1]) || null; if (sold && sm[2] === '万') sold = Math.round(sold * 10000); } // "1.9万+" = 19000
          }
          // Chống "ảo": tổng (làm tròn xuống) không thể NHỎ HƠN bán ~30 ngày → lệch thì bỏ tổng, giữ số tháng chính xác.
          if (sold != null && monthly != null && sold < monthly) sold = null;
          // 1688 không có rating theo sản phẩm → dùng điểm dịch vụ shop tổng hợp (0-5), như rating shop Etsy.
          const ts = (d.shopAddition && d.shopAddition.tradeService) || {};
          const rating = parseFloat(ts.compositeNewScore || ts.goodsScore || '') || null;
          // 回头率 (tỉ lệ khách quay lại) — tín hiệu cầu phụ. "37%" -> 37.
          const rrText = (d.afterTags && /return_rate/i.test(d.afterTags.matKey || '') && d.afterTags.text) || '';
          const repurchase = parseFloat(String(rrText).replace(/[^0-9.]/g, '')) || null;
          items.push({
            id: String(d.offerId),
            name: (d.title || '').replace(/<[^>]+>/g, '').trim(), // bỏ thẻ <font> tô đậm từ khoá
            price,
            image: d.offerPicUrl || '',
            videoUrl: _vid(it), // video sản phẩm nếu có trong response search

            monthly,                                          // thành giao ~30 ngày
            sold,                                             // tổng đã bán (từ "已售…件")
            shop: (d.shop && d.shop.text) || d.loginId || '', // tên công ty đầy đủ nếu có
            rating,                                           // điểm shop 0-5
            repurchase,                                       // % khách quay lại
            // LINK TRANG SẢN PHẨM. `d.linkUrl` là thứ chính trang dùng khi bấm vào thẻ; khi nó
            // vắng thì dựng từ `offerId` — 1688 định tuyến trang chi tiết thuần bằng mã, không
            // cần slug. Trước đây trường này KHÔNG được trả về, nên backend rơi về `similar` và
            // cả kho lưu link 'tìm hàng cùng mẫu' thay vì link sản phẩm; mở ra vẫn thấy hàng nên
            // không ai nghi ngờ.
            url: (d.linkUrl && String(d.linkUrl).length > 30)
                 ? String(d.linkUrl)
                 : 'https://detail.1688.com/offer/' + d.offerId + '.html',
            similar: d.sameDesignUrl || '',                   // link tìm sản phẩm CÙNG MẪU
          });
        }
        // Có offer nhưng KHÔNG bóc được số bán ở dòng đầu ⇒ kèm mẫu cấu trúc.
        const hut = items.length && items[0].sold == null && items[0].monthly == null;
        return { items, blocked: false, shape: hut ? _mauD : undefined };
      },
    }, 100000);
    const r = (out && out[0] && out[0].result) || { items: [], blocked: false };
    // 1688 bắt xác minh (kéo slider) — mở trang xác minh cho user giải 1 lần → set cookie x5sec → lần sau qua.
    if (r.error && /VALIDATE/i.test(r.error)) {
      // NÓI RA ĐỊA CHỈ ĐÃ MỞ, và nói rõ khi không có địa chỉ thật.
      //
      // `verifyUrl` lấy từ `data.url` của mtop. Khi mtop KHÔNG trả trường đó, dòng cũ rơi về
      // trang chủ 1688 — nơi không có slider nào cả. Người vận hành mở ra, thấy một trang bình
      // thường, tưởng đã giải xong, và lần cào sau vẫn chặn y hệt. Câu báo lỗi cũ lại giấu cả
      // mã gốc lẫn địa chỉ nên không cách nào phân biệt "giải sai chỗ" với "giải rồi vẫn chặn".
      const thatVurl = r.verifyUrl && String(r.verifyUrl).trim();
      let vurl = thatVurl || 'https://s.1688.com/';
      if (vurl.indexOf('//') === 0) vurl = 'https:' + vurl;
      await openVerifyTab('verify:1688', vurl);
      return {
        items: [], blocked: true, verifyUrl: vurl, ret: r.error,
        error: thatVurl
          ? `1688 bắt xác minh (${r.error}) — đã mở ${vurl}, kéo slider ở ĐÚNG tab đó rồi chạy lại`
          : `1688 bắt xác minh (${r.error}) nhưng KHÔNG trả địa chỉ trang xác minh, `
            + `đã mở tạm ${vurl} — trang này thường không có slider, xem ghi chú trong code`,
      };
    }
    return r;
  } catch (e) {
    return { items: [], blocked: false, error: String(e) };
  }
}

// ============================================================================
// TAOBAO + TEMU (Cách A "ký sinh"): điều hướng tab đã login tới URL search → trang TỰ gọi API đã ký
// (mtop x5sec / anti-content) → page-hook.js chộp response → parse phòng thủ. KHÔNG tự ký request.
// EXPERIMENTAL: cần tab đã đăng nhập; Baxia/Temu có thể chặn → báo notice để user xử lý.
// ============================================================================

const taobaoTab = () => keptTab('taobao');
const temuTab = () => keptTab('temu');

// Điều hướng tab tới URL search rồi ĐỢI hook chộp response (trang tự gọi, tự ký). Chạy NGẦM khi trót
// lọt; khi vướng đăng nhập/xác minh (slider) hoặc quá giờ → ĐƯA TAB RA TRƯỚC để user tự xử 1 lần.
// Trả {texts[], blocked, reason}. Không tự giải captcha (không thể & không được phép).
async function navAndCapture(getTab, url, needleRe, loginRe, contentRe, timeoutMs = 22000) {
  const tab = await getTab();
  await chrome.tabs.update(tab.id, { url });
  await focusTab(tab.id); // SPA nặng (Temu/Taobao) chỉ render + bắn XHR khi tab HIỆN TRƯỚC; tab nền bị Chrome tiết chế
  await waitForComplete(tab.id, 16000);
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    await sleep(700);
    let r = null;
    try {
      const out = await chrome.scripting.executeScript({
        target: { tabId: tab.id }, world: 'MAIN',
        func: () => ({ cap: (window.__rsCap || []).map((c) => ({ url: c.url, text: c.text })), href: location.href, body: (document.body ? document.body.innerText.slice(0, 500) : '') }),
      });
      r = out && out[0] && out[0].result;
    } catch (e) { /* trang chưa sẵn sàng */ }
    if (r) {
      // Chỉ nhận response CÓ SẢN PHẨM (khớp contentRe) — bỏ qua các call phụ như search_suggest bắn trước.
      const hits = (r.cap || []).filter((c) => needleRe.test(c.url) && (!contentRe || contentRe.test(c.text)));
      if (hits.length) return { texts: hits.map((h) => h.text), blocked: false };
      // Đăng nhập hoặc slider (nc/滑块/验证) → không tự qua được, đưa tab ra trước cho user.
      if (loginRe.test(r.href) || /login|登录|sign in/i.test(r.href)) { await focusTab(tab.id); return { texts: [], blocked: true, reason: 'login' }; }
      if (/滑块|请拖动|向右滑|verify|captcha|拖动|nc_wrapper|安全验证/i.test(r.body || '')) { await focusTab(tab.id); return { texts: [], blocked: true, reason: 'verify' }; }
    }
  }
  await focusTab(tab.id); // hết giờ mà chưa bắt được — nhiều khả năng có slider/đăng nhập, đưa tab ra
  return { texts: [], blocked: true, reason: 'timeout' };
}
async function focusTab(tabId) {
  try {
    const t = await chrome.tabs.get(tabId);
    await chrome.tabs.update(tabId, { active: true });
    if (t && t.windowId != null) await chrome.windows.update(t.windowId, { focused: true });
  } catch (e) {}
}

// TikTok API response → items chuẩn hoá. Đầu vào là raw text của response từ __rsCap (đã lọc
// theo /api/search/(general|item|video)/). Trả về [{id, name, author, videoUrl, image, likeCount,
// createdAt}]. likeCount = statistics.digg_count; createdAt = create_time (unix giây). desc =
// caption đẹp hơn nhiều so với DOM alt.
function parseTiktokTexts(texts, count) {
  const out = [];
  const seen = new Set();
  const looks = (x) => x && typeof x === 'object' && (x.id || x.aweme_id) && (x.author || x.desc || x.video || x.statistics);
  for (const t of texts) {
    let j = null; try { j = JSON.parse(t); } catch (e) { continue; }
    let arr = [];
    if (Array.isArray(j.item_list)) arr = j.item_list;
    else if (Array.isArray(j.data)) arr = j.data.map((d) => (d && (d.item || d.aweme_info)) || d).filter(Boolean);
    if (!arr.length) arr = rsDeepFindArray(j, looks);
    for (const it of arr) {
      const id = String(it.id || it.aweme_id || '');
      if (!id || seen.has(id)) continue;
      seen.add(id);
      const author = (it.author && (it.author.unique_id || it.author.uniqueId || it.author.nickname)) || '';
      const stats = it.statistics || it.stats || {};
      out.push({
        id,
        name: it.desc || '',
        author,
        videoUrl: author ? `https://www.tiktok.com/@${author}/video/${id}` : `https://www.tiktok.com/video/${id}`,
        image: (it.video && (it.video.cover || (it.video.origin_cover && it.video.origin_cover.url_list && it.video.origin_cover.url_list[0]))) || '',
        platform: 'TikTok',
        likeCount: Number(stats.digg_count || stats.diggCount || 0) || null,
        commentCount: Number(stats.comment_count || stats.commentCount || 0) || null,
        shareCount: Number(stats.share_count || stats.shareCount || 0) || null,
        playCount: Number(stats.play_count || stats.playCount || 0) || null,
        createdAt: Number(it.create_time || it.createTime || 0) || null,
      });
      if (out.length >= count) return out;
    }
  }
  return out;
}

// Douyin API response → items chuẩn hoá. Endpoint /aweme/v1/web/general/search/single/ trả về
// data[].aweme_info = { aweme_id, desc, create_time, statistics.digg_count, video.cover, author }.
// Cùng schema với TikTok (cùng gốc ByteDance), nên gần như copy parser.
function parseDouyinTexts(texts, count) {
  const out = [];
  const seen = new Set();
  const looks = (x) => x && typeof x === 'object' && (x.aweme_id || x.id) && (x.statistics || x.desc || x.video);
  for (const t of texts) {
    let j = null; try { j = JSON.parse(t); } catch (e) { continue; }
    // Douyin bọc mỗi item trong { aweme_info: {...} } hoặc thẳng { aweme_id, ... }.
    let arr = [];
    if (Array.isArray(j.data)) arr = j.data.map((d) => (d && (d.aweme_info || d.item || d)) || null).filter(Boolean);
    if (!arr.length) arr = rsDeepFindArray(j, looks);
    for (const it of arr) {
      const id = String(it.aweme_id || it.id || '');
      if (!id || seen.has(id)) continue;
      seen.add(id);
      const stats = it.statistics || {};
      const author = (it.author && (it.author.nickname || it.author.sec_uid || it.author.short_id)) || '';
      const cover = (it.video && ((it.video.cover && it.video.cover.url_list && it.video.cover.url_list[0]) || it.video.origin_cover?.url_list?.[0])) || '';
      out.push({
        id,
        name: it.desc || '',
        author,
        videoUrl: `https://www.douyin.com/video/${id}`,
        image: cover,
        platform: 'Douyin',
        likeCount: Number(stats.digg_count || 0) || null,
        commentCount: Number(stats.comment_count || 0) || null,
        shareCount: Number(stats.share_count || 0) || null,
        playCount: Number(stats.play_count || 0) || null,
        createdAt: Number(it.create_time || 0) || null,
      });
      if (out.length >= count) return out;
    }
  }
  return out;
}

// Dò MẢNG sản phẩm trong JSON bất kỳ: mảng có ≥3 phần tử "trông giống sản phẩm" (theo `looksItem`).
function rsDeepFindArray(root, looksItem) {
  let best = null;
  (function walk(o, depth) {
    if (o == null || depth > 8) return;
    if (Array.isArray(o)) {
      const n = o.length;
      if (n) {
        const hits = o.slice(0, 30).filter((x) => looksItem(x)).length;
        if (hits >= Math.min(3, n) && (!best || n > best.length)) best = o;
      }
      for (let i = 0; i < Math.min(o.length, 30); i++) walk(o[i], depth + 1);
    } else if (typeof o === 'object') {
      for (const k in o) walk(o[k], depth + 1);
    }
  })(root, 0);
  return best || [];
}

// Dò link VIDEO trong item sản phẩm bất kỳ (không cần biết field chính xác từng sàn): duyệt cây,
// bắt string trông như URL video (.mp4/.m3u8, cloud.video, /video/…). Trả '' nếu item không có
// video trong response search — nghĩa là video (nếu có) chỉ nằm ở trang chi tiết, không phải bug.
function rsFindVideoUrl(o, depth) {
  depth = depth || 0;
  if (o == null || depth > 6) return '';
  if (typeof o === 'string') {
    if (/^(https?:)?\/\//.test(o) && /\.mp4(\?|$)|\.m3u8|cloud\.video|\/video\/|video_url|\/vod\//i.test(o)) {
      return o.indexOf('//') === 0 ? 'https:' + o : o;
    }
    return '';
  }
  if (Array.isArray(o)) { for (var i = 0; i < o.length; i++) { var v = rsFindVideoUrl(o[i], depth + 1); if (v) return v; } return ''; }
  if (typeof o === 'object') {
    for (var k in o) { if (/video/i.test(k)) { var vk = rsFindVideoUrl(o[k], depth + 1); if (vk) return vk; } }
    for (var k2 in o) { var v2 = rsFindVideoUrl(o[k2], depth + 1); if (v2) return v2; }
  }
  return '';
}

// Taobao FAST: gọi mtop h5search TRỰC TIẾP trong tab origin h5api.m.taobao.com (không chờ render SPA).
// Kế thừa cookie session + x5sec của user → có thể qua Baxia khi đã đăng nhập (IP nhà). Nhanh như 1688.

async function searchTaobao(keyword, count) {
  try {
    const tab = await taobaoTab();
    await chrome.tabs.update(tab.id, { url: 'https://h5api.m.taobao.com/h5/mtop.taobao.wsearch.h5search/1.0/' });
    await waitForComplete(tab.id, 12000);
    const out = await execCoHan({
      target: { tabId: tab.id },
      world: 'MAIN',
      args: [keyword, count || 20],
      func: async (keyword, count) => {
        function md5(s){function L(k,d){return(k<<d)|(k>>>(32-d))}function K(G,k){var I,d,F,H,x;F=(G&2147483648);H=(k&2147483648);I=(G&1073741824);d=(k&1073741824);x=(G&1073741823)+(k&1073741823);if(I&d){return(x^2147483648^F^H)}if(I|d){if(x&1073741824){return(x^3221225472^F^H)}else{return(x^1073741824^F^H)}}else{return(x^F^H)}}function r(d,F,k){return(d&F)|((~d)&k)}function q(d,F,k){return(d&k)|(F&(~k))}function p(d,F,k){return(d^F^k)}function n(d,F,k){return(F^(d|(~k)))}function u(G,F,aa,Z,k,H,I){G=K(G,K(K(r(F,aa,Z),k),I));return K(L(G,H),F)}function f(G,F,aa,Z,k,H,I){G=K(G,K(K(q(F,aa,Z),k),I));return K(L(G,H),F)}function D(G,F,aa,Z,k,H,I){G=K(G,K(K(p(F,aa,Z),k),I));return K(L(G,H),F)}function t(G,F,aa,Z,k,H,I){G=K(G,K(K(n(F,aa,Z),k),I));return K(L(G,H),F)}function e(G){var Z;var F=G.length;var x=F+8;var k=(x-(x%64))/64;var I=(k+1)*16;var aa=Array(I-1);var d=0;var H=0;while(H<F){Z=(H-(H%4))/4;d=(H%4)*8;aa[Z]=(aa[Z]|(G.charCodeAt(H)<<d));H++}Z=(H-(H%4))/4;d=(H%4)*8;aa[Z]=aa[Z]|(128<<d);aa[I-2]=F<<3;aa[I-1]=F>>>29;return aa}function B(x){var k="",F="",G,d;for(d=0;d<=3;d++){G=(x>>>(d*8))&255;F="0"+G.toString(16);k=k+F.substr(F.length-2,2)}return k}function J(k){k=k.replace(/\r\n/g,"\n");var d="";for(var F=0;F<k.length;F++){var x=k.charCodeAt(F);if(x<128){d+=String.fromCharCode(x)}else{if((x>127)&&(x<2048)){d+=String.fromCharCode((x>>6)|192);d+=String.fromCharCode((x&63)|128)}else{d+=String.fromCharCode((x>>12)|224);d+=String.fromCharCode(((x>>6)&63)|128);d+=String.fromCharCode((x&63)|128)}}}return d}var C=[];var P,h,E,v,g,Y,X,W,V;var S=7,Q=12,N=17,M=22;var A=5,z=9,y=14,w=20;var o=4,m=11,l=16,j=23;var U=6,T=10,R=15,O=21;s=J(s);C=e(s);Y=1732584193;X=4023233417;W=2562383102;V=271733878;for(P=0;P<C.length;P+=16){h=Y;E=X;v=W;g=V;Y=u(Y,X,W,V,C[P+0],S,3614090360);V=u(V,Y,X,W,C[P+1],Q,3905402710);W=u(W,V,Y,X,C[P+2],N,606105819);X=u(X,W,V,Y,C[P+3],M,3250441966);Y=u(Y,X,W,V,C[P+4],S,4118548399);V=u(V,Y,X,W,C[P+5],Q,1200080426);W=u(W,V,Y,X,C[P+6],N,2821735955);X=u(X,W,V,Y,C[P+7],M,4249261313);Y=u(Y,X,W,V,C[P+8],S,1770035416);V=u(V,Y,X,W,C[P+9],Q,2336552879);W=u(W,V,Y,X,C[P+10],N,4294925233);X=u(X,W,V,Y,C[P+11],M,2304563134);Y=u(Y,X,W,V,C[P+12],S,1804603682);V=u(V,Y,X,W,C[P+13],Q,4254626195);W=u(W,V,Y,X,C[P+14],N,2792965006);X=u(X,W,V,Y,C[P+15],M,1236535329);Y=f(Y,X,W,V,C[P+1],A,4129170786);V=f(V,Y,X,W,C[P+6],z,3225465664);W=f(W,V,Y,X,C[P+11],y,643717713);X=f(X,W,V,Y,C[P+0],w,3921069994);Y=f(Y,X,W,V,C[P+5],A,3593408605);V=f(V,Y,X,W,C[P+10],z,38016083);W=f(W,V,Y,X,C[P+15],y,3634488961);X=f(X,W,V,Y,C[P+4],w,3889429448);Y=f(Y,X,W,V,C[P+9],A,568446438);V=f(V,Y,X,W,C[P+14],z,3275163606);W=f(W,V,Y,X,C[P+3],y,4107603335);X=f(X,W,V,Y,C[P+8],w,1163531501);Y=f(Y,X,W,V,C[P+13],A,2850285829);V=f(V,Y,X,W,C[P+2],z,4243563512);W=f(W,V,Y,X,C[P+7],y,1735328473);X=f(X,W,V,Y,C[P+12],w,2368359562);Y=D(Y,X,W,V,C[P+5],o,4294588738);V=D(V,Y,X,W,C[P+8],m,2272392833);W=D(W,V,Y,X,C[P+11],l,1839030562);X=D(X,W,V,Y,C[P+14],j,4259657740);Y=D(Y,X,W,V,C[P+1],o,2763975236);V=D(V,Y,X,W,C[P+4],m,1272893353);W=D(W,V,Y,X,C[P+7],l,4139469664);X=D(X,W,V,Y,C[P+10],j,3200236656);Y=D(Y,X,W,V,C[P+13],o,681279174);V=D(V,Y,X,W,C[P+0],m,3936430074);W=D(W,V,Y,X,C[P+3],l,3572445317);X=D(X,W,V,Y,C[P+6],j,76029189);Y=D(Y,X,W,V,C[P+9],o,3654602809);V=D(V,Y,X,W,C[P+12],m,3873151461);W=D(W,V,Y,X,C[P+15],l,530742520);X=D(X,W,V,Y,C[P+2],j,3299628645);Y=t(Y,X,W,V,C[P+0],U,4096336452);V=t(V,Y,X,W,C[P+7],T,1126891415);W=t(W,V,Y,X,C[P+14],R,2878612391);X=t(X,W,V,Y,C[P+5],O,4237533241);Y=t(Y,X,W,V,C[P+12],U,1700485571);V=t(V,Y,X,W,C[P+3],T,2399980690);W=t(W,V,Y,X,C[P+10],R,4293915773);X=t(X,W,V,Y,C[P+1],O,2240044497);Y=t(Y,X,W,V,C[P+8],U,1873313359);V=t(V,Y,X,W,C[P+15],T,4264355552);W=t(W,V,Y,X,C[P+6],R,2734768916);X=t(X,W,V,Y,C[P+13],O,1309151649);Y=t(Y,X,W,V,C[P+4],U,4149444226);V=t(V,Y,X,W,C[P+11],T,3174756917);W=t(W,V,Y,X,C[P+2],R,718787259);X=t(X,W,V,Y,C[P+9],O,3951481745);Y=K(Y,h);X=K(X,E);W=K(W,v);V=K(V,g)}return(B(Y)+B(X)+B(W)+B(V)).toLowerCase()}
        const appKey = '12574478', api = 'mtop.taobao.wsearch.h5search', ver = '1.0';
        const base = 'https://h5api.m.taobao.com/h5/' + api + '/' + ver + '/';
        const n = Math.min(40, Math.max(10, count || 20));
        const data = JSON.stringify({ q: keyword, search_action: 'initiative', tab: 'all', page: 1, n: n, sort: '_sale' });
        const tok = () => { const m = document.cookie.match(/_m_h5_tk=([^;_]+)/); return m ? m[1] : ''; };
        const mkurl = () => { const ts = Date.now().toString(); const sign = md5(tok() + '&' + ts + '&' + appKey + '&' + data); return base + '?jsv=2.6.1&appKey=' + appKey + '&t=' + ts + '&sign=' + sign + '&api=' + api + '&v=' + ver + '&type=originaljson&dataType=json&data=' + encodeURIComponent(data); };
        let lastText = '', lastRet = 'no-response', verifyUrl = '';
        for (let a = 0; a < 3; a++) {
          try { lastText = await (await fetch(mkurl(), { credentials: 'include' })).text(); }
          catch (e) { return { text: '', ret: 'fetch:' + e }; }
          let pj = null; try { pj = JSON.parse(lastText); } catch (e) {}
          lastRet = (pj && pj.ret && pj.ret[0]) || 'no-json';
          if (/SUCCESS/i.test(lastRet)) return { text: lastText, ret: lastRet };
          if (pj && pj.data && pj.data.url) verifyUrl = pj.data.url;
          await new Promise((r) => setTimeout(r, 400));
        }
        return { text: lastText, ret: lastRet, verifyUrl: verifyUrl };
      },
    }, 100000);
    const r = (out && out[0] && out[0].result) || { text: '', ret: 'no-response' };
    if (!/SUCCESS/i.test(r.ret || '')) {
      // Baxia (RGV587_SM) / cần xác minh / chưa đăng nhập → mở trang Taobao cho user kéo slider/login 1 lần.
      if (/VALIDATE|RGV587|SM|哎哟|令牌|FORBIDDEN|ILLEGAL/i.test(r.ret || '')) {
        let vurl = r.verifyUrl || ('https://s.taobao.com/search?q=' + encodeURIComponent(keyword));
        if (vurl.indexOf('//') === 0) vurl = 'https:' + vurl;
        await openVerifyTab('verify:taobao', vurl);
        return { items: [], blocked: true, error: 'cần đăng nhập/xác minh — đã mở tab Taobao, xong rồi bấm Research lại' };
      }
      // KEM MAU THAN PHAN HOI. `no-json` nghia la mtop tra ve thu khong phai JSON —
      // thuong la mot trang HTML chan hoac chuyen huong. Chi co ma `no-json` thi khong
      // phan biet duoc trang dang nhap voi trang Baxia voi mot phan hoi rong, ma ba thu
      // do chua bang ba cach khac nhau.
      const mau = String(r.text || '').replace(/\s+/g, ' ').slice(0, 260);
      return { items: [], blocked: false,
               error: r.ret + (mau ? ' - than=' + mau : ' - than RONG') };
    }
    const items = parseTaobaoTexts([r.text], count);
    // Chưa map được field → trả raw để dev chỉnh (Taobao h5search cấu trúc chưa xác nhận).
    return { items, blocked: false, raw: items.length ? undefined : (r.text || '').slice(0, 1400) };
  } catch (e) { return { items: [], blocked: false, error: String(e) }; }
}

function parseTaobaoTexts(texts, count) {
  const out = [];
  const looks = (o) => o && typeof o === 'object' && (o.title || o.raw_title || o.subject) && (o.price || o.view_price || o.priceInfo || o.sortPrice);
  for (const text of texts) {
    let j; try { j = JSON.parse(text); } catch (e) { continue; }
    const arr = rsDeepFindArray(j, looks);
    for (const it of arr) {
      const id = String(it.item_id || it.nid || it.itemId || it.id || '');
      if (!id) continue;
      const name = String(it.title || it.raw_title || it.subject || '').replace(/<[^>]+>/g, '').trim();
      const priceRaw = it.price || it.view_price || (it.priceInfo && (it.priceInfo.price || it.priceInfo.priceStr)) || it.sortPrice || '';
      const price = parseFloat(String(priceRaw).replace(/[^0-9.]/g, '')) || null;
      const soldRaw = String(it.realSales || it.view_sales || it.sold || it.payNum || (it.priceInfo && it.priceInfo.saleNum) || '');
      let monthly = parseFloat(soldRaw.replace(/[^0-9.]/g, '')) || null;
      if (monthly && /万/.test(soldRaw)) monthly = Math.round(monthly * 10000);
      let img = it.pic_url || it.picUrl || it.pic || it.image || (it.picInfo && it.picInfo.pic) || '';
      if (img && img.indexOf('//') === 0) img = 'https:' + img;
      const shop = it.nick || it.shopName || (it.shopInfo && it.shopInfo.title) || it.userNick || '';
      out.push({ id, name, price, image: img, monthly, shop, videoUrl: rsFindVideoUrl(it) });
      if (out.length >= count) break;
    }
    if (out.length) break;
  }
  return out;
}

// NGÂN SÁCH của cả `searchTemu`, tính từ lúc vào hàm. Phần cuộn lấy thêm trang KHÔNG BẮT ĐẦU vòng mới
// khi đã qua mốc này. Thứ tự bắt buộc (xem `RS_TEMU` ở worker/index.html và lib/core/worker_relay.py):
//   48s (đây) + một vòng cuộn tệ nhất 8,2s = 56,2s  <  60s (trang máy-thợ)  <  75s (backend)
// Một vòng cuộn tệ nhất = hạn cuộn 3s + nghỉ 1,2s + hạn đọc 4s. Đặt 50s thì vòng bắt đầu sát mốc kết
// thúc ở 58,2s — quá sát. Không có mốc tổng thì trang cuộn chậm kéo job vượt hạn trang máy-thợ, và job
// hết hạn ở tầng ngoài thì MẤT LUÔN 40 SP đã lấy được — tệ hơn nhiều so với trả ít SP hơn yêu cầu.
const TEMU_NGAN_SACH_MS = 48000;
// Cuộn mà ngần này ms không có trang mới nào → coi như từ khoá đã hết hàng, trả những gì đang có.
const TEMU_HET_TRANG_MS = 6000;

// Đọc mọi response `/poppy/v1/search` có lưới SP mà hai hook đã chộp tới giờ (bản chộp đôi được
// `parseTemuTexts` khử theo goods_id).
async function temuDocLuoi(tabId) {
  const out = await withTimeout(chrome.scripting.executeScript({
    target: { tabId }, world: 'MAIN',
    func: () => (window.__rsTemuCap || []).concat((window.__rsCap || [])
      .filter((c) => /poppy\/v1.*search/.test(c.url) && /goods_list|goods_id/.test(c.text)).map((c) => c.text)),
  }), 4000, null);
  return (out && out[0] && out[0].result) || [];
}

// Temu: mở tab search (foreground) → TỰ CÀI HOOK rồi GÕ từ khoá + Enter vào ô search để trang tự bắn
// /api/poppy/v1/search (đã ký anti-content) → chộp response. Điều hướng URL trần chỉ SSR, không bắn XHR.
async function searchTemu(keyword, count) {
  const batDau = Date.now();
  try {
    const tab = await temuTab();
    await chrome.tabs.update(tab.id, { url: 'https://www.temu.com/search_result.html?search_key=' + encodeURIComponent(keyword) });
    await focusTab(tab.id); // SPA nặng — phải foreground mới chạy
    await waitForComplete(tab.id, 16000);
    await sleep(1500); // để React mount xong ô search

    // Cài hook bắt /poppy/v1/search (có goods) + KÍCH HOẠT tìm kiếm: set value ô input rồi Enter (React-friendly).
    await chrome.scripting.executeScript({
      target: { tabId: tab.id }, world: 'MAIN', args: [keyword],
      func: (kw) => {
        if (!window.__rsTemuCap) {
          window.__rsTemuCap = [];
          const hit = (t) => /goods_list|goods_id|goodsList|goodsId/.test(t);
          const of = window.fetch;
          window.fetch = function () {
            const u = typeof arguments[0] === 'string' ? arguments[0] : (arguments[0] && arguments[0].url) || '';
            const p = of.apply(this, arguments);
            if (/poppy\/v1.*search/.test(u)) p.then((r) => { try { r.clone().text().then((t) => { if (hit(t)) window.__rsTemuCap.push(t); }); } catch (e) {} }).catch(() => {});
            return p;
          };
          const X = window.XMLHttpRequest, oo = X.prototype.open, os = X.prototype.send;
          X.prototype.open = function (m, u) { this.__u = u; return oo.apply(this, arguments); };
          X.prototype.send = function () { const self = this; this.addEventListener('load', function () { try { if (/poppy\/v1.*search/.test(self.__u) && hit(self.responseText)) window.__rsTemuCap.push(self.responseText); } catch (e) {} }); return os.apply(this, arguments); };
        }
        // Gõ vào ô search + Enter để trang tự gọi API sản phẩm (dùng native setter cho React).
        try {
          const inp = document.querySelector('input[type="search"]') || document.querySelector('input[role="searchbox"]') || [...document.querySelectorAll('input')].find((e) => /search|tìm/i.test((e.placeholder || '') + (e.getAttribute('aria-label') || '')));
          if (inp) {
            const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set;
            setter.call(inp, kw); inp.dispatchEvent(new Event('input', { bubbles: true }));
            inp.focus();
            for (const type of ['keydown', 'keypress', 'keyup']) inp.dispatchEvent(new KeyboardEvent(type, { key: 'Enter', code: 'Enter', keyCode: 13, which: 13, bubbles: true }));
            const form = inp.closest('form'); if (form) { try { form.requestSubmit ? form.requestSubmit() : form.submit(); } catch (e) {} }
          }
        } catch (e) {}
        return true;
      },
    });

    // Đợi hook chộp được response sản phẩm (do mount hoặc do lần gõ Enter ở trên).
    const deadline = Date.now() + 18000;
    let texts = [];
    while (Date.now() < deadline) {
      await sleep(800);
      let r = null;
      try {
        const out = await chrome.scripting.executeScript({ target: { tabId: tab.id }, world: 'MAIN', func: () => ({ a: window.__rsTemuCap || [], b: (window.__rsCap || []).filter((c) => /poppy\/v1.*search/.test(c.url) && /goods_list|goods_id/.test(c.text)).map((c) => c.text), href: location.href }) });
        r = out && out[0] && out[0].result;
      } catch (e) {}
      if (r) {
        if (/login\.html/.test(r.href)) { await focusTab(tab.id); return { items: [], blocked: true, error: 'chưa đăng nhập — đã mở tab Temu, đăng nhập xong rồi bấm Research lại' }; }
        const got = (r.a || []).concat(r.b || []);
        if (got.length) { texts = got; break; }
      }
    }
    if (!texts.length) { await focusTab(tab.id); return { items: [], blocked: true, error: 'chưa bắt được lưới SP — đã mở tab, gõ search 1 lần trong tab Temu rồi bấm Research lại' }; }
    let items = parseTemuTexts(texts, count);

    // LẤY THÊM TRANG CHO ĐỦ `count`. Temu chỉ trả ~40 SP một trang và tải trang kế khi CUỘN tới đáy
    // lưới (hoặc bấm "See more"). Mỗi trang là một response `/poppy/v1/search` mới mà hook đã cài ở
    // trên tự chộp — nên chỉ cần cuộn, đọc lại, cộng dồn. Dừng khi đủ, khi hết ngân sách tổng, hoặc
    // khi TEMU_HET_TRANG_MS không có trang mới (từ khoá hết hàng — trả đúng số có, không bịa thêm).
    let trang = 1;
    let soResponse = texts.length;
    let lanCuoiCoMoi = Date.now();
    while (items.length < count
           && Date.now() - batDau < TEMU_NGAN_SACH_MS
           && Date.now() - lanCuoiCoMoi < TEMU_HET_TRANG_MS) {
      await withTimeout(chrome.scripting.executeScript({
        target: { tabId: tab.id }, world: 'MAIN',
        func: () => {
          window.scrollTo(0, document.documentElement.scrollHeight);
          // Một số phiên bản trang dùng nút thay vì cuộn vô hạn. Chỉ bấm phần tử NHỎ, ĐANG HIỆN và
          // có chữ khớp hẳn — bấm nhầm một thẻ sản phẩm là điều hướng mất cả trang kết quả.
          const nut = [...document.querySelectorAll('button, [role="button"], div, span')].find((e) => {
            const t = (e.textContent || '').trim();
            return t.length < 30 && e.offsetParent && /^(see more|view more|show more|load more|xem thêm)\b/i.test(t);
          });
          if (nut) nut.click();
          return true;
        },
      }), 3000, null);
      await sleep(1200);
      const got = await temuDocLuoi(tab.id);
      if (got.length > soResponse) {
        soResponse = got.length;
        texts = got;
        trang++;
        lanCuoiCoMoi = Date.now();
        items = parseTemuTexts(texts, count);
      }
    }

    return { items, blocked: false, trang, raw: items.length ? undefined : (texts[0] || '').slice(0, 1400) };
  } catch (e) { return { items: [], blocked: false, error: String(e) }; }
}

// Parse giá từ chuỗi hiển thị theo locale của tiền tệ. Tiền KHÔNG có phần lẻ (VND/JPY…) → mọi dấu ./,
// đều là ngăn nghìn → bỏ hết. Tiền CÓ lẻ (USD/EUR…) → dấu ./, CUỐI CÙNG là thập phân, còn lại ngăn nghìn.
function rsParsePrice(str, cur) {
  let s = String(str || '').replace(/[^0-9.,]/g, '');
  if (!s) return null;
  if (/VND|JPY|KRW|IDR|CLP|HUF|TWD|COP/i.test(cur || '')) return parseInt(s.replace(/[.,]/g, ''), 10) || null;
  const lastSep = Math.max(s.lastIndexOf('.'), s.lastIndexOf(','));
  if (lastSep === -1) return parseInt(s, 10) || null;
  const intPart = s.slice(0, lastSep).replace(/[.,]/g, '');
  const decPart = s.slice(lastSep + 1).replace(/[.,]/g, '');
  return parseFloat(intPart + '.' + decPart) || null;
}

// GỘP MỌI TRANG, KHỬ TRÙNG THEO goods_id. Bản cũ dừng ngay sau response đầu tiên có hàng
// (`if (out.length) break`) — hợp lý khi chỉ có một trang, vì mỗi response bị HAI hook cùng chộp
// (`__rsTemuCap` và `__rsCap` của page-hook), không dừng thì đếm đôi. Nhưng như vậy trang hai trở
// đi không bao giờ được đọc, và Temu chỉ trả ~40 SP một trang: chọn 60 SP vẫn ra 40 (đo 15/09/2026).
// Khử trùng theo id giải quyết cả hai: bản chộp đôi bị bỏ, trang mới được cộng dồn.
function parseTemuTexts(texts, count) {
  const out = [];
  const seen = new Set();
  const looks = (o) => o && typeof o === 'object' && o.title && (o.price_info || o.priceInfo);
  for (const text of texts) {
    let j; try { j = JSON.parse(text); } catch (e) { continue; }
    // Đường dẫn thật: result.data.goods_list[]; fallback deep-find nếu Temu đổi cấu trúc.
    let arr = (((j.result || {}).data || {}).goods_list) || ((j.data || {}).goods_list) || null;
    if (!Array.isArray(arr) || !arr.length) arr = rsDeepFindArray(j, looks);
    for (const it of arr) {
      const id = String(it.goods_id || it.goodsId || it.productId || it.id || '');
      if (!id || seen.has(id)) continue;
      seen.add(id);
      const name = String(it.title || '').trim();
      const pi = it.price_info || it.priceInfo || {};
      // Giá theo TIỀN TỆ: "₫302.510" (VN . = ngăn nghìn) vs "$12.99" (US . = thập phân) → parse khác nhau.
      let price = rsParsePrice(pi.price_str || pi.priceStr, pi.currency);
      if (price == null && typeof pi.price === 'number') price = pi.price;
      let img = it.thumb_url || (it.image && (it.image.url || it.image)) || it.thumbUrl || '';
      if (img && img.indexOf('//') === 0) img = 'https:' + img;
      // sales_num "11K+" = tổng đã bán (Temu không tách theo tháng).
      const soldRaw = String(it.sales_num || it.salesNum || it.sales_tip || '');
      let sold = parseFloat(soldRaw.replace(/[^0-9.]/g, '')) || null;
      if (sold && /K/i.test(soldRaw)) sold = Math.round(sold * 1000);
      else if (sold && /M/i.test(soldRaw)) sold = Math.round(sold * 1000000);
      const cm = it.comment || {};
      const rr = cm.goods_score || cm.goodsScore;
      const rating = rr ? parseFloat(rr) || null : null;
      // Video sản phẩm có sẵn trong response Temu (field `video.video_url`) — rỗng nếu SP không có video.
      let videoUrl = (it.video && (it.video.video_url || it.video.url)) || '';
      if (videoUrl && videoUrl.indexOf('//') === 0) videoUrl = 'https:' + videoUrl;
      out.push({ id, name, price, image: img, sold, rating, currency: pi.currency || '', videoUrl });
      if (out.length >= count) return out;
    }
  }
  return out;
}

// ===== TEMU search suggest: NHIỀU cụm trong MỘT job (nguồn từ khoá cho tab Keyword) =====
//
// Vì sao Temu phải đi đường này trong khi bảy nguồn từ khoá kia gọi HTTP thẳng từ backend: đo
// lại 2026-09-03 từ VPS, `/api/poppy/v1/search_suggest` trả 500 với GET và 403 với POST, còn
// trang chủ trả JS chống bot chứ không phải HTML. Thiếu là chữ ký `anti-content` do JS của
// chính trang sinh runtime. Nên vẫn là lối "ký sinh" quen thuộc: gõ vào ô tìm kiếm, để TRANG
// tự gọi API, `page-hook.js` chộp response.
//
// KHÔNG PHẢI SỬA page-hook.js: needle `/api/poppy/v1/search` của nó khớp luôn `search_suggest`
// vì đó là so khớp chuỗi con.
//
// GỘP NHIỀU CỤM VÀO MỘT JOB là điểm khác biệt lớn nhất so với các job crawl. Bộ mở rộng từ
// khoá hỏi mỗi nguồn 12–45 lượt (`DEPTH_CALLS` ở backend). Nếu mỗi lượt là một job riêng thì
// mỗi lượt phải mở lại tab, có thể chiếm worker 3,6–13 phút vì worker xử lý tuần tự. Gộp lại:
// mở tab một lần, gõ
// lần lượt, cả lượt tốn khoảng 40 giây.
//
// KHÔNG BẤM ENTER, khác `searchTemu`: gợi ý bung ra khi ĐANG gõ. Bấm Enter là điều hướng sang
// trang kết quả, vừa mất lớp gợi ý vừa tốn một lượt tải trang cho mỗi cụm.
const temuSuggestTab = () => keptTab('temuSuggest');

//: Số cụm tối đa nhận trong một job. Trùng với trần phía backend (`MAX_TERMS` ở
//: `lib/keywords/providers/temu.py`); chốt ở cả hai đầu để một payload méo không biến thành
//: một lượt chiếm máy-thợ mười phút.
const TEMU_SUGGEST_MAX_TERMS = 4;   // khớp `MAX_TERMS` ở lib/keywords/providers/temu.py

// Đọc gợi ý ra khỏi JSON của Temu mà KHÔNG chốt cứng cấu trúc.
//
// Hình dạng `search_suggest` chưa được xác nhận và Temu đổi nó bất cứ lúc nào. Duyệt cây tìm
// những khoá NGHE NHƯ từ khoá còn bền hơn là bám vào một đường dẫn cụ thể — sai lầm ấy hỏng
// lặng lẽ (trả mảng rỗng, trông như "sàn không có gợi ý") thay vì hỏng ồn ào.
/**
 * Bóc gợi ý ra khỏi response search_suggest của Temu.
 *
 * `typed` là cụm ta vừa gõ, và nó bị LOẠI khỏi kết quả. Không phải để cho gọn: Temu trả lại
 * chính truy vấn trong payload, mà hàm này nhặt mọi chuỗi nằm dưới các khoá kiểu `query`/
 * `keyword` nên nhặt luôn nó. Hậu quả có hai tầng, tầng sau nặng hơn tầng trước:
 *
 *   1. Khi Temu không có gợi ý thật, tiếng vọng là thứ duy nhất về — bảng kết quả đầy những
 *      chuỗi do CHÍNH TA bịa ra để dò ("headphone c", "headphone d"). Không ai tìm chúng.
 *   2. Vòng chờ bên dưới thoát ngay khi `suggestions.length` khác 0. Tiếng vọng về gần như
 *      tức thì, nên nó cắt vòng chờ TRƯỚC khi gợi ý thật kịp tới — tức nó không chỉ thêm rác
 *      mà còn làm mất dữ liệu thật.
 */
function parseTemuSuggest(text, typed) {
  const out = [];
  const seen = new Set();
  const echo = String(typed || '').toLowerCase().split(/\s+/).filter(Boolean).join(' ');
  const norm = (x) => String(x || '').toLowerCase().split(/\s+/).filter(Boolean).join(' ');
  const take = (v) => {
    const t = String(v || '').trim();
    if (t.length < 2 || t.length > 60 || /[\n\r]/.test(t) || /^https?:/i.test(t)) return;
    const k = t.toLowerCase();
    if (echo && norm(t) === echo) return;
    if (!seen.has(k)) { seen.add(k); out.push(t); }
  };

  // ĐƯỜNG DẪN THẬT TRƯỚC. Đo 07/09/2026, payload `search_suggest` có dạng
  //   result.data.slice_words[] → { p_search: { query }, text | word }
  // Bộ duyệt cây tổng quát bên dưới nhặt được cả nhãn tĩnh của trang ("Explore your
  // interests") và trả nó ra như một từ khoá — đúng một chuỗi cho cả bốn cụm. Đọc thẳng chỗ
  // gợi ý thật thì không dính; bộ duyệt vẫn giữ làm lưới hứng khi Temu đổi cấu trúc.
  //
  // GỢI Ý THẬT NẰM Ở `recommend_words`, KHÔNG PHẢI `slice_words`. Đo 13/09/2026 trên Temu Vietnam,
  // gõ "t shirt": `slice_words` chỉ có đúng chuỗi "t shirt" (cách Temu cắt chính truy vấn), còn
  // `recommend_words[].recommend` = "t shirts for women", "t shirt for men"… — khớp từng dòng với
  // khung gợi ý người dùng thấy khi gõ tay. Bản cũ đọc `slice_words`, thấy có chữ là `return`
  // luôn, nên không bao giờ tới `recommend_words`; backend lọc mảnh đi rồi còn 0–1 gợi ý.
  try {
    const j = JSON.parse(text);
    const data = (j && j.result && j.result.data) || {};
    for (const w of (data.recommend_words || [])) {
      if (!w || typeof w !== 'object') continue;
      take(w.recommend || w.shade_word || w.query || w.word || w.text);
    }
    if (out.length) return out;
    for (const w of (data.slice_words || [])) {
      if (!w || typeof w !== 'object') continue;
      take(w.slice_word || w.query || w.word || w.text || (w.p_search && w.p_search.query));
    }
  } catch (e) { /* rơi về bộ duyệt cây */ }
  if (out.length) return out;
  const KEYS = /^(query|text|keyword|word|suggest_word|suggestWord|name|title|search_key|searchKey)$/i;
  let data;
  try { data = JSON.parse(text); } catch (e) { return out; }
  const walk = (node, depth) => {
    if (!node || depth > 8 || out.length >= 40) return;
    if (Array.isArray(node)) { for (const v of node) walk(v, depth + 1); return; }
    if (typeof node !== 'object') return;
    for (const k of Object.keys(node)) {
      const v = node[k];
      if (typeof v === 'string' && KEYS.test(k)) {
        const s = v.trim();
        // 2..60 ký tự: dưới 2 là nhiễu, trên 60 gần như luôn là tiêu đề sản phẩm chứ không
        // phải cụm tìm kiếm. Bỏ chuỗi có ký tự xuống dòng hoặc trông như URL.
        if (s.length >= 2 && s.length <= 60 && !/[\n\r]/.test(s) && !/^https?:/i.test(s)) {
          const key = s.toLowerCase();
          if (echo && key.split(/\s+/).filter(Boolean).join(' ') === echo) continue;
          if (!seen.has(key)) { seen.add(key); out.push(s); }
        }
      } else if (v && typeof v === 'object') {
        walk(v, depth + 1);
      }
    }
  };
  walk(data, 0);
  return out;
}

// Chạy `p`, nhưng KHÔNG bao giờ chờ quá `ms`. Trả `fallback` nếu quá hạn.
//
// `chrome.scripting.executeScript` và `chrome.tabs.update` KHÔNG có hạn giờ riêng, và đó là
// một cái bẫy có thật chứ không phải lo xa: đo 2026-09-04, job gợi ý Temu chạy quá 90 giây
// dù đã đặt ngân sách 70 giây cho cả job — vì ngân sách chỉ được KIỂM giữa các bước, mà lời
// gọi đang treo thì không bao giờ trả về để tới được chỗ kiểm. Trang Temu điều hướng sang màn
// "Security verification" ngay giữa lúc ta bơm script là dựng đúng tình huống ấy.
//
// Bọc từng lời gọi mới chặn được, chứ đặt thêm một hạn nữa ở ngoài thì cũng nằm sau nó.
function withTimeout(p, ms, fallback) {
  return Promise.race([
    Promise.resolve(p).catch(() => fallback),
    new Promise((resolve) => setTimeout(() => resolve(fallback), ms)),
  ]);
}

/**
 * GIỮ NHỊP CHO SERVICE WORKER trong suốt một job dài.
 *
 * MV3 kết liễu service worker sau khoảng 30 giây "rảnh", và "rảnh" tính theo lời gọi API
 * `chrome.*`, không theo việc mã của ta có đang chạy hay không. Mọi job dài ở đây đều có những
 * quãng chỉ ngồi chờ trang tải hoặc chờ cuộn — TikTok và Douyin đặt ngân sách 120 giây, thừa sức
 * rơi vào khe đó.
 *
 * Bị giết giữa chừng là kiểu hỏng TỆ NHẤT trong cả đường đi này: `sendResponse` biến mất cùng
 * service worker, nên trang `/worker` không nhận được trả lời, backend chỉ thấy "hết giờ", và
 * cửa sổ video hiện "Không có video" — không phân biệt được với việc thật sự không có video nào.
 *
 * Gọi một API `chrome.*` rẻ tiền mỗi 20 giây là cách chính thống để đặt lại đồng hồ ấy. `finally`
 * là bắt buộc: bỏ sót thì mỗi job để lại một nhịp chạy mãi và service worker không bao giờ ngủ.
 */
function withHeartbeat(p) {
  const beat = setInterval(() => { try { chrome.runtime.getPlatformInfo(() => {}); } catch (e) {} }, 20000);
  return Promise.resolve(p).finally(() => clearInterval(beat));
}

// Bơm một hàm vào tab, có hạn giờ. Trả `null` nếu quá hạn hoặc lỗi.
async function evalInTab(tabId, func, args, ms = 4000) {
  const out = await withTimeout(
    chrome.scripting.executeScript({ target: { tabId }, world: 'MAIN', args: args || [], func }),
    ms,
    null,
  );
  return (out && out[0] && out[0].result) || null;
}

async function temuSuggestBatch(terms, region) {
  const list = (Array.isArray(terms) ? terms : []).map((t) => String(t || '').trim())
    .filter(Boolean).slice(0, TEMU_SUGGEST_MAX_TERMS);
  if (!list.length) return { groups: [], blocked: false, error: 'không có cụm từ nào' };

  const JOB_BUDGET_MS = 150000;  // thêm vòng mở trang kết quả cho mỗi cụm
  const PER_TERM_MS = 4000;
  const jobDeadline = Date.now() + JOB_BUDGET_MS;

  // `stage` là thứ trả lời được câu "nó kẹt ở đâu" — cập nhật trước MỖI bước có thể treo.
  // Không có nó thì một lần quá hạn chỉ nói được "quá hạn", và đó là chỗ đã tốn hai vòng đoán.
  const debug = { stage: 'bắt đầu', inputFound: null, pickedInput: '', listbox: null, relatedTried: '', capUrls: [], sample: '', terms: list.length, ranTerms: 0 };
  const groups = [];

  try {
    debug.stage = 'mở tab';
    const tab = await withTimeout(temuSuggestTab(), 8000, null);
    if (!tab) return { groups, blocked: true, debug, error: 'không mở được tab Temu' };

    debug.stage = 'điều hướng temu.com';
    await withTimeout(chrome.tabs.update(tab.id, { url: 'https://www.temu.com/' }), 8000, null);
    await withTimeout(focusTab(tab.id), 4000, null); // SPA nặng — tab nền bị Chrome tiết chế

    debug.stage = 'chờ trang tải';
    await waitForComplete(tab.id, 12000); // hàm này vốn đã tự hết giờ
    await sleep(2000); // để React mount xong ô search

    let sawLogin = false;

    for (const term of list) {
      if (Date.now() > jobDeadline) { debug.stage = 'hết ngân sách'; break; }
      debug.ranTerms++;
      debug.stage = `gõ cụm ${debug.ranTerms}/${list.length}`;

      // ĐƯA TAB RA TRƯỚC LẠI Ở MỖI CỤM. `focusTab` cũ chỉ chạy một lần trước vòng lặp; bốn
      // lượt gõ sau đó hoàn toàn có thể diễn ra khi cửa sổ đã mất focus (job khác chiếm tab,
      // hoặc người dùng bấm sang việc khác). Lớp gợi ý của Temu không dựng khi
      // `document.hasFocus()` là false — mọi sự kiện vẫn bắn đúng, chỉ là không có gì hiện ra,
      // và triệu chứng giống hệt "Temu không có gợi ý".
      await withTimeout(focusTab(tab.id), 3000, null);

      // Xoá giỏ đã chộp TRƯỚC mỗi cụm, để gợi ý cụm này không lẫn của cụm trước.
      await evalInTab(tab.id, () => { try { window.__rsCap = []; } catch (e) {} }, [], 3000);

      // Gõ bằng native setter (React bỏ qua gán .value trực tiếp).
      const typedInfo = await evalInTab(tab.id, (kw) => {
        // PHẢI LÀ Ô ĐANG NHÌN THẤY. Temu có nhiều `input` ẩn (form đăng nhập, bộ lọc); gõ vào
        // một ô ẩn thì mọi sự kiện đều bắn đúng mà lớp gợi ý không bao giờ mở, và triệu chứng
        // giống hệt "Temu không có gợi ý".
        const visible = (e) => e && e.offsetParent !== null && e.getClientRects().length > 0;
        const cands = [...document.querySelectorAll('input')].filter(visible);
        const inp = cands.find((e) => e.type === 'search')
          || cands.find((e) => e.getAttribute('role') === 'searchbox')
          || cands.find((e) => /search|tìm/i.test((e.placeholder || '') + (e.getAttribute('aria-label') || '')))
          || cands[0];
        if (!inp) return { ok: false, inputs: document.querySelectorAll('input').length,
                           visibleInputs: cands.length, href: location.href };
        // GÕ TỪNG KÝ TỰ, không nhét cả cụm một lần. Lớp gợi ý của Temu chỉ dựng khi ô nhập
        // nhận đúng chuỗi sự kiện của một người đang gõ: bấm → focus → mỗi ký tự một
        // `InputEvent` có `inputType: 'insertText'`. Nhét thẳng `.value` rồi bắn một `Event`
        // trần thì React cập nhật state nhưng phần gợi ý không chạy — và triệu chứng là
        // "trang có gọi suggest, DOM không có gì", đúng thứ đã làm tôi kết luận nhầm rằng
        // Temu không có gợi ý.
        // `execCommand('insertText')` TRƯỚC, gán `.value` chỉ là đường lui.
        //
        // Sự kiện do script tự dựng mang `isTrusted: false`, và Temu bỏ qua chúng — đo được:
        // gõ đúng ô, trang có focus và đang hiện, gõ từng ký tự bằng `InputEvent` chuẩn, mà
        // lớp gợi ý vẫn không dựng. `execCommand` thì khác: nó đi qua đúng đường soạn thảo của
        // trình duyệt, nên `input` event sinh ra là event thật do trình duyệt phát.
        const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set;
        inp.click();
        inp.focus();
        inp.select && inp.select();
        let usedExec = false;
        try {
          usedExec = document.execCommand('insertText', false, kw);
        } catch (e) { usedExec = false; }
        if (!usedExec || inp.value !== kw) {
          setter.call(inp, '');
          inp.dispatchEvent(new InputEvent('input', { bubbles: true, inputType: 'deleteContentBackward' }));
          for (let i = 0; i < kw.length; i++) {
            const ch = kw[i];
            inp.dispatchEvent(new KeyboardEvent('keydown', { key: ch, bubbles: true }));
            setter.call(inp, kw.slice(0, i + 1));
            inp.dispatchEvent(new InputEvent('input', { bubbles: true, inputType: 'insertText', data: ch }));
            inp.dispatchEvent(new KeyboardEvent('keyup', { key: ch, bubbles: true }));
          }
        }
        return {
          ok: true,
          inputs: document.querySelectorAll('input').length,
          visibleInputs: cands.length,
          // Ô nào đã được gõ, và sau khi gõ trang có dựng ra lớp gợi ý nào không — hai câu
          // trả lời cần thiết để lần sau không phải đoán tiếp.
          pickedInput: (inp.type || '') + '|' + (inp.placeholder || inp.getAttribute('aria-label') || '(không nhãn)').slice(0, 40),
          typedBy: usedExec ? 'execCommand' : 'gán .value',
          listbox: document.querySelectorAll('[role="listbox"], [role="option"], [aria-expanded="true"]').length,
          // Hai câu trả lời cuối cùng còn thiếu: trang có đang được focus không, và nó có
          // đang hiện không. Cả hai đều là điều kiện để một lớp gợi ý chịu dựng ra.
          hasFocus: document.hasFocus(),
          visible: document.visibilityState,
          href: location.href,
        };
      }, [term], 5000);

      if (debug.inputFound === null) {
        debug.inputFound = typedInfo === null
          ? 'bơm script vào trang bị treo/quá hạn'
          : typedInfo.ok ? true : `không thấy ô search (có ${typedInfo.inputs} input, ${typedInfo.visibleInputs} cái nhìn thấy được, đang ở ${String(typedInfo.href).slice(0, 60)})`;
      }
      if (typedInfo && typedInfo.ok && !debug.pickedInput) {
        debug.pickedInput = typedInfo.pickedInput;
        debug.listbox = typedInfo.listbox;
        debug.hasFocus = typedInfo.hasFocus;
        debug.typedBy = typedInfo.typedBy;
        debug.visible = typedInfo.visible;
      }
      if (!typedInfo || !typedInfo.ok) { groups.push({ term, suggestions: [] }); continue; }

      const suggestions = [];
      const termDeadline = Math.min(Date.now() + PER_TERM_MS, jobDeadline);
      while (Date.now() < termDeadline) {
        await sleep(500);
        const r = await evalInTab(tab.id, (kw) => {
          // ĐỌC LỚP GỢI Ý ĐANG HIỆN TRÊN MÀN HÌNH, không chỉ đọc JSON của mạng.
          //
          // Đo 07/09/2026: `search_suggest` chỉ trả `slice_words` — cách Temu cắt câu truy vấn
          // thành từ — nên bóc từ JSON ra toàn mảnh của chính truy vấn. Nhưng lớp gợi ý VẪN
          // hiện ra dưới ô tìm kiếm; nó được dựng từ nguồn khác. Cái mắt người nhìn thấy mới
          // là cái cần lấy.
          //
          // Nhận diện KHÔNG dựa vào tên lớp CSS của Temu (đổi bất cứ lúc nào) mà dựa vào một
          // tính chất của chính gợi ý: nó CHỨA cụm vừa gõ, dài 2–60 ký tự, và là nút lá (không
          // có phần tử con mang chữ). Ba điều đó đủ để tách gợi ý khỏi mọi chữ khác trên trang.
          const norm = (x) => String(x || '').toLowerCase().replace(/\s+/g, ' ').trim();
          const want = norm(kw);
          const dom = [];
          const seen = {};
          // ĐỌC CẢ TRANG, nhưng lọc bằng "BẮT ĐẦU BẰNG cụm vừa gõ".
          //
          // Khoanh vùng quanh ô nhập là sai: lớp gợi ý của SPA thường được portal thẳng ra
          // `body`, nằm ngoài cây con của ô nhập. Còn quét cả trang mà chỉ đòi "chứa cụm" thì
          // nhãn thẻ sản phẩm lọt vào ("#2 best-selling item in men s t-shirts").
          //
          // Phép lọc đúng nằm ở bản chất của autocomplete: gợi ý là phần NỐI DÀI của cụm đang
          // gõ, nên nó BẮT ĐẦU bằng cụm đó — "jeans" → "jeans for men", "jeans baggy",
          // "jeans y2k". Nhãn merchandising thì không bao giờ bắt đầu như vậy.
          const pick = (root, test) => {
            const all = root.querySelectorAll('li, [role="option"], a, span, div');
            for (let i = 0; i < all.length && dom.length < 40; i++) {
              const el = all[i];
              if (el.children && el.children.length) continue;      // chỉ lấy nút lá
              const t = (el.textContent || '').trim();
              if (t.length < 2 || t.length > 60) continue;
              const n = norm(t);
              if (n === want || !test(n)) continue;
              if (seen[n]) continue;
              seen[n] = 1;
              dom.push(t);
            }
          };
          // CHỈ MỘT LƯỚI: gợi ý phải BẮT ĐẦU bằng cụm vừa gõ. Lưới thưa "chỉ cần chứa" từng
          // được giữ làm dự phòng và nó chỉ vớt ra nhãn thẻ sản phẩm — "most repurchased in
          // men s jeans", "#2 best-selling item in men s t-shirts". Rác trông như kết quả
          // thì tệ hơn hẳn một bảng rỗng, vì nó che mất chuyện lớp gợi ý chưa hề mở.
          if (want) pick(document, (n) => n.indexOf(want) === 0);
          return {
            dom,
            domScope: 'toàn trang, lọc theo tiền tố',
            // TẤT CẢ url đã chộp, không chỉ search_suggest: khi không ra gợi ý, câu hỏi đầu
            // tiên là "trang có gọi suggest không, hay ta chộp nhầm endpoint".
            all: (window.__rsCap || []).map((c) => c.url),
            hit: (window.__rsCap || []).filter((c) => /search_suggest/i.test(c.url)).map((c) => c.text),
            href: location.href,
          };
        }, [term], 3000);
        if (!r) continue;
        if (r.domScope && !debug.domScope) debug.domScope = r.domScope;
        for (const u of r.all || []) if (!debug.capUrls.includes(u)) debug.capUrls.push(u);
        if (/login\.html/.test(r.href)) { sawLogin = true; break; }
        // DOM trước, JSON sau: DOM là thứ người dùng thật sự nhìn thấy.
        for (const s of r.dom || []) if (!suggestions.includes(s)) suggestions.push(s);
        for (const text of r.hit) {
          if (!debug.sample) debug.sample = String(text).slice(0, 4000);
          for (const s of parseTemuSuggest(text, term)) {
            if (!suggestions.includes(s)) suggestions.push(s);
          }
        }
        if (suggestions.length) break;
      }
      // LỌC TRƯỚC KHI ĐẾM. Đường JSON (`parseTemuSuggest`) vẫn nhặt được các MẢNH của truy
      // vấn từ `slice_words` — "jean", "petite", "best". Chúng làm `suggestions.length` khác 0
      // nên nhánh trang-kết-quả bên dưới không bao giờ chạy: một đường dự phòng bị chính rác
      // của đường chính khoá lại. Chỉ giữ thứ BẮT ĐẦU bằng cụm vừa gõ — đúng phép lọc đã
      // dùng cho DOM, và đúng hình dạng của một gợi ý thật.
      {
        const w = String(term || '').toLowerCase().replace(/\s+/g, ' ').trim();
        for (let i = suggestions.length - 1; i >= 0; i--) {
          const n = String(suggestions[i]).toLowerCase().replace(/\s+/g, ' ').trim();
          if (n === w || n.indexOf(w) !== 0) suggestions.splice(i, 1);
        }
      }

      // ĐƯỜNG HAI: TRANG KẾT QUẢ, KHÔNG GÕ GÌ CẢ.
      //
      // Lớp gợi ý không chịu dựng dù mọi điều kiện đã đúng — đo được: gõ đúng ô search, trang
      // `hasFocus=true` và `visible`, gõ từng ký tự bằng `InputEvent` chuẩn, mà số phần tử
      // option vẫn là 1. Nguyên nhân còn lại duy nhất là Temu bỏ qua sự kiện bàn phím GIẢ
      // (`isTrusted: false`), và content script thì không tạo được sự kiện thật.
      //
      // Trang kết quả không cần gõ: điều hướng thẳng tới URL tìm kiếm rồi đọc khối "related
      // searches" mà Temu tự dựng. Cùng loại dữ liệu — những cụm người ta thật sự tìm — và
      // lấy được bằng đúng thứ ta điều khiển được là thanh địa chỉ.
      if (!suggestions.length) {
        await chrome.tabs.update(tab.id, {
          url: 'https://www.temu.com/search_result.html?search_key=' + encodeURIComponent(term),
        });
        await waitForComplete(tab.id, 12000);
        await sleep(2500);
        const rel = await evalInTab(tab.id, (kw) => {
          const norm = (x) => String(x || '').toLowerCase().replace(/\s+/g, ' ').trim();
          const want = norm(kw);
          const out = [];
          const seen = {};
          const all = document.querySelectorAll('a, li, span, div');
          for (let i = 0; i < all.length && out.length < 30; i++) {
            const el = all[i];
            if (el.children && el.children.length) continue;
            const t = (el.textContent || '').trim();
            if (t.length < 2 || t.length > 60) continue;
            const n = norm(t);
            // Cùng phép lọc của lớp gợi ý: cụm liên quan là phần NỐI DÀI của từ đang tìm.
            if (n === want || n.indexOf(want) !== 0) continue;
            if (seen[n]) continue;
            seen[n] = 1;
            out.push(t);
          }
          return { out, href: location.href };
        }, [term], 6000);
        for (const x of ((rel && rel.out) || [])) if (!suggestions.includes(x)) suggestions.push(x);
        if (!debug.relatedTried) debug.relatedTried = (rel && rel.href) ? String(rel.href).slice(0, 80) : 'không mở được';
        // Về lại trang chủ cho cụm kế tiếp.
        await chrome.tabs.update(tab.id, { url: 'https://www.temu.com/' });
        await waitForComplete(tab.id, 10000);
        await sleep(1200);
      }

      groups.push({ term, suggestions });
      if (sawLogin) break;
      await sleep(300); // giãn nhịp giữa hai lượt gõ, cho giống người thật
    }

    // Giữ chẩn đoán gọn — nó đi qua relay rồi hiện lên giao diện, không phải một bãi log.
    debug.capUrls = debug.capUrls.slice(0, 8).map((u) => String(u).slice(0, 120));

    const total = groups.reduce((n, g) => n + g.suggestions.length, 0);
    if (sawLogin) {
      await withTimeout(focusTab(tab.id), 3000, null);
      return { groups, blocked: true, debug, error: 'Temu đòi đăng nhập — đã mở tab, đăng nhập xong rồi thử lại' };
    }
    if (!total) {
      const why = debug.inputFound !== true
        ? `không gõ được vào ô tìm kiếm (${debug.inputFound})`
        : debug.capUrls.length
          ? `trang có gọi ${debug.capUrls.length} endpoint nhưng không cái nào là search_suggest`
          : 'trang không gọi endpoint nào sau khi gõ';
      return { groups, blocked: true, debug, error: `Temu không trả gợi ý nào — ${why}` };
    }
    return { groups, blocked: false, debug };
  } catch (e) {
    return { groups, blocked: false, debug, error: `lỗi ở bước "${debug.stage}": ${e}` };
  }
}

// ===== TikTok organic: keyword → list VIDEO (Cách A, auto-scroll + chộp API) =====
// TikTok search bắn API đã ký (X-Bogus/msToken) do JS trang tự sinh — không reimplement được.
// Nên: điều hướng tới /search/video, để page-hook (document_start) chộp response, rồi TỰ CUỘN
// nhanh nhiều lần ép trang bắn tiếp các trang sau (infinite scroll) → gom HẾT, không bắt user cuộn.
// Đây là cách khắc phục "phải kéo mới ra video": tool cuộn thay, và gom mọi trang một lượt.
const tiktokTab = () => keptTab('tiktok');

// ===== TikTok Creative Center: filter country THẬT (không bám IP user) =====
// Creative Center là công cụ duy nhất của TikTok cho phép query "top ads theo country" — endpoint
// `/api/*?biz_id=cc` gộp query dạng batch. V1 KHÔNG reimplement sign — mở tab thật, để trang tự sinh
// request, hook fetch để capture batch response + scrape DOM cards. Trả cả `raw` (2KB đầu response
// batch) để lần chạy đầu thấy được shape thật và refine parser vòng sau.
const tkccTab = () => keptTab('tkcc');

// Endpoint URL Creative Center: query string đã gồm region + period; industry (nếu có) truyền tay
// vào state URL — Creative Center đọc từ URL hash / query khi mount.
function tkccUrl(region, period) {
  const r = String(region || 'VN').toUpperCase();
  const p = String(period || 30);
  return `https://ads.tiktok.com/business/creativecenter/inspiration/topads/pc/en?region=${encodeURIComponent(r)}&period=${p}&sort_by=for_you`;
}

async function searchTiktokCreative(region, keyword, count) {
  try {
    const tab = await tkccTab();
    const target = Math.min(60, Math.max(12, count || 24));
    const kw = String(keyword || '').trim();

    // ---------------------------------------------------------------------------
    // VÌ SAO CHỘP CHỨ KHÔNG TỰ GỌI. Đo 2026-08-24.
    //
    // API thật là `/creative_radar_api/v1/top_ads/v2/list`, và NÓ CÓ tham số `keyword` —
    // gõ vào ô "Search by brand or product keywords" thì trang gửi đúng tham số ấy và trả
    // 19/33 kết quả cho "kem chống nắng". Nhưng request được KÝ: ngoài cookie còn bốn header
    // `anonymous-user-id`, `timestamp`, `lang` và `user-sign`, và chữ ký phủ cả query string.
    //
    //     header chộp được + URL GỐC          → 19 mục, code 0, OK
    //     header chộp được + thêm `&keyword=` → 0 mục, VẪN HTTP 200, VẪN msg "OK"
    //
    // Tức là sai chữ ký thì server trả rỗng chứ không báo lỗi — đúng kiểu chặn mềm mà cả repo
    // này viết ghi chú để chống. Nên không tự dựng request, mà để trang tự gọi rồi chộp lấy,
    // y như cách `lib/ads/platforms/facebook.py` mượn lại truy vấn GraphQL đã ký.
    //
    // BẢN CŨ HỎNG Ở ĐÂU, để không ai làm lại: nó (1) bóc DOM bằng selector đoán —
    // `a[href*="/topads/detail/"]` khớp ĐÚNG 0 phần tử trên trang thật; (2) móc `window.fetch`,
    // trong khi trang gọi bằng XMLHttpRequest nên không bắt được gì; (3) không hề gửi từ khoá
    // đi đâu cả, chỉ mở danh sách Top Ads của cả nước rồi lọc chuỗi con phía client.
    // ---------------------------------------------------------------------------
    const HOOK = () => {
      if (window.__rsCc) return;
      window.__rsCc = [];
      const nhan = (u, j) => { try { if (String(u).indexOf('/top_ads/v2/list') >= 0) window.__rsCc.push(j); } catch (e) {} };
      const of = window.fetch;
      window.fetch = function () {
        const u = typeof arguments[0] === 'string' ? arguments[0] : (arguments[0] && arguments[0].url) || '';
        const p = of.apply(this, arguments);
        if (String(u).indexOf('/top_ads/v2/list') >= 0) {
          p.then((r) => r.clone().json().then((j) => nhan(u, j)).catch(() => {})).catch(() => {});
        }
        return p;
      };
      // Trang thật dùng ĐƯỜNG NÀY. Thiếu nó thì móc trên không bắt được gì — lỗi của bản cũ.
      const oo = XMLHttpRequest.prototype.open, os = XMLHttpRequest.prototype.send;
      XMLHttpRequest.prototype.open = function (m, u) { this.__rsU = u; return oo.apply(this, arguments); };
      XMLHttpRequest.prototype.send = function () {
        if (this.__rsU && String(this.__rsU).indexOf('/top_ads/v2/list') >= 0) {
          this.addEventListener('load', () => { try { nhan(this.__rsU, JSON.parse(this.responseText)); } catch (e) {} });
        }
        return os.apply(this, arguments);
      };
    };

    await chrome.tabs.update(tab.id, { url: tkccUrl(region, 30) });
    await waitForComplete(tab.id, 20000);
    // Cài móc rồi TẢI LẠI: lượt gọi danh sách xảy ra ngay lúc trang dựng, cài sau là lỡ nhịp.
    await chrome.scripting.executeScript({ target: { tabId: tab.id }, world: 'MAIN', func: HOOK });
    await chrome.tabs.reload(tab.id);
    await waitForComplete(tab.id, 20000);
    await chrome.scripting.executeScript({ target: { tabId: tab.id }, world: 'MAIN', func: HOOK });

    // Chờ trang gọi xong. Bỏ luôn lớp phủ quảng cáo để nó không nuốt thao tác về sau.
    let materials = [];
    const deadline = Date.now() + 25000;
    while (Date.now() < deadline) {
      await sleep(1200);
      const out = await chrome.scripting.executeScript({
        target: { tabId: tab.id }, world: 'MAIN',
        func: () => {
          document.querySelectorAll('[class*="RevampPopup"], .byted-modal, .byted-modal-mask').forEach((e) => e.remove());
          const gom = [];
          for (const j of (window.__rsCc || [])) for (const m of ((j && j.data && j.data.materials) || [])) gom.push(m);
          return gom;
        },
      });
      materials = (out && out[0] && out[0].result) || [];
      if (materials.length) break;
    }

    if (!materials.length) {
      return { items: [], blocked: true, error: 'Creative Center không trả về danh sách nào — mở tab đó xem có đòi đăng nhập hay xác minh không.' };
    }

    const items = materials.map((m) => {
      const v = m.video_info || {};
      const urls = v.video_url || {};
      // Khoá là '720p', '480p'… lấy bản nét nhất.
      const key = Object.keys(urls).sort((a, b) => parseInt(b) - parseInt(a))[0];
      const so = (n) => (typeof n === 'number' ? n.toLocaleString('vi-VN') : null);
      return {
        id: String(m.id),
        brand: m.brand_name || '',
        body: m.ad_title || '',
        metrics: [
          typeof m.ctr === 'number' && m.ctr > 0 ? `CTR ${m.ctr}%` : null,
          m.like ? `${so(m.like)} thích` : null,
          v.duration ? `${Math.round(v.duration)} giây` : null,
        ].filter(Boolean).join(' · '),
        image: v.cover || '',
        videoUrl: key ? urls[key] : '',
        // Dạng link lấy từ chính thẻ <a> của trang, không suy ra.
        permalink: `https://ads.tiktok.com/business/creativecenter/topads/${m.id}`,
        platform: 'TikTok Creative Center',
      };
    });

    // LỌC PHÍA MÌNH, và nói thẳng đây là lọc phía mình.
    //
    // Không gửi từ khoá lên server được (xem khối ghi chú ở trên), nên tất cả những gì có là
    // ~20 quảng cáo Top Ads của cả nước. Lọc trên chừng đó thì phần lớn từ khoá sản phẩm cụ
    // thể sẽ ra rỗng — đó là giới hạn thật, không phải lỗi.
    //
    // Trả RỖNG kèm lời giải thích, KHÔNG trả danh sách chưa lọc: đây là cửa sổ "video quảng
    // cáo cho SẢN PHẨM NÀY", nên đổ vào đó 20 quảng cáo ngành khác là nói dối người dùng.
    if (!kw) return { items: items.slice(0, target), blocked: false, error: null, total: items.length };

    const chuan = (s) => String(s || '').toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '');
    const needle = chuan(kw);
    const khop = items.filter((it) => chuan(`${it.brand} ${it.body}`).includes(needle));
    if (khop.length) return { items: khop.slice(0, target), blocked: false, error: null, total: khop.length };

    return {
      items: [], blocked: false,
      error: `Creative Center: không tìm theo từ khoá được từ đây (request có chữ ký), nên chỉ đọc ${items.length} Top Ads của ${region} — không cái nào nhắc tới "${kw}".`,
    };
  } catch (e) {
    return { items: [], blocked: false, error: String(e) };
  }
}

async function tkTypeInSearchBox(tabId, term) {
  try {
    const out = await chrome.scripting.executeScript({
      target: { tabId }, world: 'MAIN', args: [term],
      func: (q) => {
        // Reset bộ đệm response để không nhặt lại cụm cũ.
        try { window.__rsCap = []; } catch (e) {}
        const inp = document.querySelector('input[type="search"]')
          || document.querySelector('[data-e2e="search-user-input"]')
          || document.querySelector('input[placeholder*="Search" i], input[placeholder*="Tìm" i], input[placeholder*="搜索" i]');
        if (!inp) return false;
        const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set;
        setter.call(inp, q);
        inp.dispatchEvent(new Event('input', { bubbles: true }));
        // React đôi khi cần thêm 'change'; thêm cho chắc.
        inp.dispatchEvent(new Event('change', { bubbles: true }));
        // Enter → SPA route sang /search/video?q=... (KHÔNG reload).
        const opts = { bubbles: true, key: 'Enter', code: 'Enter', keyCode: 13, which: 13 };
        inp.dispatchEvent(new KeyboardEvent('keydown', opts));
        inp.dispatchEvent(new KeyboardEvent('keypress', opts));
        inp.dispatchEvent(new KeyboardEvent('keyup', opts));
        // Fallback cuối: nếu có form, submit thẳng.
        try { const f = inp.closest('form'); if (f && typeof f.requestSubmit === 'function') f.requestSubmit(); } catch (e) {}
        return true;
      },
    });
    return !!(out && out[0] && out[0].result);
  } catch (e) { return false; }
}

async function searchTiktokTerm(tab, term, byId, target, budgetMs, mode, anchor, isFirst) {
  if (isFirst) {
    // LẦN ĐẦU: navigate URL đầy đủ (nạp signing JS của TikTok cho các cụm sau xài chung).
    await chrome.tabs.update(tab.id, { url: tkTermUrl(term, mode, anchor) });
    await waitForComplete(tab.id, 16000);
    await sleep(2200); // để trang render danh sách video đầu tiên
  } else {
    // CÁC CỤM SAU: KHÔNG navigate — GÕ vào ô search + Enter, như user tự search. TikTok SPA
    // đổi route ngầm (không reload trang, tab không "nhảy"). Chính là "kiểu search giống sản phẩm".
    const q = String(term).replace(/^#/, '#'); // giữ nguyên; hashtag TikTok search-box hiểu #
    const typed = await tkTypeInSearchBox(tab.id, mode === 'hashtag' && anchor ? `${anchor} ${q}` : q);
    if (!typed) {
      // Không tìm thấy ô search (layout đổi) → hạ về navigate cho cụm này (fallback an toàn).
      await chrome.tabs.update(tab.id, { url: tkTermUrl(term, mode, anchor) });
      await waitForComplete(tab.id, 16000);
    }
    await sleep(1800);
  }

  const deadline = Date.now() + budgetMs;
  let prevN = Object.keys(byId).length, stagnant = 0, iter = 0;
  while (Date.now() < deadline) {
    iter++; // không focus tab định kỳ nữa — focus 1 lần ở đầu là đủ, tránh cảm giác "cứ nhảy lên"
    let r = null;
    try {
      const out = await chrome.scripting.executeScript({
        target: { tabId: tab.id }, world: 'MAIN',
        func: () => {
          // Kích infinite-scroll: cuộn xuống đáy nhiều nấc (kích IntersectionObserver "load thêm").
          const SCOPE = '[data-e2e="search_video-item"]';
          try {
            const h = document.documentElement.scrollHeight;
            window.scrollTo(0, h * 0.7);
            window.scrollTo(0, h);
            window.dispatchEvent(new Event('scroll'));
          } catch (e) {}
          // BÓC từ DOM: mỗi video là thẻ <a href=".../@user/video/id">. CHỈ lấy trong KHỐI KẾT QUẢ
          // SEARCH — bỏ video "Có thể bạn thích"/gợi ý ở cuối trang. Không có marker → lấy hết (fallback).
          const hasScope = !!document.querySelector(SCOPE);
          const links = [];
          document.querySelectorAll('a[href*="/video/"]').forEach((a) => {
            if (hasScope && !a.closest(SCOPE)) return; // ngoài lưới kết quả search → bỏ (rác gợi ý)
            const m = (a.href || '').match(/tiktok\.com\/@([\w.\-]+)\/video\/(\d+)/);
            if (!m) return;
            const img = a.querySelector('img') || (a.closest('div[class]') && a.closest('div[class]').querySelector('img'));
            let name = img ? (img.alt || '') : '';
            if (/^\d+$/.test(name.trim())) name = ''; // alt chỉ là số (id) → không phải mô tả, bỏ
            links.push({ id: m[2], author: m[1], url: 'https://www.tiktok.com/@' + m[1] + '/video/' + m[2], image: img ? (img.src || img.getAttribute('data-src') || '') : '', name: name });
          });
          const cap = (window.__rsCap || []).filter((c) => /api\/search\/(general|item|video)/.test(c.url)).map((c) => c.text);
          return { links, cap, href: location.href, body: document.body ? document.body.innerText.slice(0, 400) : '' };
        },
      });
      r = out && out[0] && out[0].result;
    } catch (e) { /* trang chưa sẵn sàng */ }
    if (r) {
      const lastHref = r.href, lastBody = r.body || '';
      for (const it of (r.links || [])) {
        if (it.id && !byId[it.id]) byId[it.id] = { id: it.id, name: it.name || '', author: it.author || '', videoUrl: it.url, image: it.image || '', platform: 'TikTok' };
      }
      // API (nếu page-hook chộp được) có desc/author đẹp hơn — gộp đè lên bản DOM.
      for (const it of parseTiktokTexts(r.cap || [], 999)) byId[it.id] = Object.assign({}, byId[it.id] || {}, it);
      const n = Object.keys(byId).length;
      if (n >= target) return {}; // đủ target trên TỔNG các cụm → dừng cả loạt
      if (n === 0 && /\/login|passport|\/signup/i.test(lastHref) && /log ?in|đăng nhập|sign up/i.test(lastBody)) return { blocked: 'login' };
      if (/verify|captcha|robot|security check|滑块|verification/i.test(lastBody)) return { blocked: 'verify' };
      stagnant = n === prevN ? stagnant + 1 : 0; prevN = n;
      if (stagnant >= 6) break; // cụm này cạn → sang cụm sau (đừng phí thời gian)
    }
    await sleep(900); // chờ TikTok tải trang video tiếp sau khi cuộn (load-more chậm hơn scroll)
  }
  return {};
}

// Đoán ngôn ngữ mô tả video → 'match' | 'neutral' | 'other' so với NƯỚC đích. Dùng để SẮP XẾP
// (không bỏ), vì TikTok cá nhân hoá theo account/IP: bạn login VN, dù dịch keyword sang tiếng Phi
// nó vẫn đẩy video VN. Bám dấu Việt / chữ Thái / chữ Hán để nhận diện; text Latin không dấu → 'neutral'
// (không phân biệt được PH vs ID vs EN). Không có mô tả → 'neutral' (không có tín hiệu, đừng dìm).
function tkLangTag(text, region) {
  const s = String(text || '').trim();
  if (!s) return 'neutral';
  const r = String(region || '').toUpperCase();
  const isThai = /[฀-๿]/.test(s);
  const isHan = /[一-鿿]/.test(s);
  const isVN = /[ăâđêôơư]|[àáảãạầấẩẫậằắẳẵặèéẻẽẹềếểễệìíỉĩịòóỏõọồốổỗộờớởỡợùúủũụừứửữựỳýỷỹỵ]/i.test(s);
  // Match khi script đặc trưng khớp NƯỚC đích.
  if (isThai) return r === 'TH' ? 'match' : 'other';
  if (isHan) return (r === 'TW' || r === 'CN' || r === 'SG') ? 'match' : 'other';
  if (isVN) return r === 'VN' ? 'match' : 'other';
  return 'neutral'; // Latin không dấu (EN/PH/ID/MY…) — không đủ tín hiệu, coi như trung tính
}

// TikTok organic: NHIỀU cụm tìm (keyword + hashtag do backend sinh theo ngôn ngữ region) → gom video,
// bỏ link trùng. `keywords` (mảng) ưu tiên; không có thì dùng `keyword` đơn. `region` để STAMP
// nhãn ngôn ngữ vào từng item (results.js sắp xếp: match → neutral → other). Tất cả chạy trên 1 tab.
async function searchTiktok(keyword, count, keywords, region, mode, anchor) {
  try {
    const tab = await tiktokTab();
    const target = Math.min(150, Math.max(12, count || 24));
    let terms = (Array.isArray(keywords) && keywords.length ? keywords : [keyword]).map((s) => String(s || '').trim()).filter(Boolean).slice(0, 6);
    if (!terms.length) return { items: [], blocked: false, error: 'TikTok: thiếu từ khoá.' };
    // hashtag mode: ưu tiên hashtag; có anchor thì kể cả keyword thường cũng ok (đằng nào cũng nối anchor).
    if (mode === 'hashtag') {
      const tags = terms.filter((t) => /^#/.test(t));
      if (tags.length) terms = tags;
      else if (!anchor) mode = 'mixed'; // không hashtag, không anchor → hạ về search text thô
    }
    // Mode label khớp thực tế: có anchor = "anchored" (neo brand+model), else /tag/ = "hashtag".
    const effectiveMode = mode === 'hashtag' ? (anchor ? 'anchored' : 'hashtag') : 'mixed';

    const byId = {}; // id -> item, dedup xuyên suốt mọi cụm ("link trùng thì bỏ qua")
    const totalDeadline = Date.now() + 120000; // ngân sách tổng cho cả loạt cụm
    let blocked = null;
    // Focus tab CHỈ 1 lần ở đầu (nạp signing JS, render kết quả đầu). Các cụm sau chạy nền + gõ ô
    // search → tab không "nhảy" như cũ. Nếu Chrome tiết chế nặng, kết quả có thể hụt vài cụm cuối —
    // đánh đổi chấp nhận được để bớt gây khó chịu.
    await focusTab(tab.id);
    for (let i = 0; i < terms.length; i++) {
      if (Object.keys(byId).length >= target || Date.now() >= totalDeadline) break;
      // Chia đều thời gian còn lại cho các cụm CHƯA chạy; kẹp 12–28s/cụm.
      const remainingTerms = terms.length - i;
      const budget = Math.max(12000, Math.min(28000, Math.floor((totalDeadline - Date.now()) / Math.max(1, remainingTerms))));
      const res = await searchTiktokTerm(tab, terms[i], byId, target, budget, mode, anchor, i === 0);
      if (res.blocked) { blocked = res.blocked; break; }
    }

    // Nhãn ngôn ngữ + SẮP XẾP: match trước, neutral giữa, other cuối. TikTok cá nhân hoá theo
    // account nên video khác ngôn ngữ (vd tiếng Việt khi chọn PH) vẫn giữ lại — chỉ đẩy xuống cuối.
    const rank = { match: 0, neutral: 1, other: 2 };
    const stamped = Object.values(byId).map((it) => ({ ...it, langMatch: tkLangTag(it.name, region) }));
    stamped.sort((a, b) => rank[a.langMatch] - rank[b.langMatch]);
    const items = stamped.slice(0, target);
    const counts = items.reduce((a, it) => (a[it.langMatch]++, a), { match: 0, neutral: 0, other: 0 });
    if (blocked === 'login') { await focusTab(tab.id); return { items, counts, mode: effectiveMode, blocked: !items.length, error: 'TikTok đòi đăng nhập — đăng nhập trong tab rồi bấm lại.' }; }
    if (blocked === 'verify') { await focusTab(tab.id); return { items, counts, mode: effectiveMode, blocked: !items.length, error: 'TikTok bắt xác minh — xử trong tab rồi bấm lại.' }; }
    if (!items.length) { await focusTab(tab.id); return { items: [], counts, mode: effectiveMode, blocked: true, error: 'Chưa lấy được video TikTok (chưa đăng nhập / bị chặn tự động / vùng không có kết quả). Mở tab TikTok, cuộn 1 chút rồi bấm lại.' }; }
    return { items, counts, mode: effectiveMode, blocked: false };
  } catch (e) { return { items: [], blocked: false, error: String(e) }; }
}

// ===== DOUYIN organic: keyword → list VIDEO (nội địa TQ, tiếng Trung; ít vướng cá nhân hoá VN) =====
// Douyin siết bot mạnh: hay hiện slider verify sau vài truy vấn. User chưa login vẫn xem được video
// public, nhưng có thể bị 网络异常/xác minh. Chiến lược: 1 tab riêng, navigate 1 lần, sau đó GÕ vào ô
// search + Enter cho các cụm sau (SPA đổi route ngầm). Kết quả: DOM scrape <a href="/video/<id>">.
const douyinTab = () => keptTab('douyin');

// Gõ vào ô search Douyin, KHÔNG navigate (giống TikTok). Trả true/false.
async function dyTypeInSearchBox(tabId, term) {
  try {
    const out = await chrome.scripting.executeScript({
      target: { tabId }, world: 'MAIN', args: [term],
      func: (q) => {
        try { window.__rsCap = []; } catch (e) {}
        // Douyin: ô search thường có placeholder tiếng Trung, hoặc data-e2e riêng của họ.
        const inp = document.querySelector('input[type="search"]')
          || document.querySelector('input[placeholder*="搜索"]')
          || document.querySelector('input[data-e2e*="search"]')
          || Array.from(document.querySelectorAll('input')).find((e) => /搜索|search/i.test((e.placeholder || '') + (e.getAttribute('aria-label') || '')));
        if (!inp) return false;
        const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set;
        setter.call(inp, q);
        inp.dispatchEvent(new Event('input', { bubbles: true }));
        inp.dispatchEvent(new Event('change', { bubbles: true }));
        const opts = { bubbles: true, key: 'Enter', code: 'Enter', keyCode: 13, which: 13 };
        inp.dispatchEvent(new KeyboardEvent('keydown', opts));
        inp.dispatchEvent(new KeyboardEvent('keypress', opts));
        inp.dispatchEvent(new KeyboardEvent('keyup', opts));
        try { const f = inp.closest('form'); if (f && typeof f.requestSubmit === 'function') f.requestSubmit(); } catch (e) {}
        return true;
      },
    });
    return !!(out && out[0] && out[0].result);
  } catch (e) { return false; }
}

async function searchDouyinTerm(tab, term, byId, target, budgetMs, isFirst) {
  if (isFirst) {
    // /search/<encoded>?type=video → tab video, đỡ lẫn user/hashtag ở trang search tổng hợp.
    await chrome.tabs.update(tab.id, { url: 'https://www.douyin.com/search/' + encodeURIComponent(term) + '?type=video' });
    await waitForComplete(tab.id, 16000);
    await sleep(2500); // Douyin render chậm hơn TikTok (JS nặng, animation intro)
  } else {
    const typed = await dyTypeInSearchBox(tab.id, term);
    if (!typed) {
      await chrome.tabs.update(tab.id, { url: 'https://www.douyin.com/search/' + encodeURIComponent(term) + '?type=video' });
      await waitForComplete(tab.id, 16000);
    }
    await sleep(2200);
  }
  const deadline = Date.now() + budgetMs;
  let prevN = Object.keys(byId).length, stagnant = 0;
  while (Date.now() < deadline) {
    let r = null;
    try {
      const out = await chrome.scripting.executeScript({
        target: { tabId: tab.id }, world: 'MAIN',
        func: () => {
          try {
            const h = document.documentElement.scrollHeight;
            window.scrollTo(0, h * 0.7);
            window.scrollTo(0, h);
            window.dispatchEvent(new Event('scroll'));
          } catch (e) {}
          // Douyin video URL pattern: /video/<numeric_id>. Card thường có <img> cover + tiêu đề.
          const links = [];
          document.querySelectorAll('a[href*="/video/"]').forEach((a) => {
            const m = (a.getAttribute('href') || '').match(/\/video\/(\d+)/);
            if (!m) return;
            const img = a.querySelector('img') || (a.closest('li,div[class]') && (a.closest('li,div[class]').querySelector('img')));
            let name = '';
            // Douyin: tiêu đề nằm ở <p class="..."> hoặc [data-e2e="search-card-desc"] sát card.
            const wrap = a.closest('li') || a.closest('div[class]');
            if (wrap) {
              const t = wrap.querySelector('[data-e2e*="desc"], p[class]');
              if (t) name = (t.textContent || '').trim().slice(0, 200);
            }
            if (!name && img && img.alt && !/^\d+$/.test(img.alt.trim())) name = img.alt;
            const href = a.href.startsWith('http') ? a.href : ('https://www.douyin.com' + a.getAttribute('href'));
            links.push({ id: m[1], url: href.split('?')[0], image: img ? (img.src || img.getAttribute('data-src') || '') : '', name });
          });
          // Filter API response Douyin để lấy digg_count + create_time (DOM không có 2 field này).
          const cap = (window.__rsCap || []).filter((c) => /aweme\/v1\/web\/(general\/search|search\/item)/.test(c.url)).map((c) => c.text);
          return { links, cap, href: location.href, body: document.body ? document.body.innerText.slice(0, 400) : '' };
        },
      });
      r = out && out[0] && out[0].result;
    } catch (e) { /* trang chưa sẵn sàng */ }
    if (r) {
      const lastHref = r.href, lastBody = r.body || '';
      for (const it of (r.links || [])) {
        if (it.id && !byId[it.id]) byId[it.id] = { id: it.id, name: it.name || '', author: '', videoUrl: it.url, image: it.image || '', platform: 'Douyin' };
      }
      // API (nếu chộp được) có digg_count + create_time — gộp đè lên bản DOM (DOM không có 2 số này).
      for (const it of parseDouyinTexts(r.cap || [], 999)) byId[it.id] = Object.assign({}, byId[it.id] || {}, it);
      const n = Object.keys(byId).length;
      if (n >= target) return {};
      if (/passport|\/login/i.test(lastHref) || /扫码登录|需要登录|请登录/.test(lastBody)) return { blocked: 'login' };
      if (/滑块|请拖动|向右滑|verify|captcha|安全验证|网络异常/i.test(lastBody)) return { blocked: 'verify' };
      stagnant = n === prevN ? stagnant + 1 : 0; prevN = n;
      if (stagnant >= 6) break;
    }
    await sleep(1100);
  }
  return {};
}

async function searchDouyin(keyword, count, keywords, anchor) {
  try {
    const tab = await douyinTab();
    const target = Math.min(100, Math.max(12, count || 24));
    let terms = (Array.isArray(keywords) && keywords.length ? keywords : [keyword]).map((s) => String(s || '').trim()).filter(Boolean);
    if (!terms.length) return { items: [], blocked: false, error: 'Douyin: thiếu từ khoá.' };
    // Douyin search hiểu text thô (kể cả có #). Với anchor + hashtag: nối lại thành text 1 dòng.
    terms = terms.slice(0, 4).map((t) => (anchor && /^#/.test(t)) ? `${anchor} ${t}` : t);

    const byId = {};
    const totalDeadline = Date.now() + 120000;
    let blocked = null;
    await focusTab(tab.id); // Douyin cần foreground để render (giống TikTok)
    for (let i = 0; i < terms.length; i++) {
      if (Object.keys(byId).length >= target || Date.now() >= totalDeadline) break;
      const remaining = terms.length - i;
      const budget = Math.max(14000, Math.min(30000, Math.floor((totalDeadline - Date.now()) / Math.max(1, remaining))));
      const res = await searchDouyinTerm(tab, terms[i], byId, target, budget, i === 0);
      if (res.blocked) { blocked = res.blocked; break; }
    }
    // Douyin toàn tiếng Trung → langMatch coi như 'match' hết (không cần detect).
    const items = Object.values(byId).slice(0, target).map((it) => ({ ...it, langMatch: 'match' }));
    const counts = { match: items.length, neutral: 0, other: 0 };
    if (blocked === 'login') { await focusTab(tab.id); return { items, counts, blocked: !items.length, error: 'Douyin đòi đăng nhập — mở tab douyin.com đăng nhập (quét QR) rồi bấm lại.' }; }
    if (blocked === 'verify') { await focusTab(tab.id); return { items, counts, blocked: !items.length, error: 'Douyin bắt xác minh (滑块) — kéo slider trong tab rồi bấm lại.' }; }
    if (!items.length) { await focusTab(tab.id); return { items: [], counts, blocked: true, error: 'Chưa lấy được video Douyin (chặn tự động / cần verify). Mở tab douyin.com, cuộn 1 chút rồi bấm lại.' }; }
    return { items, counts, blocked: false };
  } catch (e) { return { items: [], blocked: false, error: String(e) }; }
}

// Shopee: fetch thô /api/v4/search/search_items bị 403 (anti-bot, thiếu header ký JS). Cách chạy:
// ĐIỀU HƯỚNG tab shopee (đã đăng nhập) tới trang /search — để CHÍNH TRANG gọi search_items (tự ký),
// page-hook chộp response. Cuộn để lấy thêm trang. Giống Taobao/Temu, chỉ khác domain.
// Tab RIÊNG cho search (không chiếm tab shopee bạn đang mở). Cookie same-domain → vẫn có session
// login. CHƯA CÓ NƠI GỌI: `searchShopee` hiện đi qua `ensureTab(domain)`; giữ lại để nếu dùng
// tới thì cũng nằm trong kho tab chung, không đẻ ra một cái tab id mồ côi nữa.
const shopeeSearchTab = () => keptTab('shopeeSearch');
/**
 * Cào Shopee: theo TỪ KHOÁ hoặc theo DANH MỤC, cùng một cơ chế.
 *
 * Cả hai đều để CHÍNH TRANG bắn `search_items` (endpoint ký anti-bot, ta không tự dựng được)
 * rồi chộp response. Khác nhau đúng hai chỗ: URL đi tới, và THAM SỐ dùng để nhận ra response
 * nào là của mình — `keyword=` khi tìm theo từ, `match_id=` khi duyệt danh mục.
 *
 * Danh mục lấy 2 trang vì Shopee trả 60 mục/trang mà ta cần top 100.
 */
async function searchShopee(msg) {
  const domain = msg.domain || 'shopee.vn';
  const catId = msg.catId ? String(msg.catId) : '';
  if (catId) {
    // ĐƯỜNG `-cat.<id>` chứ không phải `/search?catId=`. `/search` là trang TÌM KIẾM: không có
    // từ khoá thì SPA không chạy lượt tìm nào, nên không có `search_items` để chộp. `-cat.<id>`
    // mới là đường Shopee tự dùng khi người ta bấm vào một danh mục.
    //
    // NGÀNH CẤP 2 CẦN CẢ HAI MÃ: `-cat.<cha>.<con>`. `catPath` mang sẵn dạng "<cha>.<con>";
    // không có nó thì rơi về `catId` một mình, đúng cho ngành cấp 1.
    //
    // SLUG KHÔNG ĐƯỢC RỖNG. Đo 2026-09-10 trong Chrome đã đăng nhập: `shopee.vn/-cat.11035567`
    // và `shopee.vn/-cat.11035567.11035592` đều trả 404 ĐỨNG YÊN, trong khi cùng mã ấy kèm
    // slug thì trang chạy tiếp. Nên link chép thẳng từ sheet (dạng `/-cat.X.Y`, slug rỗng)
    // KHÔNG dùng làm URL được — sheet ghi nó để người đọc bấm, không phải để máy tải.
    //
    // Và slug phải BỎ DẤU trước khi lọc. `[^\w]` xoá luôn chữ có dấu: "Áo" thành "o",
    // "Đồ Chơi" thành "Chơi"→"Chi". Chuẩn hoá NFD rồi cắt dấu thanh cho ra "Ao", "Do-Choi".
    const slug = String(msg.catName || 'c')
      .normalize('NFD').replace(/[̀-ͯ]/g, '')
      .replace(/đ/g, 'd').replace(/Đ/g, 'D')
      .replace(/[^\w]+/g, '-').replace(/^-+|-+$/g, '') || 'c';
    const catPath = msg.catPath ? String(msg.catPath) : catId;
    const base = `https://${domain}/${slug}-cat.${catPath}`;
    const texts = [];
    let last = null;
    for (const page of [0, 1]) {
      const url = `${base}?sortBy=sales&page=${page}`;
      // Nhận diện response theo GIÁ TRỊ id, chấp nhận vài tên tham số: Shopee gọi nó là
      // `match_id` ở endpoint search, nhưng tên ấy không phải thứ ta kiểm soát được.
      //
      // VÀ PHẢI KÈM ĐÚNG OFFSET. Hai trang của cùng một danh mục mang CÙNG `match_id`, nên
      // riêng nó không phân biệt được trang 1 với trang 2: lượt chụp trang 2 nhận lại đúng
      // response của trang 1 còn sót, và cả danh mục dừng ở 60 mục thay vì 100. Shopee đánh
      // offset bằng `newest` (0, 60, 120…) — đó mới là thứ khác nhau giữa hai trang.
      // Chỉ kiểm tab sắp xếp ở TRANG ĐẦU: sang trang 2 thì lựa chọn đã dính vào phiên,
      // kiểm lại chỉ tốn thêm ngân sách của một chuỗi hạn giờ vốn đã chật.
      last = await shopeeCapture(domain, url, 'match_id|catid|category', catId,
                                 `newest=${page * 60}`, page === 0);
      if (last.blocked && last.reason) return last;      // login / xác minh: dừng hẳn
      for (const t of (last.texts || [])) texts.push(t);
      if (!last.texts || !last.texts.length) break;      // trang rỗng thì trang sau cũng rỗng
    }
    return { texts, videoItems: [], blocked: !texts.length, error: texts.length ? undefined : (last && last.error) };
  }
  const url = `https://${domain}/search?keyword=${encodeURIComponent(msg.keyword || '')}`;
  return shopeeCapture(domain, url, 'keyword', msg.keyword || '');
}

async function shopeeCapture(domain, pageUrl, param, want, mustHave, clickSort) {
  try {
    // Dùng lại tab shopee CÓ SẴN (không đẻ tab thừa), navigate ngầm (active:false → không cướp focus).
    // search_items bắn NGAY khi load → thoát ngay khi chộp được (nhanh ~2-3s), không chờ/không cuộn.
    const tab = await ensureTab(domain);
    await chrome.tabs.update(tab.id, { url: pageUrl, active: false });

    // BẤM TAY VÀO TAB "BÁN CHẠY" KHI THAM SỐ URL KHÔNG ĂN.
    //
    // `?sortBy=sales` thường tự chọn đúng tab, nhưng khi nó không ăn thì trang trả về danh
    // sách "Phổ biến" — kiểu hỏng KHÔNG nhìn ra được ở phía sau: vẫn đủ 60 sản phẩm, vẫn có
    // `sold_count`, chỉ thứ tự là của một bảng xếp hạng khác. Mà `rank` của ta CHÍNH LÀ thứ
    // tự ấy.
    //
    // PHẢI ĐỢI TRANG ĐÍCH TẢI XONG TRƯỚC KHI ĐỤNG VÀO. `chrome.tabs.update` trả về NGAY, lúc
    // đó tab vẫn còn là danh mục TRƯỚC. Bản đầu của bước này không kiểm gì cả nên nó tìm thấy
    // thanh sắp xếp của trang cũ rồi bấm — và cú bấm ấy tự nó điều hướng tab đi chỗ khác,
    // làm lượt chộp mất trang đích. Đo 2026-09-10: hai danh mục liên tiếp chết ở trần 75s
    // theo đúng kiểu đó, một VN một PH, nên nó không phải chuyện của riêng thị trường nào.
    //
    // So khớp bằng MÃ trong đường dẫn chứ không bằng cả URL: Shopee tự viết lại slug và thêm
    // tham số theo dõi sau khi tải, nên so nguyên văn sẽ không bao giờ khớp.
    if (clickSort && /[?&]sortBy=sales/.test(pageUrl)) {
      // ĐUA VỚI ĐỒNG HỒ, KHÔNG ĐƯỢC `await` TRẦN.
      //
      // `executeScript` với một `func` trả Promise sẽ chờ Promise ấy settle. Nếu tab điều
      // hướng giữa chừng thì ngữ cảnh trang bị huỷ và Promise KHÔNG BAO GIỜ settle — lời gọi
      // treo vĩnh viễn, và `try/catch` không đỡ được vì chẳng có lỗi nào được ném. Cả handler
      // đứng im cho tới khi trang máy-thợ hết giờ, rồi báo "extension chưa trả lời" — một câu
      // không hề chỉ về phía thủ phạm.
      //
      // Đo 2026-09-10: bước này chạy đúng ở danh mục ĐẦU TIÊN (tab còn ở trang chủ, không có
      // điều hướng nào chen vào) rồi treo ở mọi danh mục sau. Đúng kiểu lỗi mà phép thử một
      // danh mục không bao giờ bắt được.
      const doiThanhSapXep = chrome.scripting.executeScript({
          target: { tabId: tab.id }, world: 'MAIN', args: [String(want)],
          func: (maCanCo) => {
            const NHAN = ['top sales', 'bán chạy', 'ban chay'];
            const den = Date.now() + 9000;
            const dungTrang = () => location.pathname.includes(maCanCo);
            const tim = () => [...document.querySelectorAll('div,button,a,span')].find((e) => {
              const t = (e.textContent || '').trim().toLowerCase();
              return t.length < 24 && NHAN.some((n) => t === n);
            });
            return new Promise((xong) => {
              const nhip = setInterval(() => {
                if (Date.now() > den) { clearInterval(nhip); xong('het-gio'); return; }
                if (!dungTrang()) return;            // còn ở trang cũ — TUYỆT ĐỐI không bấm
                const o = tim();
                if (!o) return;                      // đúng trang nhưng chưa render thanh sắp xếp
                clearInterval(nhip);
                // Shopee đánh dấu tab đang chọn bằng class chứa "active"/"selected" ở chính nó
                // hoặc ở thẻ cha gần nhất — đọc cả hai rồi mới quyết định có bấm không. Bấm lại
                // tab đang chọn cũng làm trang bắn thêm một lượt `search_items` đua với lượt
                // đang chờ chộp.
                const lop = ((o.className || '') + ' ' + ((o.parentElement || {}).className || '')).toLowerCase();
                xong(/active|selected/.test(lop) ? 'da-dung-san' : (o.click(), 'da-bam'));
              }, 250);
            });
          },
      }).catch(() => null);   // tab đóng / không tiêm được: đi tiếp bằng tham số URL

      // 12s = 9s ngân sách của script + 3s bù cho lúc tiêm. Hết giờ thì BỎ QUA nó và chộp
      // tiếp: đây là lớp bảo hiểm cho thứ tự sắp xếp, không phải điều kiện bắt buộc.
      await Promise.race([doiThanhSapXep, new Promise((r) => setTimeout(r, 12000))]);
    }

    // 60s, KHÔNG phải 22s — và con số này là của MÁY CHẠY, không phải của Shopee.
    //
    // 22s đủ trên máy cá nhân nhưng thiếu trên VPS. Đo 2026-09-10 trên máy production: 4 vCPU,
    // 8 GB RAM mà chỉ còn trống 1,3 GB, riêng Chrome đã ngốn 3,2 GB qua 17 tiến trình. Trang
    // Shopee là SPA nặng; ở mức tài nguyên đó nó dựng ì ạch và `search_items` bắn ra muộn hơn
    // hẳn. Chính chủ dự án mở tay cùng trang trên hai máy và thấy rõ: máy cá nhân nhanh, VPS
    // khựng.
    //
    // ĐÂY LÀ KIỂU HỎNG DỄ CHẨN NHẦM NHẤT: một danh mục chạy được lúc máy còn rảnh rồi thôi
    // hẳn khi Chrome phình ra, mà lý do ghi lại là "trang đã rời khỏi URL" — trông y hệt
    // Shopee đổi đường dẫn hoặc chặn bot. Đã đuổi theo ba giả thuyết về URL trước khi nhận ra.
    //
    // Thứ tự bắt buộc của chuỗi hạn giờ, tính cho đường DANH MỤC vì nó tốn nhất — hai trang,
    // mỗi trang một hạn 60s riêng, cộng tối đa 9s đợi thanh sắp xếp:
    //
    //     129s (đây) < 160s (trang máy-thợ) < 180s (backend)
    const deadline = Date.now() + 60000;
    let texts = [], videoItems = {}, textsIter = -1, iter = 0, seen = null;
    while (Date.now() < deadline) {
      await sleep(500);
      iter++;
      let r = null;
      try {
        const out = await chrome.scripting.executeScript({
          target: { tabId: tab.id }, world: 'MAIN', args: [param, String(want), mustHave || ''],
          func: (pname, pwant, must) => {
            // CHỈ NHẬN JSON CỦA ĐÚNG TỪ KHOÁ ĐANG HỎI. `executeScript` có thể chạy trúng tài
            // liệu CŨ khi `tabs.update` chưa commit xong; lúc đó `__rsCap` còn nguyên
            // `search_items` của lần trước, vòng lặp thấy có `texts` nên thoát ngay và trả
            // kết quả của từ khoá TRƯỚC kèm cờ thành công. Đã xảy ra thật: một mẻ 10 từ khoá
            // bị tráo chéo mà không lớp nào phía sau nghi ngờ gì.
            const norm = (s) => String(s || '').toLowerCase().replace(/\s+/g, ' ').trim();
            const want = norm(pwant);
            const names = String(pname).split('|');
            const sameKw = (u) => {
              for (let i = 0; i < names.length; i++) {
                const m = new RegExp('[?&]' + names[i] + '=([^&]*)', 'i').exec(u || '');
                if (!m) continue;
                let got = m[1];
                try { got = decodeURIComponent(got.replace(/\+/g, ' ')); } catch (e) {}
                if (norm(got) === want) return true;
              }
              return false;
            };
            const onRightPage = sameKw(location.href);
            const all = (window.__rsCap || []).filter((c) => /\/api\/v4\/search\/search_items/.test(c.url));
            // Lọc theo `keyword=` trong chính URL của JSON — bằng chứng cứng, và tự nó đủ.
            // KHÔNG chặn thêm bằng `onRightPage`: Shopee đá một số truy vấn sang trang danh
            // mục (URL không còn `keyword=`), chặn hai lớp làm hụt 6/10 từ khoá.
            const cap = all
              .filter((c) => sameKw(c.url) && (!must || String(c.url).indexOf(must) !== -1))
              .map((c) => c.text);
            // Có JSON của từ khoá KHÁC mà không có của mình = đúng tình huống nhiễm chéo,
            // báo ra để lần sau khỏi phải đoán.
            const nOther = all.length - cap.length;
            const capKw = all.slice(-4).map((c) => {
              const m = /[?&]keyword=([^&]*)/.exec(c.url || '');
              return m ? m[1].slice(0, 40) : '(không có keyword= trong URL)';
            });
            // search_items KHÔNG có URL video, chỉ DOM có badge `data-testid="badge-video"`. Bóc LINK
            // sản phẩm có badge đó (shopid.itemid trong href) — sau này backend trỏ vào link lấy video.
            const vids = [];
            document.querySelectorAll('[data-testid="badge-video"]').forEach((b) => {
              const a = b.closest('a[href*="-i."]') || (b.closest('li') && b.closest('li').querySelector('a[href*="-i."]'));
              if (!a) return;
              const m = (a.getAttribute('href') || '').match(/-i\.(\d+)\.(\d+)/);
              if (m) vids.push({ shopid: m[1], itemid: m[2], url: a.href.split('?')[0] });
            });
            return { cap, vids, onRightPage, nOther, capKw, href: location.href, body: document.body ? document.body.innerText.slice(0, 300) : '' };
          },
        });
        r = out && out[0] && out[0].result;
      } catch (e) { /* trang chưa sẵn sàng */ }
      if (r) {
        if (/\/(buyer\/)?login|\/verify/i.test(r.href) || /verify|captcha|robot|xác minh/i.test(r.body || '')) { return { texts: [], blocked: true, reason: 'login', error: 'Shopee đòi đăng nhập/xác minh — mở ' + domain + ' đăng nhập rồi bấm lại.' }; }
        seen = r;
        if (r.cap && r.cap.length) { texts = r.cap; if (textsIter < 0) textsIter = iter; }
        // `vids` bóc từ DOM và KHÔNG mang theo từ khoá nào để đối chiếu — chỉ nhận khi
        // chắc chắn đang đứng đúng trang, còn `cap` thì tự nó đã có bằng chứng rồi.
        if (r.onRightPage) for (const v of (r.vids || [])) videoItems[v.itemid] = v;
        // Có JSON + đã bắt badge (hoặc chờ thêm ~2s cho DOM render badge) → thoát.
        if (texts.length > 0 && (Object.keys(videoItems).length > 0 || iter - textsIter >= 4)) break;
      }
    }
    // Hết giờ tay không thì nói ra đã thấy gì: ba tình huống dưới đây sửa ba kiểu khác nhau.
    let why;
    if (!texts.length) {
      why = 'Shopee: chưa chộp được search_items trong 22s';
      if (seen && seen.nOther) why += ` — chỉ thấy JSON của từ khoá khác (${seen.capKw.join(' · ')})`;
      else if (seen && !seen.onRightPage) why += ` — trang đã rời khỏi URL có keyword= (${String(seen.href).slice(0, 90)})`;
      else why += ' — trang chưa bắn XHR tìm kiếm lần nào';
      why += '. Thử lại.';
    }
    return { texts, videoItems: Object.values(videoItems), blocked: !texts.length, error: why };
  } catch (e) { return { texts: [], videoItems: [], blocked: false, error: String(e) }; }
}

// ============================================================================
// TÌM BẰNG ẢNH — Google Lens và Taobao, chạy trên MÁY-THỢ
// ============================================================================
//
// VÌ SAO HAI NGUỒN NÀY PHẢI Ở ĐÂY chứ không ở backend như trước. Đo trên chính VPS ngày
// 2026-09-04, cả hai đường tự mở Chrome trên server đều tắc, mỗi đường một lý do:
//
//   Google Lens  lớp phủ mở được, ảnh thả được, rồi Google đá thẳng sang `/sorry`. Kết quả
//                Lens BÁM THEO IP — đó vừa là giá trị của nguồn (IP Việt Nam ra Shopee VN,
//                Điện Máy XANH kèm giá VNĐ) vừa là lý do một IP datacenter không dùng được.
//   Taobao       MTOP trả đúng mẫu chưa đăng nhập. Phiên dựng bằng tay trên VPS không sống
//                sót, vì backend chạy dưới LocalSystem còn người vận hành đăng nhập dưới
//                Administrator — Chrome mã hoá cookie theo tài khoản Windows.
//
// Máy-thợ có sẵn cả ba thứ đó: Chrome thật, IP dân cư, đã đăng nhập. Xem
// `backend/lib/imagesearch/relay.py`.
//
// NGÂN SÁCH phải NHỎ HƠN `IMAGE_TIMEOUT_S` của backend (100s), nếu không backend bỏ cuộc
// trước và người dùng nhận "hết giờ" trong khi máy-thợ vẫn đang chạy ngon lành.
const IMAGE_JOB_BUDGET_MS = 80000;

/**
 * Vòng chờ kết quả phải DỪNG TRƯỚC hạn tổng của `withStageBudget` một khoảng này.
 *
 * Trước đây vòng chờ đặt `deadline = Date.now() + IMAGE_JOB_BUDGET_MS` — tính từ lúc nó bắt đầu,
 * tức MUỘN hơn hạn tổng vài chục giây (mở tab, thả ảnh đã ăn mất phần đó). Hạn tổng vì vậy luôn
 * cắt trước, và câu chẩn đoán cuối vòng ("trang chưa gọi API nào", "mtop trả: …") không bao giờ
 * về tới backend — chỉ còn "treo ở bước chờ Taobao trả kết quả", không phân biệt được Taobao
 * chậm, chưa bấm được nút tìm hay đã đổi tên API. Gặp thật 13/09/2026.
 */
const IMAGE_REPORT_MARGIN_MS = 12000;

// ẢNH ĐẾN DƯỚI DẠNG data URL và phải thành `File` TRONG TRANG. Không có đường nào khác:
// `chrome.scripting` chỉ truyền được giá trị JSON, còn `File`/`Blob` thì không qua được ranh
// giới ấy. Dựng trong trang bằng `fetch(dataUrl)` là cách gọn nhất, và cũng là cách duy nhất
// khiến `DataTransfer` mang đúng một tệp thật.

/**
 * Bấm nút máy ảnh của Taobao, thả ảnh vào, rồi bấm 搜索.
 *
 * BA CHI TIẾT, mỗi cái từng làm cả lượt chạy trượt (đo 2026-08-17 bằng Playwright, nay chép
 * sang đây):
 *   - không bấm nút máy ảnh thì `input[type=file]` KHÔNG TỒN TẠI trong DOM, cú nạp tệp rơi
 *     vào khoảng không mà không báo gì;
 *   - panel nhận ảnh xong KHÔNG tự tìm, nó đứng đợi một cú bấm 搜索 — nhìn riêng lưu lượng
 *     mạng thì y hệt "trang không nhận ảnh";
 *   - `input.files` phải gán qua `DataTransfer` rồi bắn `change`, gán thẳng không được.
 */
async function tbDropImage(dataUrl) {
  const nap = (ms) => new Promise((r) => setTimeout(r, ms));
  const camera = document.querySelector("[class*='image-search-icon-wrapper']");
  if (!camera) return { ok: false, stage: 'camera' };
  camera.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }));

  let input = null;
  for (let i = 0; i < 24 && !input; i++) {
    await nap(300);
    input = document.querySelector("input[type='file']");
  }
  if (!input) return { ok: false, stage: 'input' };

  try {
    const blob = await (await fetch(dataUrl)).blob();
    const dt = new DataTransfer();
    dt.items.add(new File([blob], 'upload.jpg', { type: 'image/jpeg' }));
    input.files = dt.files;
    input.dispatchEvent(new Event('change', { bubbles: true }));
  } catch (e) {
    return { ok: false, stage: 'file', error: String(e) };
  }

  // CHỘP LỆNH MỞ TAB KẾT QUẢ. Đo 13/09/2026: bấm 搜索 trong panel thì Taobao `window.open` trang
  // `s.taobao.com/search?…localImgKey=…` ở TAB MỚI. Cú bấm của ta là `MouseEvent` tự dựng, không
  // phải cú bấm thật, nên trình chặn popup của Chrome nuốt lệnh mở tab — trang đứng yên ở trang
  // chủ, không API tìm ảnh nào được gọi, nguồn treo tới hết giờ. Nên: bọc `window.open` để lấy
  // URL, rồi background tự mở URL ấy trong tab của mình.
  window.__rsOpenUrl = '';
  if (!window.__rsOpenPatched) {
    const origOpen = window.open;
    window.open = function (u) {
      try { if (u) window.__rsOpenUrl = String(u); } catch (e) {}
      return origOpen.apply(this, arguments);
    };
    window.__rsOpenPatched = true;
  }

  // Bấm nút xác nhận. Lấy phần tử KHỚP CHÍNH XÁC nhãn và đang HIỆN — trang có nhiều nút chữ
  // 搜索 (ô tìm kiếm chính cũng vậy), và bấm nhầm cái ở thanh trên là tìm theo chữ rỗng.
  for (let i = 0; i < 12; i++) {
    await nap(500);
    const hits = [...document.querySelectorAll('button, a, span, div')].filter((el) => {
      const t = (el.textContent || '').trim();
      return (t === '搜索' || t === '搜同款') && el.offsetParent !== null;
    });
    if (hits.length) {
      const btn = hits[hits.length - 1];
      btn.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }));
      // Nút có thể là link `target=_blank` thay vì `window.open` — lấy luôn href nếu có.
      const link = btn.closest && btn.closest('a[href]');
      for (let k = 0; k < 16 && !window.__rsOpenUrl; k++) await nap(250);
      const openUrl = window.__rsOpenUrl || (link && /localImgKey|search/i.test(link.href) ? link.href : '');
      return { ok: true, openUrl };
    }
  }
  return { ok: false, stage: 'submit' };
}

/** Đọc `__rsCap` của một tab: phản hồi recommend CÓ `itemsArray`, cộng dấu hiệu chặn. */
function tbReadCapture() {
  // Bỏ lượt `pc_search_preload` của TRANG CHỦ: nó cũng là relationrecommend, cũng `SUCCESS`, nhưng
  // chỉ là cấu hình tải sẵn — để lọt vào đây thì nó chiếm chỗ `ret`/mẫu cấu trúc của phản hồi thật.
  const caps = (window.__rsCap || []).filter((c) => /relationrecommend/i.test(c.url || '')
    && !/pc_search_preload/.test(c.text || ''));
  let items = null;
  let ret = '';
  // Lượt gọi ĐẦU của chính trang thường dính `RGV587_ERROR` rồi trang tự thử lại, nên phải
  // duyệt NGƯỢC tìm phản hồi CÓ `itemsArray` — lấy phản hồi đầu tiên khớp tên API là lấy nhầm.
  let dataKeys = [];
  let shape = '';
  for (let i = caps.length - 1; i >= 0; i--) {
    let j = null;
    try { j = JSON.parse(caps[i].text); } catch (e) { continue; }
    if (!ret) ret = (j && j.ret && j.ret[0]) || '';
    let arr = j && j.data && j.data.itemsArray;
    // ĐƯỜNG DỰ PHÒNG khi Taobao đổi chỗ để hàng. Đo 07/09/2026: mtop trả đúng
    // `SUCCESS::调用成功` mà `data.itemsArray` không còn — nguồn chết câm, triệu chứng y hệt
    // "Taobao không trả kết quả". Bám vào một đường dẫn cứng là đánh cược cả nguồn vào việc
    // sàn không bao giờ đổi tên khoá. Nên: không thấy thì lùng bất kỳ mảng nào chứa object
    // CÓ ĐỦ `item_id` và `title` — đó đúng là hai trường `_row` bên backend bắt buộc, nên
    // mảng nào qua được phép thử này là mảng dùng được.
    if (!Array.isArray(arr) || !arr.length) {
      // Lùng TẠI CHỖ, không gọi `rsDeepFindArray`: hàm này chạy `world: 'MAIN'` nên nó được
      // tuần tự hoá rồi thả vào TRANG, nơi không có gì của background.js cả. Gọi ra ngoài là
      // ReferenceError, và `evalInTab` nuốt lỗi thành `null` — nguồn chết câm y như cũ.
      //
      // NHẬN NHIỀU TÊN TRƯỜNG. Đo 13/09/2026: mtop trả `SUCCESS` với `data = {result, pvid, scm,
      // version, tpp_trace, tpp_buckets}` và phép thử `item_id`+`title` cứng không khớp mảng nào.
      // Taobao dùng lẫn `item_id`/`itemId`/`nid`/`auctionId` và `title`/`raw_title`/`itemTitle`
      // tuỳ API; mảng khớp được đổi về đúng `item_id`+`title` mà `_row` bên backend đòi.
      const idOf = (x) => x && (x.item_id || x.itemId || x.nid || x.auctionId || x.auction_id);
      const titleOf = (x) => x && (x.title || x.raw_title || x.rawTitle || x.itemTitle || x.titleText);
      const stack = [j];
      for (let g = 0; g < 20000 && stack.length && !arr; g++) {
        const o = stack.pop();
        if (!o || typeof o !== 'object') continue;
        if (Array.isArray(o)) {
          if (o.length && o.slice(0, 5).every((x) => x && typeof x === 'object' && idOf(x) && titleOf(x))) {
            arr = o.map((x) => Object.assign({}, x, {
              item_id: String(idOf(x)),
              title: String(titleOf(x)).replace(/<[^>]+>/g, ''),
            }));
            break;
          }
          for (let k = 0; k < Math.min(o.length, 40); k++) stack.push(o[k]);
        } else {
          for (const k in o) stack.push(o[k]);
        }
      }
    }
    if (Array.isArray(arr) && arr.length) { items = arr.slice(0, 40); break; }
    if (!dataKeys.length && j && j.data) {
      dataKeys = Object.keys(j.data).slice(0, 12);
      // MẪU CẤU TRÚC của `data.result`: tên khoá lồng nhau, chuỗi cắt ngắn, mảng chỉ giữ phần tử
      // đầu. Để lần sau Taobao đổi chỗ để hàng, câu báo lỗi tự chỉ ra chỗ mới — không phải đoán.
      const shapeOf = (o, d) => {
        if (o == null || typeof o !== 'object') return typeof o === 'string' ? o.slice(0, 24) : o;
        if (d > 4) return '…';
        if (Array.isArray(o)) return o.length ? [shapeOf(o[0], d + 1), `×${o.length}`] : [];
        const out = {};
        for (const k of Object.keys(o).slice(0, 14)) out[k] = shapeOf(o[k], d + 1);
        return out;
      };
      try { shape = JSON.stringify(shapeOf(j.data.result !== undefined ? j.data.result : j.data, 0)).slice(0, 900); }
      catch (e) { shape = ''; }
    }
  }
  // Không có `items` thì kèm SỔ TÊN các API trang vừa gọi. Đó là thứ duy nhất phân biệt
  // "Taobao chưa trả kịp" với "Taobao đổi tên API nên `NEEDLES` hết khớp" — hai nguyên nhân
  // cho cùng một triệu chứng, và cách sửa khác hẳn nhau.
  const seen = items ? [] : (window.__rsSeen || [])
    .filter((u) => /mtop|\/api\/|search|recommend/i.test(u))
    .slice(-12);
  return {
    items,
    ret,
    seen,
    dataKeys,
    shape,
    // HỘP ĐĂNG NHẬP PHỦ TRANG CHỦ. Đo 13/09/2026: cookie `tracknick`/`_nk_` sống lâu hơn phiên
    // thật, nên phép thử cookie ở `taobaoImageRun` qua, rồi Taobao bung hộp 密码登录 che kín trang
    // — cú thả ảnh rơi vào dưới hộp, không API nào được gọi, nguồn treo tới hết giờ. Đọc cả
    // iframe login lẫn chữ trong hộp, vì chữ nằm quá xa 400 ký tự đầu của `body` để lọt vào đó.
    loginModal: !!document.querySelector("iframe[src*='login.taobao.com'], iframe[src*='login.tmall.com']")
      || /密码登录|短信登录|扫码登录/.test(document.body ? document.body.innerText || '' : ''),
    nCap: (window.__rsCap || []).length,
    href: location.href,
    body: document.body ? (document.body.innerText || '').slice(0, 400) : '',
  };
}

/**
 * Ảnh → hàng bán lẻ Taobao. Trả `{ items, blocked, reason, error }`.
 *
 * KẾT QUẢ HIỆN Ở TAB MỚI: Taobao mở một tab khác cho trang kết quả, tab trang chủ đứng yên.
 * Nên sau khi bấm tìm phải quét MỌI tab taobao chứ không chỉ tab của mình.
 */
/**
 * Bọc cả lượt tìm bằng ảnh trong MỘT hạn giờ, và ghi lại bước đang chạy.
 *
 * `IMAGE_JOB_BUDGET_MS` trước đây chỉ chi phối vòng quét kết quả ở cuối; mọi bước TRƯỚC đó —
 * đăng ký hook, hỏi cookie, mở tab, thả ảnh — không có hạn nào cả. Bước nào treo là cả job
 * treo im, không tab nào mở, không kết quả nào về, và backend phải chờ hết 100s rồi báo một
 * câu vô nghĩa: "máy-thợ không trả kết quả kịp". Gặp thật ngày 07/09/2026.
 *
 * `stage` để câu báo nói được job chết ở bước nào thay vì chỉ nói nó chết.
 */
async function withStageBudget(ms, run) {
  const st = { at: 'bắt đầu' };
  const timeout = new Promise((resolve) =>
    setTimeout(() => resolve({ items: [], blocked: true, reason: 'timeout',
      error: `treo ở bước "${st.at}" quá ${Math.round(ms / 1000)}s` }), ms));
  return Promise.race([Promise.resolve(run(st)).catch((e) => ({
    items: [], blocked: true, reason: 'error', error: `lỗi ở bước "${st.at}": ${e}` })), timeout]);
}

/** Không để một lời hứa nào chạy vô hạn — trả `fallback` khi quá hạn. */
function capped(promise, ms, fallback) {
  return Promise.race([promise, new Promise((r) => setTimeout(() => r(fallback), ms))]);
}

function taobaoImageSearch(dataUrl) {
  return withStageBudget(IMAGE_JOB_BUDGET_MS, (st) => taobaoImageRun(dataUrl, st));
}

async function taobaoImageRun(dataUrl, st) {
  const deadline = Date.now() + IMAGE_JOB_BUDGET_MS - IMAGE_REPORT_MARGIN_MS;
  st.at = 'đăng ký page-hook';
  await capped(ensurePageHook(), 5000, null);

  // Hỏi cookie TRƯỚC: khách vãng lai thì mọi lượt gọi MTOP đều trả `FAIL_SYS_SESSION_EXPIRED`,
  // và biết trước điều đó tiết kiệm cho người dùng ba mươi giây chờ một kết quả chắc chắn rỗng.
  //
  // HỎI BỐN TÊN chứ không một. Bốn cookie này cùng xuất hiện khi đăng nhập, nên chỉ cần MỘT
  // cái có mặt là đủ kết luận. Bám vào đúng một tên là đánh cược cả nguồn vào việc Taobao
  // không bao giờ đổi tên nó — mà nếu đổi thì hỏng theo kiểu tệ nhất: nguồn báo "chưa đăng
  // nhập" trong khi phiên vẫn tốt, và không lượt nào được thử nữa để lộ ra sự thật.
  st.at = 'hỏi cookie đăng nhập Taobao';
  // `capped`: `chrome.cookies.get` không gọi callback khi quyền `cookies` bị gỡ hoặc API kẹt,
  // và một `Promise.all` không hạn giờ ở đây treo cả job trước cả khi mở tab.
  const signedIn = await capped(Promise.all(['unb', 'cookie17', '_nk_', 'tracknick'].map((name) =>
    new Promise((resolve) => {
      try {
        chrome.cookies.get({ url: 'https://www.taobao.com/', name }, (c) => resolve(!!(c && c.value)));
      } catch (e) { resolve(false); }
    })
  )), 6000, null);
  if (signedIn === null) {
    return { items: [], blocked: true, reason: 'ui',
      error: 'không đọc được cookie Taobao trong 6s — extension có thể thiếu quyền `cookies`' };
  }
  if (!signedIn.some(Boolean)) {
    await openVerifyTab('verify:taobao', 'https://login.taobao.com/');
    return { items: [], blocked: true, reason: 'login' };
  }

  st.at = 'mở tab Taobao';
  const tab = await keptTab('taobao');

  // CHỤP LẠI TAB TAOBAO CÓ SẴN trước khi tìm. Máy-thợ là máy của người thật và họ hoàn toàn có
  // thể đang mở Taobao của riêng mình; đóng nhầm tab ấy sau mỗi lượt tìm là cách chắc chắn nhất
  // để không ai chịu để máy-thợ chạy nữa. Chỉ tab XUẤT HIỆN THÊM mới là của ta.
  const before = new Set((await chrome.tabs.query({ url: 'https://*.taobao.com/*' }))
    .map((t) => t.id).filter((id) => id != null));

  // ĐI THẲNG TRANG KẾT QUẢ, KHÔNG QUA PANEL TRANG CHỦ. Đọc mã `pc-search-2024/main.js` ngày
  // 13/09/2026: trang `s.taobao.com/search?localImgKey=K` lấy ảnh bằng `sessionStorage.getItem(K)`
  // (chính nó cất `newImg.dataUrl` vào đó), hoặc xin từ `window.opener` qua postMessage.
  // Đường panel trang chủ đi nhánh opener: bấm 搜索 thì `window.open` tab kết quả — cú bấm tự
  // dựng không có user activation nên Chrome chặn popup, còn tự mở URL ấy thì tab mới không có
  // opener và nhận về `result: [null]`. Cất dataUrl vào sessionStorage của CHÍNH tab s.taobao.com
  // rồi mở URL có khoá là đúng đường trang tự dùng khi tìm lại ảnh ngay trên trang kết quả.
  st.at = 'cất ảnh vào trang kết quả Taobao';
  await chrome.tabs.update(tab.id, { url: 'https://s.taobao.com/search?tab=all' });
  await focusTab(tab.id); // SPA nặng chỉ render + bắn XHR khi tab HIỆN TRƯỚC
  await waitForComplete(tab.id, 16000);
  const key = 'localImgSearchKey' + Date.now();
  const stored = await evalInTab(tab.id, (k, d) => {
    try { sessionStorage.setItem(k, d); return { ok: sessionStorage.getItem(k) === d, host: location.host }; }
    catch (e) { return { ok: false, error: String(e), host: location.host }; }
  }, [key, dataUrl], 8000);

  if (stored && stored.ok && /s\.taobao\.com/.test(stored.host || '')) {
    st.at = 'mở trang kết quả tìm ảnh';
    await chrome.tabs.update(tab.id, {
      url: 'https://s.taobao.com/search?localImgKey=' + encodeURIComponent(key) + '&search_type=item&tab=all',
    });
    await waitForComplete(tab.id, 16000);
  } else {
    // Dự phòng: đường panel trang chủ cũ (có thể vướng popup như ghi ở trên, nhưng vẫn hơn bỏ).
    st.at = 'thả ảnh vào panel tìm-bằng-ảnh';
    await chrome.tabs.update(tab.id, { url: 'https://www.taobao.com/' });
    await waitForComplete(tab.id, 16000);
    await sleep(2500);
    const dropped = await evalInTab(tab.id, tbDropImage, [dataUrl], 20000);
    if (!dropped || !dropped.ok) {
      return {
        items: [],
        blocked: true,
        reason: 'ui',
        error: 'không cất được ảnh vào s.taobao.com (' + ((stored && (stored.error || stored.host)) || 'quá hạn')
          + ') và không thao tác được panel tìm-bằng-ảnh (' + ((dropped && dropped.stage) || 'quá hạn') + ')',
      };
    }
    if (dropped.openUrl) {
      let url = dropped.openUrl;
      if (url.startsWith('//')) url = 'https:' + url;
      else if (url.startsWith('/')) url = 'https://s.taobao.com' + url;
      await chrome.tabs.update(tab.id, { url });
      await waitForComplete(tab.id, 16000);
    }
  }

  st.at = 'chờ Taobao trả kết quả';
  const spawned = new Set();
  let lastRet = '';
  const seen = new Set();
  let keys = [];
  let shape = '';
  let nCap = 0;
  const hrefs = new Map();   // tab id → địa chỉ đang mở, cho câu chẩn đoán
  while (Date.now() < deadline) {
    await sleep(900);
    let tabs = [];
    try { tabs = await chrome.tabs.query({ url: 'https://*.taobao.com/*' }); } catch (e) { tabs = []; }
    for (const t of tabs) {
      if (t.id == null) continue;
      if (!before.has(t.id) && t.id !== tab.id) spawned.add(t.id);
      const r = await evalInTab(t.id, tbReadCapture, [], 4000);
      if (!r) continue;
      if (r.items && r.items.length) {
        await closeExtraTabs(spawned);
        return { items: r.items, blocked: false };
      }
      if (r.href) hrefs.set(t.id, String(r.href).split('?')[0].slice(0, 90) + (before.has(t.id) ? '' : ' (tab mới)'));
      if (r.ret) lastRet = r.ret;
      for (const u of (r.seen || [])) seen.add(u);
      if (r.dataKeys && r.dataKeys.length) keys = r.dataKeys;
      if (r.shape) shape = r.shape;
      if (r.nCap) nCap = Math.max(nCap, r.nCap);
      if (r.loginModal || /login\.taobao/i.test(r.href || '') || /SESSION_EXPIRED|NOT_LOGIN/i.test(r.ret || '')) {
        await focusTab(t.id);
        return { items: [], blocked: true, reason: 'login' };
      }
      if (/滑块|请拖动|向右滑|安全验证|verify|captcha/i.test(r.body || '') || /RGV587|VALIDATE/i.test(r.ret || '')) {
        await focusTab(t.id);
        return { items: [], blocked: true, reason: 'verify' };
      }
    }
  }
  await closeExtraTabs(spawned);
  let why = 'Taobao không trả kết quả trong ' + Math.round(IMAGE_JOB_BUDGET_MS / 1000) + 's';
  if (lastRet) why += ' · mtop trả: ' + lastRet
    + (keys.length ? ' · nhưng data chỉ có: ' + keys.join(', ') : '')
    + (shape ? ' · mẫu data.result: ' + shape : '');
  else if (nCap) why += ' · chộp được ' + nCap + ' response nhưng không cái nào chứa mục có item_id+title'
    + (keys.length ? ' · data có các khoá: ' + keys.join(', ') : '');
  else if (seen.size) why += ' · KHÔNG response nào khớp NEEDLES; trang vừa gọi: ' + [...seen].slice(-6).join(' ');
  else why += ' · trang chưa gọi API nào — nhiều khả năng chưa bấm được nút tìm';
  // LUÔN kèm tab đang mở và API trang đã gọi, kể cả khi đã có `mtop trả`. Đo 13/09/2026: thứ
  // duy nhất chộp được là lượt `pc_search_preload` của TRANG CHỦ — `SUCCESS` nhưng không phải kết
  // quả tìm ảnh — và nhánh `lastRet` ở trên giấu mất danh sách API, đúng thứ chỉ ra kết quả thật
  // đi đường nào (tab mới? API tên khác? JSONP mà hook không bọc được?).
  if (hrefs.size) why += ' · tab: ' + [...hrefs.values()].join(' | ');
  if (lastRet && seen.size) why += ' · API trang gọi: ' + [...seen].slice(-10).join(' ');
  return { items: [], blocked: true, reason: 'timeout', error: why };
}

/** Đóng những tab mà chính lượt tìm này làm Taobao mở thêm. Xem `before` ở trên. */
async function closeExtraTabs(ids) {
  for (const id of ids) {
    try { await chrome.tabs.remove(id); } catch (e) {}
  }
}

// ─────────────────────────── Google Lens ───────────────────────────

/**
 * Mở lớp phủ "Tìm kiếm bằng hình ảnh" trên google.com rồi THẢ ảnh vào.
 *
 * BỐN CHI TIẾT, mỗi cái từng làm cả lượt chạy trượt (đo 2026-08-17):
 *   nhãn nút   phải KHỚP CHÍNH XÁC. `[aria-label*='hình ảnh']` bắt nhầm link "Hình ảnh" trên
 *              thanh điều hướng (nhãn "Tìm kiếm hình ảnh") — gần giống, nút khác hẳn.
 *   cách bấm   `click()` bị danh sách gợi ý (`ul.dbXO9`) che. Bắn thẳng `MouseEvent` vào nút
 *              thì jsaction nhận được mà không cần con trỏ đi tới nơi.
 *   mốc chờ    phải chờ Ô DÁN LIÊN KẾT hiện ra. Chờ theo thời gian là không đủ: có lượt bấm
 *              qua rồi mà lớp phủ chưa dựng xong, cú thả rơi vào khoảng không và URL đứng yên
 *              — không lỗi, không kết quả.
 *   cách nạp   nạp vào input ẩn KHÔNG ăn. Phải dựng `DataTransfer` rồi bắn
 *              `dragenter/dragover/drop`, đúng thứ trình duyệt sinh ra khi người ta kéo ảnh vào.
 */
async function lensOpenAndDrop(dataUrl) {
  const nap = (ms) => new Promise((r) => setTimeout(r, ms));

  // Tường xin phép cookie. Chỉ bung ra với IP châu Âu nên máy-thợ ở Việt Nam không gặp — giữ
  // lại vì khi gặp thì nó che KÍN trang và mọi thao tác sau đó trượt hết mà không báo gì.
  for (const label of ['Chấp nhận tất cả', 'Accept all']) {
    const btn = [...document.querySelectorAll('button')].find((b) => (b.textContent || '').trim() === label);
    if (btn) { btn.click(); await nap(2000); break; }
  }

  // Ô tìm kiếm tự được focus lúc tải, kéo theo danh sách gợi ý bung ra đè lên nút máy ảnh.
  document.activeElement && document.activeElement.blur();
  await nap(400);

  const camera = document.querySelector(
    "[aria-label='Tìm kiếm bằng hình ảnh'], [aria-label='Search by image']"
  );
  if (!camera) return { ok: false, stage: 'camera' };
  camera.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }));

  const LINK_BOX = "input[placeholder*='liên kết'], input[placeholder*='link']";
  let box = null;
  for (let i = 0; i < 40 && !box; i++) {
    await nap(500);
    const el = document.querySelector(LINK_BOX);
    if (el && el.offsetParent !== null) box = el;
  }
  if (!box) return { ok: false, stage: 'overlay' };
  await nap(600);

  try {
    const blob = await (await fetch(dataUrl)).blob();
    const dt = new DataTransfer();
    dt.items.add(new File([blob], 'upload.jpg', { type: 'image/jpeg' }));
    // Bắn lên nhiều ứng viên vì cấu trúc DOM của Google đổi luôn, và một sự kiện thừa vô hại.
    const targets = [...document.querySelectorAll("div[role='dialog'], form, body")].slice(0, 5);
    for (const el of targets) {
      for (const type of ['dragenter', 'dragover', 'drop']) {
        el.dispatchEvent(new DragEvent(type, { bubbles: true, cancelable: true, dataTransfer: dt }));
      }
    }
    return { ok: true, targets: targets.length };
  } catch (e) {
    return { ok: false, stage: 'drop', error: String(e) };
  }
}

/**
 * Cuộn cho lưới ảnh kịp tải rồi bóc thẻ kết quả.
 *
 * KHÔNG TỐN THÊM SUẤT HẠN MỨC: cuộn không phải một lượt truy vấn mới, chỉ là để trình duyệt
 * tải nốt những tấm ảnh nó đang trì hoãn. Đo 2026-08-17 trên ba tấm ảnh đã cache: bóc ngay
 * thì 0/24 và 1/24 dòng có ảnh thu nhỏ, vì mọi `<img>` trong thẻ còn là gif 1×1 của bộ tải lười.
 *
 * BÓC THẺ: không bám vào tên class — chúng là chuỗi sinh tự động, đổi mỗi lần Google build lại.
 * CHỮ VÀ ẢNH ĐƯỢC TÌM RIÊNG, ở hai độ sâu khác nhau. Bản đầu leo một lần rồi lấy cả hai từ
 * cùng một tổ tiên, và nó lấy được chữ nhưng gần như không bao giờ lấy được ảnh. Truy ngược từ
 * ẢNH ra thẻ mới thấy vì sao: ảnh sản phẩm KHÔNG nằm trong thẻ `<a>` và cách nó tới SÁU bậc,
 * trong khi mỗi thẻ có sẵn ảnh rác ở bậc nông (favicon 32px, gif 1×1). Điều kiện dừng cũ là
 * "tổ tiên nào có <img>", mà favicon cũng là `<img>` — nên vòng lặp luôn dừng ở bậc hai-ba,
 * TRƯỚC khi tới bậc có ảnh thật. Nó không thiếu độ sâu vì đi chậm, mà vì tưởng đã tới nơi.
 */
async function lensHarvest() {
  const nap = (ms) => new Promise((r) => setTimeout(r, ms));
  const loaded = () => [...document.querySelectorAll('img')].filter((i) => i.naturalWidth >= 60).length;
  for (let i = 0; i < 5; i++) {
    if (loaded() >= 8) break;
    window.scrollBy(0, 1400);
    await nap(1200);
  }
  window.scrollTo(0, 0);
  await nap(800);

  const REAL_PX = 60; // favicon là 32, chỗ giữ chỗ là 1 — 60 nằm gọn giữa hai mức
  const TEXT_HOPS = 4;
  const IMAGE_HOPS = 7;
  const realImages = (b) => [...b.querySelectorAll('img')].filter((im) => (im.naturalWidth || 0) >= REAL_PX);

  const out = [];
  const seen = new Set();
  for (const a of document.querySelectorAll("a[href^='http']")) {
    const href = a.href;
    if (href.includes('google.') || href.includes('gstatic')) continue;
    if (seen.has(href)) continue;
    seen.add(href);

    // Chữ: tổ tiên gần nhất có đủ chữ. Leo cao hơn là bắt đầu nuốt chữ của thẻ bên cạnh.
    let textBox = a;
    for (let i = 0; i < TEXT_HOPS && textBox.parentElement; i++) {
      textBox = textBox.parentElement;
      if (textBox.innerText.trim().length > 20) break;
    }
    const text = (textBox.innerText || '').trim();
    if (!text) continue;

    // Ảnh: leo tiếp cho tới tổ tiên đầu tiên CÓ ẢNH THẬT. Chặn bằng số link bên trong — một
    // hộp ôm nhiều link là hộp chứa NHIỀU thẻ, và lấy ảnh ở đó là gán ảnh của thẻ hàng xóm.
    let best = null;
    let box = a;
    for (let i = 0; i < IMAGE_HOPS && box.parentElement; i++) {
      box = box.parentElement;
      const found = realImages(box);
      if (!found.length) continue;
      if (box.querySelectorAll("a[href^='http']").length > 2) break;
      // Lớn nhất, không phải đầu tiên: một hộp vẫn có thể chứa cả ảnh phụ.
      best = found.sort((x, y) => y.naturalWidth * y.naturalHeight - x.naturalWidth * x.naturalHeight)[0];
      break;
    }

    // Chữ nằm TRONG HỘP ẢNH mà KHÔNG có ở hộp chữ là nhãn dán đè lên ảnh, và Lens để GIÁ đúng
    // ở đó ("54.000 ₫*" góc trên trái) chứ không để cùng tên nguồn và tiêu đề. Chỉ đọc khi ĐÃ
    // tìm ra ảnh thật: lúc ấy `box` dừng đúng ở hộp của thẻ này. Không có ảnh thì vòng leo chạy
    // hết bảy nấc và `box` thành hộp ôm cả chục thẻ — nhãn nhặt ở đó là giá của thẻ khác.
    const overlay = (best && box !== textBox)
      ? [...new Set((box.innerText || '').split('\n').map((s) => s.trim()).filter(Boolean))]
          .filter((line) => !text.includes(line))
          .slice(0, 4)
      : [];

    out.push({
      href,
      overlay,
      lines: text.split('\n').map((s) => s.trim()).filter(Boolean).slice(0, 8),
      thumbnail: best ? (best.currentSrc || best.src) : null,
    });
    if (out.length >= 40) break;
  }
  return { cards: out, href: location.href };
}

/** Ảnh → thẻ kết quả Google Lens. Trả `{ cards, blocked, reason, error }`. */
function lensImageSearch(dataUrl, language) {
  // Cùng lỗ hổng cấu trúc với Taobao: `deadline` chỉ chi phối vòng quét cuối, mọi bước mở
  // tab / thả ảnh trước đó treo là treo im. Bọc cả lượt lại — xem `withStageBudget`.
  return withStageBudget(IMAGE_JOB_BUDGET_MS, (st) => lensImageRun(dataUrl, language, st));
}

async function lensImageRun(dataUrl, language, st) {
  st.at = 'mở lớp phủ tìm-bằng-ảnh của Google';
  const deadline = Date.now() + IMAGE_JOB_BUDGET_MS - IMAGE_REPORT_MARGIN_MS;
  const tab = await keptTab('lens');
  await chrome.tabs.update(tab.id, { url: 'https://www.google.com/?hl=' + encodeURIComponent(language || 'vi') });
  // ĐƯA TAB RA TRƯỚC. Không phải để người dùng xem: lưới kết quả tải ảnh theo kiểu lười, mà
  // tab nền thì Chrome không paint — cuộn bao nhiêu cũng không tấm nào chuyển sang ảnh thật,
  // và mọi dòng trả về sẽ không có ảnh thu nhỏ.
  await focusTab(tab.id);
  await waitForComplete(tab.id, 16000);
  await sleep(2000);

  const url0 = await evalInTab(tab.id, () => location.href, [], 4000);
  if (typeof url0 === 'string' && url0.includes('/sorry')) return { cards: [], blocked: true, reason: 'sorry' };

  const dropped = await evalInTab(tab.id, lensOpenAndDrop, [dataUrl], 30000);
  if (!dropped || !dropped.ok) {
    return {
      cards: [],
      blocked: true,
      reason: 'ui',
      error: 'không mở được lớp phủ tìm-bằng-ảnh (' + ((dropped && dropped.stage) || 'quá hạn') + ')',
    };
  }

  // CHỜ BẰNG CÁCH THĂM DÒ `location.href`. Sau cú thả, Google đi qua một chuỗi chuyển hướng;
  // chờ theo sự kiện điều hướng thì gãy giữa chừng với "context was destroyed" — tức là BÁO
  // LỖI đúng vào lúc mọi thứ đang chạy đúng.
  let landed = false;
  while (Date.now() < deadline) {
    await sleep(1500);
    const href = await evalInTab(tab.id, () => location.href, [], 4000);
    if (typeof href !== 'string') continue;
    if (href.includes('/sorry')) return { cards: [], blocked: true, reason: 'sorry' };
    if (href.includes('/search')) { landed = true; break; }
  }
  if (!landed) return { cards: [], blocked: true, reason: 'timeout', error: 'Google không nhận ảnh' };

  await sleep(5000);
  const got = await evalInTab(tab.id, lensHarvest, [], 20000);
  if (!got || !Array.isArray(got.cards)) {
    return { cards: [], blocked: true, reason: 'harvest', error: 'không bóc được thẻ kết quả' };
  }
  if (!got.cards.length && (got.href || '').includes('/sorry')) {
    return { cards: [], blocked: true, reason: 'sorry' };
  }
  return { cards: got.cards, blocked: false };
}

// HẠ NHIỆT NẰM Ở ĐÂY, không nằm trong từng hàm tìm kiếm: chỗ này thấy được mọi đường ra —
// thành công, lỗi, lẫn ngoại lệ — mà những lần hỏng mới đúng là lúc trang nặng bị bỏ lại.
// `.finally` chạy SAU `sendResponse`, nên việc dọn không làm chậm kết quả trả về.
chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  if (!msg || typeof msg !== 'object') return;

  if (msg.type === 'RS_PING') {
    sendResponse({ ok: true, version: VERSION });
    return;
  }

  // Đọc MỘT cookie theo tên, cho trang Research dò xem đã đăng nhập sàn nào.
  //
  // Chỉ service worker mới có `chrome.cookies` (trang web thì không, kể cả trang cùng miền —
  // cookie đăng nhập của các sàn đều là HttpOnly). Trang gọi qua cầu `content.js`.
  //
  // Trả về cookie NGUYÊN VẸN chứ không phải true/false: `research.js` tự quyết định thế nào là
  // "đã đăng nhập" theo từng sàn (Shopee coi `SPC_U === '-'` là chưa). TikTok Shop KHÔNG còn đi
  // đường này: từ 2026-09-14 nó hỏi phiên Kalodata qua `RS_KD_STATUS`.
  if (msg.type === 'RS_COOKIE') {
    try {
      chrome.cookies.get({ url: msg.url, name: msg.name }, (c) => {
        sendResponse({ ok: true, cookie: c ? { name: c.name, value: c.value, domain: c.domain } : null });
      });
    } catch (e) {
      sendResponse({ ok: false, cookie: null, error: String(e) });
    }
    return true; // giữ kênh mở cho phản hồi bất đồng bộ
  }

  if (msg.type === 'RS_FETCH') {
    handleFetch(msg.requests).then((responses) => sendResponse({ ok: true, responses }));
    return true; // giữ kênh mở cho phản hồi bất đồng bộ
  }

  if (msg.type === 'RS_FIND_SIMILAR') {
    findSimilar(msg.url).then((r) => sendResponse({
      ok: !!(r && (r.text || typeof r.domMin === 'number')),
      text: (r && r.text) || '',
      domMin: r ? r.domMin : null,
    }));
    return true;
  }

  if (msg.type === 'RS_COST_BATCH') {
    costBatch(msg.seedUrl, msg.products || []).then((results) => sendResponse({ ok: true, results }));
    return true;
  }

  // Slot tab RIÊNG (không `withCooldown` chung với sàn nào): Trends chạy trên google.com, và nhịp
  // gọi của nó do `TRENDS_MIN_INTERVAL_MS` bên backend giữ chứ không phải cooldown ở đây.
  if (msg.type === 'RS_TRENDS_RELATED') {
    trendsRelatedGuarded(msg).then((r) => sendResponse({ ok: true, ...r })).catch((e) => sendResponse({ ok: true, responses: [], frames: [], error: String(e) }));
    return true;
  }

  if (msg.type === 'RS_FB_ADLIB') {
    withHeartbeat(fbAdLibrary(msg)).then((r) => sendResponse({ ok: true, ...r })).catch((e) => sendResponse({ ok: true, pages: [], error: String(e) }));
    return true;
  }

  if (msg.type === 'RS_1688') {
    withCooldown('ali1688', search1688(msg.keyword, msg.count).then((r) => sendResponse({ ok: true, ...r })));
    return true;
  }

  if (msg.type === 'RS_TAOBAO') {
    withCooldown('taobao', searchTaobao(msg.keyword, msg.count).then((r) => sendResponse({ ok: true, ...r })).catch((e) => sendResponse({ ok: true, items: [], blocked: false, error: String(e) })));
    return true;
  }

  if (msg.type === 'RS_TAOBAO_IMAGE') {
    withCooldown('taobao', taobaoImageSearch(msg.dataUrl).then((r) => sendResponse({ ok: true, ...r })).catch((e) => sendResponse({ ok: true, items: [], blocked: true, reason: 'error', error: String(e) })));
    return true;
  }

  // Lens dùng slot tab RIÊNG, không dùng chung với nguồn từ khoá nào: nó là nguồn duy nhất
  // chạy trên google.com, và trộn vào một slot sàn sẽ khiến hai job cùng giành một tab.
  if (msg.type === 'RS_LENS_IMAGE') {
    withCooldown('lens', lensImageSearch(msg.dataUrl, msg.language).then((r) => sendResponse({ ok: true, ...r })).catch((e) => sendResponse({ ok: true, cards: [], blocked: true, reason: 'error', error: String(e) })));
    return true;
  }

  if (msg.type === 'RS_TEMU') {
    withCooldown('temu', searchTemu(msg.keyword, msg.count).then((r) => sendResponse({ ok: true, ...r })).catch((e) => sendResponse({ ok: true, items: [], blocked: false, error: String(e) })));
    return true;
  }

  if (msg.type === 'RS_AMAZON') {
    withCooldown('amazon', amazonSearch(msg.domain, msg.url).then((r) => sendResponse({ ok: true, ...r })));
    return true;
  }

  // `withHeartbeat`: ngân sách 120 giây, và có quãng chỉ ngồi chờ trang tải — không giữ nhịp thì
  // MV3 giết service worker giữa job và `sendResponse` mất theo.
  // Nguồn video qua Google: một lần tải trang, không đăng nhập, không cá nhân hoá. Slot tab
  // riêng ('googlevid') để không giành tab với Lens hay Trends — cả ba đều ở trên google.com.
  if (msg.type === 'RS_GOOGLE_VIDEOS') {
    withCooldown('googlevid', withHeartbeat(searchGoogleVideos(msg)).then((r) => sendResponse({ ok: true, ...r })).catch((e) => sendResponse({ ok: true, items: [], blocked: false, error: String(e) })));
    return true;
  }

  if (msg.type === 'RS_TIKTOK') {
    withCooldown('tiktok', withHeartbeat(searchTiktok(msg.keyword, msg.count, msg.keywords, msg.region, msg.mode, msg.anchor)).then((r) => sendResponse({ ok: true, ...r })).catch((e) => sendResponse({ ok: true, items: [], blocked: false, error: String(e) })));
    return true;
  }

  if (msg.type === 'RS_TIKTOK_CC') {
    withCooldown('tkcc', searchTiktokCreative(msg.region, msg.keyword, msg.count).then((r) => sendResponse({ ok: true, ...r })).catch((e) => sendResponse({ ok: true, items: [], blocked: false, error: String(e) })));
    return true;
  }

  if (msg.type === 'RS_DOUYIN') {
    withCooldown('douyin', withHeartbeat(searchDouyin(msg.keyword, msg.count, msg.keywords, msg.anchor)).then((r) => sendResponse({ ok: true, ...r })).catch((e) => sendResponse({ ok: true, items: [], blocked: false, error: String(e) })));
    return true;
  }

  // Nguồn từ khoá cho tab Keyword. Trả `groups` (mỗi cụm gốc một nhóm) chứ không phải một
  // mảng phẳng: backend cần biết gợi ý đến TỪ cụm nào để ghi `via_term` khi xếp hạng.
  if (msg.type === 'RS_TEMU_SUGGEST') {
    const temuGuard = { groups: [], blocked: true, debug: { stage: 'không rõ — handler quá hạn' }, error: 'job Temu quá 75s trong extension, đã bỏ dở' };
    withCooldown('temuSuggest', withTimeout(temuSuggestBatch(msg.terms, msg.region), 75000, temuGuard).then((r) => sendResponse({ ok: true, ...r })).catch((e) => sendResponse({ ok: true, groups: [], blocked: false, error: String(e) })));
    return true;
  }

  // TikTok Shop qua KALODATA (`kalodata.js`). Không `withCooldown`: không dùng kho tab chung —
  // chỉ khi cookie không đi thẳng từ service worker mới mượn một tab kalodata.com riêng.
  // `withHeartbeat` vì đường tab có quãng ngồi chờ trang tải.
  if (msg.type === 'RS_KD_PRODUCT' || msg.type === 'RS_KD_VIDEO') {
    const kind = msg.type === 'RS_KD_PRODUCT' ? 'product' : 'video';
    withHeartbeat(kdCrawl(kind, msg.opts || {}))
      .then((r) => sendResponse({ ok: true, kind, ...r }))
      .catch((e) => sendResponse({ ok: true, kind, items: [], error: String(e) }));
    return true;
  }

  if (msg.type === 'RS_KD_STATUS') {
    withHeartbeat(kdStatus())
      .then((r) => sendResponse({ ok: true, ...r }))
      .catch((e) => sendResponse({ ok: true, loggedIn: null, error: String(e) }));
    return true;
  }

  if (msg.type === 'RS_SHOPEE') {
    const shopeeHost = msg.domain || 'shopee.vn';
    withCooldown(`site:${shopeeHost}`, searchShopee(msg).then((r) => sendResponse({ ok: true, ...r })).catch((e) => sendResponse({ ok: true, texts: [], blocked: false, error: String(e) })), `https://${shopeeHost}/`);
    return true;
  }
});
