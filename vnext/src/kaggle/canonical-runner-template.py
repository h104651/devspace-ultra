# ==============================================================================
# DevSpace Ultra vNext — Authoritative Canonical Workspace Thin Runner
# ==============================================================================
# This template is version-controlled and shared across all DevSpace Large Project
# Workspaces. It verifies runtime dataset version, canonical workspace fingerprint,
# and executes the active project entrypoint while separating workspace validation
# from experiment execution status.
# ==============================================================================

from pathlib import Path
import os
import sys
import json
import time
import hashlib

print("=" * 70)
print("DEVSPACE ULTRA — CANONICAL WORKSPACE RUNNER")
print("=" * 70)

INPUT_ROOT = Path("/kaggle/input")
WORK_ROOT = Path("/kaggle/working")

# 1. Discover Project Dataset
manifest_matches = list(INPUT_ROOT.rglob("*devspace-project.json"))
if not manifest_matches:
    print("Available /kaggle/input files:")
    for f in INPUT_ROOT.rglob("*"):
        if f.is_file():
            print(" ", f)
    raise RuntimeError("FATAL: devspace-project.json not found in /kaggle/input")

MANIFEST_PATH = manifest_matches[0]
PROJECT_ROOT = MANIFEST_PATH.parent
print(f"Discovered Dataset Root: {PROJECT_ROOT}")

manifest = json.loads(MANIFEST_PATH.read_text(encoding="utf-8"))
print(f"Project Name    : {manifest.get('name')}")
print(f"Project Slug    : {manifest.get('slug')}")
print(f"Dataset Version : {manifest.get('version')}")
print(f"Entrypoint      : {manifest.get('entrypoint')}")

# 2. Compute canonical workspace fingerprint
sorted_keys = sorted(list(manifest.get('files', {}).keys()))
canonical_entries = [
    {
        "path": k,
        "size": manifest["files"][k]["size"],
        "sha256": manifest["files"][k]["sha256"]
    }
    for k in sorted_keys
]
payload = {
    "name": manifest["name"],
    "slug": manifest["slug"],
    "version": manifest["version"],
    "entrypoint": manifest["entrypoint"],
    "runnerKernelRef": manifest["runnerKernelRef"],
    "files": canonical_entries
}
computed_fp = hashlib.sha256(json.dumps(payload, separators=(',', ':')).encode('utf-8')).hexdigest()
print(f"Computed Runtime Fingerprint: {computed_fp}")

# 3. Read Execution Context (if delivered via devspace-execution-context.json)
context_matches = list(PROJECT_ROOT.rglob("*devspace-execution-context.json"))
if not context_matches:
    context_matches = list(INPUT_ROOT.rglob("*devspace-execution-context.json"))

if context_matches:
    context = json.loads(context_matches[0].read_text(encoding="utf-8"))
    expected_version = context.get("expectedDatasetVersion")
    expected_fp = context.get("expectedWorkspaceFingerprint")
    print(f"Context Expected Version: {expected_version}, Expected FP: {expected_fp}")

    if expected_version is not None and manifest.get("version") != expected_version:
        print(f"DEVSPACE_WORKSPACE_VERSION_MISMATCH: Manifest version ({manifest.get('version')}) != expected ({expected_version})")
        sys.exit(1)
    if expected_fp and computed_fp != expected_fp:
        print(f"DEVSPACE_WORKSPACE_VERSION_MISMATCH: Computed fingerprint ({computed_fp}) != expected ({expected_fp})")
        sys.exit(1)

print("RUNTIME_WORKSPACE_IDENTITY_GUARD: PASS ✅")

# 4. Assemble sys.path and execute Active Project Entrypoint
entrypoint_rel = manifest.get("entrypoint")
assert entrypoint_rel, "Manifest missing required string 'entrypoint'"
entrypoint_path = PROJECT_ROOT / entrypoint_rel

if not entrypoint_path.exists():
    print(f"FATAL: Entrypoint file does not exist at {entrypoint_path}")
    sys.exit(1)

print(f"\nExecuting Project Entrypoint: {entrypoint_rel}...")
sys.path.insert(0, str(PROJECT_ROOT))
if (PROJECT_ROOT / "src").exists():
    sys.path.insert(0, str(PROJECT_ROOT / "src"))

exp_status = "FAIL"
exp_error = None
try:
    exec_globals = {
        "__name__": "__main__",
        "__file__": str(entrypoint_path),
        "PROJECT_ROOT": PROJECT_ROOT,
        "WORK_ROOT": WORK_ROOT
    }
    exec(entrypoint_path.read_text(encoding="utf-8"), exec_globals)
    exp_status = "PASS"
    print("\nProject Entrypoint Execution: SUCCESS ✅")
except Exception as e:
    exp_error = str(e)
    print(f"\nProject Entrypoint Execution FAILED with exception: {e}")
    exp_status = "FAIL"

# 5. Write Standard DevSpace Execution Result
result = {
    "project": manifest.get("name"),
    "datasetVersion": manifest.get("version"),
    "workspaceFingerprint": computed_fp,
    "entrypoint": entrypoint_rel,
    "workspaceValidation": "PASS",
    "experimentExecution": exp_status,
    "error": exp_error,
    "timestamp": time.time()
}
out_file = WORK_ROOT / "devspace-result.json"
out_file.write_text(json.dumps(result, indent=2), encoding="utf-8")
print(f"Result written to: {out_file}")

if exp_status != "PASS":
    sys.exit(1)

print("\n" + "=" * 70)
print("DEVSPACE_RUNNER_FINISH_PASS")
print("=" * 70)
