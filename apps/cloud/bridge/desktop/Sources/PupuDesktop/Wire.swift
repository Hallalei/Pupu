// pupu-desktop 和验证用的输入助手共用：按行收发 JSON，以及让系统把授权记在自己名下。

import Foundation

enum Wire {
  private static let lock = NSLock()

  static func send(_ payload: [String: Any]) {
    guard var data = try? JSONSerialization.data(withJSONObject: payload) else { return }
    data.append(0x0A)
    lock.lock()
    FileHandle.standardOutput.write(data)
    lock.unlock()
  }

  static func log(_ message: String) {
    FileHandle.standardError.write(Data("pupu-desktop：\(message)\n".utf8))
  }
}

/// 用 posix_spawn 把自己重新拉起一次，并声明不归父进程负责（Chromium 拉辅助进程也这么做）。
enum Responsibility {
  @_silgen_name("responsibility_spawnattrs_setdisclaim")
  private static func setDisclaim(_ attrs: UnsafeMutablePointer<posix_spawnattr_t?>, _ disclaim: Int32) -> Int32

  static func disclaimIfNeeded() {
    let key = "PUPU_DESKTOP_DISCLAIMED"
    guard ProcessInfo.processInfo.environment[key] == nil else { return }
    var attrs: posix_spawnattr_t?
    guard posix_spawnattr_init(&attrs) == 0 else { return }
    defer { posix_spawnattr_destroy(&attrs) }
    guard setDisclaim(&attrs, 1) == 0 else { return }

    let path = CommandLine.arguments[0]
    let resolved = path.hasPrefix("/") ? path : FileManager.default.currentDirectoryPath + "/" + path
    var environment = ProcessInfo.processInfo.environment
    environment[key] = "1"
    let argv: [UnsafeMutablePointer<CChar>?] = CommandLine.arguments.map { strdup($0) } + [nil]
    let envp: [UnsafeMutablePointer<CChar>?] = environment.map { strdup("\($0.key)=\($0.value)") } + [nil]
    defer {
      argv.forEach { free($0) }
      envp.forEach { free($0) }
    }
    var pid: pid_t = 0
    // 没有 file actions：子进程直接继承 stdin、stdout、stderr。
    guard posix_spawn(&pid, resolved, nil, &attrs, argv, envp) == 0 else {
      Wire.log("没能以独立身份重新启动，沿用当前进程")
      return
    }
    // 父进程让出 stdin，只等子进程结束。
    close(STDIN_FILENO)
    var status: Int32 = 0
    while waitpid(pid, &status, 0) == -1 && errno == EINTR {}
    exit((status & 0x7f) == 0 ? (status >> 8) & 0xff : 1)
  }
}
