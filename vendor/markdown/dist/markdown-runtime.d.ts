declare global {
  var AedMarkdown: { renderMarkdown(src: string): { html: string; headings: { level: number; text: string; id: string }[] }; buildId: string };
}
export {};
