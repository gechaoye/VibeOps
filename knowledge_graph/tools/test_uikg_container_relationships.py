from knowledge_graph.tools.materialize_special_follow_graph import rebuild_element_relationships
from knowledge_graph.tools.validate_normalized_zto_graph import terminal_owner, validate_compositions


def make_element(key, element_id, owner, parent=None, relationships=None, children=None):
    element = {
        "id": element_id,
        "key": key,
        "owner": owner,
        "parentElementRef": parent,
        "relationshipRefs": list(relationships or []),
    }
    if children is not None:
        element["childElementRefs"] = list(children)
    return element


def make_composition_member(key, element_id, parent_id, actionable, capabilities=None, rect=None):
    element = {
        "id": element_id,
        "key": key,
        "owner": {"kind": "component", "ref": parent_id},
        "parentElementRef": parent_id,
        "elementType": "control",
        "role": "member",
        "capabilities": list(capabilities or []),
        "interactionBoundary": {"actionable": actionable, "function": key},
        "relationshipRefs": [f"owner:{parent_id}", f"parent:{parent_id}"],
    }
    if rect is not None:
        element["observations"] = [
            {
                "frameRef": "FRAME",
                "locator": {"rect": dict(zip(("left", "top", "width", "height"), rect))},
                "redboxRef": f"assets/{element_id}.png",
            }
        ]
    return element


def make_composition_container(profile, roles, children, actionable=False, capabilities=None):
    return {
        "id": "ROW",
        "key": f"settings.{profile}",
        "owner": {"kind": "page", "ref": "PAGE"},
        "parentElementRef": None,
        "elementType": "container",
        "role": "setting_group",
        "capabilities": list(capabilities or []),
        "interactionBoundary": {"actionable": actionable, "function": profile},
        "relationshipRefs": ["owner:PAGE"] + [f"child:{child}" for child in children],
        "childElementRefs": list(children),
        "composition": {"profile": profile, "roles": roles},
    }


def test_rebuilds_local_and_shared_container_relationships_identically():
    page_root = make_element(
        "page.container",
        "PAGE_ROOT",
        {"kind": "page", "ref": "PAGE"},
        relationships=["transition:LOCAL"],
    )
    page_child = make_element(
        "page.container.trigger",
        "PAGE_CHILD",
        {"kind": "component", "ref": "PAGE_ROOT"},
        parent="PAGE_ROOT",
    )
    shared_root = make_element(
        "shared.navigation",
        "SHARED_ROOT",
        {"kind": "application", "ref": "APP"},
    )
    shared_child = make_element(
        "shared.navigation.more",
        "SHARED_CHILD",
        {"kind": "shared_component", "ref": "SHARED_ROOT"},
        parent="SHARED_ROOT",
    )
    shared_grandchild = make_element(
        "shared.navigation.more.entry",
        "SHARED_GRANDCHILD",
        {"kind": "shared_component", "ref": "SHARED_CHILD"},
        parent="SHARED_CHILD",
    )
    elements = {
        element["key"]: element
        for element in (page_root, page_child, shared_root, shared_child, shared_grandchild)
    }

    rebuild_element_relationships(elements)

    assert page_root["childElementRefs"] == ["PAGE_CHILD"]
    assert "child:PAGE_CHILD" in page_root["relationshipRefs"]
    assert "transition:LOCAL" in page_root["relationshipRefs"]
    assert page_child["relationshipRefs"] == ["owner:PAGE_ROOT", "parent:PAGE_ROOT"]
    assert shared_root["childElementRefs"] == ["SHARED_CHILD"]
    assert "child:SHARED_CHILD" in shared_root["relationshipRefs"]
    assert shared_child["childElementRefs"] == ["SHARED_GRANDCHILD"]
    assert "child:SHARED_GRANDCHILD" in shared_child["relationshipRefs"]


def test_terminal_owner_distinguishes_page_and_application_scope_and_detects_cycles():
    page_root = make_element("page.root", "PAGE_ROOT", {"kind": "page", "ref": "PAGE"})
    page_child = make_element(
        "page.child",
        "PAGE_CHILD",
        {"kind": "component", "ref": "PAGE_ROOT"},
        parent="PAGE_ROOT",
    )
    shared_root = make_element("shared.root", "SHARED_ROOT", {"kind": "application", "ref": "APP"})
    shared_child = make_element(
        "shared.child",
        "SHARED_CHILD",
        {"kind": "shared_component", "ref": "SHARED_ROOT"},
        parent="SHARED_ROOT",
    )
    cycle_a = make_element("cycle.a", "CYCLE_A", {"kind": "component", "ref": "CYCLE_B"}, parent="CYCLE_B")
    cycle_b = make_element("cycle.b", "CYCLE_B", {"kind": "component", "ref": "CYCLE_A"}, parent="CYCLE_A")
    by_id = {
        element["id"]: element
        for element in (page_root, page_child, shared_root, shared_child, cycle_a, cycle_b)
    }

    assert terminal_owner(page_child, by_id) == ("page", "PAGE", None)
    assert terminal_owner(shared_child, by_id) == ("application", "APP", None)
    assert terminal_owner(cycle_a, by_id) == (None, None, "owner cycle")


