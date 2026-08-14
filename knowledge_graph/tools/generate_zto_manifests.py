#!/usr/bin/env python3
"""Rebuild the UIKG 2.0 manifests for the first-level ZTO Connect graph.

The manifests are derived indexes. They deliberately exclude immutable raw
exploration evidence and never create a separate application-version node.
"""

from __future__ import annotations

import argparse
import hashlib
import json
import sys
from pathlib import Path
from typing import Optional

import yaml

sys.dont_write_bytecode = True
import generate_zto_entity_annotations as entity_annotations


SCRIPT_DIR = Path(__file__).resolve().parent
GRAPH_ROOT = SCRIPT_DIR.parent
APP_ROOT = GRAPH_ROOT / "apps" / "zto.connect"
RUNTIME_ROOT = GRAPH_ROOT / "runtime" / "zto.connect" / "01KY6YECXXQRGNZC5S1MWPRYCX"
PROJECTION_ROOT = GRAPH_ROOT / "obsidian" / "zto.connect"
RESOURCE_INDEX = (
    GRAPH_ROOT
    / "explorations"
    / "zto-connect-fat-8.58.0-first-level-20260723"
    / "resources"
    / "index.jsonl"
)

GRAPH_REVISION = "01KY9548Z070C4WJ7CTRYZRSTH"
PARENT_REVISION = "01KY6Z7BD8DDACZNXSHMRNPPYP"
SESSION_REF = "01KY6YECXXQRGNZC5S1MWPRYCX"
GENERATED_AT = "2026-07-24T05:12:04Z"


def parse_args():
    parser = argparse.ArgumentParser(description="Generate UIKG 2.0 manifests")
    parser.add_argument(
        "--check",
        action="store_true",
        help="Fail when checked-in manifests differ from their derived form",
    )
    return parser.parse_args()


def read_yaml(path: Path):
    return yaml.safe_load(path.read_text(encoding="utf-8"))


def yaml_document_count(path: Path) -> int:
    return sum(
        document is not None
        for document in yaml.safe_load_all(path.read_text(encoding="utf-8"))
    )


def yaml_records(root: Path) -> list[dict]:
    records = []
    for path in sorted(root.rglob("*.yaml")):
        if path.name == "manifest.yaml":
            continue
        records.extend(
            document
            for document in yaml.safe_load_all(path.read_text(encoding="utf-8"))
            if isinstance(document, dict)
        )
    return records


