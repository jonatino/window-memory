"""A real Wayland client with controllable startup title and geometry."""
import os
import gi

gi.require_version('Gtk', '4.0')
from gi.repository import Gio, GLib, Gtk

GLib.set_prgname('com.example.SAMProbe')
app = Gtk.Application(application_id='com.example.SAMProbe', flags=Gio.ApplicationFlags.NON_UNIQUE)


def activate(application):
    window = Gtk.ApplicationWindow(application=application)
    title = os.environ.get('SAM_PROBE_TITLE', 'SAM probe document')
    window.set_title(title)
    window.set_default_size(420, 300)
    if os.environ.get('SAM_PROBE_SPLASH'):
        splash = Gtk.ApplicationWindow(application=application)
        splash.set_title(title)
        splash.set_default_size(300, 180)
        splash.set_resizable(False)
        splash.set_child(Gtk.Label(label='Fixed-size startup splash'))
        splash.present()
        def show_main():
            splash.close()
            window.present()
            return GLib.SOURCE_REMOVE
        GLib.timeout_add(450, show_main)
    window.set_child(Gtk.Label(label='Window placement regression probe'))
    if not os.environ.get('SAM_PROBE_SPLASH'):
        window.present()
    final_title = os.environ.get('SAM_PROBE_FINAL_TITLE')
    if final_title:
        def change_title():
            window.set_title(final_title)
            return GLib.SOURCE_REMOVE
        GLib.timeout_add(int(os.environ.get('SAM_PROBE_TITLE_DELAY', '350')), change_title)
    GLib.timeout_add(int(os.environ.get('SAM_PROBE_LIFETIME', '3000')),
                     lambda: (application.quit(), GLib.SOURCE_REMOVE)[1])


app.connect('activate', activate)
app.run([])
