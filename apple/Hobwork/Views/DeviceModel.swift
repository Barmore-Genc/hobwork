#if os(iOS)
    import UIKit
#endif

enum DeviceModel {
    @MainActor static var name: String {
        #if os(macOS)
            "Mac"
        #else
            UIDevice.current.userInterfaceIdiom == .pad ? "iPad" : "iPhone"
        #endif
    }
}
