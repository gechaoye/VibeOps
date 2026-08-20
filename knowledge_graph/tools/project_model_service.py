#!/usr/bin/env python3
"""Read and atomically update a project's configurable VibeOps model."""

from __future__ import annotations

import argparse
import json
import os
import re
import sys
import tempfile
from pathlib import Path
from typing import Any

import yaml

from validate_vibeops_project_graph import load_json, load_yaml, merge_model, validate_model, validate_schema


PROJECT_KEY = re.compile(r"^[a-z0-9][a-z0-9.-]*$")


def project_model_path(root: Path, project: str) -> Path:
    if not PROJECT_KEY.fullmatch(project):
        raise ValueError("invalid project key")
    path = (root / "projects" / project / "model.yaml").resolve()
    if root.resolve() not in path.parents:
        raise ValueError("project path escapes knowledge graph root")
    return path


def next_version(current: str, project: str) -> str:
    match = re.fullmatch(rf"{re.escape(project)}@(\d+)\.(\d+)\.(\d+)", current)
    if not match:
        return f"{project}@1.0.0"
    major, minor, patch = (int(value) for value in match.groups())
    return f"{project}@{major}.{minor}.{patch + 1}"


def public_payload(root: Path, project: str, project_model: dict[str, Any] | None = None) -> dict[str, Any]:
    core = load_yaml(root / "model/core.yaml")
    current = project_model or load_yaml(project_model_path(root, project))
    return {
        "projectKey": project,
        "core": core,
        "project": current,
        "effectiveModelVersion": current["modelVersion"],
    }


def validate_candidate(root: Path, project: str, candidate: dict[str, Any]) -> list[str]:
    errors: list[str] = []
    core = load_yaml(root / "model/core.yaml")
    schema = load_json(root / "spec/schemas/vibeops-model.schema.json")
    validate_schema(candidate, schema, f"projects/{project}/model.yaml", errors)
    if candidate.get("projectRef") != f"project:{project}":
        errors.append(f"projectRef must equal project:{project}")
    if candidate.get("baseModelVersion") != core.get("modelVersion"):
        errors.append("baseModelVersion must match the active core model")
    validate_model(merge_model(core, candidate), errors)
    return errors


def save(root: Path, project: str, payload: dict[str, Any]) -> dict[str, Any]:
    current_path = project_model_path(root, project)
    current = load_yaml(current_path)
    submitted = payload.get("model")
    if not isinstance(submitted, dict):
        raise ValueError("model must be an object")
    allowed = {"projectRef", "baseModelVersion", "entityTypes", "relationTypes", "optionSets", "fields"}
    candidate = {key: submitted[key] for key in allowed if key in submitted}
    candidate["projectRef"] = f"project:{project}"
    candidate["baseModelVersion"] = load_yaml(root / "model/core.yaml")["modelVersion"]
    candidate["modelVersion"] = next_version(str(current.get("modelVersion", "")), project)
    candidate.setdefault("entityTypes", {})
    candidate.setdefault("relationTypes", {})
    candidate.setdefault("optionSets", {})
    candidate.setdefault("fields", [])
    errors = validate_candidate(root, project, candidate)
    if errors:
        raise ValueError(json.dumps({"message": "模型配置校验失败", "errors": errors}, ensure_ascii=False))

    current_path.parent.mkdir(parents=True, exist_ok=True)
    content = yaml.safe_dump(candidate, allow_unicode=True, sort_keys=False, width=120)
    descriptor, temporary_name = tempfile.mkstemp(prefix="model-", suffix=".yaml", dir=current_path.parent)
    try:
        with os.fdopen(descriptor, "w", encoding="utf-8") as handle:
            handle.write(content)
            handle.flush()
            os.fsync(handle.fileno())
        os.replace(temporary_name, current_path)
    finally:
        if os.path.exists(temporary_name):
            os.unlink(temporary_name)
    return public_payload(root, project, candidate)


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("command", choices=["read", "save"])
    parser.add_argument("--root", type=Path, required=True)
    parser.add_argument("--project", required=True)
    args = parser.parse_args()
    try:
        if args.command == "read":
            result = public_payload(args.root.resolve(), args.project)
        else:
            result = save(args.root.resolve(), args.project, json.load(sys.stdin))
        print(json.dumps(result, ensure_ascii=False))
        return 0
    except Exception as error:
        try:
            parsed = json.loads(str(error))
            message = parsed.get("message", str(error))
            details = parsed
        except (json.JSONDecodeError, AttributeError):
            message = str(error)
            details = {"errors": [message]}
        print(json.dumps({"error": message, **details}, ensure_ascii=False), file=sys.stderr)
        return 1


if __name__ == "__main__":
    sys.exit(main())

