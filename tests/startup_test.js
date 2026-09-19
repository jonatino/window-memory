// gjs -m tests/startup_test.js
// Regression sequences for real startup races, not wall-clock timing tests.
import { WindowStateMatcher } from '../lib/state-matcher.js'
import { OperationHandler } from '../lib/state-session.js'
import { shouldTrackWindow } from '../lib/window-state.js'
import { setDebugEnabled } from '../lib/utils.js'

setDebugEnabled(false)
let checks = 0
function check(description, condition) {
    if (!condition) throw new Error(description)
    checks++
    print(`PASS: ${description}`)
}

function slot(title = 'Saved document', x = 100, workspace = 0, wmClass = 'org.example.App', seen = 1) {
    return { occupied: null, seen, props: { title, wm_class: wmClass,
        connectorPreference: ['Virtual-1'], configs: [{ connector: 'Virtual-1', workspace,
            maximized: 0, minimized: false, relative_rect: { x, y: 100, width: 500, height: 400 } }] } }
}
function details(title = 'Saved document', x = 400, workspace = 0, wmClass = 'org.example.App') {
    return { title, wm_class: wmClass, frame_rect: { x, y: 200, width: 600, height: 500 },
        workspace, monitor: 0, maximized: 0, minimized: false, fullscreen: false,
        window_type: 0, resizeable: true, transient_for: null, on_all_workspaces: false }
}
function fixture(slots, options = {}) {
    const calls = []
    const executor = { _config: { activate_on_move: false },
        place: (...args) => calls.push(['place', ...args]),
        moveToWorkspace: (...args) => calls.push(['workspace', ...args]),
        activateWorkspace: (...args) => calls.push(['activate', ...args]),
    }
    const handler = new OperationHandler(executor, options.operationFilter)
    const matcher = new WindowStateMatcher({ initialState: slots,
        getMonitorCount: () => 1,
        getMonitorGeometry: () => ({ x: 0, y: 0, width: 1600, height: 1000 }),
        getConnectorForMonitor: () => 'Virtual-1',
        getMonitorForConnector: name => name === 'Virtual-1' ? 0 : -1,
        getAvailableConnectors: () => ['Virtual-1'],
        onProcessing: result => handler.processTrackerResult(result), ...options,
    })
    handler._tracker = matcher
    return { matcher, handler, calls,
        event(name, value, id = 1) {
            const result = matcher.onWindowModified(id, name, value)
            handler.processTrackerResult(result)
            return result
        },
        close() { handler.destroy(); matcher.destroy() },
    }
}

{
    const f = fixture([slot()])
    f.event('window-created', details('Loading'))
    f.event('user-grab-begin', details('Loading'))
    f.event('notify::title', details('Saved document', 750))
    check('title arriving during a drag cannot clear active grab protection',
        f.matcher._windowStates.get(1).userGrabActive && f.calls.length === 0)
    f.event('user-grab-end', details('Saved document', 750))
    check('pending match adopts the completed drag without moving', f.calls.length === 0 &&
        f.matcher.knownWindows[0].props.configs[0].relative_rect.x === 750)
    f.close()
}

{
    const f = fixture([slot('Saved document', 100, 1)])
    const original = f.event('window-created', details())
    check('workspace restore initially has deferred geometry', f.handler._pendingMoves.has(1))
    f.event('user-grab-begin', details('Saved document', 500, 1))
    check('starting a drag removes the queue and its timer', !f.handler._pendingMoves.has(1))
    f.event('user-grab-end', details('Saved document', 800, 1))
    f.handler._executePendingOperations(1)
    f.handler._executeOperations(original.operations.filter(op => op.type === 'Place'))
    check('stale operation batches remain invalid after releasing the pointer',
        !f.calls.some(call => call[0] === 'place' || call[0] === 'activate'))
    check('final user geometry is saved on grab end',
        f.matcher.knownWindows[0].props.configs[0].relative_rect.x === 800)
    f.close()
}

