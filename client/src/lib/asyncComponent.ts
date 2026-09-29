import { defineAsyncComponent, h } from "vue";
import type { Component } from "vue";

type AsyncModule<T extends Component> = T | { default: T };

// Feature-boundary code splitting. A deploy replaces hashed chunks under open
// tabs, so a failed dynamic import is retried once before falling back to an
// inline reload prompt instead of leaving a blank panel.
export function lazyComponent<T extends Component>(loader: () => Promise<AsyncModule<T>>): T {
  return defineAsyncComponent({
    loader: loader as () => Promise<Component>,
    errorComponent: {
      name: "LazyChunkError",
      setup: () => () =>
        h("div", { class: "lazyChunkError", role: "alert" }, [
          h("span", { class: "lazyChunkErrorText" }, "内容加载失败，请刷新页面重试。"),
          h(
            "button",
            { class: "lazyChunkErrorReload", type: "button", onClick: () => window.location.reload() },
            "刷新",
          ),
        ]),
    },
    onError(_error, retry, fail, attempts) {
      if (attempts <= 1) {
        retry();
      } else {
        fail();
      }
    },
  }) as unknown as T;
}
