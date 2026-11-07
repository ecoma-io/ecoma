#!/usr/bin/env python3
"""Chay code block trong 30 bai blog va doi chieu `print` voi comment.

Bai hoc phai chua duoc, va comment canh sanh phai **dung** — mot comment ghi
sai so gia tri lam bai hoc sai. Script nay ghep cac block cua mot bai thanh mot
session (nhieu block trong mot bai la tiep dien cua nhau), chay noi bo (khong
co mang), roi so san tung dong output voi comment canh sanh tren dong `print`
tuong ung.

## Quy tac doi chieu

Mot comment canh sanh duoc tach thanh **cac con so**. Comment con chu (`# three
rotations on axis (i,j)`) thi khong phai ket qua in ra, duoc bo qua co y — xem
`VALUE_COMMENT`.

**Mot lan ghep het.** Comment va output duoc tach ra thanh danh so roi so sanh
theo **thu tu**, `expected[i]` voi `actual[i]` het do dai. Khong co "co mot so nao
trung" va cung khong phai `set` — comment 5 phan tu ma output chi co 3 phan tu
phai fail (thieu), output co 5 phan tu phai fail (thua), `[1.0, 2.0, 3.0]` ma
output in ra `[3.0, 2.0, 1.0]` phai fail (thu tu sai). Do dai bang nhau khong
tu dong kiem tra trung lap: comment `5.4772 5.4772` doi chieu output
`5.4772 5.4772` la dung, va phai vay.

**Do lech so (tolerance).** Comment thuong ghi gia tri *lam tron* (`3.5000`,
`0.9974`) trong khi `print` tra do chinh xac day du (`3.082207001484488`), nen
khong the so sanh bang `==`. Quy tac: **lam tron gia tri thuc te ve dung so chu
so thap phan cua comment, roi so bang dung sai so**. Comment khai bao bao nhieu
chu so thap phan **ke tu chu so dau**: `3.5000` la 4, `1.2e-05` cung la 6 (cua
so `0.000012`), con `3e+09` la so nguyen. Lam tron dung `ROUND_HALF_UP` trong
`decimal` — cung quy tac voi `f"{x:.4f}"` cua Python. Do le do chinh la
`so_phan_thap_phan - so_mu`, nen quy tac nay dung cho ca dang thuong lẫn dang
khoa hoc.

Gia tri thuc te duoc doc nhu mot **chuoi**, khong qua `float`. `round(float(g), 4)`
se lam tron **doi bien** `1.0004999999999998` thanh `1.0005` roi so bang
`1.0005`, bao loi trong khi comment `1.0005` sai so voi gia tri do; doc thang
tu chuoi thi khong co loi do. Doc lap float la he qua khong can them gi: comment
`3.5000` va output `3.5` la cung mot so, comment `3e+09` va output
`3000000000.0` cung vay.

Khong doc lap khac: khong `tol=`, khong epsilon. Neu comment lam tron sai, day la
loi noi dung va phai bao loi chu khong phai chay cho vong.

## Output nhieu dong va `print` khong comment

`print` mot mang numpy in ra nhieu dong, nen khong the doi chieu theo chi so
dong. Con tro **chi tien** (monotonic) va voi moi comment thu cac diem bat dau
tu con tro tro di, gan comment voi **doan** output bat dau o diem do: doan rong
mot dong truoc, neu con thieu thi noi tiep them dong cho den khi du so con so
trong comment. Doan hop la doan dung bang so con so do; actual thua bao "output
thua", khong duoc bo qua.

Con tro phai tien vi mot bai co `print` **khong** co comment canh sanh
(`print(Y)` in mang 2 dong): dong output cua lenh do khong mang danh dau de
bam, nen comment sau phai bo qua qua chung. Do la duoc phep; thu mot diem bat
dau da dung va doi chieu **het** moi la chuyen tu doi voi ban cu.

## Assert khong phai so

Comment khong tach duoc thanh con so thi la assert dang chu: `True`, `False`,
`None`. Khi do comment phai **co mat nguyen van** trong output — truong hop cu
truoc la `any(...)`, chi mot token chung la duoc chay, nghia la mot dong
`[-0.999 0.999]` cung "hop" voi comment `False`.

Shape nhu `(3, 2, 4)` tach duoc thanh 3 con so nen di qua nhanh so o tren:
comment do phai khop **dung** 3 so do, chu khong phai "co so 4 la du".

Comment chi con dau phan cach (`[]`, `(`, `,`) match `VALUE_COMMENT` nhung tach
ra khong con so nao — comment sai do phai bao loi chu khong im lang bo qua.

Mot comment con chu (cau giai thich) thi `parse_expected` tra `None` va comment
do bien mat khoi danh sach assert, khong bao loi. Do la mau chong an mot phan:
comment **co so** thi van duoc kiem chung va bao loi, ke ca khi no dang prose
(`2 x 4`).

## Ranh gioi — validator khong chung minh cai gi

Script nay **chi** doi chieu comment canh sanh tren dong `print`. Nó **không**:

- chứng minh mọi con số trong **văn bản**, mọi **bảng Markdown**, hay mọi
  **công thức** hiển thị — số sai trong prose hoặc trong bảng không bao gi báo
  lỗi;
- chứng minh code **đúng** — code chạy không lỗi và in ra đúng số vẫn có thể sai
  về mặt toán;
- chứng minh comment bị bỏ qua **đúng là** giải thích. `parse_expected` loại
  comment còn chữ bằng quy tắc khu dự `VALUE_COMMENT`, và comment vừa chữ vừa
  số sẽ được đọc như một danh số;
- chứng minh thứ tự ghép là duy nhất. Con trỏ chỉ tiến và lấy điểm **đầu tiên**
  khớp, nên khi cùng một giá trị xuất hiện ở nhiều dòng thì dòng xuất hiện sớm
  hơn thắng — và đó có thể là dòng thuộc `print` không có comment. Đây là hệ
  quả tất yếu của việc không gắn đánh dấu vào output của các lệnh không được
  kiểm chứng;
- chạy lesson cần framework (torch). Chúng được **báo bằng dòng `SKIP`** ở stdout,
  không bao gi im lặng.

Chạy:
    python3 apps/home/tests/verify-examples.py [ten-bai ...]
"""
from __future__ import annotations

