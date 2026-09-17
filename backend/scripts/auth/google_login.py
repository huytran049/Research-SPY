"""
Đăng nhập Google một lần, lưu lại phiên cho server dùng.

    cd backend
    python -m scripts.auth.google_login
    python -m scripts.auth.google_login --fresh              # xoá hồ sơ Chrome, đăng nhập từ đầu
    python -m scripts.auth.google_login --name 2 --no-verify # thêm một tài khoản vào hồ

Script mở một cửa sổ Chrome thật và dừng lại chờ. Bạn tự đăng nhập bằng tay — script không
đọc, không nhập và không lưu mật khẩu; nó chỉ chờ cho tới khi trình duyệt có cookie đăng
nhập, rồi ghi trạng thái phiên ra `backend/.auth/google.json` (đã nằm trong `.gitignore`).

NHIỀU TÀI KHOẢN: `--name <tên>` ghi ra `google-<tên>.json` và dùng một hồ sơ Chrome RIÊNG.
Server tự gom mọi file `google*.json` thành một hồ và tự xoay khi một tài khoản cạn suất —
xem `pick_session` ở `lib/core/auth.py`. Thêm tài khoản là việc MỘT LẦN và không phải restart
backend; hồ quét lại thư mục ở mỗi lượt gọi.

Đo 2026-08-14: hạn mức của bảng truy vấn liên quan bám theo TÀI KHOẢN, không theo IP — cùng
một mạng, tài khoản này trả bảng rỗng thì tài khoản khác vẫn trả bảng đầy đủ.

`--no-verify` bỏ bước gọi thật vào Trends ở cuối. Nên dùng khi đang gom tài khoản: bước kiểm
chứng tiêu đúng một suất của chính tài khoản vừa tạo, mà cái ta cần là giữ nó đầy.

DÙNG `--fresh` KHI GOOGLE ĐÃ THU HỒI PHIÊN. Cookie bị thu hồi vẫn nằm nguyên trong hồ sơ
Chrome và vẫn còn hạn cả năm — nó chỉ mất hiệu lực ở phía Google. Chạy lại kiểu thường khi đó
sẽ đi vào một cái bẫy: script thấy cookie `SID` có sẵn, kết luận "đã đăng nhập" ngay lập tức,
và bạn không bao giờ được đưa tới màn hình đăng nhập. `--fresh` xoá hồ sơ nên buộc phải đăng
nhập thật, và cookie mới mới là cookie Google còn nhận.

VÌ SAO PHẢI LÀM VIỆC NÀY: widget truy vấn liên quan của Google Trends trả về HTTP 200 kèm
danh sách RỖNG cho người gọi ẩn danh — không báo lỗi, không 403, chỉ là không có gì. Đó là
kiểu chặn đã từng khiến cả hướng đi này bị kết luận nhầm là "Trends không có dữ liệu cho
cụm bán lẻ tiếng Việt".

Vì thế script KHÔNG dừng ở chỗ thấy cookie. Nó gọi thật một lần vào Trends và chỉ lưu phiên
khi lời gọi đó trả về truy vấn thật. Một file phiên hợp lệ về hình thức nhưng vô dụng khi
chạy còn tệ hơn là không có file nào.

LƯU Ý: hãy dùng một tài khoản Google riêng cho việc này, không dùng tài khoản chính. Tự động
hoá Trends bằng phiên đăng nhập có thể bị Google gắn cờ, và ảnh hưởng sẽ áp dụng cho chính tài khoản đó.
"""

from __future__ import annotations

import asyncio
import shutil
import sys
from urllib.parse import quote

from playwright.async_api import BrowserContext, Page, async_playwright

from lib.core.auth import AUTH_DIR, GOOGLE_SESSION, storage_state_path
from lib.core.browser import adopt_playwright
from lib.core.config import config
from lib.keywords.trends import TRENDS_HOST, fetch_related_queries
from lib.keywords.types import SearchContext

#: Hồ sơ Chrome riêng cho việc này. Giữ lại giữa các lần chạy để lần sau thường không phải
#: đăng nhập lại từ đầu, và để Google thấy một trình duyệt quen thay vì một hồ sơ trắng.
PROFILE_DIR = AUTH_DIR / "chrome-profile"


def _slug() -> str:
    """Hậu tố `--name` nếu có. Rỗng nghĩa là tài khoản mặc định."""
    if "--name" not in sys.argv:
        return ""
    at = sys.argv.index("--name") + 1
    return sys.argv[at].strip() if at < len(sys.argv) else ""


