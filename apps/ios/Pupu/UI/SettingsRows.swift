import CoreImage.CIFilterBuiltins
import UIKit

// 设置里系统格子画不出来的几行：电脑那一块的头、右边写当前档位的下拉行、生成好的配对码。
// 都放进 `HostCell`：行底、圆角和分隔线照列表的，里面是自己排的视图。和网页 Settings.tsx 的 ComputerPanel、SelectRow、PairNew 一起改。

/// 放一块自己排的视图的列表格子。同一个视图再配一次只换内容，不重建。
final class HostCell: UICollectionViewListCell {
    private(set) var hosted: UIView?

    func host(_ view: UIView) {
        guard hosted !== view else { return }
        hosted?.removeFromSuperview()
        contentView.addSubview(view)
        view.pin(to: contentView)
        hosted = view
    }

    /// 拿已经放着的那种视图，没有就新建一个放进去。
    func hosted<View: UIView>(_ make: () -> View) -> View {
        if let view = hosted as? View { return view }
        let view = make()
        host(view)
        return view
    }
}

/// 状态圆点加状态词（规范 ComputerRow「状态一定写成字」）：8 的圆点，后面 `subheadline`、`ink-muted`。
func statusText(_ text: String, online: Bool) -> NSAttributedString {
    let font = Theme.font(.subheadline)
    let side: CGFloat = 8
    let dot = UIGraphicsImageRenderer(size: CGSize(width: side, height: side)).image { _ in
        UIBezierPath(ovalIn: CGRect(x: 0, y: 0, width: side, height: side)).fill()
    }.withRenderingMode(.alwaysTemplate)
    let attachment = NSTextAttachment(image: dot)
    attachment.bounds = CGRect(x: 0, y: (font.capHeight - side) / 2, width: side, height: side)
    let line = NSMutableAttributedString(attachment: attachment)
    line.addAttribute(.foregroundColor, value: online ? Theme.online : Theme.offline, range: NSRange(location: 0, length: line.length))
    line.append(NSAttributedString(string: "  " + text, attributes: [.font: font, .foregroundColor: Theme.inkMuted]))
    return line
}

/// 电脑那一块的头（规范 ComputerRow）：电脑图标 28、名字（`headline`），下面圆点加「在线 · 林夏的」；
/// 主人自己的电脑下面接整宽的「远程控制」（`action`，高 44），离线时这一颗是 `action-off` 底、`ink-muted` 字，点不了。
final class ComputerHeadView: UIView {
    enum Remote: Equatable { case none, online, offline }

    private let icon = UIImageView(image: UIImage(systemName: "desktopcomputer", withConfiguration: UIImage.SymbolConfiguration(pointSize: 22)))
    private let name = UILabel(style: .headline)
    private let status = UILabel(style: .subheadline, color: Theme.inkMuted)
    private let remote = UIButton.action(title: "远程控制", image: "cursorarrow")
    var onRemote: (() -> Void)?

    override init(frame: CGRect) {
        super.init(frame: frame)
        icon.tintColor = Theme.ink
        icon.contentMode = .center
        icon.translatesAutoresizingMaskIntoConstraints = false
        NSLayoutConstraint.activate([
            icon.widthAnchor.constraint(equalToConstant: 28),
            icon.heightAnchor.constraint(equalToConstant: 28)
        ])
        name.lineBreakMode = .byTruncatingTail
        status.numberOfLines = 0
        let text = UIStackView(arrangedSubviews: [name, status])
        text.axis = .vertical
        text.spacing = Theme.Space.s0_5
        let head = UIStackView(arrangedSubviews: [icon, text])
        head.spacing = Theme.Space.s3
        head.alignment = .center
        remote.configuration?.imagePadding = Theme.Space.s2
        remote.heightAnchor.constraint(equalToConstant: Theme.Size.control).isActive = true
        remote.addAction(UIAction { [weak self] _ in self?.onRemote?() }, for: .primaryActionTriggered)
        let column = UIStackView(arrangedSubviews: [head, remote])
        column.axis = .vertical
        column.spacing = Theme.Space.s3
        addSubview(column)
        column.pin(to: self, insets: UIEdgeInsets(top: Theme.Space.s4, left: Theme.Space.s4, bottom: Theme.Space.s4, right: Theme.Space.s4))
    }

