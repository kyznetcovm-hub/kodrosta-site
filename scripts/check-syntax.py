#!/usr/bin/env python3
"""
Локальная проверка синтаксиса JS-файлов Worker'а — без node/wrangler (их нет
на этой машине). Cloudflare Git-интеграция деплоит асинхронно: успешный
`git push` ничего не говорит о том, прошла ли сборка (`npx wrangler deploy`).
Синтаксическая ошибка обнаруживалась только постфактум, на дашборде
Cloudflare — иногда через дни, если сломанный код не задевал то, что сразу
тестируют.

Использует встроенный в macOS движок JavaScriptCore (osascript -l JavaScript,
идёт с системой, ничего доп. не ставим) — он не умеет ES-модули
(import/export), поэтому эти конструкции вырезаются перед проверкой; сама
логика (в т.ч. дубли объявлений const/let, несовпадающие скобки и т.п.)
проверяется как есть.

Запускать перед КАЖДЫМ git push, где менялись .js-файлы:
    python3 scripts/check-syntax.py
Ненулевой exit code — где-то синтаксическая ошибка, пуш делать нельзя.
"""
import re
import subprocess
import sys
from pathlib import Path
from typing import Optional

ROOT = Path(__file__).resolve().parent.parent


def strip_for_check(src: str) -> str:
    src = re.sub(r"import\s.*?;", "", src, flags=re.S)
    src = re.sub(r"^export\s+default\s+", "const __default__ = ", src, flags=re.M)
    src = re.sub(r"^export\s+(?=(async\s+function|function|const|let|var|class)\b)", "", src, flags=re.M)
    return src


def check_file(path: Path) -> Optional[str]:
    src = path.read_text(encoding="utf-8")
    stripped = strip_for_check(src)
    result = subprocess.run(
        ["osascript", "-l", "JavaScript", "-e", stripped],
        capture_output=True, text=True,
    )
    if result.returncode != 0:
        return result.stderr.strip()
    return None


def main() -> int:
    files = sorted((ROOT / "src").glob("*.js"))
    had_error = False
    for f in files:
        err = check_file(f)
        rel = f.relative_to(ROOT)
        if err:
            had_error = True
            print(f"✘ {rel}\n  {err}")
        else:
            print(f"✔ {rel}")
    return 1 if had_error else 0


if __name__ == "__main__":
    sys.exit(main())
