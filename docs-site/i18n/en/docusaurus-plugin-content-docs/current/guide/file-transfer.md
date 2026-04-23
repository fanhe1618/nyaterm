---
sidebar_position: 2
---

# SFTP File Transfer

Dragonfly's remote file workflow is built on top of SSH sessions. That means the **file explorer, SFTP transfers, and local-edit-then-upload-back workflow** are only available in SSH sessions. Local Terminal, Telnet, and Serial do not expose this set of features.

## File explorer

After connecting an SSH session, the file explorer panel lets you browse remote directories directly.

Core capabilities include:

- Automatically entering the remote user's home directory
- Entering folders, going up, and jumping by typing a path
- Refreshing the current directory
- Syncing with the terminal's working directory
- Disabling auto-sync when the session does not support path tracking

## Common file operations

From the file list or the context menu, you can perform:

| Operation | Description |
|------|------|
| Open | Download to a local temp directory, then open with the default editor |
| Upload File | Upload a local file to the current remote directory |
| Upload Folder | Upload a full local directory tree |
| Download | Download a file or an entire directory |
| Rename | Change the remote name |
| Move | Move a file or directory to another path |
| Delete | Remove a file or directory |
| Properties | View size, timestamps, UID/GID, permissions, and more |
| New File / Folder / Symlink | Create entries directly in the current directory |

The **Open** action is not just a preview. It prepares the round-trip editing flow.

## Uploads and downloads

### Upload

Use the toolbar, context menu, or drag and drop to upload local content into the current remote directory.

- Multiple files are queued one by one
- Folder uploads preserve directory structure
- Good for syncing scripts, config files, or release packages

### External drag-and-drop upload

The file explorer supports dragging **files or folders from your system file manager directly into the Dragonfly file browser** for upload.

Typical flow:

1. Open an SSH session and switch to the file explorer
2. Drag a local file or folder into the file list area
3. Release when the drag overlay appears
4. Dragonfly adds the dropped items to the upload flow automatically

Notes:

- Upload is only triggered when you drop onto the file browser list area
- Some drag sources do not expose a real local file path. In that case, Dragonfly cannot resolve the dropped item directly and will prompt you to use **Upload File** or **Upload Folder** instead

### Download

Downloads usually follow one of two workflows:

- Save directly into a default download directory
- Ask for a destination every time for ad hoc troubleshooting or task-based organization

Both file downloads and directory downloads are supported.

## Transfer panel and transfer settings

Dragonfly puts uploads and downloads into a shared transfer queue so you can inspect:

- Current progress
- Success, paused, canceled, and failed states
- Concurrent transfers
- The current download target

Each transfer item supports:

- **Pause**
- **Resume**
- **Cancel**
- **Retry after failure**
- **Remove after completion**

The panel also provides bulk actions:

- **Pause All**
- **Resume All**
- **Cancel All**
- **Clear Completed**

In **Settings → Transfer**, you can adjust:

- Upload / download thread count
- Conflict handling strategy
- Maximum retry count
- Transfer buffer size
- Whether to preserve timestamps
- Whether to continue resumable transfers
- Default file permissions
- Default download path
- Whether to ask for the save location every time
- The local editor used when opening remote files

## Sync with terminal paths

The file explorer can work together with the current SSH terminal path:

- **Manual Sync** — jump the explorer to the terminal's current directory
- **Auto Sync** — automatically follow when the terminal changes directories

This is useful when you are moving around in a deploy or log directory and want the file panel to stay aligned.

## Edit locally and upload back automatically

This is one of Dragonfly's most practical workflows for real operations work.

### How it works

1. In the SSH file explorer, choose **Open** on a remote file
2. Dragonfly downloads it into a local temp directory
3. A file watcher is started
4. After you save in your local editor, Dragonfly opens an upload prompt

### Upload prompt window

After the file changes, you can choose:

- **Upload once**
- **Always upload**
- **Cancel**

If you choose **Always upload** for a file, later saves in the **current session** are sent back automatically without prompting again.

### Good fits

- Editing remote config files
- Tweaking deploy scripts
- Pulling a file locally for inspection, then sending changes back
- Preparing screenshots that demonstrate the round-trip editing flow

## File properties and permissions

The **Properties** view shows:

- File size
- Modified time and access time
- Owner and group
- UID / GID
- Octal permission values

If your workflow requires checking permissions before replacing a file, this is often clearer than relying only on `ls -l`.

:::tip Screenshot suggestion
- Suggested image path: `/img/docs/file-transfer/remote-file-browser.png`
- Show an SSH session with the file browser, toolbar, and context menu visible
- Another good image path: `/img/docs/file-transfer/auto-upload-dialog.png`
- Open a remote text file, save it in a local editor, and capture the auto-upload prompt
:::
