"""Static code dependencies of a pipeline function, for cache keys.

`code_fingerprint(entries)` answers "which source text can change what these functions compute?" without
running them:

  - In each entry function's own module, only the top-level definitions the function reaches are
    hashed: the function itself, the helpers and constants it names (transitively), and the name ->
    module map of the imports it uses. So a change to `process_roads` leaves the `buildings` key alone
    even though both live in `process.py`.
  - Every *other* local pipeline module reached (through those imports, and then their imports, and so
    on) is hashed as a whole file. Those modules are small and cohesive (`heights.py`, `lidar.py`...)
    and whole-file hashing keeps the analysis simple and safe.
  - `config.py` is always included: every module reads it at import time.

Names are resolved from `ast`, which is exact for the ordinary code this package is written in. The
patterns it cannot see (`from x import *`, `globals()`, `eval`, `importlib`) are rejected by
`pipeline/tests/test_deps.py` so they cannot creep in and leave a key stale.
"""
from __future__ import annotations

import ast
import hashlib
import inspect
from functools import lru_cache
from pathlib import Path

PIPELINE_DIR = Path(__file__).resolve().parent
ALWAYS = ("config",)


@lru_cache(maxsize=None)
def _module_info(name: str):
    """Parsed module: source, tree, top-level defs, import map (binding -> (module, target))."""
    path = PIPELINE_DIR / f"{name}.py"
    src = path.read_text()
    tree = ast.parse(src)
    defs: dict[str, ast.AST] = {}
    imports: dict[str, tuple[str, str]] = {}
    for node in tree.body:
        if isinstance(node, (ast.FunctionDef, ast.AsyncFunctionDef, ast.ClassDef)):
            defs[node.name] = node
        elif isinstance(node, ast.Assign):
            for t in node.targets:
                for n in ast.walk(t):
                    if isinstance(n, ast.Name):
                        defs[n.id] = node
        elif isinstance(node, (ast.AnnAssign, ast.AugAssign)) and isinstance(node.target, ast.Name):
            defs[node.target.id] = node
        elif isinstance(node, ast.ImportFrom) and node.module and node.level == 0:
            root = node.module.split(".")[0]
            if is_local(root):
                for a in node.names:
                    imports[a.asname or a.name] = (root, f"{node.module}:{a.name}")
        elif isinstance(node, ast.Import):
            for a in node.names:
                root = a.name.split(".")[0]
                if is_local(root):
                    imports[a.asname or root] = (root, a.name)
    return src, tree, defs, imports


def is_local(module: str) -> bool:
    return "." not in module and (PIPELINE_DIR / f"{module}.py").exists()


def _local_module_of(fn) -> str | None:
    """Pipeline module for a callable, including a file executed directly as ``__main__``."""
    if is_local(fn.__module__):
        return fn.__module__
    source = inspect.getsourcefile(fn)
    if source:
        path = Path(source).resolve()
        if path.parent == PIPELINE_DIR.resolve() and is_local(path.stem):
            return path.stem
    return None


def _nested_imports(node: ast.AST) -> set[str]:
    """Local modules imported inside a function body (`from hydro import merge_water`)."""
    out = set()
    for sub in ast.walk(node):
        if isinstance(sub, ast.ImportFrom) and sub.module and sub.level == 0:
            root = sub.module.split(".")[0]
            if is_local(root):
                out.add(root)
        elif isinstance(sub, ast.Import):
            for a in sub.names:
                root = a.name.split(".")[0]
                if is_local(root):
                    out.add(root)
    return out


