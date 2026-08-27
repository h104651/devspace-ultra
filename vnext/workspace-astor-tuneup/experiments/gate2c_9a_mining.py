from pathlib import Path
from datetime import datetime, timezone
from collections import defaultdict
import csv, hashlib, json, shutil, subprocess, sys, zipfile

# ============================================================
# Astor TuneUp — Gate 2C
# 9A Detector Failure Mining + Human BBox Pack
# RUNNER v1.3 / SCIENTIFIC PROTOCOL v1.1
#
# Fix:
# - removes invalid top-level-loop/nonlocal pattern
# - batch inference is handled by normal helper functions
# - dependency/runtime versions are frozen before inference
#
# NO TRAINING / NO TUNING / NO MODEL SELECTION
# NO RUNTIME-GATE RETUNE / NO FRESH-COHORT ACCESS
# ============================================================

TITLE = "ASTOR GATE2C 9A DETECTOR FAILURE MINING + HUMAN LABEL PACK — RUNNER v1.3"
OWNER = "astorhsu"
BASE_SLUG = "astor-gate2c-8g-kaggle-package"
POOL_SLUG = "astor-gate2c-9a-miningpool-kaggle-package"

SOURCE_ROLE_FINAL_ZIP_NAME = "ASTOR_GATE2C_DEVELOPMENT_SOURCE_ROLE_FREEZE_V1.zip"
SOURCE_ROLE_FINAL_ZIP_SHA = "A1CD39505548359FF7E961AF5208E2ADF4AF6AEDE74B848816125E7E2E49A50D"
SOURCE_ROLE_RESULT_NAME = "ASTOR_GATE2C_DEVELOPMENT_SOURCE_ROLE_RESULT_V1.json"
SOURCE_ROLE_RESULT_SHA = "5A2828F627DE584D41023A0B79B4F989C0C23A57BD41C979147EEE3310277EDB"
SOURCE_ROLE_MANIFEST_NAME = "ASTOR_GATE2C_DEVELOPMENT_SOURCE_ROLE_MANIFEST_V1.json"
SOURCE_ROLE_MANIFEST_SHA = "4AF9C7CE557C6366D2EB5D2BA9D26933545646B2B49FB88C9E73CD9C6B3EAB37"
SOURCE_ROLE_FREEZE_NAME = "ASTOR_GATE2C_DEVELOPMENT_SOURCE_ROLE_FREEZE_V1.json"
SOURCE_ROLE_FREEZE_SHA = "8E9B7E2DCC919F715B5999093F9934412EC4A1C7EA386F058AED8C4DBD43ED53"
SOURCE_ROLE_ROSTER_NAME = "ASTOR_GATE2C_DEVELOPMENT_SOURCE_ROLE_ROSTER_V1.csv"
SOURCE_ROLE_ROSTER_SHA = "D804EE961BF8BA3BE2B331E945C9BECE6BA08F9C0D29F4864B78FB5873458CA5"

SUPERSEDED_PREINFERENCE_FREEZE_SHA = "9D43EC873FC6C5F72ADCFD1047A1616E274807F0DD21422CD8C227E5B048A5C9"
SUPERSEDED_REASON = "MISSING_ULTRALYTICS_BEFORE_ANY_9A_INFERENCE"

FROZEN_V2_MODEL_SHA = "648208026CECFB910624AD27A8A1E1F481570DD7EC1277AB4C6E54FAEB68ADE4"

MODEL_IMGSZ = 960
MODEL_CONF = 0.25
MODEL_IOU = 0.70
MODEL_MAX_DET = 300
BATCH_SIZE = 8

EXPECTED_9A = {
    "rw_002": ("rw_002.mp4", "5135B76BDE238FBE9E1D51ED9E4C9C8283C341C28194785391ADD6675E27A0EF", 228),
    "rw_003": ("rw_003.mov", "7A598F17F0A2AA9D4C3E211A1ED515B3D88D677B9F0C1257D28BB2A201E9836C", 569),
    "rw_004": ("rw_004.mov", "F3143CB3B1B097CA33AD1C7C828084CD076D3C9823ECE21C07ABA73ABFBEED61", 438),
    "rw_005": ("rw_005.mov", "96626B0C12F3AE6327F333F6CBCEF29125845408F52D431951C853603A7766B3", 1677),
    "rw_006": ("rw_006.mov", "5D25C9184B3CF7C60E804F7E0A11AC861FA56E2D4228E7BA6B67C704F9C0AE07", 357),
    "rw_007": ("rw_007.mov", "68BBD2B6EB0780F1837BAF2489F66A550A5909F5A47F14F769CA42C9B6950ADC", 905),
    "rw_009": ("rw_009.mp4", "B8682A2A8B50994F0B462FD0A12CD9D3A50BDE51C5502829FF95126F0279D934", 150),
}

FROZEN_FRESH_SOURCE_HASHES = {
    "025FDAB482329CEF8A5CC955560BCDAB42652FE74AA7EEAE46C39A301BD73CC9",
    "20D50E2EF579FD13436C9B2548DF81290998C882FBD61CA6F0EA49A6C971DF43",
    "F0CC3C3849D071B131A643C1D9FAA735AA6FA6D818304E0EA5D503D52015F8A3",
    "1D7CDDF828F99986F924266633FA7280B9CCBEE252E49900CD6EF09F788B2818",
    "1E970D6A632347343D22294BE92FB25671D3534E2586624A7E537B1F7CEB49EC",
    "3C68CAC8C133754D60C490FCEE8242D4DCC134A69FEE85490140BF570A48B358",
    "601398BD124EDBFCE4BEEC147EB4A25A650AB085A4E31E6B4333A02F1444D118",
    "707C57FF3B029773CA4A8666658F62B4075A0D7767FDB2822CFD937A8A329D1C",
    "73788DA838084845A1F9B2B0B8BEB53E1DF0D5615F6CA38C662F1980B049DC15",
    "7F5BEB6F6B337FDBF06C6A7DF59C385B7CA2B3B679456CEBC344801C502136F0",
    "EAB3ED9DAF85F55CAB611D25B6D7BDC3A04220BB3CEBDA46A3C6246D93A2FE26",
}

UNIFORM_ANCHORS_PER_SOURCE = 8
TOP_CONF_PER_SOURCE = 4
LOW_CONF_PER_SOURCE = 2
TWO_BOUNDARY_GAP_MIDPOINTS_PER_SOURCE = 4
OTHER_GAP_MIDPOINTS_PER_SOURCE = 2
MIN_DET_SELECTION_SEPARATION_SEC = 0.12

OUT = Path("/kaggle/working/ASTOR_GATE2C_9A_DETECTOR_FAILURE_MINING_MACHINE_V1_1")
HUMAN_PACK_ROOT = Path("/kaggle/working/ASTOR_GATE2C_9A_HUMAN_BBOX_LABEL_PACK_V1_1")
RAW_FRAME_ROOT = OUT / "human_label_raw_frames"
MACHINE_FINAL_ZIP = Path("/kaggle/working/ASTOR_GATE2C_9A_DETECTOR_FAILURE_MINING_MACHINE_V1_1.zip")
HUMAN_PACK_ZIP = Path("/kaggle/working/ASTOR_GATE2C_9A_HUMAN_BBOX_LABEL_PACK_V1_1.zip")

