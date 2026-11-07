#!/usr/bin/env python3
"""Diem vao cho lenh review trich dan arXiv.

Logic nam trong `citation_verify.py` de unit test import duoc (ten file co
gach khong import duoc trong Python). File nay giu nguyen duong dan
`tests/verify-citations.py` ma nguoi review da quen goi.

    python3 tests/verify-citations.py --live
"""
from __future__ import annotations

import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))

from citation_verify import main  # noqa: E402  - can chen path truoc

if __name__ == "__main__":
    sys.exit(main())
