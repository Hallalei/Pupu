import UIKit

/// 空间标记（规范 SpaceMark）：空间原色（`mark-*`）的圆角方块里一个像素图标（`on-mark`），没图标写空间名的第一个字。
/// 只有两档：20（圆角 6、图标 16，一格一 pt）和 40（圆角 12、图标 32，一格两 pt）。两种主题一样，像头像。
/// 方块不单独读，VoiceOver 和旁边的空间名合成一个元素。「我的 Pupu」不是空间，用 Pupu 的头像，不用它。
final class SpaceMarkView: UIView {
    private let icon = UIImageView()
    private let letter = UILabel()
    private let large: Bool

    init(large: Bool = false) {
        self.large = large
        super.init(frame: .zero)
        let side = large ? Theme.Size.markLarge : Theme.Size.mark
        layer.cornerRadius = large ? Theme.Radius.markLarge : Theme.Radius.mark
        layer.cornerCurve = .continuous
        // 往里收一圈 0.5pt #0000001f，放在同色的窗框上也分得清。
        layer.borderWidth = 0.5
        layer.borderColor = UIColor(white: 0, alpha: 0x1f / 255).cgColor
        isAccessibilityElement = false
        isUserInteractionEnabled = false

        icon.tintColor = Theme.onMark
        icon.contentMode = .scaleToFill
        icon.layer.magnificationFilter = .nearest
        icon.translatesAutoresizingMaskIntoConstraints = false
        addSubview(icon)

        letter.textColor = Theme.onMark
        letter.font = .systemFont(ofSize: large ? 22 : 12, weight: .bold)
        letter.textAlignment = .center
        letter.translatesAutoresizingMaskIntoConstraints = false
        addSubview(letter)

        let glyph: CGFloat = large ? 32 : 16
        translatesAutoresizingMaskIntoConstraints = false
        NSLayoutConstraint.activate([
            widthAnchor.constraint(equalToConstant: side),
            heightAnchor.constraint(equalToConstant: side),
            icon.widthAnchor.constraint(equalToConstant: glyph),
            icon.heightAnchor.constraint(equalToConstant: glyph),
            icon.centerXAnchor.constraint(equalTo: centerXAnchor),
            icon.centerYAnchor.constraint(equalTo: centerYAnchor),
            letter.centerXAnchor.constraint(equalTo: centerXAnchor),
            letter.centerYAnchor.constraint(equalTo: centerYAnchor)
        ])
        setContentHuggingPriority(.required, for: .horizontal)
        setContentCompressionResistancePriority(.required, for: .horizontal)
    }

    required init?(coder: NSCoder) { fatalError() }

    /// 认不出的颜色按雾蓝，认不出的图标按没图标（写名字的第一个字）。
    func show(color: String?, icon id: String?, name: String) {
        backgroundColor = Theme.SpaceColor(id: color).mark
        let image = id.flatMap(Theme.SpaceIcon.init(rawValue:))?.image
        icon.image = image
        icon.isHidden = image == nil
        letter.text = image == nil ? name.first.map(String.init) : nil
        letter.isHidden = image != nil
    }

    func show(_ project: Project) {
        show(color: project.color, icon: project.icon, name: project.name)
    }
}
