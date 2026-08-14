#!/usr/bin/env python3
"""Legacy UIKG 2.0 projector retained only for historical reproducibility."""

import argparse
import copy
import datetime
import hashlib
import json
import math
import re
import shutil
from pathlib import Path

import yaml
from PIL import Image, ImageDraw


SCRIPT_DIR = Path(__file__).resolve().parent
KNOWLEDGE_GRAPH_ROOT = SCRIPT_DIR.parent
SPEC_PATH = SCRIPT_DIR / "zto_entity_annotation_spec.json"
PROJECTION_ROOT = KNOWLEDGE_GRAPH_ROOT / "obsidian" / "zto.connect"
PROJECTION_MANIFEST_PATH = PROJECTION_ROOT / "projection-manifest.json"
CANONICAL_ELEMENTS_ROOT = KNOWLEDGE_GRAPH_ROOT / "apps" / "zto.connect" / "elements"
RUNTIME_ROOT = (
    KNOWLEDGE_GRAPH_ROOT
    / "runtime"
    / "zto.connect"
    / "01KY6YECXXQRGNZC5S1MWPRYCX"
)
ELEMENT_INSTANCES_PATH = RUNTIME_ROOT / "element-instances.yaml"
PAGE_INSTANCES_PATH = RUNTIME_ROOT / "page-instances.yaml"
DEVICE_REF = "01KY6Z7BD8N3EJCKYGH73N877P"
SESSION_REF = "01KY6YECXXQRGNZC5S1MWPRYCX"
RECORDED_AT = "2026-07-24T05:12:04Z"
RECORDED_BY = "service:uikg-first-level-projector"
CROCKFORD = "0123456789ABCDEFGHJKMNPQRSTVWXYZ"


def parse_args():
    parser = argparse.ArgumentParser(
        description="Generate or verify UIKG 2.0 page and element-instance visuals"
    )
    parser.add_argument(
        "--check",
        action="store_true",
        help="Verify generated Runtime records, notes, and images without writing",
    )
    return parser.parse_args()


def read_json(path):
    return json.loads(path.read_text(encoding="utf-8"))


def read_markdown_frontmatter(path):
    text = path.read_text(encoding="utf-8")
    match = re.match(r"\A---\r?\n(.*?)\r?\n---(?:\r?\n|\Z)", text, re.DOTALL)
    if match is None:
        raise ValueError(f"Missing Markdown frontmatter: {path}")
    value = yaml.safe_load(match.group(1))
    if not isinstance(value, dict):
        raise ValueError(f"Invalid Markdown frontmatter: {path}")
    return value


def deterministic_instance_ref(frame_ref, element_ref, observed_at):
    digest = hashlib.sha256(
        f"uikg-2.0-element-instance|{frame_ref}|{element_ref}".encode("utf-8")
    ).digest()
    observed = datetime.datetime.fromisoformat(observed_at.replace("Z", "+00:00"))
    if observed.tzinfo is None:
        raise ValueError(f"ElementInstance observedAt must include a timezone: {observed_at}")
    timestamp_value = int(observed.timestamp() * 1000)
    if not 0 <= timestamp_value < 2**48:
        raise ValueError(f"ElementInstance observedAt is outside the ULID range: {observed_at}")
    timestamp = ""
    for _ in range(10):
        timestamp = CROCKFORD[timestamp_value % 32] + timestamp
        timestamp_value //= 32
    value = int.from_bytes(digest[:10], "big")
    encoded = ""
    for _ in range(16):
        encoded = CROCKFORD[value % 32] + encoded
        value //= 32
    return f"{timestamp}{encoded}"


def observation_contexts(spec):
    contexts = []
    for item in spec["pageItems"]:
        context = copy.deepcopy(item)
        context["observationRole"] = "primary"
        contexts.append(context)
    for item in spec.get("supportingObservations", []):
        context = copy.deepcopy(item)
        context["observationRole"] = "supporting"
        contexts.append(context)
    return contexts


def materialize_shared_navigation_items(spec):
    navigation = spec["sharedNavigation"]
    overrides = navigation.get("instanceRefOverrides", {})
    full_page_rect = {"x": 0, "y": 0, **spec["sourcePixelSize"]}
    materialized = []

    contexts = observation_contexts(spec)
    for page_item in contexts:
        frame_observations = navigation["frameObservations"].get(
            page_item["sourceFrameRef"]
        )
        if frame_observations is None:
            raise ValueError(
                f"Missing shared-navigation observations for {page_item['sourceFrameRef']}"
            )
        refs = {}
        for template in navigation["templates"]:
            override_key = f"{page_item['sourceFrameRef']}|{template['elementKey']}"
            refs[template["elementKey"]] = overrides.get(
                override_key,
                deterministic_instance_ref(
                    page_item["sourceFrameRef"],
                    template["elementRef"],
                    page_item["observedAt"],
                ),
            )

        container_ref = refs["shared.bottom_navigation"]
        page_context_title = page_item.get("projectionContextTitle")
        if page_context_title is None:
            page_context_title = Path(page_item["instanceNotePath"]).stem.split("--", 1)[0]
        for template in navigation["templates"]:
            instance_ref = refs[template["elementKey"]]
            title = Path(template["elementNotePath"]).stem
            tab_key = template["tabKey"]
            observation = frame_observations.get(template["elementKey"])
            if observation is None:
                raise ValueError(
                    f"Missing {template['elementKey']} observation in "
                    f"{page_item['sourceFrameRef']}"
                )
            if observation.get("geometryMatch") != "reference_exact":
                raise ValueError(
                    f"Unsupported geometry match for {template['elementKey']} in "
                    f"{page_item['sourceFrameRef']}"
                )
            bbox = observation.get("bbox")
            geometry_confidence = observation.get("geometryConfidence")
            if bbox != template["referenceBBox"]:
                raise ValueError(
                    f"Frame bbox does not match its declared reference for "
                    f"{template['elementKey']} in {page_item['sourceFrameRef']}"
                )
            if not isinstance(geometry_confidence, (int, float)) or not (
                0 <= geometry_confidence <= 1
            ):
                raise ValueError(
                    f"Missing Frame geometry confidence for {template['elementKey']} in "
                    f"{page_item['sourceFrameRef']}"
                )
            if tab_key is None:
                instance_title = f"{title}（{page_context_title}）"
            else:
                selection_label = (
                    "选中"
                    if tab_key == page_item["state"]["selectedBottomTab"]
                    else "未选中"
                )
                instance_title = (
                    f"{title}（{page_context_title}-{selection_label}）"
                )
            materialized.append(
                {
                    "outputPath": f"资源/元素实体/{instance_title}--{instance_ref}.png",
                    "sourceFrameRef": page_item["sourceFrameRef"],
                    "sourceResourceRef": page_item["sourceResourceRef"],
                    "basis": template["basis"],
                    "confidence": geometry_confidence,
                    "elementRef": template["elementRef"],
                    "elementKey": template["elementKey"],
                    "observedText": observation.get("observedText"),
                    "badge": copy.deepcopy(observation.get("badge")),
                    "contentConfidence": observation.get("contentConfidence"),
                    "badgeConfidence": observation.get("badgeConfidence"),
                    "observationMethod": observation["observationMethod"],
                    "elementInstanceRef": instance_ref,
                    "elementNotePath": template["elementNotePath"],
                    "instanceNotePath": f"元素实体/{instance_title}--{instance_ref}.md",
                    "pageInstanceRef": page_item["pageInstanceRef"],
                    "pageRef": page_item["pageRef"],
                    "pageKey": page_item["pageKey"],
                    "pageState": copy.deepcopy(page_item["state"]),
                    "observationRole": page_item["observationRole"],
                    "surfaceId": "surface.main",
                    "parentInstanceRef": None if tab_key is None else container_ref,
                    "elementState": {
                        "visible": True,
                        "selected": (
                            "unknown"
                            if tab_key is None
                            else tab_key == page_item["state"]["selectedBottomTab"]
                        ),
                        "enabled": "unknown",
                        "hittable": "unknown",
                    },
                    "presentationContextKey": (
                        f"element:{template['elementKey']}|page:{page_item['pageKey']}|"
                        f"state:{page_item['state']['key']}|"
                        f"tab:{page_item['state']['selectedBottomTab']}|"
                        f"sheet:{page_item['state']['transientState']['bottomSheet']}|"
                        f"build:{spec['appBuild']['versionCode']}|geometry:"
                        f"{spec['sourcePixelSize']['width']}x{spec['sourcePixelSize']['height']}"
                    ),
                    "bbox": copy.deepcopy(bbox),
                    "fullPageRect": full_page_rect,
                }
            )

    page_items_by_ref = {item["pageInstanceRef"]: item for item in spec["pageItems"]}
    retained_items = copy.deepcopy(spec["items"])
    for item in retained_items:
        page_item = page_items_by_ref[item["pageInstanceRef"]]
        item["pageRef"] = page_item["pageRef"]
        item["pageKey"] = page_item["pageKey"]
        item["pageState"] = copy.deepcopy(page_item["state"])
        item["observedAt"] = page_item["observedAt"]
        item["observationRole"] = "primary"
        item["presentationContextKey"] = (
            f"element:{item['elementKey']}|{page_item['presentationContextKey']}"
        )
        item.setdefault("observationMethod", "curated_screenshot_visual_annotation")
        if item.get("observedText") is not None:
            item.setdefault("contentConfidence", item["confidence"])
        if item.get("badge") is not None:
            item.setdefault("badgeConfidence", item["confidence"])
    contexts_by_frame = {item["sourceFrameRef"]: item for item in contexts}
    for item in materialized:
        page_item = contexts_by_frame[item["sourceFrameRef"]]
        item["observedAt"] = page_item["observedAt"]

    items = [*materialized, *retained_items]
    instance_refs = [item["elementInstanceRef"] for item in items]
    if len(instance_refs) != len(set(instance_refs)):
        raise ValueError("ElementInstance ids are not unique")
    return items