def sha256_file(path):
    h = hashlib.sha256()
    with Path(path).open("rb") as f:
        for chunk in iter(lambda: f.read(4 * 1024 * 1024), b""):
            h.update(chunk)
    return h.hexdigest().upper()

def sha256_bytes(data):
    return hashlib.sha256(data).hexdigest().upper()

def utc_now():
    return datetime.now(timezone.utc).isoformat()

def write_json(path, obj):
    Path(path).write_text(
        json.dumps(obj, ensure_ascii=False, indent=2, sort_keys=True) + "\n",
        encoding="utf-8",
    )

def write_csv(path, rows, fields=None):
    if fields is None:
        if rows:
            fields = list(rows[0].keys())
        else:
            fields, rows = ["EMPTY"], [{"EMPTY": ""}]
    with Path(path).open("w", newline="", encoding="utf-8-sig") as f:
        w = csv.DictWriter(f, fieldnames=fields)
        w.writeheader()
        w.writerows(rows)

def ensure_ultralytics():
    try:
        import ultralytics
        return ultralytics.__version__, False
    except ModuleNotFoundError:
        print("Ultralytics is not installed.")
        print("Installing: ultralytics>=8.3,<9 ...")

        r = subprocess.run(
            [
                sys.executable,
                "-m",
                "pip",
                "install",
                "--quiet",
                "ultralytics>=8.3,<9",
            ],
            text=True,
            capture_output=True,
        )

        if r.returncode != 0:
            raise RuntimeError(
                "STOP: Ultralytics installation failed BEFORE protocol freeze/inference.\n"
                "Turn Kaggle Internet ON, then rerun this SAME full cell.\n\n"
                f"PIP STDOUT:\n{r.stdout[-4000:]}\n\n"
                f"PIP STDERR:\n{r.stderr[-4000:]}"
            )

        import ultralytics

        return ultralytics.__version__, True

def resolve_dataset(slug):
    for p in (
        Path(f"/kaggle/input/datasets/{OWNER}/{slug}"),
        Path(f"/kaggle/input/{slug}"),
    ):
        if p.exists() and p.is_dir():
            return p

    return None

def rational_to_float(v):
    if v is None:
        return None

    s = str(v)

    if not s or s.upper() == "N/A":
        return None

    if "/" in s:
        a, b = s.split("/", 1)

        try:
            a = float(a)
            b = float(b)
            return (a / b) if b else None
        except Exception:
            return None

    try:
        return float(s)
    except Exception:
        return None

def ffprobe_video(path):
    if shutil.which("ffprobe") is None:
        raise RuntimeError("STOP: ffprobe unavailable.")

    r = subprocess.run(
        [
            "ffprobe",
            "-v",
            "error",
            "-show_streams",
            "-show_format",
            "-of",
            "json",
            str(path),
        ],
        text=True,
        capture_output=True,
    )

    if r.returncode != 0:
        raise RuntimeError(
            f"ffprobe failed for {path}\n"
            f"{r.stderr}"
        )

    data = json.loads(r.stdout)

    streams = [
        s
        for s in (data.get("streams") or [])
        if s.get("codec_type") == "video"
    ]

    if not streams:
        raise RuntimeError(
            f"No video stream: {path}"
        )

    s = streams[0]

    fps_text = (
        s.get("avg_frame_rate")
        or
        s.get("r_frame_rate")
        or
        ""
    )

    fps = rational_to_float(
        fps_text
    )

    try:
        nb_frames = int(
            s.get("nb_frames")
            or
            0
        )
    except Exception:
        nb_frames = 0

    duration = 0.0

    for v in (
        (data.get("format") or {}).get("duration"),
        s.get("duration"),
    ):
        try:
            if (
                v is not None
                and
                str(v).upper() != "N/A"
            ):
                duration = float(v)
                break
        except Exception:
            pass

    rotation = None

    rotation_values = [
        (s.get("tags") or {}).get("rotate")
    ]

    for item in (
        s.get("side_data_list")
        or
        []
    ):
        if isinstance(item, dict):
            rotation_values.append(
                item.get("rotation")
            )

    for v in rotation_values:
        try:
            if v is not None:
                rotation = int(
                    round(
                        float(v)
                    )
                )
                break
        except Exception:
            pass

    return {
        "codec": s.get("codec_name", ""),
        "raw_width": int(s.get("width") or 0),
        "raw_height": int(s.get("height") or 0),
        "avg_frame_rate": fps_text,
        "fps_float": fps,
        "nb_frames": nb_frames,
        "duration": duration,
        "rotation": rotation,
    }

def verify_parent():
    roots = [
        Path("/kaggle/working"),
        Path("/kaggle/input"),
    ]

    for root in roots:
        if not root.exists():
            continue

        candidates = list(
            root.rglob(
                SOURCE_ROLE_FINAL_ZIP_NAME
            )
        )

        candidates += [
            p
            for p in root.rglob("*.zip")
            if p.is_file()
        ]

        seen = set()

        for p in candidates:
            sp = str(p)

            if sp in seen:
                continue

            seen.add(sp)

            try:
                if sha256_file(p) != SOURCE_ROLE_FINAL_ZIP_SHA:
                    continue
            except Exception:
                continue

            with zipfile.ZipFile(
                p,
                "r",
            ) as z:
                bad = z.testzip()

                if bad is not None:
                    raise RuntimeError(
                        f"Corrupt source-role ZIP member: {bad}"
                    )

                bybase = {
                    Path(n).name: n
                    for n in z.namelist()
                    if not n.endswith("/")
                }

                expected = {
                    SOURCE_ROLE_RESULT_NAME:
                        SOURCE_ROLE_RESULT_SHA,

                    SOURCE_ROLE_MANIFEST_NAME:
                        SOURCE_ROLE_MANIFEST_SHA,

                    SOURCE_ROLE_FREEZE_NAME:
                        SOURCE_ROLE_FREEZE_SHA,

                    SOURCE_ROLE_ROSTER_NAME:
                        SOURCE_ROLE_ROSTER_SHA,
                }

                for name, expected_sha in expected.items():
                    if name not in bybase:
                        raise RuntimeError(
                            f"Missing parent artifact: {name}"
                        )

                    if (
                        sha256_bytes(
                            z.read(
                                bybase[name]
                            )
                        )
                        !=
                        expected_sha
                    ):
                        raise RuntimeError(
                            f"Parent artifact SHA mismatch: {name}"
                        )

            return {
                "transport":
                    "INTACT_FINAL_ZIP",

                "path":
                    str(p),
            }

    expected = {
        SOURCE_ROLE_RESULT_NAME:
            SOURCE_ROLE_RESULT_SHA,

        SOURCE_ROLE_MANIFEST_NAME:
            SOURCE_ROLE_MANIFEST_SHA,

        SOURCE_ROLE_FREEZE_NAME:
            SOURCE_ROLE_FREEZE_SHA,

        SOURCE_ROLE_ROSTER_NAME:
            SOURCE_ROLE_ROSTER_SHA,
    }

    resolved = {}

    for name, expected_sha in expected.items():
        matches = []

        for root in roots:
            if not root.exists():
                continue

            for p in root.rglob(name):
                if (
                    p.is_file()
                    and
                    sha256_file(p)
                    ==
                    expected_sha
                ):
                    matches.append(p)

        if not matches:
            raise RuntimeError(
                "STOP: source-role parent cannot be recovered.\n"
                f"Missing: {name}\n"
                "Attach ASTOR_GATE2C_DEVELOPMENT_SOURCE_ROLE_FREEZE_V1.zip "
                "and rerun this SAME cell."
            )

        resolved[name] = str(
            sorted(matches)[0]
        )

    return {
        "transport":
            "EXPANDED_ARTIFACTS",

        "resolved":
            resolved,
    }

