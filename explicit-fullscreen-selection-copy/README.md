## Explicit fullscreen selection copy

Makes fullscreen selection copy explicit.

Upstream PR https://github.com/earendil-works/pi/pull/7757 adds a setting for
fullscreen copy-on-select and wires the message-copy action to copy an active
selection. This local patch keeps the behavior we need without adding a user
setting: selection can still be highlighted, releasing the mouse does not write
OSC 52 clipboard data, and the normal message-copy shortcut copies the active
fullscreen selection first before falling back to the last assistant message.
