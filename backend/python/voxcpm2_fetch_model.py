"""Downloads the VoxCPM2 model into HF_HOME for the DR Dubber installer.

Prints machine-readable lines the installer turns into a progress bar:
  TOTAL <bytes>
  PROGRESS <done-bytes> <total-bytes>
  DONE <local path>
Resumes an interrupted download (huggingface_hub keeps the partial files).
"""

import os
import sys
import threading
import time

MODEL_ID = sys.argv[1] if len(sys.argv) > 1 else "openbmb/VoxCPM2"


def folder_size(path):
    total = 0
    for root, _dirs, files in os.walk(path):
        for f in files:
            try:
                total += os.path.getsize(os.path.join(root, f))
            except OSError:
                pass
    return total


def main():
    from huggingface_hub import HfApi, snapshot_download

    total = 0
    try:
        info = HfApi().model_info(MODEL_ID, files_metadata=True)
        total = sum((s.size or 0) for s in (info.siblings or []))
    except Exception as e:  # noqa: BLE001 - progress just falls back to "unknown size"
        print(f"WARN could not read the model size: {e}", flush=True)
    print(f"TOTAL {total}", flush=True)

    cache = os.path.join(os.environ.get("HF_HOME") or os.path.expanduser("~/.cache/huggingface"), "hub")
    start = folder_size(cache) if os.path.isdir(cache) else 0
    done = {"flag": False}

    def report():
        while not done["flag"]:
            now = folder_size(cache) if os.path.isdir(cache) else 0
            print(f"PROGRESS {max(0, now - start) if total == 0 else min(total, now)} {total}", flush=True)
            time.sleep(1.5)

    threading.Thread(target=report, daemon=True).start()
    path = snapshot_download(MODEL_ID)
    done["flag"] = True
    # Partial files left by an earlier, interrupted attempt are never used again.
    for root, _dirs, files in os.walk(cache):
        for f in files:
            if f.endswith(".incomplete"):
                try:
                    os.remove(os.path.join(root, f))
                except OSError:
                    pass
    print(f"PROGRESS {total} {total}", flush=True)
    print(f"DONE {path}", flush=True)


if __name__ == "__main__":
    main()
