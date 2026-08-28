import Foundation
import Vision
import ImageIO

struct Rect: Codable {
    let x: Double
    let y: Double
    let width: Double
    let height: Double
}

struct Observation: Codable {
    let text: String
    let confidence: Float
    let rect: Rect
}

struct RectangleObservation: Codable {
    let confidence: Float
    let rect: Rect
}

struct SeparatorObservation: Codable {
    let orientation: String
    let confidence: Float
    let rect: Rect
}

struct Result: Codable {
    let engine: String
    let coordinateSpace: String
    let width: Int
    let height: Int
    let observations: [Observation]
    let rectangles: [RectangleObservation]
    let separatorBands: [SeparatorObservation]
    let horizontalBands: [RectangleObservation]
}

guard CommandLine.arguments.count >= 2 else {
    FileHandle.standardError.write(Data("missing image path\n".utf8))
    exit(2)
}

let url = URL(fileURLWithPath: CommandLine.arguments[1])
guard let source = CGImageSourceCreateWithURL(url as CFURL, nil),
      let image = CGImageSourceCreateImageAtIndex(source, 0, nil) else {
    FileHandle.standardError.write(Data("unable to decode image\n".utf8))
    exit(3)
}

// A WebView often has no inspectable child nodes. Recover repeated blocks from
// thin, long visual boundaries. Detection is based on local contrast and low
// variation along the line, so it does not assume a particular color or axis.
func detectSeparatorBands(_ image: CGImage) -> [SeparatorObservation] {
    let width = image.width
    let height = image.height
    let bytesPerPixel = 4
    let colorSpace = CGColorSpaceCreateDeviceRGB()
    var pixels = Array(repeating: UInt8(0), count: width * height * bytesPerPixel)
    guard let context = CGContext(
        data: &pixels,
        width: width,
        height: height,
        bitsPerComponent: 8,
        bytesPerRow: width * bytesPerPixel,
        space: colorSpace,
        bitmapInfo: CGImageAlphaInfo.premultipliedLast.rawValue
    ) else { return [] }
    context.draw(image, in: CGRect(x: 0, y: 0, width: width, height: height))

    func collect(_ orientation: String) -> [SeparatorObservation] {
        let lineCount = orientation == "horizontal" ? height : width
        let span = orientation == "horizontal" ? width : height
        let step = max(4, span / 120)
        var means = Array(repeating: (0.0, 0.0, 0.0), count: lineCount)
        var variations = Array(repeating: 0.0, count: lineCount)
        for line in 0..<lineCount {
            var sums = (0.0, 0.0, 0.0)
            var count = 0.0
            for offset in stride(from: 0, to: span, by: step) {
                let x = orientation == "horizontal" ? offset : line
                let y = orientation == "horizontal" ? line : offset
                let pixelOffset = (y * width + x) * bytesPerPixel
                sums.0 += Double(pixels[pixelOffset])
                sums.1 += Double(pixels[pixelOffset + 1])
                sums.2 += Double(pixels[pixelOffset + 2])
                count += 1
            }
            means[line] = (sums.0 / count, sums.1 / count, sums.2 / count)
            var variation = 0.0
            for offset in stride(from: 0, to: span, by: step) {
                let x = orientation == "horizontal" ? offset : line
                let y = orientation == "horizontal" ? line : offset
                let pixelOffset = (y * width + x) * bytesPerPixel
                variation += abs(Double(pixels[pixelOffset]) - means[line].0)
                    + abs(Double(pixels[pixelOffset + 1]) - means[line].1)
                    + abs(Double(pixels[pixelOffset + 2]) - means[line].2)
            }
            variations[line] = variation / count
        }
        var bands: [SeparatorObservation] = []
        var histogram: [String: Int] = [:]
        for line in 0..<lineCount where variations[line] <= 60 {
            let key = "\(Int(means[line].0 / 4)):\(Int(means[line].1 / 4)):\(Int(means[line].2 / 4))"
            histogram[key, default: 0] += 1
        }
        let dominantKey = histogram.max { $0.value < $1.value }?.key.split(separator: ":").map { Double($0)! * 4 } ?? [255, 255, 255]
        let dominant = (dominantKey[0], dominantKey[1], dominantKey[2])
        func colorDistance(_ left: (Double, Double, Double), _ right: (Double, Double, Double)) -> Double {
            sqrt(pow(left.0 - right.0, 2) + pow(left.1 - right.1, 2) + pow(left.2 - right.2, 2))
        }
        let minThickness = orientation == "horizontal" ? max(4, lineCount / 500) : max(3, lineCount / 500)
        let maxThickness = max(24, Int(Double(lineCount) * 0.025))
        var start: Int? = nil
        func averageMean(_ range: Range<Int>) -> (Double, Double, Double)? {
            guard !range.isEmpty else { return nil }
            var total = (0.0, 0.0, 0.0)
            for index in range {
                total.0 += means[index].0
                total.1 += means[index].1
                total.2 += means[index].2
            }
            let count = Double(range.count)
            return (total.0 / count, total.1 / count, total.2 / count)
        }
        func pairedContrastCoverage(_ bandStart: Int, _ bandEnd: Int, _ context: Int) -> Double {
            let middleLine = (bandStart + bandEnd - 1) / 2
            let beforeLine = max(0, bandStart - context)
            let afterLine = min(lineCount - 1, bandEnd + context - 1)
            var contrasted = 0
            var sampled = 0
            for offset in stride(from: 0, to: span, by: step) {
                func color(_ line: Int) -> (Double, Double, Double) {
                    let x = orientation == "horizontal" ? offset : line
                    let y = orientation == "horizontal" ? line : offset
                    let pixelOffset = (y * width + x) * bytesPerPixel
                    return (Double(pixels[pixelOffset]), Double(pixels[pixelOffset + 1]), Double(pixels[pixelOffset + 2]))
                }
                let before = color(beforeLine)
                let middle = color(middleLine)
                let after = color(afterLine)
                if colorDistance(before, after) <= 28
                    && min(colorDistance(middle, before), colorDistance(middle, after)) >= 8 {
                    contrasted += 1
                }
                sampled += 1
            }
            return sampled > 0 ? Double(contrasted) / Double(sampled) : 0
        }
        for line in 0...lineCount {
            let matched = line < lineCount && variations[line] <= 60 && colorDistance(means[line], dominant) >= 5
            if matched {
                if start == nil { start = line }
            } else if let bandStart = start {
                let thickness = line - bandStart
                if thickness >= minThickness && thickness <= maxThickness {
                    let context = max(3, minThickness * 2)
                    let before = averageMean(max(0, bandStart - context)..<bandStart)
                    let after = averageMean(line..<min(lineCount, line + context))
                    let middle = averageMean(bandStart..<line)
                    if let before, let after, let middle {
                        let sideDistance = colorDistance(before, after)
                        let contrast = min(colorDistance(middle, before), colorDistance(middle, after))
                        let coverage = pairedContrastCoverage(bandStart, line, context)
                        let sideLimit = max(18, contrast * 0.8 + 8)
                        let beforeVariation = (max(0, bandStart - context)..<bandStart)
                            .map { variations[$0] }.reduce(0, +) / Double(context)
                        let afterVariation = (line..<min(lineCount, line + context))
                            .map { variations[$0] }.reduce(0, +) / Double(context)
                        let rect = orientation == "horizontal"
                            ? Rect(x: 0, y: Double(bandStart), width: Double(width), height: Double(thickness))
                            : Rect(x: Double(bandStart), y: 0, width: Double(thickness), height: Double(height))
                        if contrast >= 10 && sideDistance <= sideLimit && coverage >= 0.65
                            && beforeVariation <= 60 && afterVariation <= 60 {
                            let confidence = min(0.95, 0.65 + min(contrast / 255, 0.25))
                            bands.append(SeparatorObservation(orientation: orientation, confidence: Float(confidence), rect: rect))
                        }
                    }
                }
                start = nil
            }
        }
        var merged: [SeparatorObservation] = []
        for band in bands {
            if let previous = merged.last {
                let previousEnd = orientation == "horizontal"
                    ? previous.rect.y + previous.rect.height
                    : previous.rect.x + previous.rect.width
                let currentStart = orientation == "horizontal" ? band.rect.y : band.rect.x
                if currentStart - previousEnd <= 6 {
                    let mergedRect = orientation == "horizontal"
                        ? Rect(x: 0, y: previous.rect.y, width: Double(width), height: band.rect.y + band.rect.height - previous.rect.y)
                        : Rect(x: previous.rect.x, y: 0, width: band.rect.x + band.rect.width - previous.rect.x, height: Double(height))
                    merged[merged.count - 1] = SeparatorObservation(orientation: orientation, confidence: max(previous.confidence, band.confidence), rect: mergedRect)
                    continue
                }
            }
            merged.append(band)
        }
        return merged
    }
    return collect("horizontal") + collect("vertical")
}

