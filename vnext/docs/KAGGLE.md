# DevSpace Ultra — Kaggle Free GPU Backend Guide

## 1. Overview

DevSpace Ultra connects directly to the official Kaggle API to provide free remote compute (NVIDIA Tesla T4 / P100 GPUs or multicore CPUs) for machine learning model training, tracking benchmarks, and heavy computation.

---

## 2. Configuration

Set your Kaggle credentials in `.env` or system environment variables:
```env
KAGGLE_USERNAME=your_kaggle_username
KAGGLE_KEY=your_kaggle_api_key
KAGGLE_MOCK_MODE=false
```
*Note: If `KAGGLE_MOCK_MODE=true` is set, the gateway simulates Kaggle kernel submission and execution for local testing and CI/CD without consuming Kaggle quota.*

---

## 3. Workflow & Usage

### 3.1 Submitting a GPU Job via MCP
ChatGPT or remote clients call the `kaggle_run` MCP tool:
```json
{
  "kernelSlug": "astor-bakeoff-train-01",
  "title": "Astor TrackNet Training Run 01",
  "code": "import torch\nprint('CUDA Available:', torch.cuda.is_available())\n# Training loop here...",
  "enableGpu": true,
  "enableInternet": true
}
```

### 3.2 Asynchronous Execution Cycle
1. **Packaging**: DevSpace Ultra generates `kernel-metadata.json` and a clean `.ipynb` / `.py` payload.
2. **Push**: `kaggle kernels push -p <tempDir>` uploads the kernel.
3. **Immediate Task ID**: The Gateway immediately returns `{ taskId: "task-...", status: "running" }` to the client.
4. **Background Polling**: Every 15 seconds, the Gateway checks `kaggle kernels status <slug>`.
5. **Completion & Artifact Ingestion**:
   - Downloads `stdout.log` and `stderr.log`.
   - Downloads output files (CSV predictions, model weights `.pt` / `.onnx`).
   - Ingests all outputs into `ArtifactStore`.
   - Marks task `succeeded`.

---

## 4. Quota Handling & Resiliency

* When Kaggle returns `429 Too Many Requests` or `GPU quota exceeded`, the backend captures the exact message and marks the task with structured error `RESOURCE_QUOTA_EXCEEDED`.
* Jobs can be cancelled at any time via `remote_task_cancel`.

---

## 5. First-Class Kaggle Dataset File Retrieval (`kaggle_dataset_file`)

The `kaggle_dataset_file` MCP tool provides safe, server-side direct file retrieval and authoritative SHA-256 integrity verification for files stored in any Kaggle Dataset version.

### 5.1 Guarantees & Invariants
* **Strictly READ ONLY**: Operates via read-only HTTP endpoints; performs **zero** Kaggle mutations (no dataset creation, versioning, kernel push, or execution).
* **Exact Version Resolution**:
  * If `datasetVersion` is omitted, the tool queries dataset metadata, determines `currentVersionNumber`, and explicitly pins both file listing and download to that exact resolved version.
  * If `datasetVersion` is supplied, it lists and downloads from that exact version.
* **Authoritative Actual-Byte SHA256**:
  * SHA-256 is computed server-side directly on the actual fetched byte payload (`crypto.createHash('sha256').update(actualBytes).digest('hex')`).
  * If `expectedSha256` is provided, a case-insensitive check determines `hashMatch: true | false`. The actual payload SHA is always preserved in `sha256`.
* **Bounded Inline Content**:
  * Textual files (`.json`, `.txt`, `.log`, `.md`, `.csv`, `.tsv`, `.yaml`, `.xml`, `.py`, etc.) return bounded UTF-8 text (default `maxBytes: 262144`, hard limit `1048576`).
  * Truncation uses safe UTF-8 byte boundary trimming to prevent broken multi-byte replacement characters.
* **Binary Safety**:
  * Binary files (`.zip`, `.parquet`, `.png`, `.pt`, etc.) return `content: null` and `encoding: null` without dumping binary data or Base64 inline, while preserving full file `size`, `sha256`, and `hashMatch`.

### 5.2 Example Usage

```json
{
  "datasetRef": "owner/dataset-slug",
  "relativePath": "results/result.json",
  "datasetVersion": 1,
  "expectedSha256": "c2f72c19cdac27a8e487931d904f1f2061481192b9b341fccd40832610fa89f9",
  "maxBytes": 262144
}
```

### 5.3 Example Response

```json
{
  "datasetRef": "owner/dataset-slug",
  "datasetVersion": 1,
  "relativePath": "results/result.json",
  "size": 1420,
  "sha256": "c2f72c19cdac27a8e487931d904f1f2061481192b9b341fccd40832610fa89f9",
  "hashMatch": true,
  "contentType": "application/json",
  "encoding": "utf-8",
  "content": "{\n  \"status\": \"PASS\"\n}",
  "expectedSha256": "c2f72c19cdac27a8e487931d904f1f2061481192b9b341fccd40832610fa89f9",
  "isText": true,
  "isTruncated": false,
  "returnedBytes": 1420
}
```

---

## 6. Workspace Execution & Additional Dataset Mounts (`kaggle_workspace_continue`)

The `kaggle_workspace_continue` tool supports atomic workspace version increments and thin runner execution.

### 6.1 Additional Dataset Mounts (`additionalDatasetDataSources`)
When executing a workspace thin runner, you can mount additional Kaggle datasets explicitly without modifying the canonical runner source code:
* Pass `additionalDatasetDataSources: ["owner/dataset-slug", ...]` (up to 8 datasets).
* The gateway validates each dataset ref, deduplicates against existing runner dataset sources and the workspace dataset, and attaches them to the runner kernel execution payload.
* The response returns `runnerDatasetSources: string[]` containing the complete, deduplicated dataset list mounted on the runner.


