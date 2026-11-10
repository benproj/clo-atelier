# CLO MCP bridge
#
# Runs INSIDE CLO. Load it from CLO's Python Script editor and press Run.
# It opens a localhost socket and executes Python sent by the MCP server on
# CLO's main thread, where the CLO API modules (pattern_api, fabric_api,
# utility_api, import_api, export_api, rest_api) are available.
#
# While the bridge runs, this script does not return. CLO's interface stays
# responsive because the loop keeps pumping Qt events between requests.
# Stop it with the `clo_stop_bridge` MCP tool, or by running this script again.
#
# Standard library only: CLO ships its own Python 3.10 with no pip.

import ast
import builtins
import contextlib
import ctypes
import io
import json
import os
import secrets
import select
import socket
import sys
import time
import traceback

BRIDGE_VERSION = "0.1.0"
HOST = "127.0.0.1"
DEFAULT_PORT = int(os.environ.get("CLO_MCP_PORT", "9877"))
STATE_DIR = os.environ.get("CLO_MCP_STATE_DIR") or os.path.join(os.path.expanduser("~"), ".clo-mcp")
STATE_FILE = os.path.join(STATE_DIR, "bridge.json")
API_MODULE_NAMES = (
    "utility_api",
    "pattern_api",
    "fabric_api",
    "import_api",
    "export_api",
    "rest_api",
    "ApiTypes",
)
MAX_REQUEST_BYTES = 8 * 1024 * 1024
_FLAG = "_clo_mcp_bridge_state"


def _log(msg):
    try:
        print("[clo-mcp] " + msg)
    except Exception:
        pass


# --------------------------------------------------------------------------
# CLO API modules
# --------------------------------------------------------------------------

def _find_api_modules(script_globals):
    found = {}
    for name in API_MODULE_NAMES:
        mod = script_globals.get(name)
        if mod is None:
            mod = sys.modules.get(name)
        if mod is None:
            try:
                mod = __import__(name)
            except Exception:
                mod = None
        if mod is None:
            main = sys.modules.get("__main__")
            mod = getattr(main, name, None)
        if mod is not None:
            found[name] = mod
    return found


# --------------------------------------------------------------------------
# Keeping CLO's interface alive: pump the Qt event loop through ctypes
# --------------------------------------------------------------------------

def _make_qt_pump():
    """Return a callable that processes pending Qt events, or None."""
    symbol = "_ZN16QCoreApplication13processEventsE6QFlagsIN10QEventLoop17ProcessEventsFlagEE"
    candidates = [None]
    exe_dir = os.path.dirname(os.path.realpath(sys.executable or ""))
    for base in (exe_dir, os.path.join(exe_dir, "..", "Frameworks")):
        candidates.append(os.path.join(base, "QtCore.framework", "QtCore"))
        candidates.append(os.path.join(base, "..", "Frameworks", "QtCore.framework", "QtCore"))
        candidates.append(os.path.join(base, "Qt5Core.dll"))
    for cand in candidates:
        try:
            lib = ctypes.CDLL(cand)
            fn = getattr(lib, symbol)
        except Exception:
            continue
        fn.argtypes = [ctypes.c_int]
        fn.restype = None
        return lambda: fn(0)
    return None


def _make_quit_detector():
    """Return a callable that is True once CLO has closed all its windows.

    Quitting CLO while the bridge loop is running closes the windows but
    cannot unwind past this script, so the loop has to notice and return.
    macOS only; elsewhere it returns None.
    """
    if sys.platform != "darwin":
        return None
    try:
        objc = ctypes.CDLL("/usr/lib/libobjc.A.dylib")
        objc.objc_getClass.restype = ctypes.c_void_p
        objc.objc_getClass.argtypes = [ctypes.c_char_p]
        objc.sel_registerName.restype = ctypes.c_void_p
        objc.sel_registerName.argtypes = [ctypes.c_char_p]

        def send(restype, obj, sel, *args):
            argtypes = [ctypes.c_void_p, ctypes.c_void_p] + [ctypes.c_ulong] * len(args)
            fn = ctypes.cast(objc.objc_msgSend, ctypes.CFUNCTYPE(restype, *argtypes))
            return fn(obj, objc.sel_registerName(sel), *args)

        app = send(ctypes.c_void_p, objc.objc_getClass(b"NSApplication"), b"sharedApplication")
        if not app:
            return None

        def windows_gone():
            if send(ctypes.c_bool, app, b"isHidden"):
                return False
            wins = send(ctypes.c_void_p, app, b"windows")
            count = send(ctypes.c_ulong, wins, b"count") if wins else 0
            for i in range(count):
                w = send(ctypes.c_void_p, wins, b"objectAtIndex:", i)
                if send(ctypes.c_bool, w, b"isVisible") or send(ctypes.c_bool, w, b"isMiniaturized"):
                    return False
            return True

        windows_gone()  # make sure it works before trusting it
        return windows_gone
    except Exception:
        return None


