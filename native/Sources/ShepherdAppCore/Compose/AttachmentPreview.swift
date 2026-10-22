import CoreGraphics
import Foundation
import ImageIO
import UniformTypeIdentifiers

extension AttachmentModel.File {
    /// Whether the filename names an image type a preview can decode.
    public var isImage: Bool {
        UTType(filenameExtension: (name as NSString).pathExtension)?.conforms(to: .image) == true
    }

    /// A downscaled copy decoded off the caller's actor; nil when the bytes are not a readable image.
    public func thumbnail(maxPixelSize: Int) async -> CGImage? {
        let source = source
        return await Task.detached {
            let image: CGImageSource?
            switch source {
            case .data(let data): image = CGImageSourceCreateWithData(data as CFData, nil)
            case .url(let url):
                let scoped = url.startAccessingSecurityScopedResource()
                defer { if scoped { url.stopAccessingSecurityScopedResource() } }
                image = CGImageSourceCreateWithURL(url as CFURL, nil)
            }
            guard let image else { return nil }
            return CGImageSourceCreateThumbnailAtIndex(image, 0, [
                kCGImageSourceCreateThumbnailFromImageAlways: true,
                kCGImageSourceThumbnailMaxPixelSize: maxPixelSize,
                kCGImageSourceCreateThumbnailWithTransform: true
            ] as CFDictionary)
        }.value
    }
}
