#!/usr/bin/env python3
"""Validate a normalized UI knowledge graph and its Obsidian projection."""

from __future__ import annotations

import argparse
import hashlib
import re
import sys
from collections import defaultdict
from pathlib import Path
from typing import Any

import yaml
from PIL import Image


SCRIPT_DIR = Path(__file__).resolve().parent
GRAPH_ROOT = SCRIPT_DIR.parent
APP_KEY = "zto.connect"

SETTING_PROFILE_RULES = {
    "toggle_row": {
        "required": {"label", "settingControl"},
        "optional": {"secondaryText"},
        "actionable": {"settingControl"},
        "non_actionable": {"label", "secondaryText"},
    },
    "selector_row": {
        "required": {"label", "currentValue", "settingTrigger"},
        "optional": {"affordance", "secondaryText"},
        "actionable": {"settingTrigger"},
        "non_actionable": {"label", "currentValue", "secondaryText"},
    },
    "help_toggle_row": {
        "required": {"label", "helpTrigger", "helpPopover", "settingControl"},
        "optional": {"secondaryText"},
        "actionable": {"helpTrigger", "settingControl"},
        "non_actionable": {"label", "helpPopover", "secondaryText"},
    },
    "action_row": {
        "required": {"explanatoryContent", "actionTrigger"},
        "optional": {"secondaryText"},
        "actionable": {"actionTrigger"},
        "non_actionable": {"explanatoryContent", "secondaryText"},
    },
}


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--root", type=Path, default=GRAPH_ROOT)
    parser.add_argument("--report", type=Path)
    return parser.parse_args()


def yaml_records(root: Path) -> list[dict[str, Any]]:
    records: list[dict[str, Any]] = []
    for path in root.rglob("*.yaml"):
        if path.name == "manifest.yaml":
            continue
        records.extend(
            item
            for item in yaml.safe_load_all(path.read_text(encoding="utf-8"))
            if isinstance(item, dict)
        )
    return records


def feature_depth(path: Path, category: Path) -> int:
    return len(path.relative_to(category).parts) - 1


def functional_directories_without_files(root: Path, pattern: str) -> list[Path]:
    if not root.is_dir():
        return []
    return sorted(
        directory
        for directory in root.rglob("*")
        if directory.is_dir() and not any(directory.rglob(pattern))
    )


def frontmatter(content: str) -> dict[str, Any]:
    match = re.match(r"^---\n(.*?)\n---\n", content, re.DOTALL)
    if not match:
        return {}
    value = yaml.safe_load(match.group(1))
    return value if isinstance(value, dict) else {}


def wikilink_targets(content: str) -> list[str]:
    return [target.strip() for target in re.findall(r"(?<!!)\[\[([^]|#]+)", content)]


def resolve_wikilink(target: str, document: Path, obsidian_root: Path) -> Path | None:
    app_root = obsidian_root / document.relative_to(obsidian_root).parts[0]
    candidates = [app_root / f"{target}.md", obsidian_root / f"{target}.md"]
    if "/" not in target:
        candidates.extend(app_root.rglob(f"{target}.md"))
    return next((path.resolve() for path in candidates if path.is_file()), None)


def red_pixel_count(path: Path) -> int:
    with Image.open(path) as image:
        return sum(1 for pixel in image.convert("RGB").getdata() if pixel == (255, 0, 0))


def root_hash(app_root: Path) -> str:
    digest = hashlib.sha256()
    paths = sorted(path for path in app_root.rglob("*.yaml") if path.name != "manifest.yaml")
    for path in paths:
        digest.update(path.relative_to(app_root).as_posix().encode())
        digest.update(b"\0")
        digest.update(path.read_bytes())
        digest.update(b"\0")
    return "sha256:" + digest.hexdigest()


def terminal_owner(element: dict[str, Any], element_by_id: dict[str, dict[str, Any]]) -> tuple[str | None, str | None, str | None]:
    current = element
    visited: set[str] = set()
    while current:
        current_id = current.get("id")
        if current_id in visited:
            return None, None, "owner cycle"
        visited.add(current_id)
        owner = current.get("owner", {})
        kind = owner.get("kind")
        owner_ref = owner.get("ref")
        if kind in {"application", "page"}:
            return kind, owner_ref, None
        if kind not in {"component", "shared_component"}:
            return None, owner_ref, f"invalid owner kind {kind}"
        current = element_by_id.get(owner_ref)
        if current is None:
            return None, owner_ref, "missing parent Element"
    return None, None, "unterminated owner chain"


def observation_rect(observation: dict[str, Any]) -> tuple[Any, ...] | None:
    rect = observation.get("locator", {}).get("rect", {})
    values = tuple(rect.get(field) for field in ("left", "top", "width", "height"))
    return values if all(value is not None for value in values) else None


def contains_marker(value: Any, marker: str) -> bool:
    if isinstance(value, dict):
        return any(contains_marker(key, marker) or contains_marker(item, marker) for key, item in value.items())
    if isinstance(value, list):
        return any(contains_marker(item, marker) for item in value)
    return isinstance(value, str) and marker in value


