// Source for the installer artwork. Uses only macOS AppKit/CoreGraphics.
import AppKit

let output = URL(fileURLWithPath: CommandLine.arguments[1], isDirectory: true)
try FileManager.default.createDirectory(at: output, withIntermediateDirectories: true)
for scale in [1, 2] {
    let bitmap = NSBitmapImageRep(
        bitmapDataPlanes: nil, pixelsWide: 660 * scale, pixelsHigh: 400 * scale,
        bitsPerSample: 8, samplesPerPixel: 4, hasAlpha: true, isPlanar: false,
        colorSpaceName: .deviceRGB, bytesPerRow: 0, bitsPerPixel: 0)!
    bitmap.size = NSSize(width: 660, height: 400)
    NSGraphicsContext.saveGraphicsState()
    NSGraphicsContext.current = NSGraphicsContext(bitmapImageRep: bitmap)
    // bitmap.size makes AppKit scale drawing from points to pixels at 2x.
    NSColor(srgbRed: 15/255, green: 20/255, blue: 19/255, alpha: 1).setFill()
    NSBezierPath(rect: NSRect(x: 0, y: 0, width: 660, height: 400)).fill()

    func text(_ string: String, y: CGFloat, size: CGFloat, color: NSColor,
              weight: NSFont.Weight = .regular) {
        let attributes: [NSAttributedString.Key: Any] = [
            .font: NSFont.systemFont(ofSize: size, weight: weight), .foregroundColor: color
        ]
        let line = NSString(string: string)
        let width = line.size(withAttributes: attributes).width
        line.draw(at: NSPoint(x: (660 - width) / 2, y: y), withAttributes: attributes)
    }
    let white = NSColor(srgbRed: 233/255, green: 241/255, blue: 236/255, alpha: 1)
    let muted = NSColor(srgbRed: 154/255, green: 174/255, blue: 164/255, alpha: 1)

    // Finder uses black filenames over image backgrounds, even in dark mode.
    // Quiet label backplates preserve contrast without altering signed bundles.
    NSColor(srgbRed: 200/255, green: 212/255, blue: 206/255, alpha: 1).setFill()
    for x in [170, 490] {
        NSBezierPath(roundedRect: NSRect(x: x - 80, y: 134, width: 160, height: 30),
                     xRadius: 15, yRadius: 15).fill()
    }

    // Finder's icon centres are (170, 165) and (490, 165), from the top.
    // AppKit artwork coordinates start at the bottom of the 400pt background.
    let arrow = NSBezierPath()
    arrow.move(to: NSPoint(x: 285, y: 235))
    arrow.line(to: NSPoint(x: 375, y: 235))
    arrow.move(to: NSPoint(x: 360, y: 250))
    arrow.line(to: NSPoint(x: 375, y: 235))
    arrow.line(to: NSPoint(x: 360, y: 220))
    arrow.lineWidth = 3
    arrow.lineCapStyle = .round
    arrow.lineJoinStyle = .round
    NSColor(srgbRed: 232/255, green: 161/255, blue: 58/255, alpha: 1).setStroke()
    arrow.stroke()

    // Captions begin near y=278/300 from the top, with space below the
    // 30pt filename backplates and clear of Finder's path bar, which a global
    // user preference can show despite the DMG settings.
    text("Drag Shepherd to Applications to install", y: 102, size: 14, color: white)
    text("Zum Installieren auf Programme ziehen", y: 80, size: 12, color: muted)
    NSGraphicsContext.restoreGraphicsState()
    let name = scale == 1 ? "background.png" : "background@2x.png"
    try bitmap.representation(using: .png, properties: [:])!.write(to: output.appendingPathComponent(name))
}