import re
import subprocess
import sys
from decimal import Decimal, ROUND_HALF_UP, localcontext
from pathlib import Path
from typing import Iterable, NamedTuple

FENCE = re.compile(r"```(?:python|numpy|python3)[ \t]*\n(.*?)```", re.S)
# Chuan hoa CRLF truoc khi match: file het dong bang Windows se khong match
# duoc regex dua tren `\n` va fail "khong khop dong output nao" tren *moi*
# comment — thong bao sai nguyen nhan.
#
# `print` phai duoc tim bang **may quet dau ngoac** chu khong phai regex: regex
# `^print\((.*)\)` bo qua `print` co thu le, va khi `.*` no xa nhau no se khop
# toi dau `)` o dong sau, gan comment cua lenh nay cho comment cua lenh khac.
PRINT_CALL = re.compile(r"(?<![A-Za-z0-9_.])print\s*\(")
# Comment canh sanh nam sau `)` cua lenh `print`, o cuoi dong do. `[^\\n]*`
# va `\\Z` thay cho `.*` + `$` de khong lan sang dong sau.
TRAILING_COMMENT = re.compile(r"[ \t]*(?:#[ \t]*([^\n]*))?[ \t]*\Z")
# Chi comment canh sanh GIA TRI moi la kiem chung duoc: comment giai thich
# bang tieng Anh ("entry (i,j) depends only on i-j") khong phai ket qua in ra,
# va viec doi chieu no se bao loi o sai. `_` trong comment la dau phan cach
# nhom chu so (`7_000_000_000`) va duoc bo qua khi doc.
VALUE_COMMENT = re.compile(r"^[-+._0-9eE()\[\],\s]+$")
# Comment gia tri cua lenh in boolean. Chua duoc cho phep o `VALUE_COMMENT`
# (vi `e`/`E` o do la de cho khoa hoc, nen `True` se khong match), nhung
# `print(np.allclose(...))  # True` la mot assert **khong phai so** — bo qua no
# thi bo qua mot loi kiem chung thuoc ve hinh dang.
BOOL_COMMENT = re.compile(r"^(?:True|False|None)$")
TORCH = re.compile(r"\bimport torch\b|\btorch\.", re.S)

# Mot so: `-1`, `3.5`, `-1.2e-05`, `3e+09`, `.25`, `7_000_000_000`. So nguyen
# co dau phan cach la underscore de doc duoc gia tri trieu/billion tu cach viet
# trong comment.
NUMBER = r"[-+]?(?:\d[\d_]*(?:\.\d*)?|\.\d+)(?:[eE][-+]?\d+)?"