def test_toggle_row_profile_accepts_only_its_own_required_and_optional_roles():
    row = make_composition_container(
        "toggle_row",
        {"label": "LABEL", "secondaryText": "SECONDARY", "settingControl": "CONTROL"},
        ["LABEL", "SECONDARY", "CONTROL"],
    )
    elements = [
        row,
        make_composition_member("label", "LABEL", "ROW", False),
        make_composition_member("secondary", "SECONDARY", "ROW", False),
        make_composition_member("toggle", "CONTROL", "ROW", True, ["toggle_setting"]),
    ]

    assert validate_compositions(elements) == []


def test_selector_row_profile_accepts_evidence_backed_container_self_trigger():
    row = make_composition_container(
        "selector_row",
        {
            "label": "LABEL",
            "currentValue": "VALUE",
            "settingTrigger": "ROW",
            "affordance": "CHEVRON",
        },
        ["LABEL", "VALUE", "CHEVRON"],
        actionable=True,
        capabilities=["open_selector"],
    )
    elements = [
        row,
        make_composition_member("label", "LABEL", "ROW", False),
        make_composition_member("value", "VALUE", "ROW", False),
        make_composition_member("chevron", "CHEVRON", "ROW", False),
    ]
    transitions = [{"key": "open.selector", "triggerElementRef": "ROW", "capability": "open_selector"}]

    assert validate_compositions(elements, transitions) == []


def test_help_toggle_row_profile_keeps_help_and_setting_as_independent_triggers():
    row = make_composition_container(
        "help_toggle_row",
        {
            "label": "LABEL",
            "helpTrigger": "HELP",
            "helpPopover": "POPOVER",
            "settingControl": "CONTROL",
        },
        ["LABEL", "HELP", "POPOVER", "CONTROL"],
    )
    elements = [
        row,
        make_composition_member("label", "LABEL", "ROW", False),
        make_composition_member("help", "HELP", "ROW", True, ["open_help"]),
        make_composition_member("popover", "POPOVER", "ROW", False),
        make_composition_member("toggle", "CONTROL", "ROW", True, ["toggle_setting"]),
    ]
    transitions = [
        {"key": "open.help", "triggerElementRef": "HELP", "capability": "open_help"},
        {"key": "toggle.setting", "triggerElementRef": "CONTROL", "capability": "toggle_setting"},
    ]

    assert validate_compositions(elements, transitions) == []


def test_action_row_profile_keeps_explanation_non_actionable():
    row = make_composition_container(
        "action_row",
        {"explanatoryContent": "EXPLANATION", "actionTrigger": "TRIGGER"},
        ["EXPLANATION", "TRIGGER"],
    )
    elements = [
        row,
        make_composition_member("explanation", "EXPLANATION", "ROW", False),
        make_composition_member("trigger", "TRIGGER", "ROW", True, ["open_target"]),
    ]

    assert validate_compositions(elements) == []


def test_generic_composite_can_use_the_container_and_a_child_as_distinct_triggers():
    container = make_composition_container("unused", {}, ["REMOVE"], True, ["activate_row"])
    container["composition"] = {
        "roles": {"memberTrigger": "ROW", "removeTrigger": "REMOVE"}
    }
    remove = make_composition_member("remove", "REMOVE", "ROW", True, ["remove_member"])

    assert validate_compositions([container, remove]) == []


def test_flat_page_owned_setting_row_is_rejected():
    flat = {
        "id": "FLAT",
        "key": "settings.flat",
        "owner": {"kind": "page", "ref": "PAGE"},
        "elementType": "toggle",
        "role": "setting",
    }

    assert any("flat Page-owned setting row" in error for error in validate_compositions([flat]))


def test_different_semantic_members_cannot_reuse_one_locator():
    row = make_composition_container(
        "action_row",
        {"explanatoryContent": "EXPLANATION", "actionTrigger": "TRIGGER"},
        ["EXPLANATION", "TRIGGER"],
    )
    explanation = make_composition_member("explanation", "EXPLANATION", "ROW", False, rect=(1, 2, 3, 4))
    trigger = make_composition_member("trigger", "TRIGGER", "ROW", True, ["open_target"], rect=(1, 2, 3, 4))

    assert any("reuses locator" in error for error in validate_compositions([row, explanation, trigger]))
