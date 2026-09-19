import GLib from 'gi://GLib'
import Mtk from 'gi://Mtk'
import Meta from 'gi://Meta'
import Shell from 'gi://Shell'
import * as Main from 'resource:///org/gnome/shell/ui/main.js'
import { debug, debounce, TimeoutManager } from './utils.js'
import {
    MAXIMIZED_NONE,
    MAXIMIZED_HORIZONTAL,
    MAXIMIZED_VERTICAL,
    MAXIMIZED_BOTH,
    isValidGeometry,
    EXTRACTION_PROPS,
    shouldDebounceEvent
} from './window-state.js'

/**
 * Extract detailed properties from a MetaWindow.
 * Uses property lists from tracker configuration for consistency.
 *
 * @param {Meta.Window} win - The window to inspect
 * @param {Object} extractionProps - Optional property extraction config (uses EXTRACTION_PROPS if not provided)
 * @returns {Object} Serialized window details
 */
export function getWindowState(win, extractionProps = EXTRACTION_PROPS) {
    const details = {}

    for (const propName of extractionProps.direct) {
        if (win[propName] !== undefined) {
            details[propName] = win[propName]
        }
    }

    for (const getter of extractionProps.getters) {
        const methodName = `get_${getter}`
        if (typeof win[methodName] === 'function') {
            const value = win[methodName]()
            if (value instanceof Mtk.Rectangle) {
                details[getter] = {
                    x: value.x,
                    y: value.y,
                    width: value.width,
                    height: value.height,
                }
            } else {
                details[getter] = value
            }
        }
    }

    for (const booleanProp of extractionProps.booleans) {
        if (typeof win[booleanProp] === 'function') {
            details[booleanProp] = win[booleanProp]()
        }
    }

    // Transient parent (e.g. dialogs attached to a parent window)
    const transientFor = win.get_transient_for?.()
    details.transient_for = transientFor ? transientFor.get_id() : null

    // Specific properties
    details.workspace = win.get_workspace()?.index() ?? -1
    details.on_all_workspaces = win.is_on_all_workspaces()
    details.fullscreen = win.is_fullscreen()
    details.above = win.is_above()

    // GNOME Shell 49+: get_maximized() was removed
    // Use is_maximized() for full maximize, get_maximize_flags() for partial (tiled)
    // See: https://gjs.guide/extensions/upgrading/gnome-shell-49.html
    if (win.is_maximized?.()) {
        // Fully maximized (both horizontal and vertical)
        details.maximized = MAXIMIZED_BOTH
    } else {
        // Check for partial maximize (tiled left/right/top/bottom)
        details.maximized = win.get_maximize_flags?.() ?? 0
    }
    details.maximized_horizontally = (details.maximized & MAXIMIZED_HORIZONTAL) !== 0
    details.maximized_vertically = (details.maximized & MAXIMIZED_VERTICAL) !== 0

    return details
}

/**
 * ShellWindowMonitor handles connecting to GNOME Shell window signals
 * and normalizing events for consumption.
 */
export class ShellWindowMonitor {
    /**
     * @param {Function} onEventCallback - (winid, eventType, details) => void
     */
    constructor(onEventCallback, getStartupStatus = null) {
        this._onEventCallback = onEventCallback
        this._getStartupStatus = getStartupStatus
        this._startupWindows = new Map()
        this._laters = global.compositor.get_laters()
        this._windowConnections = new Map()
        this._pendingEvents = new Map()
        this._timeoutManager = new TimeoutManager()
        this._windowCreatedId = null
        this._grabOpBeginId = null
        this._grabOpEndId = null
        this._monitorsChangedId = null
        this._monitorsChangedTimeoutId = null
    }