PRECISION = 40  # decimal so lam viec: du cho parse chuoi dai


class Problem(NamedTuple):
    """Loi doi chieu, day du thong tin de sua."""

    kind: str  # "match" | "crash" | "timeout"
    article: str
    block: int | None  # chi so block (0-based), None khi loi khong gan block
    expression: str  # dong `print` tuong ung
    want: str  # comment canh sanh
    actual: str  # doan output da doi chieu
    detail: str  # giai thich bang tieng Viet

    def render(self) -> str:
        where = self.article if self.block is None else f"{self.article} block {self.block}"
        head = f"{where}: {self.kind} — print({self.expression})"
        return (
            f"{head}\n    expected: {self.want}\n"
            f"    actual:   {self.actual}\n    detail:   {self.detail}"
        )


def decimals_of(literal: str) -> int:
    """Comment khai bao bao nhieu chu so thap phan **ke tu chu so dau**.

    Comment `-0.837054` khai bao 6 chu so, `1.2e-05` cung khai bao 6 chu so
    (cua so `0.000012`), va `3e+09` khai bao khong chu so nao — nen gia tri thuc
    te phai khop sau khi lam tron ve dung do lon do. Do le do chinh la
    `so_phan_thap_phan - so_mu`, va quy tac nay dung cho ca dang thuong lẫn dang
    khoa hoc, trong khi quy tac "chi dem phan sau dau `.`" se lam `1.2e-05`
    thanh mot chu so thap phan va **khong bao gio** khop duoc gi.
    """
    text = literal.replace("_", "").lower()
    mantissa, _, exponent = text.partition("e")
    decimals = len(mantissa.split(".")[1]) if "." in mantissa else 0
    return decimals - int(exponent) if exponent else decimals


def quantize(value: Decimal, decimals: int) -> Decimal:
    """Lam tron `value` ve `decimals` chu so thap phan, nhu `f"{x:.n}"`."""
    with localcontext() as ctx:
        ctx.prec = PRECISION
        return value.quantize(Decimal(1).scaleb(-decimals), rounding=ROUND_HALF_UP)


def numbers_in(text: str) -> list[str]:
    return [m.group(0) for m in re.finditer(NUMBER, text)]


def decimal_in(text: str) -> Decimal:
    return Decimal(text.replace("_", ""))


class Expectation(NamedTuple):
    """Comment canh sanh, tach thanh phan de so sanh *tat ca*."""

    raw: str
    numbers: list[str]  # literal so, theo thu tu xuat hien
    tokens: list[str]  # token cho assert khong phai so

    @property
    def is_numeric(self) -> bool:
        return bool(self.numbers)


def parse_expected(comment: str) -> Expectation | None:
    """Tach comment thanh con so, hoac `None` neu no khong phai ket qua in ra.

    `None` nghia la comment duoc bo qua co y: comment rong, comment con chu
    ("entry (i,j) depends only on i-j") — no mo ta code, khong phai output.
    Comment **co so** thi khong bao gio o nhanh nay, nen comment sai so van
    bao loi chu khong bi bo qua im lang.
    """
    text = comment.strip()
    if not text:
        return None
    if BOOL_COMMENT.match(text):
        # Boolean khong parse duoc thanh con so (khong co chu so nao), va no la
        # assert dang chu: so sanh nguyen van.
        return Expectation(raw=comment, numbers=[], tokens=[text])
    if VALUE_COMMENT.match(text):
        numbers = numbers_in(text)
        # Comment chi con dau phan cach (`[]`, `(`, `,`) match `VALUE_COMMENT`
        # nhung tach ra **khong con so nao**. Neu im lang bo qua, comment sai
        # duoc xem nhu hop — dung chinh xac lo "co mot so trung" cu ban cu.
        # Comment do phai bao loi.
        if not numbers:
            return Expectation(raw=comment, numbers=[], tokens=["<khong co so nao>"])
        return Expectation(raw=comment, numbers=numbers, tokens=[])
    return None


def is_value_comment(expected: str) -> bool:
    """Comment co duoc kiem chung khong (xem `VALUE_COMMENT`)."""
    return parse_expected(expected) is not None


