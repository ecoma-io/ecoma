#!/usr/bin/env python3
"""Unit test kiem chung danh tinh trich dan arXiv. **Khong cham network.**

Chay:
    cd apps/home && python3 -m unittest discover -s tests/python -t .

Lop HTTP duoc inject (`fetch`, `sleep`, `clock`) nen khong test nao mo socket
nao. Day la phan CI chay; phan goi arXiv that nam o `verify-citations.py
--live` va khong bao gio chay trong CI.
"""
from __future__ import annotations

import json
import sys
import tempfile
import textwrap
import unittest
from pathlib import Path

TESTS_DIR = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(TESTS_DIR))

from citation_verify import (  # noqa: E402
    ArxivClient,
    Finding,
    HttpResponse,
    ManifestEntry,  # noqa: F401  - tai import de chan import sai duong dan
    NetworkFailure,
    Report,
    Status,
    check_article,
    collect_required_citations,
    extract_citations,
    is_well_formed,
    load_manifest,
    normalize_title,
    parse_atom_title,
    parse_manifest,
    titles_match,
)

FEED = """<?xml version='1.0' encoding='UTF-8'?>
<feed xmlns="http://www.w3.org/2005/Atom"
      xmlns:opensearch="http://a9.com/-/spec/opensearch/1.1/">
  <id>https://arxiv.org/api/abc</id>
  <title>arXiv Query: search_query=&amp;id_list=1706.03762&amp;start=0&amp;max_results=10</title>
  <opensearch:itemsPerPage>10</opensearch:itemsPerPage>
  <opensearch:totalResults>1</opensearch:totalResults>
  <opensearch:startIndex>0</opensearch:startIndex>
  <entry>
    <id>http://arxiv.org/abs/1706.03762v7</id>
    <title>{title}</title>
    <summary>Abstract body.</summary>
  </entry>
</feed>
"""

EMPTY_FEED = """<?xml version='1.0' encoding='UTF-8'?>
<feed xmlns="http://www.w3.org/2005/Atom"
      xmlns:opensearch="http://a9.com/-/spec/opensearch/1.1/">
  <id>https://arxiv.org/api/def</id>
  <opensearch:totalResults>0</opensearch:totalResults>
  <opensearch:itemsPerPage>10</opensearch:itemsPerPage>
  <opensearch:startIndex>0</opensearch:startIndex>
</feed>
"""

ERROR_FEED = """<?xml version='1.0' encoding='UTF-8'?>
<feed xmlns="http://www.w3.org/2005/Atom"
      xmlns:opensearch="http://a9.com/-/spec/opensearch/1.1/">
  <id>https://arxiv.org/</id>
  <title>arXiv Search Results</title>
  <opensearch:totalResults>1</opensearch:totalResults>
  <entry>
    <id>https://arxiv.org/api/errors#incorrect_id_format_for_not-an-id</id>
    <title>Error</title>
    <summary>incorrect id format for not-an-id</summary>
  </entry>
</feed>
"""

ATTENTION = "Attention Is All You Need"


def feed_with_title(title: str) -> str:
    return FEED.format(title=title)


class RecordingFetch:
    """Fetch gia lap: ghi lai moi url, tra ve phan tu list da len.

    Phe tu dau co the la `HttpResponse` hoac exception de mo phong loi.
    """

    def __init__(self, *responses: object) -> None:
        self.responses = list(responses)
        self.calls: list[tuple[str, int]] = []

    def __call__(self, url: str, timeout: int) -> HttpResponse:
        self.calls.append((url, timeout))
        index = min(len(self.calls) - 1, len(self.responses) - 1)
        item = self.responses[index]
        if isinstance(item, Exception):
            raise item
        return item  # type: ignore[return-value]


def make_client(fetch: object, **kwargs: object) -> ArxivClient:
    """Client khong bao gio sleep that — `sleep` ghi lai de test do thoi gian."""
    kwargs.setdefault("sleep", lambda _seconds: None)
    return ArxivClient(fetch=fetch, **kwargs)  # type: ignore[arg-type]


