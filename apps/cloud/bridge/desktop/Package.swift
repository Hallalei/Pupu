// swift-tools-version:5.9
// pupu-desktop：把这台电脑的屏幕用 WebRTC 推给手机，并接收手机发来的鼠标键盘。
// libwebrtc 用 stasel/WebRTC 打好的二进制（BSD-3，WebRTC 本身是 BSD 许可）。
import PackageDescription

let package = Package(
  name: "PupuDesktop",
  platforms: [.macOS(.v13)],
  dependencies: [
    .package(url: "https://github.com/stasel/WebRTC.git", .upToNextMajor(from: "156.0.0"))
  ],
  targets: [
    .executableTarget(
      name: "PupuDesktop",
      dependencies: [.product(name: "WebRTC", package: "WebRTC")]
    )
  ]
)
