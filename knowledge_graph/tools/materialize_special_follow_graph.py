#!/usr/bin/env python3
"""Materialize verified special-follow evidence into a staged UI knowledge graph."""

from __future__ import annotations

import argparse
import hashlib
import json
import re
import shutil
from collections import defaultdict
from copy import deepcopy
from pathlib import Path
from typing import Any

import yaml
from PIL import Image, ImageDraw


SCRIPT_DIR = Path(__file__).resolve().parent
GRAPH_ROOT = SCRIPT_DIR.parent
SPEC_PATH = GRAPH_ROOT / "materialization" / "zto-connect-fat-messages-special-follow-recursive-20260728.yaml"
POLICY_PATH = GRAPH_ROOT / "materialization" / "zto-connect-fat-messages-special-follow-normalization-policy-20260728.yaml"
APP_KEY = "zto.connect"
APP_ID = "01KY6Z7BD8J607T07GS5NCN9RN"
EXPLORATION_ID = "zto-connect-fat-messages-special-follow-normalization-20260728"
UPDATE_ID = "zto-connect-fat-special-follow-popup-backdrop-repair-20260731"
UPDATE_RECORDED_AT = "2026-07-31T17:01:00+08:00"
MANIFEST_GENERATED_AT = "2026-07-31T17:01:00+08:00"
GRAPH_REVISION = "zto-connect-uikg301-20260731.3"
BUILD_REF = "android-package:com.zto.connect.fat@10542"
DEVICE_FALLBACK = "sha256:b1485ad4b9da3cb307ec62ea7b5c062bd3753b1875f0897bdbe49cba51e5eb36"
SCHEMA_VERSION = "3.0.0"
NORMATIVE_SPEC_VERSION = "UIKG 3.0.1"
NORMATIVE_SPEC_HASH = "sha256:03904e083f55a42e36b035db877d2bf575f6973426a2abde089326b51833969f"


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--source-root", type=Path, default=GRAPH_ROOT)
    parser.add_argument(
        "--output-root",
        type=Path,
        default=GRAPH_ROOT / ".staging" / UPDATE_ID,
    )
    return parser.parse_args()


def read_yaml(path: Path) -> dict[str, Any]:
    value = yaml.safe_load(path.read_text(encoding="utf-8"))
    if not isinstance(value, dict):
        raise ValueError(f"expected YAML mapping: {path}")
    return value


def read_json(path: Path) -> dict[str, Any]:
    value = json.loads(path.read_text(encoding="utf-8"))
    if not isinstance(value, dict):
        raise ValueError(f"expected JSON object: {path}")
    return value


def read_jsonl(path: Path) -> list[dict[str, Any]]:
    if not path.is_file():
        return []
    records: list[dict[str, Any]] = []
    for line in path.read_text(encoding="utf-8").splitlines():
        if line.strip():
            value = json.loads(line)
            if isinstance(value, dict):
                records.append(value)
    return records


def dump_yaml(path: Path, value: Any) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(
        yaml.safe_dump(value, allow_unicode=True, sort_keys=False, width=120),
        encoding="utf-8",
    )


def deterministic_id(kind: str, key: str) -> str:
    alphabet = "0123456789ABCDEFGHJKMNPQRSTVWXYZ"
    digest = hashlib.sha256(f"{APP_KEY}:{kind}:{key}".encode()).digest()
    number = int.from_bytes(digest[:10], "big")
    suffix = ""
    for _ in range(16):
        suffix = alphabet[number & 31] + suffix
        number >>= 5
    return "01KYKA3ENB" + suffix


def sha256_json(value: Any) -> str:
    payload = json.dumps(value, ensure_ascii=False, sort_keys=True, separators=(",", ":"))
    return "sha256:" + hashlib.sha256(payload.encode("utf-8")).hexdigest()


def sha256_files(paths: list[Path], base: Path) -> str:
    digest = hashlib.sha256()
    for path in sorted(paths):
        digest.update(path.relative_to(base).as_posix().encode())
        digest.update(b"\0")
        digest.update(path.read_bytes())
        digest.update(b"\0")
    return "sha256:" + digest.hexdigest()


def normalize_rect(rect: dict[str, Any] | None) -> dict[str, float] | None:
    if not rect:
        return None
    left = rect.get("left", rect.get("x"))
    top = rect.get("top", rect.get("y"))
    width = rect.get("width")
    height = rect.get("height")
    if any(value is None for value in (left, top, width, height)):
        return None
    return {"left": float(left), "top": float(top), "width": float(width), "height": float(height)}


def qualified_frame(frame: dict[str, Any], observation: dict[str, Any] | None) -> bool:
    if frame.get("recognitionStatus") != "complete":
        return False
    if frame.get("controlInventoryStatus") != "pass" or frame.get("quality") != "complete":
        return False
    if not frame.get("stability", {}).get("settled"):
        return False
    if observation is None or observation.get("semanticStatus") != "complete":
        return False
    if observation.get("operationalFailures"):
        return False
    return all(item.get("status") == "pass" for item in observation.get("requiredAssertionStatuses", []))


def qualified_trace(trace: dict[str, Any]) -> bool:
    postcondition = trace.get("postcondition", {})
    return (
        trace.get("result") == "success"
        and postcondition.get("status") == "pass"
        and not postcondition.get("failures")
        and all(item.get("status") == "pass" for item in postcondition.get("semanticAssertions", []))
    )


def resource_path(raw_root: Path, resource_ref: str, suffix: str) -> Path:
    digest = resource_ref[7:] if resource_ref.startswith("sha256:") else resource_ref
    return raw_root / "resources" / "sha256" / digest[:2] / f"{digest}.{suffix}"


def collect_evidence(source_root: Path) -> dict[str, Any]:
    frames: dict[str, dict[str, Any]] = {}
    observations: dict[str, dict[str, Any]] = {}
    traces: list[dict[str, Any]] = []
    sessions: dict[str, dict[str, Any]] = {}
    session_roots: dict[str, Path] = {}
    workerA_refs: list[str] = []
    for session_dir in sorted(source_root.glob("explorations/*special-follow*/raw-evidence/sessions/*")):
        session_path = session_dir / "raw-session.json"
        if not session_path.is_file():
            continue
        session = read_json(session_path)
        if session.get("executionAuthorization", {}).get("offlineFixture"):
            continue
        session_id = session.get("id")
        sessions[session_id] = session
        session_roots[session_id] = session_dir.parent.parent
        for observation in read_jsonl(session_dir / "raw-observations.jsonl"):
            observations[observation.get("frameRef")] = observation
        for frame in read_jsonl(session_dir / "raw-frames.jsonl"):
            frames[frame["id"]] = frame
            if any(result.get("operation") == "worker_a" for result in frame.get("recognitionResults", [])):
                workerA_refs.append(frame["id"])
        traces.extend(read_jsonl(session_dir / "raw-action-traces.jsonl"))
    valid_frames = {
        frame_id: frame
        for frame_id, frame in frames.items()
        if qualified_frame(frame, observations.get(frame_id))
    }
    valid_traces = [
        trace
        for trace in traces
        if qualified_trace(trace)
        and trace.get("beforeFrameRef") in valid_frames
        and trace.get("afterFrameRef") in valid_frames
    ]
    by_hint: dict[str, list[dict[str, Any]]] = defaultdict(list)
    for frame in valid_frames.values():
        by_hint[frame.get("planStateKeyHint", "")].append(frame)
    for values in by_hint.values():
        values.sort(key=lambda item: item.get("capturedAt", ""), reverse=True)
    return {
        "frames": frames,
        "observations": observations,
        "traces": traces,
        "sessions": sessions,
        "sessionRoots": session_roots,
        "validFrames": valid_frames,
        "validTraces": valid_traces,
        "byHint": by_hint,
        "workerAFrameRefs": workerA_refs,
    }


def resolved_graph_path(source_root: Path, relative_ref: str) -> Path:
    path = (source_root / relative_ref).resolve()
    try:
        path.relative_to(source_root.resolve())
    except ValueError:
        raise ValueError(f"evidence reference escapes graph root: {relative_ref}")
    return path


def validate_locator(locator_key: str, locator: dict[str, Any], frame: dict[str, Any]) -> dict[str, Any]:
    if locator.get("status") != "pass" or locator.get("frameRef") != frame["frameId"]:
        raise ValueError(f"live locator is not bound to its frozen frame: {locator_key}")
    rect = normalize_rect(locator.get("rect"))
    center = locator.get("center")
    dpr = locator.get("dpr")
    if rect is None or rect["width"] <= 0 or rect["height"] <= 0:
        raise ValueError(f"live locator has an invalid rect: {locator_key}")
    if not isinstance(center, list) or len(center) != 2 or not all(isinstance(value, (int, float)) for value in center):
        raise ValueError(f"live locator has an invalid center: {locator_key}")
    claimed_center = [float(center[0]), float(center[1])]
    if not (
        rect["left"] <= claimed_center[0] <= rect["left"] + rect["width"]
        and rect["top"] <= claimed_center[1] <= rect["top"] + rect["height"]
    ):
        raise ValueError(f"live locator center is outside rect: {locator_key}")
    viewport = frame["viewport"]
    if (
        rect["left"] < 0
        or rect["top"] < 0
        or rect["left"] + rect["width"] > viewport["width"]
        or rect["top"] + rect["height"] > viewport["height"]
    ):
        raise ValueError(f"live locator is outside screenshot bounds: {locator_key}")
    if not isinstance(dpr, (int, float)) or dpr <= 0:
        raise ValueError(f"live locator has an invalid dpr: {locator_key}")
    return {**locator, "rect": rect, "center": claimed_center, "dpr": float(dpr)}


