import { describe, expect, it } from "vitest";

import enUS from "../locales/en-US";
import zhCN from "../locales/zh-CN";
import { locale, resolveLocale, t } from "./i18n";

describe("web i18n", () => {
  it("selects Chinese for Chinese browser locales and English otherwise", () => {
    expect(resolveLocale("zh-CN")).toBe("zh-CN");
    expect(resolveLocale("zh-TW")).toBe("zh-CN");
    expect(resolveLocale("en-US")).toBe("en-US");
  });

  it("keeps every supported locale aligned with the source message keys", () => {
    expect(Object.keys(enUS).sort()).toEqual(Object.keys(zhCN).sort());
    expect(t("auth.serverUnavailableCached", "en-US")).toContain("server");
    expect(t("auth.serverUnavailableCached", "zh-CN")).toContain("服务器");
    expect(document.documentElement.lang).toBe(locale);
  });
});
