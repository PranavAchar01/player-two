"""Pose tracks from a video. Writes numbers only: no frames, no pixels."""
import json, sys
import cv2
import mediapipe as mp
from mediapipe.tasks import python as mpp
from mediapipe.tasks.python import vision

video, model, out = sys.argv[1:4]
# 17-22 are the pinky, index and thumb of each hand: the arm embodiments read the gripper from them
IDS = [0, 11, 12, 13, 14, 15, 16, 17, 18, 19, 20, 21, 22, 23, 24, 25, 26, 27, 28, 29, 30, 31, 32]
opts = vision.PoseLandmarkerOptions(base_options=mpp.BaseOptions(model_asset_path=model, delegate=mpp.BaseOptions.Delegate.CPU), running_mode=vision.RunningMode.VIDEO, num_poses=1)
cap = cv2.VideoCapture(video)
fps = cap.get(cv2.CAP_PROP_FPS) or 30.0
frames = []
with vision.PoseLandmarker.create_from_options(opts) as lm:
    i = 0
    while True:
        ok, bgr = cap.read()
        if not ok:
            break
        res = lm.detect_for_video(mp.Image(image_format=mp.ImageFormat.SRGB, data=cv2.cvtColor(bgr, cv2.COLOR_BGR2RGB)), int(i * 1000 / fps))
        if res.pose_world_landmarks:
            w, n = res.pose_world_landmarks[0], res.pose_landmarks[0]
            frames.append({"t": round(i / fps, 4), "world": {k: [round(w[k].x, 4), round(w[k].y, 4), round(w[k].z, 4), round(w[k].visibility, 3)] for k in IDS}, "image": {k: [round(n[k].x, 4), round(n[k].y, 4)] for k in IDS}})
        else:
            frames.append({"t": round(i / fps, 4), "world": None, "image": None})
        i += 1
json.dump({"fps": fps, "width": int(cap.get(3)), "height": int(cap.get(4)), "frames": frames}, open(out, "w"))
print(video, "frames", len(frames), "tracked", sum(1 for f in frames if f["world"]))
