#!/usr/bin/env python3
"""Kiem chung **danh tinh** cua moi trich dan arXiv trong curriculum.

Van de cua ban script truoc: no chi *in* ten bai arXiv tra ve de nguoi doc
ngam, khong bao gio chung minh id do tro toi **dung bai ma bai hoc trich**.
Mot id that nhung tro sang bai khac cung di qua trong im lang. Id sai kha
nang tra ve HTTP 200 voi HTML hop le — `curl https://arxiv.org/abs/2404.02276`
tra ve mot bai ve *co bien so* khac, khong phai "not found". Vi vay "co 200"
khong bao gio la bang chung dung.

O day tung id duoc doi chieu voi `citation-manifest.json`: danh sach khai bao
truoc, do nguoi review viet tay, khong phai lan fetch trong cung mot lan chay.
Mot bai viet sai se do la `TITLE_MISMATCH` va lam `test` do.

Nguon su that: Atom API `export.arxiv.org/api/query`. Day la may-doc cua
chinh arXiv, `<title>` trong do la **tieu de canonical** cua bai — dung thu
mot nguon cho ca hai ve, khong scrape HTML. Khong con duong ve `abs` HTML:
khong can, va HTML doi hinh khac nhau theo phien ban nen khong phai nguon
chuuan.

Phan loai ket qua — ba dam, khong gop:

* `NETWORK_FAILURE` — DNS/ket noi/timeout. **Khong bao gio** coi la hieu
  dung. Cho retry roi moi ket luan.
* `HTTP_FAILURE` — non-200 khong phai ma tam thoi. 429/403/5xx la dau hieu
  arXiv throttle: retry roi, va neu het retry van that, bao loi HTTP chu
  khong bao "id khong ton tai".
* `UNKNOWN_IDENTIFIER` — API tra feed hop le va noi ro id do khong co gi.
* `PARSE_FAILURE` — co body nhung khong tach duoc `<title>`.
* `TITLE_MISMATCH` — id that, tieu de khac.

Hanh vi sai hay nhat cua arXiv la tra "thanh cong" rong: mot request bị throttle
ra HTTP 200 + body khong phai Atom, hoac body rong. Code doc `totalResults`
de tach truong hop "id khong ton tai" khoi truong hop "response hong", va mot
than the trong body cung duoc coi la loi tam thoi chu khong phai ket luan.
Xem `_is_throttle_response`.

**Pham vi gioi han.** Script nay chi lo phan `arXiv`. Cac tai lieu khac
(NumPy, PyTorch, SciPy, sách, bài báo không có arXiv id) do
`tests/curriculum-contract.spec.ts` lo bang whitelist; doi voi chúng day khong
phai cong cu kiem chung danh tinh, va no cung khong giong gi kiem chung
duoc. Khong mo rong pham vi thanh mot dich vu trich dan tong quat.

Lenh:

    python3 tests/verify-citations.py                  # offline: kiem tra manifest
    python3 tests/verify-citations.py --live           # goi arXiv that
    python3 tests/verify-citations.py --live --article 22.quantization-precision-and-efficiency

Day la **cong cu review**, khong phai unit test: lenh `--live` cham vao
network nen CI khong chay no. CI chay `tests/python/` bang `unittest` voi HTTP
gim mock.
"""
from __future__ import annotations

import argparse
import json
import re
import sys
import time
import unicodedata
import urllib.error
import urllib.request
import xml.etree.ElementTree as ET
from dataclasses import dataclass
from enum import Enum
from html import unescape
from pathlib import Path
from typing import Callable, Iterable, Mapping, Sequence

TESTS_DIR = Path(__file__).resolve().parent
MANIFEST_PATH = TESTS_DIR / "citation-manifest.json"
BLOG_DIR = TESTS_DIR.parent / "content" / "en" / "blog"

USER_AGENT = "ecoma-curriculum-review/1.0 (citation identity check; +https://ecoma.io)"
ATOM_URL = "https://export.arxiv.org/api/query?id_list={arxiv_id}"

