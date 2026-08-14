#!/usr/bin/env python3
"""Legacy one-time normalizer for the superseded first-level UIKG layout.

Do not run this against the active graph. The current model treats bottom
navigation as an Application-owned shared Element, treats More as an Element
state, and organizes business Pages by their own feature roots. Use
materialize_special_follow_graph.py instead.
"""

from __future__ import annotations

import argparse
import hashlib
import json
import shutil
from collections import defaultdict
from datetime import datetime, timezone
from pathlib import Path

import yaml
from PIL import Image, ImageDraw


SCRIPT_DIR = Path(__file__).resolve().parent
GRAPH_ROOT = SCRIPT_DIR.parent
APP_KEY = "zto.connect"
SESSION_ID = "01KY6YECXXQRGNZC5S1MWPRYCX"
EXPLORATION_ID = "zto-connect-fat-first-level-normalization-20260728"
STAGE_ROOT = GRAPH_ROOT / ".staging" / EXPLORATION_ID
SOURCE_APP_ROOT = GRAPH_ROOT / "apps" / APP_KEY
SOURCE_OBSIDIAN_ROOT = GRAPH_ROOT / "obsidian" / APP_KEY
RUNTIME_ROOT = GRAPH_ROOT / "runtime" / APP_KEY / SESSION_ID
RESOURCE_INDEX = (
    GRAPH_ROOT
    / "explorations"
    / "zto-connect-fat-8.58.0-first-level-20260723"
    / "resources"
    / "index.jsonl"
)

PAGE_FEATURES = {
    "workbench.root": ["底部导航", "工作台"],
    "messages.root": ["底部导航", "消息"],
    "contacts.root": ["底部导航", "通讯录"],
    "news.root": ["底部导航", "资讯"],
    "app-drawer.root": ["底部导航", "更多应用抽屉"],
}
SHARED_FEATURE = ["底部导航"]
DRAWER_FEATURE = ["底部导航", "更多应用抽屉"]


def args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--publish", action="store_true", help="archive the legacy projection and publish the staged layout")
    return parser.parse_args()


def read_yaml_documents(path: Path) -> list[dict]:
    return [item for item in yaml.safe_load_all(path.read_text(encoding="utf-8")) if isinstance(item, dict)]


def load_records(root: Path) -> list[dict]:
    records: list[dict] = []
    for path in sorted(root.rglob("*.yaml")):
        if path.name == "manifest.yaml":
            continue
        records.extend(read_yaml_documents(path))
    return records


def sha256_bytes(value: bytes) -> str:
    return hashlib.sha256(value).hexdigest()


def canonical_json(value: object) -> str:
    return json.dumps(value, ensure_ascii=False, sort_keys=True, separators=(",", ":"))


def legacy_source_app_root() -> Path:
    active_application = SOURCE_APP_ROOT / "application.yaml"
    if active_application.is_file() and yaml.safe_load(active_application.read_text(encoding="utf-8")).get("schemaVersion") != "3.0.0":
        return SOURCE_APP_ROOT
    archived = GRAPH_ROOT / "legacy" / "uikg-v2-first-level-20260728" / "apps" / APP_KEY
    if archived.is_dir():
        return archived
    raise RuntimeError("The UIKG 2.0 source graph is unavailable")


def legacy_source_obsidian_root() -> Path:
    active_index = SOURCE_OBSIDIAN_ROOT / "中通宝盒-知识图谱首页.md"
    if active_index.is_file() and "页面实体" in active_index.read_text(encoding="utf-8"):
        return SOURCE_OBSIDIAN_ROOT
    archived = GRAPH_ROOT / "legacy" / "uikg-v2-first-level-20260728" / "obsidian" / APP_KEY
    if archived.is_dir():
        return archived
    raise RuntimeError("The UIKG 2.0 Obsidian projection is unavailable")


