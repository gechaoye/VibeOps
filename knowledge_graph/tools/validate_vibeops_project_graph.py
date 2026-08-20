#!/usr/bin/env python3
"""Validate VibeOps Project Graph 1.0 bundles against the active model config."""

from __future__ import annotations

import argparse
import json
import re
import sys
from collections import defaultdict
from pathlib import Path
from typing import Any

import yaml
from jsonschema import Draft202012Validator, FormatChecker


ID_PATTERN = re.compile(r"^[a-z][a-z0-9_-]*:[A-Za-z0-9][A-Za-z0-9._:-]*$")
KNOWLEDGE_VALUES = {
    "origin": {"manual", "ai_inferred", "imported", "system_generated"},
    "reviewStatus": {"pending", "confirmed", "rejected"},
    "validationStatus": {"unverified", "observed", "runtime_verified", "contradicted"},
}


def load_yaml(path: Path) -> dict[str, Any]:
    with path.open(encoding="utf-8") as handle:
        value = yaml.safe_load(handle)
    if not isinstance(value, dict):
        raise ValueError(f"{path}: root must be an object")
    return value


def load_json(path: Path) -> dict[str, Any]:
    with path.open(encoding="utf-8") as handle:
        value = json.load(handle)
    if not isinstance(value, dict):
        raise ValueError(f"{path}: root must be an object")
    return value


def validate_schema(instance: Any, schema: dict[str, Any], location: str, errors: list[str]) -> None:
    validator = Draft202012Validator(schema, format_checker=FormatChecker())
    for error in sorted(validator.iter_errors(instance), key=lambda item: list(item.absolute_path)):
        path = ".".join(str(part) for part in error.absolute_path)
        suffix = f".{path}" if path else ""
        errors.append(f"{location}{suffix}: {error.message}")


def merge_model(core: dict[str, Any], project: dict[str, Any]) -> dict[str, Any]:
    merged = {
        "entityTypes": dict(core.get("entityTypes", {})),
        "relationTypes": dict(core.get("relationTypes", {})),
        "optionSets": dict(core.get("optionSets", {})),
    }
    merged["entityTypes"].update(project.get("entityTypes", {}))
    merged["relationTypes"].update(project.get("relationTypes", {}))

    for key, override in project.get("optionSets", {}).items():
        base = dict(merged["optionSets"].get(key, {}))
        options = list(base.get("options", []))
        if "options" in override:
            options = list(override["options"])
        options.extend(override.get("addOptions", []))
        base.update({k: v for k, v in override.items() if k not in {"options", "addOptions"}})
        base["options"] = options
        merged["optionSets"][key] = base

    fields: dict[str, dict[str, Any]] = {}
    for field in [*core.get("fields", []), *project.get("fields", [])]:
        key = field.get("key")
        if not key:
            continue
        fields[key] = {**fields.get(key, {}), **field}
    merged["fields"] = list(fields.values())
    return merged


def validate_model(model: dict[str, Any], errors: list[str]) -> None:
    supported_types = {
        "string", "text", "integer", "number", "boolean", "date", "datetime",
        "option", "multi_option", "entity_ref", "entity_ref_list", "object", "object_list",
    }
    entity_types = set(model["entityTypes"])
    for key, option_set in model["optionSets"].items():
        seen: set[str] = set()
        for option in option_set.get("options", []):
            value = option.get("value")
            if not value or not option.get("label"):
                errors.append(f"model: option set {key!r} contains an incomplete option")
            if value in seen:
                errors.append(f"model: option set {key!r} contains duplicate value {value!r}")
            seen.add(value)
    for field in model["fields"]:
        key = field.get("key", "<missing>")
        if field.get("valueType") not in supported_types:
            errors.append(f"model: field {key!r} has unsupported valueType {field.get('valueType')!r}")
        unknown_types = set(field.get("appliesTo", [])) - entity_types
        if unknown_types:
            errors.append(f"model: field {key!r} applies to unknown entity types {sorted(unknown_types)}")
        option_set_ref = field.get("optionSetRef")
        if option_set_ref and option_set_ref not in model["optionSets"]:
            errors.append(f"model: field {key!r} references unknown option set {option_set_ref!r}")
    for key, relation in model["relationTypes"].items():
        for side in ("sourceTypes", "targetTypes"):
            unknown_types = set(relation.get(side, [])) - entity_types - {"*"}
            if unknown_types:
                errors.append(f"model: relation {key!r} has unknown {side} {sorted(unknown_types)}")


def validate_knowledge(value: Any, location: str, errors: list[str]) -> None:
    if not isinstance(value, dict):
        errors.append(f"{location}: knowledge must be an object")
        return
    for key, allowed in KNOWLEDGE_VALUES.items():
        if value.get(key) not in allowed:
            errors.append(f"{location}: invalid knowledge.{key}={value.get(key)!r}")
    refs = value.get("evidenceRefs")
    if not isinstance(refs, list):
        errors.append(f"{location}: knowledge.evidenceRefs must be an array")
    confidence = value.get("confidence")
    if confidence is not None and (not isinstance(confidence, (int, float)) or not 0 <= confidence <= 1):
        errors.append(f"{location}: confidence must be between 0 and 1")