    enable() {
        // Connect to all existing windows
        global.get_window_actors().forEach((actor) => {
            this._addWindow(actor.meta_window, false)
        })

        // Connect to window-created signal
        this._windowCreatedId = global.display.connect('window-created', (d, win) => {
            this._addWindow(win, true)
        })

        // Track compositor grabs so a user move/resize during startup cannot be
        // mistaken for geometry that the extension is free to overwrite later.
        this._grabOpBeginId = global.display.connect('grab-op-begin', (d, win, op) => {
            this._processWindowGrab(win, 'user-grab-begin', op)
        })
        this._grabOpEndId = global.display.connect('grab-op-end', (d, win, op) => {
            this._processWindowGrab(win, 'user-grab-end', op)
        })

        // Connect to monitors-changed signal via Main.layoutManager
        this._monitorsChangedId = Main.layoutManager.connect('monitors-changed', () => {
            // Log monitor geometry for debugging
            const nMonitors = global.display.get_n_monitors()
            for (let i = 0; i < nMonitors; i++) {
                const rect = global.display.get_monitor_geometry(i)
                debug('monitor', `monitor ${i}: x=${rect.x}, y=${rect.y}, w=${rect.width}, h=${rect.height}`)
            }

            if (this._monitorsChangedTimeoutId) {
                this._timeoutManager.remove(this._monitorsChangedTimeoutId)
                this._monitorsChangedTimeoutId = null
                debug('monitor', 'monitors changed (debounce reset)')
            } else {
                debug('monitor', 'monitors changed (debouncing...)')
            }

            this._monitorsChangedTimeoutId = this._timeoutManager.add(GLib.PRIORITY_DEFAULT, 200, () => {
                this._monitorsChangedTimeoutId = null
                debug('monitor', 'monitors changed, triggering window relocation check')
                // Notify all windows about monitor change
                for (const win of this._windowConnections.keys()) {
                    try {
                        const winid = win.get_id()
                        const details = getWindowState(win)
                        this._onEventCallback(winid, 'monitors-changed', details)
                    } catch (error) {
                        debug('monitor', `error notifying window ${win.get_id()} of monitor change: ${error.message}`, true)
                    }
                }
                return GLib.SOURCE_REMOVE
            })
        })
    }

    disable() {
        for (const win of [...this._startupWindows.keys()]) {
            this._releaseStartup(win, 'extension disabled', false)
        }
        if (this._windowCreatedId) {
            global.display.disconnect(this._windowCreatedId)
            this._windowCreatedId = null
        }

        if (this._grabOpBeginId) {
            global.display.disconnect(this._grabOpBeginId)
            this._grabOpBeginId = null
        }

        if (this._grabOpEndId) {
            global.display.disconnect(this._grabOpEndId)
            this._grabOpEndId = null
        }

        if (this._monitorsChangedId) {
            Main.layoutManager.disconnect(this._monitorsChangedId)
            this._monitorsChangedId = null
        }

        for (const [win, connections] of this._windowConnections) {
            for (const conn of connections) {
                conn.obj.disconnect(conn.id)
            }
        }
        this._windowConnections.clear()

        this._timeoutManager.removeAll()
        this._pendingEvents.clear()
    }

    _addWindow(win, isNewWindow = false) {
        if (!win || this._windowConnections.has(win)) {
            return
        }

        const windowSignals = [
            'notify::title', 'notify::wm-class', 'notify::minimized', 'notify::above',
            'notify::fullscreen', 'notify::maximized-horizontally', 'notify::maximized-vertically',
            'size-changed', 'position-changed', 'workspace-changed', 'notify::resizeable'
        ]
        const connections = windowSignals.map(signal => ({
            obj: win,
            id: win.connect(signal, () => this._onWindowModified(win, signal))
        }))

        // Register before processing window-created so the first event is not
        // rejected as untracked. Presentation is controlled by the mapping
        // inhibitor below. No actor signal is needed: the actor can already
        // be disposed when Meta.Window emits unmanaged.
        this._windowConnections.set(win, connections)
        if (isNewWindow && win.get_window_type() === Meta.WindowType.NORMAL) {
            this._startupWindows.set(win, { held: false, laterId: 0, timeoutId: 0 })
        }
        // unmanaged is authoritative even if no actor existed at creation.
        connections.push({ obj: win, id: win.connect('unmanaged', () => this._removeWindow(win)) })
        connections.push({ obj: win, id: win.connect('shown', () => {
            // This signal is after Mutter's mapping work. A held window only
            // reaches it after release; an unheld window is already visible.
            if (this._startupWindows.has(win)) this._releaseStartup(win, 'mapped without a restore hold')
        }) })

        const details = getWindowState(win)
        debug('monitor', `window ${win.get_id()} registered; new=${isNewWindow}`)
        this._processWindowEvent(win, 'window-created', details)
    }

