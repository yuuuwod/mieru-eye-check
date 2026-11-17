# Mieru Python depth service

This API uses the official Depth Anything V2 Metric Hypersim Small model to infer a metric depth map. The phone automatically calibrates each selected camera at an approximate 40 cm and stores that camera's correction factor locally. The API samples the centered face area and applies that factor to subsequent images.

The app sends a reduced-resolution JPEG for calibration and about every 1.8 seconds during the distance check. The service keeps each image in memory for inference and does not write images to disk. Use HTTPS for a deployed service. The model is an estimate and is not a clinical-grade rangefinder.

## Install the official model

```sh
git clone --depth 1 https://github.com/DepthAnything/Depth-Anything-V2.git
python3 -m venv .venv
source .venv/bin/activate
pip install -r Depth-Anything-V2/metric_depth/requirements.txt
pip install -r depth_service/requirements.txt
```

Download the official `Depth-Anything-V2-Metric-Hypersim-Small` checkpoint (`depth_anything_v2_metric_hypersim_vits.pth`) from the [model page](https://huggingface.co/depth-anything/Depth-Anything-V2-Metric-Hypersim-Small) and place it in the cloned repository's `metric_depth/checkpoints/` directory.

Set paths and start the API:

```sh
export DEPTH_ANYTHING_METRIC_DIR="/path/to/Depth-Anything-V2/metric_depth"
export DEPTH_ANYTHING_CHECKPOINT="$DEPTH_ANYTHING_METRIC_DIR/checkpoints/depth_anything_v2_metric_hypersim_vits.pth"
cd depth_service
uvicorn app:app --host 0.0.0.0 --port 8000
```

The service uses CUDA when available, otherwise Apple MPS or CPU. CPU inference can be slow.

## Connect the app

Set `EXPO_PUBLIC_DEPTH_API_URL` in `mobile/.env.local` to a reachable API URL, then restart Metro and rebuild the native app. For local development, the development server can use the computer's LAN address. For App Store / Google Play distribution, deploy the service at an HTTPS endpoint and set the production URL in the EAS build environment.

Check `GET /health` before starting the app. Images are sent only to the URL configured by the app builder.
