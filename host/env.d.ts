// bunfig loads .md as text (loader ".md" = "text"); prompt files are imported for their string default export.
declare module "*.md" {
  const text: string;
  export default text;
}