def compare(want: str, got: str) -> tuple[bool, str]:
    """True khi comment `want` mo ta **day du** gia tri cua dong output `got`.

    Tra `(khop, ly_do)`. `ly_do` chi co y nghia khi `khop` la False.
    """
    try:
        expectation = parse_expected(want)
    except ValueError as error:
        return False, str(error)
    if expectation is None:
        return True, ""

    if not expectation.is_numeric:
        return _compare_tokens(expectation, got)

    actual_numbers = numbers_in(got)
    if len(expectation.numbers) != len(actual_numbers):
        kind = "thieu gia tri" if len(actual_numbers) < len(expectation.numbers) else "output thua"
        return False, (
            f"{kind}: comment can {len(expectation.numbers)} gia tri, "
            f"output co {len(actual_numbers)} ({actual_numbers or 'khong co so nao'})"
        )

    for expected_literal, actual_literal in zip(expectation.numbers, actual_numbers):
        decimals = decimals_of(expected_literal)
        rounded = quantize(decimal_in(actual_literal), decimals)
        if rounded != decimal_in(expected_literal):
            why = f"sai {decimals} chu so thap phan" if decimals else "phai la so nguyen"
            return False, f"gia tri {rounded} != {expected_literal} ({why})"
    return True, ""


def _compare_tokens(expectation: Expectation, got: str) -> tuple[bool, str]:
    """Assert khong phai so: **tat ca** token deu phai xuat hien trong output."""
    if expectation.tokens == ["<khong co so nao>"]:
        return False, f"comment {expectation.raw!r} khong chua con so nao de kiem chung"
    absent = [token for token in expectation.tokens if token not in got]
    if absent:
        return False, f"thieu token {absent}; output la {got.strip()!r}"
    return True, ""


def scan_print_call(code: str, open_at: int) -> tuple[int, str] | None:
    """Quet mot lenh `print(` bat dau tai `open_at`. Tra `(dong ngoac, comment noi bo)`.

    Comment Python ket thuc o het dong, va chuoi nhieu dong chi ton tai bang
    ngoac tam — ca hai truong hop deu khong duoc de may quet bien mot `)`
    ben trong chuoi hay ben trong comment la dong ket `print`. Chuoi **mot
    dong** van phai bo qua noi dung (vi du `print("x = )")`), va dau `#` ben
    trong chuoi do cung khong phai comment (`print(f"{x} # not a comment")`).

    Comment noi bo la comment tren **dong noi dung cuoi cung** truoc `)`:
    khi `print(` xuong dong, tac gia hay de comment canh sanh tren dong cuoi
    cung noi dung roi moi dong `)` o dong sau (bai 28 lam dung cach do).

    Tra `None` khi khong tim thay dong ngoac — lenh khong phai ma Python hop le.
    """
    depth = 0
    quote: str | None = None
    escaped = False
    inner = ""
    index = open_at
    while index < len(code):
        char = code[index]
        if quote is not None:
            if escaped:
                escaped = False
            elif char == "\\":
                escaped = True
            elif char == quote:
                quote = None
        elif char in "\"'":
            quote = char
        elif char == "#":
            newline = code.find("\n", index)
            inner = code[index + 1 : newline if newline != -1 else len(code)]
            if newline == -1:
                return None
            index = newline + 1
            continue
        elif char == "(":
            depth += 1
        elif char == ")":
            depth -= 1
            if depth == 0:
                return index, inner
        index += 1
    return None


def comments_after_prints(code: str) -> list[tuple[str, str]]:
    """`(print, comment)` theo thu tu lenh `print` trong block.

    Comment chi giu lai khi no **la gia tri** (so, shape, bool). Comment giai
    thich bang chu thi bi loai: no mo ta code, khong kiem chung duoc bang output.
    """
    out: list[tuple[str, str]] = []
    for match in PRINT_CALL.finditer(code):
        scanned = scan_print_call(code, match.end() - 1)
        if scanned is None:
            continue
        closing, inner = scanned
        rest = code[closing + 1 :]
        line_end = re.search(r"\n", rest)
        tail = rest if line_end is None else rest[: line_end.start()]
        outer = TRAILING_COMMENT.match(tail)
        # Comment sau `)` thang; comment noi bo chi dung khi `print(` xuong dong,
        # vi khi do `)` o dong rieng nen duong chan sau no rong.
        expected = ((outer.group(1) or "") if outer else "").strip()
        if not expected and "\n" in code[match.end() : closing]:
            expected = inner.strip()
        if expected and is_value_comment(expected):
            expression = " ".join(code[match.end() : closing].split())
            out.append((expression, expected))
    return out


def assertions(blocks: Iterable[str]) -> list[tuple[int, str, str]]:
    """`(chi so block, print, comment)` cho moi comment canh sanh co kiem chung."""
    return [
        (index, expression, comment)
        for index, block in enumerate(blocks)
        for expression, comment in comments_after_prints(block)
    ]


