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
    ap.add_argument("--debug", action="store_true", help="emit per-frame diagnostics to stderr")
    args = ap.parse_args()

    # `args.keyword` accepts either a built-in name (e.g. "hey_jarvis") OR a
    # filesystem path to a custom .onnx model trained via openWakeWord's
    # automatic_model_training.ipynb notebook. openwakeword.Model dispatches
    # on the value type for us.
    log(f"loading model: {args.keyword}")
    model = Model(wakeword_models=[args.keyword], inference_framework="onnx")
    emit({"type": "ready", "keyword": args.keyword, "threshold": args.threshold})
    log(f"ready. threshold={args.threshold} debug={args.debug}")

    cooldown_frames = 0
    frame_count = 0
    debug_max = 0.0
    debug_rms_max = 0
    DEBUG_EVERY = 25  # ~2 s at 80 ms/frame
    while True:
        data = sys.stdin.buffer.read(FRAME_BYTES)
        if len(data) < FRAME_BYTES:
            break
        audio = np.frombuffer(data, dtype=np.int16)

        if args.debug:
            rms = int(np.sqrt(np.mean(audio.astype(np.float32) ** 2)))
            debug_rms_max = max(debug_rms_max, rms)

        scores = model.predict(audio)
        frame_count += 1

        if args.debug:
            top_score = max(scores.values()) if scores else 0.0
            debug_max = max(debug_max, top_score)
            if frame_count % DEBUG_EVERY == 0:
                log(
                    f"frames={frame_count} max_score_2s={debug_max:.3f} "
                    f"max_rms_2s={debug_rms_max} (rms~10 = silent, ~3000+ = speech)"
                )
                debug_max = 0.0
                debug_rms_max = 0

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