def _session_name(slug: str) -> str:
    """`google`, `google-2`, `google-cty`… Khớp với `session_paths` ở `lib/core/auth.py`."""
    return f"{GOOGLE_SESSION}-{slug}" if slug else GOOGLE_SESSION


def _profile_dir(slug: str) -> Path:
    """
    MỖI TÀI KHOẢN MỘT HỒ SƠ CHROME, và đây là điều kiện bắt buộc chứ không phải cho gọn.

    Chrome chỉ giữ được một phiên Google trong một hồ sơ. Dùng chung hồ sơ cho hai tài khoản
    thì lần đăng nhập sau đè lên lần trước, và bạn sẽ chụp ra hai file phiên của CÙNG một tài
    khoản mà không có dấu hiệu nào cho biết — cả hồ phiên khi đó vô dụng vì chúng chia chung
    một bình chứa.
    """
    return AUTH_DIR / (f"chrome-profile-{slug}" if slug else "chrome-profile")

#: Từ gốc dùng để kiểm chứng. Một cụm bán lẻ tiếng Việt bình thường — đúng loại mà phiên ẩn
#: danh trả về rỗng, nên nó phân biệt được "đã đăng nhập" với "trông như đã đăng nhập".
PROBE_SEED = "quần áo nam"

LOGIN_TIMEOUT_SECONDS = 15 * 60


async def _open_browser(playwright, profile_dir: Path) -> BrowserContext:
    """
    Ưu tiên Chrome thật của máy; Chromium đi kèm Playwright hay bị Google chặn ở màn hình
    đăng nhập với thông báo "trình duyệt này có thể không an toàn".
    """
    profile_dir.mkdir(parents=True, exist_ok=True)
    common = {
        "user_data_dir": str(profile_dir),
        "headless": False,
        "locale": "vi-VN",
        "viewport": {"width": 1440, "height": 960},
        "args": ["--disable-blink-features=AutomationControlled"],
    }
    try:
        return await playwright.chromium.launch_persistent_context(channel="chrome", **common)
    except Exception:
        print("  (không tìm thấy Chrome của máy — dùng Chromium đi kèm Playwright)")
        return await playwright.chromium.launch_persistent_context(**common)


async def _current_sid(context: BrowserContext) -> str | None:
    """Giá trị cookie `SID` hiện có trong hồ sơ, hoặc `None` khi chưa đăng nhập."""
    try:
        cookies = await context.cookies("https://www.google.com")
    except Exception:
        return None
    for cookie in cookies:
        if cookie.get("name") == "SID" and cookie.get("value"):
            return str(cookie["value"])
    return None


