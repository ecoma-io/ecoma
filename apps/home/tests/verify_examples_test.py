#!/usr/bin/env python3
"""Unit test cho phep doi chieu comment canh sanh cua `verify-examples.py`.

Khong chay code cua lesson — chi day bo so sanh bang input gia lap, nen test
chay nhanh va khong phu thuoc numpy. Dung `unittest` cua stdlib vi repo khong
co pytest va khong duoc them dependency Python.

Lay mau that bai (xem `verify-examples.py`):

    1. lenh.py test — module nay co dau `-` nen khong import truc tiep duoc
       bang ten hop le; `importlib` tai file bang duong dan tuyet doi.

Chay:
    python3 -m unittest apps.home.tests.verify_examples_test
"""
from __future__ import annotations

import importlib.util
import unittest
from pathlib import Path
from types import ModuleType

SCRIPT = Path(__file__).with_name("verify-examples.py")


def load_validator() -> ModuleType:
    """`import` module co dau `-` trong ten bang cach tai file truc tiep."""
    spec = importlib.util.spec_from_file_location("verify_examples", SCRIPT)
    assert spec and spec.loader, f"khong tai duoc {SCRIPT}"
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


V = load_validator()


class ParseExpectedTest(unittest.TestCase):
    """`parse_expected` tach comment thanh phan de so sanh, hoac bo qua."""

    def test_empty_comment_is_skipped(self) -> None:
        self.assertIsNone(V.parse_expected(""))
        self.assertIsNone(V.parse_expected("   "))

    def test_scalar_value_comment_parses_to_one_number(self) -> None:
        got = V.parse_expected("3.0822")
        assert got is not None
        self.assertTrue(got.is_numeric)
        self.assertEqual(got.numbers, ["3.0822"])

    def test_english_prose_comment_is_skipped(self) -> None:
        # Comment tieng Anh KHONG phai ket qua in ra; bo qua co y. Sau do
        # `comments_after_prints` loai no truoc khi so sanh.
        self.assertFalse(V.is_value_comment("head 1"))
        self.assertFalse(V.is_value_comment("entry (i,j) depends only on i-j"))
        self.assertFalse(V.is_value_comment("the batched form, for all S queries"))

    def test_prose_comment_with_digits_is_still_skipped(self) -> None:
        # Comment chua chu thi khong kiem chung duoc. `is_value_comment` la
        # **co cong trong day chu** nen `parse_expected` — ham doi chieu — phai
        # tra None cho no, va comment do bien mat khoi danh sach assert.
        self.assertFalse(V.is_value_comment("2 x 4 matmul with head dim 4"))
        self.assertIsNone(V.parse_expected("2 x 4 matmul with head dim 4"))
        self.assertEqual(V.comments_after_prints("print(x)  # 2 x 4 matmul\n"), [])

    def test_letters_make_a_comment_prose_and_skip_it(self) -> None:
        # `VALUE_COMMENT` cho phep `e`/`E` cho khoa hoc nen mot comment prose
        # chi con chu so + dau phan cach (dam, ngoac, cong) van la value. Bat ky
        # chu nao khac (`x`, `xem`, `~`) loai no khoi danh sach assert — va
        # do la chu thuc te duoc kiem chung: comment so chua con so thi **bao
        # loi**, comment giai thich thi im lang.
        for prose in ("2 x 4 matmul", "~3.5 sigma", "xem tren", "3.5 (lam tron)"):
            with self.subTest(prose=prose):
                self.assertFalse(V.is_value_comment(prose))
                self.assertIsNone(V.parse_expected(prose))

    def test_empty_comment_is_skipped(self) -> None:
        # Comment rong khong phai assert gi — im lang.
        for comment in ("", "   "):
            with self.subTest(comment=comment):
                self.assertIsNone(V.parse_expected(comment))
                self.assertTrue(V.compare(comment, "1.0")[0])

    def test_comment_that_parses_to_nothing_fails_loudly(self) -> None:
        # Comment chi con dau phan cach (`[]`, `(`, `,`) match `VALUE_COMMENT`
        # nhung tach ra khong con so nao. Ban cu im lang bo qua comment sai —
        # dung chinh xac lo "co mot so trung". Nay phai bao loi.
        for comment in ("-", "(", "[]", ",", "  +  "):
            with self.subTest(comment=comment):
                ok, detail = V.compare(comment, "[1.0 2.0]")
                self.assertFalse(ok, f"{comment!r} phai bao loi")
                self.assertIn("khong chua con so", detail)


