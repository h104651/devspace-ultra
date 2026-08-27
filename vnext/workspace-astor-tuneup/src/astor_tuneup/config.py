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
DATASET_ROOT = Path("/kaggle/input/astor-tuneup-project")
