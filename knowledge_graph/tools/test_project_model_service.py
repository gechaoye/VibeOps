import tempfile
import unittest
from pathlib import Path

import yaml

from project_model_service import public_payload, save


class ProjectModelServiceTest(unittest.TestCase):
    def setUp(self):
        self.temporary = tempfile.TemporaryDirectory()
        self.root = Path(self.temporary.name)
        (self.root / "model").mkdir()
        (self.root / "projects/baohe").mkdir(parents=True)
        (self.root / "spec/schemas").mkdir(parents=True)
        source_root = Path(__file__).resolve().parents[1]
        for relative in (
            "model/core.yaml",
            "projects/baohe/model.yaml",
            "spec/schemas/vibeops-model.schema.json",
        ):
            target = self.root / relative
            target.write_bytes((source_root / relative).read_bytes())

    def tearDown(self):
        self.temporary.cleanup()

    def test_save_adds_field_and_increments_version(self):
        model = public_payload(self.root, "baohe")["project"]
        model["fields"].append({
            "key": "businessPriority",
            "label": "业务优先级",
            "appliesTo": ["Function"],
            "valueType": "string",
        })
        result = save(self.root, "baohe", {"model": model})
        self.assertEqual(result["effectiveModelVersion"], "baohe@1.0.1")
        saved = yaml.safe_load((self.root / "projects/baohe/model.yaml").read_text(encoding="utf-8"))
        self.assertIn("businessPriority", {field["key"] for field in saved["fields"]})

    def test_save_rejects_unknown_entity_type(self):
        model = public_payload(self.root, "baohe")["project"]
        model["fields"].append({
            "key": "invalidField",
            "appliesTo": ["MissingType"],
            "valueType": "string",
        })
        with self.assertRaisesRegex(ValueError, "unknown entity types"):
            save(self.root, "baohe", {"model": model})


if __name__ == "__main__":
    unittest.main()
