"""Write point-cloud numbers to a compact binary file and keep descriptive metadata in JSON."""
import json
import math
import struct
import time
import uuid
from pathlib import Path


def _as_four_floats(values, label):
    if len(values) != 4:
        raise ValueError(f"{label}は4個の数値である必要があります。")
    result = tuple(float(value) for value in values)
    if not all(math.isfinite(value) and abs(value) <= 3.402823466e38 for value in result):
        raise ValueError(f"{label}にfloat32で保存できない値があります。")
    return result


def _point_position(point):
    if isinstance(point, dict):
        return point.get("position", [0.0, 0.0, 0.0, 0.0])
    return point


def _point_normal(point):
    if isinstance(point, dict):
        return point.get("normal", [0.0, 0.0, 0.0, 0.0])
    return [0.0, 0.0, 0.0, 0.0]


def _is_valid(point):
    return not isinstance(point, dict) or point.get("valid", True) is not False


def write_binary_bundle(data, metadata_path, binary_base_path):
    """Write planar float32 arrays, validity bytes, and JSON metadata.

    Binary layout (little-endian): positions, normals, valid flags, padding, critical-line positions.
    The metadata references a uniquely named binary file; this avoids replacing a file
    that the browser or a sync service may still have open.
    """
    metadata_path = Path(metadata_path)
    binary_base_path = Path(binary_base_path)
    points = data.get("points", [])
    critical_line = data.get("criticalLine", [])
    count = len(points)
    line_count = len(critical_line)
    position_offset = 0
    normal_offset = count * 16
    validity_offset = count * 32
    critical_offset = (validity_offset + count + 3) & ~3
    timestamp = time.strftime("%Y%m%d_%H%M%S")
    binary_path = binary_base_path.with_name(
        f"{binary_base_path.stem}_{timestamp}_{uuid.uuid4().hex[:8]}{binary_base_path.suffix}"
    )
    progress_total = max(1, count * 3 + line_count)
    progress_done = 0
    last_progress = 0.0

    def progress(force=False):
        nonlocal last_progress
        now = time.monotonic()
        if not force and now - last_progress < 0.2 and progress_done < progress_total:
            return
        last_progress = now
        ratio = min(1.0, progress_done / progress_total)
        width = 28
        filled = int(width * ratio)
        message = f"バイナリを書き込み中 [{'=' * filled}{' ' * (width - filled)}] {ratio * 100:5.1f}% {progress_done:,}/{progress_total:,}"
        print("\r" + message, end="\n" if ratio >= 1.0 else "", flush=True)

    try:
        with binary_path.open("xb") as output:
            for point in points:
                output.write(struct.pack("<4f", *_as_four_floats(_point_position(point), "位置")))
                progress_done += 1
                progress()
            for point in points:
                output.write(struct.pack("<4f", *_as_four_floats(_point_normal(point), "法線")))
                progress_done += 1
                progress()
            output.write(bytes(1 if _is_valid(point) else 0 for point in points))
            progress_done += count
            progress()
            padding = critical_offset - (validity_offset + count)
            if padding:
                output.write(bytes(padding))
            for point in critical_line:
                output.write(struct.pack("<4f", *_as_four_floats(point, "臨界線座標")))
                progress_done += 1
                progress()
            output.flush()
        progress(force=True)

        metadata = {
            key: value for key, value in data.items()
            if key not in ("points", "criticalLine")
        }
        metadata["dataFormat"] = "4d-point-cloud-binary-v1"
        metadata["pointCount"] = count
        metadata["criticalLineCount"] = line_count
        metadata["binary"] = {
            "file": binary_path.name,
            "byteOrder": "little-endian",
            "floatType": "float32",
            "positionsOffset": position_offset,
            "normalsOffset": normal_offset,
            "validityOffset": validity_offset,
            "criticalLineOffset": critical_offset,
            "pointCount": count,
            "criticalLineCount": line_count,
        }
        temporary_metadata = metadata_path.with_suffix(metadata_path.suffix + ".tmp")
        with temporary_metadata.open("w", encoding="utf-8", newline="") as output:
            json.dump(metadata, output, ensure_ascii=False, separators=(",", ":"))
            output.flush()
        try:
            temporary_metadata.replace(metadata_path)
        except PermissionError:
            metadata_path.write_text(temporary_metadata.read_text(encoding="utf-8"), encoding="utf-8")
            temporary_metadata.unlink(missing_ok=True)
    except Exception:
        binary_path.unlink(missing_ok=True)
        metadata_path.with_suffix(metadata_path.suffix + ".tmp").unlink(missing_ok=True)
        raise

    return count, line_count, binary_path