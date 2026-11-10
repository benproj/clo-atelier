# Stand-in for CLO: fake API modules, then run the real bridge script.
# Used by test/e2e.mjs so the bridge and server can be tested without CLO.

import json
import os
import runpy
import sys
import types

patterns = []
seams = []
fabrics = ["Default Fabric"]


def module(name, **funcs):
    mod = types.ModuleType(name)
    for key, fn in funcs.items():
        setattr(mod, key, fn)
    sys.modules[name] = mod


def create_pattern(points):
    patterns.append({"name": "Pattern_%d" % len(patterns), "points": list(points), "fabric": 0})
    return len(patterns) - 1


def export_zpac(path):
    with open(path, "w") as f:
        json.dump({"patterns": patterns, "seams": seams, "fabrics": fabrics}, f)
    return path


def import_file(path):
    if path.endswith(".zpac"):
        with open(path) as f:
            data = json.load(f)
        patterns[:] = data["patterns"]
        seams[:] = [tuple(s) for s in data["seams"]]
        fabrics[:] = data["fabrics"]
    return True


def write_png(path):
    # 1x1 transparent PNG
    data = bytes.fromhex(
        "89504e470d0a1a0a0000000d49484452000000010000000108060000001f15c489"
        "0000000d49444154789c6300010000000500010d0a2db40000000049454e44ae426082")
    with open(path, "wb") as f:
        f.write(data)
    return path


module(
    "utility_api",
    GetMajorVersion=lambda: 2025, GetMinorVersion=lambda: 0, GetPatchVersion=lambda: 84,
    GetProjectName=lambda: "mock", GetProjectFilePath=lambda: "NULL",
    GetColorwayCount=lambda: 1, GetCurrentColorwayIndex=lambda: 0, GetColorwayName=lambda i: "Colorway A",
    Simulate=lambda steps: True, SetCamViewPoint=lambda i: None, Refresh3DWindow=lambda: None,
)
module(
    "pattern_api",
    GetPatternCount=lambda: len(patterns),
    CreatePatternWithPoints=create_pattern,
    SetPatternPieceName=lambda i, n: patterns[i].__setitem__("name", n),
    GetPatternPieceName=lambda i: patterns[i]["name"],
    SetPatternPieceFabricIndex=lambda i, f: patterns[i].__setitem__("fabric", f),
    GetPatternPiecePos=lambda i: [0.0, 0.0],
    GetPatternPieceArea=lambda i: 1.0,
    GetBoundingBoxOfPattern=lambda i: {"Width": "1", "Height": "1"},
    GetPatternInformation=lambda i: json.dumps(patterns[i]),
    GetPatternInputInformation=lambda i: json.dumps({"Pattern InputInformation": [{
        "LineList": [{"Line count": "1"}, {"Line index": "0", "Line length": 300, "Line type": "Straight type"}],
        "PointList": [{"Point count": str(len(patterns[i]["points"]))}] + [
            {"Point index": str(k), "Point positionX": pt[0], "Point positionY": pt[1]}
            for k, pt in enumerate(patterns[i]["points"])],
    }]}),
    GetSeamlinePairGroupCount=lambda: len(seams),
    GetSeamlinePairGroupListInPattern=lambda i: [k for k, s in enumerate(seams) if i in (s[0], s[2])],
    GetLineLength=lambda p, l: 300.0 if l % 2 == 0 else 500.0,
    GetArrangementList=lambda: [{"ArrangementName": "Body_Front"}, {"ArrangementName": "Leg_Skirt_Back"}],
    SetArrangement=lambda i, a: patterns[i].__setitem__("arr", a),
    GetArrangementOfPattern=lambda i: {"ArrangementName": ["Body_Front", "Leg_Skirt_Back"][patterns[i]["arr"]] if "arr" in patterns[i] else "Arrangement Point"},
    SetPatternLayer=lambda i, l: patterns[i].__setitem__("layer", l),
    GetPatternLayer=lambda i: patterns[i].get("layer", 0),
    DeletePatternPiece=lambda i: patterns.pop(i),
    AddSeamlinePairGroup=lambda *a: seams.append(a) or True,
)
module(
    "fabric_api",
    GetFabricCount=lambda cur: len(fabrics),
    GetFabricStyleNameList=lambda: list(fabrics),
    GetFabricInfo=lambda i: json.dumps({"name": fabrics[i]}),
    ExportZFab=lambda path, i: write_png(path),
    AddFabric=lambda path: fabrics.append(path) or len(fabrics) - 1,
    SetFabricName=lambda i, n: fabrics.__setitem__(i, n),
    SetFabricPBRMaterialBaseColor=lambda i, face, r, g, b, a: True,
    GetFabricName=lambda i: fabrics[i],
    GetFabricIndexForPattern=lambda i: patterns[i]["fabric"],
)
module("import_api", ImportFile=import_file)
module(
    "export_api",
    GetAvatarCount=lambda: 1, GetAvatarNameList=lambda: ["Mock Avatar"],
    ExportThumbnail3D=write_png,
    ExportZPac=export_zpac,
)

bridge = os.path.join(os.path.dirname(os.path.abspath(__file__)), "..", "bridge", "clo_mcp_bridge.py")
runpy.run_path(bridge, run_name="__main__")