ATOM_NS = {
    "atom": "http://www.w3.org/2005/Atom",
    "opensearch": "http://a9.com/-/spec/opensearch/1.1/",
}

# ---------------------------------------------------------------------------
# Trich dan
# ---------------------------------------------------------------------------

# Dung `[\w./-]` chu khong phai `[\w./]`: id cu dang cu (`hep-ph/9901001`) co
# dau gach, va regex cu cuua spec TypeScript bo sot dang do. Ta bat no thanh
# `MALFORMED_IDENTIFIER` de khong bao gio im lang bo qua.
ARXIV_ABS = re.compile(r"https?://arxiv\.org/abs/([\w./+-]+)", re.IGNORECASE)
ARXIV_SHORT = re.compile(r"\barxiv:([\w./+-]+)", re.IGNORECASE)

# Hai dang id hop le cua arXiv. `vN` la version, khong phan cua danh tinh.
ARXIV_ID = re.compile(r"\A(?:\d{4}\.\d{4,5}|[a-z-]+(?:\.[A-Z]{2})?/\d{7})\Z")
VERSION_SUFFIX = re.compile(r"v\d+\Z")


class Status(str, Enum):
    """Ket qua kiem chung. Chi `MATCH` la "khong co van de"."""

    MATCH = "match"
    TITLE_MISMATCH = "title-mismatch"
    MISSING_FROM_MANIFEST = "missing-from-manifest"
    MALFORMED_IDENTIFIER = "malformed-identifier"
    UNKNOWN_IDENTIFIER = "unknown-identifier"
    PARSE_FAILURE = "parse-failure"
    NETWORK_FAILURE = "network-failure"
    HTTP_FAILURE = "http-failure"


# Hai nhom phan biet: loi *vinh vien* va loi *tam thoi*. Chi nhom tam thoi duoc
# retry. Moi nhom khac tra loi ngay — retry mot `id khong ton tai` chi la don
# viec rat lau thay cong.
TRANSIENT_STATUSES = frozenset({Status.NETWORK_FAILURE, Status.HTTP_FAILURE})

# arXiv yeu cau toi da 3 giay giua hai request. Con so nay mac dinh dung
# cho lenh `--live`.
DEFAULT_MIN_INTERVAL_SECONDS = 3.0
DEFAULT_MAX_ATTEMPTS = 3
DEFAULT_BACKOFF_SECONDS = 2.0
DEFAULT_TIMEOUT_SECONDS = 20.0


# ---------------------------------------------------------------------------
# Chuan hoa tieu de
# ---------------------------------------------------------------------------

# NFKC **khong** gop dau nhay cong `’` -> `'`, hay gach en/em dash -> `-`.
# Nen can bang dich rieng; bo qua no thi mot bai viet copy/paste tu Word se
# that bang mot bai viet go tay dung chu.
TYPOGRAPHIC = str.maketrans(
    {
        "‘": "'",
        "’": "'",
        "‚": "'",
        "‛": "'",
        "“": '"',
        "”": '"',
        "„": '"',
        "‟": '"',
        "–": "-",
        "—": "-",
        "‒": "-",
        "―": "-",
        "−": "-",
        " ": " ",
        " ": " ",
        " ": " ",
        " ": " ",
    }
)


def normalize_title(raw: str) -> str:
    """Dua hai ve ve cung mot dang de so sanh *tuong duong*.

    Chi lo phan khac bi phong hoa: HTML entity, dang Unicode (NFKC), dau nhay
    cong, khoang trang (ke ca xuong dong tu pretty-print cua Atom), cham
    cuoi, va case. Khong co fuzzy matching: mot tieu de *khac* thi phai do,
    het. Khong dung `in`, khong dung do tuong doi token — mot bai sai van la
    bai sai, va bo qua loi do chinh la ly do tool nay ton tai.
    """
    text = unescape(raw)
    text = unicodedata.normalize("NFKC", text)
    text = text.translate(TYPOGRAPHIC)
    text = " ".join(text.split())
    text = re.sub(r"\.\Z", "", text)
    return text.casefold()


def titles_match(expected: str, actual: str) -> bool:
    return normalize_title(expected) == normalize_title(actual)


