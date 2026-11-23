"""Apply hash-anchored S01-only compatibility edits to exported upstream files."""
import hashlib, json, pathlib, sys
root = pathlib.Path(sys.argv[1]).resolve()
spec = json.loads(pathlib.Path(sys.argv[2]).read_text(encoding='utf-8-sig'))
for item in spec['files']:
    target = (root / item['path']).resolve()
    if not target.is_relative_to(root):
        raise RuntimeError('Patch escaped source root')
    data = target.read_bytes()
    if hashlib.sha256(data).hexdigest() != item['originalSha256']:
        raise RuntimeError(f'Original source hash mismatch: {item["path"]}')
    for edit in sorted(item['edits'], key=lambda e: e['start'], reverse=True):
        data = data[:edit['start']] + edit['text'].encode('utf-8') + data[edit['end']:]
    if hashlib.sha256(data).hexdigest() != item['patchedSha256']:
        raise RuntimeError('Patched source hash mismatch')
    target.write_bytes(data)
    print(item['path'], item['patchedSha256'])
