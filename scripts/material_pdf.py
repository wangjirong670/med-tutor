"""Local PDF extraction only. JSON output; no network or model calls."""
import json
import sys
import pdfplumber

path = sys.argv[1]
with pdfplumber.open(path) as pdf:
    if len(sys.argv) == 2:
        print(json.dumps({'pages': len(pdf.pages)}))
    else:
        page = pdf.pages[int(sys.argv[2]) - 1]
        text = page.extract_text(layout=False) or ''
        area = page.width * page.height
        image_area = sum(max(0, min(i['x1'], page.width)-max(i['x0'], 0)) * max(0, min(i['bottom'], page.height)-max(i['top'], 0)) for i in page.images)
        print(json.dumps({'text': text, 'hasRaster': bool(page.images), 'rasterCoverage': image_area / area, 'width': page.width, 'height': page.height}, ensure_ascii=True))
