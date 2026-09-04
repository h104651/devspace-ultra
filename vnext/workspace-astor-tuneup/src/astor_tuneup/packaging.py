import json
import zipfile
from pathlib import Path

def create_human_review_pack(candidates, output_zip_path):
    with zipfile.ZipFile(output_zip_path, "w") as z:
        manifest = {"candidates": len(candidates)}
        z.writestr("manifest.json", json.dumps(manifest, indent=2))
    return output_zip_path
