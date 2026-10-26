import { app } from "../../scripts/app.js";
import { api } from "../../scripts/api.js";

const EXTENSION_ID = "custom.bypassPanel";
const API_PATH = "/bypass_panel/state";
const WF_KEY = "bypassPanelId"; // stored inside the workflow's graph.extra
const MODE_ALWAYS = 0;
const MODE_BYPASS = 4;

const originalModes = new Map(); // node -> mode before we touched it
const overrides = new Map();     // stable item key -> Set(node)
const lastApplied = new Set();
const collapsed = new Set();
let panel;
let list;
let statusEl;
let dbOnline = true;
let orphanCount = 0;
let loadToken = 0;

// For updating loadJournal -> renderPanel on workflow edited, instead of requiring a reload.
let panelOpen = false;
let updatePanelDisplay = () => {};
let lastGroupSignature = "";
const observedGraphs = new WeakSet();

// Stability, Keys, Ids, etc.

function rootGraph() {
    return app.rootGraph ?? app.graph;
}

function graphKey(graph) {
    if (!graph || graph === rootGraph()) return "root";
    return String(graph.id ?? "sub");
}

function nodeKey(node) {
    return `${graphKey(node.graph)}:${node.id}`;
}

function groupKey(graph, group) {
    const ident = group.id != null
        ? group.id
        : `${group.title}@${Math.round(group.pos[0])},${Math.round(group.pos[1])}`;
    return `group:${graphKey(graph)}:${ident}`;
}

function subgraphKey(graph, node) {
    return `subgraph:${graphKey(graph)}:${node.id}`;
}

function newId() {
    // Note to self: crypto.randomUUID only exists on https/localhost - ComfyUI is often opened via LAN http.
    return globalThis.crypto?.randomUUID?.() ??
        `${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`;
}

function ensureWorkflowId() {
    const graph = rootGraph();
    if (!graph) return null;
    graph.extra ??= {};
    if (!graph.extra[WF_KEY]) graph.extra[WF_KEY] = newId();
    return graph.extra[WF_KEY];
}

// Graph helpers

function graphNodes(graph) {
    return graph?.nodes ?? [];
}

function graphGroups(graph) {
    return graph?._groups ?? [];
}

function nodeBounds(node) {
    const pos = node.pos ?? [0, 0];
    const size = node.size ?? [0, 0];
    return { x: pos[0], y: pos[1], w: size[0], h: size[1] };
}

function containsPoint(rect, point) {
    return point[0] >= rect.x && point[0] <= rect.x + rect.w &&
        point[1] >= rect.y && point[1] <= rect.y + rect.h;
}

function containsRect(outer, inner) {
    return inner.x >= outer.x && inner.y >= outer.y &&
        inner.x + inner.w <= outer.x + outer.w &&
        inner.y + inner.h <= outer.y + outer.h;
}

function collectNodes(nodes, result = new Set(), visited = new Set()) {
    for (const node of nodes) {
        if (!node || visited.has(node)) continue;
        visited.add(node);
        result.add(node);
        if (node.subgraph) collectNodes(graphNodes(node.subgraph), result, visited);
    }
    return result;
}

function buildHierarchy(graph, visited = new Set()) {
    if (!graph || visited.has(graph)) return [];
    visited.add(graph);

    const nodes = graphNodes(graph);
    const groups = graphGroups(graph).map(group => ({
        id: groupKey(graph, group),
        name: group.title || "Group",
        type: "group",
        object: group,
        rect: { x: group.pos[0], y: group.pos[1], w: group.size[0], h: group.size[1] },
        children: [],
        affected: new Set()
    }));

    const subgraphs = nodes.filter(node => node.subgraph).map(node => ({
        id: subgraphKey(graph, node),
        name: node.title || node.type || "Subgraph",
        type: "subgraph",
        object: node,
        rect: nodeBounds(node),
        children: buildHierarchy(node.subgraph, visited),
        affected: collectNodes([node])
    }));

    for (const group of groups) {
        for (const node of nodes) {
            if (containsPoint(group.rect, node.pos ?? [0, 0])) {
                group.affected.add(node);
                if (node.subgraph) collectNodes(graphNodes(node.subgraph), group.affected);
            }
        }
    }

    for (const outer of groups) {
        for (const inner of groups) {
            if (outer === inner || !containsRect(outer.rect, inner.rect)) continue;
            const intermediate = groups.some(candidate =>
                candidate !== outer && candidate !== inner &&
                containsRect(outer.rect, candidate.rect) &&
                containsRect(candidate.rect, inner.rect)
            );
            if (!intermediate) outer.children.push(inner);
        }
    }

    for (const group of groups) {
        for (const subgraph of subgraphs) {
            if (!containsRect(group.rect, subgraph.rect)) continue;
            const intermediate = groups.some(candidate =>
                candidate !== group &&
                containsRect(group.rect, candidate.rect) &&
                containsRect(candidate.rect, subgraph.rect)
            );
            if (!intermediate) group.children.push(subgraph);
        }
        group.children = [...new Set(group.children)];
    }

    const nested = new Set(itemsNested(groups));
    return [...groups, ...subgraphs].filter(item => !nested.has(item));
}

