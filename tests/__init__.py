"""Tests of the Home Assistant independent logic of Solakon Local.

The modules under test are loaded as a bare package (without running the integration's
__init__.py), so the tests need only the Python standard library:

    python3 -m unittest discover -s tests -t .
"""

import importlib.util
import sys
from pathlib import Path

PKG = "solakon_local"
_DIR = Path(__file__).resolve().parent.parent / "custom_components" / PKG

if PKG not in sys.modules:
    spec = importlib.util.spec_from_loader(PKG, loader=None, is_package=True)
    pkg = importlib.util.module_from_spec(spec)
    pkg.__path__ = [str(_DIR)]
    sys.modules[PKG] = pkg