{
    const f = fixture([slot()])
    f.event('window-created', details())
    const state = f.matcher._windowStates.get(1)
    check('restore entered settling', state.state === 'SETTLING')
    f.event('user-grab-begin', details('Saved document', 600))
    const count = f.calls.length
    f.matcher._onSettleTimeout(1, state)
    check('a stale settling callback cannot move a dragged window', f.calls.length === count)
    f.event('user-grab-end', details('Saved document', 900))
    f.close()
}

{
    const f = fixture([slot('Old channel', 120, 0, 'vesktop', 1),
        slot('• Discord | #old | Example', 200, 0, 'vesktop', 2),
        slot('• Discord | @friend', 850, 0, 'vesktop', 3)])
    f.event('window-created', details('Discord', 400, 0, 'vesktop'))
    check('Discord main window uses the latest main-window placement before its channel loads',
        f.calls.some(call => call[0] === 'place' && call[2] === 850))
    f.event('startup-finished', details('Discord', 850, 0, 'vesktop'))
    const count = f.calls.length
    f.event('notify::title', details('• Discord | #old | Example', 850, 0, 'vesktop'))
    check('loading an older Discord channel does not switch saved slots', f.calls.length === count)
    f.close()
}

{
    const f = fixture([slot('• Discord | #general | Example', 850, 0, 'vesktop')])
    f.event('window-created', details('Network Error', 400, 0, 'vesktop'))
    check('Vesktop offline page restores the main window immediately',
        f.calls.some(call => call[0] === 'place' && call[2] === 850))
    check('offline title in an unrelated application is not a class match',
        !f.matcher.getPolicyForWindow(details('Network Error')).matchByClass)
    check('combined unread count and notification dot still identify the main window',
        f.matcher.getPolicyForWindow(details('(3) • Discord | #general | Example', 400, 0, 'vesktop')).matchByClass)
    f.close()
}

{
    const f = fixture([slot('• Discord | #old | Example', 120, 0, 'vesktop', 1),
        slot('Network Error', 850, 0, 'vesktop', 2)])
    f.event('window-created', details('• Discord | #old | Example', 400, 0, 'vesktop'))
    check('latest main-window placement wins over a stale exact conversation title',
        f.calls.some(call => call[0] === 'place' && call[2] === 850))
    f.close()
}

{
    const f = fixture([slot('• Discord | #general | Example', 850, 0, 'vesktop'),
        slot('Discord Popout', 250, 0, 'vesktop')])
    f.event('window-created', details('Discord Popout', 400, 0, 'vesktop'), 2)
    check('popouts retain their own title-matched placement',
        f.calls.some(call => call[0] === 'place' && call[1] === 2 && call[2] === 250))
    f.event('window-created', details('Network Error', 400, 0, 'vesktop'))
    check('an existing popout does not block main-window restoration',
        f.calls.some(call => call[0] === 'place' && call[1] === 1 && call[2] === 850))
    for (const title of ['Vesktop Setup', 'Discord Updater', 'Discord Popout']) {
        const props = details(title, 400, 0, 'vesktop')
        check(`${title} is not treated as the main window`,
            !f.matcher.getPolicyForWindow(props).matchByClass)
    }
    f.close()
}

{
    const f = fixture([slot('Discord', 850, 0, 'vesktop')])
    check('fuzzy popout matching cannot take a main-window slot',
        f.matcher.calculateScoresForWindow(details('Discord Popout', 400, 0, 'vesktop')).length === 0)
    f.close()
}

{
    const f = fixture([slot('• Discord | #general | Example', 100, 0, 'vesktop')])
    const splash = { ...details('Discord', 400, 0, 'vesktop'), resizeable: false }
    check('Vesktop fixed splash windows are excluded without can_resize()', !shouldTrackWindow(splash))
    f.event('window-created', splash, 2)
    check('splash does not occupy or create a placement slot',
        f.matcher.knownWindows.length === 1 && f.matcher.knownWindows[0].occupied === null)
    f.event('window-created', details('Discord', 400, 0, 'vesktop'))
    check('the main window can still claim the saved slot', f.calls.some(call => call[0] === 'place'))
    f.close()
}

