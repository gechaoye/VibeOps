#!/usr/bin/env python3
import contextlib
import io
import json
import os
import sys
from pathlib import Path

from PIL import Image


RESULT_MARKER = "UIKG_OCR_RESULT="


def as_list(value):
    if hasattr(value, "tolist"):
        return value.tolist()
    return value


def mapping_from_result(value):
    if isinstance(value, dict):
        return value
    for attribute in ("json", "to_dict"):
        candidate = getattr(value, attribute, None)
        if candidate is None:
            continue
        candidate = candidate() if callable(candidate) else candidate
        if isinstance(candidate, str):
            candidate = json.loads(candidate)
        if isinstance(candidate, dict):
            return candidate
    return None


def find_recognition_mapping(value):
    mapping = mapping_from_result(value)
    if mapping is None:
        return None
    if "rec_texts" in mapping and "rec_scores" in mapping:
        return mapping
    for child in mapping.values():
        if isinstance(child, dict) or mapping_from_result(child) is not None:
            found = find_recognition_mapping(child)
            if found is not None:
                return found
    return None


def polygon_rect(polygon, image_width, image_height):
    polygon = as_list(polygon)
    if not isinstance(polygon, (list, tuple)):
        return None
    if len(polygon) == 4 and all(isinstance(item, (int, float)) for item in polygon):
        left, top, right, bottom = map(float, polygon)
    else:
        points = [as_list(point) for point in polygon]
        points = [point for point in points if isinstance(point, (list, tuple)) and len(point) >= 2]
        if not points:
            return None
        left = min(float(point[0]) for point in points)
        top = min(float(point[1]) for point in points)
        right = max(float(point[0]) for point in points)
        bottom = max(float(point[1]) for point in points)
    left = max(0.0, min(float(image_width), left))
    top = max(0.0, min(float(image_height), top))
    right = max(left, min(float(image_width), right))
    bottom = max(top, min(float(image_height), bottom))
    if right <= left or bottom <= top:
        return None
    return {"x": left, "y": top, "width": right - left, "height": bottom - top}


def parse_v3_results(results, image_width, image_height):
    observations = []
    for result in results:
        mapping = find_recognition_mapping(result)
        if mapping is None:
            continue
        texts = as_list(mapping.get("rec_texts", []))
        scores = as_list(mapping.get("rec_scores", []))
        polygons = []
        for key in ("rec_polys", "dt_polys", "rec_boxes"):
            candidate = as_list(mapping.get(key))
            if candidate is not None and len(candidate) > 0:
                polygons = candidate
                break
        for text, score, polygon in zip(texts, scores, polygons):
            rect = polygon_rect(polygon, image_width, image_height)
            if rect is not None and str(text).strip():
                observations.append({"text": str(text), "confidence": float(score), "rect": rect})
    return observations


def parse_v2_results(value, image_width, image_height):
    observations = []

    def visit(item):
        item = as_list(item)
        if not isinstance(item, (list, tuple)):
            return
        if len(item) == 2 and isinstance(item[1], (list, tuple)) and len(item[1]) >= 2:
            text, score = item[1][0], item[1][1]
            if isinstance(text, str) and isinstance(score, (int, float)):
                rect = polygon_rect(item[0], image_width, image_height)
                if rect is not None and text.strip():
                    observations.append({"text": text, "confidence": float(score), "rect": rect})
                return
        for child in item:
            visit(child)

    visit(value)
    return observations


