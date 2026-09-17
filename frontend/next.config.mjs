/**
 * Giao diện Next.js của Research SPY.
 *
 * Toàn bộ tầng dữ liệu nằm ở backend FastAPI (`../backend`). `rewrites()` bên dưới chuyển
 * tiếp mọi đường `/api/*` sang đó, nhờ vậy:
 *
 *  - trình duyệt chỉ thấy một origin duy nhất — không cần CORS
 *  - `<video src="/api/media?...">` vẫn là cùng origin, Range và cache đi qua bình thường
 *  - code component không phải biết backend nằm ở cổng nào
 *
 * Đổi địa chỉ backend bằng biến môi trường `BACKEND_URL` (xem .env.example).
 */

const BACKEND_URL = process.env.BACKEND_URL ?? 'http://127.0.0.1:8000'

/**
 * Tiền tố đường dẫn của cả webtool. Rỗng = chạy ở gốc tên miền.
 *
 * Dùng `/research` để ứng dụng có thể được triển khai dưới một tiền tố thay vì chiếm gốc tên miền.
 *
 * Next tự ghép tiền tố này vào `<Link href>`, `router.push()`, `next/image`, file trong
 * `public/`, và cả `source` của `rewrites()`/`headers()` bên dưới — nên ĐỪNG tự gõ `/research`
 * vào những chỗ đó nữa, sẽ thành `/research/research`. Ba loại Next KHÔNG lo được
 * (`window.location`, `<img src>`, `<iframe src>`) thì bọc bằng `withBase()` — xem lib/basePath.ts.
 *
 * `usePathname()` trả về đường ĐÃ CẮT tiền tố, nên so khớp menu đang mở trong Sidebar vẫn viết
 * `/ads` như cũ, không phải sửa.
 *
 * Đổi được bằng `NEXT_PUBLIC_BASE_PATH`, kể cả về rỗng để chạy ở gốc:
 *   NEXT_PUBLIC_BASE_PATH= npm run build
 */
const BASE_PATH = process.env.NEXT_PUBLIC_BASE_PATH ?? '/research'

/**
 * Trần thời gian một request được phép nằm trong proxy rewrite, tính bằng mili giây.
 *
 * PHẢI đặt tường minh. Mặc định của Next là 30 giây (`server/lib/router-utils/proxy-request.js`),
 * và nhiều đường ở backend này vượt qua nó một cách bình thường chứ không phải do hỏng:
 * `/api/keywords` chờ Google Trends tới 60 giây cho bảng truy vấn liên quan, cộng phần mở
 * rộng của Shopee và TikTok. Khi chạm trần, Next cắt kết nối và trả 500 kèm `socket hang up`
 * — một lỗi trông như backend chết, trong khi backend vẫn đang chạy và vài giây sau trả về
 * kết quả đúng. Đo 2026-07-29: đúng 30 giây, lặp lại được.
 */
const PROXY_TIMEOUT_MS = 300_000

/**
 * Thư mục build. Mặc định `.next`, đổi được bằng `NEXT_DIST_DIR`.
 *
 * Cần thiết vì `next dev` và `next build` DÙNG CHUNG thư mục này, và cái nào chạy sau cũng
 * xoá chunk của cái chạy trước. Đổi cổng KHÔNG tách được chúng ra: hai `next dev` ở hai cổng
 * khác nhau trong cùng thư mục vẫn tranh nhau đúng một `.next`.
 *
 * Hậu quả đã gặp thật: server đang chạy vẫn giữ manifest cũ trong bộ nhớ, nên nó đi hỏi một
 * chunk vừa bị xoá và ném `Cannot find module './294.js'` — một lỗi trông như hỏng code trong
 * khi code không sao, và chỉ sửa được bằng cách xoá `.next` rồi chạy lại.
 *
 * Nhờ biến này, một lượt build hay một server thứ hai chạy song song để kiểm thử đặt được
 * sản phẩm của nó ở chỗ khác:
 *   NEXT_DIST_DIR=.next-test npx next dev -p 3013
 */
const DIST_DIR = process.env.NEXT_DIST_DIR ?? '.next'

/** @type {import('next').NextConfig} */
const nextConfig = {
  distDir: DIST_DIR,
  basePath: BASE_PATH,
  // Đưa base path sang phía trình duyệt cho `withBase()`. Phải đi qua đây chứ không đọc thẳng
  // `basePath` được: giá trị đó chỉ sống trong tiến trình server, code chạy trong trình duyệt
  // không thấy. Next thay thế `process.env.NEXT_PUBLIC_BASE_PATH` bằng chuỗi thật lúc build.
  env: { NEXT_PUBLIC_BASE_PATH: BASE_PATH },
  eslint: { ignoreDuringBuilds: true },
  // Tắt huy hiệu "N" của Next ở góc màn hình lúc chạy dev — nó đè lên chân sidebar. Chỉ hiện ở
  // dev, bản production build vốn không có; tắt cho gọn khi demo/dev.
  devIndicators: false,
  experimental: { proxyTimeout: PROXY_TIMEOUT_MS },
  async rewrites() {
    return [
      // `basePath: false` — ĐƯỜNG API Ở LẠI GỐC TÊN MIỀN, cố ý, không phải sót.
      //
      // Mặc định Next ghép tiền tố vào `source`, tức API sẽ chuyển sang `/research/api/*`. Làm
      // vậy thì mọi nơi gọi API đều phải sửa, và trong số đó có những chỗ KHÔNG sửa nổi bằng
      // build: `public/research/research.js` và `public/hub/*` là JavaScript thường, không qua
      // bundler, không thấy `withBase()`. Hơn mười lời gọi `/api/...` nằm rải trong đó; sót một
      // cái là một tính năng chết lặng lẽ.
      //
      // Giữ API ở gốc thì `fetch('/api/…')` trong lib/api.ts, trong các component, và trong đám
      // file tĩnh kia đều chạy nguyên như cũ — không sửa một dòng nào. Đánh đổi: `/api` bị chiếm
      // ở gốc `tntecom.com`, nên sau này đặt app khác lên gốc thì phải nhớ điều đó.
      { source: '/api/:path*', destination: `${BACKEND_URL}/api/:path*`, basePath: false },
      // `/login` và `/admin` giờ đều là route Next thật (app/(auth)/login, app/(dashboard)/admin)
      // nên KHÔNG còn rewrite tới HTML tĩnh nữa.
    ]
  },
  async headers() {
    // Trang research tĩnh (public/research/*) nạp trực tiếp trong trình duyệt; research.js tự bump
    // ?v= mỗi lần đổi. Vấn đề: trình duyệt cache index.html cũ → vẫn xin ?v= cũ → user phải Ctrl+F5.
    // Đặt no-cache buộc trình duyệt LUÔN revalidate index.html (304 nếu chưa đổi, 200 nếu đổi) →
    // hễ deploy bản mới là tự thấy ?v= mới → nạp JS mới, không cần refresh cứng.
    //
    // `source` dưới đây được Next tự ghép BASE_PATH, nên `/research/:path*` khớp đúng địa chỉ
    // thật của trang là `/research/research/:path*`. Đừng tự gõ thêm tiền tố vào đây.
    return [
      {
        source: '/research/:path*',
        headers: [{ key: 'Cache-Control', value: 'no-cache' }],
      },
      {
        source: '/research',
        headers: [{ key: 'Cache-Control', value: 'no-cache' }],
      },
    ]
  },
}

export default nextConfig
