// Generates an anti-aliased TFT_eSPI "smooth font" (VLW) as a C array from a
// TrueType/OpenType font, using macOS CoreText only (no other tools).
//
//   swift firmware/tools/make_vlw.swift <font.otf> <pixel size> <ascii|latin> <symbol> <out.h>
//
// "ascii" = U+0021–U+007E; "latin" also covers Latin-1 Supplement, Latin
// Extended-A (Czech, Slovak, Polish, …) and common punctuation (– — ‘ ’ “ ” … • €).
// The space is not stored: TFT_eSPI handles U+0020 itself.
//
// VLW layout (big-endian int32): glyph count, version, size, 0, ascent, descent;
// per glyph: unicode, height, width, xAdvance, dY (top above baseline), dX, 0;
// then the 8-bit alpha bitmaps in the same order.

import CoreGraphics
import CoreText
import Foundation

let args = CommandLine.arguments
guard args.count == 6, let size = Int(args[2]), size > 4, size < 120 else {
    FileHandle.standardError.write("usage: make_vlw.swift <font> <px> <ascii|latin> <symbol> <out.h>\n".data(using: .utf8)!)
    exit(2)
}
let fontURL = URL(fileURLWithPath: args[1])
let charset = args[3]
let symbol = args[4]
let outPath = args[5]

guard let provider = CGDataProvider(url: fontURL as CFURL), let cgFont = CGFont(provider) else {
    FileHandle.standardError.write("cannot read font\n".data(using: .utf8)!)
    exit(1)
}
let font = CTFontCreateWithGraphicsFont(cgFont, CGFloat(size), nil, nil)

var codepoints: [UInt32] = Array(0x21...0x7E)
if charset == "latin" {
    codepoints += Array(0xA1...0x17F).filter { $0 != 0xAD }
    codepoints += [0x2013, 0x2014, 0x2018, 0x2019, 0x201A, 0x201C, 0x201D, 0x201E, 0x2022, 0x2026, 0x20AC, 0x2192, 0x2190]
} else if charset != "ascii" {
    FileHandle.standardError.write("charset must be ascii or latin\n".data(using: .utf8)!)
    exit(2)
}

struct Glyph {
    let unicode: UInt32
    let width: Int
    let height: Int
    let advance: Int
    let dY: Int
    let dX: Int
    let bitmap: [UInt8]
}

func render(_ cp: UInt32) -> Glyph? {
    var chars = [UniChar(cp)]
    var glyph: CGGlyph = 0
    guard CTFontGetGlyphsForCharacters(font, &chars, &glyph, 1), glyph != 0 else { return nil }
    var rect = CGRect.zero
    CTFontGetBoundingRectsForGlyphs(font, .horizontal, &glyph, &rect, 1)
    var advance = CGSize.zero
    CTFontGetAdvancesForGlyphs(font, .horizontal, &glyph, &advance, 1)
    let left = Int(floor(rect.minX)) - 1
    let right = Int(ceil(rect.maxX)) + 1
    let bottom = Int(floor(rect.minY)) - 1
    let top = Int(ceil(rect.maxY)) + 1
    let width = max(1, right - left)
    let height = max(1, top - bottom)
    guard width < 256, height < 256 else { return nil }
    var pixels = [UInt8](repeating: 0, count: width * height)
    let space = CGColorSpaceCreateDeviceGray()
    pixels.withUnsafeMutableBytes { buffer in
        guard let ctx = CGContext(data: buffer.baseAddress, width: width, height: height, bitsPerComponent: 8,
                                  bytesPerRow: width, space: space, bitmapInfo: CGImageAlphaInfo.none.rawValue) else { return }
        ctx.setAllowsAntialiasing(true)
        ctx.setShouldAntialias(true)
        ctx.setAllowsFontSmoothing(false)
        ctx.setShouldSmoothFonts(false)
        ctx.setFillColor(gray: 0, alpha: 1)
        ctx.fill(CGRect(x: 0, y: 0, width: width, height: height))
        ctx.setFillColor(gray: 1, alpha: 1)
        var position = CGPoint(x: CGFloat(-left), y: CGFloat(-bottom))
        CTFontDrawGlyphs(font, &glyph, &position, 1, ctx)
    }
    // Trim empty rows and columns so the stored bitmap is tight.
    var minX = width, maxX = -1, minY = height, maxY = -1
    for y in 0..<height { for x in 0..<width where pixels[y * width + x] > 0 {
        minX = min(minX, x); maxX = max(maxX, x); minY = min(minY, y); maxY = max(maxY, y)
    } }
    if maxX < 0 { return Glyph(unicode: cp, width: 0, height: 0, advance: Int(advance.width.rounded()), dY: 0, dX: 0, bitmap: []) }
    let w = maxX - minX + 1, h = maxY - minY + 1
    var tight = [UInt8](); tight.reserveCapacity(w * h)
    for y in minY...maxY { tight.append(contentsOf: pixels[(y * width + minX)...(y * width + maxX)]) }
    // Row 0 of the bitmap is the top: its baseline offset is top - minY.
    return Glyph(unicode: cp, width: w, height: h, advance: Int(advance.width.rounded()), dY: top - minY, dX: left + minX, bitmap: tight)
}

let glyphs = codepoints.compactMap(render)
var data = Data()
func put(_ value: Int) { var v = Int32(value).bigEndian; data.append(Data(bytes: &v, count: 4)) }
put(glyphs.count); put(11); put(size); put(0)
put(Int(CTFontGetAscent(font).rounded())); put(Int(CTFontGetDescent(font).rounded()))
for g in glyphs { put(Int(g.unicode)); put(g.height); put(g.width); put(g.advance); put(g.dY); put(g.dX); put(0) }
for g in glyphs { data.append(contentsOf: g.bitmap) }

let copyright = (CTFontCopyName(font, kCTFontCopyrightNameKey) as String?) ?? ""
let fullName = (CTFontCopyName(font, kCTFontFullNameKey) as String?) ?? ""
var out = "// \(fullName), \(size) px, \(charset), \(glyphs.count) glyphs. Generated by firmware/tools/make_vlw.swift.\n"
out += "// \(copyright)\n// Licensed under the SIL Open Font License 1.1 – see fonts/OFL.txt.\n#pragma once\n#include <pgmspace.h>\n\n"
out += "const uint8_t \(symbol)[] PROGMEM = {\n"
let bytes = [UInt8](data)
for start in stride(from: 0, to: bytes.count, by: 20) {
    out += "  " + bytes[start..<min(bytes.count, start + 20)].map { String(format: "0x%02x", $0) }.joined(separator: ",") + ",\n"
}
out += "};\n"
try! out.write(toFile: outPath, atomically: true, encoding: .utf8)
print("\(symbol): \(glyphs.count) glyphs, \(bytes.count) bytes")
