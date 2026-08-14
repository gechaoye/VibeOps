#!/usr/bin/env python3

import sys
from pathlib import Path

from PIL import Image, ImageDraw


def main() -> None:
    source = Path(sys.argv[1])
    destination = Path(sys.argv[2])
    with Image.open(source) as original:
        image = original.convert("RGB")
    if len(sys.argv) == 3:
        destination.parent.mkdir(parents=True, exist_ok=True)
        image.save(destination, format="PNG", optimize=True)
        return
    left, top, width, height = (float(value) for value in sys.argv[3:7])
    x0 = max(0, min(image.width - 1, round(left)))
    y0 = max(0, min(image.height - 1, round(top)))
    x1 = max(x0 + 1, min(image.width, round(left + width)))
    y1 = max(y0 + 1, min(image.height, round(top + height)))
    ImageDraw.Draw(image).rectangle((x0, y0, x1 - 1, y1 - 1), outline=(255, 0, 0), width=6)
    destination.parent.mkdir(parents=True, exist_ok=True)
    image.save(destination, format="PNG", optimize=True)


if __name__ == "__main__":
    main()
