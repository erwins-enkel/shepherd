import Foundation

/// Matches ui/src/lib/wav.ts: linear resampling, mono PCM16 and a 44-byte RIFF header.
public enum DictationWAV {
    public static func encode(_ samples: [Float], inputRate: Double) -> Data {
        precondition(inputRate.isFinite && inputRate > 0)
        let ratio = inputRate / 16_000
        let count = Int(Double(samples.count) / ratio)
        var data = Data()
        func ascii(_ value: String) { data.append(contentsOf: value.utf8) }
        func word<T: FixedWidthInteger>(_ value: T) { var little = value.littleEndian; withUnsafeBytes(of: &little) { data.append(contentsOf: $0) } }
        ascii("RIFF"); word(UInt32(36 + count * 2)); ascii("WAVEfmt ")
        word(UInt32(16)); word(UInt16(1)); word(UInt16(1)); word(UInt32(16_000))
        word(UInt32(32_000)); word(UInt16(2)); word(UInt16(16)); ascii("data"); word(UInt32(count * 2))
        for index in 0..<count {
            let position = Double(index) * ratio, left = Int(position), right = min(left + 1, samples.count - 1)
            let fraction = Float(position - Double(left))
            let value = max(-1, min(1, samples[left] * (1 - fraction) + samples[right] * fraction))
            word(Int16(value < 0 ? value * 32768 : value * 32767))
        }
        return data
    }
}