let request = VNRecognizeTextRequest()
request.recognitionLevel = .accurate
request.usesLanguageCorrection = true
request.recognitionLanguages = ["zh-Hans", "en-US"]
request.minimumTextHeight = 0.006
let rectangleRequest = VNDetectRectanglesRequest()
rectangleRequest.maximumObservations = 30
rectangleRequest.minimumAspectRatio = 0.25
rectangleRequest.maximumAspectRatio = 1.0
rectangleRequest.minimumSize = 0.04
rectangleRequest.minimumConfidence = 0.35
rectangleRequest.quadratureTolerance = 12

do {
    try VNImageRequestHandler(cgImage: image, orientation: .up).perform([request, rectangleRequest])
    let width = image.width
    let height = image.height
    let observations = (request.results ?? []).compactMap { item -> Observation? in
        guard let candidate = item.topCandidates(1).first else { return nil }
        let box = item.boundingBox
        return Observation(
            text: candidate.string,
            confidence: candidate.confidence,
            rect: Rect(
                x: box.origin.x * Double(width),
                y: (1.0 - box.origin.y - box.height) * Double(height),
                width: box.width * Double(width),
                height: box.height * Double(height)
            )
        )
    }
    let rectangles = (rectangleRequest.results ?? []).map { item in
        let box = item.boundingBox
        return RectangleObservation(
            confidence: item.confidence,
            rect: Rect(
                x: box.origin.x * Double(width),
                y: (1.0 - box.origin.y - box.height) * Double(height),
                width: box.width * Double(width),
                height: box.height * Double(height)
            )
        )
    }
    let separatorBands = detectSeparatorBands(image)
    let result = Result(
        engine: "apple-vision",
        coordinateSpace: "screenshot_px",
        width: width,
        height: height,
        observations: observations,
        rectangles: rectangles,
        separatorBands: separatorBands,
        horizontalBands: separatorBands.filter { $0.orientation == "horizontal" }.map {
            RectangleObservation(confidence: $0.confidence, rect: $0.rect)
        }
    )
    let encoder = JSONEncoder()
    encoder.outputFormatting = [.sortedKeys]
    FileHandle.standardOutput.write(try encoder.encode(result))
} catch {
    FileHandle.standardError.write(Data("\(error)\n".utf8))
    exit(4)
}
