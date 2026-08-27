import hashlib
from pathlib import Path

def sha256_file(path):
    path = Path(path)
    h = hashlib.sha256()
    with open(path, "rb") as f:
        while True:
            b = f.read(1024 * 1024)
            if not b:
                break
            h.update(b)
    return h.hexdigest().upper()

def verify_file_sha(path, expected_sha):
    actual = sha256_file(path)
    assert actual.upper() == expected_sha.upper(), f"SHA mismatch on {path}: expected {expected_sha}, got {actual}"
    return True
