import FMFCore
import Foundation

private var followed: FMFFriend?

private func unpadded(_ id: String) -> String {
    var value = id
    while value.hasSuffix("~") { value.removeLast() }
    return value
}

/// Starts Apple's live location for exactly one opaque friend id.
/// 0 = started, 1 = not found, 2 = id is not unique.
@_cdecl("bbfm_start_live")
public func bbfmStartLive(_ manager: UnsafeMutableRawPointer, _ id: UnsafePointer<CChar>) -> Int32 {
    let finder = Unmanaged<FMFManager>.fromOpaque(manager).takeUnretainedValue()
    let wanted = unpadded(String(cString: id))
    let matches = finder.friends.filter { unpadded($0.identifier) == wanted }
    guard matches.count == 1, let friend = matches.first else { return matches.isEmpty ? 1 : 2 }
    if let previous = followed { finder.stopLiveLocation(for: previous) }
    finder.startLiveLocation(for: friend, clientApp: "BlueBubbles")
    followed = friend
    return 0
}

@_cdecl("bbfm_stop_live")
public func bbfmStopLive(_ manager: UnsafeMutableRawPointer) -> Int32 {
    guard let friend = followed else { return 0 }
    Unmanaged<FMFManager>.fromOpaque(manager).takeUnretainedValue().stopLiveLocation(for: friend)
    followed = nil
    return 0
}