def presentation_signature(spec, item):
    return {
        "schemaVersion": "1.0.0",
        "elementRef": item["elementRef"],
        "kind": spec["elementDefinitions"][item["elementRef"]]["kind"],
        "state": {
            key: copy.deepcopy(item["elementState"].get(key, "unknown"))
            for key in ("visible", "selected", "enabled", "hittable")
        },
        "content": {
            "resolvedText": item.get("observedText"),
            "badge": copy.deepcopy(item.get("badge")),
        },
        "geometry": {
            "bbox": {**copy.deepcopy(item["bbox"]), "space": "screenshot_px"},
            "semantics": spec["annotation"]["geometrySemantics"],
            "basis": item["basis"],
        },
        "appBuild": copy.deepcopy(spec["appBuild"]),
        "displayContext": copy.deepcopy(spec["presentationGroupingContext"]),
    }


def presentation_group_key(spec, item):
    element_key = item["elementKey"]
    if element_key == "shared.bottom_navigation":
        variant = "default"
    elif element_key.startswith("shared.bottom_tab."):
        variant = "selected" if item["elementState"]["selected"] else "unselected"
    else:
        variant = "default"
    signature = presentation_signature(spec, item)
    canonical = canonical_json_dumps(canonical_json_value(signature))
    signature_hash = hashlib.sha256(canonical.encode("utf-8")).hexdigest()
    group_key = f"{element_key}|signature:sha256:{signature_hash}"
    return group_key, variant, signature, signature_hash


def presentation_group_ref(group_key):
    digest = group_key.rsplit(":", 1)[-1]
    return f"presentation-group:sha256:{digest}"


def presentation_group_title(item, variant):
    title = Path(item["elementNotePath"]).stem
    if item["elementKey"] == "shared.bottom_navigation":
        return f"{title}（通用呈现）"
    if item["elementKey"].startswith("shared.bottom_tab."):
        state_title = "选中态" if variant == "selected" else "未选中态"
        return f"{title}（{state_title}）"
    return f"{title}（默认呈现）"


def materialize_presentation_groups(spec):
    grouped = {}
    for item in spec["items"]:
        group_key, variant, signature, signature_hash = presentation_group_key(
            spec, item
        )
        group_ref = presentation_group_ref(group_key)
        item["presentationGroupRef"] = group_ref
        entry = grouped.setdefault(
            group_ref,
            {
                "presentationGroupRef": group_ref,
                "presentationGroupKey": group_key,
                "presentationSignature": signature,
                "presentationSignatureHash": f"sha256:{signature_hash}",
                "groupingAlgorithm": "canonical-json-sha256-v1",
                "variant": variant,
                "elementRef": item["elementRef"],
                "elementKey": item["elementKey"],
                "elementNotePath": item["elementNotePath"],
                "members": [],
            },
        )
        entry["members"].append(item)

    for group in grouped.values():
        for member in group["members"]:
            _, _, signature, signature_hash = presentation_group_key(spec, member)
            if (
                signature != group["presentationSignature"]
                or f"sha256:{signature_hash}" != group["presentationSignatureHash"]
            ):
                raise ValueError(
                    f"Presentation group {group['presentationGroupRef']} contains "
                    "a non-equivalent Runtime ElementInstance"
                )

    groups = []
    for group in grouped.values():
        group["members"].sort(
            key=lambda item: (
                item["observationRole"] != "primary",
                item["observedAt"],
                item["elementInstanceRef"],
            )
        )
        representative = group["members"][0]
        title = presentation_group_title(representative, group["variant"])
        short_hash = group["presentationGroupRef"].rsplit(":", 1)[-1][:12]
        group["title"] = title
        group["representative"] = representative
        group["instanceNotePath"] = f"元素实体/{title}--{short_hash}.md"
        group["outputPath"] = f"资源/元素实体/{title}--{short_hash}.png"
        groups.append(group)

    groups.sort(key=lambda group: (group["elementKey"], group["variant"]))
    if len(groups) != 27:
        raise ValueError(f"Expected 27 presentation groups, found {len(groups)}")
    return groups


def load_element_definitions():
    definitions = {}
    for path in sorted(CANONICAL_ELEMENTS_ROOT.glob("*.yaml")):
        for record in yaml.safe_load_all(path.read_text(encoding="utf-8")):
            if record and record.get("entityType") == "Element":
                definitions[record["id"]] = record
    return definitions


def sha256(path):
    digest = hashlib.sha256()
    with path.open("rb") as source:
        for chunk in iter(lambda: source.read(1024 * 1024), b""):
            digest.update(chunk)
    return digest.hexdigest()


def rect_edges(rect):
    return (
        rect["x"],
        rect["y"],
        rect["x"] + rect["width"],
        rect["y"] + rect["height"],
    )


def ensure_rect_inside(inner, outer, label):
    ix0, iy0, ix1, iy1 = rect_edges(inner)
    ox0, oy0, ox1, oy1 = rect_edges(outer)
    if not (ox0 <= ix0 < ix1 <= ox1 and oy0 <= iy0 < iy1 <= oy1):
        raise ValueError(f"{label} is outside the full screenshot: {inner} vs {outer}")


def center_point(bbox):
    return {
        "x": bbox["x"] + bbox["width"] / 2,
        "y": bbox["y"] + bbox["height"] / 2,
        "space": "screenshot_px",
        "derivedBy": "half_open_bbox_center",
    }


def normalized_number(value):
    return int(value) if isinstance(value, float) and value.is_integer() else value


def center_text(point):
    return f"({normalized_number(point['x'])}, {normalized_number(point['y'])})"


def bbox_text(bbox):
    return f"({bbox['x']}, {bbox['y']}, {bbox['width']}, {bbox['height']})"


def count_red_pixels(image):
    return sum(1 for pixel in image.convert("RGB").getdata() if pixel == (255, 0, 0))


def resource_map(resource_index_path):
    records = {}
    for line in resource_index_path.read_text(encoding="utf-8").splitlines():
        if line.strip():
            record = json.loads(line)
            records[record["id"]] = record
    return records


def source_path_for(resource_index_path, resource):
    exploration_root = resource_index_path.parent.parent
    return exploration_root / resource["uri"]


def rendered_annotation_rect(bbox, image_size):
    x0 = bbox["x"]
    y0 = bbox["y"]
    x1 = bbox["x"] + bbox["width"] - 1
    y1 = bbox["y"] + bbox["height"] - 1
    if x0 < 0 or y0 < 0 or x1 >= image_size[0] or y1 >= image_size[1]:
        raise ValueError(f"Cannot render bbox {bbox} inside image {image_size}")
    return {
        "x": x0,
        "y": y0,
        "width": x1 - x0 + 1,
        "height": y1 - y0 + 1,
        "space": "screenshot_px",
    }


def app_build_frontmatter(app_build):
    return (
        f"app_package: {app_build['packageId']}\n"
        f"app_version: {app_build['versionName']}\n"
        f"app_version_code: \"{app_build['versionCode']}\"\n"
        f"app_channel: {app_build['channel']}\n"
    )


def page_link(page_key):
    labels = {
        "workbench.root": "工作台",
        "messages.root": "消息",
        "contacts.root": "通讯录",
        "news.root": "资讯",
        "app-drawer.root": "更多应用抽屉",
    }
    label = labels[page_key]
    return f"[[页面/{label}|{label}]]"


def page_instance_link(spec, page_instance_ref):
    item = next(
        candidate
        for candidate in spec["pageItems"]
        if candidate["pageInstanceRef"] == page_instance_ref
    )
    path = item["instanceNotePath"][:-3]
    title = Path(item["instanceNotePath"]).stem.split("--", 1)[0]
    return f"[[{path}|{title}页面实体]]"


def primary_page_item(spec, page_instance_ref):
    return next(
        item
        for item in spec["pageItems"]
        if item["pageInstanceRef"] == page_instance_ref
    )