def open_capture(path):
    import cv2

    cap = cv2.VideoCapture(
        str(path)
    )

    if not cap.isOpened():
        raise RuntimeError(
            f"Cannot open video: {path}"
        )

    if hasattr(
        cv2,
        "CAP_PROP_ORIENTATION_AUTO",
    ):
        try:
            cap.set(
                cv2.CAP_PROP_ORIENTATION_AUTO,
                1,
            )
        except Exception:
            pass

    return cap

def process_prediction_batch(
    model,
    device,
    source_id,
    source_path,
    source_sha,
    fps,
    decoded_w,
    decoded_h,
    batch_frames,
    batch_indices,
):
    import numpy as np

    results = model.predict(
        source=batch_frames,
        imgsz=MODEL_IMGSZ,
        conf=MODEL_CONF,
        iou=MODEL_IOU,
        max_det=MODEL_MAX_DET,
        device=device,
        verbose=False,
        stream=False,
    )

    if len(results) != len(batch_frames):
        raise RuntimeError(
            f"STOP: result-count mismatch {source_id}: "
            f"{len(results)} != {len(batch_frames)}"
        )

    rows = []

    for fi, result in zip(
        batch_indices,
        results,
    ):
        boxes = result.boxes

        det_count = 0
        top_conf = None
        top_cls = None
        x1 = None
        y1 = None
        x2 = None
        y2 = None

        if (
            boxes is not None
            and
            len(boxes) > 0
        ):
            det_count = int(
                len(boxes)
            )

            confs = (
                boxes.conf
                .detach()
                .cpu()
                .numpy()
            )

            best = int(
                np.argmax(
                    confs
                )
            )

            top_conf = float(
                confs[best]
            )

            if boxes.cls is not None:
                top_cls = int(
                    boxes.cls[best]
                    .detach()
                    .cpu()
                    .item()
                )

            x1, y1, x2, y2 = (
                boxes.xyxy[best]
                .detach()
                .cpu()
                .numpy()
                .astype(float)
                .tolist()
            )

        rows.append(
            {
                "source_id":
                    source_id,

                "source_filename":
                    source_path.name,

                "source_sha256":
                    source_sha,

                "frame_index":
                    int(fi),

                "timestamp_sec":
                    float(fi) / fps,

                "decoded_width":
                    int(decoded_w),

                "decoded_height":
                    int(decoded_h),

                "det_count":
                    int(det_count),

                "top1_conf":
                    top_conf,

                "top1_class":
                    top_cls,

                "top1_x1":
                    x1,

                "top1_y1":
                    y1,

                "top1_x2":
                    x2,

                "top1_y2":
                    y2,
            }
        )

    return rows

def infer_one_source(
    model,
    device,
    source_id,
    source_path,
    source_sha,
    fps,
    expected_frames,
):
    cap = open_capture(
        source_path
    )

    rows = []

    batch_frames = []
    batch_indices = []

    decoded_w = None
    decoded_h = None

    frame_index = 0

    while True:
        ok, frame = cap.read()

        if not ok:
            break

        h, w = frame.shape[
            :2
        ]

        if decoded_w is None:
            decoded_w = int(w)
            decoded_h = int(h)

        elif (
            int(w) != decoded_w
            or
            int(h) != decoded_h
        ):
            cap.release()

            raise RuntimeError(
                f"STOP: decoded geometry changed mid-video: "
                f"{source_id}"
            )

        batch_frames.append(
            frame
        )

        batch_indices.append(
            frame_index
        )

        if (
            len(batch_frames)
            >=
            BATCH_SIZE
        ):
            rows.extend(
                process_prediction_batch(
                    model=model,
                    device=device,
                    source_id=source_id,
                    source_path=source_path,
                    source_sha=source_sha,
                    fps=fps,
                    decoded_w=decoded_w,
                    decoded_h=decoded_h,
                    batch_frames=batch_frames,
                    batch_indices=batch_indices,
                )
            )

            batch_frames = []
            batch_indices = []

        frame_index += 1

    if batch_frames:
        rows.extend(
            process_prediction_batch(
                model=model,
                device=device,
                source_id=source_id,
                source_path=source_path,
                source_sha=source_sha,
                fps=fps,
                decoded_w=decoded_w,
                decoded_h=decoded_h,
                batch_frames=batch_frames,
                batch_indices=batch_indices,
            )
        )

    cap.release()

    if (
        frame_index != expected_frames
        or
        len(rows) != expected_frames
    ):
        raise RuntimeError(
            f"STOP: decoded/inference frame count mismatch "
            f"{source_id}: "
            f"decoded={frame_index}, "
            f"rows={len(rows)}, "
            f"expected={expected_frames}"
        )

    return (
        rows,
        {
            "source_id":
                source_id,

            "decoded_width":
                decoded_w,

            "decoded_height":
                decoded_h,

            "decoded_frames":
                frame_index,

            "fps":
                fps,
        },
    )

def pick_separated(
    rows,
    count,
    min_sep,
):
    out = []
    frames = []

    for r in rows:
        f = int(
            r["frame_index"]
        )

        if any(
            abs(f - x) < min_sep
            for x in frames
        ):
            continue

        out.append(r)
        frames.append(f)

        if len(out) >= count:
            break

    return out

def uniform_indices(
    n,
    count,
):
    import numpy as np

    if n <= 0:
        return []

    if count <= 1:
        return [
            n // 2
        ]

    return sorted(
        set(
            int(
                round(x)
            )
            for x in np.linspace(
                0,
                n - 1,
                num=min(
                    count,
                    n,
                ),
            )
        )
    )

def no_detection_gaps(rows):
    gaps = []
    n = len(rows)
    i = 0

    while i < n:
        if int(
            rows[i]["det_count"]
        ) != 0:
            i += 1
            continue

        start = i

        while (
            i + 1 < n
            and
            int(
                rows[i + 1]["det_count"]
            )
            ==
            0
        ):
            i += 1

        end = i

        left = (
            start > 0
            and
            int(
                rows[start - 1]["det_count"]
            )
            >
            0
        )

        right = (
            end + 1 < n
            and
            int(
                rows[end + 1]["det_count"]
            )
            >
            0
        )

        gaps.append(
            {
                "start_frame":
                    start,

                "end_frame":
                    end,

                "length":
                    end - start + 1,

                "mid_frame":
                    (start + end) // 2,

                "left_detected":
                    left,

                "right_detected":
                    right,

                "two_boundary":
                    bool(
                        left
                        and
                        right
                    ),
            }
        )

        i += 1

    return gaps

# ============================================================
# Runtime dependency + imports
# ============================================================

ULTRALYTICS_VERSION, ULTRALYTICS_INSTALLED_BY_RUNNER = (
    ensure_ultralytics()
)

import cv2
import numpy as np
import pandas as pd
import torch
import ultralytics

from ultralytics import YOLO

# ============================================================
# Clean output roots
# ============================================================

for p in (
    OUT,
    HUMAN_PACK_ROOT,
):
    if p.exists():
        shutil.rmtree(p)

    p.mkdir(
        parents=True,
        exist_ok=True,
    )