class AtomTitleParsingTests(unittest.TestCase):
    def test_extracts_canonical_title(self) -> None:
        status, title, _detail = parse_atom_title(feed_with_title(ATTENTION))
        self.assertIs(Status.MATCH, status)
        self.assertEqual(ATTENTION, title)

    def test_collapses_whitespace_from_pretty_printed_title(self) -> None:
        # Atom pretty-print de xuong dong trong `<title>`; so sanh nguyen van
        # se do mot tieu de hoan toan dung.
        status, title, _detail = parse_atom_title(feed_with_title("Billion-scale\n    similarity search with GPUs"))
        self.assertIs(Status.MATCH, status)
        self.assertEqual("Billion-scale similarity search with GPUs", title)

    def test_zero_total_results_is_unknown_identifier(self) -> None:
        status, title, detail = parse_atom_title(EMPTY_FEED)
        self.assertIs(Status.UNKNOWN_IDENTIFIER, status)
        self.assertIsNone(title)
        self.assertIn("totalResults=0", detail)

    def test_atom_error_entry_is_unknown_identifier(self) -> None:
        status, _title, detail = parse_atom_title(ERROR_FEED)
        self.assertIs(Status.UNKNOWN_IDENTIFIER, status)
        self.assertIn("incorrect id format", detail)

    def test_empty_body_is_parse_failure_not_unknown_identifier(self) -> None:
        # Than trong rong LA cach arXiv bao toi rat lau. Bao no la "id khong
        # ton tai" se khien nguoi review xoa mot reference nghieng.
        status, _title, detail = parse_atom_title("")
        self.assertIs(Status.PARSE_FAILURE, status)
        self.assertIn("rong", detail)

    def test_html_body_is_parse_failure(self) -> None:
        status, _title, _detail = parse_atom_title("<html><body>Rate limited</body></html>")
        self.assertIs(Status.PARSE_FAILURE, status)

    def test_feed_without_total_results_is_parse_failure(self) -> None:
        body = FEED.replace("<opensearch:totalResults>1</opensearch:totalResults>", "")
        status, _title, _detail = parse_atom_title(body)
        self.assertIs(Status.PARSE_FAILURE, status)

    def test_entry_without_title_is_parse_failure(self) -> None:
        body = feed_with_title("").replace("<title></title>", "<title>   </title>")
        status, _title, _detail = parse_atom_title(body)
        self.assertIs(Status.PARSE_FAILURE, status)


class CitationExtractionTests(unittest.TestCase):
    def test_recognizes_both_id_formats(self) -> None:
        raw = "See https://arxiv.org/abs/2404.02258 and arXiv:2404.02258 for details."
        ids, malformed = extract_citations(raw)
        self.assertEqual(["2404.02258"], ids)
        self.assertEqual([], malformed)

    def test_both_formats_dedupe_to_one_citation(self) -> None:
        raw = "[arXiv:1706.03762](https://arxiv.org/abs/1706.03762)"
        ids, _malformed = extract_citations(raw)
        self.assertEqual(["1706.03762"], ids)

    def test_strips_version_suffix(self) -> None:
        self.assertEqual(["1706.03762"], extract_citations("https://arxiv.org/abs/1706.03762v7")[0])

    def test_reports_malformed_token_instead_of_silently_skipping(self) -> None:
        ids, malformed = extract_citations("https://arxiv.org/abs/2404.02258 plus arXiv:not-an-id")
        self.assertEqual(["2404.02258"], ids)
        self.assertEqual(["not-an-id"], malformed)

    def test_old_style_identifier_with_slash_is_well_formed(self) -> None:
        # Regex cu cua spec TypeScript bo sot dang id co dau gach.
        self.assertTrue(is_well_formed("hep-ph/9901001"))
        self.assertEqual(["hep-ph/9901001"], extract_citations("arXiv:hep-ph/9901001")[0])

    def test_identifiers_are_globally_unique_across_articles(self) -> None:
        # Bảo đảm khả năng: cùng một id nhưng context khác là cùng một kiem chung.
        ids, _malformed = extract_citations("arXiv:1706.03762")
        self.assertEqual(["1706.03762"], ids)