def matches_type(value: Any, value_type: str) -> bool:
    checks = {
        "string": lambda v: isinstance(v, str),
        "text": lambda v: isinstance(v, str),
        "integer": lambda v: isinstance(v, int) and not isinstance(v, bool),
        "number": lambda v: isinstance(v, (int, float)) and not isinstance(v, bool),
        "boolean": lambda v: isinstance(v, bool),
        "date": lambda v: isinstance(v, str),
        "datetime": lambda v: isinstance(v, str),
        "option": lambda v: isinstance(v, str),
        "multi_option": lambda v: isinstance(v, list) and all(isinstance(item, str) for item in v),
        "entity_ref": lambda v: isinstance(v, str) and bool(ID_PATTERN.match(v)),
        "entity_ref_list": lambda v: isinstance(v, list) and all(isinstance(item, str) and ID_PATTERN.match(item) for item in v),
        "object": lambda v: isinstance(v, dict),
        "object_list": lambda v: isinstance(v, list) and all(isinstance(item, dict) for item in v),
    }
    return value_type in checks and checks[value_type](value)


def validate_attributes(entity: dict[str, Any], model: dict[str, Any], errors: list[str]) -> None:
    entity_type = entity["entityType"]
    attributes = entity.get("attributes")
    if not isinstance(attributes, dict):
        errors.append(f"{entity['id']}: attributes must be an object")
        return
    definitions = {
        field["key"]: field
        for field in model["fields"]
        if entity_type in field.get("appliesTo", [])
    }
    for key in attributes:
        if key not in definitions:
            errors.append(f"{entity['id']}: undeclared attribute {key!r}")
    for key, field in definitions.items():
        if field.get("required") and key not in attributes and "defaultValue" not in field:
            errors.append(f"{entity['id']}: required attribute {key!r} is missing")
        if key not in attributes:
            continue
        value = attributes[key]
        value_type = field.get("valueType")
        if not matches_type(value, value_type):
            errors.append(f"{entity['id']}: attribute {key!r} is not {value_type}")
            continue
        option_set_ref = field.get("optionSetRef")
        if option_set_ref and not field.get("allowCustomOptions"):
            option_set = model["optionSets"].get(option_set_ref)
            if not option_set:
                errors.append(f"model: field {key!r} references unknown option set {option_set_ref!r}")
                continue
            allowed = {item["value"] for item in option_set.get("options", []) if item.get("status", "active") == "active"}
            values = value if isinstance(value, list) else [value]
            unknown = [item for item in values if item not in allowed]
            if unknown:
                errors.append(f"{entity['id']}: attribute {key!r} has unknown options {unknown}")
        if value_type == "object_list" and field.get("itemFields"):
            for index, item in enumerate(value):
                for child in field["itemFields"]:
                    child_key = child["key"]
                    if child.get("required") and child_key not in item:
                        errors.append(f"{entity['id']}: {key}[{index}].{child_key} is required")
                    elif child_key in item and not matches_type(item[child_key], child["valueType"]):
                        errors.append(f"{entity['id']}: {key}[{index}].{child_key} has wrong type")


