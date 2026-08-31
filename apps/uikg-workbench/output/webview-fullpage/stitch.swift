import AppKit
import Foundation

struct Chunk: Decodable {
    let path: String
    let scrollTop: Int
}

struct Setup: Decodable {
    let scrollHeight: Int
    let clientHeight: Int
    let dpr: Int
}

struct Manifest: Decodable {
    let setup: Setup
    let chunks: [Chunk]
}

guard CommandLine.arguments.count == 4 || CommandLine.arguments.count == 6 else {
    fatalError("usage: stitch.swift <workspace> <manifest> <output> [device-screenshot header-height]")
}

let workspace = URL(fileURLWithPath: CommandLine.arguments[1])
let manifestURL = workspace.appendingPathComponent(CommandLine.arguments[2])
let outputURL = workspace.appendingPathComponent(CommandLine.arguments[3])
let headerImageURL = CommandLine.arguments.count == 6
    ? URL(fileURLWithPath: CommandLine.arguments[4])
    : nil
let headerHeight = CommandLine.arguments.count == 6 ? Int(CommandLine.arguments[5])! : 0
let manifest = try JSONDecoder().decode(Manifest.self, from: Data(contentsOf: manifestURL))
guard let first = manifest.chunks.first,
      let firstImage = NSImage(contentsOf: workspace.appendingPathComponent(first.path)),
      let firstRep = firstImage.cgImage(forProposedRect: nil, context: nil, hints: nil) else {
    fatalError("cannot read first chunk")
}

let scale = manifest.setup.dpr
let outputWidth = firstRep.width
let contentHeight = manifest.setup.scrollHeight * scale
let outputHeight = headerHeight + contentHeight
guard let context = CGContext(
    data: nil,
    width: outputWidth,
    height: outputHeight,
    bitsPerComponent: 8,
    bytesPerRow: 0,
    space: CGColorSpaceCreateDeviceRGB(),
    bitmapInfo: CGImageAlphaInfo.premultipliedLast.rawValue
) else { fatalError("cannot create image context") }

context.setFillColor(NSColor.white.cgColor)
context.fill(CGRect(x: 0, y: 0, width: outputWidth, height: outputHeight))

for (index, chunk) in manifest.chunks.enumerated() {
    let url = workspace.appendingPathComponent(chunk.path)
    guard let image = NSImage(contentsOf: url),
          let source = image.cgImage(forProposedRect: nil, context: nil, hints: nil) else {
        fatalError("cannot read \(chunk.path)")
    }
    let nextTop = index + 1 < manifest.chunks.count
        ? manifest.chunks[index + 1].scrollTop
        : manifest.setup.scrollHeight
    let contentHeight = min(manifest.setup.clientHeight, nextTop - chunk.scrollTop)
    let cropHeight = contentHeight * scale
    // CGImage cropping coordinates follow the image's top-left raster origin.
    guard let crop = source.cropping(to: CGRect(
        x: 0,
        y: 0,
        width: min(outputWidth, source.width),
        height: cropHeight
    )) else { fatalError("cannot crop \(chunk.path)") }
    let destinationY = outputHeight - headerHeight - ((chunk.scrollTop + contentHeight) * scale)
    context.draw(crop, in: CGRect(x: 0, y: destinationY, width: outputWidth, height: cropHeight))
}

if let headerImageURL,
   let headerImage = NSImage(contentsOf: headerImageURL),
   let headerSource = headerImage.cgImage(forProposedRect: nil, context: nil, hints: nil),
   let headerCrop = headerSource.cropping(to: CGRect(x: 0, y: 0, width: outputWidth, height: headerHeight)) {
    context.draw(headerCrop, in: CGRect(x: 0, y: contentHeight, width: outputWidth, height: headerHeight))
}

guard let result = context.makeImage() else { fatalError("cannot create result") }
let bitmap = NSBitmapImageRep(cgImage: result)
guard let png = bitmap.representation(using: .png, properties: [:]) else {
    fatalError("cannot encode PNG")
}
try png.write(to: outputURL)
print("\(outputWidth)x\(outputHeight) \(png.count) bytes")