class NumericCompareTest(unittest.TestCase):
    """So sanh so: phai khop HET, dung thu tu, dung so chu so thap phan."""

    def assert_matches(self, want: str, got: str) -> None:
        ok, detail = V.compare(want, got)
        self.assertTrue(ok, f"expected {want!r} to match {got!r}: {detail}")

    def assert_differs(self, want: str, got: str, *needles: str) -> None:
        ok, detail = V.compare(want, got)
        self.assertFalse(ok, f"expected {want!r} NOT to match {got!r}")
        for needle in needles:
            self.assertIn(needle, detail)

    # --- scalar dung, o ca hai chieu -------------------------------------

    def test_correct_scalar_passes(self) -> None:
        self.assert_matches("4", "4")
        self.assert_matches("3.0822", "3.082207001484488")

    def test_correct_scalar_with_wrong_value_fails(self) -> None:
        self.assert_differs("4", "3", "gia tri")
        self.assert_differs("0.7480", "0.7481", "gia tri")
        self.assert_differs("0.9974", "0.9975", "gia tri")

    # --- vector dung -----------------------------------------------------

    def test_correct_vector_passes(self) -> None:
        # Mau that bai lesson 15.
        self.assert_matches(
            "[-0.837054 -1.128204  1.200991  0.764267]",
            "[-0.83705428 -1.1282036   1.20099093  0.76426696]",
        )

    def test_correct_two_vector_on_one_line_passes(self) -> None:
        # Mau that bai lesson 02: hai so cua mot print, cach nhau dau cach.
        self.assert_matches(
            "5.4772 5.4772", "5.477225575051661 5.477225575051662"
        )

    # --- THIEU gia tri ---------------------------------------------------

    def test_missing_vector_element_fails(self) -> None:
        # Comment 4 phan tu, output chi 3.
        self.assert_differs(
            "[-0.837054 -1.128204  1.200991  0.764267]",
            "[-0.83705428 -1.1282036   1.20099093]",
            "thieu gia tri",
            "can 4 gia tri",
        )

    def test_missing_second_of_two_scalars_fails(self) -> None:
        # Lo loi goc: `numeric_match` cu trong bat buoc phai "co mot so nao
        # trung", nen comment 2 so chi in ra 1 so van pass.
        self.assert_differs("5.4772 5.4772", "5.477225575051661", "thieu gia tri")

    def test_one_correct_plus_several_incorrect_fails(self) -> None:
        # Comment 5 phan tu, chi phan tu dau dung.
        self.assert_differs(
            "1.0 2.0 3.0 4.0 5.0",
            "1.0 9.0 9.0 9.0 9.0",
            "gia tri 9.0 != 2.0",
        )
        self.assert_differs("0.5 0.25 0.125", "0.5 0.2 0.1", "gia tri")

    def test_scalar_comment_never_matches_a_longer_vector(self) -> None:
        # Khong duoc dung "mot so trung bat dau" cho comment 1 so.
        self.assert_differs("4", "4 4", "output thua")
        self.assert_differs("4", "4 4 4")

    # --- THUA gia tri (vector sai do dai) ---------------------------------

    def test_extra_actual_value_fails(self) -> None:
        self.assert_differs(
            "[-0.837054 -1.128204  1.200991  0.764267]",
            "[-0.83705428 -1.1282036   1.20099093  0.76426696  0.5]",
            "output thua",
            "can 4 gia tri",
        )

    def test_extra_value_fails_even_when_the_first_four_are_correct(self) -> None:
        self.assert_differs("1.0 2.0", "1.0 2.0 3.0", "output thua")

    # --- THU TU sai ------------------------------------------------------

    def test_reordered_vector_fails(self) -> None:
        # Thu tu la mot phan cua contract: vector co y nghia.
        self.assert_differs(
            "[1.0 2.0 3.0]", "[3.0 2.0 1.0]", "gia tri", "!= 1.0"
        )
        self.assert_differs("1.0 2.0 3.0 4.0", "2.0 1.0 4.0 3.0", "gia tri")
        self.assert_differs(
            "[-0.837054 -1.128204  1.200991  0.764267]",
            "[-0.83705428  1.20099093 -1.1282036   0.76426696]",
            "gia tri",
        )

    # --- Khoang hoc va dau am ---------------------------------------------

    def test_correct_scientific_notation_passes(self) -> None:
        self.assert_matches("3e+09", "3000000000.0")

    def test_incorrect_scientific_notation_fails(self) -> None:
        # Sai he so, dung dang: phai fail, khong duoc bo qua vi dang khop.
        self.assert_differs("3e+09", "4e+09", "gia tri")
        self.assert_differs("3e+09", "3.5e+09", "gia tri")
        self.assert_differs("1.2e-05", "1.3e-05", "gia tri")
        self.assert_differs("1.2e-05", "1.2e-04", "gia tri")
        self.assert_differs("-1.5e+03", "-1.5e+04", "gia tri")

    def test_scientific_notation_with_decimals_passes(self) -> None:
        self.assert_matches("1.2e-05", "1.2e-05")
        self.assert_matches("-1.5e+03", "-1500.0")

    def test_scientific_notation_precision_is_significant(self) -> None:
        # `1.2e-05` khai bao 6 chu so ke tu chu so dau (cua 0.000012), nen
        # chi mot diem lam tron duoc dung — comment sai so voi output phai bao
        # loi, khong duoc "thong minh" cho khop.
        self.assert_differs("1.2e-05", "1.29e-05", "gia tri")
        self.assert_differs("1.2e-05", "1.2e-04", "gia tri")

    def test_correct_negative_passes(self) -> None:
        self.assert_matches("-3.808745", "-3.808745")
        self.assert_matches("-1.128204", "-1.1282036")

    def test_incorrect_negative_fails(self) -> None:
        self.assert_differs("-3.808745", "3.808745", "gia tri")
        self.assert_differs("-3.808745", "-3.808746", "gia tri")
        self.assert_differs("-1.128204", "-1.128205", "gia tri")
        self.assert_differs("-0.837054", "0.837054", "gia tri")

    # --- Lam tron ---------------------------------------------------------

    def test_rounding_respects_comment_decimal_count(self) -> None:
        # 6 chu so: `-1.1282036` -> `-1.128204` (ROUND_HALF_UP).
        self.assert_matches("-1.128204", "-1.1282036")
        # 4 chu so: `5.477225575051662` -> `5.4772`.
        self.assert_matches("5.4772", "5.477225575051662")
        # 0 chu so: phai la so nguyen, `3.5` -> `4` khong phai `3`.
        self.assert_matches("3", "3.0")
        # 4 chu so: comment het chu so thap phan thi gia tri thuc te phai tron
        # dung 4 chu so, khong phai khop bat ky thu gi trong khoang.
        self.assert_matches("3.5000", "3.5")

    def test_rounding_boundary_uses_half_up(self) -> None:
        self.assert_matches("3.5", "3.45")  # ROUND_HALF_UP, giong f"{3.45:.1f}"
        self.assert_matches("4", "3.5")  # ROUND_HALF_UP, giong f"{3.5:.0f}"

    def test_rounding_mismatch_fails(self) -> None:
        # Comment het chu so thap phan: chi mot diem lam tron duoc dung.
        self.assert_differs("3.5", "3.4499", "gia tri 3.4 != 3.5")
        self.assert_differs("0.9974", "0.9975", "gia tri")
        self.assert_differs("5.4772", "5.4773", "gia tri")

    def test_rounded_comment_and_short_actual_are_equal(self) -> None:
        # Doc lap float: `3.5000` va `3.5` cung mot so.
        self.assert_matches("3.5000", "3.5")
        self.assert_matches("3e+09", "3000000000")

    def test_underscore_grouping_is_readable(self) -> None:
        self.assert_matches("7_000_000_000", "7000000000")

    def test_decimals_of_counts_digits_from_the_first_digit(self) -> None:
        self.assertEqual(V.decimals_of("3.5000"), 4)
        self.assertEqual(V.decimals_of("0.9974"), 4)
        self.assertEqual(V.decimals_of("-0.837054"), 6)
        # Khoa hoc: so chu so cong khai bao, ke ca am — `1.2e-05` la 6 chu so
        # cua 0.000012. Bo qua dau am se bien comment thanh vo khop bat ky gi.
        self.assertEqual(V.decimals_of("-1.2e-05"), 6)
        self.assertEqual(V.decimals_of("1.2e-05"), 6)
        self.assertEqual(V.decimals_of("3e+09"), -9)
        self.assertEqual(V.decimals_of("4"), 0)