def _bracket_depth(text: str) -> int:
    """Chenh lech so `[` truoc `]` trong mot dong output."""
    return text.count("[") - text.count("]")


def _print_extent(actual: list[str], start: int) -> int:
    """So dong ma mot lenh `print` bat dau tai dong `start` that ra.

    Mang numpy in nhieu dong va dong cuoi mang them dau phan tach, nen phai
    theo **do sau ngoac** chu khong phai theo so dong. Chi mo rong khi dong
    dau bat dau bang `[` — output cua mot gia tri thuong (`print(x)`) khong
    the nao, va `print("a[")` cung khong nen du nguyen ta nho `lstrip`.
    """
    if start >= len(actual) or not actual[start].lstrip().startswith("["):
        return 1
    depth = _bracket_depth(actual[start])
    lines = 1
    while depth > 0 and start + lines < len(actual):
        depth += _bracket_depth(actual[start + lines])
        lines += 1
    return lines


def _window_for(actual: list[str], start: int, wanted: int) -> list[str]:
    """Doan output cua **mot lenh `print`**, bat dau tai dong `start`.

    Doan dung la doan **do lenh do that ra**, dung bang `print` chu khong
    phai bang so so comment can. Hai ranh gioi phai giu lai cung luc:

    - Phan du **khong duoc bo qua im lang.** Comment 3 phan tu truoc output 4
      phan tu phai bao "output thua", chu khong cat con 3 roi bao "hop" — neu
      cat theo comment thi comment cat ngan luon "hop", va comment sai khong
      bao gio bi bat.
    - Doan **khong lan sang lenh `print` sau.** `print(Y)` in mot mang 2 dong
      roi `print(probs(...))` in mot dong; neu lan sang, output cua lenh sau
      bi quy oan cho comment hien tai va bao "thieu gia tri" o chinh bai
      dung. Ranh gioi lay tu do sau ngoac nen hai chuyen trai nhau khong xay ra.
    """
    lines = _print_extent(actual, start)
    window = actual[start : start + lines]
    return window if wanted else window[:1]


def _compare_at(actual: list[str], start: int, comment: str, wanted: int) -> tuple[bool, str]:
    """So `comment` voi doan output bat dau tai `start`. Tra `(khop, ly do)`."""
    if start >= len(actual):
        return False, "output het truoc khi comment nao xuat hien"
    window = _window_for(actual, start, wanted) if wanted else actual[start : start + 1]
    return compare(comment, "\n".join(window) if window else "<het output>")


def match_blocks(
    expected: list[tuple[int, str, str]], actual: list[str]
) -> tuple[list[Problem], int]:
    """Ghep tung comment voi doan output, doc `actual` tu dau den cuoi mot lan.

    Con tro **monotonic**: khong bao gio lui. Voi moi comment, thu cac dong bat
    dau tu con tro tro di va lay dong dau **khop day du** — con so nao cung phai
    dung, dung thu tu, dung so luong. Doan hop la doan dung bang so con so
    trong comment; actual thua bao "output thua", khong duoc bo qua.

    Con tro phai **tien** vi mot bai co `print` khong co comment canh sanh
    (`print(Y)` in mang 2 dong, `print(probs(...))` in mot dong): dong output cua
    lenh do khong mang danh dau nao de bam, nen comment sau phai bo qua chung.
    Viec do la duoc phep; phan khong duoc phep la noi dung trong doan da chon
    phai khop **het** — do la thay doi so voi ban cu, noi bat ky so nao trung
    la du.

    Ranh gioi con bi ghi nhan: neu mot comment khop mot dong o **vi tri sau**
    trong khi mot dong o vi tri truoc cung gia tri, dong truoc duoc uu tien. Va
    neu cung mot gia tri xuat hien o nhieu dong, dong dau tien duoc chon. Xem
    "Ranh gioi" trong docstring.
    """
    problems: list[Problem] = []
    cursor = 0
    matched = 0
    for index, expression, comment in expected:
        wanted = len(numbers_in(comment))
        # Ly do bao loi phai lay tu **dong canh sanh** — dong `cursor`, noi comment
        # nay theo thu tu phai bat dau. Cac dong sau do thu "neu co bang may thi
        # sao" nen ly do cua chung khong phai nguyen nhan that cua comment sai.
        canonical_ok, canonical_detail = _compare_at(actual, cursor, comment, wanted)
        for start in range(cursor, len(actual)):
            window = _window_for(actual, start, wanted) if wanted else actual[start : start + 1]
            ok, detail = compare(comment, "\n".join(window))
            if ok:
                cursor = start + max(len(window), 1)
                matched += 1
                break
        else:
            # Khong dong nao khop. Ly do bao loi lay tu dong **canh sanh** (`cursor`)
            # chu khong phai dong thu cuoi: comment bi cat ngan phai bao "thieu gia
            # tri", khong phai ly do cua mot dong o xa hoan toan khac.
            window = _window_for(actual, cursor, wanted) if wanted else actual[cursor : cursor + 1]
            problems.append(
                Problem(
                    kind="match",
                    article="",  # gan o `check_lesson`
                    block=index,
                    expression=expression,
                    want=comment,
                    actual="\n".join(window) if window else "<het output>",
                    detail=canonical_detail,
                )
            )
            cursor += 1
    return problems, matched


