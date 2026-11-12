# /// script
# requires-python = ">=3.12"
#
# [tool.orcaslicer.plugin]
# name = "3D Maker Generators"
# description = "Turn character art into multicolor trays, coins, keychains, magnets, coasters, bookmarks, cookie cutters and flat models, then send them to the plate with every part already on its filament slot."
# author = "G-Tech3D"
# version = "1.9.1"
# ///
"""3D Maker Generators for OrcaSlicer.

Once activated it adds a "3D Maker Generators" tab to Orca's top bar (it is also in Speed Dial,
as a panel that floats or docks beside the plate); build a tray, coin, keychain,
magnet or coaster there, match each color to one of the filaments loaded in Orca, and press
"Send to plate".

How the model reaches the plate: the plugin API cannot add objects, but every Orca instance
listens for the message a second launch sends it ("open these files"). The plugin writes the
model into its own storage folder and sends that message to the Orca it runs in, the same way
the Model Search plugin does. The file is a 3MF whose Metadata/model_settings.config gives each
part its filament slot; it carries no printer or filament settings, so Orca keeps yours.

  page   --{cmd: 'hello'}-->            plugin   (replies {cmd: 'slots', slots, plate})
  page   --{cmd: 'send', name, b64}-->  plugin   (writes the 3MF, hands it to Orca, replies {cmd: 'sent'})
  page   --{cmd: 'open', url}-->        plugin   (opens a link in the default browser)
"""
import base64
import os
import re
import subprocess
import sys
import zlib

import orca

TITLE = "3D Maker Generators"
PLUGIN_DIR_NAME = "maker-generators"
KEEP_SENT_FILES = 12
MAX_MODEL_BYTES = 300 * 1024 * 1024

# The generator page: one self-contained HTML file (three.js and fonts inlined), zlib + base64.
_PAGE_Z = (
__PAGE_DATA__
)


def page_html():
    return zlib.decompress(base64.b64decode("".join(_PAGE_Z))).decode("utf-8")


# ---------------------------------------------------------------- Orca state for the page

def _clean_colour(value):
    value = (value or "").strip().strip('"')
    if re.fullmatch(r"#[0-9A-Fa-f]{6}([0-9A-Fa-f]{2})?", value):
        return value[:7]
    return "#888888"


def filament_slots():
    """The filaments loaded in Orca, in slot order: [{name, color}]."""
    bundle = orca.host.preset_bundle()
    names = [str(n) for n in bundle.current_filament_preset_names()]
    raw = bundle.full_config_value("filament_colour") or ""
    colours = [c for c in re.split(r";", raw)] if raw else []
    slots = []
    for i, name in enumerate(names):
        slots.append({"name": name, "color": _clean_colour(colours[i] if i < len(colours) else "")})
    return slots


def plate_object_count():
    try:
        return len(list(orca.host.model().objects()))
    except Exception:
        return 0


# ---------------------------------------------------------------- where sent files live

def storage_dir():
    """This plugin's own folder under Orca's data directory (no permission prompt needed there)."""
    try:
        path = orca.host.plugin.storage()
        if path:
            return path
    except Exception:
        pass
    # Fallback: <data_dir>/orca_plugins/plugin_data/<name>, found from this file's location.
    here = os.path.abspath(__file__)
    for _ in range(8):
        here = os.path.dirname(here)
        if os.path.basename(here) == "orca_plugins":
            return os.path.join(here, "plugin_data", PLUGIN_DIR_NAME)
    raise RuntimeError("could not find the plugin storage folder")


def write_model(name, data):
    folder = os.path.join(storage_dir(), "sent")
    os.makedirs(folder, exist_ok=True)
    safe = re.sub(r"[^\w-]+", "_", name or "").strip("_")[:60] or "model"
    path = os.path.join(folder, safe + ".3mf")
    tmp = path + ".part"
    with open(tmp, "wb") as fh:
        fh.write(data)
    os.replace(tmp, path)
    # keep the folder small: drop the oldest models
    try:
        files = [os.path.join(folder, f) for f in os.listdir(folder) if f.endswith(".3mf")]
        files.sort(key=os.path.getmtime, reverse=True)
        for old in files[KEEP_SENT_FILES:]:
            os.remove(old)
    except OSError:
        pass
    return path


# ---------------------------------------------------------------- hand the file to this Orca

def _instance_payload(paths):
    """The argv a second launch sends, in Orca's unescape_strings_cstyle format (argv[0] is skipped)."""
    argv = ["orca-slicer"] + list(paths)
    return ";".join('"%s"' % a.replace("\\", "\\\\").replace('"', '\\"') for a in argv)


