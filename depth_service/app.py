"""Metric depth service used by the Mieru mobile app.

Images are processed in memory and are not written to disk. The app sends a
low-resolution camera JPEG only while calibrating or checking distance.
"""

from __future__ import annotations

import io
import os
import sys
from pathlib import Path
from threading import Lock
from typing import Annotated

import cv2
import numpy as np
import torch
from fastapi import FastAPI, HTTPException, Request
from fastapi.concurrency import run_in_threadpool
from PIL import Image, ImageOps
from pydantic import BaseModel, Field

METRIC_DEPTH_DIR_ENV = os.environ.get("DEPTH_ANYTHING_METRIC_DIR")
CHECKPOINT_ENV = os.environ.get("DEPTH_ANYTHING_CHECKPOINT")
if not METRIC_DEPTH_DIR_ENV:
    raise RuntimeError("Set DEPTH_ANYTHING_METRIC_DIR to Depth-Anything-V2/metric_depth")
if not CHECKPOINT_ENV:
    raise RuntimeError("Set DEPTH_ANYTHING_CHECKPOINT to the Hypersim Small checkpoint")
METRIC_DEPTH_DIR = Path(METRIC_DEPTH_DIR_ENV)
CHECKPOINT = Path(CHECKPOINT_ENV)
if not METRIC_DEPTH_DIR.is_dir():
    raise RuntimeError("DEPTH_ANYTHING_METRIC_DIR does not exist")
if not CHECKPOINT.is_file():
    raise RuntimeError("DEPTH_ANYTHING_CHECKPOINT does not exist")
sys.path.insert(0, str(METRIC_DEPTH_DIR))
from depth_anything_v2.dpt import DepthAnythingV2  # noqa: E402

DEVICE = "cuda" if torch.cuda.is_available() else "mps" if torch.backends.mps.is_available() else "cpu"
MODEL_CONFIG = {"encoder": "vits", "features": 64, "out_channels": [48, 96, 192, 384]}
model = DepthAnythingV2(**{**MODEL_CONFIG, "max_depth": 20})
model.load_state_dict(torch.load(CHECKPOINT, map_location="cpu", weights_only=True))
model = model.to(DEVICE).eval()
model_lock = Lock()

app = FastAPI(title="Mieru Python Metric Depth", version="1.0.0")
MAX_IMAGE_BYTES = 4 * 1024 * 1024


class CalibrationResponse(BaseModel):
    raw_distance_cm: Annotated[float, Field(gt=0)]
    depth_scale_factor: Annotated[float, Field(gt=0, le=5)]
    method: str = "depth-anything-v2-metric-hypersim-small"


class EstimateResponse(BaseModel):
    distance_cm: Annotated[float, Field(gt=0)]
    method: str = "depth-anything-v2-metric-hypersim-small"
    calibrated: bool = True


def decode_jpeg(data: bytes) -> np.ndarray:
    if not data or len(data) > MAX_IMAGE_BYTES:
        raise HTTPException(status_code=413, detail="Image must be between 1 byte and 4 MB")
    try:
        with Image.open(io.BytesIO(data)) as image:
            if image.width > 4096 or image.height > 4096:
                raise HTTPException(status_code=413, detail="Image dimensions are too large")
            rgb = np.asarray(ImageOps.exif_transpose(image).convert("RGB"))
        return cv2.cvtColor(rgb, cv2.COLOR_RGB2BGR)
    except HTTPException:
        raise
    except Exception as error:
        raise HTTPException(status_code=415, detail="Could not decode camera JPEG") from error


async def read_image(request: Request) -> np.ndarray:
    chunks: list[bytes] = []
    total_bytes = 0
    async for chunk in request.stream():
        total_bytes += len(chunk)
        if total_bytes > MAX_IMAGE_BYTES:
            raise HTTPException(status_code=413, detail="Image must be smaller than 4 MB")
        chunks.append(chunk)
    return decode_jpeg(b"".join(chunks))


def infer_face_depth_cm(image: np.ndarray) -> float:
    with model_lock:
        depth_map = model.infer_image(image, input_size=518)
    height, width = depth_map.shape
    # The calibration guide asks the user to center their face in the camera view.
    x0, x1 = int(width * 0.47), int(width * 0.53)
    y0, y1 = int(height * 0.45), int(height * 0.55)
    region = depth_map[y0:y1, x0:x1]
    valid = region[np.isfinite(region) & (region > 0)]
    if valid.size == 0:
        raise HTTPException(status_code=422, detail="No valid depth at the center of the image")
    return float(np.median(valid) * 100)


@app.get("/health")
def health() -> dict[str, str]:
    return {"status": "ok", "device": DEVICE}


@app.post("/calibrate", response_model=CalibrationResponse)
async def calibrate(request: Request) -> CalibrationResponse:
    image = await read_image(request)
    raw_cm = await run_in_threadpool(infer_face_depth_cm, image)
    scale = 40.0 / raw_cm
    return CalibrationResponse(raw_distance_cm=round(raw_cm, 1), depth_scale_factor=round(scale, 5))


@app.post("/estimate", response_model=EstimateResponse)
async def estimate(request: Request) -> EstimateResponse:
    try:
        scale = float(request.headers.get("x-depth-scale-factor", ""))
    except ValueError as error:
        raise HTTPException(status_code=422, detail="Missing depth calibration factor") from error
    if not np.isfinite(scale) or not 0 < scale <= 5:
        raise HTTPException(status_code=422, detail="Invalid depth calibration factor")
    image = await read_image(request)
    raw_cm = await run_in_threadpool(infer_face_depth_cm, image)
    corrected_cm = raw_cm * scale
    return EstimateResponse(distance_cm=round(corrected_cm, 1))