def tree_baseline(*roots: Path) -> dict:
    entries = []
    for root in roots:
        for path in sorted(candidate for candidate in root.rglob("*") if candidate.is_file() and candidate.name != ".DS_Store"):
            entries.append({"path": f"{root.name}/{path.relative_to(root).as_posix()}", "sha256": sha256_bytes(path.read_bytes())})
    return {"fileCount": len(entries), "contentHash": "sha256:" + sha256_bytes(canonical_json(entries).encode("utf-8"))}


def dump_yaml(value: object) -> str:
    return yaml.safe_dump(value, allow_unicode=True, sort_keys=False, width=120)


def write_yaml(path: Path, value: object) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(dump_yaml(value), encoding="utf-8")


def write_text(path: Path, value: str) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(value.rstrip() + "\n", encoding="utf-8")


def relative_png(resource_ref: str, resources: dict[str, dict]) -> Path:
    resource = resources[resource_ref]
    return RESOURCE_INDEX.parent.parent / resource["uri"]


def markdown_link(path: str, label: str) -> str:
    return f"[[{path[:-3]}|{label}]]"


def safe_name(value: str) -> str:
    return value.replace("/", "-")


def page_card_path(page: dict) -> str:
    feature = "/".join(page["featurePath"])
    return f"页面/{feature}/{safe_name(page['label'])}.md"


def element_card_path(element: dict) -> str:
    feature = "/".join(element["featurePath"])
    return f"元素/{feature}/{safe_name(element['label'])}.md"


def rect(value: dict | None) -> dict | None:
    if not value:
        return None
    source = value.get("bbox", value)
    if not all(key in source for key in ("x", "y", "width", "height")):
        return None
    return {"left": source["x"], "top": source["y"], "width": source["width"], "height": source["height"]}


def render_red_box(source: Path, destination: Path, box: dict) -> None:
    destination.parent.mkdir(parents=True, exist_ok=True)
    with Image.open(source) as original:
        image = original.convert("RGB")
    x0 = max(0, min(image.width - 1, int(box["x"])))
    y0 = max(0, min(image.height - 1, int(box["y"])))
    x1 = max(x0 + 1, min(image.width, int(box["x"] + box["width"])))
    y1 = max(y0 + 1, min(image.height, int(box["y"] + box["height"])))
    ImageDraw.Draw(image).rectangle((x0, y0, x1 - 1, y1 - 1), outline=(255, 0, 0), width=6)
    image.save(destination, format="PNG", optimize=True)


def feature_for_element(record: dict) -> list[str]:
    return SHARED_FEATURE if record.get("scope") == "shared" else DRAWER_FEATURE


def normalized_element_label(record: dict) -> str:
    key = record["key"]
    aliases = record.get("aliases", [])
    base = aliases[0] if aliases else record["labels"]["zh-CN"].replace("导航", "").replace("入口", "")
    if key == "shared.bottom_navigation":
        return "底部导航"
    if key.startswith("shared.bottom_tab."):
        return f"底部导航-{base}"
    if key == "shared.app_drawer":
        return "底部导航-更多应用抽屉"
    return f"更多应用抽屉-{base}"


def element_owner(record: dict, page_by_id: dict[str, dict]) -> dict:
    if record.get("scope") == "shared":
        return {"kind": "shared_component", "ref": "shared.bottom_navigation"}
    page = page_by_id[record["pageRef"]]
    return {"kind": "page", "ref": page["id"], "stateKeys": ["default"]}


