"""
Smoke test đầu-cuối cho MỤC TỪ KHOÁ.

Nhắm vào những lời hứa của tính năng mà có thể âm thầm sai: cả ba nguồn đều đóng góp, việc
xếp hạng thật sự diễn ra ở mức chữ bổ nghĩa (nếu đòi trùng nguyên văn thì gần như không có
gì được xếp hạng), các truy vấn dạng tư vấn được để riêng ra, và Google Trends chết không
kéo theo phần khám phá từ khoá.

    python scripts/smoke/keywords.py "quần jeans"
"""

from __future__ import annotations

import asyncio
import os
import sys
from urllib.parse import quote

import httpx

BASE = os.environ.get("BASE", "http://localhost:8000")

failures = 0


def check(label: str, ok: bool, detail: str = "") -> None:
    global failures
    print(f"{'PASS' if ok else 'FAIL'}  {label}{f' — {detail}' if detail else ''}")
    if not ok:
        failures += 1


async def main() -> int:
    seed = sys.argv[1] if len(sys.argv) > 1 else "quần jeans"
    q = quote(seed, safe="")

    async with httpx.AsyncClient(timeout=300.0) as client:

        async def search(query: str) -> dict:
            res = await client.get(f"{BASE}/api/keywords?{query}")
            if res.status_code != 200:
                raise RuntimeError(f"HTTP {res.status_code}: {res.text[:200]}")
            return res.json()

        print(f'=== 1. Cả ba nguồn đều đóng góp (từ gốc: "{seed}") ===')
        r = await search(f"seed={q}&country=VN&depth=normal&limit=80&fresh=true")
        for s in r["statuses"]:
            print(
                f"    {s['source']}: ok={s['ok']} {s['count']} từ khoá / {s['calls']} lượt gọi "
                f"trong {s['tookMs'] / 1000:.1f}s {s.get('message') or ''}"
            )
        check(
            "mọi nguồn đều trả về từ khoá",
            all(s["ok"] for s in r["statuses"]),
            ",".join(s["source"] for s in r["statuses"] if not s["ok"]),
        )
        check("số lượng từ khoá đủ dùng", len(r["keywords"]) >= 25, f"{len(r['keywords'])} đã xếp hạng")

        print("\n=== 2. Top 15 ===")
        for i, k in enumerate(r["keywords"][:15]):
            print(
                f"  {str(i + 1).rjust(2)}. [{str(k['score']['total']).rjust(3)}] {k['display']}"
                f"   {{{','.join(k['sources'])}}} agree={k['score']['agreement']} prom={k['score']['prominence']}"
            )

        ranks = [k["score"]["total"] for k in r["keywords"]]
        check("xếp tốt nhất lên đầu", all(ranks[i - 1] >= v for i, v in enumerate(ranks) if i > 0))

        print("\n=== 3. Xếp hạng ở mức chữ bổ nghĩa, không phải trùng nguyên văn ===")
        # Nếu xếp hạng phụ thuộc vào việc trùng chuỗi giữa các nguồn thì gần như mọi từ khoá
        # đầu bảng sẽ chỉ đến từ một nguồn và điểm đồng thuận sẽ bẹp về 0.
        top20 = r["keywords"][:20]
        single_source = len([k for k in top20 if len(k["sources"]) == 1])
        with_agreement = len([k for k in top20 if k["score"]["agreement"] > 0])
        check(
            "từ khoá một nguồn vẫn xếp hạng được nhờ đồng thuận chữ bổ nghĩa",
            single_source > 0 and with_agreement >= 15,
            f"{single_source}/20 một nguồn, {with_agreement}/20 có đồng thuận > 0",
        )
        check(
            "chữ bổ nghĩa được tách ra",
            all(k["display"].lower() == seed.lower() or len(k["modifiers"]) > 0 for k in top20),
        )

        print("\n=== 4. Truy vấn tư vấn được tách khỏi truy vấn mua hàng ===")
        # Nút bật phải làm kết quả đổi thật. Từ khoá dạng câu hỏi bị chấm điểm thấp có chủ
        # đích, nên nếu không dành riêng hạn ngạch thì chúng rơi hết khỏi giới hạn và việc
        # bật lên trông như không làm gì — đúng kiểu hỏng ban đầu.
        with_info = await search(f"seed={q}&country=VN&depth=normal&limit=80&includeInformational=true")
        info = [k for k in with_info["keywords"] if k["intent"] == "informational"]
        print(f"    phát hiện {len(info)} từ khoá dạng câu hỏi, ví dụ:")
        for k in info[:5]:
            print(f'      "{k["display"]}" -> điểm {k["score"]["total"]}')
        check("mặc định loại từ khoá dạng câu hỏi", all(k["intent"] == "commercial" for k in r["keywords"]))
        check(
            "bật lên thì chúng thật sự hiện ra ở cùng giới hạn",
            len(info) > 0,
            f"{len(info)} hiện trong limit=80 (trước khi dành hạn ngạch là 0)",
        )

        if info:
            commercial = [k for k in with_info["keywords"] if k["intent"] == "commercial"]
            info_avg = sum(k["score"]["total"] for k in info) / len(info)
            comm_avg = sum(k["score"]["total"] for k in commercial) / max(1, len(commercial))
            check(
                "từ khoá câu hỏi xếp dưới từ khoá mua hàng",
                info_avg < comm_avg,
                f"câu hỏi TB {info_avg:.1f} vs mua hàng {comm_avg:.1f}",
            )

        print("\n=== 5. Lý do có mặt và kiểm chứng được ===")
        check("mọi từ khoá đều kèm lý do", all(len(k["score"]["reasons"]) > 0 for k in r["keywords"]))
        if r["keywords"]:
            print(f'    ví dụ: "{r["keywords"][0]["display"]}" -> {" | ".join(r["keywords"][0]["score"]["reasons"])}')

        print("\n=== 6. Từ khoá theo mùa ===")
        # Cần giữ hai biến thể theo mùa ("quần jeans mùa hè / mùa đông"). Mở rộng chỉ bằng chữ cái không ra
        # được cái nào; gieo thêm từ bổ nghĩa bán lẻ thì ra, nên test này giữ cho điều đó
        # không bị lùi lại.
        seasonal = [k for k in r["keywords"] if k.get("seasonal")]
        preview = " · ".join(f"{k['display']} ({k['seasonal']})" for k in seasonal[:8]) or "(không có)"
        print(f"    {len(seasonal)} theo mùa: {preview}")
        check(
            "ra được từ khoá theo mùa với một từ gốc ngành thời trang",
            len(seasonal) > 0,
            "phần gieo từ bổ nghĩa có thể đã lùi về chỉ dùng chữ cái"
            if not seasonal
            else f"{len(seasonal)} từ",
        )

        print("\n=== 7. Cache ===")
        t0 = asyncio.get_running_loop().time()
        again = await search(f"seed={q}&country=VN&depth=normal&limit=80")
        check(
            "lần tìm lặp lại lấy từ cache",
            again["cached"],
            f"{round((asyncio.get_running_loop().time() - t0) * 1000)}ms",
        )

        print("\n=== 8. Google Trends được cách ly (nó chết không được làm hỏng phần khám phá) ===")
        t1 = asyncio.get_running_loop().time()
        trend_res = await client.get(f"{BASE}/api/keywords/trend?keyword={q}&geo=VN")
        trend = trend_res.json()
        check(
            "endpoint trend trả lời mà không ném lỗi",
            trend_res.status_code == 200,
            f"HTTP {trend_res.status_code} trong {(asyncio.get_running_loop().time() - t1):.1f}s",
        )
        if trend.get("series"):
            s = trend["series"]
            print(
                f"    {len(s['points'])} điểm, {s['changePercent']}% thay đổi, {s['direction']}, "
                f"cao điểm {s.get('peakMonth')}"
            )
            check("chuỗi xu hướng có điểm dữ liệu", len(s["points"]) > 10)
        else:
            print(f"    không có chuỗi: {trend.get('message')}")
            check("Trends từ chối thì phải tự giải thích", bool(trend.get("message")))
        check("khám phá từ khoá vẫn chạy bất kể Trends", len(r["keywords"]) > 0)

        print("\n=== 9. Kiểm tra đầu vào ===")
        bad = await client.get(f"{BASE}/api/keywords?seed=")
        check("từ gốc rỗng bị từ chối", bad.status_code == 400, f"HTTP {bad.status_code}")

    print(f"\n{'TẤT CẢ ĐỀU ĐẠT' if failures == 0 else f'{failures} MỤC KHÔNG ĐẠT'}")
    return 0 if failures == 0 else 1


if __name__ == "__main__":
    sys.stdout.reconfigure(encoding="utf-8")
    try:
        sys.exit(asyncio.run(main()))
    except Exception as e:  # noqa: BLE001
        print(f"smoke chạy lỗi: {e}")
        sys.exit(1)