    _holdStartupIfNeeded(win, details) {
        const startup = this._startupWindows.get(win)
        if (!startup || !this._getStartupStatus) return
        if (!startup.held) {
            if (typeof win.inhibit_mapped !== 'function' || typeof win.uninhibit_mapped !== 'function') return
            const status = this._getStartupStatus(win.get_id(), details)
            if (!status.eligible) return
            // Use Mutter's reference-counted mapping inhibitor. The client
            // can commit its buffer while Shell retains its normal animation.
            win.inhibit_mapped()
            startup.held = true
            this._setStartupDeadline(win, startup, 10000)
            // XWayland can report nonzero geometry before it supplies a
            // surface or finishes creating server-side decorations. Surface
            // attachment need not produce another Meta.Window size signal.
            startup.bufferPollId = this._timeoutManager.add(GLib.PRIORITY_DEFAULT, 50, () => {
                try {
                    if (!this._hasStartupBuffer(win)) return GLib.SOURCE_CONTINUE
                    startup.bufferPollId = 0
                    this._queueStartupCheck(win)
                } catch (error) {
                    startup.bufferPollId = 0
                    debug('monitor', `startup buffer check failed: ${error.message}`, true)
                    this._releaseStartup(win, 'startup buffer check failed')
                }
                return GLib.SOURCE_REMOVE
            })
            debug('monitor', `window ${win.get_id()} startup mapping held`)
        }
        if (!startup.contentReady && isValidGeometry(details.frame_rect) &&
            isValidGeometry(details.buffer_rect) && this._hasStartupBuffer(win)) {
            // Electron can create a hidden toplevel long before showing it.
            // Bound the presentation delay from its first usable buffer, not
            // from the beginning of the application's network/loading work.
            startup.contentReady = true
            this._setStartupDeadline(win, startup, 1200)
        }
    }

    _hasStartupBuffer(win) {
        if (win.get_client_type() === Meta.WindowClientType.WAYLAND) {
            // Native Wayland supplies its frame/buffer dimensions on commit;
            // its shaped texture may deliberately remain absent while held.
            return isValidGeometry(win.get_frame_rect()) && isValidGeometry(win.get_buffer_rect())
        }
        // Read the live actor only; never retain it or attach lifetime-bound
        // handlers. For X11, a rectangle alone can predate the first surface.
        return Boolean(win.get_compositor_private()?.get_texture()?.get_texture())
    }

    _setStartupDeadline(win, startup, milliseconds) {
        if (startup.timeoutId) this._timeoutManager.remove(startup.timeoutId)
        startup.timeoutId = this._timeoutManager.add(GLib.PRIORITY_DEFAULT, milliseconds, () => {
            startup.timeoutId = 0
            this._releaseStartup(win, 'startup deadline')
            return GLib.SOURCE_REMOVE
        })
    }