# ---------------------------------------------------------------------------
# Manifest
# ---------------------------------------------------------------------------


@dataclass(frozen=True)
class ManifestEntry:
    article: str
    arxiv_id: str
    expected_title: str


def normalize_arxiv_id(raw: str) -> str:
    """Chuan hoa id ve dang ma manifest khoa: bo version, viet nhu goc."""
    candidate = raw.strip().rstrip(".,;")
    if candidate[:5].lower().startswith("arxiv:"):
        candidate = candidate[5:]
    return VERSION_SUFFIX.sub("", candidate)


def is_well_formed(arxiv_id: str) -> bool:
    return bool(ARXIV_ID.match(arxiv_id))


def parse_manifest(raw: Mapping[str, object]) -> tuple[dict[tuple[str, str], str], list[str]]:
    """Doc manifest thanh `{(article, id): expected_title}` kem loi cau truc."""
    problems: list[str] = []
    citations = raw.get("citations")
    if not isinstance(citations, list):
        return {}, ["manifest: `citations` phai la mot JSON array"]

    table: dict[tuple[str, str], str] = {}
    for index, row in enumerate(citations):
        if not isinstance(row, dict):
            problems.append(f"manifest row {index}: khong phai object")
            continue
        article = row.get("article")
        arxiv_id = row.get("arxivId")
        title = row.get("expectedTitle")
        for key, value in (("article", article), ("arxivId", arxiv_id), ("expectedTitle", title)):
            if not isinstance(value, str) or not value.strip():
                problems.append(f"manifest row {index}: `{key}` phai la chuoi khong rong")
        if problems and not isinstance(article, str):
            continue
        if not (isinstance(article, str) and isinstance(arxiv_id, str) and isinstance(title, str)):
            continue
        clean_id = normalize_arxiv_id(arxiv_id)
        if not is_well_formed(clean_id):
            problems.append(f"manifest row {index}: arXiv id khong hop le `{arxiv_id}`")
            continue
        key = (article, clean_id)
        if key in table:
            problems.append(f"manifest row {index}: trung khoa `{article}` + `{clean_id}`")
            continue
        table[key] = title

    # `table` giu theo thu tu dau vao (dict), nen lenh `list(table)` chinh la
    # thu tu trong file. So sanh no voi ban sap xep de bat ra file bi sua
    # lung tung — reviewer phai thay duoc moi muc trong mot dong.
    input_order = list(table)
    if input_order != sorted(input_order):
        problems.append("manifest: `citations` phai sap xep theo (article, arxivId) de diff doc duoc")
    return table, problems


def load_manifest(path: Path = MANIFEST_PATH) -> dict[tuple[str, str], str]:
    if not path.is_file():
        raise FileNotFoundError(f"khong tim thay manifest: {path}")
    table, problems = parse_manifest(json.loads(path.read_text(encoding="utf-8")))
    if problems:
        raise ValueError("manifest khong hop le:\n  - " + "\n  - ".join(problems))
    return table


def iter_article_dirs(blog_dir: Path = BLOG_DIR) -> list[Path]:
    if not blog_dir.is_dir():
        return []
    return sorted(path for path in blog_dir.iterdir() if (path / "index.md").is_file())


def extract_citations(raw: str) -> tuple[list[str], list[str]]:
    """Tra `(id hop le khong trung lap, token khong hop le)`.

    Id hop le co dedupe — mot bai trich cung mot id o ca URL va dang
    `arXiv:` van la **mot** phai fetch. Token khong hop le giu nguyen de bao
    loi: bo qua chung im lang moi la lo.
    """
    found: set[str] = set()
    malformed: set[str] = set()
    for match in (*ARXIV_ABS.finditer(raw), *ARXIV_SHORT.finditer(raw)):
        token = match.group(1).rstrip(".,;")
        if token[:5].lower().startswith("arxiv:"):
            token = token[5:]
        candidate = VERSION_SUFFIX.sub("", token)
        if is_well_formed(candidate):
            found.add(candidate)
        else:
            malformed.add(token)
    return sorted(found), sorted(malformed)


