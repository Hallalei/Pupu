import UIKit

/// 手指怎么算鼠标。
nonisolated enum DesktopInputMode: String, CaseIterable, Sendable {
    /// 手指在哪就点哪，单指拖动是挪画面。
    case touch
    /// 手指滑动移动鼠标，轻点是点击。
    case trackpad

    var title: String {
        switch self {
        case .touch: "触摸"
        case .trackpad: "触控板"
        }
    }
}

/// 放画面的舞台：算画面放在哪，把手势翻译成鼠标。
/// 手势规则逐条照 Cindy 的 viewerRuntime.js（Apache-2.0）：按住 400 毫秒开始拖动，移动超过 6 点不算点击；
/// 双指里距离变化大于平移的 0.65 倍并且持续 40 毫秒算捏合，平移超过 8 点算滚动；捏合时手指下的那一点不动。
final class DesktopStageView: UIView {
    var mode: DesktopInputMode = .touch
    /// 只看：手势只挪画面。
    var control = true
    var onInput: (([String: Any]) -> Void)?
    /// 底部工具栏、键盘挡掉的高度。
    var bottomInset: CGFloat = 0 { didSet { setNeedsLayout() } }

    /// 电脑屏幕的宽高比，来自画面。
    var desktopSize = CGSize(width: 16, height: 10) { didSet { setNeedsLayout() } }
    /// 视频或 JPEG 放在这里面，跟着 `layoutSubviews` 走。
    let content = UIView()

    private var zoom: CGFloat = 1
    /// 视口中心对着画面的哪一点，0 到 1。
    private var focus = CGPoint(x: 0.5, y: 0.5)
    private var cursor = CGPoint(x: 0.5, y: 0.5)
    private let tapMark = UIView()

    private struct Multi {
        var distance: CGFloat
        var center: CGPoint
        var last: CGPoint
        var zoom: CGFloat
        var anchor: CGPoint
        var kind: Kind?
        var candidateAt: TimeInterval?
        var candidate: (distance: CGFloat, zoom: CGFloat, anchor: CGPoint)?
        var aimed = false
        var rest = CGPoint.zero

        enum Kind { case pinch, scroll }
    }

    private var touchPoints: [ObjectIdentifier: CGPoint] = [:]
    private var start: CGPoint?
    private var last: CGPoint?
    private var moved = false
    private var dragging = false
    private var hold: Timer?
    private var multi: Multi?

    override init(frame: CGRect) {
        super.init(frame: frame)
        backgroundColor = .black
        clipsToBounds = true
        isMultipleTouchEnabled = true
        content.isUserInteractionEnabled = false
        addSubview(content)
        tapMark.isUserInteractionEnabled = false
        tapMark.frame = CGRect(x: 0, y: 0, width: 28, height: 28)
        tapMark.layer.cornerRadius = 14
        tapMark.layer.borderWidth = 2
        tapMark.layer.borderColor = UIColor.white.cgColor
        tapMark.backgroundColor = UIColor.white.withAlphaComponent(0.25)
        tapMark.alpha = 0
        addSubview(tapMark)
    }

    @available(*, unavailable)
    required init?(coder: NSCoder) { fatalError() }

    // MARK: 画面放在哪

    private var viewport: CGSize {
        CGSize(width: bounds.width, height: max(1, bounds.height - bottomInset))
    }

    private var fit: CGFloat {
        guard desktopSize.width > 0, desktopSize.height > 0 else { return 1 }
        return min(viewport.width / desktopSize.width, viewport.height / desktopSize.height)
    }

    /// 最大放到两倍物理像素。
    private var maxZoom: CGFloat {
        max(4, 2 / max(fit * UIScreen.main.scale / 2, 0.01))
    }

    private var placed: CGRect {
        let scale = fit * zoom
        let width = desktopSize.width * scale
        let height = desktopSize.height * scale
        let port = viewport
        func place(_ size: CGFloat, _ span: CGFloat, _ center: CGFloat) -> CGFloat {
            if size <= span { return (span - size) / 2 }
            return min(0, max(span - size, span / 2 - center * size))
        }
        return CGRect(
            x: place(width, port.width, focus.x),
            y: place(height, port.height, focus.y),
            width: width,
            height: height
        )
    }

    override func layoutSubviews() {
        super.layoutSubviews()
        content.frame = placed
        for child in content.subviews { child.frame = content.bounds }
    }

