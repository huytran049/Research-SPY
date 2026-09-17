import type { Metadata } from 'next'

export const metadata: Metadata = {
  title: 'Hướng dẫn — Research SPY',
}

/**
 * In-app guide.
 *
 * The tool carries several limits that are invisible in the results themselves — the
 * CVR figure is an estimate, TikTok cannot search by keyword, Facebook's own default
 * matching returns mostly noise. Those were documented only in the README, which testers
 * will not read. Anything that could lead someone to misread a number belongs here.
 */
export default function GuidePage() {
  return (
    <>
      <div className="page-head">
        <div>
          <h1>Hướng dẫn sử dụng</h1>
          <p>Quy trình dùng tool và cách đọc đúng các con số. Nên đọc phần &ldquo;Đọc số liệu&rdquo; trước khi ra quyết định test sản phẩm.</p>
        </div>
      </div>

      <div className="guide">
        <section className="guide-card">
          <h2>Quy trình gợi ý</h2>
          <ol className="steps">
            <li>
              <div>
                <strong>Bắt đầu từ tab Từ khoá.</strong> Nhập từ khoá gốc của ngành hàng (vd <em>quần jeans</em>), không
                nhập cụm quá dài. Tool sẽ mở rộng ra các biến thể thật đang được tìm kiếm. Ba ô{' '}
                <em>Quốc gia · Thời gian · Loại tìm kiếm</em> là ba ô của chính Google Trends và áp cho cả danh sách
                lẫn đường lượng tìm — đổi chúng là đổi câu hỏi, không phải đổi cách hiển thị.
              </div>
            </li>
            <li>
              <div>
                <strong>Đọc cột &ldquo;Lượng tìm 12 tháng&rdquo;.</strong> Đường vẽ hình dạng nhu cầu theo thời gian, kèm
                tháng cao điểm — đó mới là thứ quyết định nên test lúc nào. Cột bên phải cho biết nền tảng nào
                gợi ý từ khoá đó; từ được nhiều nguồn cùng công nhận thì đáng tin hơn. Cột ấy tên là &ldquo;Bảng xếp
                hạng&rdquo; kèm số thứ hạng khi Google Trends đang bật, và đổi thành &ldquo;Nguồn tham khảo&rdquo; không
                kèm số khi tắt Trends — vì lúc đó không nguồn nào đo được nhu cầu để mà xếp hạng.
              </div>
            </li>
            <li>
              <div>
                <strong>Bấm &ldquo;Tìm sản phẩm&rdquo;</strong> để nhảy sang tab Sản phẩm với từ khoá đó điền sẵn, xem ai đang
                bán và ai đang chạy quảng cáo cho món này. Từ khoá được điền sẵn nhưng KHÔNG tự chạy — bấm Research
                khi đã chọn xong sàn và quốc gia.
              </div>
            </li>
            <li>
              <div>
                <strong>Lọc theo số ngày chạy.</strong> Đặt tối thiểu 30–60 ngày để loại các ads mới còn đang test. Ads
                sống lâu là tín hiệu đáng tin nhất cho thấy sản phẩm có lãi.
              </div>
            </li>
            <li>
              <div>
                <strong>Lấy content về làm tư liệu.</strong> Bấm nút play để xem video ngay trên web, hoặc &ldquo;Tải
                video&rdquo; để lưu về.
              </div>
            </li>
          </ol>
        </section>

        <section className="guide-card">
          <h2>Đọc số liệu — 3 điều dễ hiểu sai</h2>

          <p>
            <strong>1. &ldquo;CVR ước lượng&rdquo; không phải CVR thật.</strong> Không nền tảng công khai nào cung cấp tỷ
            lệ chuyển đổi — đó là dữ liệu riêng trong tài khoản advertiser. Con số trên mỗi thẻ là chỉ số suy ra từ:
          </p>
          <table>
            <thead>
              <tr>
                <th>Thành phần</th>
                <th>Trọng số</th>
                <th>Vì sao</th>
              </tr>
            </thead>
            <tbody>
              <tr>
                <td>Số ngày ads đã chạy</td>
                <td>55%</td>
                <td>Advertiser không đốt tiền tiếp cho ads lỗ</td>
              </tr>
              <tr>
                <td>Số biến thể creative</td>
                <td>20%</td>
                <td>Nhiều biến thể = đang scale nghiêm túc</td>
              </tr>
              <tr>
                <td>CTR (chỉ TikTok)</td>
                <td>15%</td>
                <td>Nói về chất lượng hook, không phải chất lượng offer</td>
              </tr>
              <tr>
                <td>Lượt tương tác (chỉ TikTok)</td>
                <td>10%</td>
                <td>Tín hiệu yếu nhất, dễ bị nhiễu</td>
              </tr>
            </tbody>
          </table>
          <div className="callout">
            Dùng để <strong>xếp hạng ứng viên</strong> so với nhau. Không dùng thay cho số liệu thật khi tính toán ngân
            sách.
          </div>

          <p style={{ marginTop: 20 }}>
            <strong>2. TikTok không search được theo từ khoá.</strong> Ô search của TikTok Creative Center chạy trên danh
            sách brand/product được index sẵn, và phiên ẩn danh không truy cập được danh sách đó. Khi bạn search một sản
            phẩm, TikTok thường trả về <em>0 kết quả kèm mã thành công</em> — trông hệt như &ldquo;sản phẩm này không có
            nhu cầu&rdquo;.
          </p>
          <div className="callout">
            Khi gặp trường hợp này tool sẽ hiện <strong>thông báo vàng</strong> nói rõ kết quả đang là Top Ads theo CTR
            chứ không phải kết quả cho từ khoá của bạn. Thấy thông báo vàng thì đừng kết luận về nhu cầu sản phẩm —
            hãy nhìn phần Facebook.
          </div>

          <p style={{ marginTop: 20 }}>
            <strong>3. Điểm ở tab Từ khoá là độ phù hợp, không phải lượng search.</strong> Không nguồn miễn phí nào cho
            volume thật. Một từ khoá điểm 84 nghĩa là nhiều nguồn cùng công nhận biến thể đó, không có nghĩa là nó được
            tìm 84 nghìn lần.
          </p>
        </section>

        <section className="guide-card">
          <h2>Mẹo dùng cho kết quả chính xác hơn</h2>
          <ul>
            <li>
              <strong>Giữ &ldquo;Đúng cụm từ&rdquo; ở tab Quảng cáo.</strong> Chế độ &ldquo;Rộng&rdquo; là mặc định của
              Meta và khớp rời từng chữ bất kể thứ tự — đo thực tế chỉ 0–10% kết quả đúng chủ đề. Chỉ chuyển sang Rộng
              khi cần quét rộng và chấp nhận lọc tay.
            </li>
            <li>
              <strong>Từ khoá gốc nên ngắn.</strong> Nhập <em>quần jeans</em> sẽ ra nhiều biến thể hơn hẳn so với nhập
              <em> quần jeans nam ống rộng cao cấp</em>.
            </li>
            <li>
              <strong>Độ sâu &ldquo;Vừa&rdquo; là đủ cho hầu hết trường hợp.</strong> Chọn &ldquo;Sâu&rdquo; khi cần đào
              từ khoá đuôi dài, chấp nhận chờ lâu hơn.
            </li>
            <li>
              <strong>Kết quả được cache trong 15 phút để hạn chế request lặp lại.</strong> Bấm &ldquo;Làm mới&rdquo; nếu cần dữ
              liệu mới nhất.
            </li>
            <li>
              <strong>Link video hết hạn sau vài giờ.</strong> Đây là link ký số của nền tảng, không phải lỗi tool. Mở
              lại hôm sau thì search lại để lấy link mới.
            </li>
          </ul>
        </section>

        <section className="guide-card">
          <h2>Khi thấy báo lỗi</h2>
          <table>
            <thead>
              <tr>
                <th>Thông báo</th>
                <th>Nên làm gì</th>
              </tr>
            </thead>
            <tbody>
              <tr>
                <td>TikTok rate limit (40100)</td>
                <td>Chờ khoảng 1 phút rồi thử lại. Nhiều người search cùng lúc sẽ gặp cái này.</td>
              </tr>
              <tr>
                <td>Google Trends chặn request (429)</td>
                <td>Bình thường, không phải lỗi. Phần tìm từ khoá không bị ảnh hưởng.</td>
              </tr>
              <tr>
                <td>Chấm đỏ ở Facebook/TikTok</td>
                <td>Nguồn đang có vấn đề. Báo người quản trị — có thể nền tảng đã đổi cấu trúc.</td>
              </tr>
              <tr>
                <td>Video hiện &ldquo;upstream 403&rdquo;</td>
                <td>Link đã hết hạn. Search lại để lấy link mới.</td>
              </tr>
            </tbody>
          </table>
        </section>
      </div>
    </>
  )
}