def collect_live_evidence_source(source_root: Path, config: dict[str, Any]) -> dict[str, Any]:
    index_path = resolved_graph_path(source_root, config["evidenceIndexRef"])
    index = read_json(index_path)
    exploration_ref = config["explorationRef"]
    if index.get("explorationRef") != exploration_ref:
        raise ValueError("live evidence index explorationRef does not match the materialization spec")
    exploration_root = index_path.parent
    frames: dict[str, dict[str, Any]] = {}
    by_state: dict[str, dict[str, Any]] = {}
    for raw_frame in index.get("frames", []):
        frame = deepcopy(raw_frame)
        frame_id = frame.get("frameId")
        state_key = frame.get("stateKey")
        if not frame_id or frame_id != frame.get("screenshotRef") or not frame_id.startswith("sha256:"):
            raise ValueError(f"live frame has invalid identity: {state_key}")
        screenshot_path = resolved_graph_path(exploration_root, frame["screenshotPath"])
        if "sha256:" + hashlib.sha256(screenshot_path.read_bytes()).hexdigest() != frame_id:
            raise ValueError(f"live screenshot bytes do not match frameId: {state_key}")
        workerA_path = resolved_graph_path(exploration_root, frame["workerARef"])
        worker_b_path = resolved_graph_path(exploration_root, frame["workerBRef"])
        locator_path = resolved_graph_path(exploration_root, frame["locatorRef"])
        workerA = read_json(workerA_path)
        worker_b_answer = read_json(worker_b_path)
        locator_record = read_json(locator_path)
        if workerA.get("frameId") != frame_id:
            raise ValueError(f"Worker A result is not bound to live frame: {state_key}")
        if not worker_b_answer:
            raise ValueError(f"Worker B answer is empty: {state_key}")
        if locator_record.get("frameId") != frame_id or locator_record.get("screenshotRef") != frame_id:
            raise ValueError(f"locator record is not bound to live frame: {state_key}")
        record_locators = locator_record.get("locators", {})
        if set(record_locators) != set(frame.get("locators", {})):
            raise ValueError(f"evidence index and locator record differ: {state_key}")
        validated_locators = {
            key: validate_locator(key, value, frame) for key, value in record_locators.items()
        }
        frame["locators"] = validated_locators
        frame["explorationRef"] = exploration_ref
        frame["sourcePath"] = screenshot_path
        frame["workerAPath"] = workerA_path
        frame["workerBPath"] = worker_b_path
        frame["locatorPath"] = locator_path
        if frame_id in frames or state_key in by_state:
            raise ValueError(f"duplicate live frame identity or state: {state_key}")
        frames[frame_id] = frame
        by_state[state_key] = frame

    live_actions = index.get("actions", [])
    action_ids: set[str] = set()
    for action in live_actions:
        action_id = action.get("id")
        if not action_id or action_id in action_ids:
            raise ValueError(f"live evidence has a missing or duplicate action ID: {action_id}")
        if action.get("status") != "executed_verified":
            raise ValueError(f"indexed live action is not verified: {action_id}")
        if action.get("beforeFrameRef") not in frames:
            raise ValueError(f"indexed live action lacks its before frame: {action_id}")
        action_ids.add(action_id)

    bindings: dict[str, dict[str, Any]] = {}
    for binding_key, binding in config.get("bindings", {}).items():
        frame = by_state.get(binding["stateKey"])
        if frame is None:
            raise ValueError(f"live locator binding has an unknown state: {binding_key}")
        locator = frame["locators"].get(binding["locatorKey"])
        if locator is None:
            raise ValueError(f"live locator binding has an unknown locator: {binding_key}")
        bindings[binding_key] = {
            "frame": frame,
            "locator": locator,
            "explorationRef": exploration_ref,
        }
    return {
        "liveFrames": frames,
        "liveByState": by_state,
        "liveBindings": bindings,
        "liveTransitionBindings": config.get("transitions", {}),
        "liveActions": live_actions,
        "liveExplorationRef": exploration_ref,
        "liveModelDiagnostics": index.get("modelDiagnostics", {}),
    }


def collect_live_evidence(source_root: Path, spec: dict[str, Any]) -> dict[str, Any]:
    configs = spec.get("liveEvidenceSources")
    if configs is None:
        config = spec.get("liveEvidence")
        configs = [config] if config else []
    if not configs:
        return {
            "liveFrames": {},
            "liveByState": {},
            "liveBindings": {},
            "liveTransitionBindings": {},
            "liveActions": [],
            "liveExplorationRef": None,
            "liveExplorationRefs": [],
            "pageLiveExplorationRefs": [],
            "liveModelDiagnostics": {},
            "liveModelDiagnosticsByExploration": {},
        }

    combined = {
        "liveFrames": {},
        "liveByState": {},
        "liveBindings": {},
        "liveTransitionBindings": {},
        "liveActions": [],
        "liveExplorationRef": None,
        "liveExplorationRefs": [],
        "pageLiveExplorationRefs": [],
        "liveModelDiagnostics": {},
        "liveModelDiagnosticsByExploration": {},
    }
    action_ids: set[str] = set()
    for config in configs:
        source = collect_live_evidence_source(source_root, config)
        for field in ("liveFrames", "liveByState", "liveBindings", "liveTransitionBindings"):
            overlap = set(combined[field]) & set(source[field])
            if overlap:
                raise ValueError(f"duplicate live evidence {field}: {sorted(overlap)}")
            combined[field].update(source[field])
        for action in source["liveActions"]:
            if action["id"] in action_ids:
                raise ValueError(f"duplicate live evidence action: {action['id']}")
            action_ids.add(action["id"])
            combined["liveActions"].append(action)
        exploration_ref = source["liveExplorationRef"]
        combined["liveExplorationRefs"].append(exploration_ref)
        if config.get("pageProvenanceEligible", True):
            combined["pageLiveExplorationRefs"].append(exploration_ref)
        combined["liveExplorationRef"] = exploration_ref
        combined["liveModelDiagnostics"] = source["liveModelDiagnostics"]
        combined["liveModelDiagnosticsByExploration"][exploration_ref] = source[
            "liveModelDiagnostics"
        ]
    return combined


def matches_element_target(element: dict[str, Any], candidate_key: str) -> bool:
    if candidate_key in element.get("targetKeys", []):
        return True
    return any(re.fullmatch(pattern, candidate_key) for pattern in element.get("targetKeyPatterns", []))


def control_candidates(element: dict[str, Any], evidence: dict[str, Any]) -> list[dict[str, Any]]:
    candidates: list[dict[str, Any]] = []
    include_visible_controls = element.get("candidateSource") in (None, "visible_control")
    include_action_traces = element.get("candidateSource") in (None, "action_trace")
    for frame in (evidence["validFrames"].values() if include_visible_controls else []):
        for control in frame.get("visibleControls", []):
            key = control.get("candidateKey", "")
            if not key or not matches_element_target(element, key):
                continue
            rect = normalize_rect(control.get("locator", {}).get("screenshot", {}).get("rect"))
            rect = rect or normalize_rect(control.get("geometry", {}).get("bbox"))
            if rect:
                candidates.append({"frame": frame, "rect": rect, "control": control, "trace": None})
    for trace in (evidence["validTraces"] if include_action_traces else []):
        target = trace.get("targetCandidate") or {}
        key = target.get("key", "")
        if not key or not matches_element_target(element, key):
            continue
        locator = next(
            (
                item
                for item in trace.get("locatorAttempts", [])
                if item.get("result") == "pass" and item.get("runtimeLocator")
            ),
            None,
        )
        if not locator:
            continue
        rect = normalize_rect(locator["runtimeLocator"].get("screenshot", {}).get("rect"))
        if rect:
            candidates.append(
                {
                    "frame": evidence["validFrames"][trace["beforeFrameRef"]],
                    "rect": rect,
                    "control": None,
                    "trace": trace,
                    "locatorEvidenceRef": locator.get("evidenceRef"),
                }
            )
    candidates.sort(key=lambda item: item["frame"].get("capturedAt", ""), reverse=True)
    return candidates


def trace_matches_transition(transition: dict[str, Any], trace: dict[str, Any]) -> bool:
    from_hints = transition.get("fromStateHints", [])
    to_hints = transition.get("toStateHints", [])
    if from_hints and trace.get("fromPlanStateKeyHint") not in from_hints:
        return False
    if to_hints and trace.get("toPlanStateKeyHint") not in to_hints:
        return False
    target_key = (trace.get("targetCandidate") or {}).get("key")
    operation = trace.get("invocation", {}).get("operation")
    semantic_action = trace.get("invocation", {}).get("semanticAction")
    if transition.get("actionTargetKeys") and target_key in transition["actionTargetKeys"]:
        return True
    if transition.get("operations") and operation in transition["operations"]:
        return True
    return semantic_action == transition.get("capability")


def frame_observation(frame: dict[str, Any], evidence: dict[str, Any]) -> dict[str, Any]:
    session = evidence["sessions"][frame["sessionRef"]]
    raw_root = evidence["sessionRoots"][frame["sessionRef"]]
    screenshot_ref = frame["screenshot"]["resourceRef"]
    return {
        "frameRef": frame["id"],
        "observedAt": frame["capturedAt"],
        "buildRef": BUILD_REF,
        "deviceRef": session.get("rawDeviceContext", {}).get("serialHash", DEVICE_FALLBACK),
        "viewport": {
            "width": frame["screenshot"]["pixelSize"]["width"],
            "height": frame["screenshot"]["pixelSize"]["height"],
            "orientation": session.get("rawDeviceContext", {}).get("orientation", "portrait"),
        },
        "stateProperties": {
            "planStateKeyHint": frame.get("planStateKeyHint"),
            "independentWorker A": "missing_from_legacy_capture",
            "workerBRecognition": "complete",
        },
        "screenshotRef": screenshot_ref,
        "rawEvidenceRef": str(raw_root.relative_to(GRAPH_ROOT) / "sessions" / frame["sessionRef"]),
        "evidenceStatus": "workerB_verified_pending_independent_workerA",
    }


def element_observation(candidate: dict[str, Any], evidence: dict[str, Any]) -> dict[str, Any]:
    frame = candidate["frame"]
    base = frame_observation(frame, evidence)
    rect = candidate["rect"]
    control = candidate.get("control") or {}
    trace = candidate.get("trace") or {}
    center = [rect["left"] + rect["width"] / 2, rect["top"] + rect["height"] / 2]
    base.update(
        {
            "locator": {
                "rect": rect,
                "center": center,
                "dpr": 1,
                "status": "pass",
                "evidenceRef": candidate.get("locatorEvidenceRef")
                or control.get("locatorEvidenceRef")
                or control.get("locator", {}).get("evidenceRef"),
            },
            "state": control.get("visibleState", "visible_and_actionable"),
            "stateProperties": {
                "enabled": control.get("enabled", True if trace else None),
                "selected": None,
                "checked": None,
            },
            "dynamicValue": control.get("visibleState") if control else None,
            "actionTraceRef": trace.get("id"),
        }
    )
    return base


def live_frame_observation(frame: dict[str, Any], exploration_ref: str) -> dict[str, Any]:
    return {
        "frameRef": frame["frameId"],
        "observedAt": frame["observedAt"],
        "buildRef": frame["buildRef"],
        "deviceRef": frame["deviceRef"],
        "viewport": deepcopy(frame["viewport"]),
        "stateProperties": {
            "planStateKeyHint": frame["stateKey"],
            "independentWorker A": "complete",
            "workerBReconciliation": "complete",
        },
        "screenshotRef": frame["screenshotRef"],
        "rawEvidenceRef": f"explorations/{exploration_ref}",
        "evidenceStatus": "dual_model_verified_live_frame",
    }


def live_element_observation(
    candidate: dict[str, Any],
    binding: dict[str, Any],
    exploration_ref: str,
) -> dict[str, Any]:
    frame = binding["frame"]
    locator = binding["locator"]
    base = live_frame_observation(frame, exploration_ref)
    locator_payload = {
        "frameRef": frame["frameId"],
        "prompt": locator.get("prompt"),
        "rect": locator["rect"],
        "center": locator["center"],
        "dpr": locator["dpr"],
    }
    base.update(
        {
            "locator": {
                "rect": deepcopy(locator["rect"]),
                "center": deepcopy(locator["center"]),
                "dpr": locator["dpr"],
                "status": "pass",
                "evidenceRef": sha256_json(locator_payload),
            },
            "state": candidate.get("observationState", "visible"),
            "stateProperties": deepcopy(candidate.get("observationStateProperties", {})),
            "dynamicValue": candidate.get("observationDynamicValue"),
            "actionTraceRef": None,
        }
    )
    return base