def sha256(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as source:
        for chunk in iter(lambda: source.read(1024 * 1024), b""):
            digest.update(chunk)
    return digest.hexdigest()


def relative_path(path: Path, root: Path) -> str:
    return path.relative_to(root).as_posix()


def yaml_entries(root: Path) -> list[dict]:
    paths = sorted(path for path in root.rglob("*.yaml") if path.name != "manifest.yaml")
    return [
        {
            "path": relative_path(path, root),
            "mediaType": "application/yaml",
            "byteLength": path.stat().st_size,
            "sha256": sha256(path),
            "entityCount": yaml_document_count(path),
        }
        for path in paths
    ]


def evidence_resources() -> list[dict]:
    records = []
    for line in RESOURCE_INDEX.read_text(encoding="utf-8").splitlines():
        if not line.strip():
            continue
        record = json.loads(line)
        records.append(
            {
                "sha256": record["sha256"],
                "byteLength": record["byteLength"],
                "mediaType": record["mediaType"],
            }
        )
    return sorted(records, key=lambda item: item["sha256"])


def descriptor_root_hash(entries: list[dict], resources: list[dict]) -> str:
    lines = [
        f"entry:{item['path']}:{item['sha256'].lower()}\n".encode("utf-8")
        for item in entries
    ]
    lines.extend(
        (
            f"resource:{item['sha256'].lower()}:{item['byteLength']}:"
            f"{item['mediaType']}\n"
        ).encode("utf-8")
        for item in resources
    )
    return f"sha256:{hashlib.sha256(b''.join(sorted(lines))).hexdigest()}"


def dump_yaml(value: dict) -> str:
    return yaml.safe_dump(
        value,
        allow_unicode=True,
        sort_keys=False,
        width=120,
    )


def canonical_manifest(application: dict) -> dict:
    entries = yaml_entries(APP_ROOT)
    resources = evidence_resources()
    return {
        "schemaVersion": "2.0.0",
        "manifestType": "CanonicalGraphManifest",
        "manifestVersion": 2,
        "repositoryId": "uikg-repo-main",
        "applicationRef": application["id"],
        "graphRevision": GRAPH_REVISION,
        "parentRevision": PARENT_REVISION,
        "createdAt": GENERATED_AT,
        "createdBy": "service:uikg-first-level-projector",
        "entries": entries,
        "resources": resources,
        "rootHash": descriptor_root_hash(entries, resources),
        "hashAlgorithm": "sha256(sorted-entry-and-resource-descriptors-v1)",
        "signature": None,
    }


def runtime_manifest(application: dict, app_build: dict) -> dict:
    entries = yaml_entries(RUNTIME_ROOT)
    resources = evidence_resources()
    return {
        "schemaVersion": "2.0.0",
        "manifestType": "RuntimeCaptureManifest",
        "manifestVersion": 2,
        "repositoryId": "uikg-repo-main",
        "applicationRef": application["id"],
        "captureSessionRef": SESSION_REF,
        "appBuild": app_build,
        "graphRevision": GRAPH_REVISION,
        "createdAt": GENERATED_AT,
        "createdBy": "service:uikg-first-level-projector",
        "sourceEvidenceManifestRef": "sha256:4963e2b9ec238bb4a3abb99566a7e04e23d0d76bc98e49ed08fae6b1ef0c7efb",
        "entries": entries,
        "resources": resources,
        "rootHash": descriptor_root_hash(entries, resources),
        "hashAlgorithm": "sha256(sorted-entry-and-resource-descriptors-v1)",
        "signature": None,
    }


PROJECTION_FILE_KEYS = (
    "index",
    "applications",
    "pages",
    "pageInstances",
    "elements",
    "elementPresentationGroups",
    "navigationTopologies",
    "observations",
    "coverage",
    "devices",
)

PROJECTION_TYPE_TO_FILE_KEY = {
    "UIKG-Projection-Index": "index",
    "Application": "applications",
    "Page": "pages",
    "PageInstance": "pageInstances",
    "Element": "elements",
    "ElementPresentationGroup": "elementPresentationGroups",
    "NavigationTopology": "navigationTopologies",
    "Observation": "observations",
    "ExplorationCoverage": "coverage",
    "DeviceSnapshot": "devices",
}


def markdown_frontmatter_type(path: Path) -> Optional[str]:
    source = path.read_text(encoding="utf-8")
    if not source.startswith("---\n"):
        return None
    closing = source.find("\n---\n", 4)
    if closing < 0:
        return None
    frontmatter = yaml.safe_load(source[4:closing])
    if not isinstance(frontmatter, dict):
        return None
    note_type = frontmatter.get("type")
    return note_type if isinstance(note_type, str) else None


def projection_files() -> dict[str, list[str]]:
    files = {key: [] for key in PROJECTION_FILE_KEYS}
    for path in sorted(PROJECTION_ROOT.rglob("*.md")):
        note_type = markdown_frontmatter_type(path)
        key = PROJECTION_TYPE_TO_FILE_KEY.get(note_type)
        if key is None:
            raise ValueError(
                f"Unsupported or legacy projection note type {note_type!r}: {path}"
            )
        files[key].append(relative_path(path, PROJECTION_ROOT))
    return files


def projection_manifest(application: dict, app_build: dict, canonical: dict) -> dict:
    canonical_records = yaml_records(APP_ROOT)
    runtime_records = yaml_records(RUNTIME_ROOT)
    canonical_type_counts: dict[str, int] = {}
    for record in canonical_records:
        entity_type = record.get("entityType") or record.get("recordType")
        if isinstance(entity_type, str):
            canonical_type_counts[entity_type] = canonical_type_counts.get(entity_type, 0) + 1
    runtime_type_counts: dict[str, int] = {}
    for record in runtime_records:
        entity_type = record.get("entityType") or record.get("recordType")
        if isinstance(entity_type, str):
            runtime_type_counts[entity_type] = runtime_type_counts.get(entity_type, 0) + 1

    pages = [record for record in canonical_records if record.get("entityType") == "Page"]
    page_keys = sorted(record["key"] for record in pages)
    overlay_page_keys = sorted(
        record["key"]
        for record in pages
        if record.get("pageKind") == "overlay_drawer"
    )
    primary_page_keys = sorted(set(page_keys) - set(overlay_page_keys))
    navigation_scope_refs = sorted(
        record["id"]
        for record in canonical_records
        if record.get("entityType") == "NavigationScope"
    )

    spec = json.loads(entity_annotations.SPEC_PATH.read_text(encoding="utf-8"))
    spec["items"] = entity_annotations.materialize_shared_navigation_items(spec)
    spec["elementDefinitions"] = entity_annotations.load_element_definitions()
    spec["presentationGroups"] = entity_annotations.materialize_presentation_groups(spec)
    presentation_assets, page_assets = entity_annotations.describe_existing_assets(spec)
    files = projection_files()
    all_notes = sorted(path for paths in files.values() for path in paths)
    return {
        "schemaVersion": "2.0.0",
        "manifestType": "ObsidianProjectionManifest",
        "manifestVersion": 2,
        "application": {"id": application["id"], "key": application["key"]},
        "appBuild": app_build,
        "projection": {
            "generatedBy": "uikg-manifest-generator@2.0.0",
            "generatedAt": GENERATED_AT,
            "readOnly": True,
            "vaultRoot": "../..",
            "entryPoint": "中通宝盒-知识图谱首页.md",
            "vaultRelativeEntryPoint": "obsidian/zto.connect/中通宝盒-知识图谱首页.md",
        },
        "source": {
            "canonicalManifest": "../../apps/zto.connect/manifest.yaml",
            "graphRevision": GRAPH_REVISION,
            "rootHash": canonical["rootHash"],
            "runtimeManifest": "../../runtime/zto.connect/01KY6YECXXQRGNZC5S1MWPRYCX/manifest.yaml",
            "runtimeCoverage": "../../runtime/zto.connect/01KY6YECXXQRGNZC5S1MWPRYCX/coverage.yaml",
            "runtimeDevice": "../../runtime/zto.connect/01KY6YECXXQRGNZC5S1MWPRYCX/device.yaml",
            "evidenceSessionRef": SESSION_REF,
        },
        "scope": {
            "navigationDepth": 1,
            "pageKeys": page_keys,
            "primaryPageKeys": primary_page_keys,
            "overlayPageKeys": overlay_page_keys,
            "navigationScopeRefs": navigation_scope_refs,
            "workbenchInternalElementCount": 0,
            "newsInternalElementCount": 0,
            "appDrawerEntryActivationCount": 0,
            "unknownDestinationsMaterialized": 0,
        },
        "contentPolicy": {
            "embeddedEvidenceResources": 0,
            "derivedAnnotatedScreenshotAssets": len(presentation_assets),
            "derivedPageScreenshotAssets": len(page_assets),
            "containsSensitiveScreenshots": True,
            "projectionAssetDataClassification": "confidential",
            "projectionAssetRedactionStatus": "not_applied",
            "includesPhysicalLocators": False,
            "includesPixelGeometry": True,
            "includesDynamicBusinessContent": True,
        },
        "counts": {
            "markdownNotes": len(all_notes),
            "applications": len(files["applications"]),
            "pages": len(files["pages"]),
            "pageInstances": len(files["pageInstances"]),
            "elements": len(files["elements"]),
            "elementPresentationGroups": len(files["elementPresentationGroups"]),
            "transitions": canonical_type_counts.get("Transition", 0),
            "navigationScopes": canonical_type_counts.get("NavigationScope", 0),
            "navigationTopologies": len(files["navigationTopologies"]),
            "observations": len(files["observations"]),
            "coverageRecords": len(files["coverage"]),
            "deviceSnapshots": len(files["devices"]),
            "runtimeElementInstances": runtime_type_counts.get("ElementInstance", 0),
            "elementPresentationImages": len(presentation_assets),
            "pageObservationImages": len(page_assets),
        },
        "files": files,
        "assets": {
            "elementPresentationImages": presentation_assets,
            "pageObservationImages": page_assets,
        },
    }


def expected_outputs() -> dict[Path, str]:
    application = read_yaml(APP_ROOT / "application.yaml")
    session = read_yaml(RUNTIME_ROOT / "session.yaml")
    canonical = canonical_manifest(application)
    runtime = runtime_manifest(application, session["appBuild"])
    projection = projection_manifest(application, session["appBuild"], canonical)
    return {
        APP_ROOT / "manifest.yaml": dump_yaml(canonical),
        RUNTIME_ROOT / "manifest.yaml": dump_yaml(runtime),
        PROJECTION_ROOT / "projection-manifest.json": f"{json.dumps(projection, ensure_ascii=False, indent=2)}\n",
    }


def main():
    args = parse_args()
    outputs = expected_outputs()
    if args.check:
        stale = [
            str(path.relative_to(GRAPH_ROOT))
            for path, content in outputs.items()
            if not path.is_file() or path.read_text(encoding="utf-8") != content
        ]
        if stale:
            raise SystemExit(f"Stale derived manifests: {', '.join(stale)}")
        print("Verified 3 UIKG 2.0 manifests.")
        return
    for path, content in outputs.items():
        path.write_text(content, encoding="utf-8")
    print("Generated canonical, runtime, and Obsidian UIKG 2.0 manifests.")


if __name__ == "__main__":
    main()
