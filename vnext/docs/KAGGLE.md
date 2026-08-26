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