def _handoff_windows(paths):
    """WM_COPYDATA to our own main window, exactly what a second OrcaSlicer.exe would send.

    Orca's handler only posts an event (OtherInstanceMessageHandler::handle_message), so sending
    from the UI thread returns at once and the file loads after this callback finishes.
    """
    import ctypes
    from ctypes import wintypes

    user32 = ctypes.WinDLL("user32", use_last_error=True)
    kernel32 = ctypes.WinDLL("kernel32", use_last_error=True)
    user32.GetPropW.restype = wintypes.HANDLE
    user32.GetPropW.argtypes = [wintypes.HWND, wintypes.LPCWSTR]
    user32.GetClassNameW.argtypes = [wintypes.HWND, wintypes.LPWSTR, ctypes.c_int]
    user32.GetWindowThreadProcessId.argtypes = [wintypes.HWND, ctypes.POINTER(wintypes.DWORD)]
    user32.SendMessageW.restype = ctypes.c_ssize_t
    user32.SendMessageW.argtypes = [wintypes.HWND, ctypes.c_uint, ctypes.c_void_p, ctypes.c_void_p]

    class COPYDATASTRUCT(ctypes.Structure):
        _fields_ = [("dwData", ctypes.c_void_p), ("cbData", wintypes.DWORD), ("lpData", ctypes.c_void_p)]

    our_pid = kernel32.GetCurrentProcessId()
    found = []

    def _enum(hwnd, _lparam):
        name = ctypes.create_unicode_buffer(256)
        if user32.GetClassNameW(hwnd, name, 256) == 0 or name.value != "wxWindowNR":
            return True
        # Orca sets these two properties on its main frame only.
        if not user32.GetPropW(hwnd, "Instance_Hash_Minor") or not user32.GetPropW(hwnd, "Instance_Hash_Major"):
            return True
        pid = wintypes.DWORD()
        user32.GetWindowThreadProcessId(hwnd, ctypes.byref(pid))
        if pid.value != our_pid:
            return True
        found.append(hwnd)
        return False

    proc = ctypes.WINFUNCTYPE(wintypes.BOOL, wintypes.HWND, wintypes.LPARAM)(_enum)
    user32.EnumWindows(proc, 0)
    if not found:
        return False, "could not find the OrcaSlicer main window"
    buf = ctypes.create_unicode_buffer(_instance_payload(paths))
    data = COPYDATASTRUCT(ctypes.c_void_p(1), ctypes.sizeof(buf), ctypes.cast(buf, ctypes.c_void_p))
    user32.SendMessageW(found[0], 0x004A, None, ctypes.byref(data))  # WM_COPYDATA
    return True, ""


def _orca_executable():
    if sys.platform == "darwin":
        import ctypes

        buf = ctypes.create_string_buffer(4096)
        size = ctypes.c_uint32(len(buf))
        if ctypes.CDLL(None)._NSGetExecutablePath(buf, ctypes.byref(size)) == 0:
            return os.path.realpath(buf.value.decode())
    return os.path.realpath("/proc/self/exe") if os.path.exists("/proc/self/exe") else (sys.executable or "")


