import CoreGraphics
import Foundation
import ImageIO
import Testing
import UniformTypeIdentifiers
@testable import ShepherdAppCore

extension CoreSeamTests {
@Suite struct AttachmentPreviewTests {
    static func png(width: Int, height: Int) throws -> Data {
        let space = CGColorSpaceCreateDeviceRGB()
        let context = try #require(CGContext(data: nil, width: width, height: height, bitsPerComponent: 8, bytesPerRow: 0,
                                             space: space, bitmapInfo: CGImageAlphaInfo.premultipliedLast.rawValue))
        context.setFillColor(CGColor(red: 1, green: 0, blue: 0, alpha: 1))
        context.fill(CGRect(x: 0, y: 0, width: width, height: height))
        let image = try #require(context.makeImage())
        let data = NSMutableData()
        let sink = try #require(CGImageDestinationCreateWithData(data, UTType.png.identifier as CFString, 1, nil))
        CGImageDestinationAddImage(sink, image, nil)
        #expect(CGImageDestinationFinalize(sink))
        return data as Data
    }

    @Test func imageBytesScaleDownToTheRequestedSize() async throws {
        let file = AttachmentModel.File(name: "shot.png", data: try Self.png(width: 400, height: 200))
        #expect(file.isImage)
        let thumbnail = try #require(await file.thumbnail(maxPixelSize: 100))
        #expect(thumbnail.width == 100 && thumbnail.height == 50)
    }

    @Test func fileURLsDecodeTheSameWay() async throws {
        let url = FileManager.default.temporaryDirectory.appendingPathComponent("preview-\(UUID()).png")
        try Self.png(width: 20, height: 40).write(to: url)
        defer { try? FileManager.default.removeItem(at: url) }
        let file = AttachmentModel.File(url: url)
        #expect(file.isImage)
        let thumbnail = try #require(await file.thumbnail(maxPixelSize: 400))
        #expect(thumbnail.width == 20 && thumbnail.height == 40)
    }

    @Test func textAndUnreadableBytesHaveNoPreview() async {
        let text = AttachmentModel.File(name: "notes.txt", data: Data("hello".utf8))
        #expect(!text.isImage)
        #expect(await text.thumbnail(maxPixelSize: 100) == nil)
        let broken = AttachmentModel.File(name: "broken.png", data: Data([0x89, 0x50, 0x4E, 0x47]))
        #expect(broken.isImage)
        #expect(await broken.thumbnail(maxPixelSize: 100) == nil)
    }
}
}