    _queueStartupCheck(win) {
        const startup = this._startupWindows.get(win)
        if (!startup || startup.laterId) return
        // Initial placement (CALC_SHOWING) precedes BEFORE_REDRAW. Reading and
        // restoring here avoids the 500ms geometry debounce and prevents the
        // initial placement calculation from overwriting our first request.
        startup.laterId = this._laters.add(Meta.LaterType.BEFORE_REDRAW, () => {
            startup.laterId = 0
            if (this._startupWindows.get(win) !== startup) return GLib.SOURCE_REMOVE
            try {
                const details = getWindowState(win)
                this._holdStartupIfNeeded(win, details)
                const hasBuffer = this._hasStartupBuffer(win)
                if (hasBuffer) this._onEventCallback(win.get_id(), 'startup-layout', details)
                const status = this._getStartupStatus?.(win.get_id(), getWindowState(win))
                if (startup.held && (!status?.eligible || (hasBuffer && status?.ready))) {
                    this._releaseStartup(win, 'placement ready')
                }
            } catch (error) {
                debug('monitor', `startup check failed: ${error.message}`, true)
                this._releaseStartup(win, 'startup check failed')
            }
            return GLib.SOURCE_REMOVE
        })
    }

    _releaseStartup(win, reason, notify = true) {
        const startup = this._startupWindows.get(win)
        if (!startup) return
        this._startupWindows.delete(win)
        if (startup.laterId) this._laters.remove(startup.laterId)
        if (startup.timeoutId) this._timeoutManager.remove(startup.timeoutId)
        if (startup.bufferPollId) this._timeoutManager.remove(startup.bufferPollId)
        try {
            if (notify) this._onEventCallback(win.get_id(), 'startup-finished', getWindowState(win))
        } finally {
            if (startup.held) win.uninhibit_mapped()
        }
        debug('monitor', `window ${win.get_id()} startup released: ${reason}`)
    }

    _processWindowGrab(win, eventType, op) {
        if (!win || !this._windowConnections.has(win)) {
            return
        }

        try {
            const winid = win.get_id()
            const details = getWindowState(win)
            details.grab_op = op
            this._onEventCallback(winid, eventType, details)
            if (eventType === 'user-grab-begin') this._releaseStartup(win, 'user took control')
        } catch (error) {
            debug('monitor', `error processing ${eventType}: ${error.message}`, true)
        }
    }

    _removeWindow(win) {
        this._releaseStartup(win, 'window unmanaged', false)
        this._processWindowEvent(win, 'destroy')

        if (this._pendingEvents.has(win)) {
            for (const [eventType, timeoutId] of this._pendingEvents.get(win)) {
                this._timeoutManager.remove(timeoutId)
            }
            this._pendingEvents.delete(win)
        }

        if (!this._windowConnections.has(win)) {
            return
        }

        const connections = this._windowConnections.get(win)
        for (const conn of connections) {
            conn.obj.disconnect(conn.id)
        }
        this._windowConnections.delete(win)
    }

    _onWindowModified(win, eventType) {
        if (eventType === 'destroy') {
            this._removeWindow(win)
            return
        }
        if (this._startupWindows.has(win)) {
            // Identity is inspected immediately to acquire the mapping hold;
            // geometry is coalesced to the next compositor layout boundary.
            try {
                this._holdStartupIfNeeded(win, getWindowState(win))
                this._queueStartupCheck(win)
            } catch (error) {
                debug('monitor', `startup event failed: ${error.message}`, true)
                this._releaseStartup(win, 'startup event failed')
            }
            return
        }
        // Use tracker policy for debouncing decisions
        if (!shouldDebounceEvent(eventType)) {
            this._processWindowEvent(win, eventType)
            return
        }
        debounce(win, eventType, this._pendingEvents, this._processWindowEvent.bind(this), this._timeoutManager)
    }

    _processWindowEvent(win, eventType, existingDetails = null) {
        if (!win) return

        if (!this._windowConnections.has(win) && eventType !== 'destroy') {
            // Untracked window event
            return
        }

        try {
            const winid = win.get_id()
            if (eventType === 'destroy') {
                this._onEventCallback(winid, eventType, { destroyed: true })
                return
            }

            const details = existingDetails || getWindowState(win)
            this._holdStartupIfNeeded(win, details)
            // Newly created X11 windows already have an identity/rectangle,
            // but restoration before their initial surface/decorations exists
            // can still be overwritten by Mutter's first placement.
            if (!this._startupWindows.has(win)) this._onEventCallback(winid, eventType, details)
            this._queueStartupCheck(win)
        } catch (error) {
            debug('monitor', `error processing window event ${eventType}: ${error.message}`, true)
        }
    }
}

