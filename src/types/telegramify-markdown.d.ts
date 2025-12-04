declare module "telegramify-markdown" {
  type UnsupportedTagsStrategy = "escape" | "remove" | "keep";

  export default function telegramifyMarkdown(
    markdown: string,
    unsupportedTagsStrategy?: UnsupportedTagsStrategy,
  ): string;
}