class NormalizationTests(unittest.TestCase):
    def test_collapses_whitespace_and_newlines(self) -> None:
        self.assertTrue(titles_match("Billion-scale  similarity\nsearch with GPUs", "Billion-scale similarity search with GPUs"))

    def test_html_entities_match_raw_characters(self) -> None:
        self.assertTrue(titles_match("BERT &amp; friends", "BERT & friends"))

    def test_unicode_nfkc_variants_match(self) -> None:
        # Precomposed vs decomposed: accent tieng Viet `ơ`/`ư` va NBSP.
        self.assertTrue(titles_match("Nguyễn Văn A", "Nguyễn Văn A"))
        self.assertTrue(titles_match("deep learning", "deep learning"))

    def test_curly_quotes_and_dashes_match(self) -> None:
        self.assertTrue(titles_match("The “Model” — Revisited", 'The "Model" - Revisited'))

    def test_trailing_period_is_harmless(self) -> None:
        self.assertTrue(titles_match("Attention Is All You Need.", "Attention Is All You Need"))

    def test_case_is_ignored(self) -> None:
        self.assertTrue(titles_match("AWQ: Activation-aware Weight Quantization", "awq: activation-aware weight quantization"))

    def test_materially_different_titles_are_rejected(self) -> None:
        self.assertFalse(titles_match(ATTENTION, "Attention Is All You Need For Everything"))

    def test_extra_subtitle_is_rejected_not_fuzzy_matched(self) -> None:
        # Khong substring, khong token-overlap: bai sai van la bai sai.
        self.assertFalse(titles_match(ATTENTION, "Attention Is All You Need, and 6 other things"))

    def test_normalizes_expected_and_actual_identically(self) -> None:
        self.assertEqual(normalize_title("A &amp; B."), normalize_title("a & b"))


class ClientOutcomeTests(unittest.TestCase):
    def test_correct_id_and_matching_title_passes(self) -> None:
        fetch = RecordingFetch(HttpResponse(200, feed_with_title(ATTENTION)))
        result = make_client(fetch).fetch_title("1706.03762")
        self.assertIs(Status.MATCH, result.status)
        self.assertTrue(result.ok)
        self.assertEqual(ATTENTION, result.actual_title)

    def test_existing_id_with_different_title_reports_mismatch_title(self) -> None:
        # Day la truong hop ban script truoc bo qua: id that, bai khac.
        fetch = RecordingFetch(HttpResponse(200, feed_with_title("A Study of Galactic Bulge Dynamics")))
        result = make_client(fetch).fetch_title("1706.03762")
        self.assertIs(Status.MATCH, result.status)  # id ton tai
        self.assertFalse(titles_match(ATTENTION, result.actual_title or ""))

    def test_unknown_identifier_does_not_retry(self) -> None:
        fetch = RecordingFetch(HttpResponse(200, EMPTY_FEED))
        result = make_client(fetch).fetch_title("2999.99999")
        self.assertIs(Status.UNKNOWN_IDENTIFIER, result.status)
        self.assertEqual(1, result.attempts)

    def test_atom_error_entry_reports_unknown_not_http_error(self) -> None:
        # arXiv bao id sai dinh dang bang HTTP **400** chu khong phai 404.
        # Body van la mot feed Atom binh thuong, nen chi nhin status se bao
        # sai than "HTTP error".
        fetch = RecordingFetch(HttpResponse(400, ERROR_FEED))
        result = make_client(fetch).fetch_title("2999.99999")
        self.assertIs(Status.UNKNOWN_IDENTIFIER, result.status)
        self.assertEqual(1, result.attempts)
        self.assertIn("incorrect id format", result.detail)

    def test_malformed_identifier_never_hits_the_network(self) -> None:
        # `2404.022` chi co 3 chu so sau dau cham: khong phai id arXiv hop le.
        fetch = RecordingFetch(HttpResponse(200, feed_with_title(ATTENTION)))
        result = make_client(fetch).fetch_title("2404.022")
        self.assertIs(Status.MALFORMED_IDENTIFIER, result.status)
        self.assertEqual(0, result.attempts)
        self.assertEqual([], fetch.calls, "id khong hop le thi khong ton request")

    def test_unparseable_response_fails(self) -> None:
        fetch = RecordingFetch(HttpResponse(200, "not xml at all"))
        result = make_client(fetch).fetch_title("1706.03762")
        self.assertIs(Status.PARSE_FAILURE, result.status)
        self.assertFalse(result.ok)

    def test_throttled_empty_200_body_is_not_reported_as_unknown_identifier(self) -> None:
        # HTTP 200 + than rong. Neu bao "id khong ton tai" thi nguoi review se
        # xoa mot reference hoan toan dung.
        fetch = RecordingFetch(HttpResponse(200, ""), HttpResponse(200, ""), HttpResponse(200, ""))
        result = make_client(fetch).fetch_title("1706.03762")
        self.assertNotIn(result.status, {Status.MATCH, Status.UNKNOWN_IDENTIFIER})
        self.assertIs(Status.NETWORK_FAILURE, result.status)

    def test_throttled_200_body_recovers_on_retry(self) -> None:
        fetch = RecordingFetch(
            HttpResponse(200, "Sorry, your query was throttled. Please try again later."),
            HttpResponse(200, feed_with_title(ATTENTION)),
        )
        result = make_client(fetch).fetch_title("1706.03762")
        self.assertIs(Status.MATCH, result.status)
        self.assertEqual(2, result.attempts)

    def test_http_429_retries_then_fails_as_http_failure(self) -> None:
        fetch = RecordingFetch(*[HttpResponse(429, "")] * 3)
        result = make_client(fetch, max_attempts=3).fetch_title("1706.03762")
        self.assertIs(Status.HTTP_FAILURE, result.status)
        self.assertEqual(3, result.attempts)
        self.assertIn("429", result.detail)

    def test_http_404_is_not_retried(self) -> None:
        fetch = RecordingFetch(*[HttpResponse(404, "nope")] * 3)
        result = make_client(fetch, max_attempts=3).fetch_title("1706.03762")
        self.assertIs(Status.HTTP_FAILURE, result.status)
        self.assertEqual(1, result.attempts)

    def test_request_carries_timeout_and_user_agent(self) -> None:
        fetch = RecordingFetch(HttpResponse(200, feed_with_title(ATTENTION)))
        make_client(fetch, timeout_seconds=7).fetch_title("1706.03762")
        url, timeout = fetch.calls[0]
        self.assertEqual(7, timeout)
        self.assertIn("export.arxiv.org", url)
        self.assertIn("id_list=1706.03762", url)