def check_lesson(
    article: str, blocks: list[str], actual: list[str], prose: str
) -> tuple[list[Problem], int, int]:
    expected = assertions(blocks)
    problems, _ = match_blocks(expected, actual)
    problems = [Problem(**{**p._asdict(), "article": article}) for p in problems]

    # Van bai nhieu khi ke lai ket qua **trong cau chu**, khong phai tren dong
    # `print`: "Producing `raw = [4. 5. 3.]`". Dang nay van chua duoc kiem chung
    # chinh (xem "Ranh gioi" trong docstring) — chi dem de bao cao.
    claims = re.findall(r"`([a-zA-Z_][\w.]*\s*=\s*\[[^`]+?\])`", prose)
    return problems, len(expected), len(claims)


def run_lesson(blocks: list[str], timeout: int) -> tuple[list[str], str]:
    """Chay ghep cac block trong mot interpreter. Tra `(stdout lines, loi)`."""
    session = "\n".join(blocks)
    try:
        result = subprocess.run(
            [sys.executable, "-c", session],
            capture_output=True,
            text=True,
            timeout=timeout,
            cwd="/",  # lesson nao cung tim thay numpy, khong o phu thuoc cwd
        )
    except subprocess.TimeoutExpired:
        return [], "timeout"
    if result.returncode != 0:
        last = result.stderr.strip().splitlines()[-1] if result.stderr.strip() else "?"
        return [], f"chay loi -> {last}"
    return result.stdout.splitlines(), ""


def main(argv: list[str]) -> int:
    root = Path(__file__).resolve().parents[1]
    blog = root / "content" / "en" / "blog"
    wanted = set(argv[1:])
    ran = skipped = 0
    problems: list[Problem] = []
    timeout = 180

    for article in sorted(blog.iterdir()):
        path = article / "index.md"
        if not path.is_file():
            continue
        if wanted and article.name not in wanted:
            continue
        text = path.read_text(encoding="utf-8").replace("\r\n", "\n")
        blocks = FENCE.findall(text)
        if not blocks:
            continue
        if any(TORCH.search(block) for block in blocks):
            # Skip phai **thay duoc**, khong bao gi im lang: bao cao phai biet
            # lesson nao chua bao gio chung minh.
            print(f"SKIP {article.name} (canh torch, {len(blocks)} block — chua kiem chung)")
            skipped += 1
            continue

        ran += 1
        actual, failure = run_lesson(blocks, timeout)
        if failure:
            problems.append(
                Problem(
                    kind="timeout" if failure == "timeout" else "crash",
                    article=article.name,
                    block=None,
                    expression="",
                    want="",
                    actual="",
                    detail=failure,
                )
            )
            print(f"FAIL {article.name} ({failure})")
            continue

        lesson_problems, checked, claims = check_lesson(article.name, blocks, actual, text)
        problems.extend(lesson_problems)
        status = "FAIL" if lesson_problems else "OK  "
        print(
            f"{status} {article.name} "
            f"({checked} comment kiem chung, {claims} claim trong van)"
        )

    print(f"\nran {ran} lesson(s), skipped {skipped}")
    if skipped:
        print(f"  {skipped} lesson can framework (torch) — KHONG duoc kiem chung, xem dong SKIP")
    if problems:
        print(f"\nPROBLEMS ({len(problems)}):")
        for problem in problems:
            print(f"  - {problem.render()}")
        return 1
    print("every example runs and every inline comment matches its output")
    return 0


if __name__ == "__main__":
    sys.exit(main(sys.argv))