    func resetView() {
        zoom = 1
        focus = CGPoint(x: 0.5, y: 0.5)
        setNeedsLayout()
    }

    private func clamp(_ value: CGFloat) -> CGFloat { max(0, min(1, value)) }

    private func desktopPoint(_ point: CGPoint) -> CGPoint {
        let rect = placed
        return CGPoint(x: clamp((point.x - rect.minX) / rect.width), y: clamp((point.y - rect.minY) / rect.height))
    }

    private func inside(_ point: CGPoint) -> Bool {
        placed.contains(point)
    }

    private func pan(_ dx: CGFloat, _ dy: CGFloat) {
        let rect = placed
        if rect.width > 0 { focus.x = clamp(focus.x - dx / rect.width) }
        if rect.height > 0 { focus.y = clamp(focus.y - dy / rect.height) }
        // 把焦点拉回画面真正能到的位置，免得在边上空划一段才动。
        let now = placed
        focus = CGPoint(
            x: (viewport.width / 2 - now.minX) / now.width,
            y: (viewport.height / 2 - now.minY) / now.height
        )
        setNeedsLayout()
    }

    // MARK: 发鼠标

    private func send(_ event: [String: Any]) {
        onInput?(event)
    }

    private func move() {
        send(["t": "move", "x": cursor.x, "y": cursor.y])
    }

    private func button(_ down: Bool, _ button: Int = 0) {
        send(["t": down ? "down" : "up", "b": button, "x": cursor.x, "y": cursor.y])
    }

    private func click() {
        if mode == .touch { showTap() }
        move()
        button(true)
        button(false)
    }

    private func showTap() {
        let rect = placed
        tapMark.center = CGPoint(x: rect.minX + cursor.x * rect.width, y: rect.minY + cursor.y * rect.height)
        tapMark.alpha = 1
        UIView.animate(withDuration: 0.45) { self.tapMark.alpha = 0 }
    }

    /// 右键：控制面板和工具栏用。
    func rightClick() {
        move()
        button(true, 2)
        button(false, 2)
    }

    // MARK: 手指

    private func pair() -> (center: CGPoint, distance: CGFloat)? {
        let points = Array(touchPoints.values)
        guard points.count >= 2 else { return nil }
        let a = points[0], b = points[1]
        return (CGPoint(x: (a.x + b.x) / 2, y: (a.y + b.y) / 2), hypot(a.x - b.x, a.y - b.y))
    }

    override func touchesBegan(_ touches: Set<UITouch>, with event: UIEvent?) {
        for touch in touches { touchPoints[ObjectIdentifier(touch)] = touch.location(in: self) }
        if touchPoints.count == 1, let first = touches.first {
            let point = first.location(in: self)
            start = point
            last = point
            moved = false
            hold?.invalidate()
            hold = Timer.scheduledTimer(withTimeInterval: 0.4, repeats: false) { [weak self] _ in
                MainActor.assumeIsolated { self?.beginDrag() }
            }
        } else if let pair = pair() {
            hold?.invalidate()
            if dragging { send(["t": "release"]) }
            dragging = false
            start = nil
            multi = Multi(
                distance: pair.distance,
                center: pair.center,
                last: pair.center,
                zoom: zoom,
                anchor: rawPoint(pair.center)
            )
        }
    }

    private func rawPoint(_ point: CGPoint) -> CGPoint {
        let rect = placed
        return CGPoint(x: (point.x - rect.minX) / rect.width, y: (point.y - rect.minY) / rect.height)
    }

    private func beginDrag() {
        guard control, !moved, touchPoints.count == 1, let start else { return }
        if mode == .touch {
            guard inside(start) else { return }
            cursor = desktopPoint(start)
        }
        move()
        button(true)
        dragging = true
        UIImpactFeedbackGenerator(style: .light).impactOccurred()
    }

    override func touchesMoved(_ touches: Set<UITouch>, with event: UIEvent?) {
        for touch in touches { touchPoints[ObjectIdentifier(touch)] = touch.location(in: self) }
        if touchPoints.count >= 2 {
            movePair()
            return
        }
        guard let start, let last, let now = touches.first?.location(in: self) else { return }
        let dx = now.x - last.x
        let dy = now.y - last.y
        self.last = now
        if hypot(now.x - start.x, now.y - start.y) > 6 {
            moved = true
            hold?.invalidate()
        }
        if !control || (mode == .touch && !dragging) {
            pan(dx, dy)
            return
        }
        if mode == .trackpad {
            let rect = placed
            cursor = CGPoint(x: clamp(cursor.x + dx / rect.width), y: clamp(cursor.y + dy / rect.height))
        } else {
            cursor = desktopPoint(now)
        }
        move()
    }

