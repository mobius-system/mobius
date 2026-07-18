#!/usr/bin/env bash
# install-dummy-bash-cmd-list.bash
#
#
#
#   bash /home/alice/project/install-dummy-bash-cmd-list.bash
#
#

set -euo pipefail

PREFIX="${PREFIX:-$HOME/.local/bin}"

LEGACY_CMDS=(
  display_image
)

mkdir -p "$PREFIX"

for old in "${LEGACY_CMDS[@]}"; do
  if [[ -e "$PREFIX/$old" ]]; then
    rm -f "$PREFIX/$old"
    echo "removed legacy command: $PREFIX/$old"
  fi
done

target="$PREFIX/display_images"
cat > "$target" <<'SCRIPT'
#!/usr/bin/env bash
set -euo pipefail

prog="$(basename "$0")"

usage() {
  cat <<USAGE
Usage: $prog [options] <image1> [image2 ...]

  Mark one or more images as displayed to the user.
  This is a placeholder implementation: it does not render images, and only prints one status line per image.

  Important: image paths must be absolute paths (starting with /),
     or URLs starting with http:// or https://. Relative paths are rejected.

Arguments:
  <imageN>      absolute image path (starting with /) or http(s) URL

Options:
  -h, --help    show this help and exit

Examples:
  $prog /home/alice/pics/cat.png
  $prog /home/alice/pics/a.png /home/alice/pics/b.jpg
  $prog https://example.com/photo.jpg
USAGE
}

case "${1:-}" in
  -h|--help)
    usage
    exit 0
    ;;
  "")
    echo "ERROR: no image arguments provided" >&2
    echo >&2
    usage >&2
    exit 1
    ;;
esac

for img in "$@"; do
  case "$img" in
    /*|http://*|https://*) ;;
    *)
      echo "ERROR: path must be absolute (starting with /) or an http(s) URL: $img" >&2
      exit 2
      ;;
  esac
done

for img in "$@"; do
  echo "Image has been displayed to user: $img"
done
SCRIPT
chmod 755 "$target"
echo "installed: $target"

echo
echo "Done. Verification examples:"
echo "  display_images /tmp/cat.png          # -> Image has been displayed to user: /tmp/cat.png"
echo "  display_images /tmp/a.png /tmp/b.jpg
echo "  display_images --help

case ":$PATH:" in
  *":$PREFIX:"*) ;;
  *) echo
     echo "Note: \$PATH does not contain $PREFIX; add this to your shell configuration:"
     echo "  export PATH=\"$PREFIX:\$PATH\"" ;;
esac
