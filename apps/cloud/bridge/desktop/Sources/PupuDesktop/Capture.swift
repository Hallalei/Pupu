import CoreGraphics
import CoreMedia
import CoreVideo
import Foundation
import ScreenCaptureKit

/// 画面来源：真实屏幕，或者测试画面。拿到一帧就交给 deliver（像素缓冲、单调时间戳纳秒）。
protocol FrameSource: AnyObject {
  func start(_ done: @escaping (_ width: Int, _ height: Int, _ error: String?) -> Void)
  func stop()
}

private func monotonicNs() -> Int64 {
  Int64(DispatchTime.now().uptimeNanoseconds)
}

private func nowMs() -> Double {
  Date().timeIntervalSince1970 * 1000
}

/// 在画面左上角写一排黑白方块：先一白一黑做定位，再是 41 位毫秒时间戳（高位在前）。
/// 看画面的一端按同样的格子读回来，减去时钟差，就是从截屏到显示的延迟。
enum Stamp {
  static let block = 16
  static let bits = 41

  static func write(into buffer: CVPixelBuffer, ms: Double) {
    guard CVPixelBufferGetPlaneCount(buffer) == 2 else { return }
    CVPixelBufferLockBaseAddress(buffer, [])
    defer { CVPixelBufferUnlockBaseAddress(buffer, []) }
    guard let luma = CVPixelBufferGetBaseAddressOfPlane(buffer, 0),
          let chroma = CVPixelBufferGetBaseAddressOfPlane(buffer, 1)
    else { return }
    let lumaStride = CVPixelBufferGetBytesPerRowOfPlane(buffer, 0)
    let chromaStride = CVPixelBufferGetBytesPerRowOfPlane(buffer, 1)
    let width = CVPixelBufferGetWidthOfPlane(buffer, 0)
    let height = CVPixelBufferGetHeightOfPlane(buffer, 0)
    let cells = bits + 2
    guard cells * block <= width, block <= height else { return }
    let value = UInt64(max(0, ms)) & ((UInt64(1) << UInt64(bits)) - 1)
    for cell in 0..<cells {
      let on: Bool
      switch cell {
      case 0: on = true
      case 1: on = false
      default: on = (value >> UInt64(bits - 1 - (cell - 2))) & 1 == 1
      }
      let x = cell * block
      for row in 0..<block {
        memset(luma + row * lumaStride + x, on ? 235 : 16, block)
      }
    }
    // 色度设成中性，方块是纯黑白。
    for row in 0..<(block / 2) {
      memset(chroma + row * chromaStride, 128, cells * block)
    }
  }
}

/// 主屏幕。按 LiveKit 的做法：只送完整的帧；屏幕不动时 ScreenCaptureKit 不出新帧，
/// 每秒补发一次上一帧，看画面的一端才不会一直等关键帧。
final class ScreenSource: NSObject, FrameSource, SCStreamOutput, SCStreamDelegate {
  private let fps: Int
  private let maxWidth: Int
  private let stamp: Bool
  private let deliver: (CVPixelBuffer, Int64) -> Void
  private let queue = DispatchQueue(label: "pupu.desktop.screen")
  private var stream: SCStream?
  private var last: CVPixelBuffer?
  private var lastAt = Date.distantPast
  private var resend: DispatchSourceTimer?

  init(fps: Int, maxWidth: Int, stamp: Bool, deliver: @escaping (CVPixelBuffer, Int64) -> Void) {
    self.fps = fps
    self.maxWidth = maxWidth
    self.stamp = stamp
    self.deliver = deliver
  }

  func start(_ done: @escaping (Int, Int, String?) -> Void) {
    SCShareableContent.getExcludingDesktopWindows(false, onScreenWindowsOnly: true) { [weak self] content, error in
      guard let self else { return }
      guard let content,
            let display = content.displays.first(where: { $0.displayID == CGMainDisplayID() }) ?? content.displays.first
      else {
        let why = error?.localizedDescription ?? "没有找到显示器"
        done(0, 0, "截不了屏（\(why)）。到系统设置 → 隐私与安全性 → 屏幕录制里允许 pupu-desktop，再重试。")
        return
      }
      // 按实际像素截，长边不超过 maxWidth；H.264 要求宽高是偶数。
      let pixelWidth = CGDisplayCopyDisplayMode(display.displayID)?.pixelWidth ?? display.width * 2
      let width = min(pixelWidth, maxWidth) & ~1
      let height = Int((Double(width) * Double(display.height) / Double(display.width)).rounded()) & ~1

      let configuration = SCStreamConfiguration()
      configuration.width = width
      configuration.height = height
      configuration.minimumFrameInterval = CMTime(value: 1, timescale: CMTimeScale(fps))
      configuration.queueDepth = 5
      configuration.pixelFormat = kCVPixelFormatType_420YpCbCr8BiPlanarVideoRange
      configuration.showsCursor = true
      let filter = SCContentFilter(display: display, excludingWindows: [])
      let stream = SCStream(filter: filter, configuration: configuration, delegate: self)
      do {
        try stream.addStreamOutput(self, type: .screen, sampleHandlerQueue: queue)
      } catch {
        done(0, 0, "截屏输出接不上：\(error.localizedDescription)")
        return
      }
      self.stream = stream
      stream.startCapture { error in
        if let error {
          done(0, 0, "开始截屏失败（\(error.localizedDescription)）。到系统设置 → 隐私与安全性 → 屏幕录制里允许 pupu-desktop，再重试。")
        } else {
          done(width, height, nil)
        }
      }
      self.startResend()
    }
  }