export class ShellWindowExecutor {
    constructor(config = {}) {
        this._config = {
            activate_on_move: true,
            ...config
        }
        this._global = global
        this._display = global.display
        this._workspaceManager = global.workspace_manager
    }

    _getWindowById(winid) {
        const windows = global.get_window_actors()
        const actor = windows.find((win) => win.meta_window.get_id() == winid)
        return actor ? actor.meta_window : null
    }

    /**
     * Get window by ID or throw if not found.
     * @param {number} winid - Window ID
     * @param {string} opName - Operation name for error message
     * @returns {Meta.Window} The window
     * @throws {Error} If window not found
     */
    _getWindowOrThrow(winid, opName) {
        const win = this._getWindowById(winid)
        if (!win) {
            throw new Error(`${opName}: Window ${winid} not found`)
        }
        return win
    }

    /**
     * Execute an operation on a window with standardized error handling.
     * @param {number} winid - Window ID
     * @param {string} opName - Operation name for logging
     * @param {Function} fn - Function to execute with the window
     * @returns {*} Result of fn, or undefined on error
     */
    _withWindow(winid, opName, fn) {
        const win = this._getWindowById(winid)
        if (!win) {
            debug('shell', `${opName}: Window ${winid} not found`, true)
            return
        }
        try {
            return fn(win)
        } catch (error) {
            debug('shell', `failed to ${opName.toLowerCase()} window ${winid}: ${error.message}`, true)
        }
    }

    /* --- Read Operations --- */

    list() {
        const windows = global.get_window_actors()
        return windows.map((w) => {
            const win = w.meta_window
            return {
                id: win.get_id(),
                title: win.get_title(),
                wm_class: win.get_wm_class(),
            }
        })
    }

    listNormalWindows() {
        const windows = global.get_window_actors()
        const normalWindows = []
        const windowTracker = Shell.WindowTracker.get_default()

        for (const actor of windows) {
            const win = actor.meta_window
            if (!win) continue

            const title = win.get_title()
            const wm_class = win.get_wm_class()

            if (!title || !wm_class) continue
            if (win.is_skip_taskbar()) continue
            if (win.get_window_type() !== Meta.WindowType.NORMAL) continue

            let icon_string = ''
            const app = windowTracker.get_window_app(win)
            if (app) {
                const icon = app.get_icon()
                if (icon) {
                    icon_string = icon.to_string()
                }
            }

            normalWindows.push({
                wsh: wm_class,
                title: title,
                app_icon: icon_string,
            })
        }
        return normalWindows
    }

    getDetails(winid) {
        return getWindowState(this._getWindowOrThrow(winid, 'GetDetails'))
    }

    getFrameRect(winid) {
        const { x, y, width, height } = this._getWindowOrThrow(winid, 'GetFrameRect').get_frame_rect()
        return { x, y, width, height }
    }

    getBufferRect(winid) {
        const { x, y, width, height } = this._getWindowOrThrow(winid, 'GetBufferRect').get_buffer_rect()
        return { x, y, width, height }
    }

    getTitle(winid) {
        return this._getWindowOrThrow(winid, 'GetTitle').get_title()
    }

    getFocusedMonitorDetails() {
        const id = global.display.get_current_monitor()
        const monitorGeometryMtkRect = global.display.get_monitor_geometry(id)
        return {
            id,
            geometry: {
                x: monitorGeometryMtkRect.x,
                y: monitorGeometryMtkRect.y,
                width: monitorGeometryMtkRect.width,
                height: monitorGeometryMtkRect.height,
            },
        }
    }

    getAllWindowDetails() {
        const actors = global.get_window_actors()
        return actors.map(actor => {
             const win = actor.meta_window
             return {
                 id: win.get_id(),
                 details: getWindowState(win)
             }
        })
    }