def validate_graph(root: Path, graph_path: Path) -> list[str]:
    core = load_yaml(root / "model/core.yaml")
    graph = load_yaml(graph_path)
    project_key = graph["projectRef"].split(":", 1)[1]
    project_model = load_yaml(root / f"projects/{project_key}/model.yaml")
    model = merge_model(core, project_model)
    records = [*graph.get("records", []), *graph.get("relations", [])]
    errors: list[str] = []
    model_schema = load_json(root / "spec/schemas/vibeops-model.schema.json")
    record_schema = load_json(root / "spec/schemas/vibeops-record.schema.json")
    validate_schema(core, model_schema, "model/core.yaml", errors)
    validate_schema(project_model, model_schema, f"projects/{project_key}/model.yaml", errors)
    validate_model(model, errors)
    by_id: dict[str, dict[str, Any]] = {}

    for index, record in enumerate(records):
        location = f"record[{index}]"
        if not isinstance(record, dict):
            errors.append(f"{location}: record must be an object")
            continue
        record_id = record.get("id")
        if not isinstance(record_id, str) or not ID_PATTERN.match(record_id):
            errors.append(f"{location}: invalid id {record_id!r}")
            continue
        if record_id in by_id:
            errors.append(f"{record_id}: duplicate id")
        by_id[record_id] = record
        validate_schema(record, record_schema, record_id, errors)
        if record.get("projectRef") != graph.get("projectRef"):
            errors.append(f"{record_id}: projectRef differs from graph projectRef")

    entity_by_id = {key: value for key, value in by_id.items() if value.get("recordKind") == "Entity"}
    evidence_by_id = {key: value for key, value in by_id.items() if value.get("recordKind") == "Evidence"}

    for record_id, record in by_id.items():
        kind = record.get("recordKind")
        if kind == "Entity":
            entity_type = record.get("entityType")
            if entity_type not in model["entityTypes"]:
                errors.append(f"{record_id}: unknown entityType {entity_type!r}")
            for key in ("key", "label", "summary", "lifecycleStatus", "knowledge"):
                if key not in record:
                    errors.append(f"{record_id}: missing {key}")
            validate_knowledge(record.get("knowledge"), record_id, errors)
            validate_attributes(record, model, errors)
        elif kind == "Relation":
            definition = model["relationTypes"].get(record.get("relationType"))
            if not definition:
                errors.append(f"{record_id}: unknown relationType {record.get('relationType')!r}")
                continue
            source = entity_by_id.get(record.get("sourceRef"))
            target = entity_by_id.get(record.get("targetRef"))
            if not source:
                errors.append(f"{record_id}: unresolved sourceRef {record.get('sourceRef')!r}")
            if not target:
                errors.append(f"{record_id}: unresolved targetRef {record.get('targetRef')!r}")
            if source and "*" not in definition["sourceTypes"] and source["entityType"] not in definition["sourceTypes"]:
                errors.append(f"{record_id}: source type {source['entityType']} is not allowed")
            if target and "*" not in definition["targetTypes"] and target["entityType"] not in definition["targetTypes"]:
                errors.append(f"{record_id}: target type {target['entityType']} is not allowed")
            source_rule = definition.get("constraints", {}).get("sourceAttribute")
            if source and source_rule and source.get("attributes", {}).get(source_rule["key"]) != source_rule["equals"]:
                errors.append(f"{record_id}: source does not satisfy {source_rule}")
            validate_knowledge(record.get("knowledge"), record_id, errors)
        elif kind == "Observation":
            if record.get("subjectRef") not in entity_by_id:
                errors.append(f"{record_id}: unresolved subjectRef {record.get('subjectRef')!r}")
            for element in record.get("payload", {}).get("elements", []):
                if element.get("elementRef") not in entity_by_id:
                    errors.append(f"{record_id}: unresolved observed element {element.get('elementRef')!r}")
        elif kind == "Evidence":
            if not record.get("uri") or not record.get("capturedAt"):
                errors.append(f"{record_id}: Evidence requires uri and capturedAt")
        else:
            errors.append(f"{record_id}: unknown recordKind {kind!r}")

        knowledge = record.get("knowledge")
        if isinstance(knowledge, dict):
            for evidence_ref in knowledge.get("evidenceRefs", []):
                if evidence_ref not in evidence_by_id:
                    errors.append(f"{record_id}: unresolved evidenceRef {evidence_ref!r}")
            if knowledge.get("validationStatus") == "runtime_verified" and not knowledge.get("evidenceRefs"):
                errors.append(f"{record_id}: runtime_verified requires evidenceRefs")
        for evidence_ref in record.get("evidenceRefs", []):
            if evidence_ref not in evidence_by_id:
                errors.append(f"{record_id}: unresolved evidenceRef {evidence_ref!r}")

    parents: dict[str, list[str]] = defaultdict(list)
    adjacency: dict[str, list[str]] = defaultdict(list)
    for relation in graph.get("relations", []):
        if relation.get("relationType") == "contains":
            parents[relation["targetRef"]].append(relation["sourceRef"])
            adjacency[relation["sourceRef"]].append(relation["targetRef"])
    for target, sources in parents.items():
        if len(sources) > 1:
            errors.append(f"{target}: multiple structural parents {sources}")

    visiting: set[str] = set()
    visited: set[str] = set()

    def visit(node: str) -> None:
        if node in visiting:
            errors.append(f"contains: cycle detected at {node}")
            return
        if node in visited:
            return
        visiting.add(node)
        for child in adjacency[node]:
            visit(child)
        visiting.remove(node)
        visited.add(node)

    for node in list(adjacency):
        visit(node)
    return errors


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--root", type=Path, default=Path("knowledge_graph"))
    parser.add_argument("--graph", type=Path, default=Path("knowledge_graph/projects/baohe/graph/special-follow.yaml"))
    args = parser.parse_args()
    root = args.root.resolve()
    graph_path = args.graph.resolve()
    errors = validate_graph(root, graph_path)
    if errors:
        print("VibeOps Project Graph validation failed:")
        for error in errors:
            print(f"- {error}")
        return 1
    graph = load_yaml(graph_path)
    print(f"graph: {graph_path}")
    print(f"modelVersion: {graph['modelVersion']}")
    print(f"entities/evidence/observations: {len(graph.get('records', []))}")
    print(f"relations: {len(graph.get('relations', []))}")
    print("result: PASS")
    return 0


if __name__ == "__main__":
    sys.exit(main())
