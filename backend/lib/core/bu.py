"""
ĐƠN VỊ KINH DOANH (BU) — danh sách chuẩn hoá và chính sách theo từng đơn vị.

Đây là nguồn cấu hình duy nhất cho lựa chọn BU, biểu mẫu quản trị và ngưỡng xanh của bảng Giá vốn.

VÌ SAO PHẢI CHỐT DANH SÁCH. `bu` từng là một ô CHỮ TỰ DO, dẫn tới nhiều cách viết cho cùng một
đơn vị:

    "Holding"  ×2      "Hoding"  ×1  (gõ thiếu chữ)      "HO"  ×1

Với một ô hồ sơ để hiển thị thì ba cách viết ấy chỉ hơi xấu. Nhưng từ lúc BU quyết định một
CON SỐ — ngưỡng xanh của tỷ giá — thì nó thành lỗi thật: "Hoding" không khớp khoá nào, nên
người đó âm thầm rơi về ngưỡng mặc định mà giao diện không báo rõ. Dùng danh sách chọn thay vì
ô nhập tự do giúp giữ dữ liệu nhất quán.

NGƯỠNG XANH KHÔNG PHẢI MỘT CON SỐ CHUNG. Nó là mức chênh giá vốn tối thiểu để một sản phẩm
được tô xanh (đáng nhập). Các đơn vị có thể dùng ngưỡng khác nhau để phản ánh cơ cấu chi phí.

ĐÂY CHỈ LÀ MẶC ĐỊNH, KHÔNG PHẢI KHOÁ. Người dùng vẫn tự chỉnh được trong modal Giá vốn và lựa
chọn của họ được nhớ lại; BU chỉ quyết định con số họ thấy ở lần đầu. Xem
`frontend/public/research/research.js::costThresh`.
"""

from __future__ import annotations

#: Ngưỡng xanh mặc định (%) theo từng BU. Khoá của dict CHÍNH LÀ danh sách BU hợp lệ — giữ
#: một chỗ thay vì một danh sách và một bảng tra rời nhau, vì hai cái rời nhau thì thêm BU mới
#: sẽ sửa được một chỗ và quên chỗ kia.
BU_FX_GREEN_THRESHOLD: dict[str, int] = {
    "BU1": 20,
    "BU2": 30,
    "BU3": 30,
    "HO": 30,
}

#: Thứ tự hiển thị trong ô chọn, theo thứ tự cấu hình.
BU_CHOICES: list[str] = list(BU_FX_GREEN_THRESHOLD)

#: Dùng khi hồ sơ chưa có BU, hoặc BU ghi bằng một cách viết không còn nhận ra. Bằng đúng con
#: số của phần lớn BU, nên một hồ sơ hỏng không tự nhiên được ưu ái hơn ai.
FX_GREEN_THRESHOLD_DEFAULT = 30


def normalize_bu(raw: str | None) -> str | None:
    """
    Chuỗi thô → một mã trong `BU_CHOICES`, hoặc `None` nếu không nhận ra.

    So khớp KHÔNG phân biệt hoa thường và bỏ khoảng trắng, vì "bu1" / "BU 1" là cùng một đơn
    vị và bắt người dùng gõ đúng từng ký tự chỉ đẻ thêm dữ liệu rác.
    """
    gọn = (raw or "").strip().upper().replace(" ", "").replace("-", "").replace("_", "")
    return gọn if gọn in BU_FX_GREEN_THRESHOLD else None


def fx_green_threshold(raw_bu: str | None) -> int:
    """Ngưỡng xanh (%) cho một BU. BU lạ hoặc trống → `FX_GREEN_THRESHOLD_DEFAULT`."""
    mã = normalize_bu(raw_bu)
    return BU_FX_GREEN_THRESHOLD.get(mã or "", FX_GREEN_THRESHOLD_DEFAULT)