def make_page(record: dict, instances: list[dict], transition_refs: list[str]) -> dict:
    feature_path = PAGE_FEATURES[record["key"]]
    observations = []
    states = []
    for instance in instances:
        screenshots = instance.get("screenshotRefs", [])
        if not screenshots:
            continue
        frame = instance["layoutSnapshotRef"]
        observations.append(
            {
                "frameRef": frame,
                "observedAt": instance["observedAt"],
                "buildRef": instance["appBuild"]["buildId"],
                "deviceRef": "sha256:legacy-device-redacted",
                "viewport": {"width": 1152, "height": 2376, "orientation": "portrait"},
                "stateProperties": {
                    "selectedBottomTab": instance["state"].get("selectedBottomTab"),
                    "bottomSheet": instance["state"].get("transientState", {}).get("bottomSheet"),
                },
                "screenshotRef": screenshots[0],
                "evidenceStatus": "legacy_visual_observation_requires_dual_model_reconciliation",
            }
        )
        states.append(
            {
                "key": instance["state"]["key"],
                "summary": instance["state"].get("label", instance["state"]["key"]),
                "frameRefs": [frame],
            }
        )
    return {
        "schemaVersion": "3.0.0",
        "entityType": "Page",
        "id": record["id"],
        "key": record["key"],
        "label": record["labels"]["zh-CN"],
        "applicationRef": record["applicationRef"],
        "featurePath": feature_path,
        "surfaceType": "bottom-sheet" if record["key"] == "app-drawer.root" else "page",
        "status": "legacy_evidence_pending_reconciliation",
        "summary": record["description"]["zh-CN"],
        "states": states or [{"key": "default", "summary": "历史默认状态", "frameRefs": []}],
        "elementRefs": [],
        "inboundTransitionRefs": [],
        "outboundTransitionRefs": transition_refs,
        "observations": observations,
        "provenance": {
            "sourceType": "legacy_uikg_v2_import",
            "sourceEntityId": record["id"],
            "limitations": ["legacy observations include OCR-derived semantics", "no current aiScout reconciliation"],
        },
    }


def make_element(record: dict, page_by_id: dict[str, dict], instances: list[dict], legacy_transition_refs: list[str]) -> dict:
    observations = []
    for instance in instances[:1]:
        visual = instance.get("visualEvidence", {})
        geometry = instance.get("geometry", {})
        box = geometry.get("bbox", {})
        if not visual.get("sourceFrameRef") or not visual.get("fullPageScreenshotRef") or not box:
            continue
        current_rect = rect(box)
        observations.append(
            {
                "frameRef": visual["sourceFrameRef"],
                "observedAt": instance["observedAt"],
                "buildRef": instance["appBuild"]["buildId"],
                "locator": {
                    "rect": current_rect,
                    "center": [box["x"] + box["width"] / 2, box["y"] + box["height"] / 2],
                    "dpr": 1,
                    "status": "legacy_visual_annotation_not_live_locator",
                },
                "state": "visible" if instance.get("state", {}).get("visible") else "unknown",
                "stateProperties": {
                    "enabled": instance.get("state", {}).get("enabled"),
                    "selected": instance.get("state", {}).get("selected"),
                    "checked": instance.get("state", {}).get("checked"),
                },
                "dynamicValue": instance.get("content", {}).get("badge"),
                "screenshotRef": visual["fullPageScreenshotRef"],
                "evidenceStatus": "legacy_visual_observation_requires_dual_model_reconciliation",
            }
        )
    parent = record.get("parentElementRef")
    relationships = [f"parent:{parent}"] if parent else [f"owner:{element_owner(record, page_by_id)['ref']}"]
    relationships.extend(f"legacy-transition:{item}" for item in legacy_transition_refs)
    return {
        "schemaVersion": "3.0.0",
        "entityType": "Element",
        "id": record["id"],
        "key": record["key"],
        "label": normalized_element_label(record),
        "applicationRef": record["applicationRef"],
        "featurePath": feature_for_element(record),
        "owner": element_owner(record, page_by_id),
        "parentElementRef": parent,
        "controlType": "container" if record["kind"] == "container" else "menu-item",
        "role": record.get("semanticRole", "unknown"),
        "capabilities": [item["key"] for item in record.get("interactionCapabilities", [])],
        "summary": record.get("description", {}).get("zh-CN", ""),
        "relationshipRefs": relationships,
        "observations": observations,
        "coverage": "legacy_observed_pending_dual_model_reconciliation",
        "risk": "low" if record.get("criticality") != "high" else "medium",
        "provenance": {
            "sourceType": "legacy_uikg_v2_import",
            "sourceEntityId": record["id"],
            "limitations": ["legacy observations include OCR-derived semantics", "geometry is not a live locator"],
        },
    }