class TokenCompareTest(unittest.TestCase):
    """Assert khong phai so: TAT CA token phai khop, va khong bao gio la
    duong thay the cho so sanh so."""

    def test_shape_and_bool_passes(self) -> None:
        self.assertTrue(V.compare("(3, 2, 4)", "(3, 2, 4)")[0])
        self.assertTrue(V.compare("True", "True")[0])
        self.assertTrue(V.compare("False", "False")[0])
        self.assertTrue(V.compare("[0.4 0.6]", "[0.4 0.6]")[0])

    def test_wrong_bool_fails(self) -> None:
        ok, detail = V.compare("True", "False")
        self.assertFalse(ok)
        self.assertIn("thieu token", detail)
        self.assertFalse(V.compare("False", "True")[0])

    def test_wrong_shape_fails(self) -> None:
        self.assertFalse(V.compare("(3, 2, 4)", "(3, 4, 2)")[0])
        self.assertFalse(V.compare("(3, 2, 4)", "(6, 2, 4)")[0])

    def test_partial_token_match_is_not_enough(self) -> None:
        # Lo loi goc cua `token_match`: chi mot token chung la duoc chay. Boolean
        # la assert dang chu nen phai so sanh nguyen van — dong nao chua `True`
        # thi khong duoc khop voi comment `True`.
        ok, detail = V.compare("True", "False")
        self.assertFalse(ok)
        self.assertIn("thieu token", detail)
        self.assertFalse(V.compare("True", "5.0")[0])
        self.assertFalse(V.compare("False", "True")[0])

    def test_textual_assertion_cannot_validate_a_numerical_assertion(self) -> None:
        # Comment token khong bao gio la duong thay the cho comment so.
        self.assertFalse(V.compare("True", "[-0.999 0.999]")[0])
        self.assertFalse(V.compare("(3, 2, 4)", "[[ 1.5 2.5]]")[0])
        # Va chieu nguoc: comment so khong duoc "hop" bang output toan chu.
        self.assertFalse(V.compare("3.0822", "about three oh two")[0])
        self.assertFalse(V.compare("4", "True")[0])
        # Comment so thoi cung khong duoc match vao dong chi chua token
        # trung so voi no.
        self.assertFalse(V.compare("1.0 2.0 3.0 4.0 5.0", "False: rows move")[0])

    def test_non_numeric_comment_without_numbers_reports_clearly(self) -> None:
        # Comment prose con chu da bi `parse_expected` loai truoc khi so sanh.
        # `comments_after_prints` la noi duy nhat quyet dinh comment nao duoc
        # kiem chung, va no phai bo qua comment do im lang.
        block = "print(a)  # head 1\nprint(b)  # 1.0\n"
        self.assertEqual(
            [comment for _, comment in V.comments_after_prints(block)], ["1.0"]
        )


