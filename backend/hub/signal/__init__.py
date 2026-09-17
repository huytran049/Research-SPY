"""
BA PHẦN CHÍNH của Trend Signal Hub. Mỗi module ở đây là MỘT phần, và chỉ một.

    trendsig.py   ① Tín hiệu Google Trends  — L · M_ngắn · M_bền · YoY → nhãn
    top10.py      ② Top 10 chính & nổi bật  — growth_long% · spike% trong một partition
    ask.py        ③ One-shot AI             — hỏi đáp nhiều lượt, ground trên ① và ②

VÌ SAO TÁCH KHỎI `engines/`. `engines/` là phần còn lại của bản Printway (Etsy · Amazon ·
product type · gallery). Ba phần này đọc nguồn khác (Google Trends daily · Shopee/Taobao/1688
snapshot) và trả hình dạng khác; trộn chung thư mục thì sáu tháng nữa không ai phân biệt
được cái nào còn sống.

ĐIỀU PHẢI BIẾT TRƯỚC KHI SỬA CÔNG THỨC. Google Trends KHÔNG cho lượt tìm tuyệt đối — nó cho
chỉ số 0–100 chuẩn hoá trong nội bộ MỘT truy vấn. Spec gốc (`Tín hiệu gg Trends.docx`) giả
định `value` là lượt thật (vd 342) và `MIN_LUOT = 150` áp thẳng; giả định đó không đúng với
dữ liệu hiện có, nên ngưỡng quy mô ở đây là `MIN_INDEX` trên thang 0–100 và mọi
bản ghi mang theo cờ `value_kind`. Ngày nào có nguồn lượt tuyệt đối thật, đổi cờ là xong,
không phải sửa công thức: cả bốn chỉ số đều là TỈ LỆ nên bất biến với thang đo.
"""
