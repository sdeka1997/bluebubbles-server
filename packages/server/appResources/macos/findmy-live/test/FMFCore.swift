import Foundation

public struct FMFFriend {
    public let name: String
    public let identifier: String
    public init(name: String, identifier: String) {
        self.name = name
        self.identifier = identifier
    }
}

open class FMFManager {
    private var storedFriends: [FMFFriend]
    public var friends: [FMFFriend] {
        append("FRIENDS \(Thread.isMainThread ? "main" : "background")")
        return storedFriends
    }
    public init(friends: [FMFFriend]) { self.storedFriends = friends }

    public func startLiveLocation(for friend: FMFFriend, clientApp: String?) {
        append("START \(friend.identifier) \(clientApp ?? "nil") \(Thread.isMainThread ? "main" : "background")")
    }

    public func stopLiveLocation(for friend: FMFFriend) {
        append("STOP \(friend.identifier) \(Thread.isMainThread ? "main" : "background")")
    }

    private func append(_ line: String) {
        guard let path = ProcessInfo.processInfo.environment["BBFM_TEST_LOG"] else { return }
        let data = Data((line + "\n").utf8)
        if !FileManager.default.fileExists(atPath: path) { FileManager.default.createFile(atPath: path, contents: nil) }
        let file = try! FileHandle(forWritingTo: URL(fileURLWithPath: path))
        try! file.seekToEnd()
        try! file.write(contentsOf: data)
        try! file.close()
    }
}
