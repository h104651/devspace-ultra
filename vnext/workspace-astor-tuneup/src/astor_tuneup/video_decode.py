import cv2
from pathlib import Path

def extract_video_frames(video_path, target_fps=10, max_frames=300):
    cap = cv2.VideoCapture(str(video_path))
    frames = []
    fps = cap.get(cv2.CAP_PROP_FPS) or target_fps
    stride = max(1, int(round(fps / target_fps)))
    idx = 0
    while cap.isOpened() and len(frames) < max_frames:
        ret, frame = cap.read()
        if not ret:
            break
        if idx % stride == 0:
            frames.append((idx, frame))
        idx += 1
    cap.release()
    return frames