def live_transition_trace(
    source_root: Path,
    transition_key: str,
    evidence: dict[str, Any],
) -> dict[str, Any] | None:
    binding = evidence["liveTransitionBindings"].get(transition_key)
    if binding is None:
        return None
    action_path = resolved_graph_path(source_root, binding["actionRecordRef"])
    action = read_json(action_path)
    if action.get("status") != "executed_verified" or action.get("assertion", {}).get("pass") is not True:
        raise ValueError(f"live transition action is not verified: {transition_key}")
    before_frame = evidence["liveFrames"].get(action.get("beforeFrameRef"))
    after_frame = evidence["liveByState"].get(binding["afterStateKey"])
    if before_frame is None or after_frame is None:
        raise ValueError(f"live transition lacks before/after frame: {transition_key}")
    action_locator = deepcopy(action.get("locator", {}))
    action_locator["status"] = "pass"
    action_locator["frameRef"] = before_frame["frameId"]
    validate_locator(f"{transition_key}.action", action_locator, before_frame)
    assertion_ref = sha256_json(
        {
            "actionRecordRef": binding["actionRecordRef"],
            "postcondition": action.get("postcondition"),
            "assertion": action.get("assertion"),
        }
    )
    return {
        "action": action,
        "actionRecordRef": binding["actionRecordRef"],
        "beforeFrameRef": before_frame["frameId"],
        "afterFrameRef": after_frame["frameId"],
        "semanticAssertionRef": assertion_ref,
        "explorationRef": before_frame["explorationRef"],
    }


def frozen_locator_observation(
    candidate: dict[str, Any],
    recheck: dict[str, Any],
    evidence: dict[str, Any],
) -> dict[str, Any]:
    frame_ref = recheck["frameRef"]
    frame = evidence["validFrames"].get(frame_ref)
    if frame is None:
        raise ValueError(f"frozen locator recheck uses an unqualified frame: {frame_ref}")
    screenshot_ref = frame["screenshot"]["resourceRef"]
    if screenshot_ref != recheck["screenshotRef"]:
        raise ValueError(f"frozen locator recheck screenshot mismatch: {recheck['key']}")
    rect = normalize_rect(recheck.get("rect"))
    if rect is None:
        raise ValueError(f"frozen locator recheck has an invalid rect: {recheck['key']}")
    center = [rect["left"] + rect["width"] / 2, rect["top"] + rect["height"] / 2]
    claimed_center = [float(value) for value in recheck.get("center", center)]
    if not (
        rect["left"] <= claimed_center[0] <= rect["left"] + rect["width"]
        and rect["top"] <= claimed_center[1] <= rect["top"] + rect["height"]
    ):
        raise ValueError(f"frozen locator recheck center is outside rect: {recheck['key']}")
    evidence_payload = {
        "producer": recheck["producer"],
        "verifiedAt": recheck["verifiedAt"],
        "frameRef": frame_ref,
        "screenshotRef": screenshot_ref,
        "prompt": recheck["prompt"],
        "rect": rect,
        "center": claimed_center,
    }
    base = frame_observation(frame, evidence)
    base.update(
        {
            "locator": {
                "rect": rect,
                "center": claimed_center,
                "dpr": 1,
                "status": "pass",
                "evidenceRef": sha256_json(evidence_payload),
            },
            "state": candidate.get("observationState", "visible"),
            "stateProperties": deepcopy(candidate.get("observationStateProperties", {})),
            "dynamicValue": candidate.get("observationDynamicValue"),
            "actionTraceRef": None,
        }
    )
    return base


def copy_frame_asset(observation: dict[str, Any], evidence: dict[str, Any], obsidian_root: Path) -> Path:
    live_frame = evidence.get("liveFrames", {}).get(observation["frameRef"])
    if live_frame is not None:
        source = live_frame["sourcePath"]
        target = obsidian_root / "assets" / "full-pages" / f"{live_frame['frameId']}.png"
        target.parent.mkdir(parents=True, exist_ok=True)
        if not target.exists():
            shutil.copy2(source, target)
        return target
    frame = evidence["frames"][observation["frameRef"]]
    raw_root = evidence["sessionRoots"][frame["sessionRef"]]
    source = resource_path(raw_root, frame["screenshot"]["resourceRef"], "png")
    target = obsidian_root / "assets" / "full-pages" / f"{frame['id']}.png"
    target.parent.mkdir(parents=True, exist_ok=True)
    if not target.exists():
        shutil.copy2(source, target)
    return target


def draw_redbox(source: Path, target: Path, rect: dict[str, float]) -> None:
    target.parent.mkdir(parents=True, exist_ok=True)
    with Image.open(source).convert("RGB") as image:
        draw = ImageDraw.Draw(image)
        left = round(rect["left"])
        top = round(rect["top"])
        right = round(rect["left"] + rect["width"])
        bottom = round(rect["top"] + rect["height"])
        draw.rectangle((left, top, right, bottom), outline=(255, 0, 0), width=8)
        image.save(target)


def card_path(root: Path, category: str, feature_path: list[str], label: str) -> Path:
    return root / category / Path(*feature_path) / f"{label}.md"


def wiki_path(path: Path, obsidian_root: Path) -> str:
    return path.relative_to(obsidian_root).with_suffix("").as_posix()


def remove_empty_directories(root: Path) -> None:
    if not root.is_dir():
        return
    directories = sorted(
        (path for path in root.rglob("*") if path.is_dir()),
        key=lambda path: len(path.parts),
        reverse=True,
    )
    for directory in directories:
        if not any(directory.iterdir()):
            directory.rmdir()


def format_list(values: list[Any]) -> str:
    return ", ".join(str(value) for value in values) if values else "仅观察"


def rebuild_element_relationships(elements: dict[str, dict[str, Any]]) -> None:
    """Derive every direct parent/child relation from the canonical owner edges."""
    children_by_parent: dict[str, list[dict[str, Any]]] = defaultdict(list)
    for element in elements.values():
        owner = element.get("owner", {})
        if owner.get("kind") in {"component", "shared_component"}:
            children_by_parent[owner["ref"]].append(element)

    for element in elements.values():
        owner_ref = element.get("owner", {}).get("ref")
        relationships = [
            relation
            for relation in element.get("relationshipRefs", [])
            if not relation.startswith(("owner:", "parent:", "child:"))
        ]
        if owner_ref:
            relationships.insert(0, f"owner:{owner_ref}")
        if element.get("parentElementRef"):
            relationships.append(f"parent:{element['parentElementRef']}")

        actual_children = {
            child["id"]: child for child in children_by_parent.get(element["id"], [])
        }
        existing_order = [
            child_ref
            for child_ref in element.get("childElementRefs", [])
            if child_ref in actual_children
        ]
        remaining = sorted(
            (child for child_id, child in actual_children.items() if child_id not in existing_order),
            key=lambda child: child["key"],
        )
        children = [actual_children[child_ref] for child_ref in existing_order] + remaining
        if children:
            element["childElementRefs"] = [child["id"] for child in children]
            relationships.extend(f"child:{child['id']}" for child in children)
        else:
            element.pop("childElementRefs", None)
        element["relationshipRefs"] = list(dict.fromkeys(relationships))


def apply_confirmed_navigation_model(
    pages: dict[str, dict[str, Any]],
    elements: dict[str, dict[str, Any]],
    policy: dict[str, Any],
    existing_migrations: list[dict[str, Any]],
) -> list[dict[str, Any]]:
    for key, feature_path in policy.get("pageFeatureOverrides", {}).items():
        if key in pages:
            pages[key]["featurePath"] = feature_path

    existing_by_key = {item.get("oldKey"): item for item in existing_migrations}
    migration_records: list[dict[str, Any]] = []
    navigation = policy["sharedNavigation"]
    state_source = elements.get(navigation["moreStateSourceElementKey"])
    for old_key, migration in policy.get("canonicalMigrations", {}).items():
        target_element_key = migration.get("targetElementKey")
        target_page_key = migration.get("targetPageKey")
        if bool(target_element_key) == bool(target_page_key):
            raise ValueError(f"migration must name exactly one Page or Element target: {old_key}")
        target = elements[target_element_key] if target_element_key else pages[target_page_key]
        target_key = target_element_key or target_page_key
        old_page = pages.pop(old_key, None)
        old_element = None
        if old_key in elements and old_key != target_key:
            old_element = elements.pop(old_key)
        old_entity = old_page or old_element
        if old_entity:
            migration_records.append(
                {
                    "oldId": old_entity["id"],
                    "oldKey": old_entity["key"],
                    "oldEntityType": old_entity["entityType"],
                    "targetRef": target["id"],
                    "targetKey": target["key"],
                    "targetEntityType": target["entityType"],
                    "targetStateKey": migration.get("targetStateKey"),
                    "reason": migration["reason"],
                    "reviewedBy": migration.get("reviewedBy", "user_context_2026-07-28"),
                }
            )
        elif old_key in existing_by_key:
            existing = existing_by_key[old_key]
            migration_records.append(
                {
                    "oldId": existing["oldId"],
                    "oldKey": existing["oldKey"],
                    "oldEntityType": existing["oldEntityType"],
                    "targetRef": target["id"],
                    "targetKey": target["key"],
                    "targetEntityType": target["entityType"],
                    "targetStateKey": migration.get("targetStateKey"),
                    "reason": migration["reason"],
                    "reviewedBy": migration.get("reviewedBy", existing.get("reviewedBy")),
                }
            )

    root = elements[navigation["rootElementKey"]]
    root["featurePath"] = navigation["rootFeaturePath"]
    root["owner"] = {"kind": "application", "ref": APP_ID}
    root["parentElementRef"] = None
    root["availableOnPageRefs"] = [
        pages[key]["id"] for key in navigation["availablePageKeys"] if key in pages
    ]

    for key in navigation["tabElementKeys"]:
        tab = elements[key]
        tab["featurePath"] = navigation["rootFeaturePath"]
        tab["owner"] = {"kind": "shared_component", "ref": root["id"]}
        tab["parentElementRef"] = root["id"]
        tab.pop("availableOnPageRefs", None)

    more_trigger = elements[navigation["moreTriggerElementKey"]]
    more_trigger["controlType"] = "shared-component-trigger"
    more_trigger["role"] = "role.menu"
    more_trigger["capabilities"] = list(dict.fromkeys(more_trigger.get("capabilities", []) + ["open_more"]))
    more_trigger["summary"] = "打开底部导航中的“更多”共享应用入口抽屉；不创建同名 Page。"
    if state_source:
        known_frames = {item["frameRef"] for item in more_trigger.get("observations", [])}
        for observation in state_source.get("observations", []):
            if observation["frameRef"] in known_frames:
                continue
            migrated_observation = deepcopy(observation)
            migrated_observation["redboxRef"] = f"assets/element-redboxes/{state_source['id']}.png"
            migrated_observation["stateProperties"] = dict(migrated_observation.get("stateProperties", {}))
            migrated_observation["stateProperties"]["sharedComponentState"] = "open"
            more_trigger.setdefault("observations", []).append(migrated_observation)
    open_frames = [
        item["frameRef"]
        for item in more_trigger.get("observations", [])
        if item.get("stateProperties", {}).get("sharedComponentState") == "open"
    ]
    more_trigger["states"] = [
        {"key": "open", "summary": "更多应用抽屉已打开", "frameRefs": open_frames}
    ]

    for key, element in elements.items():
        if not key.startswith(navigation["moreEntryKeyPrefix"]):
            continue
        element["featurePath"] = navigation["moreFeaturePath"]
        element["owner"] = {"kind": "shared_component", "ref": more_trigger["id"]}
        element["parentElementRef"] = more_trigger["id"]
        if element.get("label", "").startswith(navigation["moreEntryLabelPrefixFrom"]):
            element["label"] = navigation["moreEntryLabelPrefixTo"] + element["label"][
                len(navigation["moreEntryLabelPrefixFrom"]):
            ]
        element.pop("availableOnPageRefs", None)

    rebuild_element_relationships(elements)
    for element in elements.values():
        element.setdefault("status", element.get("coverage", "observed"))
    return migration_records


