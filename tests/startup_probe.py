#!/usr/bin/env python3
"""Run first-visible-frame checks in an isolated GNOME Wayland compositor.

This never changes the host dconf database or installed extensions. Logs and
test profiles are retained under --output for inspection. No logout is needed.
"""
import argparse
import json
import os
from pathlib import Path
import shutil
import subprocess
import sys
import tempfile
import time

ROOT = Path(__file__).resolve().parents[1]
UUID = 'smart-auto-move@khimaros.com'
OBSERVER = 'sam-startup-observer@test.local'


def run(*args, **kwargs):
    return subprocess.run(args, check=True, text=True, capture_output=True, **kwargs)


def inside(output, app_kind):
    run('gsettings', 'set', 'org.gnome.shell', 'enabled-extensions', json.dumps([UUID, OBSERVER]))
    run('gsettings', 'set', 'org.gnome.mutter', 'dynamic-workspaces', 'false')
    run('gsettings', 'set', 'org.gnome.desktop.wm.preferences', 'num-workspaces', '3')
    schema = 'org.gnome.shell.extensions.smart-auto-move'
    run('gsettings', 'set', schema, 'config-version', '37')
    if app_kind == 'no-animation':
        run('gsettings', 'set', 'org.gnome.desktop.interface', 'enable-animations', 'false')
    if app_kind == 'ignored':
        run('gsettings', 'set', schema, 'ignore-position', 'true')
    wm_class = 'vesktop' if app_kind == 'vesktop' else 'com.example.SAMProbe'
    title = '• Discord | #general | Example' if app_kind == 'vesktop' else 'SAM probe document'
    slot = {
        'occupied': None, 'seen': int(time.time() * 1000),
        'props': {'wm_class': wm_class, 'title': title, 'connectorPreference': ['Meta-0'],
                  'configs': [{'connector': 'Meta-0', 'workspace': 0, 'minimized': False,
                               'maximized': 0, 'relative_rect': {'x': 200, 'y': 150, 'width': 600, 'height': 650}}]},
    }
    if app_kind == 'workspace':
        slot['props']['configs'][0]['workspace'] = 1
    if app_kind == 'monitor':
        slot['props']['configs'][0]['connector'] = 'Meta-1'
        slot['props']['connectorPreference'] = ['Meta-1']
    if app_kind == 'vesktop':
        slot['props']['configs'][0]['relative_rect'].update(width=1100, height=700)
    if app_kind == 'maximized':
        slot['props']['configs'][0]['maximized'] = 3
    run('gsettings', 'set', schema, 'saved-windows', json.dumps([slot]))
    run('gsettings', 'set', schema, 'debug-logging', 'true')
    shell_log = output / 'shell.log'
    with shell_log.open('w') as log:
        shell_command = ['gnome-shell', '--headless', '--wayland', '--no-x11',
                         '--wayland-display=sam-test', '--virtual-monitor=1600x1000']
        if app_kind == 'xwayland':
            shell_command.remove('--no-x11')
        if app_kind == 'monitor':
            shell_command.append('--virtual-monitor=1280x900')
        shell = subprocess.Popen(shell_command,
                                 stdout=log, stderr=subprocess.STDOUT)
        client = None
        try:
            deadline = time.monotonic() + 12
            while time.monotonic() < deadline:
                if shell.poll() is not None:
                    raise RuntimeError('Test compositor exited; see shell.log')
                if 'SAM_PROBE_READY' in shell_log.read_text(errors='replace'):
                    break
                time.sleep(0.1)
            else:
                raise RuntimeError('Observer did not become ready; see shell.log')
            client_env = dict(os.environ, WAYLAND_DISPLAY='sam-test', GDK_BACKEND='wayland',
                              GTK_A11Y='none', NO_AT_BRIDGE='1')
            if app_kind == 'xwayland':
                displays = [line.split('SAM_PROBE_DISPLAY ', 1)[1].strip()
                            for line in shell_log.read_text(errors='replace').splitlines()
                            if 'SAM_PROBE_DISPLAY ' in line]
                assert displays and displays[-1], 'Isolated Xwayland display was not published'
                client_env.update(DISPLAY=displays[-1], GDK_BACKEND='x11')
                authorities = [line.split('SAM_PROBE_XAUTHORITY ', 1)[1].strip()
                               for line in shell_log.read_text(errors='replace').splitlines()
                               if 'SAM_PROBE_XAUTHORITY ' in line]
                assert authorities and authorities[-1], 'Isolated Xwayland authority was not published'
                client_env['XAUTHORITY'] = authorities[-1]
            if app_kind in ['delayed', 'timeout', 'disable']:
                client_env.update(SAM_PROBE_TITLE='Loading', SAM_PROBE_FINAL_TITLE=title,
                                  SAM_PROBE_TITLE_DELAY='2300' if app_kind == 'timeout' else '900')
            if app_kind == 'splash':
                client_env['SAM_PROBE_SPLASH'] = '1'
            if app_kind == 'vesktop':
                profile = output / 'vesktop-profile'
                profile.mkdir(exist_ok=True)
                (profile / 'state.json').write_text(json.dumps({'firstLaunch': False}))
                (profile / 'settings.json').write_text(json.dumps({
                    'tray': False, 'arRPC': False, 'enableSplashScreen': True,
                }))
                client_env['VENCORD_USER_DATA_DIR'] = str(profile)
            command = (['/opt/vesktop/vesktop', '--ozone-platform=wayland',
                        '--user-data-dir=' + str(output / 'vesktop-profile'), '--disable-gpu']
                       if app_kind == 'vesktop' else [sys.executable, str(ROOT / 'tests/startup_probe_app.py')])
            with (output / 'client.log').open('w') as client_log:
                client = subprocess.Popen(command, env=client_env, stdout=client_log, stderr=subprocess.STDOUT)
                if app_kind == 'disable':
                    time.sleep(0.65)
                    run('gnome-extensions', 'disable', UUID)
                try:
                    client.wait(timeout=7 if app_kind == 'vesktop' else 5)
                except subprocess.TimeoutExpired:
                    client.terminate()
                    client.wait(timeout=5)
            time.sleep(0.2)
            if shell.poll() is not None:
                raise RuntimeError('Test compositor exited unexpectedly; see shell.log')
        finally:
            if client and client.poll() is None:
                client.kill()
                client.wait(timeout=5)
            if shell.poll() is None:
                shell.terminate()
                try:
                    shell.wait(timeout=5)
                except subprocess.TimeoutExpired:
                    shell.kill()
                    shell.wait(timeout=5)


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument('--inside', action='store_true')
    parser.add_argument('--app', choices=['exact', 'delayed', 'vesktop', 'timeout', 'disable',
                                         'workspace', 'monitor', 'ignored', 'splash', 'no-animation',
                                         'maximized', 'xwayland'], default='exact')
    parser.add_argument('--output', type=Path)
    args = parser.parse_args()
    if args.inside:
        inside(args.output, args.app)
        return
    output = args.output or Path(tempfile.mkdtemp(prefix='sam-startup-', dir=ROOT.parent))
    output.mkdir(parents=True, exist_ok=True)
    output = output.resolve()
    env = dict(os.environ)
    for key, name in [('XDG_CONFIG_HOME', 'config'), ('XDG_DATA_HOME', 'data'),
                      ('XDG_CACHE_HOME', 'cache'), ('XDG_STATE_HOME', 'state'),
                      ('XDG_RUNTIME_DIR', 'runtime')]:
        directory = output / name
        directory.mkdir(mode=0o700, exist_ok=True)
        env[key] = str(directory)
    for key in ['DISPLAY', 'WAYLAND_DISPLAY', 'DBUS_SESSION_BUS_ADDRESS', 'GNOME_SETUP_DISPLAY', 'XAUTHORITY']:
        env.pop(key, None)
    extensions = output / 'data/gnome-shell/extensions'
    extension = extensions / UUID
    extension.mkdir(parents=True, exist_ok=True)
    for name in ['metadata.json', 'extension.js', 'common.js', 'migrations.js', 'lib', 'schemas']:
        source = ROOT / name
        if source.is_dir():
            shutil.copytree(source, extension / name, dirs_exist_ok=True)
        else:
            shutil.copy2(source, extension / name)
    shutil.copytree(ROOT / 'tests/startup-observer', extensions / OBSERVER, dirs_exist_ok=True)
    run('glib-compile-schemas', str(extension / 'schemas'))
    env.update(GSETTINGS_SCHEMA_DIR=str(extension / 'schemas'), GTK_A11Y='none',
               NO_AT_BRIDGE='1', XDG_SESSION_TYPE='wayland', XDG_CURRENT_DESKTOP='GNOME')
    with (output / 'runner.log').open('w') as log:
        result = subprocess.run(['dbus-run-session', '--', sys.executable, __file__, '--inside',
                                 '--app', args.app, '--output', str(output)], env=env,
                                stdout=log, stderr=subprocess.STDOUT, timeout=35)
    events = []
    for line in (output / 'shell.log').read_text(errors='replace').splitlines():
        if 'SAM_PROBE {' in line:
            events.append(json.loads(line.split('SAM_PROBE ', 1)[1]))
    (output / 'events.json').write_text(json.dumps(events, indent=2))
    print('Probe output:', output)
    for event in events:
        if event['event'] in ['created', 'map', 'shown', 'first-frame', 'first-visible', 'unmanaged']:
            print(json.dumps(event))
    if result.returncode:
        print((output / 'runner.log').read_text(errors='replace')[-4000:])
        sys.exit(result.returncode)
    visible = [event for event in events if event['event'] == 'first-visible' and
               event.get('resizeable', True)]
    assert visible, 'No first-visible main-window frame was observed'
    first = visible[-1]
    expected = {'x': 1800 if args.app == 'monitor' else 200, 'y': 150, 'width': 600, 'height': 650}
    if args.app == 'maximized':
        expected = first['workarea']
        assert first['maximized'] == 3, 'Window was not maximized before first display'
    if args.app == 'vesktop':
        expected.update(width=1100, height=700)
        splashes = [event for event in events if event['event'] == 'first-visible' and
                    not event.get('resizeable', True)]
        assert splashes, 'The real Vesktop splash was not observed'
        assert all(event['rect']['width'] == 300 and event['rect']['height'] == 350
                   for event in splashes), 'The main-window placement was applied to the splash'
    if args.app not in ['timeout', 'disable', 'ignored']:
        assert first['rect'] == expected, f'First visible geometry was {first["rect"]}, expected {expected}'
        assert first['workspace'] == (1 if args.app == 'workspace' else 0)
    later = [event for event in events if event['id'] == first['id'] and
             event['time'] >= first['time'] and event['event'] in ['position-changed', 'size-changed', 'unmanaged']]
    assert all(event['rect'] == first['rect'] for event in later), 'Window moved after first display'
    assert all(not event['inhibited'] for event in events if event['event'] == 'unmanaged'), 'Mapping hold leaked'
    errors = [line for line in (output / 'shell.log').read_text(errors='replace').splitlines()
              if 'JS ERROR:' in line or 'startup check failed' in line or 'error processing window' in line
              or 'assertion failed' in line or 'libmutter:ERROR' in line
              or 'has been already disposed' in line or 'has no handler with id' in line]
    assert not errors, '\n'.join(errors)
    (output / 'result.json').write_text(json.dumps({
        'scenario': args.app, 'status': 'passed', 'first_visible': first,
        'no_late_restore': True, 'no_leaked_mapping_hold': True,
    }, indent=2))
    print('PASS:', args.app, 'first visible geometry and no later restore')


if __name__ == '__main__':
    main()
