## ComfyUI Bypass Panel
## (For Comfy Portable)

A lightweight ComfyUI extension that adds a JavaScript-based panel for managing node bypass states directly in the workflow UI.

Bypass overrides are saved per workflow and persist across reloads and sessions. State is stored in `ComfyUI/user/bypass_panel/bypass_db.json`, keeping settings separate from the extension so updates and reinstalls won't erase them.

### There is one "bug" in that it will not re-enable a Group or Subgraph that was manually already bypassed, so that it does not accidently flip all of the nodes within it.

### Features:
- JavaScript-based UI integration
- Per-workflow bypass state persistence
- Server-side JSON storage with atomic writes
- Automatic backup of corrupted database files
- No additional Python node files or dependencies required

### To-Do:
```
│ Add JS for refreshing the panel
└ Currently it just refreshes on a page load, ctrl+f5, etc.
```


Feel free to provide feedback, but I am unlikely to actively maintain unless there is a bug that is urgent to patch.