def collect_required_citations(blog_dir: Path = BLOG_DIR) -> list[tuple[str, str]]:
    """Moi cap `(ten thu muc bai, arXiv id)` ma bai hoc hien tai trich."""
    pairs: list[tuple[str, str]] = []
    for article in iter_article_dirs(blog_dir):
        ids, _malformed = extract_citations((article / "index.md").read_text(encoding="utf-8"))
        pairs.extend((article.name, arxiv_id) for arxiv_id in ids)
    return sorted(set(pairs))


# ---------------------------------------------------------------------------
# Lop HTTP
# ---------------------------------------------------------------------------


@dataclass(frozen=True)
class HttpResponse:
    status: int
    body: str


class NetworkFailure(Exception):
    """Loi o tang transport: DNS, ket noi, timeout. Thu lai, khong ket luan."""


# `fetch(url, timeout) -> HttpResponse`. injectable de test khong cham network.
Fetch = Callable[[str, int], HttpResponse]


def urllib_fetch(url: str, timeout: int) -> HttpResponse:
    request = urllib.request.Request(url, headers={"User-Agent": USER_AGENT})
    try:
        with urllib.request.urlopen(request, timeout=timeout) as response:
            return HttpResponse(response.status, response.read().decode("utf-8", errors="replace"))
    except urllib.error.HTTPError as exc:
        # van doc body: 400 cua arXiv API mang ve nghia "id sai dinh dang" va
        # 429/503 mang ve throttle — bo body thi mat hai phien ban do.
        try:
            body = exc.read().decode("utf-8", errors="replace")
        except Exception:  # pragma: no cover - body lau doc la truong hop hiem
            body = ""
        return HttpResponse(exc.code, body)
    except (urllib.error.URLError, TimeoutError, OSError) as exc:
        raise NetworkFailure(str(exc)) from exc


THROTTLE_MARKERS = (
    "too many requests",
    "rate limit",
    "rate-limit",
    "ratelimit",
    "try again later",
    "your api access",
    "temporarily unavailable",
    "service is unavailable",
)


def is_throttle_response(response: HttpResponse) -> bool:
    head = response.body[:2000].casefold()
    if not head.strip():
        return True
    return any(marker in head for marker in THROTTLE_MARKERS)


@dataclass(frozen=True)
class TitleResult:
    arxiv_id: str
    status: Status
    actual_title: str | None = None
    detail: str = ""
    attempts: int = 0

    @property
    def ok(self) -> bool:
        return self.status is Status.MATCH


def _atom_error(body: str) -> str | None:
    """Message tu `arxiv.org/api/errors#...` trong body, neu co.

    arXiv bao loi dinh dang id sai bang HTTP **400** chu khong phai 404, va
    body la mot feed Atom binh thuong co mot `<entry>` ten `Error`. Neu ta
    chi nhin status, ta se bao "HTTP error" cho thu mot `id khong ton tai`,
    hoac tai hon la bao sai khi rate limit — ca hai deu sai.
    """
    try:
        root = ET.fromstring(body)
    except ET.ParseError:
        return None
    for entry in root.findall("atom:entry", ATOM_NS):
        identifier = entry.findtext("atom:id", default="", namespaces=ATOM_NS)
        if "/api/errors" in identifier:
            summary = " ".join((entry.findtext("atom:summary", default="", namespaces=ATOM_NS)).split())
            return summary or "arXiv bao loi dinh dang id khong hop le"
    return None


