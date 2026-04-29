const colorEnabled = Boolean(
  process.stdout.isTTY && Bun.env.NO_COLOR === undefined && Bun.env.TERM !== "dumb",
);
const reportedBackground = Bun.env.COLORFGBG?.split(";").at(-1);
const themeOverride = Bun.env.CODING_AGENT_THEME;
const lightBackground = themeOverride === "light" ||
  (themeOverride !== "dark" && (reportedBackground === "7" || reportedBackground === "15"));
const colors = lightBackground
  ? { label: "34", approval: "33", success: "32", error: "31", added: "32", removed: "31" }
  : { label: "96", approval: "93", success: "92", error: "91", added: "92", removed: "91" };

function color(code: string, text: string): string {
  return colorEnabled ? `\u001b[${code}m${text}\u001b[0m` : text;
}

export const terminalStyle = {
  label: (text: string) => color(colors.label, text),
  approval: (text: string) => color(colors.approval, text),
  success: (text: string) => color(colors.success, text),
  error: (text: string) => color(colors.error, text),
  muted: (text: string) => text,
  path: (text: string) => color(colors.label, text),
  prompt: (text: string) => color(colors.label, text),
};

export function colorizeDiff(diff: string): string {
  if (!colorEnabled) return diff;
  return diff.split("\n").map((line) => {
    if (line.startsWith("+++ ")) return color(colors.added, line);
    if (line.startsWith("--- ")) return color(colors.removed, line);
    if (line.startsWith("@@")) return color(colors.label, line);
    if (line.startsWith("+")) return color(colors.added, line);
    if (line.startsWith("-")) return color(colors.removed, line);
    if (line.startsWith("…")) return color(colors.approval, line);
    return line;
  }).join("\n");
}