def _reach(module: str, roots: list[str]) -> tuple[list[str], dict[str, str], set[str]]:
    """Top-level defs reached from `roots` in `module`, the imports they use, and other local modules."""
    src, tree, defs, imports = _module_info(module)
    seen: list[str] = []
    used_imports: dict[str, str] = {}
    modules: set[str] = set()
    stack = [r for r in roots if r in defs]
    missing = [r for r in roots if r not in defs]
    if missing:
        raise KeyError(f"{module}.py has no top-level definition named {missing}")
    while stack:
        name = stack.pop()
        if name in seen:
            continue
        seen.append(name)
        node = defs[name]
        modules |= _nested_imports(node)
        for sub in ast.walk(node):
            ident = None
            if isinstance(sub, ast.Name):
                ident = sub.id
            elif isinstance(sub, ast.Attribute) and isinstance(sub.value, ast.Name):
                ident = sub.value.id
            if ident is None:
                continue
            if ident in imports:
                imported_module, target = imports[ident]
                used_imports[ident] = target
                modules.add(imported_module)
            elif ident in defs and ident not in seen:
                stack.append(ident)
    return sorted(seen), used_imports, modules


@lru_cache(maxsize=None)
def module_closure(module: str) -> frozenset[str]:
    """`module` plus every local module it imports, transitively (top-level or nested imports)."""
    out: set[str] = set()
    stack = [module]
    while stack:
        m = stack.pop()
        if m in out:
            continue
        out.add(m)
        _, tree, _, imports = _module_info(m)
        stack.extend({module for module, _ in imports.values()} | _nested_imports(tree))
    return frozenset(out)


def _file_digest(module: str) -> str:
    return hashlib.sha1((PIPELINE_DIR / f"{module}.py").read_bytes()).hexdigest()[:16]


def _partial_fingerprint(module: str, names: list[str], used_imports: dict[str, str]) -> dict:
    src, _, defs, _ = _module_info(module)
    segments = [ast.get_source_segment(src, defs[name]) or "" for name in names]
    return {
        "defs": names,
        "imports": dict(sorted(used_imports.items())),
        "digest": hashlib.sha1("\n".join(segments).encode()).hexdigest()[:16],
    }


def code_fingerprint(entries: tuple, modules: tuple[str, ...] = ()) -> dict:
    """Stable description of the code `entries` (functions) and `modules` (whole files) depend on.

    Returns a JSON-able dict; put it in a cache key. Whole-file digests use content, not mtimes, so a
    `git checkout` that restores identical text keeps the cache warm.
    """
    by_module: dict[str, list[str]] = {}
    for fn in entries:
        mod = _local_module_of(fn)
        if mod is None:
            raise ValueError(f"{fn!r} is not a pipeline module function")
        by_module.setdefault(mod, []).append(fn.__name__)
    partial: dict[str, dict] = {}
    whole: set[str] = set(modules) | set(ALWAYS)
    for mod, roots in by_module.items():
        names, used_imports, reached = _reach(mod, roots)
        partial[mod] = _partial_fingerprint(mod, names, used_imports)
        for m in reached:
            if m != mod:
                whole |= module_closure(m)
    # a module hashed as a whole must not also be hashed partially: whole wins (it is the superset)
    for mod in list(partial):
        if mod in whole:
            partial.pop(mod)
    return {"partial": partial, "whole": {m: _file_digest(m) for m in sorted(whole)}}


def clear_caches() -> None:
    """Forget parsed modules (tests edit files between calls; a build parses each module once)."""
    _module_info.cache_clear()
    module_closure.cache_clear()


def source_of(fn) -> str:
    """Source text of a function, for hashing a step's own glue code."""
    return inspect.getsource(fn)


def glue_fingerprint(fn) -> dict | str:
    """Fingerprint glue plus same-module helpers, without pulling imported processors in whole.

    Step registry entries fingerprint the imported processor functions precisely. Glue still needs to
    follow helpers such as ``_concat`` in its own module; hashing only ``inspect.getsource(fn)`` misses
    those edits. Test-local callables fall back to their direct source because they are outside pipeline/.
    """
    module = _local_module_of(fn)
    if module is None:
        return source_of(fn)
    names, used_imports, _ = _reach(module, [fn.__name__])
    return _partial_fingerprint(module, names, used_imports)