def render_page_card(
    page: dict[str, Any],
    target: Path,
    obsidian_root: Path,
    page_cards: dict[str, Path],
    element_cards: dict[str, Path],
    page_by_id: dict[str, dict[str, Any]],
    element_by_id: dict[str, dict[str, Any]],
    transition_by_id: dict[str, dict[str, Any]],
    authority_contract_by_id: dict[str, dict[str, Any]],
) -> None:
    lines = [
        "---",
        "type: page",
        f"id: {page['id']}",
        f"key: {page['key']}",
        "application: [[中通宝盒-知识图谱首页]]",
        "feature_path: [" + ", ".join(f'\"{item}\"' for item in page["featurePath"]) + "]",
        f"status: {page.get('status', 'observed')}",
        "---",
        "",
        f"# {page['label']}",
        "",
        page.get("summary", ""),
        "",
        "## 页面实例",
        "",
    ]
    state_by_frame = {
        frame: state["key"] for state in page.get("states", []) for frame in state.get("frameRefs", [])
    }
    for observation in page.get("observations", []):
        frame = observation["frameRef"]
        viewport = observation.get("viewport", {})
        lines.extend(
            [
                f"### `{frame}`",
                "",
                f"![[assets/full-pages/{frame}.png|640]]",
                "",
                "| 时间 | 构建 | 设备/视口 | 状态 | 实例属性 |",
                "| --- | --- | --- | --- | --- |",
                f"| {observation.get('observedAt')} | `{observation.get('buildRef')}` | "
                f"{viewport.get('width')}x{viewport.get('height')} | `{state_by_frame.get(frame, 'observed')}` | "
                f"`{observation.get('stateProperties', {})}` |",
                "",
            ]
        )
    lines.extend(["## 元素", "", "| 元素 | 类型 | 能力 |", "| --- | --- | --- |"])
    for element_id in page.get("elementRefs", []):
        element = element_by_id.get(element_id)
        if not element:
            continue
        link = wiki_path(element_cards[element_id], obsidian_root)
        lines.append(f"| [[{link}|{element['label']}]] | {element.get('controlType')} | {format_list(element.get('capabilities', []))} |")
    lines.extend(["", "## 导航关系", "", "### 进入", ""])
    inbound = [transition_by_id[item] for item in page.get("inboundTransitionRefs", []) if item in transition_by_id]
    if inbound:
        for transition in inbound:
            source = page_by_id[transition["sourceRef"]]
            trigger = element_by_id[transition["triggerElementRef"]]
            lines.append(
                f"- [[{wiki_path(page_cards[source['id']], obsidian_root)}|{source['label']}]] -> "
                f"[[{wiki_path(element_cards[trigger['id']], obsidian_root)}|{trigger['label']}]] -> 本页"
            )
    inbound_contracts = [
        authority_contract_by_id[item]
        for item in page.get("inboundAuthorityContractRefs", [])
        if item in authority_contract_by_id
    ]
    for contract in inbound_contracts:
        source = page_by_id[contract["sourceSelector"]["ref"]]
        trigger = element_by_id[contract["triggerElementRef"]]
        lines.append(
            f"- `authority_contract` / `{contract['runtimeEvidenceStatus']}`: "
            f"[[{wiki_path(page_cards[source['id']], obsidian_root)}|{source['label']}]] -> "
            f"[[{wiki_path(element_cards[trigger['id']], obsidian_root)}|{trigger['label']}]] -> 本页"
        )
    if not inbound and not inbound_contracts:
        lines.append("- 无已闭合的进入 Transition。")
    lines.extend(["", "### 离开", ""])
    outbound = [transition_by_id[item] for item in page.get("outboundTransitionRefs", []) if item in transition_by_id]
    if outbound:
        for transition in outbound:
            target_page = page_by_id[transition["targetRef"]]
            trigger = element_by_id[transition["triggerElementRef"]]
            lines.append(
                f"- [[{wiki_path(element_cards[trigger['id']], obsidian_root)}|{trigger['label']}]] -> "
                f"[[{wiki_path(page_cards[target_page['id']], obsidian_root)}|{target_page['label']}]]"
            )
    outbound_contracts = [
        authority_contract_by_id[item]
        for item in page.get("outboundAuthorityContractRefs", [])
        if item in authority_contract_by_id
    ]
    for contract in outbound_contracts:
        target_page = page_by_id[contract["expectedTarget"]["ref"]]
        trigger = element_by_id[contract["triggerElementRef"]]
        lines.append(
            f"- `authority_contract` / `{contract['runtimeEvidenceStatus']}`: "
            f"[[{wiki_path(element_cards[trigger['id']], obsidian_root)}|{trigger['label']}]] -> "
            f"[[{wiki_path(page_cards[target_page['id']], obsidian_root)}|{target_page['label']}]]"
        )
    if not outbound and not outbound_contracts:
        lines.append("- 无已闭合的离开 Transition。")
    evidence_statuses = {item.get("evidenceStatus", "") for item in page.get("observations", [])}
    has_live_dual_model = any(status == "dual_model_verified_live_frame" for status in evidence_statuses)
    has_legacy_pending_workerA = any("pending_independent_workerA" in status for status in evidence_statuses)
    if has_live_dual_model and has_legacy_pending_workerA:
        evidence_note = "当前页面同时包含实时双模型闭合帧和历史 仅 Worker B 帧；后者仍待独立 Worker A 对账。"
    elif has_live_dual_model:
        evidence_note = "当前页面实例已具备独立 Worker A、Worker B 答卷和实时冻结帧证据。"
    else:
        evidence_note = "该页面当前仅有历史 Worker B 视觉证据，尚待独立 Worker A 对账。"
    lines.extend(
        [
            "",
            "## 边界与待确认",
            "",
            f"- {page.get('boundaryNote', evidence_note)}",
            "",
            "## 运行证据",
            "",
            f"- {evidence_note}",
        ]
    )
    target.parent.mkdir(parents=True, exist_ok=True)
    target.write_text("\n".join(lines) + "\n", encoding="utf-8")


def render_element_card(
    element: dict[str, Any],
    target: Path,
    obsidian_root: Path,
    page_cards: dict[str, Path],
    element_cards: dict[str, Path],
    page_by_id: dict[str, dict[str, Any]],
    element_by_id: dict[str, dict[str, Any]],
    transition_by_id: dict[str, dict[str, Any]],
    authority_contract_by_id: dict[str, dict[str, Any]],
) -> None:
    owner = element["owner"]
    if owner.get("kind") == "application" and owner.get("ref") == APP_ID:
        owner_link = "中通宝盒-知识图谱首页"
        owner_label = "中通宝盒"
    elif owner.get("kind") == "page" and owner.get("ref") in page_by_id:
        owner_page = page_by_id[owner["ref"]]
        owner_link = wiki_path(page_cards[owner_page["id"]], obsidian_root)
        owner_label = owner_page["label"]
    elif owner.get("kind") in {"component", "shared_component"} and owner.get("ref") in element_by_id:
        owner_element = element_by_id[owner["ref"]]
        owner_link = wiki_path(element_cards[owner_element["id"]], obsidian_root)
        owner_label = owner_element["label"]
    else:
        raise KeyError(f"unresolved Element owner for {element['key']}: {owner}")
    parent_line = "无"
    parent_ref = element.get("parentElementRef")
    if parent_ref in element_cards:
        parent_line = f"[[{wiki_path(element_cards[parent_ref], obsidian_root)}]]"
    lines = [
        "---",
        "type: element",
        f"id: {element['id']}",
        f"key: {element['key']}",
        "application: [[中通宝盒-知识图谱首页]]",
        f"owner: [[{owner_link}]]",
        "feature_path: [" + ", ".join(f'\"{item}\"' for item in element["featurePath"]) + "]",
        f"status: {element.get('status')}",
        *(
            ["aliases: [" + ", ".join(f'\"{item}\"' for item in element["aliases"]) + "]"]
            if element.get("aliases")
            else []
        ),
        "---",
        "",
        f"# {element['label']}",
        "",
        element.get("summary", ""),
        "",
        "## 归属与关系",
        "",
        f"- Owner: [[{owner_link}|{owner_label}]]",
        f"- 父容器: {parent_line}",
        "- 可用页面: " + (
            ", ".join(
                f"[[{wiki_path(page_cards[page_ref], obsidian_root)}|{page_by_id[page_ref]['label']}]]"
                for page_ref in element.get("availableOnPageRefs", [])
                if page_ref in page_by_id
            )
            or "由 Owner 关系继承"
        ),
        f"- 关系: `{format_list(element.get('relationshipRefs', []))}`",
    ]
    child_refs = element.get("childElementRefs", [])
    if child_refs:
        lines.extend(["", "## 子元素", ""])
        composition = element.get("composition", {})
        role_by_ref = {ref: role for role, ref in composition.get("roles", {}).items()}
        role_labels = {
            "label": "名称文案",
            "currentValue": "当前值",
            "secondaryText": "次要说明",
            "helpTrigger": "帮助入口",
            "helpPopover": "帮助浮层",
            "settingControl": "设置开关",
            "affordance": "视觉提示",
            "explanatoryContent": "说明内容",
            "actionTrigger": "动作入口",
            "previewTrigger": "试听入口",
            "removeTrigger": "移除入口",
        }
        for child_ref in child_refs:
            child = element_by_id[child_ref]
            child_role = (
                role_labels.get(role_by_ref.get(child_ref))
                or (
                    "说明文案"
                    if child_ref == composition.get("labelElementRef")
                    else "点击入口"
                    if child_ref == composition.get("triggerElementRef")
                    else "子元素"
                )
            )
            lines.append(
                f"- {child_role}：[[{wiki_path(element_cards[child_ref], obsidian_root)}|{child['label']}]]"
            )
    lines.extend(
        [
            "",
            "## 能力与状态",
            "",
            "| 类型 | 语义角色 | 能力 | 风险 | 覆盖 |",
            "| --- | --- | --- | --- | --- |",
            f"| {element.get('controlType')} | `{element.get('role')}` | {format_list(element.get('capabilities', []))} | "
            f"{element.get('risk')} | {element.get('coverage')} |",
        ]
    )
    composition = element.get("composition", {})
    if composition:
        lines.extend(["", "## 复合结构", ""])
        if composition.get("profile"):
            lines.append(f"- Profile: `{composition['profile']}`")
        for role, ref in composition.get("roles", {}).items():
            target_element = element_by_id.get(ref)
            if ref == element.get("id"):
                lines.append(f"- `{role}`：当前容器自身")
            elif target_element:
                lines.append(
                    f"- `{role}`：[[{wiki_path(element_cards[ref], obsidian_root)}|{target_element['label']}]]"
                )
    presentation = element.get("presentation", {})
    boundary = element.get("interactionBoundary", {})
    if presentation or boundary:
        lines.extend(["", "## 交互边界", ""])
        if boundary.get("actionable") is False:
            lines.extend(
                [
                    "- 可点击：`false`。",
                    f"- 用途：`{boundary.get('function', 'description')}`。",
                ]
            )
        elif presentation or boundary.get("actionablePart") or boundary.get("labelTextActionable") is not None:
            relation = next(iter(presentation.get("spatialRelations", [])), {})
            lines.extend(
                [
                    f"- 可见文字：`{presentation.get('visibleLabel', '未指定')}`。",
                    f"- 实际触发控件：`{presentation.get('triggerAffordance', boundary.get('actionablePart', '未指定'))}`。",
                    f"- 空间关系：`{relation.get('subject', 'trigger_affordance')} {relation.get('predicate', 'unknown')} {relation.get('object', 'visible_label')}`。",
                    f"- 文字是否可触发：`{boundary.get('labelTextActionable', 'unspecified')}`。",
                    f"- 其他行区域：`{boundary.get('otherRowRegions', 'unspecified')}`。",
                ]
            )
        else:
            lines.extend(
                [
                    f"- 可点击：`{str(boundary.get('actionable')).lower()}`。",
                    f"- 用途：`{boundary.get('function', 'unspecified')}`。",
                ]
            )
        if boundary.get("commonMisinterpretation"):
            lines.append(f"- 常见误解：{boundary['commonMisinterpretation']}")
    lines.extend(["", "## 交互结果", ""])
    related = [item for item in transition_by_id.values() if item.get("triggerElementRef") == element["id"]]
    if related:
        for transition in related:
            target_page = page_by_id[transition["targetRef"]]
            lines.append(
                f"- 动作 `{transition['action']}` -> [[{wiki_path(page_cards[target_page['id']], obsidian_root)}|{target_page['label']}]]；"
                f"后置条件 `{transition['evidence']['postcondition']}`。"
            )
    else:
        lines.append("- 本次仅观察，未执行动作。")
    related_contracts = [
        item for item in authority_contract_by_id.values() if item.get("triggerElementRef") == element["id"]
    ]
    for contract in related_contracts:
        target_page = page_by_id[contract["expectedTarget"]["ref"]]
        fact = contract.get("certifiedFact", {})
        lines.append(
            f"- 权威契约 `{contract['id']}`：`{contract['authorityStatus']}` / "
            f"运行证据 `{contract['runtimeEvidenceStatus']}`；仅 `{fact.get('actionableControl')}` 触发 -> "
            f"[[{wiki_path(page_cards[target_page['id']], obsidian_root)}|{target_page['label']}]]。"
        )
    if element.get("states"):
        lines.extend(["", "## 共享组件状态", ""])
        for state in element["states"]:
            lines.append(
                f"- `{state['key']}`：{state.get('summary', '')}；Frame `{format_list(state.get('frameRefs', []))}`"
            )
    lines.extend(["", "## 元素实例", ""])
    for observation in element.get("observations", []):
        redbox = observation.get("redboxRef", f"assets/element-redboxes/{element['id']}.png")
        rect = observation["locator"]["rect"]
        lines.extend(
            [
                f"### `{observation['frameRef']}`",
                "",
                f"![[{redbox}|640]]",
                "",
                "| 时间 | 构建 | Frame | rect | center/dpr | 控件状态 | 动态值 |",
                "| --- | --- | --- | --- | --- | --- | --- |",
                f"| {observation.get('observedAt')} | `{observation.get('buildRef')}` | `{observation['frameRef']}` | "
                f"`{rect['left']},{rect['top']},{rect['width']},{rect['height']}` | "
                f"`{observation['locator']['center']} / {observation['locator']['dpr']}` | "
                f"`{observation.get('stateProperties')}` | `{observation.get('dynamicValue')}` |",
                "",
            ]
        )
    evidence_statuses = {item.get("evidenceStatus", "") for item in element.get("observations", [])}
    has_live_dual_model = any(status == "dual_model_verified_live_frame" for status in evidence_statuses)
    if has_live_dual_model:
        workerB_note = "实时帧已完成 Worker B 答卷、定位及适用动作断言。"
        workerA_note = "当前实例已完成独立 Worker A 清点。"
    else:
        workerB_note = "历史冻结帧的 Worker B 识别、定位或断言证据已保留，仍待当前规范复核。"
        workerA_note = "历史采集中缺失，当前状态为待补采。"
    lines.extend(
        [
            "## 来源",
            "",
            f"- Worker B: {workerB_note}",
            f"- Worker A: {workerA_note}",
        ]
    )
    if related_contracts:
        lines.append("- 用户事实：用户确认“我的特别关注”是说明文字，实际入口为其右侧向右箭头。")
    target.parent.mkdir(parents=True, exist_ok=True)
    target.write_text("\n".join(lines) + "\n", encoding="utf-8")