function itemsNested(groups) {
    return groups.flatMap(group => group.children);
}

// Database backend

function buildRecord() {
    const nodes = {};
    const ov = {};
    for (const [itemKey, set] of overrides) {
        ov[itemKey] = [];
        for (const node of set) {
            const key = nodeKey(node);
            ov[itemKey].push(key);
            nodes[key] = originalModes.get(node) ?? MODE_ALWAYS;
        }
    }
    return { nodes, overrides: ov };
}

async function saveJournal() {
    const wf = ensureWorkflowId();
    if (!wf) return false;
    try {
        const res = await api.fetchApi(API_PATH, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ wf, record: buildRecord() })
        });
        dbOnline = res.ok;
    } catch (error) {
        console.warn(`[${EXTENSION_ID}] journal save failed`, error);
        dbOnline = false;
    }
    updateStatus();
    return dbOnline;
}

async function loadJournal() {
    const token = ++loadToken;
    originalModes.clear();
    overrides.clear();
    lastApplied.clear();

    const wf = ensureWorkflowId();
    if (!wf) return;

    let record;
    try {
        const res = await api.fetchApi(`${API_PATH}?wf=${encodeURIComponent(wf)}`);
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        record = await res.json();
        dbOnline = true;
    } catch (error) {
        console.warn(`[${EXTENSION_ID}] journal load failed`, error);
        dbOnline = false;
        updateStatus();
        return;
    }
    if (token !== loadToken) return; // a newer load (tab switch) supersedes this iteration

    const live = new Map();
    for (const node of collectNodes(graphNodes(rootGraph()))) live.set(nodeKey(node), node);

    // Only re-adopt nodes that are STILL bypassed. Anything else was already restored
    // (or deleted), so the journal entry is stale and gets dropped.
    let changed = false;
    for (const [itemKey, keys] of Object.entries(record.overrides ?? {})) {
        const set = new Set();
        for (const key of keys) {
            const node = live.get(key);
            if (!node || (node.mode ?? MODE_ALWAYS) !== MODE_BYPASS) {
                changed = true;
                continue;
            }
            set.add(node);
            originalModes.set(node, record.nodes?.[key] ?? MODE_ALWAYS);
        }
        if (set.size) overrides.set(itemKey, set);
        else changed = true;
    }

    applyOverrides();
    if (changed) await saveJournal();
}

// Override logic

function isForcedOff(node) {
    for (const nodes of overrides.values()) {
        if (nodes.has(node)) return true;
    }
    return false;
}

function applyOverrides() {
    const affected = new Set([...originalModes.keys(), ...lastApplied]);

    for (const nodes of overrides.values()) {
        for (const node of nodes) {
            if (!originalModes.has(node)) originalModes.set(node, node.mode ?? MODE_ALWAYS);
            affected.add(node);
        }
    }

    for (const node of affected) {
        if (isForcedOff(node)) {
            node.mode = MODE_BYPASS;
            lastApplied.add(node);
        } else {
            if (lastApplied.has(node)) node.mode = originalModes.get(node) ?? MODE_ALWAYS;
            lastApplied.delete(node);
            originalModes.delete(node); // don't keep stale "original" values around
        }
    }

    app.graph?.setDirtyCanvas(true, true);
}

