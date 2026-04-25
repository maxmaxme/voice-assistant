#!/usr/bin/env python3
"""Wake-word daemon. Reads raw 16-bit mono 16kHz PCM from stdin in 1280-sample
(80ms) frames and emits JSON wake events on stdout. Designed to be spawned by
the Node parent."""
import json
import sys
import argparse
import numpy as np
from openwakeword.model import Model

FRAME_SAMPLES = 1280
FRAME_BYTES = FRAME_SAMPLES * 2

def emit(obj):
    sys.stdout.write(json.dumps(obj) + "\n")
    sys.stdout.flush()

def log(msg):
    sys.stderr.write(f"[wake] {msg}\n")
    sys.stderr.flush()

def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--keyword", default="hey_jarvis", help="openwakeword model name")
    ap.add_argument("--threshold", type=float, default=0.5)
    args = ap.parse_args()

    log(f"loading model: {args.keyword}")
    model = Model(wakeword_models=[args.keyword], inference_framework="onnx")
    emit({"type": "ready", "keyword": args.keyword, "threshold": args.threshold})

    cooldown_frames = 0
    while True:
        data = sys.stdin.buffer.read(FRAME_BYTES)
        if len(data) < FRAME_BYTES:
            break
        audio = np.frombuffer(data, dtype=np.int16)
        scores = model.predict(audio)
        if cooldown_frames > 0:
            cooldown_frames -= 1
            continue
        for kw, score in scores.items():
            if score >= args.threshold:
                emit({"type": "wake", "keyword": kw, "score": float(score)})
                # ~1 s cooldown to avoid double-fires from the same utterance
                cooldown_frames = 12
                break

if __name__ == "__main__":
    main()