def page_presentation_context(item):
    if item.get("presentationContext") is not None:
        return copy.deepcopy(item["presentationContext"])
    return {
        "activePageRef": item["pageRef"],
        "primaryPageRef": item["pageRef"],
        "hostPageRef": None,
        "hostPageParticipatesInIdentity": False,
    }


def replace_generated_block(text, marker, content):
    start = f"<!-- uikg:{marker}:start -->"
    end = f"<!-- uikg:{marker}:end -->"
    block = f"{start}\n{content.rstrip()}\n{end}"
    pattern = rf"\n?{re.escape(start)}.*?{re.escape(end)}\s*"
    stripped = re.sub(pattern, "\n", text, flags=re.DOTALL).rstrip()
    return f"{stripped}\n\n{block}\n"


def element_presentation_note_text(spec, group, asset):
    item = group["representative"]
    title = Path(group["elementNotePath"]).stem
    definition = spec["elementDefinitions"][group["elementRef"]]
    bbox = item["bbox"]
    center = center_point(bbox)
    state = item["elementState"]
    observed_text = item.get("observedText")
    badge = item.get("badge")
    semantic_role = definition.get("semanticRole", "unknown")
    overall_confidence = instance_confidence(item)
    badge_description = "无"
    if badge:
        badge_description = badge["kind"]
        if badge.get("text") is not None:
            badge_description += f" `{badge['text']}`"
        badge_description += f"（语义 `{badge['semanticMeaning']}`）"
    runtime_source = "../../../runtime/zto.connect/01KY6YECXXQRGNZC5S1MWPRYCX/element-instances.yaml"
    member_instance_refs = [member["elementInstanceRef"] for member in group["members"]]
    member_frame_refs = [member["sourceFrameRef"] for member in group["members"]]
    member_rows = []
    for member in group["members"]:
        member_rows.append(
            f"| `{member['elementInstanceRef']}` | {page_link(member['pageKey'])} | "
            f"`{member['sourceFrameRef']}` | `{member['observedAt']}` |"
        )
    member_row_text = "\n".join(member_rows)
    text = (
        "---\n"
        "type: ElementPresentationGroup\n"
        f"presentation_group_ref: {group['presentationGroupRef']}\n"
        f"presentation_group_key: {group['presentationGroupKey']}\n"
        f"presentation_signature_hash: {group['presentationSignatureHash']}\n"
        f"grouping_algorithm: {group['groupingAlgorithm']}\n"
        f"presentation_signature: {json.dumps(group['presentationSignature'], ensure_ascii=False, separators=(',', ':'))}\n"
        f"presentation_variant: {group['variant']}\n"
        f"element_ref: {group['elementRef']}\n"
        f"element_key: {group['elementKey']}\n"
        f"representative_element_instance_ref: {item['elementInstanceRef']}\n"
        f"member_element_instance_refs: {json.dumps(member_instance_refs, ensure_ascii=False)}\n"
        f"member_frame_refs: {json.dumps(member_frame_refs, ensure_ascii=False)}\n"
        f"member_count: {len(group['members'])}\n"
        f"device_ref: {DEVICE_REF}\n"
        f"representative_frame_ref: {item['sourceFrameRef']}\n"
        f"representative_screenshot_ref: {item['sourceResourceRef']}\n"
        f"kind: {definition['kind']}\n"
        "visibility: visible\n"
        f"semantic_role: {semantic_role}\n"
        "semantic_role_fact_status: inferred\n"
        f"observation_method: {item['observationMethod']}\n"
        f"observed_text: {json.dumps(observed_text, ensure_ascii=False)}\n"
        f"badge: {json.dumps(badge, ensure_ascii=False)}\n"
        f"bbox: [{bbox['x']}, {bbox['y']}, {bbox['width']}, {bbox['height']}]\n"
        f"center_point: [{normalized_number(center['x'])}, {normalized_number(center['y'])}]\n"
        "coordinate_space: screenshot_px\n"
        "visual_bounds_semantics: representative_visual_bounds\n"
        f"geometry_confidence: {item['confidence']}\n"
        f"instance_confidence: {overall_confidence}\n"
        f"annotation_sha256: {asset['sha256']}\n"
        f"{app_build_frontmatter(spec['appBuild'])}"
        "read_only: true\n"
        f"runtime_source: {runtime_source}\n"
        "tags:\n"
        "  - uikg/element-presentation-group\n"
        "  - projection/presentation-equivalence\n"
        "---\n\n"
        f"# {group['title']}\n\n"
        f"这是[[{group['elementNotePath'][:-3]}|{title}]]的一个呈现等价类。"
        "Runtime 仍逐 Frame 保存 ElementInstance；本卡片只合并语义、选中状态和视觉结构等价的展示，"
        "不合并或覆盖原始观察。\n\n"
        "## 呈现组属性\n\n"
        f"- 呈现组：`{group['presentationGroupRef']}`\n"
        f"- 等价签名：`{group['presentationGroupKey']}`\n"
        f"- 签名算法：`{group['groupingAlgorithm']}`\n"
        f"- Runtime 成员数：`{len(group['members'])}`\n"
        f"- 代表 ElementInstance：`{item['elementInstanceRef']}`\n"
        f"- 应用版本：`{spec['appBuild']['versionName']}`（versionCode `{spec['appBuild']['versionCode']}`，"
        f"包名 `{spec['appBuild']['packageId']}`）\n"
        "- 设备：[[设备/华为-NOH-AN01-1152x2376|HUAWEI NOH-AN01]]\n"
        f"- 元素类型与可见性：`kind={definition['kind']}`、`visibility=visible`\n"
        f"- 实例语义角色：`{semantic_role}`（`inferred`，稳定 Element 仅作为先验）\n"
        f"- 实际可见文字：{f'`{observed_text}`' if observed_text is not None else '无直接文字'}\n"
        f"- 徽标：{badge_description}\n"
        f"- 观测方式：`{item['observationMethod']}`；实例综合置信度 `{overall_confidence}`\n"
        f"- 元素状态：`visible={str(state['visible']).lower()}`、`selected={str(state['selected']).lower()}`、"
        f"`enabled={state['enabled']}`、`hittable={state['hittable']}`\n"
        f"- bbox：`{bbox_text(bbox)}`，格式为 `(x, y, width, height)`\n"
        f"- 中心点：`{center_text(center)}`，由半开 bbox 精确派生\n"
        "- 坐标空间：`screenshot_px`，截图尺寸 `1152 x 2376`\n"
        f"- 几何语义：`representative_visual_bounds`，依据 `{item['basis']}`，置信度 `{item['confidence']}`\n"
        f"- 代表 Frame：`{item['sourceFrameRef']}`\n\n"
        "## Runtime 成员\n\n"
        "| ElementInstance | 页面 | Frame | 观察时间 |\n"
        "| --- | --- | --- | --- |\n"
        f"{member_row_text}\n\n"
        "## 代表完整页面定位图\n\n"
        f"![[{group['outputPath']}|640]]\n\n"
        f"- 标注图 SHA-256：`{asset['sha256']}`\n"
        f"- 生成器：`{asset['generator']['id']}@{asset['generator']['version']}`\n"
        f"- 数据分类：`{asset['dataClassification']}`；脱敏状态：`{asset['redaction']['status']}`\n\n"
        "> 红框来自代表 ElementInstance 的完整页面截图。组内每个 Runtime 实例仍保留各自 bbox、"
        "字段级 Observation、Frame 和原始截图引用。"
    )
    return f"{text}\n"


def write_element_presentation_note(spec, group, asset):
    note_path = PROJECTION_ROOT / group["instanceNotePath"]
    note_path.parent.mkdir(parents=True, exist_ok=True)
    note_path.write_text(
        element_presentation_note_text(spec, group, asset), encoding="utf-8"
    )