class BooleanCompareTest(unittest.TestCase):
    """Assert boolean: `print(np.allclose(...))  # True` la mot assert that."""

    def test_correct_bool_passes(self) -> None:
        self.assertTrue(V.compare("True", "True")[0])
        self.assertTrue(V.compare("False", "False")[0])
        self.assertTrue(V.compare("None", "None")[0])

    def test_wrong_bool_fails(self) -> None:
        # Comment nay **khong** bao gio duoc kiem chung o ban cu (khong match
        # `VALUE_COMMENT`), nen mot loi tinh hinh dang se lot qua im lang.
        for want, got in (("True", "False"), ("False", "True")):
            with self.subTest(want=want, got=got):
                ok, detail = V.compare(want, got)
                self.assertFalse(ok)
                self.assertIn("thieu token", detail)

    def test_bool_cannot_validate_a_numeric_line(self) -> None:
        self.assertFalse(V.compare("False", "[-0.999 0.999]")[0])
        self.assertFalse(V.compare("True", "1.0 2.0")[0])

    def test_shape_comment_is_compared_as_numbers(self) -> None:
        # `(3, 2, 4)` tach duoc thanh 3 con so, nen no phai khop *dung* 3 so
        # do — khong phai "co token 4 la du".
        self.assertTrue(V.compare("(3, 2, 4)", "(3, 2, 4)")[0])
        self.assertFalse(V.compare("(3, 2, 4)", "(3, 4, 2)")[0])
        self.assertFalse(V.compare("(3, 2, 4)", "(6, 2, 4)")[0])


