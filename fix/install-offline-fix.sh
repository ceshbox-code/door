#!/bin/sh
# Копирует 3 изменённых файла фронтенда в /volume1/docker/door/public. Контейнеры, БД и данные не затрагиваются.
set -e
SRC="$(cd "$(dirname "$0")" && pwd)/public"
DST="/volume1/docker/door/public"
[ -d "$DST" ] || { echo "Нет каталога $DST"; exit 1; }
cp "$SRC/js/offline.js" "$DST/js/offline.js"
cp "$SRC/index.html"    "$DST/index.html"
cp "$SRC/sw.js"         "$DST/sw.js"
echo "Готово. На телефоне закройте и откройте приложение (обновится кэш)."
