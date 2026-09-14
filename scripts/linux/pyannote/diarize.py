#!/usr/bin/env python3
"""Meetless speaker-diarization sidecar (pyannote 3.x, CPU).

Chạy bằng python trong venv do scripts/linux/install-diarization.sh tạo:

    ~/.local/share/meetless/tools/pyannote/bin/python scripts/linux/pyannote/diarize.py \\
        --audio meeting.wav --out turns.json [--hf-token-file PATH] [--chunk-minutes 15]

Đầu ra (--out): {"turns":[{"speaker":"S1","startMs":123,"endMs":456}, ...]}
    - speaker đặt tên S1, S2, ... theo thứ tự xuất hiện;
    - các turn cùng speaker chồng lấn (kể cả qua biên chunk) được gộp;
    - turn khác speaker chồng lấn ở biên chunk bị cắt cho không chồng lấn.
Tiến độ: mỗi dòng một JSON {"progress":0..1} ra STDERR.

Token: đọc từ --hf-token-file (mặc định ~/.local/share/meetless/tools/pyannote/hf-token),
fallback env HF_TOKEN.

Exit code: 0 = ok; 2 = thiếu token (stderr: DIARIZE_TOKEN_MISSING);
           3 = lỗi model/inference (stderr: DIARIZE_ERROR: <msg>).
"""
from __future__ import annotations

import argparse
import json
import sys
from pathlib import Path

DEFAULT_TOKEN_FILE = (
    Path.home() / ".local/share/meetless/tools/pyannote/hf-token"
)
MODEL_ID = "pyannote/speaker-diarization-3.1"


def emit_progress(fraction: float) -> None:
    print(json.dumps({"progress": round(max(0.0, min(1.0, fraction)), 4)}), file=sys.stderr, flush=True)


def read_token(token_file: str | Path) -> str | None:
    """Token từ file (một token/dòng), fallback env HF_TOKEN."""
    try:
        token = Path(token_file).read_text(encoding="utf-8").strip()
        if token:
            return token
    except OSError:
        pass
    import os

    return os.environ.get("HF_TOKEN", "").strip() or None


def audio_duration(path: Path) -> float:
    """Thời lượng (giây) — stdlib wave cho WAV, fallback soundfile (dep pyannote)."""
    import wave

    try:
        with wave.open(str(path), "rb") as wav:
            return wav.getnframes() / float(wav.getframerate())
    except (wave.Error, EOFError, ZeroDivisionError):
        pass
    import soundfile as sf

    info = sf.info(str(path))
    return info.frames / float(info.samplerate)


def merge_turns(turns: list[tuple[str, float, float]]) -> list[tuple[str, float, float]]:
    """Sắp theo start; gộp turn cùng speaker chồng lấn/chạm nhau.

    Turn khác speaker chồng lấn (thường chỉ ở biên chunk) bị cắt phần đầu cho
    không chồng lấn; đoạn rỗng thì bỏ.
    """
    kept = [(spk, start, end) for spk, start, end in turns if end > start]
    kept.sort(key=lambda t: (t[1], t[2]))
    merged: list[list] = []  # [speaker, start, end]
    for spk, start, end in kept:
        if merged and merged[-1][0] == spk and start <= merged[-1][2]:
            merged[-1][2] = max(merged[-1][2], end)
            continue
        if merged and start < merged[-1][2]:
            start = merged[-1][2]
            if start >= end:
                continue
        merged.append([spk, start, end])
    return [(spk, start, end) for spk, start, end in merged]


def run_diarization(audio_path: Path, out_path: Path, token: str, chunk_minutes: float) -> None:
    import torch
    from pyannote.audio import Audio, Pipeline
    from pyannote.core import Segment

    pipeline = Pipeline.from_pretrained(MODEL_ID, use_auth_token=token)
    if pipeline is None:  # pyannote trả về None khi token sai / chưa accept điều khoản
        raise RuntimeError(
            f"không tải được pipeline {MODEL_ID} — token sai hoặc chưa đồng ý điều khoản tại "
            "https://huggingface.co/pyannote/speaker-diarization-3.1 và "
            "https://huggingface.co/pyannote/segmentation-3.0"
        )
    pipeline.to(torch.device("cpu"))

    total = audio_duration(audio_path)
    chunk_seconds = max(chunk_minutes, 0.05) * 60.0
    chunk_starts = []
    start = 0.0
    while start < total - 1e-9:
        chunk_starts.append(start)
        start += chunk_seconds
    if not chunk_starts:  # file rỗng/0s
        chunk_starts = [0.0]

    io = Audio()
    raw_turns: list[tuple[str, float, float]] = []
    for index, chunk_start in enumerate(chunk_starts):
        chunk_end = min(chunk_start + chunk_seconds, total)
        waveform, sample_rate = io.crop(str(audio_path), Segment(chunk_start, chunk_end))
        annotation = pipeline({"waveform": waveform, "sample_rate": sample_rate})
        for segment, _, label in annotation.itertracks(yield_label=True):
            raw_turns.append((label, chunk_start + segment.start, chunk_start + segment.end))
        emit_progress((index + 1) / len(chunk_starts))

    merged = merge_turns(raw_turns)
    speaker_index: dict[str, int] = {}
    turns_json = []
    for spk, seg_start, seg_end in merged:
        speaker_index.setdefault(spk, len(speaker_index) + 1)
        turns_json.append(
            {
                "speaker": f"S{speaker_index[spk]}",
                "startMs": int(round(seg_start * 1000)),
                "endMs": int(round(seg_end * 1000)),
            }
        )

    # tự kiểm tra: đơn điệu, không chồng lấn, ms dương.
    for prev, curr in zip(turns_json, turns_json[1:]):
        if prev["endMs"] > curr["startMs"] or curr["startMs"] > curr["endMs"]:
            raise RuntimeError(f"turns sau gộp không hợp lệ: {prev} -> {curr}")

    out_path.parent.mkdir(parents=True, exist_ok=True)
    out_path.write_text(json.dumps({"turns": turns_json}, indent=2), encoding="utf-8")


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description="Meetless speaker-diarization sidecar (pyannote)")
    parser.add_argument("--audio", required=True, type=Path, help="file WAV đầu vào")
    parser.add_argument("--out", required=True, type=Path, help="file JSON turns đầu ra")
    parser.add_argument(
        "--hf-token-file",
        default=str(DEFAULT_TOKEN_FILE),
        help=f"file HF token (mặc định: {DEFAULT_TOKEN_FILE})",
    )
    parser.add_argument(
        "--chunk-minutes", type=float, default=15.0, help="độ dài chunk (phút) khi file dài (mặc định 15)"
    )
    args = parser.parse_args(argv)

    if not args.audio.is_file():
        print(f"DIARIZE_ERROR: không tìm thấy file audio: {args.audio}", file=sys.stderr)
        return 3

    token = read_token(args.hf_token_file)
    if not token:
        print("DIARIZE_TOKEN_MISSING", file=sys.stderr)
        print(
            f"(cần HF token tại {args.hf_token_file} hoặc env HF_TOKEN — xem: npm run diarization:install)",
            file=sys.stderr,
        )
        return 2

    try:
        run_diarization(args.audio, args.out, token, args.chunk_minutes)
    except Exception as exc:  # noqa: BLE001 — mọi lỗi model/inference đều thành exit 3
        print(f"DIARIZE_ERROR: {exc}", file=sys.stderr)
        return 3
    return 0


if __name__ == "__main__":
    sys.exit(main())