def parse_atom_title(body: str) -> tuple[Status, str | None, str]:
    """`(status, title, detail)` tu body Atom.

    Distinction quan trong: `totalResults` = 0 tren mot feed **hop le** la
    "id khong ton tai". Mot body rong, body HTML, hoac feed thieu `totalResults`
    la **parse failure** — day la hinh dang ma arXiv throttle bao ve minh, va
    bao no thanh "id khong ton tai" se dan nguoi review xoa mot reference
    nghieng.
    """
    if not body.strip():
        return Status.PARSE_FAILURE, None, "response rong"
    try:
        root = ET.fromstring(body)
    except ET.ParseError as exc:
        return Status.PARSE_FAILURE, None, f"XML khong parse duoc: {exc}"
    if root.tag != f"{{{ATOM_NS['atom']}}}feed":
        return Status.PARSE_FAILURE, None, f"phai la Atom feed, nhan `{root.tag}`"

    error = _atom_error(body)
    if error:
        return Status.UNKNOWN_IDENTIFIER, None, error

    total = root.findtext("opensearch:totalResults", default=None, namespaces=ATOM_NS)
    if total is None:
        return Status.PARSE_FAILURE, None, "feed khong co `opensearch:totalResults`"

    entries = root.findall("atom:entry", ATOM_NS)
    if not entries:
        if total.strip() == "0":
            return Status.UNKNOWN_IDENTIFIER, None, "arXiv tra feed rong voi totalResults=0"
        return Status.PARSE_FAILURE, None, f"feed noi totalResults={total} nhung khong co entry nao"

    title = entries[0].findtext("atom:title", default=None, namespaces=ATOM_NS)
    if title is None or not title.strip():
        return Status.PARSE_FAILURE, None, "entry khong co `atom:title` hoac title rong"
    return Status.MATCH, " ".join(title.split()), ""


class ArxivClient:
    """Fetch tieu de canonical, co retry/backoff, phan loai loi tung loai.

    `fetch`, `sleep` va `clock` deu inject duoc nen toan bo ma nghinh nghiệp
    chay duoc trong `unittest` ma khong mo socket nao.
    """

    def __init__(
        self,
        fetch: Fetch | None = None,
        *,
        max_attempts: int = DEFAULT_MAX_ATTEMPTS,
        backoff_seconds: float = DEFAULT_BACKOFF_SECONDS,
        timeout_seconds: float = DEFAULT_TIMEOUT_SECONDS,
        sleep: Callable[[float], None] = time.sleep,
        clock: Callable[[], float] = time.monotonic,
        url_template: str = ATOM_URL,
    ) -> None:
        self._fetch: Fetch = fetch or urllib_fetch
        self.max_attempts = max_attempts
        self.backoff_seconds = backoff_seconds
        self.timeout_seconds = timeout_seconds
        self._sleep = sleep
        self._clock = clock
        self._url_template = url_template
        self._last_request_at: float | None = None

    def _wait_turn(self, min_interval: float) -> None:
        """Giữ nhịp 3 giây/request mà arXiv yêu cầu."""
        if min_interval <= 0:
            return
        now = self._clock()
        if self._last_request_at is not None:
            wait = self._last_request_at + min_interval - now
            if wait > 0:
                self._sleep(wait)
        self._last_request_at = self._clock()

    def _backoff(self, attempt: int) -> None:
        self._sleep(self.backoff_seconds * (2 ** (attempt - 1)))

    def _classify(self, response: HttpResponse) -> tuple[Status, str | None, str, bool]:
        """`(status, title, detail, retryable)` cho mot response."""
        if response.status == 200:
            if is_throttle_response(response):
                # arXiv throttle co the van HTTP 200. Body khong phai feed
                # thi `parse_atom_title` bao parse-failure, nhung thu hien
                # dang rat la `rate limit` thi phai retry chu khong phai
                # doi toi ket luan.
                return Status.NETWORK_FAILURE, None, "arXiv throttle (HTTP 200, body khong phai Atom)", True
            status, title, detail = parse_atom_title(response.body)
            return status, title, detail, False
        if response.status == 400:
            error = _atom_error(response.body)
            if error:
                return Status.UNKNOWN_IDENTIFIER, None, f"HTTP 400: {error}", False
        if response.status in (403, 429) or 500 <= response.status < 600:
            return Status.HTTP_FAILURE, None, f"HTTP {response.status} (arXiv throttle hoac loi server)", True
        return Status.HTTP_FAILURE, None, f"HTTP {response.status}", False

    def fetch_title(self, arxiv_id: str, *, min_interval: float = 0.0) -> TitleResult:
        if not is_well_formed(arxiv_id):
            return TitleResult(arxiv_id, Status.MALFORMED_IDENTIFIER, detail="id khong dung dang arXiv", attempts=0)
        url = self._url_template.format(arxiv_id=arxiv_id)
        last: tuple[Status, str] = (Status.NETWORK_FAILURE, "khong fetch duoc")
        for attempt in range(1, self.max_attempts + 1):
            self._wait_turn(min_interval)
            try:
                response = self._fetch(url, int(self.timeout_seconds))
            except NetworkFailure as exc:
                last = (Status.NETWORK_FAILURE, f"loi mang: {exc}")
                if attempt < self.max_attempts:
                    self._backoff(attempt)
                continue
            status, title, detail, retryable = self._classify(response)
            if status is Status.MATCH:
                return TitleResult(arxiv_id, status, title, attempts=attempt)
            last = (status, detail)
            if not retryable or attempt == self.max_attempts:
                return TitleResult(arxiv_id, status, detail=detail, attempts=attempt)
            self._backoff(attempt)
        return TitleResult(arxiv_id, last[0], detail=last[1], attempts=self.max_attempts)


