/**
 * The face models, self-hosted under /models/ (apps/web/public/models, with their licences) and checked
 * against these SHA-256 values before use. Unchanged copies from OpenCV Zoo (github.com/opencv/opencv_zoo).
 */
export const MODELS = {
  yunet: {
    file: 'face_detection_yunet_2023mar.onnx',
    sha256: '8f2383e4dd3cfbb4553ea8718107fc0423210dc964f9f4280604804ed2552fa4',
    bytes: 232_589,
  },
  sface: {
    file: 'face_recognition_sface_2021dec_int8.onnx',
    sha256: '2b0e941e6f16cc048c20aee0c8e31f569118f65d702914540f7bfdc14048d78a',
    bytes: 9_896_933,
  },
} as const;
export const MODEL_PATH = '/models/';
export const MODEL_CACHE = 'zephyr-models-v1';
