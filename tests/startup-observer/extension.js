import GLib from 'gi://GLib'
import * as Main from 'resource:///org/gnome/shell/ui/main.js'
import { Extension } from 'resource:///org/gnome/shell/extensions/extension.js'

export default class Observer extends Extension {
    enable() {
        this.connections = []
        this.windows = new Map()
        this.firstVisible = new Set()
        const watch = win => {
            if (win.get_window_type() !== 0 || this.windows.has(win)) return
            this.windows.set(win, win.get_id())
            this.record(win, 'created')
            for (const signal of ['notify::wm-class', 'notify::title', 'size-changed', 'position-changed', 'shown']) {
                this.connect(win, signal, () => this.record(win, signal))
            }
            this.connect(win, 'unmanaged', () => {
                this.record(win, 'unmanaged')
                this.windows.delete(win)
            })
        }
        this.connect(global.display, 'window-created', (_, win) => watch(win))
        for (const actor of global.get_window_actors()) watch(actor.meta_window)
        this.connect(global.window_manager, 'map', (_, actor) => this.record(actor.meta_window, 'map'))
        this.connect(global.stage, 'after-paint', () => {
            for (const [win, id] of this.windows) {
                const actor = win.get_compositor_private()
                if (!this.firstVisible.has(id) && actor?.mapped && actor.get_paint_opacity() > 0 &&
                    !win.is_hidden() && win.showing_on_its_workspace()) {
                    this.firstVisible.add(id)
                    this.record(win, 'first-visible')
                }
            }
        })
        Main.overview.hide()
        console.log('SAM_PROBE_DISPLAY ' + (GLib.getenv('DISPLAY') || ''))
        console.log('SAM_PROBE_XAUTHORITY ' + (GLib.getenv('XAUTHORITY') || ''))
        console.log('SAM_PROBE_READY')
    }

    connect(object, signal, callback) {
        this.connections.push([object, object.connect(signal, callback)])
    }

    record(win, event) {
        if (!win || win.get_window_type() !== 0) return
        const rect = win.get_frame_rect()
        // The monitor is already gone during unmanaged; querying its work
        // area then is a fatal Mutter assertion, not a catchable JS exception.
        const area = win.get_monitor() >= 0 ? win.get_work_area_current_monitor() : rect
        console.log('SAM_PROBE ' + JSON.stringify({
            event, id: win.get_id(), time: GLib.get_monotonic_time() / 1000,
            title: win.get_title(), wm_class: win.get_wm_class(), monitor: win.get_monitor(),
            resizeable: win.resizeable, active_workspace: global.workspace_manager.get_active_workspace_index(),
            maximized: win.get_maximize_flags(),
            workarea: { x: area.x, y: area.y, width: area.width, height: area.height },
            workspace: win.get_workspace()?.index(), inhibited: win.is_mapped_inhibited(),
            rect: { x: rect.x, y: rect.y, width: rect.width, height: rect.height },
        }))
    }

    disable() {
        for (const [object, id] of this.connections) {
            try { object.disconnect(id) } catch (_) { /* Some probe windows have already closed. */ }
        }
        this.connections = []
        this.windows.clear()
    }
}