# ---------------------------------------------------------------------------
# Kiem chung
# ---------------------------------------------------------------------------


@dataclass(frozen=True)
class Finding:
    article: str
    arxiv_id: str
    status: Status
    expected_title: str | None = None
    actual_title: str | None = None
    detail: str = ""
    attempts: int = 0

    def as_line(self) -> str:
        parts = [f"[{self.status.value}]", f"{self.article}", f"arXiv:{self.arxiv_id}"]
        if self.expected_title:
            parts.append(f"expected={self.expected_title!r}")
        if self.actual_title:
            parts.append(f"actual={self.actual_title!r}")
        if self.detail:
            parts.append(f"({self.detail})")
        if self.attempts:
            parts.append(f"attempts={self.attempts}")
        return "  " + "  ".join(parts)


def check_article(
    article_dir: Path,
    manifest: Mapping[tuple[str, str], str],
    client: ArxivClient,
    *,
    min_interval: float = 0.0,
) -> list[Finding]:
    """Kiem chung mot bai. Chi fet id co san trong manifest."""
    raw = (article_dir / "index.md").read_text(encoding="utf-8")
    ids, malformed = extract_citations(raw)
    findings: list[Finding] = []

    for token in malformed:
        findings.append(
            Finding(article_dir.name, token, Status.MALFORMED_IDENTIFIER, detail="token khong dung dang arXiv id")
        )

    for arxiv_id in ids:
        expected = manifest.get((article_dir.name, arxiv_id))
        if expected is None:
            # Khong fetch: id chua khai bao la loi khai bao, goi arXiv ve no
            # chi ton them request va lam bang chung sai.
            findings.append(
                Finding(
                    article_dir.name,
                    arxiv_id,
                    Status.MISSING_FROM_MANIFEST,
                    detail="bai hoc trich id nay nhung citation-manifest.json chua khai bao tieu de mong doi",
                )
            )
            continue

        result = client.fetch_title(arxiv_id, min_interval=min_interval)
        if not result.ok:
            findings.append(
                Finding(article_dir.name, arxiv_id, result.status, expected, result.actual_title, result.detail, result.attempts)
            )
        elif not titles_match(expected, result.actual_title or ""):
            findings.append(
                Finding(
                    article_dir.name,
                    arxiv_id,
                    Status.TITLE_MISMATCH,
                    expected,
                    result.actual_title,
                    detail="arXiv tra ve bai khac",
                    attempts=result.attempts,
                )
            )
    return findings


@dataclass
class Report:
    checked: int = 0
    findings: list[Finding] = None  # type: ignore[assignment]
    unreferenced: list[tuple[str, str]] = None  # type: ignore[assignment]

    def __post_init__(self) -> None:
        if self.findings is None:
            self.findings = []
        if self.unreferenced is None:
            self.unreferenced = []


