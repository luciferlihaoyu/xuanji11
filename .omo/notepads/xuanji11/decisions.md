# Phase 6 — Local Auth bcrypt Migration

- Use `bcrypt.hash(password, 10)` for all new admin password hashes, including `auth.changePassword`, by changing only the shared `hashPassword` helper.
- Keep deterministic scrypt only as a legacy verification fallback for 128-character hex hashes that do not start with `$2`; bcrypt hashes are verified first with `bcrypt.compare`.
- On successful legacy verification, immediately persist a bcrypt replacement to `system_settings.admin_password_hash` so migration happens during normal login without forcing password resets.
- Derive `signLocalToken` expiry from `Session.maxAgeMs` as `${Math.floor(Session.maxAgeMs / 1000)}s` so JWT lifetime matches the 365-day session cookie max age.
# Decisions — Xuanji Knowledge Graph UI

## Phase 4: Context Menu, Node Editing, Create Node Button

### D1: Metadata merge strategy for updateNode
- **Decision**: Spread existing `metadata` before overwriting `tags` and `importance` in the update handler.
- **Rationale**: The `updateNode` tRPC mutation does `db.update(...).set(clean(data))` which REPLACES the entire `metadata` JSON column. Without merging, other metadata fields (e.g. `documentId` used by `deleteNode` for vector cleanup) would be silently lost.
- **Implementation**: `handleUpdateNode` in `KnowledgeGraph.tsx` reads `existing.metadata` from `renderNodes` and spreads it: `metadata: { ...existingMetadata, tags: data.tags, importance: data.importance }`.

### D2: Context menu as React overlay, not D3 DOM
- **Decision**: The right-click context menu is rendered as a React component positioned absolutely within the container, not as D3-appended DOM elements.
- **Rationale**: Keeps the D3 rendering core untouched (per MUST NOT constraints), allows React event handling and state management, and matches the existing pattern where UI overlays (NodeDetailPanel, GraphControlPanel, modals) are React components positioned over the SVG.
- **Implementation**: D3 `.on('contextmenu')` handler calls `event.preventDefault()` + `setContextMenu({ x, y, nodeId })`. React renders the menu at those coordinates. A `useEffect` attaches window-level `click`/`contextmenu`/`keydown` listeners to close the menu.

### D3: Edit trigger via `editTriggerId` state
- **Decision**: Use a separate `editTriggerId` state (not a boolean) to trigger edit mode in NodeDetailPanel from the context menu.
- **Rationale**: When the user right-clicks a node and selects "编辑节点", the panel needs to open AND start in edit mode. A simple boolean would not distinguish between "edit triggered for this node" vs "edit triggered for a different node". Using the node ID ensures the `startInEdit` prop is only true when the panel is showing the correct node.
- **Implementation**: `editTriggerId` is set to the node ID on context menu "编辑节点". NodeDetailPanel receives `startInEdit={editTriggerId === selectedNodeData.id}`. `onEditDone` clears `editTriggerId` to null.

### D4: Renamed "添加节点" to "新建节点"
- **Decision**: Renamed the existing add-node button text from "添加节点" to "新建节点" to match the task spec exactly.
- **Rationale**: The existing button already used `createNode` and opened a modal — it satisfied the functional requirement. Only the label needed changing. Also enhanced the modal with `importance` (range slider) and `tags` (comma-separated input) fields for consistency with the edit form.

### D5: Confirmation dialog on context-menu delete
- **Decision**: Added a `confirm()` dialog to `handleContextMenuDelete`, matching the existing NodeDetailPanel delete button behavior.
- **Rationale**: The existing `handleDeleteNode` function does NOT confirm — confirmation was in the panel's onClick handler. The context menu delete should have the same safety guard.
