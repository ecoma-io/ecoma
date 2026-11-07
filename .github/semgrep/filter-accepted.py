#!/usr/bin/env python3
"""Filter SARIF result của semgrep qua allowlist `accepted-shapes.json`.

Hai chế độ:

  filter  — đọc SARIF, DROP mọi result khớp MỘT entry allowlist (rule + path +
            start..end line + TỪNG dòng code khớp regex ghim của entry), ghi
            SARIF còn lại ra stdout (output này là file upload lên code
            scanning). Result khớp (rule, path, line) nhưng code KHÔNG còn khớp
            regex ghim → GIỮ nguyên result trong output và FAIL: dòng đã bị
            sửa, exception phải được xem lại bởi người, không được tự động im.

  gate    — thay thế `semgrep --error` cho workflow: exit 0 khi mọi result đều
            được chấp nhận bởi allowlist (cùng điều kiện như trên), exit 1 nếu
            còn result nào ngoài allowlist hoặc một entry thất bại kiểm shape.

Fail-closed ở cả hai chế độ:
  * entry allowlist không khớp result nào → FAIL (finding đã hết — prune entry).
  * không đọc được file nguồn để so regex → FAIL, không chấp nhận mù.

Không dùng `nosemgrep`: đo trên semgrep 1.181.0 — inline suppression làm
`--error` xanh nhưng KHÔNG loại result khỏi SARIF, nên code scanning vẫn mở
alert. Script này là điểm chế duy nhất cho cả gate lẫn SARIF.
"""

from __future__ import annotations

import json
import re
import sys
from pathlib import Path

RULE_PREFIX = "github.semgrep."


def load_allowlist(config_path: Path) -> list[dict]:
    with config_path.open(encoding="utf-8") as f:
        entries = json.load(f)
    seen: set[tuple[str, str, int, int]] = set()
    for entry in entries:
        key = (entry["rule"], entry["path"], entry["start"], entry["end"])
        if key in seen:
            raise SystemExit(f"duplicate allowlist entry: {key}")
        seen.add(key)
        if not entry.get("reason", "").strip():
            raise SystemExit(f"allowlist entry without reason: {key}")
        if not entry.get("lines"):
            raise SystemExit(f"allowlist entry without pinned lines: {key}")
    return entries


def read_source_lines(path: str) -> dict[int, str] | None:
    file = Path(path)
    if not file.is_file():
        return None
    try:
        return {
            number + 1: line.rstrip("\n")
            for number, line in enumerate(file.read_text(encoding="utf-8").splitlines())
        }
    except (OSError, UnicodeDecodeError):
        return None


def entry_matches(entry: dict, result: dict) -> tuple[bool, str]:
    """Trả (khớp, lý do không khớp) giữa một entry allowlist và một SARIF result."""
    location = result["locations"][0]["physicalLocation"]
    sarif_path = location["artifactLocation"]["uri"]
    start = location["region"]["startLine"]
    end = location["region"].get("endLine", start)
    rule = result["ruleId"].removeprefix(RULE_PREFIX)

    if entry["rule"] != rule or entry["path"] != sarif_path:
        return False, ""
    if not (entry["start"] <= start and end <= entry["end"]):
        return False, ""

    source = read_source_lines(sarif_path)
    if source is None:
        return False, f"source file unreadable: {sarif_path}"

    for line_number_text, pattern in entry["lines"].items():
        line_number = int(line_number_text)
        actual = source.get(line_number)
        if actual is None:
            return False, f"line {line_number} missing in {sarif_path}"
        if re.fullmatch(pattern, actual) is None:
            return (
                False,
                f"line {line_number} of {sarif_path} drifted from its pinned shape: {actual!r}",
            )
    return True, ""


def main() -> None:
    if len(sys.argv) != 4 or sys.argv[1] not in {"filter", "gate"}:
        print(
            "usage: filter-accepted.py <filter|gate> <sarif-or-json> <accepted-shapes.json>",
            file=sys.stderr,
        )
        raise SystemExit(2)

    mode, findings_path, config_path = sys.argv[1], Path(sys.argv[2]), Path(sys.argv[3])
    entries = load_allowlist(config_path)

    with findings_path.open(encoding="utf-8") as f:
        document = json.load(f)

    results = document["runs"][0]["results"]
    kept: list[dict] = []
    accepted: list[tuple[str, int]] = []
    failures: list[str] = []

    for result in results:
        location = result["locations"][0]["physicalLocation"]
        matched_entry = None
        drift_reason = ""
        for entry in entries:
            matched, reason = entry_matches(entry, result)
            if matched:
                matched_entry = entry
                break
            if reason:
                drift_reason = reason

        rule = result["ruleId"].removeprefix(RULE_PREFIX)
        where = (
            f"{location['artifactLocation']['uri']}:"
            f"{location['region']['startLine']}"
        )
        if matched_entry is not None:
            accepted.append((rule, location["region"]["startLine"]))
            # Accept = DROP khỏi SARIF upload (đó là mục đích của chế độ filter):
            # code scanning không mở alert cho shape đã duyệt. Chế độ gate thì
            # `continue` đơn giản là không ghi failure.
            continue
        if drift_reason:
            failures.append(f"{where}: {drift_reason}")
            # Line drifted → the finding is NOT accepted; keep it visible.
            if mode == "filter":
                kept.append(result)
            continue
        if mode == "gate":
            failures.append(f"{where}: finding outside the accepted shapes")
        else:
            kept.append(result)

    used = {(entry["rule"], entry["start"]) for entry in entries}
    matched_rules = {rule for rule, _ in accepted}
    for entry in entries:
        if (entry["rule"], entry["start"]) not in {
            (rule, line) for rule, line in accepted
        }:
            failures.append(
                f"stale allowlist entry {entry['path']}:{entry['start']} "
                "(no SARIF result matched it — finding was fixed or moved; prune or re-pin)"
            )

    if mode == "filter":
        document["runs"][0]["results"] = kept
        out = sys.stdout.buffer
        out.write(json.dumps(document).encode("utf-8"))
        out.flush()
        print(
            f"[filter-accepted] sarif results: {len(results)} in, "
            f"{len(kept)} kept, {len(accepted)} accepted by allowlist",
            file=sys.stderr,
        )

    if failures:
        for failure in failures:
            print(f"::error::[accepted-shapes] {failure}", file=sys.stderr)
        raise SystemExit(1)
    print(
        f"[filter-accepted] {len(accepted)}/{len(results)} findings accepted "
        f"by {len(entries)} allowlist entries; gate clean",
        file=sys.stderr,
    )


if __name__ == "__main__":
    main()