def check_all(
    manifest: Mapping[tuple[str, str], str],
    client: ArxivClient | None = None,
    *,
    blog_dir: Path = BLOG_DIR,
    article_filter: str | None = None,
    min_interval: float = 0.0,
) -> Report:
    client = client or ArxivClient()
    report = Report()
    used: set[tuple[str, str]] = set()
    for article_dir in iter_article_dirs(blog_dir):
        if article_filter and article_filter not in article_dir.name:
            continue
        ids, malformed = extract_citations((article_dir / "index.md").read_text(encoding="utf-8"))
        used.update((article_dir.name, arxiv_id) for arxiv_id in ids)
        report.findings.extend(check_article(article_dir, manifest, client, min_interval=min_interval))
        report.checked += len(ids)
        report.checked += len(malformed)
    report.unreferenced = sorted(key for key in manifest if key not in used)
    return report


# ---------------------------------------------------------------------------
# CLI
# ---------------------------------------------------------------------------


def _print_report(report: Report, label: str) -> None:
    print(f"\n{label}: kiem tra {report.checked} cap (bai, arXiv id)")
    for finding in report.findings:
        print(finding.as_line())
    if report.unreferenced:
        # Khong phai loi: manifest duoc phep giu san id dung o bai khac. Chi
        # bao de nguoi review khong nen chay lai.
        print(f"\n{len(report.unreferenced)} muc manifest hien khong duoc bai nao trich:")
        for article, arxiv_id in report.unreferenced[:10]:
            print(f"  - {article}  arXiv:{arxiv_id}")
    if report.findings:
        counts: dict[Status, int] = {}
        for finding in report.findings:
            counts[finding.status] = counts.get(finding.status, 0) + 1
        print("\nPROBLEMS:")
        for status, count in sorted(counts.items(), key=lambda item: item[0].value):
            print(f"  {status.value}: {count}")
        return
    print("\nkhong co van de: moi trich dan arXiv tro dung bai da khai bao")


def main(argv: Sequence[str] | None = None) -> int:
    parser = argparse.ArgumentParser(
        description="Kiem chung danh tinh trich dan arXiv cua curriculum.",
        epilog="Khong co --live thi khong cham network.",
    )
    parser.add_argument("--live", action="store_true", help="goi arXiv that (chay review, khong dung cho CI)")
    parser.add_argument("--manifest", type=Path, default=MANIFEST_PATH)
    parser.add_argument("--blog-dir", type=Path, default=BLOG_DIR)
    parser.add_argument("--article", default=None, help="chi kiem tra bai co chu nay trong ten thu muc")
    parser.add_argument(
        "--delay",
        type=float,
        default=DEFAULT_MIN_INTERVAL_SECONDS,
        help=f"giay cho giua hai request arXiv (mac dinh {DEFAULT_MIN_INTERVAL_SECONDS})",
    )
    parser.add_argument("--attempts", type=int, default=DEFAULT_MAX_ATTEMPTS)
    args = parser.parse_args(argv)

    try:
        manifest = load_manifest(args.manifest)
    except (FileNotFoundError, ValueError, json.JSONDecodeError) as exc:
        print(f"manifest khong dung: {exc}", file=sys.stderr)
        return 2

    if not args.live:
        # Che do mac dinh: offline. Kiem tra phan manifest co phu moi trich
        # dan hien co khong — day la phan CI chay qua unittest.
        required = collect_required_citations(args.blog_dir)
        missing = [key for key in required if key not in manifest]
        print(f"manifest: {len(manifest)} muc")
        print(f"bai hoc hien trich: {len(required)} cap (bai, arXiv id)")
        if missing:
            print("\nPROBLEMS:")
            for article, arxiv_id in missing:
                print(f"  [{Status.MISSING_FROM_MANIFEST.value}]  {article}  arXiv:{arxiv_id}")
            return 1
        print("moi trich dan trong bai hoc deu co muc trong manifest")
        return 0

    report = check_all(
        manifest,
        ArxivClient(max_attempts=args.attempts),
        blog_dir=args.blog_dir,
        article_filter=args.article,
        min_interval=args.delay,
    )
    _print_report(report, "live")
    return 1 if report.findings else 0


if __name__ == "__main__":
    sys.exit(main())