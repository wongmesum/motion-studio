#!/bin/bash
set -e

echo "📦 Building motion-studio.zip..."

if command -v zip &>/dev/null; then
  zip -r motion-studio.zip . \
    -x "*.git*" \
    -x "node_modules/*" \
    -x "*/node_modules/*" \
    -x "frames/*" \
    -x "output/*.mp4" \
    -x "cache/*" \
    -x "*.zip"
  echo "✅ Done: motion-studio.zip ($(du -h motion-studio.zip | cut -f1))"
else
  echo "⚠️ 'zip' command not found, trying tar/python fallback..."
  python3 -c "
import zipfile, os
exclude_dirs = {'.git', 'node_modules', 'frames', 'cache'}
with zipfile.ZipFile('motion-studio.zip', 'w', zipfile.ZIP_DEFLATED) as zf:
    for root, dirs, files in os.walk('.'):
        dirs[:] = [d for d in dirs if d not in exclude_dirs]
        for file in files:
            if file.endswith('.zip'): continue
            full_path = os.path.join(root, file)
            zf.write(full_path, os.path.relpath(full_path, '.'))
print('✅ Done: motion-studio.zip')
"
fi
