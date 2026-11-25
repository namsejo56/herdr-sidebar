"""Install the layout and mods into a Herdr App home without replacing files."""

import argparse
import os
import shutil
from contextlib import ExitStack
from pathlib import Path


ROOT = Path(__file__).resolve().parent
LAYOUT = Path("layouts/native-agent-view.json")
MOD_FILE_EXTENSIONS = {".js", ".json", ".py", ".svg"}


def package_files():
    yield LAYOUT
    for folder in sorted((ROOT / "mods").iterdir()):
        if (folder / "main.js").is_file():
            for source in sorted(folder.iterdir()):
                if (
                    source.is_file()
                    and source.suffix in MOD_FILE_EXTENSIONS
                    and source.name != "jsconfig.json"
                ):
                    yield source.relative_to(ROOT)


def plan_install(home):
    missing = []
    conflicts = []
    for relative in package_files():
        target = home / relative
        for directory in (home / parent for parent in reversed(relative.parents)):
            if (
                directory.is_symlink()
                or directory.is_junction()
                or (directory.exists() and not directory.is_dir())
            ):
                conflicts.append(f"{directory} is not a regular directory")
                break
        else:
            if target.is_symlink() or target.is_junction():
                conflicts.append(f"{target} is a link")
            elif not target.exists():
                missing.append(relative)
            elif not target.is_file() or target.read_bytes() != (ROOT / relative).read_bytes():
                conflicts.append(f"{target} differs from the package")
    return missing, sorted(set(conflicts))


def install_missing(home, missing):
    with ExitStack() as rollback:
        for relative in missing:
            source = ROOT / relative
            target = home / relative
            absent = []
            for parent in target.parents:
                if parent.exists():
                    break
                absent.append(parent)
            for parent in reversed(absent):
                parent.mkdir()
                rollback.callback(parent.rmdir)
            with source.open("rb") as input_file, target.open("xb") as output_file:
                rollback.callback(target.unlink)
                shutil.copyfileobj(input_file, output_file)
        rollback.pop_all()


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    default_home = os.environ.get("HERDR_APP_HOME") or Path.home() / ".config" / "herdr-app"
    parser.add_argument("--app-home", type=Path, default=Path(default_home))
    parser.add_argument("--dry-run", action="store_true", help="check destinations without copying")
    args = parser.parse_args()
    home = args.app_home.expanduser().absolute()

    try:
        missing, conflicts = plan_install(home)
        if conflicts:
            parser.exit(1, "Installation stopped before copying files:\n" + "\n".join(conflicts) + "\n")
        if not missing:
            print(f"All layout and mod files already match {home}.")
        elif args.dry_run:
            for relative in missing:
                print(f"Would install {home / relative}")
        else:
            install_missing(home, missing)
            print(f"Installed {len(missing)} files into {home}.")
    except OSError as error:
        parser.exit(1, f"Installation failed: {error}\n")


if __name__ == "__main__":
    main()