def page_instance_note_text(spec, item):
    state = item["state"]
    presentation_context = page_presentation_context(item)
    page_title_by_ref = {
        page_item["pageRef"]: page_item["pageTitle"]
        for page_item in spec["pageItems"]
    }
    runtime_source = "../../../runtime/zto.connect/01KY6YECXXQRGNZC5S1MWPRYCX/page-instances.yaml"
    element_links = []
    for group in spec["presentationGroups"]:
        if not any(
            member["pageInstanceRef"] == item["pageInstanceRef"]
            for member in group["members"]
        ):
            continue
        element_links.append(
            f"- [[{group['instanceNotePath'][:-3]}|{group['title']}]]："
            f"variant `{group['variant']}` / Runtime 成员 `{len(group['members'])}`"
        )
    element_link_text = "\n".join(element_links)
    supporting = [
        observation
        for observation in spec.get("supportingObservations", [])
        if observation["pageInstanceRef"] == item["pageInstanceRef"]
    ]
    supporting_layout_refs = [observation["sourceFrameRef"] for observation in supporting]
    supporting_rows = []
    supporting_sections = []
    for observation in supporting:
        supporting_rows.append(
            f"| `{observation['sourceFrameRef']}` | `{observation['sourceResourceRef']}` | "
            f"`{observation['observedAt']}` | `{observation['reason']}` |"
        )
        supporting_sections.append(
            f"### Frame `{observation['sourceFrameRef']}`\n\n"
            f"![[{observation['outputPath']}|640]]\n\n"
            f"- 截图资源：`{observation['sourceResourceRef']}`\n"
            f"- 观察时间：`{observation['observedAt']}`\n"
            f"- 归并方法：`{observation['equivalenceMethod']}`，"
            f"置信度 `{observation['equivalenceConfidence']}`\n"
        )
    supporting_text = "\n".join(supporting_rows) if supporting_rows else "无支持观察。"
    supporting_section_text = "\n".join(supporting_sections)
    text = (
        "---\n"
        "type: PageInstance\n"
        f"uikg_id: {item['pageInstanceRef']}\n"
        f"page_ref: {item['pageRef']}\n"
        f"page_key: {item['pageKey']}\n"
        f"state_key: {state['key']}\n"
        f"selected_bottom_tab: {state['selectedBottomTab']}\n"
        f"bottom_sheet: {state['transientState']['bottomSheet']}\n"
        f"device_ref: {DEVICE_REF}\n"
        f"layout_snapshot_ref: {item['sourceFrameRef']}\n"
        f"supporting_layout_snapshot_refs: {json.dumps(supporting_layout_refs, ensure_ascii=False)}\n"
        f"source_screenshot_ref: {item['sourceResourceRef']}\n"
        f"supporting_screenshot_refs: {json.dumps([observation['sourceResourceRef'] for observation in supporting], ensure_ascii=False)}\n"
        f"observed_at: \"{item['observedAt']}\"\n"
        f"presentation_context_key: \"{item['presentationContextKey']}\"\n"
        f"representative_presentation_context: {json.dumps(presentation_context, ensure_ascii=False, separators=(',', ':'))}\n"
        f"{app_build_frontmatter(spec['appBuild'])}"
        "read_only: true\n"
        f"runtime_source: {runtime_source}\n"
        "tags:\n"
        "  - uikg/page-instance\n"
        "  - runtime/page-presentation\n"
        "---\n\n"
        f"# {item['pageTitle']}页面实体\n\n"
        f"这是[[页面/{item['pageTitle']}|{item['pageTitle']}]]在当前条件与呈现签名下的页面实体。"
        "主 Frame 提供代表截图；语义与呈现等价的重复 Frame 作为 supporting observation 归入本实体，"
        "不会再生成以采集步骤命名的页面卡片。"
        f"页面状态是 `{state['key']}`，底部导航选中项是 `{state['selectedBottomTab']}`，"
        f"`bottomSheet={state['transientState']['bottomSheet']}`。\n\n"
        "## 实例属性\n\n"
        f"- 应用版本：`{spec['appBuild']['versionName']}`（versionCode `{spec['appBuild']['versionCode']}`，"
        f"包名 `{spec['appBuild']['packageId']}`）\n"
        "- 设备：[[设备/华为-NOH-AN01-1152x2376|HUAWEI NOH-AN01]]\n"
        f"- LayoutSnapshot / Frame：`{item['sourceFrameRef']}`\n"
        f"- 支持观察数量：`{len(supporting)}`\n"
        f"- 观察时间：`{item['observedAt']}`\n"
        "- 截图尺寸与坐标空间：`1152 x 2376 screenshot_px`\n"
        f"- 展示上下文键：`{item['presentationContextKey']}`\n\n"
        + (
            f"- 本次 Frame 来源宿主："
            f"[[页面/{page_title_by_ref[presentation_context['hostPageRef']]}|"
            f"{page_title_by_ref[presentation_context['hostPageRef']]}]] "
            f"(`{presentation_context['hostPageRef']}`)；"
            f"入口 ActionTrace：`{presentation_context.get('entryActionTraceRef')}`；"
            "该宿主仅描述本次观测来源，不参与抽屉页面身份。\n\n"
            if presentation_context.get("hostPageRef") is not None
            else ""
        )
        +
        "## 完整页面截图\n\n"
        f"![[{item['outputPath']}|640]]\n\n"
        "## 支持观察\n\n"
        + (
            "| LayoutSnapshot / Frame | 截图资源 | 观察时间 | 归并原因 |\n"
            "| --- | --- | --- | --- |\n"
            f"{supporting_text}\n\n"
            if supporting_rows
            else f"{supporting_text}\n\n"
        )
        + (
            "## 支持观察完整截图\n\n"
            f"{supporting_section_text}\n"
            if supporting_sections
            else ""
        )
        + "## 元素呈现组\n\n"
        f"{element_link_text}\n\n"
        "> 页面实体按条件与呈现签名扩展；纯重复采集保留为 Frame/Layout/ElementInstance 证据，"
        "不制造同质页面卡片。"
    )
    return f"{text}\n"


def write_page_instance_note(spec, item):
    note_path = PROJECTION_ROOT / item["instanceNotePath"]
    note_path.parent.mkdir(parents=True, exist_ok=True)
    note_path.write_text(page_instance_note_text(spec, item), encoding="utf-8")


def stable_element_note_text(spec, source_text, groups):
    text = re.sub(
        r"\n## 实体位置\n.*\Z", "", source_text, flags=re.DOTALL
    ).rstrip()
    links = []
    for group in groups:
        representative = group["representative"]
        links.append(
            f"- [[{group['instanceNotePath'][:-3]}|{group['title']}]]："
            f"variant `{group['variant']}` / Runtime 成员 `{len(group['members'])}` / "
            f"代表 Frame `{representative['sourceFrameRef']}` / "
            f"bbox `{bbox_text(representative['bbox'])}`"
        )
    content = "## 已观察呈现组\n\n" + "\n".join(links)
    return replace_generated_block(text, "element-instance-links", content)


def stable_page_note_text(spec, source_text, items):
    links = []
    for item in items:
        state = item["state"]
        links.append(
            f"- [[{item['instanceNotePath'][:-3]}|{Path(item['instanceNotePath']).stem.split('--', 1)[0]}]]："
            f"`{spec['appBuild']['versionName']}` / state `{state['key']}` / "
            f"bottomSheet `{state['transientState']['bottomSheet']}`"
        )
    content = "## 已观察页面实体\n\n" + "\n".join(links)
    return replace_generated_block(source_text, "page-instance-links", content)


def grouped_stable_note_items(spec):
    by_element = {}
    for group in spec["presentationGroups"]:
        by_element.setdefault(group["elementNotePath"], []).append(group)
    by_page = {}
    for item in spec["pageItems"]:
        by_page.setdefault(item["pageTitle"], []).append(item)
    return by_element, by_page


def update_stable_notes(spec):
    by_element, by_page = grouped_stable_note_items(spec)
    for note_relative, items in by_element.items():
        note_path = PROJECTION_ROOT / note_relative
        source_text = note_path.read_text(encoding="utf-8")
        note_path.write_text(
            stable_element_note_text(spec, source_text, items), encoding="utf-8"
        )

    for page_title, items in by_page.items():
        note_path = PROJECTION_ROOT / "页面" / f"{page_title}.md"
        if not note_path.is_file():
            continue
        source_text = note_path.read_text(encoding="utf-8")
        note_path.write_text(
            stable_page_note_text(spec, source_text, items), encoding="utf-8"
        )


def field_observation_id(observation):
    canonical = canonical_json_dumps(canonical_json_value(observation))
    digest = hashlib.sha256(canonical.encode("utf-8")).hexdigest()
    return f"field-observation:sha256:{digest}"


def field_observation(
    item,
    field_path,
    value,
    *,
    fact_status,
    source_type,
    method,
    confidence,
    prior_element_ref=None,
):
    body = {
        "subjectRef": item["elementInstanceRef"],
        "fieldPath": field_path,
        "value": copy.deepcopy(value),
        "factStatus": fact_status,
        "sourceType": source_type,
        "evidenceRef": item["sourceResourceRef"],
        "frameRef": item["sourceFrameRef"],
        "region": {**item["bbox"], "space": "screenshot_px"},
        "method": method,
        "producer": {
            "kind": "curated_multimodal_review",
            "id": "uikg-curated-visual-annotation",
            "version": "2.0.0",
        },
        "confidence": confidence,
    }
    if prior_element_ref is not None:
        body["priorElementRef"] = prior_element_ref
    return {"observationId": field_observation_id(body), **body}


def resolved_field_evidence(observation, resolution_method):
    return {
        "resolutionMethod": resolution_method,
        "selectedObservationRef": observation["observationId"],
        "observations": [observation],
    }


def instance_confidence(item):
    confidences = [item["confidence"], 0.9]
    if isinstance(item["elementState"].get("selected"), bool):
        confidences.append(item["pageState"]["recognition"]["confidence"])
    if item.get("observedText") is not None:
        confidences.append(item.get("contentConfidence", item["confidence"]))
    if item.get("badge") is not None:
        confidences.append(item.get("badgeConfidence", item["confidence"]))
    return min(confidences)