    required init?(coder: NSCoder) { fatalError() }

    func show(name: String, status: String, online: Bool, remote state: Remote) {
        self.name.text = name
        self.status.attributedText = statusText(status, online: online)
        remote.isHidden = state == .none
        remote.isEnabled = state == .online
        remote.configuration?.title = state == .online ? "远程控制" : "离线，连上才能远程控制"
        remote.configuration?.image = state == .online ? UIImage(systemName: "cursorarrow") : nil
        accessibilityElements = [self.name, self.status, remote].filter { !$0.isHidden }
    }
}

/// 一块里能改的一行（规范 ComputerRow）：名字在左，当前那一档写在右边（`subheadline`、`ink-muted`），点整行弹系统的菜单。
/// 不能选的档在菜单里灰掉。按下时整行换 `line` 底，和别的行一样。
final class MenuRowView: UIButton {
    private let title = UILabel(style: .body)
    private let value = UILabel(style: .subheadline, color: Theme.inkMuted)
    private let chevron = UIImageView(image: UIImage(systemName: "chevron.up.chevron.down", withConfiguration: UIImage.SymbolConfiguration(pointSize: 11, weight: .semibold)))

    override init(frame: CGRect) {
        super.init(frame: frame)
        chevron.tintColor = Theme.inkFaint
        title.setContentCompressionResistancePriority(.defaultLow, for: .horizontal)
        value.setContentHuggingPriority(.required, for: .horizontal)
        let row = UIStackView(arrangedSubviews: [title, value, chevron])
        row.spacing = Theme.Space.s2
        row.alignment = .center
        row.isUserInteractionEnabled = false
        row.setCustomSpacing(6, after: value)
        addSubview(row)
        row.pin(to: self, insets: UIEdgeInsets(top: Theme.Space.s2, left: Theme.Space.s4, bottom: Theme.Space.s2, right: Theme.Space.s4))
        heightAnchor.constraint(greaterThanOrEqualToConstant: 52).isActive = true
        showsMenuAsPrimaryAction = true
    }

    required init?(coder: NSCoder) { fatalError() }

    func show(title: String, value: String, menu: UIMenu, label: String) {
        self.title.text = title
        self.value.text = value
        self.menu = menu
        accessibilityLabel = label
        accessibilityValue = value
    }

    override var isHighlighted: Bool {
        didSet { backgroundColor = isHighlighted ? Theme.line : .clear }
    }
}

/// 生成好的配对码（规范 Devices）：左边二维码，右边码和倒计时，下面一句怎么用，右下「收起」。点码复制。
final class PairCodeView: UIView {
    private let qr = UIImageView()
    private let code = UILabel()
    private let left = UILabel(style: .subheadline, color: Theme.inkMuted)
    private let note = UILabel(style: .subheadline, color: Theme.inkMuted)
    private let collapse = UIButton(configuration: .plain())
    private var link = ""
    var onCopy: (() -> Void)?
    var onCollapse: (() -> Void)?

