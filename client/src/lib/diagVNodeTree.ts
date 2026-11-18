/**
 * Temporary on-device diagnostics: dump the vnode block tree of a crashed
 * component. The iOS-only "Maximum call stack size exceeded" crash loops
 * through patch -> processElement -> patchElement -> patchBlockChildren, which
 * is only possible if a vnode's dynamicChildren contain one of its own
 * ancestors (a cycle) or the same vnode/array appears twice (shared
 * structure). Walking the tree with identity sets names the exact vnode that
 * closes the loop.
 *
 * TODO: remove once the root cause is fixed and verified on device.
 */

type VNodeLike = {
  type?: unknown;
  key?: unknown;
  patchFlag?: unknown;
  shapeFlag?: unknown;
  el?: unknown;
  component?: { uid?: unknown; subTree?: unknown; type?: unknown } | null;
  dynamicChildren?: unknown;
};

function typeLabel(type: unknown): string {
  if (typeof type === "string") return type;
  if (typeof type === "symbol") return type.description ?? type.toString();
  if (typeof type === "function") {
    const fn = type as { displayName?: unknown; __name?: unknown; name?: unknown };
    return `C:${String(fn.displayName ?? fn.__name ?? fn.name ?? "fn")}`;
  }
  if (type && typeof type === "object") {
    const record = type as { __name?: unknown; name?: unknown };
    return `C:${String(record.__name ?? record.name ?? "obj")}`;
  }
  return String(type);
}

function elLabel(el: unknown): string {
  if (!el || typeof el !== "object") return "";
  const node = el as { tagName?: unknown; nodeType?: unknown };
  if (typeof node.tagName === "string") return node.tagName.toLowerCase();
  if (typeof node.nodeType === "number") return `n${node.nodeType}`;
  return "";
}

export function dumpVNodeBlockTree(root: unknown, maxLines = 40): string {
  const seenVnodes = new Set<object>();
  const seenArrays = new Set<object>();
  const lines: string[] = [];
  let hitLimit = false;

  const visit = (vnode: unknown, path: string, depth: number): void => {
    if (hitLimit) return;
    if (lines.length >= maxLines || depth > 100) {
      hitLimit = true;
      lines.push("…");
      return;
    }
    if (!vnode || typeof vnode !== "object") {
      lines.push(`${path}#${String(vnode)}`);
      return;
    }
    const vn = vnode as VNodeLike;
    const dup = seenVnodes.has(vn);
    const bits: string[] = [typeLabel(vn.type)];
    if (vn.key != null) bits.push(`k=${String(vn.key).slice(0, 24)}`);
    const patchFlag = Number(vn.patchFlag);
    if (Number.isFinite(patchFlag) && patchFlag > 0) bits.push(`pf=${patchFlag}`);
    const dc = Array.isArray(vn.dynamicChildren) ? (vn.dynamicChildren as unknown[]) : null;
    if (dc) bits.push(`dc=${dc.length}`);
    const el = elLabel(vn.el);
    if (el) bits.push(`el=${el}`);
    else if (vn.el === null) bits.push("el=NULL");
    lines.push(`${path} ${bits.join(" ")}${dup ? " ⟳CYCLE" : ""}`);
    if (dup) return;
    seenVnodes.add(vn);

    if (dc && dc.length > 0) {
      if (seenArrays.has(dc)) {
        lines.push(`${path}.dc ⟳SHARED-ARRAY`);
      } else {
        seenArrays.add(dc);
        for (let i = 0; i < dc.length; i += 1) {
          visit(dc[i], `${path}.${i}`, depth + 1);
          if (hitLimit) return;
        }
      }
    }
    // A component child updates synchronously inside this patch, so the
    // recursion the stack shows can pass through component subTrees too.
    const component = vn.component;
    if (component && typeof component === "object" && component.subTree) {
      visit(component.subTree, `${path}§`, depth + 1);
    }
  };

  visit(root, "r", 0);
  return lines.join(" / ");
}

export function resolveInternalInstance(instance: unknown): { subTree?: unknown; root?: { subTree?: unknown } } | null {
  if (!instance || typeof instance !== "object") return null;
  // errorHandler receives the public proxy; internals live under `$`.
  const proxy = instance as { $?: unknown };
  const internal = proxy.$ && typeof proxy.$ === "object" ? proxy.$ : instance;
  return internal as { subTree?: unknown; root?: { subTree?: unknown } };
}

/**
 * Dump the crashed component's block tree first; if nothing anomalous shows
 * up there, fall back to the app root tree. The anomaly markers are what the
 * on-device report needs to keep intact.
 */
export function dumpCrashTrees(instance: unknown): string {
  try {
    const internal = resolveInternalInstance(instance);
    if (!internal) return "";
    const own = internal.subTree ? dumpVNodeBlockTree(internal.subTree) : "";
    if (!own) return "";
    if (own.includes("⟳") || !internal.root || internal.root.subTree === internal.subTree) {
      return `subTree: ${own}`;
    }
    const rootDump = internal.root.subTree ? dumpVNodeBlockTree(internal.root.subTree, 80) : "";
    return rootDump ? `subTree: ${own} || root: ${rootDump}` : `subTree: ${own}`;
  } catch (error) {
    return `dump失败: ${error instanceof Error ? error.message : String(error)}`;
  }
}