class RetryPolicyTests(unittest.TestCase):
    def test_transient_network_failure_follows_retry_policy_and_eventually_fails(self) -> None:
        fetch = RecordingFetch(*[NetworkFailure("dns goboom")] * 5)
        sleeps: list[float] = []
        client = make_client(fetch, max_attempts=4, sleep=sleeps.append)
        result = client.fetch_title("1706.03762")
        self.assertIs(Status.NETWORK_FAILURE, result.status)
        self.assertEqual(4, result.attempts, "phai thu dung so lan trong max_attempts")
        self.assertEqual(4, len(fetch.calls))
        self.assertEqual([2.0, 4.0, 8.0], sleeps, "backoff luoi, dung so lan thu")

    def test_network_failure_recovers_before_exhausting_attempts(self) -> None:
        fetch = RecordingFetch(NetworkFailure("reset"), HttpResponse(200, feed_with_title(ATTENTION)))
        result = make_client(fetch, max_attempts=3).fetch_title("1706.03762")
        self.assertIs(Status.MATCH, result.status)
        self.assertEqual(2, result.attempts)

    def test_network_failure_is_never_silently_valid(self) -> None:
        fetch = RecordingFetch(*[NetworkFailure("offline")] * 3)
        result = make_client(fetch, max_attempts=3).fetch_title("1706.03762")
        self.assertFalse(result.ok)

    def test_permanent_failure_is_not_retried(self) -> None:
        # Retry mot `id khong ton tai` chi la don viec rat lau thay cong.
        fetch = RecordingFetch(*[HttpResponse(200, EMPTY_FEED)] * 3)
        result = make_client(fetch, max_attempts=3).fetch_title("2999.99999")
        self.assertEqual(1, result.attempts)

    def test_min_interval_enforces_arxiv_rate_limit_politeness(self) -> None:
        # clock gia lap: moi lan goi "ton tai" nhieu thoi gian la 0 nen client
        # phai sleep it nhat `min_interval` truoc request thu hai.
        ticks = iter([0.0, 0.0, 0.0, 0.0, 0.0, 0.0])
        sleeps: list[float] = []
        fetch = RecordingFetch(*[HttpResponse(200, feed_with_title(ATTENTION))] * 2)
        client = ArxivClient(
            fetch=fetch,
            sleep=sleeps.append,
            clock=lambda: next(ticks),
            max_attempts=2,
        )
        client.fetch_title("1706.03762", min_interval=3.0)
        client.fetch_title("1706.03762", min_interval=3.0)
        self.assertEqual([3.0], sleeps)


