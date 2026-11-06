import FMFCore
import Foundation

@_silgen_name("bbfm_set_test_manager")
func setTestManager(_ pointer: UnsafeMutableRawPointer)

var manager: FMFManager? = FMFManager(friends: [
    FMFFriend(name: "One", identifier: "friend-one~~~"),
    FMFFriend(name: "Two", identifier: "friend-two"),
    FMFFriend(name: "Duplicate A", identifier: "duplicate"),
    FMFFriend(name: "Duplicate B", identifier: "duplicate~~"),
])
setTestManager(Unmanaged.passUnretained(manager!).toOpaque())
manager = nil // The bridge, not this host, must keep the manager alive.
RunLoop.main.run(until: Date(timeIntervalSinceNow: 8))