def validate_compositions(
    elements: list[dict[str, Any]],
    transitions: list[dict[str, Any]] | None = None,
    authority_contracts: list[dict[str, Any]] | None = None,
) -> list[str]:
    """Validate generic composites and the UIKG 3.0.1 setting-row profiles."""
    errors: list[str] = []
    element_by_id = {item.get("id"): item for item in elements}
    protected_non_actionable_ids: set[str] = set()

    for element in elements:
        key = element.get("key")
        composition = element.get("composition")
        owner = element.get("owner", {})
        if (
            not composition
            and owner.get("kind") == "page"
            and element.get("role") == "setting"
            and element.get("controlType") in {"list_entry", "toggle"}
        ):
            errors.append(f"Element {key} is a flat Page-owned setting row without a composition profile")
            continue
        if not composition:
            continue

        roles = composition.get("roles")
        if not isinstance(roles, dict) or not roles:
            errors.append(f"Element {key} composition has no named roles")
            continue
        child_refs = set(element.get("childElementRefs", []))
        role_refs = set(roles.values())
        allowed_refs = child_refs | {element.get("id")}
        invalid_refs = role_refs - allowed_refs
        if invalid_refs:
            errors.append(f"Element {key} composition roles reference non-child Elements: {sorted(invalid_refs)}")
        if child_refs != (role_refs - {element.get("id")}):
            errors.append(f"Element {key} composition roles differ from its direct children")

        profile = composition.get("profile")
        if profile is None:
            duplicate_refs = [ref for ref in role_refs if list(roles.values()).count(ref) > 1]
            if duplicate_refs:
                errors.append(f"Element {key} generic composition assigns one Element to multiple roles")
        elif profile not in SETTING_PROFILE_RULES:
            errors.append(f"Element {key} has unsupported setting composition profile {profile}")
        else:
            rules = SETTING_PROFILE_RULES[profile]
            actual_roles = set(roles)
            missing = rules["required"] - actual_roles
            unexpected = actual_roles - rules["required"] - rules["optional"]
            if missing:
                errors.append(f"Element {key} {profile} is missing roles: {sorted(missing)}")
            if unexpected:
                errors.append(f"Element {key} {profile} has unexpected roles: {sorted(unexpected)}")

            for role, ref in roles.items():
                if ref == element.get("id") and not (profile == "selector_row" and role == "settingTrigger"):
                    errors.append(f"Element {key} role {role} cannot reference the container itself")
            duplicate_role_groups: dict[str, set[str]] = defaultdict(set)
            for role, ref in roles.items():
                duplicate_role_groups[ref].add(role)
            for ref, assigned_roles in duplicate_role_groups.items():
                if len(assigned_roles) <= 1:
                    continue
                if not (
                    profile == "selector_row"
                    and assigned_roles == {"affordance", "settingTrigger"}
                    and ref != element.get("id")
                ):
                    errors.append(
                        f"Element {key} assigns one Element to incompatible roles: {sorted(assigned_roles)}"
                    )

            for role in rules["non_actionable"] & actual_roles:
                member = element_by_id.get(roles[role])
                if not member:
                    continue
                protected_non_actionable_ids.add(member.get("id"))
                if member.get("capabilities"):
                    errors.append(f"Element {key} role {role} must have empty capabilities")
                if member.get("interactionBoundary", {}).get("actionable") is not False:
                    errors.append(f"Element {key} role {role} is not explicitly non-actionable")

            for role in rules["actionable"] & actual_roles:
                member = element if roles[role] == element.get("id") else element_by_id.get(roles[role])
                if not member:
                    continue
                if not member.get("capabilities"):
                    errors.append(f"Element {key} role {role} has no capability")
                if member.get("interactionBoundary", {}).get("actionable") is not True:
                    errors.append(f"Element {key} role {role} is not explicitly actionable")

            if profile == "selector_row" and "affordance" in roles:
                affordance = element_by_id.get(roles["affordance"])
                same_as_trigger = roles["affordance"] == roles.get("settingTrigger")
                if affordance and not same_as_trigger:
                    protected_non_actionable_ids.add(affordance.get("id"))
                    if affordance.get("capabilities"):
                        errors.append(f"Element {key} affordance must have empty capabilities")
                    if affordance.get("interactionBoundary", {}).get("actionable") is not False:
                        errors.append(f"Element {key} affordance is not explicitly non-actionable")

            self_is_trigger = profile == "selector_row" and roles.get("settingTrigger") == element.get("id")
            if not self_is_trigger:
                if element.get("capabilities"):
                    errors.append(f"Element {key} setting-row container must have empty capabilities")
                if element.get("interactionBoundary", {}).get("actionable") is not False:
                    errors.append(f"Element {key} setting-row container is not explicitly non-actionable")

        semantic_members = [element] + [element_by_id[ref] for ref in child_refs if ref in element_by_id]
        locator_signatures: dict[tuple[str, tuple[Any, ...]], list[str]] = defaultdict(list)
        redbox_signatures: dict[tuple[str, str], list[str]] = defaultdict(list)
        for member in semantic_members:
            for observation in member.get("observations", []):
                frame_ref = observation.get("frameRef")
                rect = observation_rect(observation)
                if frame_ref and rect:
                    locator_signatures[(frame_ref, rect)].append(member.get("key"))
                redbox_ref = observation.get("redboxRef")
                if frame_ref and redbox_ref:
                    redbox_signatures[(frame_ref, redbox_ref)].append(member.get("key"))
        for signature, member_keys in locator_signatures.items():
            if len(set(member_keys)) > 1:
                errors.append(
                    f"Element {key} reuses locator {signature} across semantic members: {sorted(set(member_keys))}"
                )
        for signature, member_keys in redbox_signatures.items():
            if len(set(member_keys)) > 1:
                errors.append(
                    f"Element {key} reuses redbox {signature} across semantic members: {sorted(set(member_keys))}"
                )

    for edge_kind, edges in (
        ("Transition", transitions or []),
        ("AuthorityContract", authority_contracts or []),
    ):
        for edge in edges:
            edge_key = edge.get("key")
            trigger = element_by_id.get(edge.get("triggerElementRef"))
            if not trigger:
                continue
            capability = edge.get("capability")
            if trigger.get("id") in protected_non_actionable_ids:
                errors.append(f"{edge_kind} {edge_key} uses a non-actionable composition role as Trigger")
            if trigger.get("interactionBoundary", {}).get("actionable") is not True:
                errors.append(f"{edge_kind} {edge_key} Trigger is not explicitly actionable")
            if capability not in trigger.get("capabilities", []):
                errors.append(f"{edge_kind} {edge_key} Trigger does not own capability {capability}")

    return errors