def detect_separator_bands(image):
    """Find thin, long visual boundaries without assuming a color or orientation."""
    width, height = image.size
    image = image.convert("RGB")
    sample_step = max(2, min(width, height) // 240)

    def profile(axis):
        length, span = (height, width) if axis == "horizontal" else (width, height)
        values = []
        for index in range(length):
            samples = [image.getpixel((offset, index) if axis == "horizontal" else (index, offset))
                       for offset in range(0, span, sample_step)]
            means = tuple(sum(pixel[channel] for pixel in samples) / max(1, len(samples)) for channel in range(3))
            variation = sum(sum(abs(pixel[channel] - means[channel]) for channel in range(3)) for pixel in samples) / max(1, len(samples))
            values.append((means, variation))
        return values

    def collect(axis):
        values = profile(axis)
        length, span = (height, width) if axis == "horizontal" else (width, height)
        bands = []
        histogram = {}
        for means, variation in values:
            if variation <= 60:
                key = tuple(int(channel / 4) for channel in means)
                histogram[key] = histogram.get(key, 0) + 1
        dominant = tuple(channel * 4 for channel in max(histogram, key=histogram.get, default=(63, 63, 63)))
        min_thickness = max(4 if axis == "horizontal" else 3, length // 500)
        max_thickness = max(24, int(length * 0.025))
        def color_distance(left, right):
            return sum((left[channel] - right[channel]) ** 2 for channel in range(3)) ** 0.5
        def average_mean(start, end):
            if end <= start:
                return None
            return tuple(sum(values[index][0][channel] for index in range(start, end)) / (end - start)
                         for channel in range(3))
        def paired_contrast_coverage(band_start, band_end, context):
            middle_index = (band_start + band_end - 1) // 2
            before_index = max(0, band_start - context)
            after_index = min(length - 1, band_end + context - 1)
            contrasted = 0
            sampled = 0
            for offset in range(0, span, sample_step):
                before = image.getpixel((offset, before_index) if axis == "horizontal" else (before_index, offset))
                middle = image.getpixel((offset, middle_index) if axis == "horizontal" else (middle_index, offset))
                after = image.getpixel((offset, after_index) if axis == "horizontal" else (after_index, offset))
                if color_distance(before, after) <= 28 and min(
                        color_distance(middle, before), color_distance(middle, after)) >= 8:
                    contrasted += 1
                sampled += 1
            return contrasted / max(1, sampled)
        start = None
        for index in range(length + 1):
            matched = index < length and values[index][1] <= 60 and color_distance(values[index][0], dominant) >= 5
            if matched and start is None:
                start = index
            elif not matched and start is not None:
                thickness = index - start
                if min_thickness <= thickness <= max_thickness:
                    context = max(3, min_thickness * 2)
                    before = average_mean(max(0, start - context), start)
                    after = average_mean(index, min(length, index + context))
                    middle = average_mean(start, index)
                    if before is not None and after is not None and middle is not None:
                        side_distance = color_distance(before, after)
                        contrast = min(color_distance(middle, before), color_distance(middle, after))
                        coverage = paired_contrast_coverage(start, index, context)
                        side_limit = max(18, contrast * 0.8 + 8)
                        before_variation = sum(values[offset][1] for offset in range(max(0, start - context), start)) / context
                        after_variation = sum(values[offset][1] for offset in range(index, min(length, index + context))) / context
                        if contrast >= 10 and side_distance <= side_limit and coverage >= 0.65 and before_variation <= 60 and after_variation <= 60:
                            rect = ({"x": 0, "y": start, "width": width, "height": thickness}
                                    if axis == "horizontal" else
                                    {"x": start, "y": 0, "width": thickness, "height": height})
                            confidence = min(0.95, 0.65 + min(contrast / 255, 0.25))
                            bands.append({"orientation": axis, "confidence": confidence, "rect": rect})
                start = None
        return bands

    return collect("horizontal") + collect("vertical")


def build_ocr(PaddleOCR):
    language = os.environ.get("UIKG_PADDLE_OCR_LANG", "ch")
    device = os.environ.get("UIKG_PADDLE_OCR_DEVICE")
    options = {
        "lang": language,
        "use_doc_orientation_classify": False,
        "use_doc_unwarping": False,
        "use_textline_orientation": False,
    }
    if device:
        options["device"] = device
    try:
        return PaddleOCR(**options)
    except (TypeError, ValueError):
        legacy_options = {"lang": language, "use_angle_cls": False, "show_log": False}
        if device:
            legacy_options["use_gpu"] = device.lower().startswith("gpu")
        return PaddleOCR(**legacy_options)


def recognize(image_path):
    os.environ.setdefault("PADDLE_PDX_DISABLE_MODEL_SOURCE_CHECK", "True")
    with Image.open(image_path) as image:
        width, height = image.size
        separator_bands = detect_separator_bands(image)

    # Paddle libraries are verbose on stdout; keep stdout machine-readable for Node.
    with contextlib.redirect_stdout(io.StringIO()):
        from paddleocr import PaddleOCR

        ocr = build_ocr(PaddleOCR)
        if hasattr(ocr, "predict"):
            raw = list(ocr.predict(str(image_path)))
            observations = parse_v3_results(raw, width, height)
        else:
            raw = ocr.ocr(str(image_path), cls=False)
            observations = parse_v2_results(raw, width, height)

    return {
        "engine": "paddleocr",
        "coordinateSpace": "screenshot_px",
        "width": width,
        "height": height,
        "observations": observations,
        "separatorBands": separator_bands,
        "horizontalBands": [band for band in separator_bands if band["orientation"] == "horizontal"],
    }


def main():
    if len(sys.argv) != 2:
        raise SystemExit("usage: paddle-ocr.py IMAGE_PATH")
    image_path = Path(sys.argv[1])
    if not image_path.is_file():
        raise SystemExit(f"image does not exist: {image_path}")
    result = recognize(image_path)
    print(RESULT_MARKER + json.dumps(result, ensure_ascii=False, separators=(",", ":")))


if __name__ == "__main__":
    main()
