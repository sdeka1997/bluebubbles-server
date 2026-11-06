import FMFCore
import Foundation

// Find My's manager appears a moment into launch; the bridge must find it by itself, soon after.
var manager: FMFManager?
DispatchQueue.main.asyncAfter(deadline: .now() + 0.5) {
    manager = FMFManager(friends: [FMFFriend(name: "Two", identifier: "friend-two")])
}
RunLoop.main.run(until: Date(timeIntervalSinceNow: 6))