def main() -> None:
    options = parse_args()
    root = options.root.resolve()
    app_root = root / "apps" / APP_KEY
    app_obsidian = root / "obsidian" / APP_KEY
    obsidian_root = root / "obsidian"
    errors: list[str] = []
    records = yaml_records(app_root)
    pages = [item for item in records if item.get("entityType") == "Page"]
    elements = [item for item in records if item.get("entityType") == "Element"]
    transitions = [item for item in records if item.get("entityType") == "Transition"]
    authority_contracts = [item for item in records if item.get("entityType") == "AuthorityContract"]
    applications = [item for item in records if item.get("entityType") == "Application"]
    page_by_id = {item.get("id"): item for item in pages}
    element_by_id = {item.get("id"): item for item in elements}
    element_by_key = {item.get("key"): item for item in elements}
    transition_by_id = {item.get("id"): item for item in transitions}
    authority_contract_by_id = {item.get("id"): item for item in authority_contracts}
    application_id = applications[0].get("id") if len(applications) == 1 else None
    canonical_records = applications + pages + elements + transitions + authority_contracts

    if len(applications) != 1:
        errors.append(f"expected one Application, found {len(applications)}")
    for field in ("id", "key"):
        values = [item.get(field) for item in canonical_records]
        if len(values) != len(set(values)):
            errors.append(f"duplicate Canonical {field}s across entity types")
    for kind, values in (
        ("Page", pages),
        ("Element", elements),
        ("Transition", transitions),
        ("AuthorityContract", authority_contracts),
    ):
        ids = [item.get("id") for item in values]
        keys = [item.get("key") for item in values]
        if len(ids) != len(set(ids)):
            errors.append(f"duplicate {kind} IDs")
        if len(keys) != len(set(keys)):
            errors.append(f"duplicate {kind} keys")

    manifest_path = app_root / "manifest.yaml"
    manifest = yaml.safe_load(manifest_path.read_text(encoding="utf-8")) if manifest_path.is_file() else {}
    manifest_ids = set(manifest.get("entityIds", []))
    actual_ids = (
        set(page_by_id)
        | set(element_by_id)
        | set(transition_by_id)
        | set(authority_contract_by_id)
    )
    actual_ids.update(item.get("id") for item in applications)
    if manifest_ids != actual_ids:
        errors.append(
            f"manifest entityIds mismatch: missing={sorted(actual_ids - manifest_ids)}, extra={sorted(manifest_ids - actual_ids)}"
        )
    actual_entries = sorted(
        path.relative_to(app_root).as_posix()
        for path in app_root.rglob("*.yaml")
        if path.name != "manifest.yaml"
    )
    if manifest.get("entries") != actual_entries:
        errors.append("manifest entries differ from the active YAML file set or are not deterministically sorted")
    if not manifest.get("graphRevision"):
        errors.append("manifest graphRevision is missing")
    if manifest.get("rootHash") != root_hash(app_root):
        errors.append("manifest rootHash differs from the active Canonical and supporting records")

    for category_name, records_for_category in (("pages", pages), ("elements", elements)):
        category = app_root / category_name
        for path in category.rglob("*.yaml"):
            depth = feature_depth(path, category)
            if depth not in (1, 2, 3):
                errors.append(f"invalid {category_name} path depth: {path}")
            record = yaml.safe_load(path.read_text(encoding="utf-8"))
            if isinstance(record, dict) and path.relative_to(category).parts[:-1] != tuple(record.get("featurePath", [])):
                errors.append(f"{category_name} file path differs from featurePath: {path}")
        for record in records_for_category:
            if not 1 <= len(record.get("featurePath", [])) <= 3:
                errors.append(f"{category_name} {record.get('key')} has invalid featurePath")
    authority_category = app_root / "authority-contracts"
    for path in (authority_category.rglob("*.yaml") if authority_category.is_dir() else []):
        depth = feature_depth(path, authority_category)
        if depth not in (1, 2, 3):
            errors.append(f"invalid authority-contracts path depth: {path}")
        record = yaml.safe_load(path.read_text(encoding="utf-8"))
        if isinstance(record, dict) and path.relative_to(authority_category).parts[:-1] != tuple(
            record.get("featurePath", [])
        ):
            errors.append(f"authority-contract file path differs from featurePath: {path}")

    for entity_tree, pattern in (
        (app_root / "pages", "*.yaml"),
        (app_root / "elements", "*.yaml"),
        (app_root / "transitions", "*.yaml"),
        (app_root / "authority-contracts", "*.yaml"),
        (app_obsidian / "页面", "*.md"),
        (app_obsidian / "元素", "*.md"),
    ):
        for directory in functional_directories_without_files(entity_tree, pattern):
            errors.append(f"empty functional directory: {directory}")

    for page in pages:
        key = page.get("key")
        if page.get("featurePath", [None])[0] == "底部导航":
            errors.append(f"Page {key} is incorrectly organized under the shared bottom navigation")
        if key in {"navigation.bottom_navigation", "app-drawer.root"}:
            errors.append(f"shared navigation state is incorrectly modeled as Page {key}")
        if not page.get("observations"):
            errors.append(f"Page {key} has no frame observation")
        observation_frames = {item.get("frameRef") for item in page.get("observations", [])}
        for state in page.get("states", []):
            missing = set(state.get("frameRefs", [])) - observation_frames
            if missing:
                errors.append(f"Page {key} state {state.get('key')} references non-observation frames: {sorted(missing)}")
        for observation in page.get("observations", []):
            frame = observation.get("frameRef")
            image = app_obsidian / "assets" / "full-pages" / f"{frame}.png"
            if not image.is_file():
                errors.append(f"Page {key} references missing full-page asset for {frame}")
        for element_ref in page.get("elementRefs", []):
            element = element_by_id.get(element_ref)
            if not element:
                errors.append(f"Page {key} references missing Element {element_ref}")
                continue
            owner = element.get("owner", {})
            is_owned = owner.get("kind") == "page" and owner.get("ref") == page.get("id")
            is_available = (
                owner.get("kind") == "application"
                and page.get("id") in element.get("availableOnPageRefs", [])
            )
            if not is_owned and not is_available:
                errors.append(f"Page {key} has non-owned Element without availability relation: {element.get('key')}")
        expected_inbound = {item["id"] for item in transitions if item.get("targetRef") == page.get("id")}
        expected_outbound = {item["id"] for item in transitions if item.get("sourceRef") == page.get("id")}
        if set(page.get("inboundTransitionRefs", [])) != expected_inbound:
            errors.append(f"Page {key} inbound Transition refs are not reciprocal")
        if set(page.get("outboundTransitionRefs", [])) != expected_outbound:
            errors.append(f"Page {key} outbound Transition refs are not reciprocal")
        expected_inbound_contracts = {
            item["id"]
            for item in authority_contracts
            if item.get("expectedTarget", {}).get("ref") == page.get("id")
        }
        expected_outbound_contracts = {
            item["id"]
            for item in authority_contracts
            if item.get("sourceSelector", {}).get("ref") == page.get("id")
        }
        if set(page.get("inboundAuthorityContractRefs", [])) != expected_inbound_contracts:
            errors.append(f"Page {key} inbound AuthorityContract refs are not reciprocal")
        if set(page.get("outboundAuthorityContractRefs", [])) != expected_outbound_contracts:
            errors.append(f"Page {key} outbound AuthorityContract refs are not reciprocal")

    children_by_parent: dict[str, list[dict[str, Any]]] = defaultdict(list)
    for child in elements:
        child_owner = child.get("owner", {})
        if child_owner.get("kind") in {"component", "shared_component"}:
            children_by_parent[child_owner.get("ref")].append(child)

    for element in elements:
        key = element.get("key")
        owner = element.get("owner", {})
        owner_kind = owner.get("kind")
        owner_ref = owner.get("ref")
        page = page_by_id.get(owner_ref) if owner_kind == "page" else None
        component = element_by_id.get(owner_ref) if owner_kind in {"component", "shared_component"} else None
        if owner_kind == "application":
            if owner_ref != application_id:
                errors.append(f"Element {key} has missing Application owner")
            if element.get("parentElementRef") is not None:
                errors.append(f"Element {key} is Application-owned but has a parent Element")
        elif owner_kind == "page":
            if not page:
                errors.append(f"Element {key} has missing Page owner")
            if element.get("parentElementRef") is not None:
                errors.append(f"Element {key} is Page-owned but has a parent Element")
        elif owner_kind in {"component", "shared_component"}:
            if not component:
                errors.append(f"Element {key} has missing component Element owner")
            elif owner_kind == "shared_component" and owner_ref in element_by_key:
                errors.append(f"Element {key} uses a key instead of the stable shared owner ID")
        else:
            errors.append(f"Element {key} has invalid owner kind {owner_kind}")
        if page:
            if element.get("featurePath") != page.get("featurePath"):
                errors.append(f"Element {key} featurePath differs from Page owner")
            if element.get("id") not in page.get("elementRefs", []):
                errors.append(f"Page owner is missing reciprocal Element reference for {key}")
            is_new_materialization = element.get("provenance", {}).get("sourceType") == "verified_legacy_midscene_evidence"
            if is_new_materialization and not element.get("label", "").startswith(page.get("label", "") + "-"):
                errors.append(f"Element {key} does not use the parent-chain label")
        if component and element.get("parentElementRef") != component.get("id"):
            errors.append(f"Element {key} component owner differs from parentElementRef")
        if component and f"parent:{component.get('id')}" not in element.get("relationshipRefs", []):
            errors.append(f"Element {key} is missing the canonical parent relationship")
        if component and owner_kind == "component":
            if element.get("featurePath") != component.get("featurePath"):
                errors.append(f"Element {key} featurePath differs from component owner")
            if not element.get("label", "").startswith(component.get("label", "") + "-"):
                errors.append(f"Element {key} does not use the component parent-chain label")
        if component and owner_kind == "shared_component":
            parent_path = component.get("featurePath", [])
            child_path = element.get("featurePath", [])
            if child_path[: len(parent_path)] != parent_path or len(child_path) > 3:
                errors.append(f"Element {key} featurePath is not a legal shared-component extension")
        terminal_kind, terminal_ref, terminal_error = terminal_owner(element, element_by_id)
        if terminal_error:
            errors.append(f"Element {key} has invalid owner chain: {terminal_error}")
        elif owner_kind == "component" and (terminal_kind != "page" or terminal_ref not in page_by_id):
            errors.append(f"Element {key} component chain does not terminate at a Page")
        elif owner_kind == "shared_component" and (
            terminal_kind != "application" or terminal_ref != application_id
        ):
            errors.append(f"Element {key} shared-component chain does not terminate at the Application")
        if f"owner:{owner_ref}" not in element.get("relationshipRefs", []):
            errors.append(f"Element {key} is missing the canonical owner relationship")
        for page_ref in element.get("availableOnPageRefs", []):
            if page_ref not in page_by_id:
                errors.append(f"Element {key} has missing available Page {page_ref}")
            elif element.get("id") not in page_by_id[page_ref].get("elementRefs", []):
                errors.append(f"Element {key} availability is not reciprocal on Page {page_by_id[page_ref].get('key')}")
        if element.get("parentElementRef") and element["parentElementRef"] not in element_by_id:
            errors.append(f"Element {key} has missing parent")
        for child_ref in element.get("childElementRefs", []):
            child = element_by_id.get(child_ref)
            if not child:
                errors.append(f"Element {key} references missing child Element {child_ref}")
                continue
            parent_scope, _, parent_scope_error = terminal_owner(element, element_by_id)
            expected_owner_kind = "component" if parent_scope == "page" else "shared_component"
            if parent_scope_error or child.get("owner") != {
                "kind": expected_owner_kind,
                "ref": element.get("id"),
            }:
                errors.append(f"Element {key} child {child.get('key')} has a non-reciprocal owner")
            if child.get("parentElementRef") != element.get("id"):
                errors.append(f"Element {key} child {child.get('key')} has a non-reciprocal parent")
            if f"child:{child_ref}" not in element.get("relationshipRefs", []):
                errors.append(f"Element {key} is missing child relationship for {child.get('key')}")
        if not element.get("relationshipRefs"):
            errors.append(f"Element {key} is orphaned")
        if not element.get("status"):
            errors.append(f"Element {key} has no canonical status")
        for contract in authority_contracts:
            if contract.get("triggerElementRef") != element.get("id"):
                continue
            expected_relation = f"authority_contract:{contract.get('id')}"
            if expected_relation not in element.get("relationshipRefs", []):
                errors.append(f"Element {key} is missing reciprocal relation {expected_relation}")
        if not element.get("observations"):
            errors.append(f"Element {key} has no source-frame observation")
        for observation in element.get("observations", []):
            locator = observation.get("locator", {})
            rect = locator.get("rect", {})
            if locator.get("status") == "failed" or any(rect.get(field) is None for field in ("left", "top", "width", "height")):
                errors.append(f"Element {key} has incomplete locator evidence")
                continue
            redbox_ref = observation.get("redboxRef", f"assets/element-redboxes/{element.get('id')}.png")
            image = app_obsidian / redbox_ref
            if not image.is_file():
                errors.append(f"Element {key} has no red-box image for {observation.get('frameRef')}")
            elif red_pixel_count(image) == 0:
                errors.append(f"Element {key} red-box image has no red annotation")

    errors.extend(validate_compositions(elements, transitions, authority_contracts))

    for parent_ref, children in children_by_parent.items():
        parent = element_by_id.get(parent_ref)
        if not parent:
            continue
        declared_children = set(parent.get("childElementRefs", []))
        for child in children:
            if child.get("id") not in declared_children:
                errors.append(
                    f"Element {parent.get('key')} is missing reverse childElementRef for {child.get('key')}"
                )
            if f"child:{child.get('id')}" not in parent.get("relationshipRefs", []):
                errors.append(
                    f"Element {parent.get('key')} is missing reverse child relationship for {child.get('key')}"
                )

    expected_page_roots = {
        "messages.root": ["消息"],
        "workbench.root": ["工作台"],
        "contacts.root": ["通讯录"],
        "news.root": ["资讯"],
    }
    page_by_key = {item.get("key"): item for item in pages}
    for key, feature_path in expected_page_roots.items():
        if key in page_by_key and page_by_key[key].get("featurePath") != feature_path:
            errors.append(f"Page {key} does not use its first-level business feature root")
    bottom_navigation = element_by_key.get("shared.bottom_navigation")
    more_trigger = element_by_key.get("shared.bottom_tab.more")
    if "shared.app_drawer" in element_by_key:
        errors.append("More drawer is duplicated as a wrapper Element instead of a More Element state")
    if not bottom_navigation or bottom_navigation.get("owner") != {"kind": "application", "ref": application_id}:
        errors.append("bottom navigation is not an Application-owned shared Element")
    if more_trigger and bottom_navigation:
        if more_trigger.get("owner") != {"kind": "shared_component", "ref": bottom_navigation.get("id")}:
            errors.append("bottom-navigation More trigger is not owned by the bottom-navigation Element")
        if not any(state.get("key") == "open" and state.get("frameRefs") for state in more_trigger.get("states", [])):
            errors.append("More drawer open presentation is not modeled directly as a More Element state")
    for key, element in element_by_key.items():
        if key.startswith("shared.app_drawer.") and more_trigger:
            if element.get("owner") != {"kind": "shared_component", "ref": more_trigger.get("id")}:
                errors.append(f"More entry {key} is not directly owned by the More shared component")

    def element_available_on_page(element: dict[str, Any], page_id: str) -> bool:
        current = element
        visited: set[str] = set()
        while current and current.get("id") not in visited:
            visited.add(current.get("id"))
            if page_id in current.get("availableOnPageRefs", []):
                return True
            owner = current.get("owner", {})
            if owner.get("kind") == "page":
                return owner.get("ref") == page_id
            if owner.get("kind") in {"component", "shared_component"}:
                current = element_by_id.get(owner.get("ref"))
                continue
            return False
        return False

    for transition in transitions:
        key = transition.get("key")
        source = page_by_id.get(transition.get("sourceRef"))
        target = page_by_id.get(transition.get("targetRef"))
        trigger = element_by_id.get(transition.get("triggerElementRef"))
        if not source:
            errors.append(f"Transition {key} has missing source Page")
        if not target:
            errors.append(f"Transition {key} has missing target Page")
        if not trigger:
            errors.append(f"Transition {key} has missing trigger Element")
        elif source and not element_available_on_page(trigger, source.get("id")):
            errors.append(f"Transition {key} trigger is not available through its source Page hierarchy")
        evidence = transition.get("evidence", {})
        if evidence.get("postcondition") != "pass" or not evidence.get("actionTraceRef"):
            errors.append(f"Transition {key} lacks a passing atomic action trace")
        for field in ("beforeFrameRef", "afterFrameRef"):
            frame = evidence.get(field)
            if not frame or not (app_obsidian / "assets" / "full-pages" / f"{frame}.png").is_file():
                errors.append(f"Transition {key} references missing {field} asset")
        if trigger and f"transition:{transition.get('id')}" not in trigger.get("relationshipRefs", []):
            errors.append(f"Transition {key} is not reciprocal on trigger Element")

    for contract in authority_contracts:
        key = contract.get("key")
        source_selector = contract.get("sourceSelector", {})
        expected_target = contract.get("expectedTarget", {})
        source = None
        source_pages: list[dict[str, Any]] = []
        if source_selector.get("kind") == "exact_page":
            source = page_by_id.get(source_selector.get("ref"))
            if source:
                source_pages = [source]
            else:
                errors.append(f"AuthorityContract {key} has an unresolved exact Page source")
        elif source_selector.get("kind") == "shared_availability":
            shared_source = element_by_id.get(source_selector.get("ref"))
            if not shared_source or shared_source.get("owner") != {
                "kind": "application",
                "ref": application_id,
            }:
                errors.append(f"AuthorityContract {key} has an unresolved shared availability source")
            else:
                source_pages = [
                    page_by_id[page_ref]
                    for page_ref in shared_source.get("availableOnPageRefs", [])
                    if page_ref in page_by_id
                ]
                if not source_pages:
                    errors.append(f"AuthorityContract {key} shared source has no available Pages")
        else:
            errors.append(f"AuthorityContract {key} has an invalid source selector kind")
        target = page_by_id.get(expected_target.get("ref"))
        trigger = element_by_id.get(contract.get("triggerElementRef"))
        if contract.get("edgeKind") != "authority_contract":
            errors.append(f"AuthorityContract {key} has invalid edgeKind")
        if expected_target.get("kind") != "page" or not target:
            errors.append(f"AuthorityContract {key} has an unresolved expected target")
        if not trigger:
            errors.append(f"AuthorityContract {key} has a missing trigger Element")
        elif any(not element_available_on_page(trigger, item.get("id")) for item in source_pages):
            errors.append(f"AuthorityContract {key} trigger is not available throughout its source scope")
        if contract.get("sourceType") != "user_context":
            errors.append(f"AuthorityContract {key} sourceType is not user_context")
        if contract.get("authorityStatus") != "authority_certified":
            errors.append(f"AuthorityContract {key} is not authority_certified")
        if contract.get("runtimeEvidenceStatus") not in {"pending", "verified", "contradicted"}:
            errors.append(f"AuthorityContract {key} has invalid runtimeEvidenceStatus")
        verified_transition_ref = contract.get("verifiedTransitionRef")
        if contract.get("runtimeEvidenceStatus") == "verified":
            transition = transition_by_id.get(verified_transition_ref)
            if not transition:
                errors.append(f"AuthorityContract {key} is verified without a closed Transition")
            elif (
                transition.get("sourceRef") not in {item.get("id") for item in source_pages}
                or transition.get("triggerElementRef") != contract.get("triggerElementRef")
                or transition.get("capability") != contract.get("capability")
                or transition.get("targetRef") != expected_target.get("ref")
            ):
                errors.append(f"AuthorityContract {key} verified Transition has different semantics")
        if contract.get("runtimeEvidenceStatus") == "contradicted" and not contract.get("defectRef"):
            errors.append(f"AuthorityContract {key} is contradicted without a product defect")
        fact = contract.get("certifiedFact", {})
        component_fact_fields = {
            "visibleLabel",
            "actionableControl",
            "labelTextActionable",
            "containerElementRef",
            "labelElementRef",
            "triggerElementRef",
        }
        if component_fact_fields & set(fact):
            missing_fact_fields = component_fact_fields - set(fact)
            if missing_fact_fields:
                errors.append(f"AuthorityContract {key} has incomplete certified component facts")
                continue
            if fact.get("labelTextActionable") is not False:
                errors.append(f"AuthorityContract {key} does not mark its visible label as non-triggering")
            container = element_by_id.get(fact.get("containerElementRef"))
            label_element = element_by_id.get(fact.get("labelElementRef"))
            certified_trigger = element_by_id.get(fact.get("triggerElementRef"))
            if not container or not label_element or not certified_trigger:
                errors.append(f"AuthorityContract {key} has an unresolved certified component structure")
            else:
                expected_children = {label_element.get("id"), certified_trigger.get("id")}
                if set(container.get("childElementRefs", [])) != expected_children:
                    errors.append(f"AuthorityContract {key} container does not own exactly its label and trigger")
                if source and container.get("owner") != {"kind": "page", "ref": source.get("id")}:
                    errors.append(f"AuthorityContract {key} container is not owned by its source Page")
                if source and container.get("id") not in source.get("elementRefs", []):
                    errors.append(f"AuthorityContract {key} source Page does not directly reference its container")
                if source and (
                    label_element.get("id") in source.get("elementRefs", [])
                    or certified_trigger.get("id") in source.get("elementRefs", [])
                ):
                    errors.append(f"AuthorityContract {key} source Page directly references a container child")
                expected_child_owner = {"kind": "component", "ref": container.get("id")}
                if (
                    label_element.get("owner") != expected_child_owner
                    or certified_trigger.get("owner") != expected_child_owner
                ):
                    errors.append(f"AuthorityContract {key} child owner does not resolve to the container")
                if label_element.get("controlType") != "text_label" or label_element.get("capabilities"):
                    errors.append(f"AuthorityContract {key} label is not a non-actionable text element")
                if label_element.get("interactionBoundary", {}).get("actionable") is not False:
                    errors.append(f"AuthorityContract {key} label is not explicitly marked non-actionable")
                if certified_trigger.get("id") != contract.get("triggerElementRef"):
                    errors.append(f"AuthorityContract {key} certified trigger differs from the contract trigger")

    page_cards = list(app_obsidian.joinpath("页面").rglob("*.md"))
    element_cards = list(app_obsidian.joinpath("元素").rglob("*.md"))
    if len(page_cards) != len(pages):
        errors.append(f"expected {len(pages)} Page cards, found {len(page_cards)}")
    if len(element_cards) != len(elements):
        errors.append(f"expected {len(elements)} Element cards, found {len(element_cards)}")
    card_ids: dict[str, list[Path]] = defaultdict(list)
    card_keys: dict[str, list[Path]] = defaultdict(list)
    for category, cards, kind in (
        (app_obsidian / "页面", page_cards, "page"),
        (app_obsidian / "元素", element_cards, "element"),
    ):
        for card in cards:
            if feature_depth(card, category) not in (1, 2, 3):
                errors.append(f"invalid {kind} card path depth: {card}")
            content = card.read_text(encoding="utf-8")
            metadata = frontmatter(content)
            if metadata.get("type") != kind:
                errors.append(f"{kind} card missing canonical frontmatter: {card}")
            card_ids[str(metadata.get("id"))].append(card)
            card_keys[str(metadata.get("key"))].append(card)
            record = page_by_id.get(metadata.get("id")) if kind == "page" else element_by_id.get(metadata.get("id"))
            if not record:
                errors.append(f"{kind} card has no canonical record: {card}")
                continue
            if kind == "page":
                frame_refs = re.findall(r"^### `([^`]+)`", content, re.MULTILINE)
                expected_frames = [item.get("frameRef") for item in record.get("observations", [])]
                if frame_refs != expected_frames:
                    errors.append(f"Page card instances differ from canonical observations: {card}")
                for frame in expected_frames:
                    if f"![[assets/full-pages/{frame}.png|640]]" not in content:
                        errors.append(f"Page card is missing full-page instance image for {frame}: {card}")
                local_contract_refs = set(record.get("inboundAuthorityContractRefs", [])) | set(
                    record.get("outboundAuthorityContractRefs", [])
                )
                for contract_ref in local_contract_refs:
                    contract = authority_contract_by_id.get(contract_ref)
                    if contract and "`authority_contract`" not in content:
                        errors.append(f"Page card does not expose AuthorityContract navigation: {card}")
            else:
                for observation in record.get("observations", []):
                    redbox_ref = observation.get("redboxRef", f"assets/element-redboxes/{record.get('id')}.png")
                    if f"![[{redbox_ref}|640]]" not in content and f"![[{redbox_ref}|480]]" not in content:
                        errors.append(f"Element card is missing red-box instance image {redbox_ref}: {card}")
                for child_ref in record.get("childElementRefs", []):
                    child = element_by_id.get(child_ref)
                    if child and child.get("label") not in content:
                        errors.append(f"Element card does not expose child Element {child.get('key')}: {card}")
                trigger_contracts = [
                    contract
                    for contract in authority_contracts
                    if contract.get("triggerElementRef") == record.get("id")
                ]
                for contract in trigger_contracts:
                    if contract.get("id") not in content:
                        errors.append(f"Element card does not expose AuthorityContract {contract.get('key')}: {card}")
                    for required_text in ("可见文字", "实际触发控件", "文字是否可触发"):
                        if required_text not in content:
                            errors.append(f"Element card lacks explicit interaction boundary {required_text}: {card}")
            for asset in re.findall(r"!\[\[(assets/[^]|]+)", content):
                if not (app_obsidian / asset).is_file():
                    errors.append(f"card references missing asset {asset}: {card}")

    for value, paths in card_ids.items():
        if value != "None" and len(paths) != 1:
            errors.append(f"duplicate Obsidian entity id {value}: {paths}")
    for value, paths in card_keys.items():
        if value != "None" and len(paths) != 1:
            errors.append(f"duplicate Obsidian entity key {value}: {paths}")

    topology_path = app_obsidian / "导航" / "导航路网索引.md"
    legacy_topology_path = app_obsidian / "导航" / "底部导航拓扑.md"
    if legacy_topology_path.exists():
        errors.append("deprecated full-edge navigation topology remains")
    if not topology_path.is_file():
        errors.append("compact navigation index is missing")
    else:
        topology_content = topology_path.read_text(encoding="utf-8")
        topology_metadata = frontmatter(topology_content)
        if topology_metadata.get("type") != "navigation-index":
            errors.append("navigation index has invalid type")
        if topology_metadata.get("route_materialization") != "on_demand":
            errors.append("navigation routes are not marked as on-demand")
        if topology_metadata.get("edge_projection") != "canonical_refs_only":
            errors.append("navigation index does not use canonical edge references")
        if topology_metadata.get("graph_revision") != manifest.get("graphRevision"):
            errors.append("navigation index Graph Revision differs from the Canonical manifest")
        if manifest.get("graphRevision") not in topology_content:
            errors.append("navigation index does not display the Canonical Graph Revision")
        if re.search(r"(?m)^-\s+.*(?:->|→).*$", topology_content):
            errors.append("navigation index duplicates atomic Transition edges")

    all_docs = list(obsidian_root.rglob("*.md")) if obsidian_root.is_dir() else []
    graph: dict[Path, set[Path]] = defaultdict(set)
    for document in all_docs:
        content = document.read_text(encoding="utf-8")
        for target in wikilink_targets(content):
            resolved = resolve_wikilink(target, document, obsidian_root)
            if not resolved:
                errors.append(f"unresolved Wikilink {target}: {document}")
            else:
                graph[document.resolve()].add(resolved)
                graph[resolved].add(document.resolve())
    for document in all_docs:
        if not graph[document.resolve()]:
            errors.append(f"orphan Obsidian document: {document}")

    for forbidden in ("页面实体", "元素实体"):
        if app_obsidian.joinpath(forbidden).exists():
            errors.append(f"deprecated active card directory remains: {forbidden}")

    historical_record_ids = set(manifest.get("legacyTransitionIds", []))
    historical_record_ids.update(manifest.get("migratedEntityIds", []))
    migration_records: list[dict[str, Any]] = []
    for record in records:
        historical_record_ids.update(
            item.get("id") for item in record.get("records", []) if isinstance(item, dict) and item.get("id")
        )
        migration_records.extend(
            item for item in record.get("migrations", []) if isinstance(item, dict)
        )
    migration_ids = {item.get("oldId") for item in migration_records}
    if set(manifest.get("migratedEntityIds", [])) != migration_ids:
        errors.append("manifest migratedEntityIds differ from the reviewed migration ledger")
    for migration in migration_records:
        if not re.fullmatch(r"user_context_\d{4}-\d{2}-\d{2}", str(migration.get("reviewedBy", ""))):
            errors.append(f"migration {migration.get('oldKey')} is not explicitly user reviewed")
        if migration.get("targetRef") not in element_by_id and migration.get("targetRef") not in page_by_id:
            errors.append(f"migration {migration.get('oldKey')} has missing target")
    preserved_ids = actual_ids | historical_record_ids
    update_candidates = sorted(root.glob("normalization/*/graph-update.yaml"))
    for update_path in update_candidates:
        update = yaml.safe_load(update_path.read_text(encoding="utf-8")) or {}
        if update.get("update", {}).get("status") == "complete" and contains_marker(
            update.get("coverage", {}), "unresolved_setting_row"
        ):
            errors.append(f"complete graph update contains unresolved_setting_row: {update_path}")
        expected = set(update.get("preservation", {}).get("existingEntityIds", []))
        missing = expected - preserved_ids
        if missing:
            errors.append(f"historical IDs missing after normalization: {sorted(missing)}")

    audit_path = app_root / "observations" / "special-follow-materialization-audit.yaml"
    audit = yaml.safe_load(audit_path.read_text(encoding="utf-8")) if audit_path.is_file() else {}
    graph_status = audit.get("status", manifest.get("status", "unknown"))
    if audit:
        scout_frames = audit.get("evidence", {}).get("aiScoutFrames", 0)
        live_frames = audit.get("evidence", {}).get("liveDualModelFrames", 0)
        if live_frames <= 0 or scout_frames < live_frames:
            errors.append("special-follow live repair lacks independently scouted frame coverage")
        if audit.get("status") == "complete" and contains_marker(audit, "unresolved_setting_row"):
            errors.append("complete materialization audit contains unresolved_setting_row")
    for coverage_path in root.glob("explorations/*/coverage.yaml"):
        coverage_record = yaml.safe_load(coverage_path.read_text(encoding="utf-8")) or {}
        if coverage_record.get("status") == "complete" and contains_marker(
            coverage_record, "unresolved_setting_row"
        ):
            errors.append(f"complete exploration coverage contains unresolved_setting_row: {coverage_path}")
    report = [
        f"root: {root}",
        f"pages: {len(pages)}",
        f"elements: {len(elements)}",
        f"transitions: {len(transitions)}",
        f"authorityContracts: {len(authority_contracts)}",
        f"obsidianDocuments: {len(all_docs)}",
        f"graphStatus: {graph_status}",
        "result: " + ("PASS" if not errors else "FAIL"),
    ]
    report.extend(f"- {item}" for item in errors)
    output = "\n".join(report) + "\n"
    if options.report:
        options.report.parent.mkdir(parents=True, exist_ok=True)
        options.report.write_text(output, encoding="utf-8")
    print(output, end="")
    if errors:
        sys.exit(1)


if __name__ == "__main__":
    main()