for p in (
    MACHINE_FINAL_ZIP,
    HUMAN_PACK_ZIP,
):
    if p.exists():
        p.unlink()

RAW_FRAME_ROOT.mkdir(
    parents=True,
    exist_ok=True,
)

# ============================================================
# Start
# ============================================================

print(
    "=" * 100
)

print(
    TITLE
)

print(
    "=" * 100
)

print(
    "PYTHON:",
    sys.version.split()[0],
)

print(
    "TORCH:",
    torch.__version__,
)

print(
    "ULTRALYTICS:",
    ultralytics.__version__,
)

print(
    "OPENCV:",
    cv2.__version__,
)

print(
    "CUDA AVAILABLE:",
    torch.cuda.is_available(),
)

print(
    "TRAINING EXECUTED: False"
)

print(
    "TUNING EXECUTED: False"
)

print(
    "MODEL SELECTION EXECUTED: False"
)

print(
    "RUNTIME GATE RETUNED: False"
)

print(
    "FRESH COHORT ACCESSED: False"
)

print()

parent = verify_parent()

print(
    "SOURCE-ROLE FREEZE VERIFIED ✅"
)

print(
    "TRANSPORT:",
    parent["transport"],
)

base_root = resolve_dataset(
    BASE_SLUG
)

pool_root = resolve_dataset(
    POOL_SLUG
)

if (
    base_root is None
    or
    pool_root is None
):
    raise RuntimeError(
        "STOP: missing 8G or 9A dataset. "
        f"8G={base_root}, "
        f"9A={pool_root}"
    )

model_exts = {
    ".pt",
    ".pth",
    ".onnx",
    ".tflite",
    ".torchscript",
    ".engine",
    ".bin",
    ".ckpt",
}

model_path = None

for p in base_root.rglob("*"):
    if (
        p.is_file()
        and
        p.suffix.lower()
        in
        model_exts
        and
        sha256_file(p)
        ==
        FROZEN_V2_MODEL_SHA
    ):
        model_path = p
        break

if model_path is None:
    raise RuntimeError(
        "STOP: frozen V2 model not found. "
        f"SHA={FROZEN_V2_MODEL_SHA}"
    )

print(
    "FROZEN V2 MODEL PASS ✅"
)

print(
    "MODEL PATH:",
    model_path,
)

video_exts = {
    ".mp4",
    ".mov",
    ".m4v",
    ".avi",
    ".mkv",
    ".webm",
    ".mts",
    ".m2ts",
}

pool_sha = {}

for p in pool_root.rglob("*"):
    if (
        p.is_file()
        and
        p.suffix.lower()
        in
        video_exts
    ):
        s = sha256_file(p)

        if s in pool_sha:
            raise RuntimeError(
                f"STOP: duplicate 9A video SHA: {s}"
            )

        pool_sha[s] = p

source_rows = []
resolved_sources = {}

for sid, (
    filename,
    expected_sha,
    expected_frames,
) in EXPECTED_9A.items():

    p = pool_sha.get(
        expected_sha
    )

    if p is None:
        raise RuntimeError(
            f"STOP: exact 9A source missing: {sid}"
        )

    if (
        expected_sha
        in
        FROZEN_FRESH_SOURCE_HASHES
    ):
        raise RuntimeError(
            f"STOP: forbidden Fresh collision: {sid}"
        )

    probe = ffprobe_video(
        p
    )

    if (
        probe["nb_frames"] > 0
        and
        probe["nb_frames"]
        !=
        expected_frames
    ):
        raise RuntimeError(
            f"STOP: ffprobe frame mismatch {sid}: "
            f"{probe['nb_frames']} != "
            f"{expected_frames}"
        )

    if (
        not probe["fps_float"]
        or
        probe["fps_float"] <= 0
    ):
        raise RuntimeError(
            f"STOP: invalid FPS {sid}"
        )

    resolved_sources[sid] = p

    source_rows.append(
        {
            "source_id":
                sid,

            "filename":
                p.name,

            "path":
                str(p),

            "sha256":
                expected_sha,

            "expected_frames":
                expected_frames,

            "ffprobe_frames":
                probe["nb_frames"],

            "fps":
                probe["fps_float"],

            "avg_frame_rate":
                probe["avg_frame_rate"],

            "codec":
                probe["codec"],

            "raw_width":
                probe["raw_width"],

            "raw_height":
                probe["raw_height"],

            "rotation":
                probe["rotation"],

            "duration_sec":
                probe["duration"],

            "role":
                "DEVELOPMENT_MINING_POOL",
        }
    )

    print(
        f"{sid} PASS ✅ | "
        f"{p.name} | "
        f"{probe['raw_width']}x"
        f"{probe['raw_height']} | "
        f"fps={probe['fps_float']:.6f} | "
        f"frames={probe['nb_frames']} | "
        f"codec={probe['codec']} | "
        f"rotation={probe['rotation']}"
    )

print(
    "9A SOURCE ROSTER PASS ✅ 7 / 7"
)

# ============================================================
# Freeze runtime + protocol BEFORE inference
# ============================================================

SOURCE_ROSTER_CSV = (
    OUT
    /
    "ASTOR_GATE2C_9A_MINING_SOURCE_ROSTER_V1_1.csv"
)

ENV_JSON = (
    OUT
    /
    "ASTOR_GATE2C_9A_RUNTIME_ENVIRONMENT_V1_1.json"
)

PROTOCOL_JSON = (
    OUT
    /
    "ASTOR_GATE2C_9A_DETECTOR_FAILURE_MINING_PROTOCOL_V1_1.json"
)

SELECTION_JSON = (
    OUT
    /
    "ASTOR_GATE2C_9A_CANDIDATE_SELECTION_SPEC_V1_1.json"
)

SUPERSESSION_JSON = (
    OUT
    /
    "ASTOR_GATE2C_9A_PREINFERENCE_SUPERSESSION_V1_1.json"
)

PREFREEZE_JSON = (
    OUT
    /
    "ASTOR_GATE2C_9A_PREINFERENCE_FREEZE_V1_1.json"
)

write_csv(
    SOURCE_ROSTER_CSV,
    source_rows,
)

write_json(
    ENV_JSON,
    {
        "schema":
            "astor_gate2c_9a_runtime_environment_v1_1",

        "python":
            sys.version,

        "torch":
            torch.__version__,

        "ultralytics":
            ultralytics.__version__,

        "opencv":
            cv2.__version__,

        "numpy":
            np.__version__,

        "pandas":
            pd.__version__,

        "cuda_available":
            bool(
                torch.cuda.is_available()
            ),

        "cuda_version":
            getattr(
                torch.version,
                "cuda",
                None,
            ),

        "ultralytics_installed_by_runner":
            ULTRALYTICS_INSTALLED_BY_RUNNER,
    },
)