  func stop() {
    resend?.cancel()
    resend = nil
    stream?.stopCapture { _ in }
    stream = nil
  }

  func stream(_: SCStream, didOutputSampleBuffer sampleBuffer: CMSampleBuffer, of type: SCStreamOutputType) {
    guard type == .screen, CMSampleBufferIsValid(sampleBuffer),
          let attachments = CMSampleBufferGetSampleAttachmentsArray(sampleBuffer, createIfNecessary: false)
            as? [[SCStreamFrameInfo: Any]],
          let statusRaw = attachments.first?[.status] as? Int,
          SCFrameStatus(rawValue: statusRaw) == .complete,
          let buffer = CMSampleBufferGetImageBuffer(sampleBuffer)
    else { return }
    emit(buffer)
  }

  func stream(_: SCStream, didStopWithError error: Error) {
    Wire.send(["type": "error", "message": "截屏停了：\(error.localizedDescription)"])
  }

  private func emit(_ buffer: CVPixelBuffer) {
    if stamp { Stamp.write(into: buffer, ms: nowMs()) }
    last = buffer
    lastAt = Date()
    deliver(buffer, monotonicNs())
  }

  private func startResend() {
    let timer = DispatchSource.makeTimerSource(queue: queue)
    timer.schedule(deadline: .now() + 1, repeating: 0.25)
    timer.setEventHandler { [weak self] in
      guard let self, let last = self.last, Date().timeIntervalSince(self.lastAt) >= 1 else { return }
      self.emit(last)
    }
    timer.resume()
    resend = timer
  }
}

/// 测试画面：一根左右移动的亮条，加上时间戳。不需要屏幕录制权限，用来单独验证编码和传输。
final class PatternSource: FrameSource {
  private let fps: Int
  private let width: Int
  private let height: Int
  private let stamp: Bool
  private let deliver: (CVPixelBuffer, Int64) -> Void
  private let queue = DispatchQueue(label: "pupu.desktop.pattern")
  private var timer: DispatchSourceTimer?
  private var pool: CVPixelBufferPool?
  private var tick = 0

  init(fps: Int, width: Int, stamp: Bool, deliver: @escaping (CVPixelBuffer, Int64) -> Void) {
    self.fps = fps
    self.width = width & ~1
    self.height = (width * 10 / 16) & ~1
    self.stamp = stamp
    self.deliver = deliver
  }

  func start(_ done: @escaping (Int, Int, String?) -> Void) {
    let attributes: [String: Any] = [
      kCVPixelBufferPixelFormatTypeKey as String: kCVPixelFormatType_420YpCbCr8BiPlanarVideoRange,
      kCVPixelBufferWidthKey as String: width,
      kCVPixelBufferHeightKey as String: height,
      kCVPixelBufferIOSurfacePropertiesKey as String: [:] as [String: Any]
    ]
    CVPixelBufferPoolCreate(nil, nil, attributes as CFDictionary, &pool)
    guard pool != nil else {
      done(0, 0, "建不了测试画面的缓冲池")
      return
    }
    let timer = DispatchSource.makeTimerSource(queue: queue)
    timer.schedule(deadline: .now(), repeating: 1.0 / Double(fps))
    timer.setEventHandler { [weak self] in self?.frame() }
    timer.resume()
    self.timer = timer
    done(width, height, nil)
  }

  func stop() {
    timer?.cancel()
    timer = nil
  }

  private func frame() {
    guard let pool else { return }
    var output: CVPixelBuffer?
    guard CVPixelBufferPoolCreatePixelBuffer(nil, pool, &output) == kCVReturnSuccess, let buffer = output else { return }
    tick += 1
    CVPixelBufferLockBaseAddress(buffer, [])
    if let luma = CVPixelBufferGetBaseAddressOfPlane(buffer, 0),
       let chroma = CVPixelBufferGetBaseAddressOfPlane(buffer, 1)
    {
      let lumaStride = CVPixelBufferGetBytesPerRowOfPlane(buffer, 0)
      let chromaStride = CVPixelBufferGetBytesPerRowOfPlane(buffer, 1)
      let bar = (tick * 12) % max(1, width - 40)
      for row in 0..<height {
        let line = luma + row * lumaStride
        memset(line, Int32(40 + row * 120 / height), width)
        memset(line + bar, 220, 40)
      }
      for row in 0..<(height / 2) {
        memset(chroma + row * chromaStride, 128, width)
      }
    }
    CVPixelBufferUnlockBaseAddress(buffer, [])
    if stamp { Stamp.write(into: buffer, ms: nowMs()) }
    deliver(buffer, monotonicNs())
  }
}