function isItemDisabled(item) {
    if (overrides.has(item.id)) return true;

    if (item.type === "subgraph" && item.object.mode === MODE_BYPASS) return true;

    const nodes = [...item.affected];
    return nodes.length > 0 && nodes.every(node => (node.mode ?? MODE_ALWAYS) === MODE_BYPASS);
}

async function toggleItem(item) {
    if (isItemDisabled(item)) {
        // RESTORE: apply first, journal second. A crash in between leaves a stale journal
        // entry, which loadJournal() discards because the node is no longer bypassed.
        overrides.delete(item.id);
        applyOverrides();
        await saveJournal();
    } else {
        // BYPASS: journal first, apply second. A crash in between can never leave
        // bypassed nodes that the DB doesn't know about.
        for (const node of item.affected) {
            if (!originalModes.has(node)) originalModes.set(node, node.mode ?? MODE_ALWAYS);
        }
        overrides.set(item.id, new Set(item.affected));
        await saveJournal();
        applyOverrides();
    }
    renderPanel();
}

async function restoreAll() {
    overrides.clear();
    applyOverrides();
    await saveJournal();
    renderPanel();
}

// UI handling

function updateStatus() {
    if (!statusEl) return;
    const parts = [dbOnline ? `${overrides.size} forced · DB ok` : "⚠ DB offline, not persisted"];
    if (orphanCount) parts.push(`${orphanCount} unmatched (use Restore all)`);
    statusEl.textContent = parts.join(" · ");
    statusEl.style.color = dbOnline ? "#8a8f98" : "#ff8a80";
}

function makeSwitch(item) {
    const disabled = isItemDisabled(item);
    const button = document.createElement("button");
    button.className = `bp-switch ${disabled ? "bp-off" : "bp-on"}`;
    button.type = "button";
    button.setAttribute("role", "switch");
    button.setAttribute("aria-checked", String(!disabled));
    button.title = disabled ? "Restore original node states" : "Bypass this group";

    const knob = document.createElement("span");
    knob.className = "bp-knob";
    button.append(knob);
    button.addEventListener("click", event => {
        event.stopPropagation();
        toggleItem(item);
    });
    return button;
}

function renderItems(items, parent, depth = 0) {
    for (const item of items) {
        const row = document.createElement("div");
        row.className = "bp-row";
        row.style.paddingLeft = `${depth * 12 + 6}px`;

        if (item.children.length) {
            const expand = document.createElement("button");
            expand.className = "bp-expand";
            expand.textContent = collapsed.has(item.id) ? "›" : "⌄";
            expand.title = collapsed.has(item.id) ? "Expand" : "Collapse";
            expand.addEventListener("click", event => {
                event.stopPropagation();
                if (collapsed.has(item.id)) collapsed.delete(item.id);
                else collapsed.add(item.id);
                renderPanel();
            });
            row.append(expand);
        } else {
            const spacer = document.createElement("span");
            spacer.className = "bp-expand-spacer";
            row.append(spacer);
        }

        const label = document.createElement("span");
        label.className = "bp-label";
        label.textContent = item.name;
        label.title = `${item.type}: ${item.name}`;
        row.append(label, makeSwitch(item));
        parent.append(row);

        if (item.children.length && !collapsed.has(item.id)) {
            renderItems(item.children, parent, depth + 1);
        }
    }
}

function observeGraphRefresh(graph, visited = new Set()) {
    if (!graph || visited.has(graph)) return;
    visited.add(graph);

    if (!observedGraphs.has(graph) && typeof graph.setDirtyCanvas === "function") {
        const original = graph.setDirtyCanvas;
        graph.setDirtyCanvas = function(...args) {
            const result = original.apply(this, args);
            if (panelOpen) requestAnimationFrame(checkGroupChanges);
            return result;
        };
        observedGraphs.add(graph);
    }

    for (const node of graphNodes(graph)) {
        if (node?.subgraph) observeGraphRefresh(node.subgraph, visited);
    }
}

