#import <Foundation/Foundation.h>
#import <objc/runtime.h>
#import <malloc/malloc.h>
#import <mach/mach.h>
#import <os/log.h>
#import <errno.h>
#import <poll.h>
#import <sys/socket.h>
#import <sys/stat.h>
#import <sys/un.h>
#import <time.h>
#import <unistd.h>
#import <dlfcn.h>

typedef int32_t (*StartLive)(void *, const char *);
typedef int32_t (*StopLive)(void *);
static os_log_t logHandle;
static Class managerClass;
static id managerObject;
static unsigned managersFound;
static StartLive startLive;
static StopLive stopLive;
static NSString *token;
static NSString *socketPath;
static int listener = -1;

static kern_return_t reader(task_t task, vm_address_t address, vm_size_t size, void **pointer) {
    (void)task; (void)size; *pointer = (void *)address; return KERN_SUCCESS;
}

static void recordManager(task_t task, void *context, unsigned type, vm_range_t *ranges, unsigned count) {
    (void)task; (void)context; (void)type;
    for (unsigned i = 0; i < count; i++) {
        if (ranges[i].size < sizeof(void *)) continue;
        void *candidate = (void *)ranges[i].address;
        void *isa = NULL;
        memcpy(&isa, candidate, sizeof(isa));
        if (isa == (__bridge void *)managerClass) {
            managersFound++;
            if (!managerObject) managerObject = (__bridge id)candidate;
        }
    }
}

static void findManager(void) {
    managerClass = NSClassFromString(@"FMFCore.FMFManager");
    if (!managerClass || !startLive || !stopLive) return;
    vm_address_t *zones = NULL;
    unsigned zoneCount = 0;
    if (malloc_get_all_zones(mach_task_self(), reader, &zones, &zoneCount) != KERN_SUCCESS) return;
    for (unsigned i = 0; i < zoneCount; i++) {
        malloc_zone_t *zone = (malloc_zone_t *)zones[i];
        if (zone && zone->introspect && zone->introspect->enumerator) {
            zone->introspect->enumerator(mach_task_self(), NULL, MALLOC_PTR_IN_USE_RANGE_TYPE,
                                        (vm_address_t)zone, reader, recordManager);
        }
    }
    os_log_info(logHandle, "manager scan count=%u ready=%{public}s", managersFound, managerObject ? "yes" : "no");
}

static NSData *response(NSString *status, NSString *error) {
    NSMutableDictionary *body = [@{ @"status": status } mutableCopy];
    if (error) body[@"error"] = error;
    NSData *json = [NSJSONSerialization dataWithJSONObject:body options:0 error:nil];
    NSMutableData *line = [json mutableCopy];
    [line appendBytes:"\n" length:1];
    return line;
}

static void writeAll(int fd, NSData *data) {
    const uint8_t *bytes = data.bytes;
    NSUInteger sent = 0;
    while (sent < data.length) {
        ssize_t count = write(fd, bytes + sent, data.length - sent);
        if (count <= 0) return;
        sent += (NSUInteger)count;
    }
}

static int64_t monotonicMilliseconds(void) {
    struct timespec value;
    clock_gettime(CLOCK_MONOTONIC, &value);
    return (int64_t)value.tv_sec * 1000 + value.tv_nsec / NSEC_PER_MSEC;
}

static NSDictionary *readRequest(int client) {
    const int64_t deadline = monotonicMilliseconds() + 1000;
    NSMutableData *data = [NSMutableData data];
    while (data.length < 8192) {
        int64_t remaining = deadline - monotonicMilliseconds();
        if (remaining <= 0) return nil;
        struct pollfd descriptor = { .fd = client, .events = POLLIN };
        int ready = poll(&descriptor, 1, (int)remaining);
        if (ready < 0 && errno == EINTR) continue;
        if (ready <= 0 || !(descriptor.revents & POLLIN)) return nil;
        uint8_t bytes[1024];
        size_t capacity = MIN(sizeof(bytes), 8192 - data.length);
        ssize_t count = read(client, bytes, capacity);
        if (count <= 0) return nil;
        void *newline = memchr(bytes, '\n', (size_t)count);
        NSUInteger accepted = newline ? (NSUInteger)((uint8_t *)newline - bytes) + 1 : (NSUInteger)count;
        [data appendBytes:bytes length:accepted];
        if (!newline) continue;
        id value = [NSJSONSerialization JSONObjectWithData:data options:0 error:nil];
        return [value isKindOfClass:NSDictionary.class] ? value : nil;
    }
    return nil;
}