write_json(
    PROTOCOL_JSON,
    {
        "schema":
            "astor_gate2c_9a_detector_failure_mining_protocol_v1_1",

        "created_utc":
            utc_now(),

        "runner":
            "v1.3_nonlocal_fix",

        "parent_source_role_final_zip_sha256":
            SOURCE_ROLE_FINAL_ZIP_SHA,

        "supersedes_preinference_freeze_sha256":
            SUPERSEDED_PREINFERENCE_FREEZE_SHA,

        "supersession_reason":
            SUPERSEDED_REASON,

        "no_inference_executed_under_superseded_freeze":
            True,

        "all_7_9a_sources_mandatory":
            True,

        "post_inference_source_exclusion_allowed":
            False,

        "fresh_cohort_access_allowed":
            False,

        "fresh_cohort_training_allowed":
            False,

        "model": {
            "sha256":
                FROZEN_V2_MODEL_SHA,

            "imgsz":
                MODEL_IMGSZ,

            "conf":
                MODEL_CONF,

            "iou":
                MODEL_IOU,

            "max_det":
                MODEL_MAX_DET,

            "purpose":
                (
                    "DEVELOPMENT_FAILURE_MINING_ONLY_"
                    "NOT_MODEL_SELECTION"
                ),
        },

        "runtime_environment_sha256":
            sha256_file(
                ENV_JSON
            ),

        "human_annotation_target":
            "YOLO_BBOX_OF_PHYSICAL_CLUB_HEAD_BODY",

        "human_annotation_frame_contains_model_overlay":
            False,

        "eligible_human_states": [
            "POSITIVE_BOX_CONFIDENT",
            "NEGATIVE_NO_CLUB_HEAD_VISIBLE",
            "IGNORE_UNRESOLVABLE_OR_OCCLUDED",
        ],

        "training_authorized_after_machine_stage":
            False,

        "next_action":
            "COLAB_HUMAN_BBOX_ANNOTATION_AND_FREEZE",
    },
)

write_json(
    SELECTION_JSON,
    {
        "schema":
            "astor_gate2c_9a_candidate_selection_spec_v1_1",

        "selection_frozen_before_inference":
            True,

        "uniform_anchor_frames":
            UNIFORM_ANCHORS_PER_SOURCE,

        "highest_top1_confidence_detected_frames":
            TOP_CONF_PER_SOURCE,

        "lowest_top1_confidence_detected_frames":
            LOW_CONF_PER_SOURCE,

        "longest_two_boundary_no_detection_gap_midpoints":
            TWO_BOUNDARY_GAP_MIDPOINTS_PER_SOURCE,

        "longest_other_no_detection_gap_midpoints":
            OTHER_GAP_MIDPOINTS_PER_SOURCE,

        "detected_frame_temporal_separation_sec":
            MIN_DET_SELECTION_SEPARATION_SEC,

        "dedupe":
            "SOURCE_ID_PLUS_SOURCE_FRAME_INDEX",

        "tie_break":
            "LOWER_SOURCE_FRAME_INDEX",

        "manual_post_inference_candidate_removal":
            False,
    },
)

write_json(
    SUPERSESSION_JSON,
    {
        "schema":
            "astor_gate2c_9a_preinference_supersession_v1_1",

        "superseded_preinference_freeze_sha256":
            SUPERSEDED_PREINFERENCE_FREEZE_SHA,

        "reason":
            SUPERSEDED_REASON,

        "superseded_freeze_had_9a_inference":
            False,

        "superseded_freeze_had_training":
            False,

        "new_protocol_sha256":
            sha256_file(
                PROTOCOL_JSON
            ),

        "new_environment_sha256":
            sha256_file(
                ENV_JSON
            ),
    },
)

write_json(
    PREFREEZE_JSON,
    {
        "schema":
            "astor_gate2c_9a_preinference_freeze_v1_1",

        "status":
            "FROZEN_BEFORE_9A_INFERENCE",

        "source_roster_sha256":
            sha256_file(
                SOURCE_ROSTER_CSV
            ),

        "environment_sha256":
            sha256_file(
                ENV_JSON
            ),

        "protocol_sha256":
            sha256_file(
                PROTOCOL_JSON
            ),

        "selection_spec_sha256":
            sha256_file(
                SELECTION_JSON
            ),

        "supersession_sha256":
            sha256_file(
                SUPERSESSION_JSON
            ),

        "frozen_v2_model_sha256":
            FROZEN_V2_MODEL_SHA,

        "training":
            False,

        "tuning":
            False,

        "model_selection":
            False,

        "runtime_gate_retuned":
            False,

        "fresh_cohort_accessed":
            False,

        "9a_inference_authorized":
            True,
    },
)

print()

print(
    "NEW PRE-INFERENCE FREEZE v1.1 COMPLETE ✅"
)

print(
    "ENVIRONMENT:",
    sha256_file(
        ENV_JSON
    ),
)

print(
    "PROTOCOL:",
    sha256_file(
        PROTOCOL_JSON
    ),
)

print(
    "SELECTION:",
    sha256_file(
        SELECTION_JSON
    ),
)

print(
    "SUPERSESSION:",
    sha256_file(
        SUPERSESSION_JSON
    ),
)

print(
    "PREFREEZE:",
    sha256_file(
        PREFREEZE_JSON
    ),
)

# ============================================================
# Inference starts only after freeze
# ============================================================

device = (
    0
    if torch.cuda.is_available()
    else
    "cpu"
)

print()

print(
    "9A DEVELOPMENT INFERENCE START"
)

print(
    "DEVICE:",
    device,
)

model = YOLO(
    str(model_path)
)

all_rows = []
per_source = {}
decode_rows = []

for sid in EXPECTED_9A:
    p = resolved_sources[sid]

    fps = next(
        float(r["fps"])
        for r in source_rows
        if r["source_id"] == sid
    )

    expected_sha = (
        EXPECTED_9A[sid][1]
    )

    expected_frames = (
        EXPECTED_9A[sid][2]
    )

    rows, decode_info = infer_one_source(
        model=model,
        device=device,
        source_id=sid,
        source_path=p,
        source_sha=expected_sha,
        fps=fps,
        expected_frames=expected_frames,
    )

    per_source[sid] = rows

    all_rows.extend(
        rows
    )

    decode_rows.append(
        decode_info
    )

    detected = sum(
        int(r["det_count"]) > 0
        for r in rows
    )

    print(
        f"{sid}: "
        f"frames={len(rows)} | "
        f"detected={detected} | "
        f"no_detection={len(rows)-detected} | "
        f"decoded="
        f"{decode_info['decoded_width']}x"
        f"{decode_info['decoded_height']}"
    )

# ============================================================
# Candidate mining
# ============================================================

gap_rows = []
candidate_map = {}

def add_candidate(
    sid,
    fi,
    reason,
    priority,
):
    key = (
        sid,
        int(fi),
    )

    if key not in candidate_map:
        candidate_map[key] = {
            "reasons":
                set(),

            "priority":
                int(priority),
        }

    candidate_map[key][
        "reasons"
    ].add(
        reason
    )

    candidate_map[key][
        "priority"
    ] = min(
        candidate_map[key]["priority"],
        int(priority),
    )