class PrintScannerTest(unittest.TestCase):
    """May quet `print` phai tim duoc moi lenh, ke ca lenh nhieu dong/thu le."""

    def test_nested_call_does_not_steal_the_closing_paren(self) -> None:
        block = 'print(f"{np.linalg.norm(X):.4f}")  # 3.0822\nprint(y)  # 4\n'
        self.assertEqual(
            [comment for _, comment in V.comments_after_prints(block)], ["3.0822", "4"]
        )

    def test_comment_is_taken_from_the_closing_line(self) -> None:
        block = 'print(\n    a + b,   # tong\n    c,\n)\nprint(d)  # 5.0\n'
        self.assertEqual(
            [comment for _, comment in V.comments_after_prints(block)], ["5.0"]
        )

    def test_value_comment_on_multiline_print_is_found(self) -> None:
        block = 'print(\n    f"BM25({d}) = {s:.6f}",  # 5.4772\n    f"RRF = {r:.6f}",\n)\n'
        found = V.comments_after_prints(block)
        self.assertEqual([comment for _, comment in found], ["5.4772"])

    def test_string_containing_a_paren_does_not_confuse_the_scanner(self) -> None:
        block = 'print("x = )")  # 1.0\nprint(y)  # 2.0\n'
        self.assertEqual(
            [comment for _, comment in V.comments_after_prints(block)], ["1.0", "2.0"]
        )

    def test_hash_inside_a_string_is_not_a_comment(self) -> None:
        block = 'print(f"{x} # not a comment")  # 1.0\n'
        self.assertEqual(
            [comment for _, comment in V.comments_after_prints(block)], ["1.0"]
        )

    def test_method_call_named_print_is_not_a_statement(self) -> None:
        block = 'logger.print(x)  # 1.0\nprint(y)  # 2.0\n'
        self.assertEqual(
            [comment for _, comment in V.comments_after_prints(block)], ["2.0"]
        )

    def test_unclosed_paren_does_not_hang_the_scanner(self) -> None:
        block = "print(1\nprint(2)  # 2.0\n"
        self.assertEqual(
            [comment for _, comment in V.comments_after_prints(block)], ["2.0"]
        )


class ExtractTest(unittest.TestCase):
    """`comments_after_prints` va `PRINT` — bao dam khong bo sot `print`."""

    def test_indented_print_with_comment_is_found(self) -> None:
        block = 'for x in xs:\n    print(x)   # 1.0\n'
        self.assertEqual(
            V.comments_after_prints(block), [("x", "1.0")]
        )

    def test_indented_multiline_print_is_not_silently_dropped(self) -> None:
        # Regex cu bat dau bang `^print` nen bo qua moi `print` co thu le, ke ca
        # comment gia tri nam tren dong con cua lenh nhieu dong (bai 28: `print(
        # f"...",  # Solving w*ln[A] ...`). Comment do chua bien bao gio duoc
        # kiem chung.
        block = '    print(\n        f"{x} = {v}",  # 5.4772\n        f"{n} = {m}"\n    )\n'
        found = V.comments_after_prints(block)
        self.assertEqual(len(found), 1, f"phai bat duoc 1 comment, nhan {found}")
        self.assertEqual(found[0][1], "5.4772")

    def test_prose_comment_is_dropped_not_checked(self) -> None:
        block = 'print(a)  # entry (i,j) depends only on i-j\nprint(b)  # 3.5\n'
        self.assertEqual(
            V.comments_after_prints(block), [("b", "3.5")]
        )

    def test_comment_with_no_number_surfaces_as_a_problem(self) -> None:
        block = "print(a)  # []\n"
        problems, matched = V.match_blocks(V.assertions([block]), ["1.0"])
        self.assertEqual(matched, 0)
        self.assertEqual(len(problems), 1)