{
    const f = fixture([slot('Identical title', 10, 0, 'org.other.App'),
        slot('Identical title', 300)])
    f.event('window-created', details('Identical title'))
    check('an exact title in another app cannot outrank the right app',
        f.calls.some(call => call[0] === 'place' && call[2] === 300))
    f.close()
}

{
    const f = fixture([slot()])
    f.event('window-created', details('Loading'))
    f.event('startup-finished', details('Loading', 650))
    f.event('notify::title', details('Saved document', 650))
    check('title arriving after the presentation deadline cannot cause a visible restore', f.calls.length === 0)
    f.close()
}

{
    const f = fixture([])
    f.event('window-created', details('New window'))
    f.event('startup-finished', details('New window', 650))
    f.matcher.addWindowAsNew(1, details('New window', 650))
    check('learning a new window after presentation restores normal future tracking',
        !f.matcher.shouldSkipOperation(1) &&
        f.matcher.knownWindows[0].props.configs[0].relative_rect.x === 650)
    f.close()
}

{
    const f = fixture([slot('Saved document', 100, 1)], { operationFilter: op => op.type !== 'Place' })
    f.event('window-created', details())
    f.handler._executePendingOperations(1)
    check('ignored geometry stays ignored in deferred batches', !f.calls.some(call => call[0] === 'place'))
    check('disabled workspace following stays disabled', !f.calls.some(call => call[0] === 'activate'))
    f.close()
}

{
    const f = fixture([slot('Saved document', 100, 1)])
    f.event('window-created', details())
    f.event('workspace-changed', details('Saved document', 400, 1))
    const timeout = f.handler._pendingMoves.get(1).timeoutId
    f.event('notify::title', details('Saved document still loading', 400, 1))
    check('loading events cannot continually postpone a deferred workspace restore',
        f.handler._pendingMoves.get(1).timeoutId === timeout)
    f.close()
}

{
    let ignorePlacement = false
    const f = fixture([slot('Saved document', 100, 1)], {
        operationFilter: op => !ignorePlacement || op.type !== 'Place',
    })
    f.event('window-created', details())
    ignorePlacement = true
    f.handler._executePendingOperations(1)
    check('filtering all deferred operations still completes the restore batch',
        f.matcher._windowStates.get(1).state === 'SETTLING')
    check('startup readiness respects a setting changed while operations were queued',
        f.matcher.getStartupStatus(1, details('Saved document', 400, 1)).ready)
    f.close()
}

{
    const f = fixture([slot('Same title', 10, 0, 'org.other.App'),
        slot('Same title - Document', 300)])
    const scores = f.matcher.calculateScoresForWindow(details('Same title'))
    check('a cross-application exact title cannot outrank a same-application fuzzy match',
        scores.length === 1 && scores[0].window.props.wm_class === 'org.example.App')
    f.close()
}

{
    const f = fixture([slot()], {
        getMonitorCount: () => 2,
        getConnectorForMonitor: index => index === 1 ? 'Virtual-2' : 'Virtual-1',
        getMonitorForConnector: name => name === 'Virtual-2' ? 1 : 0,
        getAvailableConnectors: () => ['Virtual-1', 'Virtual-2'],
    })
    f.event('window-created', details())
    f.event('user-grab-begin', details())
    const props = f.matcher.knownWindows[0].props
    props.connectorPreference.unshift('Virtual-2')
    props.configs.push({ ...props.configs[0], connector: 'Virtual-2' })
    const result = f.event('monitors-changed', details())
    check('monitor changes during a grab do not restart the restoration state machine',
        result.operations.length === 0 && f.matcher._windowStates.get(1).state === 'TRACKING')
    f.close()
}

{
    const f = fixture([slot('Saved document', 100, 1)])
    f.event('window-created', details())
    f.event('destroy', { destroyed: true })
    check('closing a window cancels its deferred queue', !f.handler._pendingMoves.has(1))
    f.handler._executePendingOperations(1)
    check('closed windows cannot receive delayed Place calls', !f.calls.some(call => call[0] === 'place'))
    f.close()
}

print(`${checks} startup regression checks passed`)
