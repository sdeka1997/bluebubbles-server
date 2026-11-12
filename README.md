# BubbleBeam Server

The Mac half of [BubbleBeam](https://github.com/sdeka1997/bluebubbles-app), an Android client for iMessage. It's a fork of the [BlueBubbles Server](https://github.com/BlueBubblesApp/bluebubbles-server): it runs on a Mac you own, signed in to iMessage, and passes your messages to and from the Android app.

It began as a few fixes to BlueBubbles and grew into the server side of its own app: Find My mirrored from the Mac, Apple's read state, deletions and Spam passed through to Android, and faster answers to the app.

> **BubbleBeam is an independent project.** It isn't made, endorsed or supported by the BlueBubbles team, so please don't take BubbleBeam issues to them.

> The Mac app itself still says "BlueBubbles Server". Only this repository carries the new name so far.

---

## What's different from BlueBubbles

### Find My, mirrored from the Mac
- **Friends, devices and items** are read from the Mac's own Find My data, including the encrypted caches Apple uses from macOS 14.4 on. On those versions, import the three Find My keys under Settings → Features.
- **Live location:** Find My runs on the Mac only while a Find My screen is open in the app, and each new location is sent the moment it arrives. The address follows as a second update.
- **Addresses** come from Apple's own geocoder on the Mac.

### Behaves like your iPhone
- **Read state:** reading a chat, or marking it unread, on a Mac or iPhone reaches Android, including "Mark as Unread" on an iPhone.
- **Deletions:** chats you delete and messages moved to Recently Deleted are passed on to the app.
- **Spam:** the server tells the app which chats Messages filed under Spam.
- **Thread grouping:** each message's service (iMessage, SMS or RCS) and each chat's old group IDs are sent, so the app can group threads the way Messages does.
- **Emoji tapbacks:** any emoji can be sent as a reaction (requires the Private API).

### Faster and steadier
- Loading messages no longer blocks the server for seconds at a time.
- Notifications for large messages, which used to be dropped, now get through, and read events are sent first.
- The app downloads contact photos only when they've changed.
- Self-update is turned off, so the official BlueBubbles updater can't replace this build.

---

## Getting started

1. Set up the Mac as for BlueBubbles: the [BlueBubbles installation guide](https://bluebubbles.app/install/) still applies.
2. Build this repository (see below). There are no packaged releases yet.
3. Build the Android app from [the app repository](https://github.com/sdeka1997/bluebubbles-app) and connect it to the server.

### Building

```bash
./build-server.sh     # Node 22 and npm 10; installs dependencies if they're missing
```

You'll need your own Apple signing setup to package and run a release build.

---

## Branches

- `main`: the server as it runs today. Everything is built from here.
- `master`: an unchanged copy of upstream BlueBubbles, used to track their changes.
- `archive/*` and `backup/*`: old work kept for reference.

---

## Credits and license

BubbleBeam Server is built on the [BlueBubbles Server](https://github.com/BlueBubblesApp/bluebubbles-server), and keeps their work and its history. Thanks to the BlueBubbles team and contributors.

Licensed under the [Apache License 2.0](LICENSE), like BlueBubbles. Files changed in this fork carry those changes in the project's git history.

Mac, iMessage, iPhone, FaceTime and Find My are trademarks of Apple Inc. BubbleBeam isn't affiliated with Apple.