    /* --- Write Operations --- */

    moveToWorkspace(winid, wsid) {
        this._withWindow(winid, 'MoveToWorkspace', (win) => {
            const workspace = this._workspaceManager.get_workspace_by_index(wsid)
            if (!workspace) {
                debug('shell', `MoveToWorkspace: Workspace ${wsid} not found`, true)
                return
            }
            win.change_workspace(workspace)
            if (this._config.activate_on_move) {
                workspace.activate_with_focus(win, this._global.get_current_time())
            }
            debug('shell', `moved window ${winid} to workspace ${wsid}`)
        })
    }

    moveToMonitor(winid, mid) {
        const nMonitors = global.display.get_n_monitors()
        if (mid < 0 || mid >= nMonitors) {
            debug('shell', `MoveToMonitor: Monitor ${mid} not found (available: 0-${nMonitors - 1})`, true)
            return
        }
        this._withWindow(winid, 'MoveToMonitor', (win) => {
            win.move_to_monitor(mid)
            debug('shell', `moved window ${winid} to monitor ${mid}`)
        })
    }

    place(winid, x, y, width, height) {
        this._withWindow(winid, 'Place', (win) => {
            // This is compositor-driven restoration, not a user grab.
            win.move_resize_frame(false, x, y, width, height)
            debug('shell', `placed window ${winid} at (${x}, ${y}) with size ${width}x${height}`)
        })
    }

    move(winid, x, y) {
        this._withWindow(winid, 'Move', (win) => {
            win.move_frame(false, x, y)
            debug('shell', `moved window ${winid} to (${x}, ${y})`)
        })
    }

    maximize(winid, state) {
        this._withWindow(winid, 'Maximize', (win) => {
            if (state === MAXIMIZED_HORIZONTAL) {
                win.set_maximize_flags(Meta.MaximizeFlags.HORIZONTAL)
                debug('shell', `maximized window ${winid} horizontally`)
            } else if (state === MAXIMIZED_VERTICAL) {
                win.set_maximize_flags(Meta.MaximizeFlags.VERTICAL)
                debug('shell', `maximized window ${winid} vertically`)
            } else if (state === MAXIMIZED_BOTH) {
                win.maximize()
                debug('shell', `maximized window ${winid} fully`)
            } else {
                debug('shell', `Maximize called with invalid state ${state}`, true)
            }
        })
    }

    minimize(winid) {
        this._withWindow(winid, 'Minimize', (win) => {
            win.minimize()
            debug('shell', `minimized window ${winid}`)
        })
    }

    unmaximize(winid) {
        this._withWindow(winid, 'Unmaximize', (win) => {
            win.unmaximize()
            debug('shell', `unmaximized window ${winid}`)
        })
    }

    close(winid, isForced = false) {
        this._withWindow(winid, 'Close', (win) => {
            if (isForced) {
                win.kill()
                debug('shell', `forcefully killed window ${winid}`)
            } else {
                win.delete(this._global.get_current_time())
                debug('shell', `closed window ${winid}`)
            }
        })
    }

    setFullscreen(winid, state) {
        this._withWindow(winid, 'SetFullscreen', (win) => {
            if (state) {
                win.make_fullscreen()
                debug('shell', `set fullscreen for window ${winid}`)
            } else {
                win.unmake_fullscreen()
                debug('shell', `removed fullscreen for window ${winid}`)
            }
        })
    }

    toggleFullscreen(winid) {
        this._withWindow(winid, 'ToggleFullscreen', (win) => {
            if (win.is_fullscreen()) {
                win.unmake_fullscreen()
                debug('shell', `exited fullscreen for window ${winid}`)
            } else {
                win.make_fullscreen()
                debug('shell', `entered fullscreen for window ${winid}`)
            }
        })
    }