def main() -> None:
    options = parse_args()
    source_root = options.source_root.resolve()
    output_root = options.output_root.resolve()
    spec = read_yaml(SPEC_PATH)
    policy = read_yaml(POLICY_PATH)
    evidence = collect_evidence(source_root)
    evidence.update(collect_live_evidence(source_root, spec))
    if output_root.exists():
        shutil.rmtree(output_root)
    app_root = output_root / "apps" / APP_KEY
    obsidian_root = output_root / "obsidian" / APP_KEY
    shutil.copytree(source_root / "apps" / APP_KEY, app_root)
    shutil.copytree(source_root / "obsidian" / APP_KEY, obsidian_root)

    existing_pages = {
        record["key"]: record
        for path in app_root.joinpath("pages").rglob("*.yaml")
        for record in yaml.safe_load_all(path.read_text(encoding="utf-8"))
        if isinstance(record, dict) and record.get("entityType") == "Page"
    }
    existing_elements = {
        record["key"]: record
        for path in app_root.joinpath("elements").rglob("*.yaml")
        for record in yaml.safe_load_all(path.read_text(encoding="utf-8"))
        if isinstance(record, dict) and record.get("entityType") == "Element"
    }
    existing_authority_contracts = {
        record["key"]: record
        for path in app_root.joinpath("authority-contracts").rglob("*.yaml")
        for record in yaml.safe_load_all(path.read_text(encoding="utf-8"))
        if isinstance(record, dict) and record.get("entityType") == "AuthorityContract"
    }
    page_ids = {key: value["id"] for key, value in existing_pages.items()}
    element_ids = {key: value["id"] for key, value in existing_elements.items()}
    for page in spec["pages"]:
        page_ids.setdefault(page["key"], deterministic_id("Page", page["key"]))
    for element in spec["elements"]:
        element_ids.setdefault(element["key"], deterministic_id("Element", element["key"]))
    transition_ids = {
        transition["key"]: deterministic_id("Transition", transition["key"])
        for transition in spec["transitions"]
    }
    authority_contract_ids = {
        contract["key"]: deterministic_id("AuthorityContract", contract["key"])
        for contract in spec.get("authorityContracts", [])
    }

    pages: dict[str, dict[str, Any]] = deepcopy(existing_pages)
    for key, feature_path in policy.get("pageFeatureOverrides", {}).items():
        if key in pages:
            pages[key]["featurePath"] = feature_path
    selected_frame_ids: set[str] = set()
    pending_pages: list[str] = []
    for candidate in spec["pages"]:
        selected_states: list[dict[str, Any]] = []
        selected_observations: list[dict[str, Any]] = []
        has_live_evidence = False
        for state in candidate.get("states", []):
            live_frame = evidence["liveByState"].get(state.get("liveStateKey"))
            legacy_frame = next(
                (
                    evidence["byHint"][hint][0]
                    for hint in state.get("stateHints", [])
                    if evidence["byHint"].get(hint)
                ),
                None,
            )
            if live_frame:
                frame_ref = live_frame["frameId"]
                observation = live_frame_observation(
                    live_frame,
                    live_frame.get("explorationRef", evidence["liveExplorationRef"]),
                )
                has_live_evidence = True
            elif legacy_frame:
                frame_ref = legacy_frame["id"]
                observation = frame_observation(legacy_frame, evidence)
            else:
                continue
            if frame_ref:
                selected_states.append(
                    {"key": state["key"], "summary": state.get("label", ""), "frameRefs": [frame_ref]}
                )
                selected_observations.append(observation)
                selected_frame_ids.add(frame_ref)
        if not selected_observations:
            pending_pages.append(candidate["key"])
            continue
        key = candidate["key"]
        if key in pages:
            page = pages[key]
            page["featurePath"] = policy["featurePaths"][key]
            known_frames = {item["frameRef"] for item in page.get("observations", [])}
            replacement_states = {item["key"]: item for item in selected_states}
            existing_state_keys = {item["key"] for item in page.get("states", [])}
            page["states"] = [
                replacement_states.get(item["key"], item) for item in page.get("states", [])
            ]
            page["states"].extend(
                item for item in selected_states if item["key"] not in existing_state_keys
            )
            page.setdefault("observations", []).extend(
                observation
                for observation in selected_observations
                if observation["frameRef"] not in known_frames
            )
            if has_live_evidence:
                page["status"] = "observed_dual_model_verified_with_legacy_evidence"
                page["provenance"] = {
                    "sourceType": "mixed_verified_evidence",
                    "materializationSpec": SPEC_PATH.name,
                    "liveExplorationRefs": evidence["pageLiveExplorationRefs"],
                    "limitations": ["some historical states remain 仅 Worker B pending independent Worker A"],
                }
            elif page.get("provenance", {}).get("sourceType") == "legacy_uikg_v2_import":
                page["status"] = "partially_reconciled_workerB_only_pending_workerA"
            else:
                page["status"] = "observed_workerB_only_pending_workerA"
            page["summary"] = candidate.get("summary", page.get("summary"))
        else:
            page = {
                "schemaVersion": SCHEMA_VERSION,
                "entityType": "Page",
                "id": page_ids[key],
                "key": key,
                "label": policy["cardLabels"][key],
                "applicationRef": APP_ID,
                "featurePath": policy["featurePaths"][key],
                "surfaceType": candidate.get("kind", "page"),
                "status": (
                    "observed_dual_model_verified"
                    if has_live_evidence
                    else "observed_workerB_only_pending_workerA"
                ),
                "summary": candidate.get("summary", ""),
                "states": selected_states,
                "elementRefs": [],
                "inboundTransitionRefs": [],
                "outboundTransitionRefs": [],
                "observations": selected_observations,
                "provenance": (
                    {
                        "sourceType": "midscene_dual_model_live_evidence",
                        "materializationSpec": SPEC_PATH.name,
                        "liveExplorationRef": evidence["liveExplorationRef"],
                    }
                    if has_live_evidence
                    else {
                        "sourceType": "verified_legacy_midscene_evidence",
                        "materializationSpec": SPEC_PATH.name,
                        "limitations": ["independent worker_a evidence is absent from the historical capture"],
                    }
                ),
            }
            if key in policy.get("boundaryPolicies", {}):
                page["boundaryNote"] = policy["boundaryPolicies"][key]
            pages[key] = page

    elements: dict[str, dict[str, Any]] = deepcopy(existing_elements)
    pending_elements: list[str] = []
    for candidate in spec["elements"]:
        key = candidate["key"]
        owner_page_key = candidate.get("pageKey")
        owner_element_key = candidate.get("ownerElementKey")
        if owner_page_key and owner_page_key in pages:
            owner_page = pages[owner_page_key]
            owner = {"kind": "page", "ref": owner_page["id"]}
            parent_ref = None
            feature_path = owner_page["featurePath"]
            owner_label = owner_page["label"]
        elif owner_element_key and owner_element_key in elements:
            owner_element = elements[owner_element_key]
            owner = {"kind": "component", "ref": owner_element["id"]}
            parent_ref = owner_element["id"]
            feature_path = owner_element["featurePath"]
            owner_label = owner_element["label"]
        else:
            pending_elements.append(key)
            continue
        live_binding_key = candidate.get("liveLocatorBinding")
        live_binding = evidence["liveBindings"].get(live_binding_key)
        if live_binding_key and live_binding is None:
            raise ValueError(f"Element references a missing live locator binding: {key}")
        if live_binding:
            observation = live_element_observation(
                candidate,
                live_binding,
                live_binding.get("explorationRef", evidence["liveExplorationRef"]),
            )
        else:
            candidates = control_candidates(candidate, evidence)
            if not candidates:
                pending_elements.append(key)
                continue
            observation = element_observation(candidates[0], evidence)
        if "observationState" in candidate:
            observation["state"] = candidate["observationState"]
        if "observationStateProperties" in candidate:
            observation["stateProperties"] = candidate["observationStateProperties"]
        if "observationDynamicValue" in candidate:
            observation["dynamicValue"] = candidate["observationDynamicValue"]
        selected_frame_ids.add(observation["frameRef"])
        raw_label = candidate.get("label", key)
        label = f"{owner_label}-{raw_label}"
        element = {
            "schemaVersion": SCHEMA_VERSION,
            "entityType": "Element",
            "id": element_ids[key],
            "key": key,
            "label": label,
            "applicationRef": APP_ID,
            "featurePath": feature_path,
            "owner": owner,
            "parentElementRef": parent_ref,
            "controlType": candidate.get("controlType", candidate.get("kind", "control")),
            "role": candidate.get("semanticRole", "unknown"),
            "capabilities": candidate.get("capabilities", []),
            "summary": candidate.get("description", ""),
            "relationshipRefs": [f"owner:{owner['ref']}"]
            + ([f"parent:{parent_ref}"] if parent_ref else []),
            "observations": [observation],
            "coverage": (
                (
                    "executed_verified_dual_model_live"
                    if candidate.get("activation") == "executed_verified"
                    else "observed_not_activated_dual_model_live"
                )
                if live_binding
                else (
                    "executed_verified_workerB_only_pending_workerA"
                    if candidate.get("activation") == "executed_verified"
                    else "observed_not_activated_workerB_only_pending_workerA"
                )
            ),
            "status": (
                "dual_model_verified_live"
                if live_binding
                else "workerB_verified_pending_independent_workerA"
            ),
            "risk": candidate.get("risk", "unknown"),
            "provenance": (
                {
                    "sourceType": "midscene_dual_model_live_evidence",
                    "materializationSpec": SPEC_PATH.name,
                    "liveExplorationRef": live_binding.get(
                        "explorationRef", evidence["liveExplorationRef"]
                    ),
                    "workerAModel": evidence["liveModelDiagnosticsByExploration"]
                    .get(live_binding.get("explorationRef"), {})
                    .get("worker_a", {})
                    .get("name"),
                    "operatorModel": evidence["liveModelDiagnosticsByExploration"]
                    .get(live_binding.get("explorationRef"), {})
                    .get("default", {})
                    .get("name"),
                }
                if live_binding
                else {
                    "sourceType": "verified_legacy_midscene_evidence",
                    "materializationSpec": SPEC_PATH.name,
                    "limitations": ["independent worker_a evidence is absent from the historical capture"],
                }
            ),
        }
        if candidate.get("userContextCertifiedFact"):
            element["provenance"]["userContextCertifiedFact"] = candidate["userContextCertifiedFact"]
        for optional_field in ("aliases", "presentation", "interactionBoundary"):
            if optional_field in candidate:
                element[optional_field] = candidate[optional_field]
        if (
            "interactionBoundary" not in element
            and candidate.get("activation") == "executed_verified"
            and element["capabilities"]
        ):
            element["interactionBoundary"] = {
                "actionable": True,
                "function": element["capabilities"][0],
            }
        elements[key] = element

    for candidate in spec["elements"]:
        key = candidate["key"]
        if key not in elements or not candidate.get("childElementKeys"):
            continue
        child_keys = [child_key for child_key in candidate["childElementKeys"] if child_key in elements]
        if len(child_keys) != len(candidate["childElementKeys"]):
            pending_elements.append(f"{key}.composition")
            continue
        element = elements[key]
        child_refs = [elements[child_key]["id"] for child_key in child_keys]
        label_key = candidate.get("labelElementKey")
        trigger_key = candidate.get("triggerElementKey")
        role_keys = candidate.get("compositionRoles", {})
        missing_role_keys = [
            child_key
            for child_key in role_keys.values()
            if child_key != "@self" and child_key not in elements
        ]
        if missing_role_keys:
            pending_elements.append(f"{key}.compositionRoles")
            continue
        resolved_roles = {
            role: element["id"] if child_key == "@self" else elements[child_key]["id"]
            for role, child_key in role_keys.items()
        }
        element["childElementRefs"] = child_refs
        composition = {"roles": resolved_roles}
        if candidate.get("compositionProfile"):
            composition["profile"] = candidate["compositionProfile"]
        elif label_key or trigger_key:
            composition.update(
                {
                    "labelElementRef": elements[label_key]["id"] if label_key in elements else None,
                    "triggerElementRef": elements[trigger_key]["id"] if trigger_key in elements else None,
                }
            )
        element["composition"] = composition
        element["relationshipRefs"].extend(f"child:{child_ref}" for child_ref in child_refs)

    existing_migration_path = app_root / "observations" / "shared-navigation-model-migrations.yaml"
    existing_migration_ledger = read_yaml(existing_migration_path) if existing_migration_path.is_file() else {}
    migrations = apply_confirmed_navigation_model(
        pages,
        elements,
        policy,
        existing_migration_ledger.get("migrations", []),
    )

    transitions: dict[str, dict[str, Any]] = {}
    pending_transitions: list[str] = []
    for candidate in spec["transitions"]:
        key = candidate["key"]
        if key in policy.get("deprecatedTransitions", {}):
            continue
        source_key = candidate.get("fromPageKey")
        target_key = candidate.get("toPageKey")
        trigger_key = candidate.get("triggerElementKey")
        if source_key not in pages or target_key not in pages or trigger_key not in elements:
            pending_transitions.append(key)
            continue
        live_trace = live_transition_trace(source_root, key, evidence)
        matching = [trace for trace in evidence["validTraces"] if trace_matches_transition(candidate, trace)]
        matching.sort(key=lambda item: item.get("endedAt", ""), reverse=True)
        if live_trace:
            action = live_trace["action"]
            action_name = action.get("method", "aiTap")
            verification_status = "success_dual_model_live"
            transition_evidence = {
                "actionTraceRef": action["id"],
                "actionRecordRef": live_trace["actionRecordRef"],
                "beforeFrameRef": live_trace["beforeFrameRef"],
                "afterFrameRef": live_trace["afterFrameRef"],
                "postcondition": "pass",
                "semanticAssertions": [live_trace["semanticAssertionRef"]],
            }
            provenance = {
                "sourceType": "midscene_dual_model_live_action_trace",
                "liveExplorationRef": live_trace["explorationRef"],
            }
        elif matching:
            trace = matching[0]
            action_name = trace.get("invocation", {}).get("operation")
            verification_status = "success_workerB_only_pending_workerA"
            transition_evidence = {
                "actionTraceRef": trace["id"],
                "beforeFrameRef": trace["beforeFrameRef"],
                "afterFrameRef": trace["afterFrameRef"],
                "postcondition": trace["postcondition"]["status"],
                "semanticAssertions": [
                    item.get("resourceRef") for item in trace["postcondition"].get("semanticAssertions", [])
                ],
            }
            provenance = {
                "sourceType": "verified_legacy_midscene_action_trace",
                "limitations": ["independent worker_a evidence is absent from the historical capture"],
            }
        else:
            pending_transitions.append(key)
            continue
        transition = {
            "schemaVersion": SCHEMA_VERSION,
            "entityType": "Transition",
            "id": transition_ids[key],
            "key": key,
            "applicationRef": APP_ID,
            "featurePath": pages[source_key]["featurePath"],
            "sourceRef": pages[source_key]["id"],
            "triggerElementRef": elements[trigger_key]["id"],
            "action": action_name,
            "capability": candidate.get("capability"),
            "targetRef": pages[target_key]["id"],
            "reversible": candidate.get("reversible"),
            "risk": candidate.get("risk"),
            "verificationStatus": verification_status,
            "evidence": transition_evidence,
            "provenance": provenance,
        }
        transitions[key] = transition
        selected_frame_ids.update(
            [transition_evidence["beforeFrameRef"], transition_evidence["afterFrameRef"]]
        )
        elements[trigger_key]["relationshipRefs"].append(f"transition:{transition['id']}")

    authority_contracts: dict[str, dict[str, Any]] = {}
    for candidate in spec.get("authorityContracts", []):
        key = candidate["key"]
        existing_contract = existing_authority_contracts.get(key, {})
        source_key = candidate["sourcePageKey"]
        trigger_key = candidate["triggerElementKey"]
        target_key = candidate["expectedTargetPageKey"]
        verified_transition_key = candidate.get("verifiedTransitionKey")
        verified_transition = transitions.get(verified_transition_key)
        runtime_status = candidate.get("runtimeEvidenceStatus", "pending")
        if runtime_status == "verified" and not verified_transition:
            raise ValueError(f"authority contract {key} claims verified evidence without a closed Transition")
        certified_fact = deepcopy(candidate.get("certifiedFact", {}))
        for source_field, target_field in (
            ("containerElementKey", "containerElementRef"),
            ("labelElementKey", "labelElementRef"),
            ("triggerElementKey", "triggerElementRef"),
        ):
            element_key = certified_fact.pop(source_field, None)
            if element_key:
                certified_fact[target_field] = elements[element_key]["id"]
        contract = {
            "schemaVersion": SCHEMA_VERSION,
            "entityType": "AuthorityContract",
            "id": authority_contract_ids[key],
            "key": key,
            "edgeKind": "authority_contract",
            "applicationRef": APP_ID,
            "featurePath": pages[source_key]["featurePath"],
            "sourceSelector": {"kind": "exact_page", "ref": pages[source_key]["id"]},
            "triggerElementRef": elements[trigger_key]["id"],
            "action": candidate.get("action", "aiTap"),
            "capability": candidate.get("capability"),
            "expectedTarget": {"kind": "page", "ref": pages[target_key]["id"], "stateKey": None},
            "risk": candidate.get("risk", "unknown"),
            "sourceType": "user_context",
            "authorityStatus": candidate.get("authorityStatus", "authority_certified"),
            "planningEligible": candidate.get("planningEligible", True),
            "runtimeEvidenceStatus": runtime_status,
            "verifiedTransitionRef": verified_transition["id"] if verified_transition else None,
            "defectRef": None,
            "certifiedFact": certified_fact,
            "contradictionPolicy": candidate.get("contradictionPolicy", "record_product_defect"),
            "provenance": {
                "sourceType": "user_context",
                "recordedAt": existing_contract.get("provenance", {}).get(
                    "recordedAt", UPDATE_RECORDED_AT
                ),
                "reviewedBy": "user_context_2026-07-30",
            },
        }
        authority_contracts[key] = contract
        elements[trigger_key]["relationshipRefs"].append(f"authority_contract:{contract['id']}")

    page_by_id = {page["id"]: page for page in pages.values()}
    element_by_id = {element["id"]: element for element in elements.values()}
    transition_by_id = {transition["id"]: transition for transition in transitions.values()}
    authority_contract_by_id = {
        contract["id"]: contract for contract in authority_contracts.values()
    }
    for page in pages.values():
        owned = [
            element["id"]
            for element in elements.values()
            if element.get("owner", {}).get("kind") == "page"
            and element.get("owner", {}).get("ref") == page["id"]
        ]
        available = [
            element["id"]
            for element in elements.values()
            if page["id"] in element.get("availableOnPageRefs", [])
        ]
        page["elementRefs"] = sorted(set(owned + available))
        page["inboundTransitionRefs"] = sorted(
            transition["id"] for transition in transitions.values() if transition["targetRef"] == page["id"]
        )
        page["outboundTransitionRefs"] = sorted(
            transition["id"] for transition in transitions.values() if transition["sourceRef"] == page["id"]
        )
        inbound_contract_refs = sorted(
            contract["id"]
            for contract in authority_contracts.values()
            if contract["expectedTarget"]["ref"] == page["id"]
        )
        outbound_contract_refs = sorted(
            contract["id"]
            for contract in authority_contracts.values()
            if contract["sourceSelector"]["ref"] == page["id"]
        )
        if inbound_contract_refs:
            page["inboundAuthorityContractRefs"] = inbound_contract_refs
        else:
            page.pop("inboundAuthorityContractRefs", None)
        if outbound_contract_refs:
            page["outboundAuthorityContractRefs"] = outbound_contract_refs
        else:
            page.pop("outboundAuthorityContractRefs", None)

    for category in ("pages", "elements", "transitions", "authority-contracts"):
        target = app_root / category
        if target.exists():
            shutil.rmtree(target)
        target.mkdir(parents=True, exist_ok=True)

    for key, page in pages.items():
        feature = page["featurePath"]
        path = app_root / "pages" / Path(*feature) / f"{key}.yaml"
        dump_yaml(path, page)
    for key, element in elements.items():
        path = app_root / "elements" / Path(*element["featurePath"]) / f"{key}.yaml"
        dump_yaml(path, element)
    for key, transition in transitions.items():
        path = app_root / "transitions" / Path(*transition["featurePath"]) / f"{key}.yaml"
        dump_yaml(path, transition)
    for key, contract in authority_contracts.items():
        path = app_root / "authority-contracts" / Path(*contract["featurePath"]) / f"{key}.yaml"
        dump_yaml(path, contract)

    for page in pages.values():
        for observation in page.get("observations", []):
            if observation["frameRef"] in evidence["frames"]:
                copy_frame_asset(observation, evidence, obsidian_root)
    for frame_id in selected_frame_ids:
        if frame_id in evidence["liveFrames"]:
            copy_frame_asset(
                live_frame_observation(
                    evidence["liveFrames"][frame_id],
                    evidence["liveFrames"][frame_id].get(
                        "explorationRef", evidence["liveExplorationRef"]
                    ),
                ),
                evidence,
                obsidian_root,
            )
        elif frame_id in evidence["frames"]:
            copy_frame_asset(frame_observation(evidence["frames"][frame_id], evidence), evidence, obsidian_root)
    for element in elements.values():
        for observation in element.get("observations", []):
            if (
                observation["frameRef"] not in evidence["frames"]
                and observation["frameRef"] not in evidence["liveFrames"]
            ):
                continue
            source = copy_frame_asset(observation, evidence, obsidian_root)
            redbox_name = f"{element['id']}-{observation['frameRef']}.png"
            redbox_rel = f"assets/element-redboxes/{redbox_name}"
            draw_redbox(source, obsidian_root / redbox_rel, observation["locator"]["rect"])
            observation["redboxRef"] = redbox_rel
            dump_yaml(app_root / "elements" / Path(*element["featurePath"]) / f"{element['key']}.yaml", element)

    page_cards = {
        page["id"]: card_path(obsidian_root, "页面", page["featurePath"], page["label"])
        for page in pages.values()
    }
    element_cards = {
        element["id"]: card_path(obsidian_root, "元素", element["featurePath"], element["label"])
        for element in elements.values()
    }
    existing_page_cards = list(obsidian_root.joinpath("页面").rglob("*.md"))
    existing_element_cards = list(obsidian_root.joinpath("元素").rglob("*.md"))
    for path in existing_page_cards + existing_element_cards:
        path.unlink()
    for page in pages.values():
        render_page_card(
            page,
            page_cards[page["id"]],
            obsidian_root,
            page_cards,
            element_cards,
            page_by_id,
            element_by_id,
            transition_by_id,
            authority_contract_by_id,
        )
    for element in elements.values():
        render_element_card(
            element,
            element_cards[element["id"]],
            obsidian_root,
            page_cards,
            element_cards,
            page_by_id,
            element_by_id,
            transition_by_id,
            authority_contract_by_id,
        )
    for entity_tree in (
        app_root / "pages",
        app_root / "elements",
        app_root / "transitions",
        app_root / "authority-contracts",
        obsidian_root / "页面",
        obsidian_root / "元素",
    ):
        remove_empty_directories(entity_tree)

    report_directory = obsidian_root / "探索报告"
    report_directory.mkdir(parents=True, exist_ok=True)
    for old_report in report_directory.glob("*.md"):
        old_report.unlink()
    report_path = report_directory / "2026-07-31-特别关注-UIKG-3.0.1-规范化报告.md"
    setting_profile_counts: dict[str, int] = defaultdict(int)
    for element in elements.values():
        profile = element.get("composition", {}).get("profile")
        if profile:
            setting_profile_counts[profile] += 1
    profile_summary = "、".join(
        f"{profile}={count}" for profile, count in sorted(setting_profile_counts.items())
    )
    report_path.write_text(
        "---\ntype: exploration-report\nstatus: incomplete\n---\n\n"
        "# 特别关注 UIKG 3.0.1 规范化报告\n\n"
        "[[中通宝盒-知识图谱首页|返回知识图谱首页]]\n\n"
        f"本次合并 {len(evidence['liveFrames'])} 个实时双模型冻结帧和 {len(evidence['liveActions'])} 次成功 Midscene 动作，完成特别关注剩余 Page/Element 的 UIKG 3.0.1 模型规范化。\n\n"
        f"- 设置行 profile：{profile_summary}。\n"
        "- Page 只引用顶层行容器；Label、当前值、说明文字和帮助内容显式不可操作。\n"
        "- 四个选择行由父行容器承担经实测确认的整行 Trigger，箭头只作为不可操作 affordance。\n"
        "- 夜间免打扰使用 toggle_row；我的特别关注使用 action_row，只有右侧箭头是入口。\n"
        "- 提示音选项和成员行使用普通复合容器，行主动作与试听/移除按钮保持独立边界。\n"
        "- 旧帮助 Page 和三个重复帮助图标已通过迁移账本退出 Canonical。\n"
        "- 非 UI 的系统返回动作不再伪装成 Element/Transition；原始动作证据继续保留。\n"
        "- 本次模型修正与实时范围已闭合；历史 仅 Worker B 状态仍待独立 Worker A，因此总体图谱保持 `incomplete`。\n",
        encoding="utf-8",
    )

    legacy_topology_path = obsidian_root / "导航" / "底部导航拓扑.md"
    if legacy_topology_path.is_file():
        legacy_topology_path.unlink()
    topology_path = obsidian_root / "导航" / "导航路网索引.md"
    legacy_navigation_path = app_root / "observations" / "legacy-first-level-navigation.yaml"
    legacy_navigation = read_yaml(legacy_navigation_path) if legacy_navigation_path.is_file() else {}
    pending_shared_navigation = legacy_navigation.get("records", [])
    bottom_navigation = elements.get("shared.bottom_navigation")
    topology_lines = [
        "---",
        "type: navigation-index",
        "status: incomplete",
        "route_materialization: on_demand",
        "edge_projection: canonical_refs_only",
        f"graph_revision: {GRAPH_REVISION}",
        "---",
        "",
        "# 导航路网索引",
        "",
        "[[中通宝盒-知识图谱首页|返回知识图谱首页]]",
        "",
        "## 共享导航范围",
        "",
    ]
    if bottom_navigation:
        topology_lines.append(
            f"- 共享组件：[[{wiki_path(element_cards[bottom_navigation['id']], obsidian_root)}|底部导航]]"
        )
        available_pages = [
            page_by_id[page_ref]
            for page_ref in bottom_navigation.get("availableOnPageRefs", [])
            if page_ref in page_by_id
        ]
        topology_lines.append(
            "- 可用页面：" + ", ".join(
                f"[[{wiki_path(page_cards[page['id']], obsidian_root)}|{page['label']}]]"
                for page in available_pages
            )
        )
    else:
        topology_lines.append("- 尚无已建模的共享导航组件。")
    topology_lines.extend(
        [
            "",
            "## 路网摘要",
            "",
            f"- Page 节点：{len(pages)}",
            f"- 已闭合原子 Transition：{len(transitions)}",
            f"- 权威导航契约：{len(authority_contracts)}",
            f"- 待复核共享导航入口：{len(pending_shared_navigation)}",
            f"- Graph Revision：`{GRAPH_REVISION}`",
            "- 原子边只保存在 Canonical Transition 中；本索引不复制全量边或起终点路线。",
            "",
            "## 按需路径查询",
            "",
            "路线在查询时从当前 Canonical Graph Revision 计算。证据未闭合的共享导航记录不会进入可执行路网。",
            "",
            "`node knowledge_graph/tools/query_navigation_paths.mjs --from <page-key> --to <page-key> --profile shortest --pretty`",
            "",
            "可用 profile：`shortest`、`low-risk`。",
        ]
    )
    topology_path.write_text("\n".join(topology_lines) + "\n", encoding="utf-8")

    home_path = obsidian_root / "中通宝盒-知识图谱首页.md"
    home_lines = [
        "---",
        "type: application",
        f"id: {APP_ID}",
        f"key: {APP_KEY}",
        "status: incomplete",
        f"graph_revision: {GRAPH_REVISION}",
        "---",
        "",
        "# 中通宝盒 UI 知识图谱",
        "",
        f"- [[{wiki_path(report_path, obsidian_root)}|特别关注探索报告]]",
        f"- [[{wiki_path(topology_path, obsidian_root)}|导航路网索引]]",
        "",
        "## 页面",
        "",
    ]
    for page in sorted(pages.values(), key=lambda item: (item["featurePath"], item["label"])):
        home_lines.append(f"- [[{wiki_path(page_cards[page['id']], obsidian_root)}|{page['label']}]]")
    home_lines.extend(["", "## 元素", ""])
    for element in sorted(elements.values(), key=lambda item: (item["featurePath"], item["label"])):
        home_lines.append(f"- [[{wiki_path(element_cards[element['id']], obsidian_root)}|{element['label']}]]")
    home_lines.extend(
        [
            "",
            "## 状态",
            "",
            f"- 本次 UIKG 3.0.1 规范化已具备 {len(evidence['liveFrames'])} 个双模型实时帧；其他特别关注历史状态仍缺少独立 Worker A。",
            "- 底部导航是 Application 持有的共享 Element；“更多”抽屉是共享 Element 状态，不建立同名 Page。",
            "- Obsidian 游离节点验收范围仅为 `knowledge_graph/obsidian/`。",
        ]
    )
    home_path.write_text("\n".join(home_lines) + "\n", encoding="utf-8")

    audit = {
        "recordType": "UiGraphMaterializationAudit",
        "explorationRef": evidence["liveExplorationRef"] or EXPLORATION_ID,
        "status": "incomplete",
        "reason": "uikg_3_0_1_model_normalization_complete_but_historical_states_remain_workerB_only",
        "sourceSpec": SPEC_PATH.name,
        "normalizationPolicy": POLICY_PATH.name,
        "evidence": {
            "rawFrames": len(evidence["frames"]),
            "qualifiedFrames": len(evidence["validFrames"]),
            "rawActionTraces": len(evidence["traces"]),
            "qualifiedActionTraces": len(evidence["validTraces"]),
            "worker_aFrames": len(evidence["workerAFrameRefs"]) + len(evidence["liveFrames"]),
            "liveDualModelFrames": len(evidence["liveFrames"]),
            "liveVerifiedActions": len(evidence["liveActions"]),
            "liveExplorationRef": evidence["liveExplorationRef"],
            "liveExplorationRefs": evidence["liveExplorationRefs"],
            "deprecatedRuntimeTransitions": len(policy.get("deprecatedTransitions", {})),
        },
        "materialized": {
            "pagesTotal": len(pages),
            "elementsTotal": len(elements),
            "transitions": len(transitions),
            "newOrUpdatedSpecialFollowPages": len(spec["pages"]) - len(pending_pages),
            "newSpecialFollowElements": len(spec["elements"]) - len(pending_elements),
        },
        "pending": {
            "pages": pending_pages,
            "elements": pending_elements,
            "transitions": pending_transitions,
        },
    }
    dump_yaml(app_root / "observations" / "special-follow-materialization-audit.yaml", audit)
    migration_ledger = {
        "recordType": "UiGraphMigrationLedger",
        "migrationRef": "reviewed-ui-model-corrections-through-20260730",
        "status": "reviewed",
        "reviewSource": "multiple_user_context_reviews",
        "migrations": migrations,
    }
    dump_yaml(app_root / "observations" / "shared-navigation-model-migrations.yaml", migration_ledger)
    deprecated_transition_records: list[dict[str, Any]] = []
    transition_candidates = {item["key"]: item for item in spec["transitions"]}
    for key, conflict in policy.get("deprecatedTransitions", {}).items():
        candidate = transition_candidates[key]
        evidence_records = []
        for evidence_ref in conflict.get("evidenceRefs", []):
            action_record = read_json(resolved_graph_path(source_root, evidence_ref))
            evidence_records.append(
                {
                    "evidenceRef": evidence_ref,
                    "actionId": action_record.get("id"),
                    "status": action_record.get("status"),
                    "beforeFrameRef": action_record.get("beforeFrameRef"),
                    "actual": action_record.get("assertion", {}).get("thought")
                    or action_record.get("error"),
                }
            )
        deprecated_transition_records.append(
            {
                "id": transition_ids[key],
                "key": key,
                "sourcePageRef": pages[candidate["fromPageKey"]]["id"],
                "triggerElementRef": elements[candidate["triggerElementKey"]]["id"],
                "targetPageRef": pages[candidate["toPageKey"]]["id"],
                "previousCapability": candidate["capability"],
                "canonicalStatus": "removed_from_executable_graph",
                "runtimeStatus": conflict["status"],
                "buildRef": conflict["buildRef"],
                "reason": conflict["reason"],
                "evidence": evidence_records,
            }
        )
    runtime_conflict_ledger = {
        "schemaVersion": SCHEMA_VERSION,
        "recordType": "LegacyTransitionLedger",
        "status": "contradicted_by_current_build",
        "reason": "旧成功 Transition 与当前构建实时证据冲突，保留历史身份但退出可执行 Canonical 路网。",
        "records": deprecated_transition_records,
    }
    dump_yaml(app_root / "observations" / "runtime-transition-conflicts.yaml", runtime_conflict_ledger)

    entries = [
        path.relative_to(app_root).as_posix()
        for path in app_root.rglob("*.yaml")
        if path.name != "manifest.yaml"
    ]
    legacy_manifest = read_yaml(app_root / "manifest.yaml")
    root_hash = sha256_files(
        [path for path in app_root.rglob("*.yaml") if path.name != "manifest.yaml"], app_root
    )
    manifest = {
        "schemaVersion": SCHEMA_VERSION,
        "manifestType": "NormalizedUiKnowledgeGraph",
        "applicationRef": APP_ID,
        "generatedAt": MANIFEST_GENERATED_AT,
        "graphRevision": GRAPH_REVISION,
        "status": "incomplete",
        "entries": sorted(entries),
        "entityIds": sorted(
            set(page_by_id)
            | set(element_by_id)
            | set(transition_by_id)
            | set(authority_contract_by_id)
            | {APP_ID}
        ),
        "migratedEntityIds": sorted(item["oldId"] for item in migrations),
        "legacyTransitionIds": sorted(
            set(legacy_manifest.get("legacyTransitionIds", []))
            | {item["id"] for item in deprecated_transition_records}
        ),
        "rootHash": root_hash,
    }
    dump_yaml(app_root / "manifest.yaml", manifest)

    update = {
        "update": {
            "explorationRef": UPDATE_ID,
            "applicationRef": APP_ID,
            "mergePolicy": "reviewed-migration-plus-additive-upsert",
            "deletions": [item["oldId"] for item in migrations],
            "status": "complete",
            "resultingGraphStatus": "incomplete",
        },
        "migrations": migrations,
        "pages": [
            {"operation": "upsert", **pages[candidate["key"]]}
            for candidate in spec["pages"]
            if candidate["key"] in pages
        ],
        "elements": [
            {"operation": "upsert", **elements[key]}
            for key in sorted(candidate["key"] for candidate in spec["elements"] if candidate["key"] in elements)
        ],
        "transitions": [
            {"operation": "upsert", **transitions[key]}
            for key in sorted(
                set(evidence["liveTransitionBindings"])
                | {"messages.special_follow.settings.open_people"}
            )
            if key in transitions
        ],
        "authorityContracts": [
            {"operation": "upsert", **contract}
            for contract in authority_contracts.values()
        ],
        "preservation": {
            "existingEntityIds": sorted(legacy_manifest.get("entityIds", [])),
            "protectedSharedNavigationRefs": sorted(existing_elements),
        },
        "coverage": audit,
    }
    normalization_root = output_root / "normalization" / UPDATE_ID
    dump_yaml(normalization_root / "graph-update.yaml", update)
    baseline_paths = sorted(
        list(source_root.joinpath("apps", APP_KEY).rglob("*"))
        + list(source_root.joinpath("obsidian", APP_KEY).rglob("*"))
    )
    baseline_files = [path for path in baseline_paths if path.is_file()]
    scope = {
        "task": {
            "id": UPDATE_ID,
            "requestedAt": UPDATE_RECORDED_AT,
            "objective": "按 UIKG 3.0.1 修正弹窗提醒间隔选择器背景遮罩的实时 locator 与红框，并保持既有容器模型不变。",
        },
        "application": {
            "key": APP_KEY,
            "packageId": "com.zto.connect.fat",
            "build": {"environment": "test", "versionCode": "10542"},
        },
        "entry": {
            "description": "特别关注提醒页面“我的特别关注”复合入口容器",
            "knownFacts": [
                "页面只直接引用“我的特别关注”总容器元素。",
                "总容器持有说明文案和右侧箭头两个子元素。",
                "“我的特别关注”文案用于说明入口，不可点击。",
                "右侧箭头是打开全部特别关注成员列表的独立可点击入口。",
            ],
            "authorityContracts": [
                {
                    "id": contract["id"],
                    "sourceType": contract["sourceType"],
                    "authorityStatus": contract["authorityStatus"],
                    "planningEligible": contract["planningEligible"],
                    "sourceSelector": contract["sourceSelector"],
                    "triggerElementRef": contract["triggerElementRef"],
                    "expectedTarget": contract["expectedTarget"],
                    "runtimeEvidenceStatus": contract["runtimeEvidenceStatus"],
                }
                for contract in authority_contracts.values()
            ],
        },
        "scope": {
            "mode": "uikg_3_0_1_popup_backdrop_redbox_repair",
            "deviceActions": f"{len(evidence['liveActions'])} verified Midscene actions; no ADB UI actions",
            "reason": "设备已连接；弹窗提醒间隔选择器的完整背景遮罩已获得实时帧、独立 Worker A、Worker B 答卷和独立 locator。",
        },
        "graph": {
            "root": str(source_root),
            "normativeSpec": {
                "index": "spec/README.md",
                "version": NORMATIVE_SPEC_VERSION,
                "schemaVersion": SCHEMA_VERSION,
                "contentHash": NORMATIVE_SPEC_HASH,
                "schemaFiles": [
                    "spec/schemas/application.schema.json",
                    "spec/schemas/authority-contract.schema.json",
                    "spec/schemas/common.schema.json",
                    "spec/schemas/element.schema.json",
                    "spec/schemas/manifest.schema.json",
                    "spec/schemas/page.schema.json",
                    "spec/schemas/supporting-record.schema.json",
                    "spec/schemas/transition.schema.json",
                ],
                "relationshipRules": "spec/relationship-invariants.md",
                "precedenceAccepted": True,
            },
            "mergePolicy": "reviewed-migration-plus-additive-upsert",
            "preserveHistoricalEntities": True,
            "stageBeforePublish": True,
            "baseline": {
                "fileCount": len(baseline_files),
                "contentHash": sha256_files(baseline_files, source_root),
                "entityIdsHash": "sha256:" + hashlib.sha256(
                    "\n".join(sorted(legacy_manifest.get("entityIds", []))).encode()
                ).hexdigest(),
            },
        },
        "completion": {
            "correctionStatus": "complete",
            "resultingGraphStatus": "incomplete",
            "remainingLimitation": "本次模型规范化与实时范围已闭合；历史特别关注状态仍有 仅 Worker B 证据，整体图谱继续标记 incomplete。",
        },
    }
    dump_yaml(normalization_root / "scope.yaml", scope)
    live_frame_count = len(evidence["liveFrames"])
    live_action_count = len(evidence["liveActions"])
    (normalization_root / "report.md").write_text(
        "# 特别关注 UIKG 3.0.1 规范化报告\n\n"
        f"本次用 {live_frame_count} 个实时双模型冻结帧和 {live_action_count} 次成功 Midscene 动作完成背景遮罩红框修复并复验既有模型。\n\n"
        f"- 设置行 profile：{profile_summary}。\n"
        "- 页面引用：设置页、提示音面板和成员页只引用顶层容器，不再扁平引用后代。\n"
        "- 交互边界：说明文字、当前值、帮助内容和 affordance 不可操作；实际 Trigger 独立承担 capability。\n"
        "- 定位修复：弹窗提醒间隔选择器背景遮罩使用完整模态背景区域的实时 locator 生成独立红框图。\n"
        "- 普通复合控件：提示音行区分选择与试听，成员行区分主行与移除按钮。\n"
        "- 重复清理：旧帮助 Page 和 `settings.help.*` 重复元素通过审核迁移记录退出 Canonical。\n"
        "- 运行冲突：旧“再次点击问号关闭”边已从可执行路网移除并保留反例证据。\n"
        "- 总体状态：模型规范化完成；历史 仅 Worker B 状态仍缺独立 Worker A，图谱保持 `incomplete`。\n",
        encoding="utf-8",
    )
    print(yaml.safe_dump(audit, allow_unicode=True, sort_keys=False), end="")


if __name__ == "__main__":
    main()