static void serveClient(int client) {
    NSDictionary *request = readRequest(client);
    NSData *reply;
    if (!request) {
        reply = response(@"error", @"invalid request");
    } else if (![request[@"token"] isEqual:token]) {
        reply = response(@"error", @"unauthorized");
    } else {
        __block NSData *commandReply;
        dispatch_sync(dispatch_get_main_queue(), ^{
            if (!managerObject) {
                commandReply = response(@"error", @"Find My is not ready");
            } else if ([request[@"command"] isEqual:@"start"] && [request[@"id"] isKindOfClass:NSString.class]) {
                int32_t result = startLive((__bridge void *)managerObject, [request[@"id"] UTF8String]);
                commandReply = result == 0 ? response(@"ok", nil)
                                           : response(@"error", result == 1 ? @"friend not found" : @"friend id is not unique");
            } else if ([request[@"command"] isEqual:@"stop"]) {
                stopLive((__bridge void *)managerObject);
                commandReply = response(@"ok", nil);
            } else {
                commandReply = response(@"error", @"unsupported command");
            }
        });
        reply = commandReply;
    }
    writeAll(client, reply);
}

static void listenForCommands(void) {
    unlink(socketPath.fileSystemRepresentation);
    listener = socket(AF_UNIX, SOCK_STREAM, 0);
    if (listener < 0) return;
    struct sockaddr_un address = {0};
    address.sun_family = AF_UNIX;
    const char *path = socketPath.fileSystemRepresentation;
    if (strlen(path) >= sizeof(address.sun_path)) {
        close(listener);
        listener = -1;
        return;
    }
    strlcpy(address.sun_path, path, sizeof(address.sun_path));
    if (bind(listener, (struct sockaddr *)&address, sizeof(address)) != 0 || chmod(path, 0600) != 0 || listen(listener, 4) != 0) {
        close(listener); listener = -1; unlink(path); return;
    }
    while (listener >= 0) {
        int client = accept(listener, NULL, NULL);
        if (client < 0) continue;
        int noSigPipe = 1;
        if (setsockopt(client, SOL_SOCKET, SO_NOSIGPIPE, &noSigPipe, sizeof(noSigPipe)) != 0) {
            close(client);
            continue;
        }
        serveClient(client);
        close(client);
    }
}

#ifdef BBFM_TEST
void bbfm_set_test_manager(void *pointer) {
    managerObject = pointer ? (__bridge id)pointer : nil;
    managersFound = pointer ? 1 : 0;
}
#endif

__attribute__((constructor)) static void loadBridge(void) {
    @autoreleasepool {
        logHandle = os_log_create("com.bluebubbles.findmy-live", "bridge");
        NSDictionary *environment = NSProcessInfo.processInfo.environment;
        token = environment[@"BBFM_LIVE_TOKEN"];
        socketPath = environment[@"BBFM_LIVE_SOCKET"];
        startLive = (StartLive)dlsym(RTLD_DEFAULT, "bbfm_start_live");
        stopLive = (StopLive)dlsym(RTLD_DEFAULT, "bbfm_stop_live");
        if (token.length < 32 || socketPath.length == 0) return;
        dispatch_async(dispatch_get_global_queue(QOS_CLASS_USER_INITIATED, 0), ^{ listenForCommands(); });
        long delayMs = [environment[@"BBFM_LIVE_SCAN_DELAY_MS"] longLongValue];
        if (delayMs <= 0) delayMs = 15000;
        dispatch_after(dispatch_time(DISPATCH_TIME_NOW, delayMs * NSEC_PER_MSEC), dispatch_get_main_queue(), ^{ findManager(); });
    }
}

__attribute__((destructor)) static void unloadBridge(void) {
    if (listener >= 0) close(listener);
    if (socketPath) unlink(socketPath.fileSystemRepresentation);
}