def element_instance_record(spec, item):
    definition = spec["elementDefinitions"][item["elementRef"]]
    observed_text = item.get("observedText")
    badge = copy.deepcopy(item.get("badge"))
    bbox = {**item["bbox"], "space": "screenshot_px"}
    role = definition.get("semanticRole", "unknown")
    role_confidence = 0.9
    content_confidence = item.get("contentConfidence", item["confidence"])
    badge_confidence = item.get("badgeConfidence", item["confidence"])
    overall_confidence = instance_confidence(item)
    selected = item["elementState"]["selected"]
    state = {
        "present": True,
        "displayed": True,
        "inViewport": True,
        "occluded": False,
        "visible": True,
        "selected": selected,
        "enabled": item["elementState"]["enabled"],
        "hittable": item["elementState"]["hittable"],
        "focused": "unknown",
        "checked": "unknown",
        "expanded": "unknown",
        "pressed": "unknown",
        "loading": "unknown",
        "editable": "unknown",
        "required": "unknown",
        "readOnly": "unknown",
        "invalid": "unknown",
    }
    content = {
        "resolvedText": observed_text,
        "language": "zh-CN" if observed_text is not None else None,
        "source": (
            item["observationMethod"]
            if observed_text is not None
            else "not_applicable"
        ),
        "factStatus": "observed" if observed_text is not None else "unknown",
    }
    if badge is not None:
        content["badge"] = badge
    geometry_observation = field_observation(
        item,
        "geometry.bbox",
        bbox,
        fact_status="observed",
        source_type="vision",
        method=item["observationMethod"],
        confidence=item["confidence"],
    )
    visible_observation = field_observation(
        item,
        "state.visible",
        True,
        fact_status="observed",
        source_type="vision",
        method=item["observationMethod"],
        confidence=1.0,
    )
    role_observation = field_observation(
        item,
        "semantics.role",
        role,
        fact_status="inferred",
        source_type="inference",
        method="visual_role_inference_with_element_prior",
        confidence=role_confidence,
        prior_element_ref=item["elementRef"],
    )
    field_evidence = {
        "geometry.bbox": resolved_field_evidence(
            geometry_observation, "single_curated_visual_observation"
        ),
        "state.visible": resolved_field_evidence(
            visible_observation, "single_curated_visual_observation"
        ),
        "semantics.role": resolved_field_evidence(
            role_observation, "visual_inference_with_canonical_prior"
        ),
    }
    if isinstance(selected, bool):
        selected_observation = field_observation(
            item,
            "state.selected",
            selected,
            fact_status="observed",
            source_type="vision",
            method="selected_tab_visual_state_resolution",
            confidence=item["pageState"]["recognition"]["confidence"],
        )
        field_evidence["state.selected"] = resolved_field_evidence(
            selected_observation, "single_frame_selected_tab_visual_resolution"
        )
    if observed_text is not None:
        text_observation = field_observation(
            item,
            "content.resolvedText",
            observed_text,
            fact_status="observed",
            source_type="vision",
            method=item["observationMethod"],
            confidence=content_confidence,
        )
        name_observation = field_observation(
            item,
            "semantics.name",
            observed_text,
            fact_status="observed",
            source_type="vision",
            method=item["observationMethod"],
            confidence=content_confidence,
        )
        field_evidence["content.resolvedText"] = resolved_field_evidence(
            text_observation, "single_curated_visual_observation"
        )
        field_evidence["semantics.name"] = resolved_field_evidence(
            name_observation, "resolved_from_visible_text"
        )
    if badge is not None:
        badge_observation = field_observation(
            item,
            "content.badge",
            badge,
            fact_status="observed",
            source_type="vision",
            method=item["observationMethod"],
            confidence=badge_confidence,
        )
        field_evidence["content.badge"] = resolved_field_evidence(
            badge_observation, "single_curated_visual_observation"
        )
    return {
        "schemaVersion": "2.0.0",
        "entityType": "ElementInstance",
        "id": item["elementInstanceRef"],
        "revision": 1,
        "status": "observed",
        "recordedAt": RECORDED_AT,
        "recordedBy": RECORDED_BY,
        "elementRef": item["elementRef"],
        "layoutSnapshotRef": item["sourceFrameRef"],
        "pageInstanceRef": item["pageInstanceRef"],
        "pageRef": item["pageRef"],
        "pageState": item["pageState"],
        "appBuild": spec["appBuild"],
        "deviceSnapshotRef": DEVICE_REF,
        "observedAt": item["observedAt"],
        "kind": definition["kind"],
        "surfaceId": item["surfaceId"],
        "parentInstanceRef": item["parentInstanceRef"],
        "visibility": "visible",
        "state": state,
        "semantics": {
            "role": role,
            "roleFactStatus": "inferred",
            "name": observed_text,
            "nameFactStatus": "observed" if observed_text is not None else "unknown",
        },
        "content": content,
        "geometry": {
            "semantics": spec["annotation"]["geometrySemantics"],
            "bbox": bbox,
            "centerPoint": center_point(item["bbox"]),
            "basis": item["basis"],
            "confidence": item["confidence"],
            "locatorEligible": False,
        },
        "visualEvidence": {
            "sourceFrameRef": item["sourceFrameRef"],
            "fullPageScreenshotRef": item["sourceResourceRef"],
            "sourcePixelSize": spec["sourcePixelSize"],
            "coordinateSpace": "screenshot_px",
            "coordinateMappingRef": (
                f"{item['sourceFrameRef']}#screenshotGeometry"
            ),
        },
        "presentationGroupRef": item["presentationGroupRef"],
        "presentationContextKey": item["presentationContextKey"],
        "fieldEvidence": field_evidence,
        "confidence": overall_confidence,
        "provenance": [
            {
                "sourceType": "materialization",
                "sourceId": "knowledge_graph/tools/zto_entity_annotation_spec.json",
                "sourceVersion": "uikg-instance-projector@2.0.0",
                "inputEvidenceRefs": [item["sourceResourceRef"]],
                "confidence": overall_confidence,
            }
        ],
        "extensions": {},
    }


def page_instance_record(spec, item, element_refs):
    supporting_observations = []
    for observation in spec.get("supportingObservations", []):
        if observation["pageInstanceRef"] != item["pageInstanceRef"]:
            continue
        supporting_element_refs = [
            element_item["elementInstanceRef"]
            for element_item in spec["items"]
            if element_item["sourceFrameRef"] == observation["sourceFrameRef"]
        ]
        supporting_observations.append(
            {
                "layoutSnapshotRef": observation["sourceFrameRef"],
                "observedAt": observation["observedAt"],
                "screenshotRef": observation["sourceResourceRef"],
                "elementInstanceRefs": supporting_element_refs,
                "presentationContextKey": observation["presentationContextKey"],
                "presentationContext": page_presentation_context(observation),
                "reason": observation["reason"],
                "equivalence": {
                    "method": observation["equivalenceMethod"],
                    "confidence": observation["equivalenceConfidence"],
                },
            }
        )
    screenshot_refs = list(
        dict.fromkeys(
            [item["sourceResourceRef"]]
            + [observation["screenshotRef"] for observation in supporting_observations]
        )
    )
    return {
        "schemaVersion": "2.0.0",
        "entityType": "PageInstance",
        "id": item["pageInstanceRef"],
        "revision": 1,
        "status": "observed",
        "recordedAt": RECORDED_AT,
        "recordedBy": RECORDED_BY,
        "pageRef": item["pageRef"],
        "layoutSnapshotRef": item["sourceFrameRef"],
        "captureSessionRef": SESSION_REF,
        "deviceSnapshotRef": DEVICE_REF,
        "appBuild": spec["appBuild"],
        "observedAt": item["observedAt"],
        "state": item["state"],
        "screenshotRefs": screenshot_refs,
        "elementInstanceRefs": element_refs,
        "supportingObservations": supporting_observations,
        "representativeObservation": {
            "layoutSnapshotRef": item["sourceFrameRef"],
            "observedAt": item["observedAt"],
            "screenshotRef": item["sourceResourceRef"],
            "presentationContext": page_presentation_context(item),
        },
        "presentationSignature": {
            "key": item["presentationContextKey"],
            "basis": "page-state-navigation-surface-build-and-geometry",
        },
        "presentationContextKey": item["presentationContextKey"],
        "provenance": [
            {
                "sourceType": "runtime",
                "sourceId": item["sourceFrameRef"],
                "sourceVersion": "midscene-android-uikg-explorer@1.1.0",
                "confidence": 1.0,
            }
        ],
        "extensions": {},
    }


def canonical_json_value(value):
    if isinstance(value, datetime.datetime):
        utc_value = value.astimezone(datetime.timezone.utc)
        return utc_value.isoformat(timespec="milliseconds").replace("+00:00", "Z")
    if isinstance(value, datetime.date):
        return value.isoformat()
    if isinstance(value, float) and value.is_integer():
        return int(value)
    if isinstance(value, list):
        return [canonical_json_value(item) for item in value]
    if isinstance(value, dict):
        return {
            key: canonical_json_value(value[key])
            for key in sorted(value)
        }
    return value