for sid, rows in per_source.items():
    n = len(rows)

    for fi in uniform_indices(
        n,
        UNIFORM_ANCHORS_PER_SOURCE,
    ):
        add_candidate(
            sid,
            fi,
            "UNIFORM_ANCHOR",
            10,
        )

    detected = [
        r
        for r in rows
        if int(r["det_count"]) > 0
    ]

    fps = next(
        float(r["fps"])
        for r in source_rows
        if r["source_id"] == sid
    )

    min_sep = max(
        1,
        int(
            round(
                fps
                *
                MIN_DET_SELECTION_SEPARATION_SEC
            )
        ),
    )

    high = sorted(
        detected,
        key=lambda r: (
            -float(
                r["top1_conf"]
            ),
            int(
                r["frame_index"]
            ),
        ),
    )

    for r in pick_separated(
        high,
        TOP_CONF_PER_SOURCE,
        min_sep,
    ):
        add_candidate(
            sid,
            r["frame_index"],
            "TOP_CONF_DETECTION",
            20,
        )

    low = sorted(
        detected,
        key=lambda r: (
            float(
                r["top1_conf"]
            ),
            int(
                r["frame_index"]
            ),
        ),
    )

    for r in pick_separated(
        low,
        LOW_CONF_PER_SOURCE,
        min_sep,
    ):
        add_candidate(
            sid,
            r["frame_index"],
            "LOW_CONF_DETECTION",
            30,
        )

    gaps = no_detection_gaps(
        rows
    )

    for gi, g in enumerate(
        gaps,
        1,
    ):
        gap_rows.append(
            {
                "source_id":
                    sid,

                "gap_index":
                    gi,

                **g,
            }
        )

    two = sorted(
        [
            g
            for g in gaps
            if g["two_boundary"]
        ],
        key=lambda g: (
            -int(
                g["length"]
            ),
            int(
                g["start_frame"]
            ),
        ),
    )

    for g in two[
        :TWO_BOUNDARY_GAP_MIDPOINTS_PER_SOURCE
    ]:
        add_candidate(
            sid,
            g["mid_frame"],
            "TWO_BOUNDARY_GAP_MIDPOINT",
            40,
        )

    other = sorted(
        [
            g
            for g in gaps
            if not g["two_boundary"]
        ],
        key=lambda g: (
            -int(
                g["length"]
            ),
            int(
                g["start_frame"]
            ),
        ),
    )

    for g in other[
        :OTHER_GAP_MIDPOINTS_PER_SOURCE
    ]:
        add_candidate(
            sid,
            g["mid_frame"],
            "OTHER_GAP_MIDPOINT",
            50,
        )

source_order = list(
    EXPECTED_9A.keys()
)

candidate_rows = []

for (
    sid,
    fi,
), c in sorted(
    candidate_map.items(),
    key=lambda kv: (
        source_order.index(
            kv[0][0]
        ),
        kv[0][1],
    ),
):
    mr = per_source[
        sid
    ][
        fi
    ]

    candidate_rows.append(
        {
            "candidate_id":
                f"9A_{sid.upper()}_F{fi:05d}",

            "source_id":
                sid,

            "source_filename":
                mr["source_filename"],

            "source_sha256":
                mr["source_sha256"],

            "source_frame_index":
                fi,

            "timestamp_sec":
                mr["timestamp_sec"],

            "decoded_width":
                mr["decoded_width"],

            "decoded_height":
                mr["decoded_height"],

            "selection_reasons":
                "|".join(
                    sorted(
                        c["reasons"]
                    )
                ),

            "selection_priority":
                c["priority"],

            "model_det_count":
                mr["det_count"],

            "model_top1_conf":
                mr["top1_conf"],

            "model_top1_class":
                mr["top1_class"],

            "model_top1_x1":
                mr["top1_x1"],

            "model_top1_y1":
                mr["top1_y1"],

            "model_top1_x2":
                mr["top1_x2"],

            "model_top1_y2":
                mr["top1_y2"],
        }
    )

FRAME_CSV = (
    OUT
    /
    "ASTOR_GATE2C_9A_FROZEN_V2_FRAME_INFERENCE_V1_1.csv"
)

GAPS_CSV = (
    OUT
    /
    "ASTOR_GATE2C_9A_NO_DETECTION_GAPS_V1_1.csv"
)

DECODE_CSV = (
    OUT
    /
    "ASTOR_GATE2C_9A_DECODE_GEOMETRY_V1_1.csv"
)

CANDIDATE_CSV = (
    OUT
    /
    "ASTOR_GATE2C_9A_HUMAN_LABEL_CANDIDATE_ROSTER_V1_1.csv"
)

write_csv(
    FRAME_CSV,
    all_rows,
)

write_csv(
    GAPS_CSV,
    gap_rows,
)

write_csv(
    DECODE_CSV,
    decode_rows,
)

# ============================================================
# Export prediction-free frames
# ============================================================

targets_by_source = defaultdict(
    dict
)

for r in candidate_rows:
    targets_by_source[
        r["source_id"]
    ][
        int(
            r["source_frame_index"]
        )
    ] = r

for sid in EXPECTED_9A:
    targets = targets_by_source[
        sid
    ]

    cap = open_capture(
        resolved_sources[sid]
    )

    fi = 0
    saved = 0

    while True:
        ok, frame = cap.read()

        if not ok:
            break

        if fi in targets:
            r = targets[
                fi
            ]

            name = (
                f"{r['candidate_id']}.jpg"
            )

            path = (
                RAW_FRAME_ROOT
                /
                name
            )

            if not cv2.imwrite(
                str(path),
                frame,
                [
                    int(
                        cv2.IMWRITE_JPEG_QUALITY
                    ),
                    95,
                ],
            ):
                cap.release()

                raise RuntimeError(
                    f"STOP: cannot write {path}"
                )

            chk = cv2.imread(
                str(path)
            )

            if chk is None:
                cap.release()

                raise RuntimeError(
                    f"STOP: cannot reread {path}"
                )

            h, w = chk.shape[
                :2
            ]

            if (
                w
                !=
                int(
                    r["decoded_width"]
                )
                or
                h
                !=
                int(
                    r["decoded_height"]
                )
            ):
                cap.release()

                raise RuntimeError(
                    f"STOP: frame geometry mismatch {name}"
                )

            r[
                "raw_frame_file"
            ] = (
                "raw_frames/"
                +
                name
            )

            r[
                "raw_frame_sha256"
            ] = sha256_file(
                path
            )

            r[
                "raw_frame_bytes"
            ] = (
                path.stat()
                .st_size
            )

            saved += 1

        fi += 1

    cap.release()

    if saved != len(targets):
        raise RuntimeError(
            f"STOP: export count mismatch {sid}: "
            f"{saved} != {len(targets)}"
        )

write_csv(
    CANDIDATE_CSV,
    candidate_rows,
)

# ============================================================
# Human pack
# ============================================================

pack_frames = (
    HUMAN_PACK_ROOT
    /
    "raw_frames"
)

pack_frames.mkdir(
    parents=True,
    exist_ok=True,
)

human_template = []

for r in candidate_rows:
    human_template.append(
        {
            "candidate_id":
                r["candidate_id"],

            "source_id":
                r["source_id"],

            "source_filename":
                r["source_filename"],

            "source_sha256":
                r["source_sha256"],

            "source_frame_index":
                r["source_frame_index"],

            "timestamp_sec":
                r["timestamp_sec"],

            "image_width":
                r["decoded_width"],

            "image_height":
                r["decoded_height"],

            "raw_frame_file":
                r["raw_frame_file"],

            "raw_frame_sha256":
                r["raw_frame_sha256"],

            "human_state":
                "",

            "bbox_x1":
                "",

            "bbox_y1":
                "",

            "bbox_x2":
                "",

            "bbox_y2":
                "",

            "human_note":
                "",
        }
    )

    src = (
        RAW_FRAME_ROOT
        /
        Path(
            r["raw_frame_file"]
        ).name
    )

    dst = (
        pack_frames
        /
        src.name
    )

    shutil.copy2(
        src,
        dst,
    )

    if (
        sha256_file(src)
        !=
        sha256_file(dst)
    ):
        raise RuntimeError(
            f"STOP: pack-copy SHA mismatch {src.name}"
        )

