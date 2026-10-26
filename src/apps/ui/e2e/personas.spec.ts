import { readFileSync } from "node:fs";
import { expect, test } from "./fixtures";

// Screen 1 over the real bridge: the seeded project's layer stack in merge order, the resolved
// persona by field group, "Explain" on values, and "Open in editor" through `/v1/open` into a
// fake $VISUAL.

/** The lines of the fake editor's log (none until it first runs). */
function lines(log: string): string[] {
  try {
    return readFileSync(log, "utf8").split("\n").filter(Boolean);
  } catch {
    return [];
  }
}

test("lists the layers in merge order", async ({ page, signIn }) => {
  await page.goto(signIn);
  const layers = page.getByRole("list", { name: "Layers" });
  await expect(layers.getByRole("listitem")).toHaveText([
    /org\/base/,
    /area\/fintech/,
    /team\/payments/,
    /project\/persona/,
    /user\/overrides/,
  ]);
});

test("explains a value: its layer, what it overrode and its lock", async ({
  page,
  signIn,
}) => {
  await page.goto(signIn);
  // team/payments set pr-review over org/base.
  const skill = page.getByRole("listitem").filter({ hasText: "pr-review" });
  await skill.getByRole("button", { name: "Explain" }).click();
  const popover = page.getByRole("dialog", { name: "Explain pr-review" });
  await expect(popover).toContainText("Set by team/payments");
  await expect(popover).toContainText("Overrode org/base");
  await page.keyboard.press("Escape");

  // org/base set the deny rule and locks permissions.deny.
  const rule = page.getByRole("listitem").filter({ hasText: "Bash(rm -rf:*)" });
  await rule.getByRole("button", { name: "Explain" }).click();
  const locked = page.getByRole("dialog", {
    name: "Explain Bash(rm -rf:*)",
  });
  await expect(locked).toContainText("Set by org/base");
  await expect(locked).toContainText("Locked by org/base");
  await expect(locked).toContainText("permissions.deny");
});

test("shows secret refs once each, never values", async ({ page, signIn }) => {
  await page.goto(signIn);
  const secrets = page.getByRole("region", { name: "Secrets (refs only)" });
  await expect(secrets).toContainText("secret://vault/payments/schema-token");
  // The ledger server names this ref twice: one row.
  await expect(secrets.getByText("secret://vault/ledger")).toHaveCount(1);
});

test("the persona switcher offers the stored personas", async ({
  page,
  signIn,
}) => {
  await page.goto(signIn);
  await page.getByRole("combobox", { name: "Preview as" }).click();
  for (const ref of ["org/base", "area/fintech", "team/payments"]) {
    await expect(page.getByRole("option", { name: ref })).toBeVisible();
  }
});

test("Open in editor opens every layer's file", async ({
  page,
  signIn,
  donn,
}) => {
  await page.goto(signIn);
  const files: Record<string, string> = {
    "org/base": `${donn.personas}/org/base.yaml`,
    "area/fintech": `${donn.personas}/area/fintech.yaml`,
    "team/payments": `${donn.personas}/team/payments.yaml`,
    "project/persona": `${donn.repo}/.donn/persona.yaml`,
    "user/overrides": `${donn.home}/overrides.yaml`,
  };
  const layers = page.getByRole("list", { name: "Layers" });
  for (const [ref, file] of Object.entries(files)) {
    await layers
      .getByRole("listitem")
      .filter({ hasText: ref })
      .getByRole("button", { name: "Open in editor" })
      .click();
    // The fake $VISUAL appends its argv: the file the bridge opened.
    await expect
      .poll(() => lines(donn.editorLog), { message: ref })
      .toContain(file);
  }
});

test("Explain names the layer for each field group", async ({
  page,
  signIn,
}) => {
  await page.goto(signIn);
  // [group, value shown, the layer Explain must name]
  const cases = [
    ["Agents", "bot", "project/persona"],
    ["MCP servers", "ledger", "project/persona"],
    ["Models", "default", "project/persona"],
    ["Models", "gateway", "org/base"],
    ["Secrets (refs only)", "vault", "org/base"],
  ] as const;
  for (const [group, value, layer] of cases) {
    const item = page
      .getByRole("region", { name: group })
      .getByRole("listitem")
      .filter({ hasText: new RegExp(`^${value}`) });
    await item.getByRole("button", { name: "Explain" }).click();
    await expect(
      page.getByRole("dialog", { name: `Explain ${value}` }),
    ).toContainText(`Set by ${layer}`);
    await page.keyboard.press("Escape");
    await expect(
      page.getByRole("dialog", { name: `Explain ${value}` }),
    ).toBeHidden();
  }
});