def write_page_card(root: Path, page: dict, page_by_id: dict[str, dict], element_by_id: dict[str, dict], legacy_by_trigger: dict[str, list[dict]]) -> None:
    instances = page["observations"]
    instance_sections = []
    for item in instances:
        image = f"assets/full-pages/{item['frameRef']}.png"
        instance_sections.append(
            f"### `{item['frameRef']}`\n\n![[{image}|640]]\n\n"
            "| 时间 | 构建 | 视口 | 状态 |\n| --- | --- | --- | --- |\n"
            f"| {item['observedAt']} | `{item['buildRef']}` | {item['viewport']['width']}x{item['viewport']['height']} | `{item['stateProperties']}` |"
        )
    elements = [item for item in element_by_id.values() if item["owner"].get("ref") == page["id"]]
    if page["key"] != "app-drawer.root":
        elements.extend(item for item in element_by_id.values() if item["owner"].get("kind") == "shared_component")
    element_rows = []
    for item in sorted({entry["id"]: entry for entry in elements}.values(), key=lambda entry: entry["key"]):
        element_rows.append(f"| {markdown_link(element_card_path(item), item['label'])} | {item['controlType']} | {', '.join(item['capabilities']) or '仅观察'} |")
    legacy_rows = []
    for item in legacy_by_trigger.values():
        for transition in item:
            if transition["targetPageRef"] == page["id"]:
                legacy_rows.append(f"- 历史导航 `{transition['key']}` 通过 {transition['triggerElementRef']} 指向本页；未保留原子 source/before/after，待复核。")
    body = f"""---
type: page
id: {page['id']}
key: {page['key']}
application: [[中通宝盒-知识图谱首页]]
feature_path: {json.dumps(page['featurePath'], ensure_ascii=False)}
status: {page['status']}
---

# {page['label']}

{page['summary']}

## 页面实例

{chr(10).join(instance_sections) or '无可用历史截图。'}

## 元素

| 元素 | 类型 | 能力 |
| --- | --- | --- |
{chr(10).join(element_rows) or '| 无 | - | - |'}

## 导航关系

{chr(10).join(legacy_rows) or '- 本页没有已闭合的当前 Transition。'}

## 边界与待确认

- 该卡片由 UIKG 2.0 历史数据迁入；原始观测包含 OCR 语义，尚未经过本技能要求的 Scout/GPT 对账。
"""
    write_text(root / page_card_path(page), body)


def write_element_card(root: Path, element: dict, page_by_id: dict[str, dict], element_by_id: dict[str, dict]) -> None:
    owner = element["owner"]
    if owner["kind"] == "page":
        owner_label = page_by_id[owner["ref"]]["label"]
        owner_link = markdown_link(page_card_path(page_by_id[owner["ref"]]), owner_label)
    else:
        owner_link = markdown_link(element_card_path(element_by_id["01KY6Z7BD84VK4BNARMMSEET0K"]), "底部导航")
    if element["parentElementRef"]:
        parent = element_by_id[element["parentElementRef"]]
        parent_line = markdown_link(element_card_path(parent), parent["label"])
    else:
        parent_line = "无"
    observation = element["observations"][0] if element["observations"] else None
    image = f"assets/element-redboxes/{element['id']}.png"
    instance = "无可用历史定位记录。"
    if observation:
        box = observation["locator"]["rect"]
        instance = (
            f"![[{image}|480]]\n\n| 时间 | 构建 | Frame | rect | center/dpr | 控件状态 | 动态值 |\n"
            "| --- | --- | --- | --- | --- | --- | --- |\n"
            f"| {observation['observedAt']} | `{observation['buildRef']}` | `{observation['frameRef']}` | "
            f"`{box['left']},{box['top']},{box['width']},{box['height']}` | `{observation['locator']['center']} / 1` | "
            f"`{observation['state']}` | `{observation['dynamicValue']}` |"
        )
    body = f"""---
type: element
id: {element['id']}
key: {element['key']}
application: [[中通宝盒-知识图谱首页]]
feature_path: {json.dumps(element['featurePath'], ensure_ascii=False)}
status: {element['coverage']}
---

# {element['label']}

{element['summary']}

## 归属与关系

- Owner: {owner_link}
- 父容器: {parent_line}
- 关系: `{', '.join(element['relationshipRefs'])}`

## 能力与状态

| 类型 | 语义角色 | 能力 | 风险 | 覆盖 |
| --- | --- | --- | --- | --- |
| {element['controlType']} | `{element['role']}` | {', '.join(element['capabilities']) or '仅观察'} | {element['risk']} | {element['coverage']} |

## 元素实例

{instance}

## 来源

- 历史视觉观测已保留，但其 OCR 语义与定位均须在当前帧经 `aiScout`、`aiQuery` 和 `aiLocate` 复核后才能用于动作。
"""
    write_text(root / element_card_path(element), body)