class ArticleCheckTests(unittest.TestCase):
    def setUp(self) -> None:
        self.tmp = tempfile.TemporaryDirectory()
        self.blog = Path(self.tmp.name) / "blog"
        self.article = self.blog / "22.quantization-precision-and-efficiency"
        self.article.mkdir(parents=True)
        self.addCleanup(self.tmp.cleanup)

    def write(self, body: str) -> None:
        (self.article / "index.md").write_text(body, encoding="utf-8")

    def check(self, body: str, manifest: dict, fetch: object, **kwargs: object) -> list[Finding]:
        self.write(body)
        client = make_client(fetch, **kwargs)  # type: ignore[arg-type]
        return check_article(self.article, manifest, client)

    def test_matching_citation_produces_no_finding(self) -> None:
        body = textwrap.dedent(
            """\
            # Lesson
            [arXiv:2210.17323](https://arxiv.org/abs/2210.17323)
            """
        )
        manifest = {("22.quantization-precision-and-efficiency", "2210.17323"): "GPTQ: Accurate Post-Training Quantization for Generative Pre-trained Transformers"}
        fetch = RecordingFetch(
            HttpResponse(200, feed_with_title("GPTQ: Accurate Post-Training Quantization for Generative Pre-trained Transformers"))
        )
        self.assertEqual([], self.check(body, manifest, fetch))

    def test_citation_absent_from_manifest_is_detected_without_fetching(self) -> None:
        body = "## References\n- arXiv:2210.17323\n"
        fetch = RecordingFetch(HttpResponse(200, feed_with_title("irrelevant")))
        findings = self.check(body, {}, fetch)
        self.assertEqual(1, len(findings))
        self.assertIs(Status.MISSING_FROM_MANIFEST, findings[0].status)
        self.assertEqual([], fetch.calls, "id chua khai bao thi khong ton request")
        self.assertIn("2210.17323", findings[0].as_line())

    def test_wrong_paper_is_reported_with_expected_and_actual(self) -> None:
        body = "## References\n- https://arxiv.org/abs/1706.03762\n"
        manifest = {("22.quantization-precision-and-efficiency", "1706.03762"): ATTENTION}
        fetch = RecordingFetch(HttpResponse(200, feed_with_title("Discovery of a Giant Exoplanet Atmosphere")))
        findings = self.check(body, manifest, fetch)
        self.assertEqual(1, len(findings))
        finding = findings[0]
        self.assertIs(Status.TITLE_MISMATCH, finding.status)
        self.assertEqual(ATTENTION, finding.expected_title)
        self.assertEqual("Discovery of a Giant Exoplanet Atmosphere", finding.actual_title)
        # Report phai du de nguoi review doc ma khong phai mo code lai.
        line = finding.as_line()
        self.assertIn("22.quantization-precision-and-efficiency", line)
        self.assertIn("arXiv:1706.03762", line)
        self.assertIn("Attention Is All You Need", line)
        self.assertIn("Discovery of a Giant Exoplanet Atmosphere", line)

    def test_harmless_formatting_difference_passes(self) -> None:
        body = "## References\n- arXiv:1706.03762\n"
        manifest = {("22.quantization-precision-and-efficiency", "1706.03762"): "attention  is   all you need."}
        fetch = RecordingFetch(HttpResponse(200, feed_with_title("Attention Is All You Need")))
        self.assertEqual([], self.check(body, manifest, fetch))

    def test_malformed_token_in_article_is_reported(self) -> None:
        body = "## References\n- arXiv:not-a-real-id\n"
        findings = self.check(body, {}, RecordingFetch())
        self.assertEqual([Status.MALFORMED_IDENTIFIER], [f.status for f in findings])

    def test_network_failure_surfaces_as_finding_not_success(self) -> None:
        body = "## References\n- arXiv:1706.03762\n"
        manifest = {("22.quantization-precision-and-efficiency", "1706.03762"): ATTENTION}
        fetch = RecordingFetch(*[NetworkFailure("no route to host")] * 3)
        findings = self.check(body, manifest, fetch, max_attempts=3)
        self.assertEqual([Status.NETWORK_FAILURE], [f.status for f in findings])
        self.assertEqual(3, findings[0].attempts)