async def _wait_for_login(context: BrowserContext, page: Page) -> bool:
    """Chờ tới khi trình duyệt có cookie đăng nhập của Google. Trả về False nếu hết giờ."""
    for _ in range(LOGIN_TIMEOUT_SECONDS // 3):
        if page.is_closed():
            print("\nCửa sổ trình duyệt đã bị đóng.")
            return False
        if await _current_sid(context) is not None:
            return True
        await asyncio.sleep(3)
    print(f"\nHết {LOGIN_TIMEOUT_SECONDS // 60} phút chờ mà chưa thấy đăng nhập.")
    return False


#: Câu chẩn đoán cho trường hợp hồ sơ Chrome còn phiên cũ đã bị Google thu hồi.
#:
#: Cần nói riêng, vì thông báo mặc định ("thử tài khoản khác") chỉ đúng khi người dùng THẬT SỰ
#: vừa đăng nhập. Khi cookie `SID` không đổi thì họ chưa đăng nhập lần nào — script tự nhận
#: bừa là đã xong — nên bảo họ đổi tài khoản là đẩy họ đi sai đường hoàn toàn.
STALE_PROFILE_HINT = (
    "Cookie SID không thay đổi — bạn CHƯA đăng nhập lại lần nào. Hồ sơ Chrome còn giữ phiên cũ\n"
    "mà Google đã thu hồi, nên script thấy cookie có sẵn và bỏ qua bước đăng nhập.\n"
    "Chạy lại kèm --fresh để xoá hồ sơ và đăng nhập thật:\n"
    "    python -m scripts.auth.google_login --fresh"
)


#: Cookie mà Google đòi ĐI KÈM `__Secure-1PSID` thì mới coi phiên là hợp lệ trên các trang
#: google.com. Thiếu nó, phiên vẫn "trông đúng" — đủ cookie, chưa hết hạn — nhưng Trends đối
#: xử với người gọi như khách vãng lai: trang vẫn dựng, RPC vẫn bắn, vẫn trả HTTP 200, và
#: payload rỗng. Đúng kiểu chặn mà cả file này sinh ra để phát hiện.
SESSION_BOUND_COOKIES = ("__Secure-1PSIDTS", "__Secure-3PSIDTS")

#: Cookie ghi việc người dùng đã trả lời thanh xin phép cookie của Google.
#:
#: Tách khỏi `SESSION_BOUND_COOKIES` vì nó hỏng theo kiểu khác: phiên vẫn đăng nhập thật —
#: trang /explore hiện đúng avatar tài khoản — nhưng Google có thể giữ lại dữ liệu.
#:
#: MỨC ĐỘ NGHIÊM TRỌNG THẤP HƠN VẺ NGOÀI, và cần nói rõ để không lặp lại sai lầm cũ của file
#: này. Đo 2026-08-04: một lượt đăng nhập THIẾU `SOCS` vẫn qua được bước kiểm chứng, lấy về
#: đủ "shop quần áo nam", "áo sơ mi nam"… Nên thiếu nó là một cảnh báo, KHÔNG phải chẩn đoán
#: — thấy nó mà dữ liệu vẫn rỗng thì đừng dừng ở đây, đi kiểm 429 và địa chỉ trang trước.
CONSENT_COOKIE = "SOCS"

#: Tên miền dùng để soi cookie sau khi chụp.
COOKIE_HOSTS = ("https://trends.google.com", "https://trends.google.com.vn")

#: Chữ trên nút đồng ý, theo thứ tự ưu tiên. Có cả bản tiếng Anh vì trang đổi ngôn ngữ theo
#: tài khoản chứ không theo `locale` ta đặt cho trình duyệt.
CONSENT_BUTTONS = (
    # Thanh cookie của Trends dùng đúng chữ này — đo 2026-08-04 bằng ảnh chụp màn hình, và
    # nó là lý do lượt trước không bấm được: cả bảy nhãn còn lại đều trượt.
    "OK, got it",
    "got it",
    "Đã hiểu",
    "Tôi hiểu",
    "Chấp nhận tất cả",
    "Đồng ý tất cả",
    "Đồng ý",
    "I understand",
    "Accept all",
    "I agree",
)


async def _accept_cookie_notice(page: Page) -> bool:
    """
    Bấm thanh xin phép cookie, nếu nó có mặt. Trả về True khi đã bấm được.

    Không coi việc không tìm thấy nút là lỗi: hồ sơ đã trả lời từ trước thì thanh không hiện,
    và đó là kết cục tốt chứ không phải sự cố.
    """
    for label in CONSENT_BUTTONS:
        try:
            button = page.get_by_role("button", name=label, exact=False).first
            await button.click(timeout=2_500)
            await asyncio.sleep(2)
            return True
        except Exception:
            continue
    return False


async def _wait_until_navigation_stops(page: Page, timeout_seconds: float = 20) -> None:
    """Chờ URL và document đứng yên trước khi chụp storage state.

    Luồng `ServiceLogin?continue=...` có thể hoàn tất `domcontentloaded` rồi mới chuyển hướng
    thêm một lần bằng JavaScript. Chụp đúng lúc ấy làm frame bị tháo khỏi page và Playwright
    báo `net::ERR_ABORTED; maybe frame was detached`.
    """
    deadline = asyncio.get_running_loop().time() + timeout_seconds
    last_url = ""
    stable_ticks = 0
    while asyncio.get_running_loop().time() < deadline:
        await asyncio.sleep(0.5)
        try:
            current_url = page.url
            ready = await page.evaluate("document.readyState")
        except Exception:
            stable_ticks = 0
            continue
        if current_url == last_url and ready in {"interactive", "complete"}:
            stable_ticks += 1
            if stable_ticks >= 4:
                return
        else:
            last_url = current_url
            stable_ticks = 0


async def _warm_up_google_domain(page: Page) -> None:
    """
    Cấp cookie cho tên miền Trends bằng CHÍNH trình duyệt sắp được xuất phiên.

    Đây là bước từng thiếu, và nó thiếu một cách rất khó thấy. Script chỉ mở
    `accounts.google.com` rồi chụp ngay — nhưng `accounts.google.com` không phát
    `__Secure-1PSIDTS` cho `.google.com`; trang google.com mới phát. Nên file phiên xuất ra có
    đủ `SID`, `HSID`, `SAPISID`, `__Secure-1PSID` — mọi thứ trông đúng — mà vẫn thiếu đúng cái
    cookie quyết định. Đo 2026-08-04 trên một phiên vừa đăng nhập: `google.json` có
    `__Secure-1PSIDTS` trên `.youtube.com` nhưng KHÔNG có trên `.google.com`.

    Ghé Google trước để làm mới cookie `.google.com`, sau đó đi qua ServiceLogin đúng một lần
    để chuyển phiên sang tên miền Trends hiện tại. Không mở `/explore`, không cuộn và không
    gọi RPC dữ liệu: bước kiểm chứng phía sau mới được phép tiêu đúng một lượt Trends.

    PHẢI GHÉ CẢ TÊN MIỀN QUỐC GIA, và đây là cùng một bài học lặp lại ở mức tên miền. Cookie
    đăng nhập được cấp cho ĐÚNG tên miền mà trình duyệt thật sự ghé qua: ghé
    `trends.google.com` thì chỉ có cookie `.google.com`. Đo 2026-08-04 trên một phiên vừa đăng
    nhập thành công: `google.json` có 17 cookie cho `.google.com` và ĐÚNG 0 cookie cho
    `.google.com.vn` — nên mở `trends.google.com.vn/explore` bằng phiên đó ra thẳng màn hình
    "Đăng nhập để sử dụng Gemini", tức là khách vãng lai.

    Điều đó quan trọng vì trang Khám phá mới của Google phục vụ người Việt ở tên miền quốc
    gia, và nó là trang duy nhất có cột "Thay đổi" cho bảng truy vấn hàng đầu.
    """
    trends_origin = f"https://{TRENDS_HOST}"
    targets = (
        ("Google", "https://www.google.com/"),
        (
            TRENDS_HOST,
            "https://accounts.google.com/ServiceLogin?continue="
            + quote(f"{trends_origin}/", safe=""),
        ),
    )
    for label, url in targets:
        try:
            await page.goto(url, wait_until="domcontentloaded", timeout=90_000)
            await _wait_until_navigation_stops(page)
            if await _accept_cookie_notice(page):
                print(f"  (đã bấm đồng ý thanh cookie trên {label})")
                await _wait_until_navigation_stops(page)
        except Exception as error:
            # Không chặn luồng: đây là bước làm nóng, phép kiểm chứng thật nằm ở `_verify`.
            print(f"  (không ghé được {label} để làm nóng phiên: {error})")


async def _save_storage_state(context: BrowserContext, path) -> None:
    """Chụp phiên, thử lại khi Google vừa thay frame trong lúc chuyển hướng."""
    for attempt in range(3):
        try:
            await context.storage_state(path=str(path))
            return
        except Exception as error:
            transient = "ERR_ABORTED" in str(error) or "frame was detached" in str(error)
            if not transient or attempt == 2:
                raise
            await asyncio.sleep(2)


async def _missing_session_cookies(context: BrowserContext) -> list[str]:
    """
    Cookie còn thiếu, kiểm trên TỪNG tên miền của `COOKIE_HOSTS`.

    Kiểm từng tên miền riêng chứ không gộp: một phiên đủ cookie ở `.google.com` mà trống trơn
    ở `.google.com.vn` vẫn là phiên hỏng một nửa, và nửa hỏng ấy nằm đúng ở trang mà Google
    phục vụ người Việt. Trước đây chỉ soi `.com` nên nửa kia lặng lẽ vắng mặt.
    """
    missing: list[str] = []
    for host in COOKIE_HOSTS:
        try:
            cookies = await context.cookies(host)
        except Exception:
            continue
        present = {c["name"] for c in cookies if c.get("value")}
        domain = host.replace("https://trends.", "")
        # Không có `SID` nghĩa là ẩn danh hoàn toàn ở tên miền này — nói thẳng như vậy thay vì
        # liệt kê từng cookie con, vì nguyên nhân và cách sửa khác hẳn.
        if "SID" not in present:
            missing.append(f"toàn bộ phiên trên {domain}")
            continue
        missing += [f"{n} trên {domain}" for n in (*SESSION_BOUND_COOKIES, CONSENT_COOKIE) if n not in present]
    return missing


async def _verify(page: Page) -> tuple[str, str]:
    """
    Gọi thật vào Trends và xem có truy vấn liên quan không.

    Trả về `("ok" | "needs_login" | "error", mô tả)`.

    Cố ý đi qua ĐÚNG hàm mà server dùng, không dựng lại một đường gọi riêng. Một script kiểm
    chứng có đường đi khác với đường chạy thật thì nó chứng minh nhầm thứ: nó chỉ chứng minh
    chính nó chạy được.

    Vì hàm đó đọc phiên từ đĩa nên nơi gọi phải lưu phiên TRƯỚC khi kiểm chứng.
    """
    outcome = await fetch_related_queries(PROBE_SEED, SearchContext(country="VN"))

    if outcome.queries:
        top = [q.query for q in outcome.queries if not q.rising][:5]
        return "ok", "ví dụ lấy được: " + ", ".join(top)
    if outcome.needs_login:
        return "needs_login", outcome.message or "phiên chưa có quyền đọc Trends"
    return "error", outcome.message or "không lấy được dữ liệu"


async def main() -> int:
    print(__doc__)
    print("=" * 78)

    slug = _slug()
    profile_dir = _profile_dir(slug)
    session_name = _session_name(slug)
    skip_verify = "--no-verify" in sys.argv

    if slug:
        print(f"\nTài khoản phụ `{slug}` — phiên sẽ ghi vào {session_name}.json")

    if "--fresh" in sys.argv:
        shutil.rmtree(profile_dir, ignore_errors=True)
        print("\nĐã xoá hồ sơ Chrome cũ — bạn sẽ phải đăng nhập từ đầu.")

    async with async_playwright() as playwright:
        # Bước kiểm chứng gọi vào code server, mà code đó tự start driver Playwright của riêng
        # nó. Giao lại driver đang có để cả tiến trình chỉ nuôi MỘT driver — hai cái cùng lúc
        # là tình huống đã treo vô hạn ở `chromium.launch()` (xem `adopt_playwright`).
        adopt_playwright(playwright)
        context = await _open_browser(playwright, profile_dir)
        try:
            page = context.pages[0] if context.pages else await context.new_page()
            initial_sid = await _current_sid(context)
            await page.goto("https://accounts.google.com/", wait_until="domcontentloaded")

            # Nói đúng việc script sắp làm. Khi hồ sơ đã có phiên sẵn, nó KHÔNG chờ gì cả —
            # in "hãy đăng nhập rồi để yên" khi đó là bảo người dùng ngồi chờ một thứ sẽ không
            # bao giờ tới, và đó đúng là chuyện đã xảy ra ngày 2026-07-30.
            if initial_sid is None:
                print("\n>>> Đăng nhập vào tài khoản Google trong cửa sổ vừa mở, rồi để yên.")
                print(">>> Script tự nhận ra khi bạn xong. Đừng đóng cửa sổ.\n")
            else:
                print("\nHồ sơ Chrome này ĐÃ có phiên đăng nhập sẵn, nên script không chờ bạn")
                print("làm gì — nó đi thẳng sang bước kiểm chứng.")
                print("Cứ để nó chạy: nếu tài khoản còn sống thì Chrome tự làm mới cookie và bạn")
                print("không phải nhập lại gì. Chỉ khi bước kiểm chứng THẤT BẠI thì mới cần")
                print("`--fresh` — lúc đó phiên sẵn có đã bị Google thu hồi thật.\n")

            if not await _wait_for_login(context, page):
                return 1
            reused_old_session = initial_sid is not None and await _current_sid(context) == initial_sid

            # Làm nóng TRƯỚC khi chụp. Thứ tự này là cả nội dung của bản sửa — xem
            # `_warm_up_google_domain`.
            print("\nĐang ghé Trends một vòng để Google cấp cookie ràng buộc phiên…")
            await _warm_up_google_domain(page)

            # Lưu trước rồi mới kiểm chứng: phép kiểm chứng chạy đúng hàm của server, mà hàm
            # đó đọc phiên từ đĩa. Kiểm trước khi lưu là kiểm một file chưa tồn tại.
            AUTH_DIR.mkdir(parents=True, exist_ok=True)
            path = storage_state_path(session_name)
            await _wait_until_navigation_stops(page)
            await _save_storage_state(context, path)

            missing = await _missing_session_cookies(context)
            if missing:
                # Nói ngay tại chỗ chứ không để nó lộ ra sau đó dưới dạng "Trends không có dữ
                # liệu" — hai câu đó dẫn người đọc đi hai hướng hoàn toàn khác nhau.
                print("  CẢNH BÁO: phiên còn thiếu —")
                for item in missing:
                    print(f"    · {item}")
                if any(item.startswith("toàn bộ phiên") for item in missing):
                    print(
                        "  Ẩn danh hoàn toàn ở tên miền đó: trang Khám phá mới sẽ hiện màn hình\n"
                        '  "Đăng nhập để sử dụng Gemini" thay vì dữ liệu.'
                    )
                elif any(item.startswith(CONSENT_COOKIE) for item in missing):
                    print(
                        "  Chưa trả lời thanh xin phép cookie — Google vẫn cho đăng nhập nhưng\n"
                        "  có thể giữ lại dữ liệu. Bấm nút đồng ý ở thanh dưới đáy rồi chạy lại."
                    )
                else:
                    print("  Phiên có thể bị Trends coi như khách vãng lai.")

            if skip_verify:
                # Bước kiểm chứng TIÊU một suất trong đúng cái bình mà tài khoản này vừa được
                # tạo ra để giữ đầy. Khi đang gom nhiều tài khoản thì đó là việc phản tác dụng,
                # nên `--no-verify` tồn tại — đổi lấy việc không biết phiên có đọc được Trends
                # không cho tới lần dùng thật đầu tiên.
                print(f"\nĐã lưu phiên vào {path} (bỏ qua kiểm chứng theo --no-verify)")
                print("Server sẽ tự dùng phiên này cùng các phiên khác trong thư mục .auth/.")
                return 0

            print("Đã lưu phiên. Đang kiểm chứng bằng đúng đường mà server dùng…")
            # Nói theo đúng cấu hình đang chạy. Câu cũ hứa "mở một cửa sổ nữa" bất kể
            # `config.headless`, nên với cấu hình mặc định (ẩn) người dùng ngồi chờ một cửa sổ
            # không bao giờ hiện, rồi tưởng script đã treo.
            where = "chạy ẩn, KHÔNG có cửa sổ nào hiện ra" if config.headless else "mở một cửa sổ nữa"
            print(f"(gọi thật vào Google Trends — {where}, mất khoảng một phút)\n")
            status, detail = await _verify(page)

            if status == "ok":
                print(f"Kiểm chứng đạt — {detail}")
                print(f"\nĐã lưu phiên vào {path}")
                print("Server sẽ tự dùng phiên này. Cookie Google sẽ hết hạn sau một thời gian —")
                print("khi tab từ khoá báo phiên hết hạn thì chạy lại đúng lệnh này.")
                return 0

            if status == "needs_login":
                # Phiên không đọc được Trends thì giữ lại chỉ tổ làm server tưởng đã có phiên.
                path.unlink(missing_ok=True)
                print(f"ĐÃ XOÁ PHIÊN — {detail}")
                if reused_old_session:
                    print(STALE_PROFILE_HINT)
                else:
                    print("Đăng nhập xong nhưng Trends không nhận phiên này. Thử tài khoản khác.")
                return 1

            print(f"GIỮ PHIÊN, NHƯNG CHƯA KIỂM CHỨNG ĐƯỢC — {detail}")
            print(f"  {path}")
            print("\nLỗi này KHÔNG nói rằng phiên hỏng, nên cookie được giữ lại.")
            # Câu chung của `EMPTY_PAYLOAD_HINT` khuyên "thử một cụm gốc rộng hơn", mà cụm ở
            # đây là "quần áo nam" — rộng sẵn rồi. Để nguyên là đẩy người đọc đi tìm lỗi ở từ
            # khoá, đúng cái đã ngốn trọn một ngày 2026-08-13.
            print(
                "Nếu câu trên nói bảng RỖNG: gần như luôn là tài khoản này đã cạn suất, không\n"
                "phải phiên hỏng. Cách xử lý là thêm một tài khoản vào hồ chứ không đăng nhập lại:\n"
                "  python -m scripts.auth.google_login --name 2 --fresh --no-verify"
            )
            return 0
        finally:
            try:
                await context.close()
            except Exception:
                pass


if __name__ == "__main__":
    sys.exit(asyncio.run(main()))
