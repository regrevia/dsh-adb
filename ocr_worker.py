"""macOS Vision 文本识别常驻进程：stdin 一行一个图片路径，stdout 一行一个 JSON。

不上传、不联网。空闲由 Node 侧杀掉，这里只管读一行答一行。
"""

import json
import sys

import Vision
from Quartz import (
    CGImageSourceCreateImageAtIndex,
    CGImageSourceCreateWithURL,
    CGImageGetHeight,
    CGImageGetWidth,
)
from Foundation import NSURL


def recognize(path):
    src = CGImageSourceCreateWithURL(NSURL.fileURLWithPath_(path), None)
    if src is None:
        raise ValueError("图片读不出来")
    image = CGImageSourceCreateImageAtIndex(src, 0, None)
    if image is None:
        raise ValueError("图片解码失败")
    request = Vision.VNRecognizeTextRequest.alloc().init()
    request.setRecognitionLevel_(Vision.VNRequestTextRecognitionLevelAccurate)
    request.setUsesLanguageCorrection_(False)
    request.setRecognitionLanguages_(["zh-Hans", "en-US"])
    handler = Vision.VNImageRequestHandler.alloc().initWithCGImage_options_(image, None)
    handler.performRequests_error_([request], None)
    blocks = []
    for observation in request.results() or []:
        candidates = observation.topCandidates_(1)
        if not candidates:
            continue
        candidate = candidates[0]
        box = observation.boundingBox()
        blocks.append(
            {
                "text": str(candidate.string()),
                "conf": round(float(candidate.confidence()), 3),
                "x": round(float(box.origin.x), 5),
                "y": round(float(box.origin.y), 5),
                "w": round(float(box.size.width), 5),
                "h": round(float(box.size.height), 5),
            }
        )
    return blocks, CGImageGetWidth(image), CGImageGetHeight(image)


def main():
    print(json.dumps({"ready": True}), flush=True)
    for line in sys.stdin:
        path = line.strip()
        if not path:
            continue
        if path == "quit":
            break
        try:
            blocks, width, height = recognize(path)
            print(
                json.dumps({"path": path, "blocks": blocks, "w": width, "h": height}, ensure_ascii=False),
                flush=True,
            )
        except Exception as exc:  # noqa: BLE001 - 出错也要答一行，不能卡住调用方
            print(json.dumps({"path": path, "error": str(exc)[:200]}, ensure_ascii=False), flush=True)


if __name__ == "__main__":
    main()