# --------------------------------------------------------------------------
# Executing code
# --------------------------------------------------------------------------

def _to_jsonable(value, depth=0):
    if value is None or isinstance(value, (bool, int, float, str)):
        return value
    if depth > 8:
        return repr(value)
    if isinstance(value, bytes):
        return value.decode("utf-8", "replace")
    if isinstance(value, dict):
        return {str(k): _to_jsonable(v, depth + 1) for k, v in value.items()}
    if isinstance(value, (list, tuple, set, frozenset)):
        return [_to_jsonable(v, depth + 1) for v in value]
    # CLO API value types (CloApiRgb, options structs, ...): expose public fields
    fields = {}
    try:
        for name in dir(value):
            if name.startswith("_"):
                continue
            attr = getattr(value, name)
            if callable(attr):
                continue
            fields[name] = _to_jsonable(attr, depth + 1)
    except Exception:
        fields = {}
    if fields:
        fields["__type__"] = type(value).__name__
        return fields
    return repr(value)


def _execute(code, namespace):
    """Run `code`; the value of a trailing expression (or `result`) is returned."""
    out = io.StringIO()
    response = {"ok": True, "result": None}
    namespace.pop("result", None)
    try:
        tree = ast.parse(code, "<clo-mcp>", "exec")
        last_expr = None
        if tree.body and isinstance(tree.body[-1], ast.Expr):
            last_expr = ast.Expression(tree.body.pop().value)
            ast.fix_missing_locations(last_expr)
        with contextlib.redirect_stdout(out), contextlib.redirect_stderr(out):
            exec(compile(tree, "<clo-mcp>", "exec"), namespace)
            value = None
            if last_expr is not None:
                value = eval(compile(last_expr, "<clo-mcp>", "eval"), namespace)
            if value is None:
                value = namespace.get("result")
        response["result"] = _to_jsonable(value)
    except BaseException as exc:  # SystemExit from user code must not kill CLO
        response["ok"] = False
        response["error"] = "".join(traceback.format_exception(type(exc), exc, exc.__traceback__))
    response["stdout"] = out.getvalue()
    return response


# --------------------------------------------------------------------------
# Server loop
# --------------------------------------------------------------------------

class _Conn(object):
    def __init__(self, sock):
        self.sock = sock
        self.buf = b""
        self.authed = False


def _send(conn, payload):
    data = (json.dumps(payload) + "\n").encode("utf-8")
    conn.sock.setblocking(True)
    try:
        conn.sock.sendall(data)
    finally:
        conn.sock.setblocking(False)


def _handle(state, conn, line):
    try:
        req = json.loads(line.decode("utf-8"))
    except Exception:
        _send(conn, {"ok": False, "error": "invalid JSON"})
        return
    rid = req.get("id")
    if not conn.authed:
        if not secrets.compare_digest(str(req.get("token", "")), state["token"]):
            _send(conn, {"id": rid, "ok": False, "error": "bad token"})
            raise ConnectionError("bad token")
        conn.authed = True
    op = req.get("op")
    if op == "ping":
        resp = {
            "ok": True,
            "result": {
                "bridge_version": BRIDGE_VERSION,
                "python": sys.version.split()[0],
                "api_modules": sorted(state["modules"].keys()),
                "ui_pump": state["pump"] is not None,
                "pid": os.getpid(),
            },
        }
    elif op == "exec":
        resp = _execute(req.get("code", ""), state["namespace"])
    elif op == "stop":
        state["running"] = False
        resp = {"ok": True, "result": "bridge stopping"}
    else:
        resp = {"ok": False, "error": "unknown op: %r" % (op,)}
    resp["id"] = rid
    _send(conn, resp)