function renderPanel() {
    const graph = rootGraph();
    if (!list || !graph) return;
	
	observeGraphRefresh(graph);
	
    lastGroupSignature = JSON.stringify(getGroupSignature(graph));

    list.replaceChildren();
    const tree = buildHierarchy(graph);
    renderItems(tree, list);

    const ids = new Set();
    (function walk(items) {
        for (const item of items) {
            ids.add(item.id);
            walk(item.children);
        }
    })(tree);

    orphanCount = [...overrides.keys()].filter(key => !ids.has(key)).length;
    updateStatus();
}

function createPanel() {
    if (panel) return;

    const style = document.createElement("style");
    style.textContent = `
        #bp-panel {
            position: fixed; left: clamp(60px, 4vw, 160px); top: clamp(150px, 21.75vh, 300px); z-index: 10000;
            width: 250px; max-height: 70vh; display: flex; flex-direction: column;
            color: var(--fg-color, #ddd); background: var(--comfy-menu-bg, #202226);
            border: 1px solid #44474d; border-radius: 8px;
            box-shadow: 0 4px 18px #0005; font: 12px sans-serif;
        }
        #bp-panel[hidden] { display: none !important; }
        #bp-tab[hidden] { display: none !important; }
        #bp-header {
            display: flex; align-items: center; justify-content: space-between; gap: 6px;
            padding: 9px 10px; border-bottom: 1px solid #3b3e43; font-weight: 600;
        }
        #bp-title { flex: 1; }
        #bp-restore {
            background: #2f3237; color: #ddd; border: 1px solid #494c52; border-radius: 4px;
            font-size: 11px; padding: 2px 6px; cursor: pointer;
        }
        #bp-restore:hover { background: #3a3d43; }
        #bp-status { padding: 4px 10px; font-size: 10.5px; border-bottom: 1px solid #2c2f33; }
        #bp-list { overflow-y: auto; padding: 4px 4px 6px; }
        .bp-row { display: flex; align-items: center; gap: 5px; min-height: 29px; }
        .bp-row:hover { background: #ffffff0b; border-radius: 4px; }
        .bp-label { flex: 1; overflow: hidden; white-space: nowrap; text-overflow: ellipsis; }
        .bp-expand, .bp-expand-spacer { width: 18px; height: 22px; flex: 0 0 18px; }
        .bp-expand {
            color: #aaa; background: transparent; border: 0; cursor: pointer;
            font-size: 17px; padding: 0;
        }
        .bp-switch {
            position: relative; width: 34px; height: 18px; flex: 0 0 34px;
            border: 0; border-radius: 12px; padding: 2px; cursor: pointer;
            transition: background .16s, box-shadow .16s;
        }
        .bp-off { background: #562858; }
        .bp-on { background: #28583b; box-shadow: 0 0 8px #6bdc8a35; }
        .bp-knob {
            display: block; width: 14px; height: 14px; border-radius: 50%;
            background: #c9a0e7; transform: translateX(0);
            transition: transform .16s, background .16s;
        }
        .bp-on .bp-knob { transform: translateX(16px); background: #a0e7b3; }
        #bp-close {
            background: transparent; border: 0; color: #aaa; cursor: pointer;
            font-size: 16px; padding: 0 2px;
        }
        #bp-tab {
            position: fixed; left: clamp(60px, 4vw, 160px); top: clamp(120px, 19vh, 200px); z-index: 10001;
            border: 1px solid #44474d; border-radius: 5px;
            padding: 6px 9px; background: #202226; color: #ddd; cursor: pointer;
        }
    `;
    document.head.append(style);

    const tab = document.createElement("button");
    tab.id = "bp-tab";
    tab.type = "button";
    tab.textContent = "⇆ Bypass";
    tab.addEventListener("click", () => {
		panelOpen = !panelOpen;
		if (panelOpen) renderPanel();
		updatePanelDisplay();
	});

    panel = document.createElement("section");
    panel.id = "bp-panel";
    panel.hidden = true;

    const header = document.createElement("div");
    header.id = "bp-header";

    const title = document.createElement("span");
    title.id = "bp-title";
    title.textContent = "Groups & Subgraphs";

    const restore = document.createElement("button");
    restore.id = "bp-restore";
    restore.type = "button";
    restore.textContent = "Restore all";
    restore.title = "Undo every bypass this panel applied in this workflow";
    restore.addEventListener("click", () => restoreAll());

    const close = document.createElement("button");
    close.id = "bp-close";
    close.type = "button";
    close.textContent = "×";
    close.addEventListener("click", () => {
		panelOpen = false;
		updatePanelDisplay();
	});

    header.append(title, restore, close);

    statusEl = document.createElement("div");
    statusEl.id = "bp-status";
    list = document.createElement("div");
    list.id = "bp-list";
    panel.append(header, statusEl, list);
    document.body.append(tab, panel);
    updateStatus();
}

