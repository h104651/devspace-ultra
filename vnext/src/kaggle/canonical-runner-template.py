# ==============================================================================
# DevSpace Ultra vNext — Authoritative Canonical Workspace Thin Runner
# ==============================================================================
# This template is version-controlled and shared across all DevSpace Large Project
# Workspaces. It fails closed on missing/malformed execution context, deterministically
# selects the target workspace dataset, verifies dataset version and canonical
# workspace fingerprint, and executes the active project entrypoint while separating
# workspace validation from experiment execution status.
# ==============================================================================

from pathlib import Path
import os
import sys
import json
import time
import hashlib

# Ensure utf-8 stdout/stderr across all platforms
if hasattr(sys.stdout, 'reconfigure'):
    try:
        sys.stdout.reconfigure(encoding="utf-8", errors="replace")
        sys.stderr.reconfigure(encoding="utf-8", errors="replace")
    except Exception:
        pass

print("=" * 70)
print("DEVSPACE ULTRA -- CANONICAL WORKSPACE RUNNER")
print("=" * 70)

INPUT_ROOT = Path(os.environ.get("DEVSPACE_INPUT_ROOT", "/kaggle/input"))
WORK_ROOT = Path(os.environ.get("DEVSPACE_WORK_ROOT", "/kaggle/working"))

# ------------------------------------------------------------------------------
# 1. Resolve and Validate Execution Context (FAIL CLOSED)
# ------------------------------------------------------------------------------
context_matches = list(INPUT_ROOT.rglob("*devspace-execution-context.json"))
if not context_matches:
    print("FATAL: DEVSPACE_EXECUTION_CONTEXT_MISSING: devspace-execution-context.json not found in /kaggle/input")
    sys.exit(1)

if len(context_matches) > 1:
    print(f"FATAL: DEVSPACE_EXECUTION_CONTEXT_AMBIGUOUS: Found {len(context_matches)} execution context files")
    sys.exit(1)

CONTEXT_PATH = context_matches[0]
print(f"Loaded Execution Context File: {CONTEXT_PATH}")

try:
    context = json.loads(CONTEXT_PATH.read_text(encoding="utf-8"))
except Exception as e:
    print(f"FATAL: DEVSPACE_EXECUTION_CONTEXT_MALFORMED: JSON parse error: {e}")
    sys.exit(1)

REQUIRED_CONTEXT_FIELDS = ["project", "slug", "expectedDatasetVersion", "expectedWorkspaceFingerprint", "entrypoint"]
for field in REQUIRED_CONTEXT_FIELDS:
    if field not in context or context[field] is None or context[field] == "":
        print(f"FATAL: DEVSPACE_EXECUTION_CONTEXT_INVALID: Missing required field '{field}'")
        sys.exit(1)

expected_project = context["project"]
expected_slug = context["slug"]
expected_version = context["expectedDatasetVersion"]
expected_fp = context["expectedWorkspaceFingerprint"]
expected_entrypoint = context["entrypoint"]

print(f"Context Target Project: {expected_project} ({expected_slug})")
print(f"Context Expected Version: {expected_version}")
print(f"Context Expected Fingerprint: {expected_fp}")
print(f"Context Expected Entrypoint: {expected_entrypoint}")

# ------------------------------------------------------------------------------
# 2. Deterministic Workspace Selection
# ------------------------------------------------------------------------------
manifest_matches = list(INPUT_ROOT.rglob("*devspace-project.json"))
matching_manifests = []

for mp in manifest_matches:
    try:
        raw_m = json.loads(mp.read_text(encoding="utf-8"))
        if raw_m.get("slug") == expected_slug:
            matching_manifests.append((mp, raw_m))
    except Exception as e:
        print(f"Warning: Failed to parse manifest at {mp}: {e}")

if len(matching_manifests) == 0:
    print(f"FATAL: DEVSPACE_WORKSPACE_NOT_FOUND: No workspace manifest matching slug '{expected_slug}' found")
    sys.exit(1)

if len(matching_manifests) > 1:
    print(f"FATAL: DEVSPACE_WORKSPACE_AMBIGUOUS: Found {len(matching_manifests)} workspace manifests matching slug '{expected_slug}'")
    sys.exit(1)

MANIFEST_PATH, manifest = matching_manifests[0]
PROJECT_ROOT = MANIFEST_PATH.parent
print(f"Discovered Target Workspace Root: {PROJECT_ROOT}")

# ------------------------------------------------------------------------------
# 3. Context / Manifest Consistency & Runtime Identity Guards
# ------------------------------------------------------------------------------
if manifest.get("entrypoint") != expected_entrypoint:
    print(f"FATAL: DEVSPACE_WORKSPACE_VERSION_MISMATCH: Manifest entrypoint ({manifest.get('entrypoint')}) != context entrypoint ({expected_entrypoint})")
    sys.exit(1)

if manifest.get("version") != expected_version:
    print(f"FATAL: DEVSPACE_WORKSPACE_VERSION_MISMATCH: Manifest version ({manifest.get('version')}) != expected version ({expected_version})")
    sys.exit(1)

# Compute canonical workspace fingerprint
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

if computed_fp != expected_fp:
    print(f"FATAL: DEVSPACE_WORKSPACE_VERSION_MISMATCH: Computed fingerprint ({computed_fp}) != expected fingerprint ({expected_fp})")
    sys.exit(1)

print("RUNTIME_WORKSPACE_IDENTITY_GUARD: PASS")

# ------------------------------------------------------------------------------
# 4. Assemble sys.path and execute Active Project Entrypoint
# ------------------------------------------------------------------------------
entrypoint_path = PROJECT_ROOT / expected_entrypoint
if not entrypoint_path.exists():
    print(f"FATAL: Entrypoint file does not exist at {entrypoint_path}")
    sys.exit(1)

print(f"\nExecuting Project Entrypoint: {expected_entrypoint}...")
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
    print("\nProject Entrypoint Execution: SUCCESS")
except Exception as e:
    exp_error = str(e)
    print(f"\nProject Entrypoint Execution FAILED with exception: {e}")
    exp_status = "FAIL"

# ------------------------------------------------------------------------------
# 5. Write Standard DevSpace Execution Result
# ------------------------------------------------------------------------------
result = {
    "project": manifest.get("name"),
    "datasetVersion": manifest.get("version"),
    "workspaceFingerprint": computed_fp,
    "entrypoint": expected_entrypoint,
    "workspaceValidation": "PASS",
    "experimentExecution": exp_status,
    "error": exp_error,
    "timestamp": time.time()
}
WORK_ROOT.mkdir(parents=True, exist_ok=True)
out_file = WORK_ROOT / "devspace-result.json"
out_file.write_text(json.dumps(result, indent=2), encoding="utf-8")
print(f"Result written to: {out_file}")

if exp_status != "PASS":
    sys.exit(1)

print("\n" + "=" * 70)
print("DEVSPACE_RUNNER_FINISH_PASS")
print("=" * 70)