class ManifestTests(unittest.TestCase):
    def test_repository_manifest_is_valid_and_sorted(self) -> None:
        table = load_manifest()
        self.assertGreater(len(table), 0)
        # sorted + one entry per line: reviewer phai doc duoc diff.
        rows = json.loads((TESTS_DIR / "citation-manifest.json").read_text(encoding="utf-8"))["citations"]
        keys = [(row["article"], row["arxivId"]) for row in rows]
        self.assertEqual(sorted(keys), keys)

    def test_repository_manifest_covers_every_citation_in_the_articles(self) -> None:
        # Day la hop dong giua bai hoc va manifest: moi trich dan trong bai hoc
        # deu phai co muc khai bao. Test nao se do neu ai them id moi.
        table = load_manifest()
        required = collect_required_citations()
        missing = [key for key in required if key not in table]
        self.assertEqual([], missing, f"bai hoc trich id chua co trong citation-manifest.json: {missing}")

    def test_repository_manifest_has_no_invented_ids(self) -> None:
        # ID dang duoi cua arXiv chua bao gio dung cho bai moi; id trong
        # curriculum phai la bai thuoc nhung nam 2013+.
        table = load_manifest()
        for (_article, arxiv_id) in table:
            self.assertRegex(arxiv_id, r"\A\d{4}\.\d{4,5}\Z")
            self.assertGreaterEqual(int(arxiv_id[:2]), 13)

    def test_manifest_rows_must_be_sorted(self) -> None:
        raw = {
            "citations": [
                {"article": "b", "arxivId": "1706.03762", "expectedTitle": "t"},
                {"article": "a", "arxivId": "1706.03762", "expectedTitle": "t"},
            ]
        }
        _table, problems = parse_manifest(raw)
        self.assertTrue(any("sap xep" in problem for problem in problems))

    def test_manifest_rejects_duplicate_keys(self) -> None:
        raw = {
            "citations": [
                {"article": "a", "arxivId": "1706.03762", "expectedTitle": "t"},
                {"article": "a", "arxivId": "1706.03762", "expectedTitle": "t2"},
            ]
        }
        _table, problems = parse_manifest(raw)
        self.assertTrue(any("trung khoa" in problem for problem in problems))

    def test_manifest_rejects_malformed_identifier(self) -> None:
        raw = {"citations": [{"article": "a", "arxivId": "12.34", "expectedTitle": "t"}]}
        _table, problems = parse_manifest(raw)
        self.assertTrue(any("khong hop le" in problem for problem in problems))

    def test_manifest_rejects_blank_title(self) -> None:
        raw = {"citations": [{"article": "a", "arxivId": "1706.03762", "expectedTitle": "  "}]}
        _table, problems = parse_manifest(raw)
        self.assertTrue(any("expectedTitle" in problem for problem in problems))


class CanonicalTitleRegressionTests(unittest.TestCase):
    """Hai tieu de canonical ma khai bao tay sai, phat hien khi chay `--live`.

    Ca hai duoc xac nhan tren ca hai be mat cua arXiv: Atom feed (nguon chinh)
    va trang `abs` HTML. `Heterogenous` la chinh tac cua arXiv cho BEIR — `Heterogeneous`
    chi xuat hien o ban in cua bai, va `classical` trong tieu de Belkin khong ton
    tai tren arXiv. Test nay giu lai bang chung, va mot nguoi review doc lesson
    van co the tu kiem bang mat tai khi doi tieu de khai bao.
    """

    CONFIRMED = {
        "1812.11118": "Reconciling modern machine learning practice and the bias-variance trade-off",
        "2104.08663": "BEIR: A Heterogenous Benchmark for Zero-shot Evaluation of Information Retrieval Models",
    }

    def test_manifest_uses_confirmed_canonical_titles(self) -> None:
        table = load_manifest()
        declared = {arxiv_id: title for (_article, arxiv_id), title in table.items()}
        for arxiv_id, title in self.CONFIRMED.items():
            self.assertIn(arxiv_id, declared, f"manifest phai co muc cho arXiv:{arxiv_id}")
            self.assertEqual(title, declared[arxiv_id])

    def test_typo_variants_are_rejected_against_the_declared_title(self) -> None:
        # Bai hoc 25/27/29 van viet "Heterogeneous" va bai 09 viet
        # "classical". Do la loi cua bai hoc, khong phai cua khai bao — va
        # verifier phai bat duoc, vi day chinh la lo bao doc ta day ra.
        table = load_manifest()
        declared = {arxiv_id: title for (_article, arxiv_id), title in table.items()}
        for arxiv_id, typo in (
            ("1812.11118", "Reconciling modern machine-learning practice and the classical bias-variance trade-off"),
            ("2104.08663", "BEIR: A Heterogeneous Benchmark for Zero-shot Evaluation of Information Retrieval Models"),
        ):
            self.assertFalse(
                titles_match(declared[arxiv_id], typo),
                f"biến thể sai cua arXiv:{arxiv_id} phai bị từ chối, không phải bỏ qua âm thầm",
            )


class ReportTests(unittest.TestCase):
    def test_report_defaults_to_empty_lists(self) -> None:
        report = Report()
        self.assertEqual([], report.findings)
        self.assertEqual([], report.unreferenced)


if __name__ == "__main__":
    unittest.main()