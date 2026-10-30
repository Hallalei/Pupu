import UIKit

/// 顶栏中间的三段切换：玻璃胶囊底，选中的一段用 action 填充、on-action 写字，其余用 ink。
/// 不用 UISegmentedControl：iOS 26 把它放进导航栏后，选中段画成玻璃透镜，selectedSegmentTintColor 不生效，
/// 选中的字成了浅底白字，看不清。
final class SectionSwitch: UIControl {
    static let segmentWidth: CGFloat = 64
    private static let inset: CGFloat = 4

    private(set) var selectedIndex: Int
    private let glass = GlassView(interactive: true)
    private let indicator = UIView()
    private let labels: [UILabel]

    init(titles: [String], selected: Int) {
        selectedIndex = selected
        labels = titles.map { UILabel(text: $0, style: .subheadline) }
        super.init(frame: .zero)
        glass.isUserInteractionEnabled = false
        addSubview(glass)
        glass.pin(to: self)
        indicator.backgroundColor = Theme.action
        indicator.layer.cornerCurve = .continuous
        indicator.isUserInteractionEnabled = false
        addSubview(indicator)
        for label in labels {
            label.textAlignment = .center
            label.adjustsFontSizeToFitWidth = true
            label.minimumScaleFactor = 0.7
            label.isAccessibilityElement = true
            addSubview(label)
        }
        addGestureRecognizer(UITapGestureRecognizer(target: self, action: #selector(tapped)))
        isAccessibilityElement = false
        accessibilityTraits = .tabBar
        accessibilityElements = labels
        update()
    }

    required init?(coder: NSCoder) { fatalError() }

    override var intrinsicContentSize: CGSize {
        CGSize(width: Self.inset * 2 + Self.segmentWidth * CGFloat(labels.count), height: Theme.Size.control)
    }

    override func layoutSubviews() {
        super.layoutSubviews()
        for (index, label) in labels.enumerated() { label.frame = frame(of: index) }
        indicator.frame = frame(of: selectedIndex)
        indicator.layer.cornerRadius = indicator.bounds.height / 2
    }

    func select(_ index: Int, animated: Bool) {
        guard labels.indices.contains(index), index != selectedIndex else { return }
        selectedIndex = index
        update()
        let move = { self.indicator.frame = self.frame(of: index) }
        if animated && !UIAccessibility.isReduceMotionEnabled {
            UIView.animate(springDuration: 0.3, bounce: 0.15, animations: move)
        } else {
            move()
        }
    }

    @objc private func tapped(_ gesture: UITapGestureRecognizer) {
        let x = gesture.location(in: self).x - Self.inset
        let index = min(max(Int(x / Self.segmentWidth), 0), labels.count - 1)
        guard index != selectedIndex else { return }
        select(index, animated: true)
        sendActions(for: .valueChanged)
    }

    private func frame(of index: Int) -> CGRect {
        CGRect(
            x: Self.inset + CGFloat(index) * Self.segmentWidth,
            y: Self.inset,
            width: Self.segmentWidth,
            height: max(0, bounds.height - Self.inset * 2)
        )
    }

    private func update() {
        for (index, label) in labels.enumerated() {
            let selected = index == selectedIndex
            label.textColor = selected ? Theme.onAction : Theme.ink
            label.font = Theme.font(.subheadline, weight: selected ? .semibold : .medium)
            label.accessibilityTraits = selected ? [.button, .selected] : .button
        }
    }
}
