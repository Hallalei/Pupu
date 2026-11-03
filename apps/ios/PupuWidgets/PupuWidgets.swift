import SwiftUI
import WidgetKit

/// 小组件扩展：目前只有灵动岛和锁屏的实时活动。
@main
struct PupuWidgets: WidgetBundle {
    var body: some Widget {
        PupuLiveActivity()
    }
}
