import os
from pathlib import Path

PROJECT_NAME = "Astor TuneUp"
GATE_VERSION = "Gate2C-9A"
EXPERIMENT_NAME = "detector_failure_mining"

FROZEN_V2_MODEL_SHA = "648208026CECFB910624AD27A8A1E1F481570DD7EC1277AB4C6E54FAEB68ADE4"
INFER_IMGSZ = 960
INFER_CONF = 0.25
INFER_IOU = 0.70
INFER_MAX_DET = 300

INPUT_ROOT = Path("/kaggle/input")
WORK_ROOT = Path("/kaggle/working")


def _resolve_project_root() -> Path:
    env_root = os.getenv("ASTOR_TUNEUP_PROJECT_ROOT")
    if env_root and Path(env_root).exists():
        return Path(env_root).resolve()

    # Derive relative to installed source file (parents[2] from src/astor_tuneup/config.py)
    source_root = Path(__file__).resolve().parents[2]
    if (source_root / "devspace-project.json").exists():
        return source_root

    # Robust fallback: search /kaggle/input for devspace-project.json
    if INPUT_ROOT.exists():
        matches = list(INPUT_ROOT.rglob("devspace-project.json"))
        if matches:
            return matches[0].parent

    return source_root


PROJECT_ROOT = _resolve_project_root()
DATASET_ROOT = PROJECT_ROOT  # Backward-compatibility alias