function getGroupSignature(graph, visited = new Set()) {
    if (!graph || visited.has(graph)) return [];
    visited.add(graph);

    const signature = graphGroups(graph).map(group => [
        group.id,
        group.title,
        group.pos?.[0],
        group.pos?.[1],
        group.size?.[0],
        group.size?.[1]
    ]);

    for (const node of graphNodes(graph)) {
        if (node?.subgraph) {
            signature.push(...getGroupSignature(node.subgraph, visited));
        }
    }

    return signature;
}

function checkGroupChanges() {
    const graph = rootGraph();
    if (!graph) return;

    const signature = JSON.stringify(getGroupSignature(graph));

    if (signature === lastGroupSignature) return;

    lastGroupSignature = signature;
    renderPanel();
}

// This is objectively better and does not require reloading.
// However, I have not perfected it at this time.
// The panel still requires interacting with to update its text display.
// Otherwise, reloading to update the panel is no longer a limiting factor.

function observeWorkflowTabs() {
    const selector = '[data-testid="topbar-workflow-tabs"]';
    let previousState = null;
    let scheduled = false;

    const refresh = () => {
        scheduled = false;
        renderPanel();
    };

    const observer = new MutationObserver(() => {
        const button = document.querySelector(`${selector} [data-testid="close-workflow-button"]`);
        if (!button) return;

        const state = button.classList.contains("invisible");

        if (previousState === null) {
            previousState = state;
            return;
        }

        if (state === previousState) return;
        previousState = state;

        if (scheduled) return;
        scheduled = true;
        requestAnimationFrame(refresh);
    });

    const attach = () => {
        const tabs = document.querySelector(selector);
        if (!tabs) return false;

        observer.observe(tabs, {
            subtree: true,
            attributes: true,
            attributeFilter: ["class"]
        });

        return true;
    };

    if (!attach()) {
        const finder = new MutationObserver(() => {
            if (attach()) finder.disconnect();
        });

        finder.observe(document.documentElement, { childList: true, subtree: true });
    }
}

app.registerExtension({
    name: EXTENSION_ID,
    async setup() {
        createPanel();
        renderPanel();
		observeWorkflowTabs();
		
		// Hide panel when sidebar is open OR when it is hidden (Settings opens up, etc)
		updatePanelDisplay = () => {
			const sidebar = document.querySelector(".side-toolbar-container");
			const target = document.getElementById('bp-tab');
			const targetTwo = document.getElementById('bp-panel');
            if (!sidebar || !target || !targetTwo) return;

            const group = document.querySelector('[data-panel-group][data-panel-group-id="reka-splitter-group-v-19"]');

            const sidebarHidden = sidebar.getAttribute("data-aria-hidden") === "true" || sidebar.getAttribute("aria-hidden") === "true";

            const hasOpenPanel = group && [...group.children].some(panel => {
                if (!panel.matches("[data-panel]") || panel.id === "main-panel") return false;

                const style = getComputedStyle(panel);
                const size = parseFloat(panel.dataset.panelSize || "0");

                return size > 0 && style.display !== "none" && style.visibility !== "hidden" && panel.getClientRects().length > 0;
            });

            target.hidden = sidebarHidden || !!hasOpenPanel;
			targetTwo.hidden = !panelOpen || sidebarHidden || !!hasOpenPanel;
        };

        const observer = new MutationObserver(updatePanelDisplay);

        observer.observe(document.body, {
            childList: true,
            subtree: true,
            attributes: true,
            attributeFilter: ["style", "class", "data-panel-size", "data-aria-hidden", "aria-hidden"]
        });

        updatePanelDisplay();
    }
});