def yaml_json_value(value):
    if isinstance(value, datetime.datetime):
        utc_value = value.astimezone(datetime.timezone.utc)
        return utc_value.isoformat(timespec="milliseconds").replace("+00:00", "Z")
    if isinstance(value, datetime.date):
        return value.isoformat()
    if isinstance(value, list):
        return [yaml_json_value(item) for item in value]
    if isinstance(value, dict):
        return {key: yaml_json_value(item) for key, item in value.items()}
    return value


def canonical_json_number(value):
    if not math.isfinite(value):
        raise ValueError("Canonical JSON does not allow NaN or Infinity")
    if value == 0:
        return "0"
    if value.is_integer() and abs(value) < 1e21:
        return str(int(value))

    rendered = repr(value).lower()
    magnitude = abs(value)
    if 1e-6 <= magnitude < 1e21:
        if "e" not in rendered:
            return rendered
        mantissa, exponent = rendered.split("e", 1)
        exponent_value = int(exponent)
        sign = ""
        if mantissa.startswith("-"):
            sign = "-"
            mantissa = mantissa[1:]
        whole, _, fraction = mantissa.partition(".")
        digits = whole + fraction
        decimal_position = len(whole) + exponent_value
        if decimal_position <= 0:
            return f"{sign}0.{('0' * -decimal_position)}{digits}"
        if decimal_position >= len(digits):
            return f"{sign}{digits}{('0' * (decimal_position - len(digits)))}"
        return f"{sign}{digits[:decimal_position]}.{digits[decimal_position:]}"

    mantissa, exponent = rendered.split("e", 1)
    mantissa = mantissa.rstrip("0").rstrip(".")
    exponent_value = int(exponent)
    exponent_sign = "+" if exponent_value >= 0 else ""
    return f"{mantissa}e{exponent_sign}{exponent_value}"


def canonical_json_dumps(value):
    if value is None:
        return "null"
    if value is True:
        return "true"
    if value is False:
        return "false"
    if isinstance(value, int):
        return str(value)
    if isinstance(value, float):
        return canonical_json_number(value)
    if isinstance(value, str):
        return json.dumps(value, ensure_ascii=False, separators=(",", ":"))
    if isinstance(value, list):
        return f"[{','.join(canonical_json_dumps(item) for item in value)}]"
    if isinstance(value, dict):
        pairs = (
            f"{canonical_json_dumps(key)}:{canonical_json_dumps(value[key])}"
            for key in sorted(value)
        )
        return f"{{{','.join(pairs)}}}"
    raise TypeError(f"Unsupported canonical JSON value: {type(value).__name__}")


def record_content_hash(record):
    body = {key: value for key, value in record.items() if key != "contentHash"}
    canonical = canonical_json_dumps(canonical_json_value(body))
    return f"sha256:{hashlib.sha256(canonical.encode('utf-8')).hexdigest()}"


def update_layout_snapshots(spec):
    items_by_frame = {}
    for item in spec["items"]:
        items_by_frame.setdefault(item["sourceFrameRef"], []).append(item)

    for page_item in observation_contexts(spec):
        frame_ref = page_item["sourceFrameRef"]
        snapshot_path = RUNTIME_ROOT / "layouts" / frame_ref / "snapshot.yaml"
        snapshot = yaml.safe_load(snapshot_path.read_text(encoding="utf-8"))
        snapshot = materialized_layout_snapshot(
            spec,
            page_item,
            snapshot,
            items_by_frame.get(frame_ref, []),
        )
        snapshot_path.write_text(
            yaml.safe_dump(
                snapshot,
                allow_unicode=True,
                sort_keys=False,
                width=120,
            ),
            encoding="utf-8",
        )


def materialized_layout_snapshot(spec, page_item, source_snapshot, frame_items):
    snapshot = copy.deepcopy(source_snapshot)
    snapshot["pageRef"] = page_item["pageRef"]
    snapshot["pageInstanceRef"] = page_item["pageInstanceRef"]
    snapshot["pageObservationRole"] = page_item["observationRole"]
    snapshot["presentationContext"] = page_presentation_context(page_item)
    snapshot["pageState"] = {
        "key": page_item["state"]["key"],
        "properties": {
            "selectedBottomTab": page_item["state"]["selectedBottomTab"],
        },
    }
    snapshot["transientState"] = copy.deepcopy(
        page_item["state"].get("transientState", {})
    )
    snapshot["rootInstanceRefs"] = [
        item["elementInstanceRef"]
        for item in frame_items
        if item["parentInstanceRef"] is None
    ]
    snapshot["elementInstanceRefs"] = [
        item["elementInstanceRef"] for item in frame_items
    ]
    snapshot["instanceCount"] = len(frame_items)
    current_display_to_screen = [7 / 6, 0, 0, 0, 7 / 6, 0, 0, 0, 1]
    screen_to_current_display = [6 / 7, 0, 0, 0, 6 / 7, 0, 0, 0, 1]
    snapshot["screenshotGeometry"] = {
        "resourceRef": page_item["sourceResourceRef"],
        "pixelSize": copy.deepcopy(spec["sourcePixelSize"]),
        "captureRectScreenPx": {
            "x": 0,
            "y": 0,
            "width": 1344,
            "height": 2772,
            "space": "screen_px",
        },
        "rotationDegrees": spec["rotationDegrees"],
        "transforms": [
            {
                "id": "current_display_px_to_screen_px",
                "from": spec["sourceCoordinateSpace"],
                "to": "screen_px",
                "matrix3x3": copy.deepcopy(current_display_to_screen),
                "inverseMatrix3x3": copy.deepcopy(screen_to_current_display),
                "basis": "device_display_override_1152x2376_to_physical_1344x2772",
                "confidence": 1.0,
            },
            {
                "id": "screen_px_to_screenshot_px",
                "from": "screen_px",
                "to": "screenshot_px",
                "matrix3x3": copy.deepcopy(screen_to_current_display),
                "inverseMatrix3x3": copy.deepcopy(current_display_to_screen),
                "basis": "physical_1344x2772_to_full_display_capture_1152x2376",
                "confidence": 1.0,
            },
        ],
    }
    snapshot = yaml_json_value(snapshot)
    snapshot["contentHash"] = record_content_hash(snapshot)
    return snapshot


def write_runtime_records(spec):
    element_records = [element_instance_record(spec, item) for item in spec["items"]]
    element_refs_by_page_instance = {}
    for item in spec["items"]:
        element_refs_by_page_instance.setdefault(item["pageInstanceRef"], []).append(
            item["elementInstanceRef"]
        )
    page_records = [
        page_instance_record(
            spec,
            item,
            element_refs_by_page_instance.get(item["pageInstanceRef"], []),
        )
        for item in spec["pageItems"]
    ]
    ELEMENT_INSTANCES_PATH.write_text(
        yaml.safe_dump_all(
            element_records,
            allow_unicode=True,
            sort_keys=False,
            explicit_start=False,
            width=120,
        ),
        encoding="utf-8",
    )
    PAGE_INSTANCES_PATH.write_text(
        yaml.safe_dump_all(
            page_records,
            allow_unicode=True,
            sort_keys=False,
            explicit_start=False,
            width=120,
        ),
        encoding="utf-8",
    )
    update_layout_snapshots(spec)


def element_asset_descriptor(spec, group, output_path, rendered, red_added):
    item = group["representative"]
    return {
        "path": group["outputPath"],
        "notePath": group["instanceNotePath"],
        "assetType": "AnnotatedElementPresentationScreenshot",
        "presentationGroupRef": group["presentationGroupRef"],
        "presentationGroupKey": group["presentationGroupKey"],
        "presentationSignatureHash": group["presentationSignatureHash"],
        "presentationSignature": group["presentationSignature"],
        "groupingAlgorithm": group["groupingAlgorithm"],
        "elementRef": group["elementRef"],
        "elementKey": group["elementKey"],
        "representativeElementInstanceRef": item["elementInstanceRef"],
        "memberElementInstanceRefs": [
            member["elementInstanceRef"] for member in group["members"]
        ],
        "memberFrameRefs": [member["sourceFrameRef"] for member in group["members"]],
        "pageInstanceRef": item["pageInstanceRef"],
        "sourceFrameRef": item["sourceFrameRef"],
        "sourceResourceRef": item["sourceResourceRef"],
        "sourcePixelSize": spec["sourcePixelSize"],
        "coordinateMappingRef": f"{item['sourceFrameRef']}#screenshotGeometry",
        "fullPageRect": {**item["fullPageRect"], "space": "screenshot_px"},
        "bbox": {**item["bbox"], "space": "screenshot_px"},
        "centerPoint": center_point(item["bbox"]),
        "annotation": {
            **spec["annotation"],
            "renderedAnnotationRect": rendered,
            "basis": item["basis"],
            "confidence": item["confidence"],
            "redPixelCountAdded": red_added,
        },
        "presentationContextKey": item["presentationContextKey"],
        "generator": {"id": "uikg-instance-image-projector", "version": "2.0.0"},
        "mediaType": "image/png",
        "byteLength": output_path.stat().st_size,
        "sha256": sha256(output_path),
        "dataClassification": "confidential",
        "redaction": {"status": "not_applied"},
    }