HUMAN_TEMPLATE_CSV = (
    HUMAN_PACK_ROOT
    /
    "ASTOR_GATE2C_9A_HUMAN_BBOX_ANNOTATION_TEMPLATE_V1_1.csv"
)

write_csv(
    HUMAN_TEMPLATE_CSV,
    human_template,
)

README = (
    HUMAN_PACK_ROOT
    /
    "README_9A_HUMAN_BBOX_LABEL_PROTOCOL_V1_1.md"
)

README.write_text(
"""# Astor TuneUp — 9A Development Human BBox Label Protocol v1.1

Target: physical Club Head body.

Allowed human_state:
- POSITIVE_BOX_CONFIDENT: draw one confident Club Head bbox.
- NEGATIVE_NO_CLUB_HEAD_VISIBLE: confidently no visible Club Head body; no bbox.
- IGNORE_UNRESOLVABLE_OR_OCCLUDED: ambiguous/occluded/severe blur; no bbox.

Do not label ball, shaft alone, hands, body, shoes, grass, trees, or background.

Images are prediction-free: no detector boxes/confidence/runtime-gate/Fresh-result overlays.

Training remains forbidden until the completed human result is validated and frozen.
""",
    encoding="utf-8",
)

for p in (
    SOURCE_ROSTER_CSV,
    ENV_JSON,
    PROTOCOL_JSON,
    SELECTION_JSON,
    SUPERSESSION_JSON,
    PREFREEZE_JSON,
):
    shutil.copy2(
        p,
        HUMAN_PACK_ROOT
        /
        p.name,
    )

HUMAN_MANIFEST = (
    HUMAN_PACK_ROOT
    /
    "ASTOR_GATE2C_9A_HUMAN_BBOX_LABEL_PACK_MANIFEST_V1_1.json"
)

files_for_manifest = [
    p
    for p in HUMAN_PACK_ROOT.rglob("*")
    if (
        p.is_file()
        and
        p != HUMAN_MANIFEST
    )
]

write_json(
    HUMAN_MANIFEST,
    {
        "schema":
            "astor_gate2c_9a_human_bbox_label_pack_manifest_v1_1",

        "created_utc":
            utc_now(),

        "candidate_count":
            len(candidate_rows),

        "raw_frame_count":
            len(
                list(
                    pack_frames.glob(
                        "*.jpg"
                    )
                )
            ),

        "annotation_frames_contain_model_overlay":
            False,

        "training_authorized":
            False,

        "files": {
            str(
                p.relative_to(
                    HUMAN_PACK_ROOT
                )
            ):
                sha256_file(p)

            for p in sorted(
                files_for_manifest
            )
        },
    },
)

HUMAN_FREEZE = (
    HUMAN_PACK_ROOT
    /
    "ASTOR_GATE2C_9A_HUMAN_BBOX_LABEL_PACK_FREEZE_V1_1.json"
)

write_json(
    HUMAN_FREEZE,
    {
        "schema":
            "astor_gate2c_9a_human_bbox_label_pack_freeze_v1_1",

        "status":
            "FROZEN_AWAITING_HUMAN_BBOX_ANNOTATION",

        "candidate_count":
            len(candidate_rows),

        "human_template_sha256":
            sha256_file(
                HUMAN_TEMPLATE_CSV
            ),

        "manifest_sha256":
            sha256_file(
                HUMAN_MANIFEST
            ),

        "training_authorized":
            False,

        "next_action":
            "COLAB_HUMAN_BBOX_ANNOTATION_AND_FREEZE",
    },
)

with zipfile.ZipFile(
    HUMAN_PACK_ZIP,
    "w",
    compression=zipfile.ZIP_DEFLATED,
    compresslevel=6,
) as z:
    for p in sorted(
        HUMAN_PACK_ROOT.rglob("*")
    ):
        if p.is_file():
            z.write(
                p,
                arcname=str(
                    p.relative_to(
                        HUMAN_PACK_ROOT
                    )
                ),
            )

with zipfile.ZipFile(
    HUMAN_PACK_ZIP,
    "r",
) as z:
    bad = z.testzip()

    if bad is not None:
        raise RuntimeError(
            f"STOP: Human pack ZIP corrupt member: {bad}"
        )

# ============================================================
# Machine result / freeze
# ============================================================

reason_counts = defaultdict(
    int
)

for r in candidate_rows:
    for reason in r[
        "selection_reasons"
    ].split("|"):
        if reason:
            reason_counts[
                reason
            ] += 1

total_frames = len(
    all_rows
)

detected_frames = sum(
    int(
        r["det_count"]
    )
    >
    0
    for r in all_rows
)

no_detection_frames = (
    total_frames
    -
    detected_frames
)

MACHINE_RESULT = (
    OUT
    /
    "ASTOR_GATE2C_9A_DETECTOR_FAILURE_MINING_RESULT_V1_1.json"
)

write_json(
    MACHINE_RESULT,
    {
        "schema":
            "astor_gate2c_9a_detector_failure_mining_result_v1_1",

        "status":
            "MACHINE_MINING_COMPLETE_HUMAN_LABEL_PACK_FROZEN",

        "runner":
            "v1.3_nonlocal_fix",

        "parent_source_role_final_zip_sha256":
            SOURCE_ROLE_FINAL_ZIP_SHA,

        "preinference_freeze_sha256":
            sha256_file(
                PREFREEZE_JSON
            ),

        "runtime_environment_sha256":
            sha256_file(
                ENV_JSON
            ),

        "frozen_v2_model_sha256":
            FROZEN_V2_MODEL_SHA,

        "device":
            str(device),

        "source_count":
            7,

        "total_frames":
            total_frames,

        "detected_frames":
            detected_frames,

        "no_detection_frames":
            no_detection_frames,

        "gap_count":
            len(
                gap_rows
            ),

        "candidate_count":
            len(
                candidate_rows
            ),

        "candidate_reason_counts":
            dict(
                sorted(
                    reason_counts.items()
                )
            ),

        "human_pack_zip_sha256":
            sha256_file(
                HUMAN_PACK_ZIP
            ),

        "training_executed":
            False,

        "tuning_executed":
            False,

        "model_selection_executed":
            False,

        "runtime_gate_retuned":
            False,

        "fresh_cohort_accessed":
            False,

        "9a_training_authorized":
            False,

        "next_action":
            "COLAB_HUMAN_BBOX_ANNOTATION_AND_FREEZE",
    },
)

MACHINE_MANIFEST = (
    OUT
    /
    "ASTOR_GATE2C_9A_DETECTOR_FAILURE_MINING_MANIFEST_V1_1.json"
)

machine_files = [
    SOURCE_ROSTER_CSV,
    ENV_JSON,
    PROTOCOL_JSON,
    SELECTION_JSON,
    SUPERSESSION_JSON,
    PREFREEZE_JSON,
    FRAME_CSV,
    GAPS_CSV,
    DECODE_CSV,
    CANDIDATE_CSV,
    MACHINE_RESULT,
]