def stage() -> dict:
    if STAGE_ROOT.exists():
        shutil.rmtree(STAGE_ROOT)
    stage_app = STAGE_ROOT / "apps" / APP_KEY
    stage_obsidian = STAGE_ROOT / "obsidian" / APP_KEY
    legacy_app_root = legacy_source_app_root()
    legacy_obsidian_root = legacy_source_obsidian_root()
    baseline_tree = tree_baseline(legacy_app_root, legacy_obsidian_root)
    source_records = load_records(legacy_app_root)
    pages_legacy = [item for item in source_records if item.get("entityType") == "Page"]
    elements_legacy = [item for item in source_records if item.get("entityType") == "Element"]
    transitions_legacy = [item for item in source_records if item.get("entityType") == "Transition"]
    application = next(item for item in source_records if item.get("entityType") == "Application")
    page_instances = [item for item in read_yaml_documents(RUNTIME_ROOT / "page-instances.yaml") if item.get("entityType") == "PageInstance"]
    element_instances = [item for item in read_yaml_documents(RUNTIME_ROOT / "element-instances.yaml") if item.get("entityType") == "ElementInstance"]
    resources = {f"sha256:{item['sha256']}": item for item in (json.loads(line) for line in RESOURCE_INDEX.read_text(encoding="utf-8").splitlines() if line.strip())}
    page_instances_by_ref: dict[str, list[dict]] = defaultdict(list)
    for item in page_instances:
        page_instances_by_ref[item["pageRef"]].append(item)
    element_instances_by_ref: dict[str, list[dict]] = defaultdict(list)
    for item in element_instances:
        element_instances_by_ref[item["elementRef"]].append(item)
    page_by_id_legacy = {item["id"]: item for item in pages_legacy}
    legacy_by_trigger: dict[str, list[dict]] = defaultdict(list)
    for item in transitions_legacy:
        target = item["outcomes"][0]["toState"]["pageRef"]
        legacy_by_trigger[item["trigger"]["elementRef"]].append(
            {
                "id": item["id"],
                "key": item["key"],
                "triggerElementRef": item["trigger"]["elementRef"],
                "targetPageRef": target,
                "legacySourceSelector": item["sourceSelector"],
                "legacyObservationRefs": item.get("observationRefs", []),
                "importStatus": "unresolved_legacy_generic_source_without_closed_before_after_evidence",
            }
        )
    pages = [
        make_page(item, page_instances_by_ref[item["id"]], [])
        for item in sorted(pages_legacy, key=lambda item: item["key"])
    ]
    page_by_id = {item["id"]: item for item in pages}
    elements = [
        make_element(item, page_by_id_legacy, element_instances_by_ref[item["id"]], [entry["id"] for entry in legacy_by_trigger[item["id"]]])
        for item in sorted(elements_legacy, key=lambda item: item["key"])
    ]
    element_by_id = {item["id"]: item for item in elements}
    primary_page_ids = [page["id"] for page in pages if page["key"] != "app-drawer.root"]
    for element in elements:
        if element["owner"]["kind"] == "shared_component":
            element["availableOnPageRefs"] = primary_page_ids
    for page in pages:
        page["elementRefs"] = sorted(
            item["id"]
            for item in elements
            if item["owner"].get("ref") == page["id"] or page["id"] in item.get("availableOnPageRefs", [])
        )
    application_record = {
        "schemaVersion": "3.0.0",
        "entityType": "Application",
        "id": application["id"],
        "key": application["key"],
        "label": application["labels"]["zh-CN"],
        "packageId": "com.zto.connect.fat",
        "platform": "android",
        "status": "active",
        "provenance": {"sourceType": "legacy_uikg_v2_import", "sourceEntityId": application["id"]},
    }
    write_yaml(stage_app / "application.yaml", application_record)
    for page in pages:
        path = stage_app / "pages" / Path(*page["featurePath"]) / f"{page['key']}.yaml"
        write_yaml(path, page)
    for element in elements:
        path = stage_app / "elements" / Path(*element["featurePath"]) / f"{element['key']}.yaml"
        write_yaml(path, element)
    legacy_transitions = [entry for entries in legacy_by_trigger.values() for entry in entries]
    write_yaml(
        stage_app / "observations" / "legacy-first-level-navigation.yaml",
        {
            "schemaVersion": "3.0.0",
            "recordType": "LegacyTransitionLedger",
            "status": "requires_current_frame_reconciliation",
            "reason": "UIKG 2.0 generic navigation-scope transitions cannot be represented as closed Page/state atomic edges without fabricating source or before/after evidence.",
            "records": legacy_transitions,
        },
    )
    for page in pages:
        for observation in page["observations"]:
            source = relative_png(observation["screenshotRef"], resources)
            destination = stage_obsidian / "assets" / "full-pages" / f"{observation['frameRef']}.png"
            destination.parent.mkdir(parents=True, exist_ok=True)
            shutil.copyfile(source, destination)
    for element in elements:
        if not element["observations"]:
            continue
        observation = element["observations"][0]
        source = relative_png(observation["screenshotRef"], resources)
        rectangle = observation["locator"]["rect"]
        render_red_box(source, stage_obsidian / "assets" / "element-redboxes" / f"{element['id']}.png", {"x": rectangle["left"], "y": rectangle["top"], "width": rectangle["width"], "height": rectangle["height"]})
    for page in pages:
        write_page_card(stage_obsidian, page, page_by_id, element_by_id, legacy_by_trigger)
    for element in elements:
        write_element_card(stage_obsidian, element, page_by_id, element_by_id)
    index = f"""---
type: application-index
id: {application['id']}
key: {application['key']}
status: partially-normalized
---

# 中通宝盒知识图谱

当前已规范化底部导航范围：{', '.join(markdown_link(page_card_path(page), page['label']) for page in pages)}。

## 共享组件

{chr(10).join(f'- {markdown_link(element_card_path(element), element["label"])}' for element in elements if element['owner']['kind'] == 'shared_component')}

## 证据状态

- 当前稳定实体来自 UIKG 2.0 历史记录；页面和元素实例已并入统一卡片。
- 5 条历史泛化导航声明保留在 `observations/legacy-first-level-navigation.yaml`，尚未产生符合当前规范的原子 Transition。
- “特别关注”递归探索仍是未物化证据，未被加入此索引。
"""
    write_text(stage_obsidian / "中通宝盒-知识图谱首页.md", index)
    topology = """---
type: navigation-topology
status: unresolved-legacy-import
---

# 底部导航拓扑

现有历史记录保留 5 条由共享导航作用域声明的动作，但缺少每条边的具体来源 Page/state 和可闭合 before/after 证据。为避免伪造成功 Transition，本版本只保留待复核账本，不把它们视为当前原子导航边。

## 待复核关系

| 历史关系 | 触发元素 | 目标页面 | 状态 |
| --- | --- | --- | --- |
""" + "\n".join(
        f"| `{item['key']}` | `{item['triggerElementRef']}` | `{item['targetPageRef']}` | 待当前帧复核 |" for item in legacy_transitions
    )
    write_text(stage_obsidian / "导航" / "底部导航拓扑.md", topology)
    baseline_ids = sorted(item["id"] for item in [application, *pages_legacy, *elements_legacy, *transitions_legacy])
    timestamp = datetime.now(timezone.utc).replace(microsecond=0).isoformat().replace("+00:00", "Z")
    scope = {
        "task": {"id": EXPLORATION_ID, "requestedAt": timestamp, "objective": "使用 explore-app-ui-graph 技能重新规范现有的知识图谱"},
        "application": {"key": APP_KEY, "packageId": "com.zto.connect.fat", "build": {"environment": "test", "versionName": "8.58.0.10542", "versionCode": "10542"}},
        "entry": {"description": "existing first-level graph", "knownFacts": ["Only published first-level canonical entities are normalized.", "Special-follow records remain unmaterialized evidence."]},
        "scope": {"mode": "normalization_only", "deviceActions": "none", "reason": "No new UI exploration was requested; this migration must not fabricate dual-model evidence."},
        "graph": {"root": str(GRAPH_ROOT), "mergePolicy": "additive-upsert", "preserveHistoricalEntities": True, "stageBeforePublish": True, "baseline": {**baseline_tree, "entityIdsHash": "sha256:" + sha256_bytes(canonical_json(baseline_ids).encode()), "protectedSharedNavigationRefs": ["01KY6Z7BD84VK4BNARMMSEET0K", "01KY9E733GCWPPT489SF5YPP3B"]}},
        "completion": {"status": "incomplete", "reason": "Legacy first-level evidence was normalized, but it has not undergone fresh Scout/GPT reconciliation and atomic transition closure."},
    }
    normalization_root = STAGE_ROOT / "normalization" / EXPLORATION_ID
    write_yaml(normalization_root / "scope.yaml", scope)
    write_yaml(normalization_root / "graph-update.yaml", {"update": {"explorationRef": EXPLORATION_ID, "mergePolicy": "additive-upsert", "deletions": []}, "preservation": {"existingEntityIds": baseline_ids, "legacyTransitionIds": [item["id"] for item in legacy_transitions]}, "counts": {"pages": len(pages), "elements": len(elements), "legacyTransitions": len(legacy_transitions)}})
    write_text(normalization_root / "report.md", f"""# 规范化报告

本次仅重构已发布底部导航图谱，未连接设备、未执行 UI 动作。

- 基线包含 {baseline_tree['fileCount']} 个已发布文件，内容哈希为 `{baseline_tree['contentHash']}`。
- 保留 Application、{len(pages)} 个 Page、{len(elements)} 个 Element 和 {len(legacy_transitions)} 个历史 Transition ID。
- Page 与 Element 已按 2 级 `featurePath` 归档；Obsidian 已收敛为统一 Page/Element 卡片。
- 旧证据使用 OCR 和泛化 navigation scope，不能通过本技能的双模型与原子边门禁，因此仍为 `incomplete`。
""")
    write_yaml(
        normalization_root / "query-results.yaml",
        {
            "queries": [
                {
                    "name": "verified_atomic_transitions",
                    "filter": "entityType=Transition AND evidenceStatus=executed_verified",
                    "resultCount": 0,
                    "reason": "No legacy generic navigation declaration is upgraded to a closed atomic Transition.",
                },
                {
                    "name": "preserved_legacy_navigation",
                    "filter": "recordType=LegacyTransitionLedger",
                    "resultCount": len(legacy_transitions),
                    "ids": [item["id"] for item in legacy_transitions],
                },
                {
                    "name": "normalized_canonical_entities",
                    "filter": "entityType in (Page, Element)",
                    "resultCount": len(pages) + len(elements),
                    "breakdown": {"pages": len(pages), "elements": len(elements)},
                },
            ]
        },
    )
    manifest_records = [application_record, *pages, *elements]
    manifest = {"schemaVersion": "3.0.0", "manifestType": "NormalizedUiKnowledgeGraph", "applicationRef": application["id"], "generatedAt": timestamp, "entries": sorted(str(path.relative_to(stage_app)) for path in stage_app.rglob("*.yaml") if path.name != "manifest.yaml"), "entityIds": sorted(item["id"] for item in manifest_records), "legacyTransitionIds": sorted(item["id"] for item in legacy_transitions)}
    manifest["contentHash"] = "sha256:" + sha256_bytes(canonical_json(manifest).encode())
    write_yaml(stage_app / "manifest.yaml", manifest)
    return {"pages": pages, "elements": elements, "legacy_transitions": legacy_transitions, "baseline_ids": baseline_ids}


