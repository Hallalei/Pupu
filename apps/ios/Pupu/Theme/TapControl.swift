import UIKit

/// 自己画的可点控件的底类。UIControl 自己只发触摸事件，`.primaryActionTriggered` 只有 UIButton 这类系统控件才发；
/// 这里在手指在控件里抬起时补发一次，`addAction(_:for: .primaryActionTriggered)` 才会被叫到。
/// 只听 `.touchUpInside` 的控件不用换成它。
class TapControl: UIControl {
    override init(frame: CGRect) {
        super.init(frame: frame)
        addAction(UIAction { [weak self] _ in self?.sendActions(for: .primaryActionTriggered) }, for: .touchUpInside)
    }

    required init?(coder: NSCoder) { fatalError() }
}