class MatchBlocksTest(unittest.TestCase):
    """Doi chieu nhieu comment voi output nhieu dong (print mang numpy)."""

    def assert_no_problems(self, expected: list[tuple[int, str, str]], actual: list[str]) -> None:
        problems, matched = V.match_blocks(expected, actual)
        self.assertEqual(problems, [], f"expected no problem, got {problems}")
        self.assertEqual(matched, len(expected))

    def assert_problems(self, expected: list[tuple[int, str, str]], actual: list[str]) -> list:
        problems, _ = V.match_blocks(expected, actual)
        self.assertTrue(problems, "expected at least one problem")
        return problems

    def test_multiline_array_matches_across_two_lines(self) -> None:
        # `print(Y)` in 2 dong: comment phai mo ta **toan bo** 6 so, khong
        # phai 4 so dau. Comment chi 4 so la comment bi cat ngan — truoc ban
        # day bo cat con theo comment nen no luon "hop", va comment sai khong
        # bao gio bi bat.
        self.assert_no_problems(
            [(0, "Y", "[0.1 -3.7 1.3 2.1 5.8 -1.2]")],
            ["[[ 0.1 -3.7  1.3]", " [ 2.1  5.8 -1.2]]"],
        )

    def test_comment_covering_only_the_first_row_of_a_multiline_array_fails(self) -> None:
        # Doi chieu voi `test_multiline_array_matches_across_two_lines`: comment
        # cat ngan 2 dong thi bao "output thua", chu khong im lang bo qua.
        problems = self.assert_problems(
            [(0, "Y", "[0.1 -3.7 1.3]")],
            ["[[ 0.1 -3.7  1.3]", " [ 2.1  5.8 -1.2]]"],
        )
        self.assertIn("output thua", problems[0].detail)
        self.assertIn("output co 6", problems[0].detail)

    def test_multiline_array_with_wrong_second_line_fails(self) -> None:
        problems = self.assert_problems(
            [(0, "Y", "[0.1 -3.7 1.3 2.1 5.8 -1.2]")],
            ["[[ 0.1 -3.7  1.3]", " [ 9.9  5.8 -1.2]]"],
        )
        self.assertIn("gia tri", problems[0].detail)

    def test_second_multiline_array_still_matches(self) -> None:
        # Bai 01: hai mang 2 dong lien nhau, con lai phai dung con tro. Doan
        # cho comment thu hai phai bat dau o dong thu hai chu khong phai lan
        # nguoc lai dong dau.
        self.assert_no_problems(
            [(0, "out[0]", "[[2.1 5.8 -2.2] [10.1 13.8 -2.2]]")],
            ["[[  2.1   5.8  -2.2]", " [ 10.1  13.8  -2.2]]"],
        )

    def test_scalar_comment_after_a_multiline_array_is_not_swallowed(self) -> None:
        # Bai 01: `print(X)` in mang 2 dong roi moi den `print(X.shape)`. Doan
        # cua comment `.shape` phai bat dau **dung cho lenh shape**, khong lan
        # nguoc lai mang — neu lan, comment se doi 3 so cua shape voi 6 so cua
        # mang va bao sai o chinh bai dung.
        self.assert_no_problems(
            [(0, "X.shape", "(3, 2, 4)")],
            ["[[ 0.1 -3.7  1.3]", " [ 2.1  5.8 -1.2]]", "(3, 2, 4)"],
        )

    def test_scalar_comment_fails_when_its_own_output_line_is_absent(self) -> None:
        # Cung vi tri tren nhung dong `(3, 2, 4)` khong ton tai: comment phai
        # bao loi, khong doi 3 so comment len 6 so cua mang de "khop".
        problems = self.assert_problems(
            [(0, "X.shape", "(3, 2, 4)")],
            ["[[ 0.1 -3.7  1.3]", " [ 2.1  5.8 -1.2]]"],
        )
        self.assertIn("output co 6", problems[0].detail)

    def test_scalar_comments_walk_monotonically(self) -> None:
        self.assert_no_problems(
            [(0, "rank", "4"), (0, "rank", "3"), (0, "cond", "3e+09")],
            ["4", "3", "3000000000.0"],
        )

    def test_reversed_scalar_comments_fail(self) -> None:
        self.assert_problems(
            [(0, "rank", "4"), (0, "rank", "3")], ["3", "4"]
        )

    def test_cursor_skips_output_of_unannotated_prints(self) -> None:
        # `print(Y)` khong comment in 2 dong truoc, `print(out.shape)` co comment
        # thi phai bo qua 2 dong do. Con tro phai **tien** — khong bao gio lui,
        # vi comment den truoc lenh khong co comment se khong duoc gan nham.
        self.assert_no_problems(
            [(1, "out.shape", "(3, 2, 3)")],
            ["[[ 0.1 -3.7  1.3]", " [ 2.1  5.8 -1.2]]", "(3, 2, 3)"],
        )

    def test_comment_matching_a_later_line_passes_when_earlier_ones_differ(self) -> None:
        self.assert_no_problems([(2, "rank", "4")], ["1.5", "9.9", "4"])

    def test_a_skipped_line_can_be_consumed_by_a_later_comment(self) -> None:
        # Han vi chay duoc ghi nhan trong docstring: comment `2.0` bat dau quet
        # tu con tro 0, bo qua dong `1.0` (thuoc lenh khong comment) va **an**
        # dong do. Comment tiep theo `1.0` roi khong con dong nao de khop.
        # Day la he qua tat yeu cua viec khong gan danh dau output.
        problems = self.assert_problems(
            [(0, "a", "2.0"), (0, "b", "1.0")], ["1.0", "2.0"]
        )
        self.assertIn("het output", problems[0].actual + problems[0].detail)

    def test_trailing_output_is_not_an_error(self) -> None:
        # Output thua cuoi cung khong phai loi: chi "output thua" *trong doan
        # da chon* moi la loi.
        self.assert_no_problems([(0, "a", "1.0")], ["1.0", "9.9 9.9", "tail"])

    def test_same_comment_twice_needs_two_output_lines(self) -> None:
        # `5.4772 5.4772` in 1 dong; comment lap lai 2 lan can 2 dong.
        self.assert_problems(
            [(0, "n", "5.4772"), (0, "n", "5.4772")], ["5.477225575051661"]
        )

    def test_exhausted_output_is_reported_clearly(self) -> None:
        problems = self.assert_problems([(0, "y", "1.0")], [])
        self.assertIn("<het output>", problems[0].actual)

    def test_problem_records_article_block_expression_expected_actual(self) -> None:
        problems, _ = V.match_blocks(
            [(7, "np.linalg.norm(W)", "3.0822")], ["9.9"]
        )
        rendered = problems[0].render()
        for needle in ("block 7", "np.linalg.norm(W)", "3.0822", "9.9", "gia tri"):
            self.assertIn(needle, rendered)


class RunLessonTest(unittest.TestCase):
    """Chay lesson that — stdlib khong can numpy cho cac case nay."""

    def test_stdout_lines_are_returned(self) -> None:
        lines, failure = V.run_lesson(["print(1)", "print('a b')"], 30)
        self.assertEqual(failure, "")
        self.assertEqual(lines, ["1", "a b"])

    def test_nonzero_exit_is_reported_as_a_crash(self) -> None:
        lines, failure = V.run_lesson(["raise SystemExit(3)"], 30)
        self.assertEqual(lines, [])
        self.assertIn("chay loi", failure)

    def test_timeout_is_reported(self) -> None:
        _lines, failure = V.run_lesson(["while True: pass"], 1)
        self.assertEqual(failure, "timeout")


if __name__ == "__main__":
    unittest.main(verbosity=2)