write_json(
    MACHINE_MANIFEST,
    {
        "schema":
            "astor_gate2c_9a_detector_failure_mining_manifest_v1_1",

        "created_utc":
            utc_now(),

        "outputs": {
            p.name:
                sha256_file(p)

            for p in machine_files
        },

        "human_pack_zip_sha256":
            sha256_file(
                HUMAN_PACK_ZIP
            ),
    },
)

MACHINE_FREEZE = (
    OUT
    /
    "ASTOR_GATE2C_9A_DETECTOR_FAILURE_MINING_FREEZE_V1_1.json"
)

write_json(
    MACHINE_FREEZE,
    {
        "schema":
            "astor_gate2c_9a_detector_failure_mining_freeze_v1_1",

        "status":
            "FROZEN_AT_HUMAN_BBOX_ANNOTATION_BOUNDARY",

        "machine_result_sha256":
            sha256_file(
                MACHINE_RESULT
            ),

        "machine_manifest_sha256":
            sha256_file(
                MACHINE_MANIFEST
            ),

        "human_pack_zip_sha256":
            sha256_file(
                HUMAN_PACK_ZIP
            ),

        "training_authorized":
            False,

        "model_selection_authorized":
            False,

        "runtime_gate_retune_authorized":
            False,

        "fresh_cohort_development_use_authorized":
            False,

        "next_action":
            "COLAB_HUMAN_BBOX_ANNOTATION_AND_FREEZE",
    },
)

with zipfile.ZipFile(
    MACHINE_FINAL_ZIP,
    "w",
    compression=zipfile.ZIP_DEFLATED,
    compresslevel=6,
) as z:
    for p in sorted(
        OUT.iterdir(),
        key=lambda x: x.name,
    ):
        if p.is_file():
            z.write(
                p,
                arcname=p.name,
            )

with zipfile.ZipFile(
    MACHINE_FINAL_ZIP,
    "r",
) as z:
    bad = z.testzip()

    if bad is not None:
        raise RuntimeError(
            f"STOP: Machine final ZIP corrupt member: {bad}"
        )

by_source = defaultdict(
    int
)

for r in candidate_rows:
    by_source[
        r["source_id"]
    ] += 1

# ============================================================
# FINAL SUMMARY
# ============================================================

print()

print(
    "=" * 100
)

print(
    "ASTOR GATE2C 9A DETECTOR FAILURE MINING + "
    "HUMAN LABEL PACK v1.1 FINAL SUMMARY"
)

print(
    "=" * 100
)

print(
    "STATUS: "
    "MACHINE_MINING_COMPLETE_HUMAN_LABEL_PACK_FROZEN"
)

print()

print(
    "ENVIRONMENT"
)

print(
    "-" * 100
)

print(
    "PYTHON:",
    sys.version.split()[0],
)

print(
    "TORCH:",
    torch.__version__,
)

print(
    "ULTRALYTICS:",
    ultralytics.__version__,
)

print(
    "OPENCV:",
    cv2.__version__,
)

print(
    "CUDA AVAILABLE:",
    torch.cuda.is_available(),
)

print(
    "DEVICE:",
    device,
)

print()

print(
    "PRE-INFERENCE LINEAGE"
)

print(
    "-" * 100
)

print(
    "SUPERSEDED PREINFERENCE FREEZE:",
    SUPERSEDED_PREINFERENCE_FREEZE_SHA,
)

print(
    "SUPERSEDED REASON:",
    SUPERSEDED_REASON,
)

print(
    "INFERENCE UNDER SUPERSEDED FREEZE: False"
)

print(
    "SOURCE ROSTER:",
    sha256_file(
        SOURCE_ROSTER_CSV
    ),
)

print(
    "ENVIRONMENT:",
    sha256_file(
        ENV_JSON
    ),
)

print(
    "PROTOCOL:",
    sha256_file(
        PROTOCOL_JSON
    ),
)

print(
    "SELECTION:",
    sha256_file(
        SELECTION_JSON
    ),
)

print(
    "SUPERSESSION:",
    sha256_file(
        SUPERSESSION_JSON
    ),
)

print(
    "NEW PREFREEZE:",
    sha256_file(
        PREFREEZE_JSON
    ),
)

print()

print(
    "FROZEN V2 DEVELOPMENT INFERENCE"
)

print(
    "-" * 100
)

print(
    "SOURCES: 7"
)

print(
    "TOTAL FRAMES:",
    total_frames,
)

print(
    "DETECTED FRAMES:",
    detected_frames,
)

print(
    "NO-DETECTION FRAMES:",
    no_detection_frames,
)

print(
    "NO-DETECTION GAPS:",
    len(
        gap_rows
    ),
)

print(
    "MODEL SHA:",
    FROZEN_V2_MODEL_SHA,
)

print(
    "PARAMS:",
    {
        "imgsz":
            MODEL_IMGSZ,

        "conf":
            MODEL_CONF,

        "iou":
            MODEL_IOU,

        "max_det":
            MODEL_MAX_DET,
    },
)

print()

print(
    "HUMAN LABEL CANDIDATES"
)

print(
    "-" * 100
)

print(
    "TOTAL:",
    len(
        candidate_rows
    ),
)

for sid in EXPECTED_9A:
    print(
        sid,
        "candidates=",
        by_source[sid],
    )

print(
    "REASON COUNTS:",
    dict(
        sorted(
            reason_counts.items()
        )
    ),
)

print(
    "ANNOTATION FRAMES CONTAIN MODEL OVERLAY: False"
)

print()

print(
    "SCIENTIFIC STATE"
)

print(
    "-" * 100
)

print(
    "TRAINING EXECUTED: False"
)

print(
    "TUNING EXECUTED: False"
)

print(
    "MODEL SELECTION EXECUTED: False"
)

print(
    "RUNTIME GATE RETUNED: False"
)

print(
    "FRESH COHORT ACCESSED: False"
)

print(
    "9A TRAINING AUTHORIZED: False"
)

print()

print(
    "ARTIFACT HASHES"
)

print(
    "-" * 100
)

print(
    "FRAME INFERENCE:",
    sha256_file(
        FRAME_CSV
    ),
)

print(
    "GAPS:",
    sha256_file(
        GAPS_CSV
    ),
)

print(
    "CANDIDATE ROSTER:",
    sha256_file(
        CANDIDATE_CSV
    ),
)

print(
    "MACHINE RESULT:",
    sha256_file(
        MACHINE_RESULT
    ),
)

print(
    "MACHINE MANIFEST:",
    sha256_file(
        MACHINE_MANIFEST
    ),
)

print(
    "MACHINE FREEZE:",
    sha256_file(
        MACHINE_FREEZE
    ),
)

print(
    "HUMAN LABEL PACK:",
    sha256_file(
        HUMAN_PACK_ZIP
    ),
)

print(
    "MACHINE FINAL ZIP:",
    sha256_file(
        MACHINE_FINAL_ZIP
    ),
)

print()

print(
    "DOWNLOAD BOTH ZIPs:"
)

print(
    HUMAN_PACK_ZIP
)

print(
    MACHINE_FINAL_ZIP
)

print()

print(
    "STOP — REAL HUMAN BBOX ANNOTATION BOUNDARY"
)

print(
    "NEXT ACTION: "
    "COLAB_HUMAN_BBOX_ANNOTATION_AND_FREEZE"
)

print()

print(
    "Download BOTH ZIPs and paste this "
    "FINAL SUMMARY back to ChatGPT."
)