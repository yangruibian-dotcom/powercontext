"""本地向量化：直接用 onnxruntime + tokenizers 跑 all-MiniLM-L6-v2（INT8）。

不依赖 torch / sentence-transformers，也不需要任何云端 API。
模型文件可由 scripts/fetch_model.py 从 hf-mirror 下载。
"""

from __future__ import annotations

import os
from pathlib import Path

import numpy as np
import onnxruntime as ort
from tokenizers import Tokenizer

DEFAULT_MODEL_DIR = Path(__file__).resolve().parent.parent / "models" / "all-MiniLM-L6-v2"
MODEL_DIR = Path(os.environ.get("EMB_MODEL_DIR", DEFAULT_MODEL_DIR))
DIM = 384


class Embedder:
    def __init__(self, model_dir: Path = MODEL_DIR):
        self.model_dir = Path(model_dir)
        onnx_path = self.model_dir / "onnx" / "model_quantized.onnx"
        if not onnx_path.exists():
            onnx_path = self.model_dir / "onnx" / "model.onnx"
        if not onnx_path.exists():
            raise FileNotFoundError(
                f"找不到模型文件：{onnx_path}\n先执行 python scripts/fetch_model.py 下载"
            )
        self.sess = ort.InferenceSession(str(onnx_path), providers=["CPUExecutionProvider"])
        self.tok = Tokenizer.from_file(str(self.model_dir / "tokenizer.json"))
        self.tok.enable_truncation(max_length=256)
        self.tok.enable_padding(pad_id=0, pad_token="[PAD]")

    def encode(self, texts: list[str]) -> list[list[float]]:
        if not texts:
            return []
        encs = self.tok.encode_batch(texts)
        ids = np.array([e.ids for e in encs], dtype=np.int64)
        mask = np.array([e.attention_mask for e in encs], dtype=np.int64)
        feed = {"input_ids": ids, "attention_mask": mask}
        names = {i.name for i in self.sess.get_inputs()}
        if "token_type_ids" in names:
            feed["token_type_ids"] = np.zeros_like(ids)
        hidden = self.sess.run(None, feed)[0]  # [B, T, 384]
        m = mask[..., None].astype(np.float32)
        pooled = (hidden * m).sum(axis=1) / np.clip(m.sum(axis=1), 1e-9, None)
        norm = np.linalg.norm(pooled, axis=1, keepdims=True)
        return (pooled / np.clip(norm, 1e-9, None)).astype(np.float32).tolist()


_singleton: Embedder | None = None


def get_embedder() -> Embedder:
    global _singleton
    if _singleton is None:
        _singleton = Embedder()
    return _singleton