def _handoff_macos(paths):
    """`open -a <bundle> file` delivers an open-documents event to the running app."""
    bundle = _orca_executable()
    for _ in range(3):  # <bundle>.app/Contents/MacOS/<exe>
        bundle = os.path.dirname(bundle)
    if not bundle.endswith(".app"):
        return False, "not running from an .app bundle"
    try:
        subprocess.Popen(["/usr/bin/open", "-a", bundle] + list(paths),
                         stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
    except Exception as error:
        return False, str(error)
    return True, ""


def _own_instance_hashes():
    """Instance hashes of this data directory (Orca names <data_dir>/cache/<hash>.lock), newest first."""
    try:
        here = storage_dir()
        while os.path.basename(here) != "orca_plugins":
            parent = os.path.dirname(here)
            if parent == here:
                return []
            here = parent
        cache = os.path.join(os.path.dirname(here), "cache")
        locks = [f for f in os.listdir(cache) if f.endswith(".lock") and f[:-5].isdigit()]
        locks.sort(key=lambda f: os.path.getmtime(os.path.join(cache, f)), reverse=True)
        return [f[:-5] for f in locks]
    except Exception:
        return []


def _dbus_another_instance(instance, payload):
    iface = "com.orcaslicer.OrcaSlicer.InstanceCheck.Object" + instance
    # Output is inherited rather than captured or sent to /dev/null: opening either makes Orca's
    # plugin sandbox ask for file permission (dbus-send prints nothing for a plain method call).
    return subprocess.run(
        ["dbus-send", "--session", "--type=method_call", "--dest=" + iface,
         "/com/orcaslicer/OrcaSlicer/InstanceCheck/Object" + instance,
         iface + ".AnotherInstance", "string:" + payload],
        timeout=15).returncode == 0


def _handoff_linux(paths):
    """The session-bus call a second launch makes (InstanceCheck AnotherInstance)."""
    payload = _instance_payload(paths)
    try:
        # Orca names <data_dir>/cache/<hash>.lock after the same hash its bus name carries.
        for instance in _own_instance_hashes():
            if _dbus_another_instance(instance, payload):
                return True, ""
    except FileNotFoundError:
        return False, "dbus-send is not installed"
    except Exception as error:
        return False, str(error)
    return False, "could not reach this OrcaSlicer on the session bus"


def load_into_orca(path):
    if os.name == "nt":
        return _handoff_windows([path])
    if sys.platform == "darwin":
        return _handoff_macos([path])
    return _handoff_linux([path])


# ---------------------------------------------------------------- talking to the page

def post_slots(post):
    try:
        slots = filament_slots()
    except Exception as error:
        print("maker-generators: could not read filaments: %s" % error, file=sys.stderr)
        slots = []
    post({"cmd": "slots", "slots": slots, "plate": plate_object_count()})


def send_model(post, message):
    name = str(message.get("name") or "model")
    try:
        encoded = str(message.get("b64") or "")
        if not encoded or len(encoded) > MAX_MODEL_BYTES * 4 // 3 + 4:
            raise ValueError("the model is empty or too large")
        data = base64.b64decode(encoded, validate=True)
        if not data.startswith(b"PK"):
            raise ValueError("the model is not a 3MF file")
        path = write_model(name, data)
        ok, why = load_into_orca(path)
    except Exception as error:
        ok, why, path = False, str(error), ""
    if ok:
        text = "Sent %s to the plate." % os.path.basename(path)
    else:
        text = "Could not send to the plate: %s." % why
        print("maker-generators: %s" % text, file=sys.stderr)
    post({"cmd": "sent", "ok": ok, "message": text, "file": path})


def handle_message(post, message):
    """Called on the UI thread when the page posts; post(dict) answers the page."""
    message = message if isinstance(message, dict) else {}
    command = message.get("cmd")
    if command == "hello":
        post_slots(post)
    elif command == "log":
        print("maker-generators page: %s" % str(message.get("text"))[:500], file=sys.stderr)
    elif command == "reset":
        # Reset: the page replaces itself with a fresh copy (a reload is blank on Windows).
        print("maker-generators: sending fresh page", file=sys.stderr)
        post({"cmd": "page", "html": page_html()})
    elif command == "send":
        send_model(post, message)
    elif command == "open":
        url = str(message.get("url") or "")
        if re.match(r"^https://", url):
            import webbrowser
            webbrowser.open(url)


# ---------------------------------------------------------------- the tab in Orca's top bar

class MakerGeneratorsTab(orca.pages.PagesPluginCapabilityBase):
    """The generator as its own tab next to Prepare, Preview, Device and Project."""

    def get_name(self):
        return TITLE

    def get_ui(self):
        return page_html()

    def on_message(self, message):
        handle_message(self.post_message, message)


# ---------------------------------------------------------------- Speed Dial: a floating panel

class MakerGeneratorsPanel(orca.script.ScriptPluginCapabilityBase):
    """The same generator from Speed Dial (Space), in a panel that floats or docks beside the plate."""
    window = None

    def get_name(self):
        return TITLE + " (panel)"

    def execute(self):
        if self.window is not None and self.window.is_open():
            self.window.show()
            return orca.ExecutionResult.success(TITLE + " is already open.")
        # A dock panel rather than a dialog window: a dialog closes on Esc, which the generator
        # uses to dismiss its own pop-ups.
        self.window = orca.host.ui.create_dock_panel(
            html=page_html(), title=TITLE, width=1200, height=820,
            on_message=lambda message: handle_message(self.post, message),
            on_close=self.on_close, dock="float")
        return orca.ExecutionResult.success(TITLE + " opened.")

    def post(self, payload):
        if self.window is not None and self.window.is_open():
            self.window.post(payload)

    def on_close(self):
        self.window = None


@orca.plugin
class MakerGeneratorsPlugin(orca.base):
    def register_capabilities(self):
        orca.register_capability(MakerGeneratorsTab)
        orca.register_capability(MakerGeneratorsPanel)