def publish() -> None:
    if (SOURCE_APP_ROOT / "application.yaml").is_file() and yaml.safe_load((SOURCE_APP_ROOT / "application.yaml").read_text(encoding="utf-8")).get("schemaVersion") == "3.0.0":
        rollback_root = GRAPH_ROOT / ".rollback" / "normalization-before-bottom-navigation-layout-20260728"
        if rollback_root.exists():
            raise RuntimeError(f"Refusing to overwrite existing rollback: {rollback_root}")
        (rollback_root / "apps").mkdir(parents=True)
        (rollback_root / "obsidian").mkdir(parents=True)
        shutil.move(str(SOURCE_APP_ROOT), str(rollback_root / "apps" / APP_KEY))
        shutil.move(str(SOURCE_OBSIDIAN_ROOT), str(rollback_root / "obsidian" / APP_KEY))
        shutil.copytree(STAGE_ROOT / "apps" / APP_KEY, SOURCE_APP_ROOT)
        shutil.copytree(STAGE_ROOT / "obsidian" / APP_KEY, SOURCE_OBSIDIAN_ROOT)
        return
    legacy_root = GRAPH_ROOT / "legacy" / "uikg-v2-first-level-20260728"
    if legacy_root.exists():
        raise RuntimeError(f"Refusing to overwrite existing archive: {legacy_root}")
    (legacy_root / "apps").mkdir(parents=True)
    (legacy_root / "obsidian").mkdir(parents=True)
    shutil.move(str(SOURCE_APP_ROOT), str(legacy_root / "apps" / APP_KEY))
    shutil.move(str(SOURCE_OBSIDIAN_ROOT), str(legacy_root / "obsidian" / APP_KEY))
    shutil.copytree(STAGE_ROOT / "apps" / APP_KEY, SOURCE_APP_ROOT)
    shutil.copytree(STAGE_ROOT / "obsidian" / APP_KEY, SOURCE_OBSIDIAN_ROOT)
    destination = GRAPH_ROOT / "normalization" / EXPLORATION_ID
    if destination.exists():
        raise RuntimeError(f"Refusing to overwrite existing normalization report: {destination}")
    shutil.copytree(STAGE_ROOT / "normalization" / EXPLORATION_ID, destination)


def main() -> None:
    raise RuntimeError(
        "This legacy normalizer uses the retired bottom-navigation Page model; "
        "use materialize_special_follow_graph.py."
    )
    options = args()
    summary = stage()
    print(json.dumps({"stage": str(STAGE_ROOT), "pages": len(summary["pages"]), "elements": len(summary["elements"]), "legacyTransitions": len(summary["legacy_transitions"])}, ensure_ascii=False))
    if options.publish:
        publish()
        print(json.dumps({"published": True, "appRoot": str(SOURCE_APP_ROOT), "obsidianRoot": str(SOURCE_OBSIDAN_ROOT) if False else str(SOURCE_OBSIDIAN_ROOT)}, ensure_ascii=False))


if __name__ == "__main__":
    main()