    setOnAllWorkspaces(winid, state) {
        this._withWindow(winid, 'SetOnAllWorkspaces', (win) => {
            if (state) {
                win.stick()
                debug('shell', `set window ${winid} on all workspaces`)
            } else {
                win.unstick()
                debug('shell', `removed window ${winid} from all workspaces`)
            }
        })
    }

    setAbove(winid, state) {
        this._withWindow(winid, 'SetAbove', (win) => {
            if (state) {
                win.make_above()
                debug('shell', `set window ${winid} above others`)
            } else {
                win.unmake_above()
                debug('shell', `removed window ${winid} from above others`)
            }
        })
    }

    /**
     * Activate a workspace to make it visible.
     * This is needed before placing windows on non-active workspaces,
     * as move_resize_frame() doesn't work reliably on invisible workspaces.
     *
     * @param {number} wsid - Workspace index to activate
     */
    activateWorkspace(wsid) {
        const workspace = this._workspaceManager.get_workspace_by_index(wsid)
        if (!workspace) {
            debug('shell', `ActivateWorkspace: Workspace ${wsid} not found`, true)
            return
        }
        workspace.activate(this._global.get_current_time())
        debug('shell', `activated workspace ${wsid}`)
    }
}

/**
 * Iterate through all logical monitors and their physical monitors.
 * Helper to avoid code duplication in monitor-related functions.
 *
 * @param {Function} callback - Called with (logicalMonitor, physicalMonitor) for each monitor.
 *                              Return a non-undefined value to stop iteration and return that value.
 * @param {string} errorContext - Context string for error logging
 * @returns {*} The value returned by callback, or null if callback never returned a value
 */
function iterateMonitors(callback, errorContext) {
    try {
        const monitorManager = global.backend.get_monitor_manager()
        for (const logical of monitorManager.get_logical_monitors()) {
            for (const monitor of logical.get_monitors()) {
                const result = callback(logical, monitor)
                if (result !== undefined) return result
            }
        }
    } catch (e) {
        debug('shell', `error ${errorContext}: ${e.message}`)
    }
    return null
}

/**
 * Get the connector name for a monitor index.
 * Connector names (e.g., "DP-1", "eDP-1") are stable identifiers that persist
 * across monitor connect/disconnect cycles, unlike indices which can change.
 *
 * @param {number} monitorIndex - The logical monitor index
 * @returns {string|null} The connector name, or null if not found
 */
export function getConnectorForMonitor(monitorIndex) {
    return iterateMonitors((logical, monitor) => {
        if (logical.get_number() === monitorIndex) {
            return monitor.get_connector()
        }
    }, `getting connector for monitor ${monitorIndex}`)
}

/**
 * Get the monitor index for a connector name.
 *
 * @param {string} connectorName - The connector name (e.g., "DP-1")
 * @returns {number} The monitor index, or -1 if not found/connected
 */
export function getMonitorForConnector(connectorName) {
    const result = iterateMonitors((logical, monitor) => {
        if (monitor.get_connector() === connectorName) {
            return logical.get_number()
        }
    }, `getting monitor for connector ${connectorName}`)
    return result !== null ? result : -1
}

/**
 * Get list of all currently connected monitor connector names.
 *
 * @returns {string[]} Array of connector names
 */
export function getAvailableConnectors() {
    const connectors = []
    iterateMonitors((logical, monitor) => {
        connectors.push(monitor.get_connector())
    }, 'getting available connectors')
    return connectors
}

/**
 * Get the geometry (position and size) for a monitor by its index.
 *
 * @param {number} monitorIndex - GNOME's logical monitor index
 * @returns {Object|null} Monitor geometry {x, y, width, height} or null if not found
 */
export function getMonitorGeometry(monitorIndex) {
    try {
        const rect = global.display.get_monitor_geometry(monitorIndex)
        return {
            x: rect.x,
            y: rect.y,
            width: rect.width,
            height: rect.height
        }
    } catch (e) {
        debug('shell', `error getting geometry for monitor ${monitorIndex}: ${e.message}`)
    }
    return null
}
