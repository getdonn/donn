import { readFileSync } from "node:fs";
import { expect, test } from "./fixtures";

// Screen 1 over the real bridge: the seeded project's layer stack in merge order, the resolved
// persona by field group, "Explain" on values, and "Open in editor" through `/v1/open` into a
// fake $VISUAL.

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

test("shows secret refs, never values", async ({ page, signIn }) => {
  await page.goto(signIn);
  const secrets = page.getByRole("region", { name: "Secrets (refs only)" });
  await expect(secrets).toContainText("secret://vault/payments/schema-token");
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

test("Open in editor asks the bridge to open the layer's file", async ({
  page,
  signIn,
  donn,
}) => {
  await page.goto(signIn);
  const project = page
    .getByRole("list", { name: "Layers" })
    .getByRole("listitem")
    .filter({ hasText: "project/persona" });
  await project.getByRole("button", { name: "Open in editor" }).click();
  await expect
    .poll(() => {
      try {
        return readFileSync(donn.editorLog, "utf8").trim();
      } catch {
        return "";
      }
    })
    .toBe(`${donn.repo}/.donn/persona.yaml`);
});
