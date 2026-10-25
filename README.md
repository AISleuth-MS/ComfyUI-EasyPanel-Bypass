## ◄ ComfyUI Bypass Panel ►
## (For Comfy Portable)

A lightweight ComfyUI extension that adds a JavaScript-based panel for managing Subgraph and Group bypass states directly in the workflow UI.

Bypass overrides are saved per workflow and persist across reloads and sessions. State is stored in ►`ComfyUI/user/bypass_panel/bypass_db.json`◄, keeping settings separate from the extension so updates and reinstalls won't erase them.

### 🟢 How To Use
Download this repo, extract the zip and drop it into your ComfyUI Portable folder.
Such as in my case:

►`📂 ComfyUI_windows_portable\ComfyUI\custom_nodes\ComfyUI-Portable-EasyPanel-Bypass`◄

### ⚠️ Known "Bugs"
```
There is one "bug" in that it will not re-enable a Top-level Group or Subgraph that was already manually bypassed, so that it does not accidently flip all of the nodes within it. 
Just make the Group or Subgraph normal first and the panel will function.
```
### Features:

┤► JavaScript-based UI integration

┤► Per-workflow bypass state persistence

┤► Local JSON DB storage

┤► Automatic backup of corrupted database files

┤► No additional Python node files or dependencies required

### To-Do (Priority Listing):
```
│► Add JS for refreshing the panel
└──┤► Currently the panel itself just refreshes on a page load, ctrl+f5, etc. In the event of a node name change, a reload is required at this time.
│► Make it functional for the Desktop App
└──┤► Currently I do not have the Desktop version so... I will attempt it eventually.
```

Feel free to provide feedback, but I am unlikely to actively maintain unless there is a bug that is urgent to patch.
