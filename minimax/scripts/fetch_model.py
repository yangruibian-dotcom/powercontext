"""下载 all-MiniLM-L6-v2（INT8）到 minimax/models，供本地向量化使用。

默认走 hf-mirror（国内可用），可用 HF_ENDPOINT 切到 huggingface.co。
如果本机已有同名模型，可用 --from 直接复制，避免重复下载。
"""

from __future__ import annotations

import argparse
import shutil
import sys
import urllib.request
from pathlib import Path

REPO = "Xenova/all-MiniLM-L6-v2"
MIRROR = "https://hf-mirror.com"
FILES = [
    "config.json",
    "tokenizer.json",
    "tokenizer_config.json",
    "onnx/model_quantized.onnx",
]
ROOT = Path(__file__).resolve().parent.parent
OUT = ROOT / "models" / "all-MiniLM-L6-v2"


def download(endpoint: str) -> None:
    OUT.mkdir(parents=True, exist_ok=True)
    for rel in FILES:
        dst = OUT / rel
        dst.parent.mkdir(parents=True, exist_ok=True)
        if dst.exists() and dst.stat().st_size > 0:
            print(f"skip  {rel} ({(dst.stat().st_size / 1048576):.2f} MB)")
            continue
        url = f"{endpoint}/{REPO}/resolve/main/{rel}"
        print(f"get   {rel} ...", end=" ", flush=True)
        last = ""
        for _ in range(5):
            try:
                with urllib.request.urlopen(url, timeout=120) as r:
                    data = r.read()
                dst.write_bytes(data)
                print(f"{(len(data) / 1048576):.2f} MB")
                last = ""
                break
            except Exception as e:  # noqa: BLE001
                last = f"{type(e).__name__}: {e}"
        if last:
            sys.exit(f"下载失败 {rel}: {last}")


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("--endpoint", default=MIRROR, help="HF 镜像地址")
    ap.add_argument("--from", dest="src", default=None, help="从本地已有目录复制，例如 stepfun/web/models")
    a = ap.parse_args()

    if a.src:
        src = Path(a.src).resolve()
        if not (src / "all-MiniLM-L6-v2").exists():
            sys.exit(f"{src} 下没有 all-MiniLM-L6-v2")
        OUT.parent.mkdir(parents=True, exist_ok=True)
        if OUT.exists():
            shutil.rmtree(OUT)
        shutil.copytree(src / "all-MiniLM-L6-v2", OUT)
        print(f"copied from {src} -> {OUT}")
    else:
        download(a.endpoint)

    size = sum((p.stat().st_size for p in OUT.rglob("*") if p.is_file())) / 1048576
    print(f"done: {OUT}  ({size:.2f} MB)")


if __name__ == "__main__":
    main()