def page_asset_descriptor(spec, item, output_path):
    primary = primary_page_item(spec, item["pageInstanceRef"])
    observation_role = item.get("observationRole", "primary")
    return {
        "path": item["outputPath"],
        "notePath": primary["instanceNotePath"],
        "assetType": "PageObservationScreenshot",
        "pageRef": item["pageRef"],
        "pageKey": item["pageKey"],
        "pageInstanceRef": item["pageInstanceRef"],
        "layoutSnapshotRef": item["sourceFrameRef"],
        "observationRole": observation_role,
        "sourceResourceRef": item["sourceResourceRef"],
        "sourcePixelSize": spec["sourcePixelSize"],
        "coordinateMappingRef": f"{item['sourceFrameRef']}#screenshotGeometry",
        "presentationContextKey": item["presentationContextKey"],
        "presentationContext": page_presentation_context(item),
        "generator": {"id": "uikg-instance-image-projector", "version": "2.0.0"},
        "mediaType": "image/png",
        "byteLength": output_path.stat().st_size,
        "sha256": sha256(output_path),
        "dataClassification": "confidential",
        "redaction": {"status": "not_applied"},
    }


def generate_element_images(spec, resources, resource_index_path):
    descriptors = []
    full_bounds = {"x": 0, "y": 0, **spec["sourcePixelSize"]}
    stroke_width = spec["annotation"]["strokeWidthPx"]
    for group in spec["presentationGroups"]:
        item = group["representative"]
        ensure_rect_inside(item["bbox"], full_bounds, item["elementKey"])
        resource = resources.get(item["sourceResourceRef"])
        if not resource or resource.get("mediaType") != "image/png":
            raise ValueError(f"Missing PNG resource {item['sourceResourceRef']}")
        source_path = source_path_for(resource_index_path, resource)
        with Image.open(source_path) as source:
            image = source.convert("RGB")
            if image.size != (
                spec["sourcePixelSize"]["width"],
                spec["sourcePixelSize"]["height"],
            ):
                raise ValueError(f"Unexpected source size for {source_path}: {image.size}")
        rendered = rendered_annotation_rect(item["bbox"], image.size)
        before_red = count_red_pixels(image)
        rx0, ry0, rx1, ry1 = rect_edges(rendered)
        ImageDraw.Draw(image).rectangle(
            (rx0, ry0, rx1 - 1, ry1 - 1),
            outline=(255, 0, 0),
            width=stroke_width,
        )
        red_added = count_red_pixels(image) - before_red
        if red_added <= 0:
            raise ValueError(f"No red pixels were added for {item['elementKey']}")
        output_path = PROJECTION_ROOT / group["outputPath"]
        output_path.parent.mkdir(parents=True, exist_ok=True)
        image.save(output_path, format="PNG", optimize=True)
        descriptors.append(
            element_asset_descriptor(spec, group, output_path, rendered, red_added)
        )
    return descriptors


def generate_page_images(spec, resources, resource_index_path):
    descriptors = []
    for item in observation_contexts(spec):
        resource = resources.get(item["sourceResourceRef"])
        if not resource or resource.get("mediaType") != "image/png":
            raise ValueError(f"Missing page screenshot {item['sourceResourceRef']}")
        source_path = source_path_for(resource_index_path, resource)
        output_path = PROJECTION_ROOT / item["outputPath"]
        output_path.parent.mkdir(parents=True, exist_ok=True)
        shutil.copyfile(source_path, output_path)
        with Image.open(output_path) as image:
            if image.size != (
                spec["sourcePixelSize"]["width"],
                spec["sourcePixelSize"]["height"],
            ):
                raise ValueError(f"Unexpected page image size for {output_path}: {image.size}")
        descriptors.append(page_asset_descriptor(spec, item, output_path))
    return descriptors


def describe_existing_assets(spec, resources=None, resource_index_path=None):
    resource_index_path = resource_index_path or (
        KNOWLEDGE_GRAPH_ROOT / spec["resourceIndex"]
    )
    resources = resources or resource_map(resource_index_path)
    expected_size = (
        spec["sourcePixelSize"]["width"],
        spec["sourcePixelSize"]["height"],
    )
    stroke_width = spec["annotation"]["strokeWidthPx"]
    element_descriptors = []
    for group in spec["presentationGroups"]:
        item = group["representative"]
        output_path = PROJECTION_ROOT / group["outputPath"]
        if not output_path.is_file():
            raise ValueError(f"Missing generated element image {output_path}")
        resource = resources.get(item["sourceResourceRef"])
        if not resource or resource.get("mediaType") != "image/png":
            raise ValueError(f"Missing PNG resource {item['sourceResourceRef']}")
        source_path = source_path_for(resource_index_path, resource)
        rendered = rendered_annotation_rect(item["bbox"], expected_size)
        with Image.open(source_path) as source_image, Image.open(output_path) as output_image:
            source_rgb = source_image.convert("RGB")
            output_rgb = output_image.convert("RGB")
            if source_rgb.size != expected_size or output_rgb.size != expected_size:
                raise ValueError(f"Unexpected image size for {output_path}")
            expected_image = source_rgb.copy()
            rx0, ry0, rx1, ry1 = rect_edges(rendered)
            ImageDraw.Draw(expected_image).rectangle(
                (rx0, ry0, rx1 - 1, ry1 - 1),
                outline=(255, 0, 0),
                width=stroke_width,
            )
            if expected_image.tobytes() != output_rgb.tobytes():
                raise ValueError(f"Generated annotation pixels are stale: {output_path}")
            red_added = count_red_pixels(output_rgb) - count_red_pixels(source_rgb)
        element_descriptors.append(
            element_asset_descriptor(spec, group, output_path, rendered, red_added)
        )

    page_descriptors = []
    for item in observation_contexts(spec):
        output_path = PROJECTION_ROOT / item["outputPath"]
        if not output_path.is_file():
            raise ValueError(f"Missing generated page image {output_path}")
        resource = resources.get(item["sourceResourceRef"])
        if not resource or resource.get("mediaType") != "image/png":
            raise ValueError(f"Missing PNG resource {item['sourceResourceRef']}")
        source_path = source_path_for(resource_index_path, resource)
        if sha256(output_path) != sha256(source_path):
            raise ValueError(f"Page image is not an exact source copy: {output_path}")
        with Image.open(output_path) as image:
            if image.size != expected_size:
                raise ValueError(f"Unexpected page image size for {output_path}")
        page_descriptors.append(page_asset_descriptor(spec, item, output_path))
    return element_descriptors, page_descriptors


def update_projection_manifest(element_descriptors, page_descriptors):
    if not PROJECTION_MANIFEST_PATH.is_file():
        return
    manifest = read_json(PROJECTION_MANIFEST_PATH)
    manifest["schemaVersion"] = "2.0.0"
    manifest["manifestVersion"] = 2
    manifest["assets"] = {
        "elementPresentationImages": element_descriptors,
        "pageObservationImages": page_descriptors,
    }
    counts = manifest.setdefault("counts", {})
    counts.pop("elementInstanceImages", None)
    counts["elementPresentationGroups"] = len(element_descriptors)
    counts.pop("pageInstanceImages", None)
    counts["pageObservationImages"] = len(page_descriptors)
    policy = manifest.setdefault("contentPolicy", {})
    policy.update(
        {
            "embeddedEvidenceResources": 0,
            "derivedAnnotatedScreenshotAssets": len(element_descriptors),
            "derivedPageScreenshotAssets": len(page_descriptors),
            "containsSensitiveScreenshots": True,
            "projectionAssetDataClassification": "confidential",
            "projectionAssetRedactionStatus": "not_applied",
            "includesPhysicalLocators": False,
            "includesPixelGeometry": True,
            "includesDynamicBusinessContent": True,
        }
    )
    PROJECTION_MANIFEST_PATH.write_text(
        f"{json.dumps(manifest, ensure_ascii=False, indent=2)}\n",
        encoding="utf-8",
    )


def remove_stale_generated_outputs(spec):
    expected_asset_paths = {
        item["outputPath"]
        for item in [
            *spec["presentationGroups"],
            *spec["pageItems"],
            *spec.get("supportingObservations", []),
        ]
    }
    expected_note_paths = {
        item["instanceNotePath"]
        for item in [*spec["presentationGroups"], *spec["pageItems"]]
    }
    for relative_root, suffix, expected_paths in [
        ("资源/元素实体", ".png", expected_asset_paths),
        ("资源/页面实体", ".png", expected_asset_paths),
        ("元素实体", ".md", expected_note_paths),
        ("页面实体", ".md", expected_note_paths),
    ]:
        root = PROJECTION_ROOT / relative_root
        if not root.is_dir():
            continue
        for candidate in root.glob(f"*{suffix}"):
            relative_path = candidate.relative_to(PROJECTION_ROOT).as_posix()
            if relative_path not in expected_paths:
                candidate.unlink()