    override init(frame: CGRect) {
        super.init(frame: frame)
        // 二维码两种主题都是白底黑块，相机才认得出来（规范写明的例外，不换成 token）。
        let paper = UIView()
        paper.backgroundColor = .white
        paper.layer.cornerRadius = Theme.Radius.tag
        qr.layer.magnificationFilter = .nearest
        qr.contentMode = .center
        qr.isAccessibilityElement = true
        qr.accessibilityLabel = "配对二维码，用 iPhone 相机扫"
        paper.addSubview(qr)
        qr.pin(to: paper, insets: UIEdgeInsets(top: Theme.Space.s2, left: Theme.Space.s2, bottom: Theme.Space.s2, right: Theme.Space.s2))
        qr.translatesAutoresizingMaskIntoConstraints = false
        NSLayoutConstraint.activate([
            qr.widthAnchor.constraint(equalToConstant: 128),
            qr.heightAnchor.constraint(equalToConstant: 128)
        ])
        paper.setContentHuggingPriority(.required, for: .horizontal)

        code.font = UIFontMetrics(forTextStyle: .title3).scaledFont(for: .monospacedSystemFont(ofSize: 20, weight: .semibold))
        code.adjustsFontForContentSizeCategory = true
        code.textColor = Theme.ink
        code.adjustsFontSizeToFitWidth = true
        code.minimumScaleFactor = 0.7
        left.numberOfLines = 0
        let codeColumn = UIStackView(arrangedSubviews: [code, left])
        codeColumn.axis = .vertical
        codeColumn.spacing = Theme.Space.s1
        codeColumn.isUserInteractionEnabled = true
        codeColumn.addGestureRecognizer(UITapGestureRecognizer(target: self, action: #selector(copyCode)))
        codeColumn.isAccessibilityElement = true
        codeColumn.accessibilityTraits = .button
        codeColumn.accessibilityHint = "复制配对码"

        let top = UIStackView(arrangedSubviews: [paper, codeColumn])
        top.spacing = Theme.Space.s3
        top.alignment = .center

        note.numberOfLines = 0
        note.text = "手机扫码或在 App 里填码，浏览器和电脑 App 填码。连过手机的，新手机要用旧手机设置里生成的码。"

        // 「收起」：不填底的胶囊，高 32，`subheadline` 600，`ink`。
        var config = UIButton.Configuration.plain()
        config.title = "收起"
        config.cornerStyle = .capsule
        config.contentInsets = NSDirectionalEdgeInsets(top: 0, leading: 14, bottom: 0, trailing: 14)
        config.titleTextAttributesTransformer = UIConfigurationTextAttributesTransformer { attributes in
            var attributes = attributes
            attributes.font = Theme.font(.subheadline, weight: .semibold)
            attributes.foregroundColor = Theme.ink
            return attributes
        }
        collapse.configuration = config
        collapse.configurationUpdateHandler = { button in
            button.configuration?.background.backgroundColor = button.isHighlighted ? Theme.line : .clear
        }
        collapse.heightAnchor.constraint(equalToConstant: 32).isActive = true
        collapse.addAction(UIAction { [weak self] _ in self?.onCollapse?() }, for: .primaryActionTriggered)
        let bottom = UIStackView(arrangedSubviews: [UIView(), collapse])

        let column = UIStackView(arrangedSubviews: [top, note, bottom])
        column.axis = .vertical
        column.spacing = Theme.Space.s3
        addSubview(column)
        column.pin(to: self, insets: UIEdgeInsets(top: Theme.Space.s3, left: Theme.Space.s4, bottom: Theme.Space.s3, right: Theme.Space.s4))
    }

    required init?(coder: NSCoder) { fatalError() }

    /// `seconds` 是还剩几秒；`copied` 时倒计时那里临时写「已复制。」。
    func show(code text: String, link: String, seconds: Int, copied: Bool) {
        code.attributedText = NSAttributedString(string: text, attributes: [.kern: 1.0])
        left.text = copied ? "已复制。" : "\(seconds / 60):\(String(format: "%02d", seconds % 60)) 后过期"
        if link != self.link {
            self.link = link
            qr.image = QRCode.image(link, side: 128, scale: traitCollection.displayScale > 0 ? traitCollection.displayScale : 3)
        }
        (code.superview as? UIStackView)?.accessibilityLabel = "配对码 \(text)，\(left.text ?? "")"
    }

    @objc private func copyCode() { onCopy?() }
}

/// 配对二维码：`CIFilter.qrCodeGenerator`，纠错 M，按整数倍放大到不超过 `side`，像素不糊。
enum QRCode {
    private static let context = CIContext()

    static func image(_ text: String, side: CGFloat, scale: CGFloat) -> UIImage? {
        let filter = CIFilter.qrCodeGenerator()
        filter.message = Data(text.utf8)
        filter.correctionLevel = "M"
        guard let output = filter.outputImage else { return nil }
        let modules = output.extent.width
        let factor = max(1, floor(side * scale / modules))
        let scaled = output.transformed(by: CGAffineTransform(scaleX: factor, y: factor))
        guard let image = context.createCGImage(scaled, from: scaled.extent) else { return nil }
        return UIImage(cgImage: image, scale: scale, orientation: .up)
    }
}
