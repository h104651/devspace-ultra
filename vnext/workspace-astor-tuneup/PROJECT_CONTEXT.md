# Astor TuneUp — Large Project Context & Architecture

## Project Overview
**Astor TuneUp** is a computer vision research project targeting continuous detector failure mining and fine-tuning on native CCTV and mobile video feeds.

## Project Lineage
1. **Gate 2C-8G**: Controlled V3 Fine-Tune using frozen ClubheadDB (4271 train / 327 val / 427 test) + V2 Replay (220) + V3 Delta (48).
2. **Gate 2C-8H**: Frozen V2 vs V3 A/B test on held-out gold/killer test sets.
3. **Gate 2C-9A (Active Lineage)**: Detector Failure Mining Protocol + Human Label Pack generation.
4. **Gate 2C-9B / 9C / 9D**: Mixed-FPS candidate extraction and human confirmation boundary protocols.

## Key Methods & Findings
- **Detector-Centric YOLO Lineage**: YOLOv8/YOLO11 architecture with frozen V2 weights initialization.
- **Fail-Safe Integrity Contract**: Every model weight, dataset slice, and manifest is verified against cryptographic SHA-256 hashes prior to inference.
- **Automated Failure Mining**: Mined candidate frames with confidence between 0.20 and 0.80 near boundary regions are packaged into structured Human Review Packs for ground-truth annotation.

## Active Experiment
- **Entrypoint**: `experiments/gate2c_9a_mining.py`
- **Protocol**: Gate 2C-9A Detector Failure Mining + Human BBox Label Pack v1.3
- **Runner Kernel**: `astorhsu/astor-tuneup-runner`