def generate(spec):
    resource_index_path = KNOWLEDGE_GRAPH_ROOT / spec["resourceIndex"]
    resources = resource_map(resource_index_path)
    remove_stale_generated_outputs(spec)
    write_runtime_records(spec)
    element_descriptors = generate_element_images(spec, resources, resource_index_path)
    page_descriptors = generate_page_images(spec, resources, resource_index_path)
    assets_by_group = {
        asset["presentationGroupRef"]: asset for asset in element_descriptors
    }
    for group in spec["presentationGroups"]:
        write_element_presentation_note(
            spec,
            group,
            assets_by_group[group["presentationGroupRef"]],
        )
    for item in spec["pageItems"]:
        write_page_instance_note(spec, item)
    update_stable_notes(spec)
    update_projection_manifest(element_descriptors, page_descriptors)
    print(
        f"Generated {len(page_descriptors)} page-observation screenshots and "
        f"{len(element_descriptors)} presentation-group annotations "
        f"covering {len(spec['items'])} Runtime ElementInstances."
    )


def check(spec):
    manifest = read_json(PROJECTION_MANIFEST_PATH)
    element_assets = manifest.get("assets", {}).get("elementPresentationImages", [])
    page_assets = manifest.get("assets", {}).get("pageObservationImages", [])
    if len(element_assets) != len(spec["presentationGroups"]):
        raise ValueError("Element-presentation descriptor count is inconsistent")
    if len(page_assets) != len(observation_contexts(spec)):
        raise ValueError("Page-observation descriptor count is inconsistent")
    resource_index_path = KNOWLEDGE_GRAPH_ROOT / spec["resourceIndex"]
    expected_element_assets, expected_page_assets = describe_existing_assets(
        spec,
        resource_map(resource_index_path),
        resource_index_path,
    )
    if element_assets != expected_element_assets or page_assets != expected_page_assets:
        raise ValueError("Projection asset descriptors differ from the spec and generated files")
    for asset in [*element_assets, *page_assets]:
        note_path = PROJECTION_ROOT / asset["notePath"]
        if not note_path.is_file() or f"![[{asset['path']}|640]]" not in note_path.read_text(encoding="utf-8"):
            raise ValueError(f"Projection note does not embed {asset['path']}")

    element_records = list(yaml.safe_load_all(ELEMENT_INSTANCES_PATH.read_text(encoding="utf-8")))
    page_records = list(yaml.safe_load_all(PAGE_INSTANCES_PATH.read_text(encoding="utf-8")))
    if len(element_records) != len(spec["items"]) or len(page_records) != len(spec["pageItems"]):
        raise ValueError("Runtime instance files are incomplete")
    expected_element_records = [element_instance_record(spec, item) for item in spec["items"]]
    element_refs_by_page_instance = {}
    for item in spec["items"]:
        element_refs_by_page_instance.setdefault(item["pageInstanceRef"], []).append(
            item["elementInstanceRef"]
        )
    expected_page_records = [
        page_instance_record(
            spec,
            item,
            element_refs_by_page_instance.get(item["pageInstanceRef"], []),
        )
        for item in spec["pageItems"]
    ]
    if element_records != expected_element_records:
        raise ValueError("Runtime ElementInstance records are stale")
    if page_records != expected_page_records:
        raise ValueError("Runtime PageInstance records are stale")

    items_by_frame = {}
    for item in spec["items"]:
        items_by_frame.setdefault(item["sourceFrameRef"], []).append(item)
    for page_item in observation_contexts(spec):
        frame_ref = page_item["sourceFrameRef"]
        snapshot_path = RUNTIME_ROOT / "layouts" / frame_ref / "snapshot.yaml"
        actual_snapshot = yaml.safe_load(snapshot_path.read_text(encoding="utf-8"))
        expected_snapshot = materialized_layout_snapshot(
            spec,
            page_item,
            actual_snapshot,
            items_by_frame.get(frame_ref, []),
        )
        if actual_snapshot != expected_snapshot:
            raise ValueError(f"LayoutSnapshot is stale: {snapshot_path}")

    element_assets_by_group = {
        asset["presentationGroupRef"]: asset for asset in element_assets
    }
    for group in spec["presentationGroups"]:
        note_path = PROJECTION_ROOT / group["instanceNotePath"]
        note_text = note_path.read_text(encoding="utf-8")
        expected_note_text = element_presentation_note_text(
            spec, group, element_assets_by_group[group["presentationGroupRef"]]
        )
        if note_text != expected_note_text:
            raise ValueError(f"ElementPresentationGroup note is stale: {note_path}")
        frontmatter = read_markdown_frontmatter(note_path)
        representative = group["representative"]
        expected_frontmatter = {
            "type": "ElementPresentationGroup",
            "presentation_group_ref": group["presentationGroupRef"],
            "presentation_group_key": group["presentationGroupKey"],
            "presentation_signature_hash": group["presentationSignatureHash"],
            "grouping_algorithm": group["groupingAlgorithm"],
            "presentation_signature": group["presentationSignature"],
            "element_ref": group["elementRef"],
            "element_key": group["elementKey"],
            "representative_element_instance_ref": representative["elementInstanceRef"],
            "member_element_instance_refs": [
                member["elementInstanceRef"] for member in group["members"]
            ],
            "member_count": len(group["members"]),
            "bbox": [representative["bbox"][key] for key in ("x", "y", "width", "height")],
            "center_point": [
                normalized_number(center_point(representative["bbox"])["x"]),
                normalized_number(center_point(representative["bbox"])["y"]),
            ],
            "annotation_sha256": element_assets_by_group[group["presentationGroupRef"]]["sha256"],
        }
        for key, value in expected_frontmatter.items():
            if frontmatter.get(key) != value:
                raise ValueError(f"Stale ElementInstance note field {key}: {note_path}")

    for item in spec["pageItems"]:
        note_path = PROJECTION_ROOT / item["instanceNotePath"]
        note_text = note_path.read_text(encoding="utf-8")
        if note_text != page_instance_note_text(spec, item):
            raise ValueError(f"PageInstance note is stale: {note_path}")
        frontmatter = read_markdown_frontmatter(note_path)
        expected_frontmatter = {
            "type": "PageInstance",
            "uikg_id": item["pageInstanceRef"],
            "page_ref": item["pageRef"],
            "page_key": item["pageKey"],
            "state_key": item["state"]["key"],
            "selected_bottom_tab": item["state"]["selectedBottomTab"],
            "bottom_sheet": item["state"]["transientState"]["bottomSheet"],
            "layout_snapshot_ref": item["sourceFrameRef"],
            "supporting_layout_snapshot_refs": [
                observation["sourceFrameRef"]
                for observation in spec.get("supportingObservations", [])
                if observation["pageInstanceRef"] == item["pageInstanceRef"]
            ],
            "source_screenshot_ref": item["sourceResourceRef"],
            "supporting_screenshot_refs": [
                observation["sourceResourceRef"]
                for observation in spec.get("supportingObservations", [])
                if observation["pageInstanceRef"] == item["pageInstanceRef"]
            ],
            "observed_at": item["observedAt"],
            "representative_presentation_context": page_presentation_context(item),
        }
        for key, value in expected_frontmatter.items():
            if frontmatter.get(key) != value:
                raise ValueError(f"Stale PageInstance note field {key}: {note_path}")

    by_element, by_page = grouped_stable_note_items(spec)
    for note_relative, items in by_element.items():
        note_path = PROJECTION_ROOT / note_relative
        note_text = note_path.read_text(encoding="utf-8")
        if note_text != stable_element_note_text(spec, note_text, items):
            raise ValueError(f"Stable Element note has stale instance links: {note_path}")
    for page_title, items in by_page.items():
        note_path = PROJECTION_ROOT / "页面" / f"{page_title}.md"
        if not note_path.is_file():
            continue
        note_text = note_path.read_text(encoding="utf-8")
        if note_text != stable_page_note_text(spec, note_text, items):
            raise ValueError(f"Stable Page note has stale instance links: {note_path}")
    print(
        f"Verified {len(page_records)} PageInstances with {len(page_assets)} page observations and "
        f"{len(element_assets)} presentation groups covering "
        f"{len(element_records)} Runtime ElementInstances."
    )


def main():
    raise RuntimeError(
        "This UIKG 2.0 projector uses the retired app-drawer Page model and must not modify the active graph."
    )
    args = parse_args()
    spec = read_json(SPEC_PATH)
    spec["items"] = materialize_shared_navigation_items(spec)
    spec["elementDefinitions"] = load_element_definitions()
    spec["presentationGroups"] = materialize_presentation_groups(spec)
    if args.check:
        check(spec)
    else:
        generate(spec)


if __name__ == "__main__":
    main()