    private func movePair() {
        guard var gesture = multi, let next = pair() else { return }
        let span = abs(next.distance - gesture.distance)
        let travel = hypot(next.center.x - gesture.center.x, next.center.y - gesture.center.y)
        if gesture.kind != .pinch {
            let slop = max(6, min(12, gesture.distance * 0.04))
            if span >= slop, span > travel * 0.65 {
                // 平行滚动时两根手指的更新可能差一帧，确认一下再算捏合。
                let now = ProcessInfo.processInfo.systemUptime
                if gesture.candidate == nil {
                    gesture.candidateAt = now
                    gesture.candidate = (next.distance, zoom, rawPoint(next.center))
                }
                if now - (gesture.candidateAt ?? now) >= 0.04, let candidate = gesture.candidate {
                    if gesture.kind == .scroll {
                        gesture.distance = candidate.distance
                        gesture.zoom = candidate.zoom
                        gesture.anchor = candidate.anchor
                    }
                    gesture.kind = .pinch
                    gesture.candidate = nil
                } else {
                    multi = gesture
                    return
                }
            } else {
                gesture.candidate = nil
                if gesture.kind == nil, travel > 8, travel > span {
                    gesture.kind = .scroll
                    gesture.aimed = mode != .touch
                }
            }
        }
        if gesture.kind == .pinch {
            zoom = max(1, min(maxZoom, gesture.zoom * next.distance / max(1, gesture.distance)))
            let scale = fit * zoom
            let width = desktopSize.width * scale
            let height = desktopSize.height * scale
            // 手指下的那一点不动。
            focus = CGPoint(
                x: gesture.anchor.x + (viewport.width / 2 - next.center.x) / width,
                y: gesture.anchor.y + (viewport.height / 2 - next.center.y) / height
            )
            setNeedsLayout()
        } else if gesture.kind == .scroll {
            let dx = next.center.x - gesture.last.x
            let dy = next.center.y - gesture.last.y
            if control {
                // 电脑滚的是鼠标下面的东西，触摸模式下先把鼠标放到手指下面。
                if !gesture.aimed, inside(next.center) {
                    cursor = desktopPoint(next.center)
                    move()
                    gesture.aimed = true
                }
                // 电脑只收整数像素，零头留到下一次，慢慢拖也能滚。
                let sx = gesture.rest.x - dx
                let sy = gesture.rest.y - dy
                let wx = sx.rounded(.towardZero)
                let wy = sy.rounded(.towardZero)
                gesture.rest = CGPoint(x: sx - wx, y: sy - wy)
                if gesture.aimed, wx != 0 || wy != 0 {
                    send(["t": "scroll", "dx": max(-2000, min(2000, wx)), "dy": max(-2000, min(2000, wy))])
                }
            } else {
                pan(dx, dy)
            }
        }
        if gesture.kind != nil { gesture.last = next.center }
        multi = gesture
    }

    override func touchesEnded(_ touches: Set<UITouch>, with event: UIEvent?) {
        let wasSingle = touchPoints.count == 1
        for touch in touches { touchPoints[ObjectIdentifier(touch)] = nil }
        hold?.invalidate()
        if dragging {
            button(false)
            dragging = false
        } else if wasSingle, start != nil, !moved, control, let point = touches.first?.location(in: self) {
            if mode == .touch {
                if inside(point) {
                    cursor = desktopPoint(point)
                    click()
                }
            } else {
                click()
            }
        }
        if touchPoints.isEmpty {
            start = nil
            last = nil
            multi = nil
        } else if touchPoints.count < 2 {
            multi = nil
        }
    }

    override func touchesCancelled(_ touches: Set<UITouch>, with event: UIEvent?) {
        for touch in touches { touchPoints[ObjectIdentifier(touch)] = nil }
        hold?.invalidate()
        if dragging { send(["t": "release"]) }
        dragging = false
        start = nil
        last = nil
        multi = nil
    }
}