def _serve(state):
    srv = state["server"]
    conns = []
    pump = state["pump"]
    windows_gone = _make_quit_detector() if pump else None
    gone_checks = 0
    next_quit_check = time.time() + 5.0
    while state["running"]:
        try:
            readable, _, _ = select.select([srv] + [c.sock for c in conns], [], [], 0.01 if pump else 0.5)
        except Exception:
            conns = [c for c in conns if c.sock.fileno() != -1]
            readable = []
        for sock in readable:
            if sock is srv:
                try:
                    client, _addr = srv.accept()
                    client.setblocking(False)
                    conns.append(_Conn(client))
                except Exception:
                    pass
                continue
            conn = next((c for c in conns if c.sock is sock), None)
            if conn is None:
                continue
            try:
                chunk = sock.recv(65536)
                if not chunk:
                    raise ConnectionError("closed")
                conn.buf += chunk
                if len(conn.buf) > MAX_REQUEST_BYTES:
                    raise ConnectionError("request too large")
                while b"\n" in conn.buf:
                    line, conn.buf = conn.buf.split(b"\n", 1)
                    if line.strip():
                        _handle(state, conn, line)
            except (BlockingIOError, InterruptedError):
                pass
            except Exception:
                try:
                    sock.close()
                except Exception:
                    pass
                conns.remove(conn)
        if pump:
            try:
                pump()
            except Exception:
                pass
            if windows_gone and time.time() >= next_quit_check:
                next_quit_check = time.time() + 1.0
                try:
                    gone_checks = gone_checks + 1 if windows_gone() else 0
                except Exception:
                    gone_checks = 0
                if gone_checks >= 3:
                    state["running"] = False
    for c in conns:
        try:
            c.sock.close()
        except Exception:
            pass


def _bind():
    last_error = None
    for port in range(DEFAULT_PORT, DEFAULT_PORT + 10):
        srv = socket.socket(socket.AF_INET, socket.SOCK_STREAM)
        srv.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEADDR, 1)
        try:
            srv.bind((HOST, port))
            srv.listen(8)
            srv.setblocking(False)
            return srv, port
        except OSError as exc:
            last_error = exc
            srv.close()
    raise last_error


def _write_state_file(port, token):
    os.makedirs(STATE_DIR, exist_ok=True)
    try:
        os.chmod(STATE_DIR, 0o700)
    except Exception:
        pass
    fd = os.open(STATE_FILE, os.O_WRONLY | os.O_CREAT | os.O_TRUNC, 0o600)
    with os.fdopen(fd, "w") as f:
        json.dump({"host": HOST, "port": port, "token": token, "pid": os.getpid(),
                   "bridge_version": BRIDGE_VERSION}, f)


def main(script_globals):
    existing = getattr(builtins, _FLAG, None)
    if existing and existing.get("running"):
        # Running the script a second time is the manual way to stop the bridge.
        existing["running"] = False
        _log("Bridge stop requested. Run the script again to restart it.")
        return

    modules = _find_api_modules(script_globals)
    namespace = {"__name__": "__clo_mcp__", "__builtins__": builtins, "json": json, "os": os}
    namespace.update(modules)

    srv, port = _bind()
    token = secrets.token_hex(24)
    state = {
        "running": True,
        "server": srv,
        "token": token,
        "modules": modules,
        "namespace": namespace,
        "pump": _make_qt_pump(),
    }
    setattr(builtins, _FLAG, state)
    _write_state_file(port, token)
    _log("Bridge %s listening on %s:%d (API modules: %s; UI pump: %s)" % (
        BRIDGE_VERSION, HOST, port, ", ".join(sorted(modules)) or "none found",
        "on" if state["pump"] else "OFF - CLO will look frozen while the bridge runs"))
    try:
        _serve(state)
    finally:
        state["running"] = False
        try:
            srv.close()
        except Exception:
            pass
        try:
            os.remove(STATE_FILE)
        except Exception:
            pass
        _log("Bridge stopped.")


main(globals())
