def find_failure_candidates(detections, low_thresh=0.20, high_thresh=0.80):
    candidates = []
    for d in detections:
        conf = d.get("confidence", 1.0)
        if low_thresh <= conf <= high_thresh:
            candidates.append(d)
    return candidates
