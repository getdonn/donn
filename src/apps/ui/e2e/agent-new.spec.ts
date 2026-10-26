import { readFileSync } from "node:fs";
import { join } from "node:path";
import { expect, test } from "./fixtures";

// Screen 5, the agent builder (docs/planning/26-gui.md §3 item 5): template, persona, target,
// the `create --dry-run` review, then `create` as a job. eve is the PATH shim in e2e/bin.

test("builds a blank local agent: review the dry run, create, land on the agent page", async ({
  page,
  signIn,
  donn,
}) => {
  await page.goto(signIn);
  await page.getByRole("link", { name: "Agents" }).click();
  await page.getByRole("link", { name: "New agent" }).click();
  await expect(
    page.getByRole("heading", { name: "New agent", level: 1 }),
  ).toBeVisible();

  // (a) Template: blank first, the others from `agent templates`.
  const templates = page.getByRole("radiogroup", { name: "Template" });
  await expect(templates.getByRole("radio").first()).toBeChecked();
  await expect(templates.getByRole("radio").first()).toHaveAccessibleName(
    /Blank agent/,
  );
  await expect(templates.getByText("Vercel-only").first()).toBeVisible();

  // The name is checked for shape here; the CLI is the authority.
  const name = page.getByRole("textbox", { name: "Agent name" });
  await name.fill("Not Valid");
  await expect(page.getByRole("button", { name: "Next" })).toBeDisabled();
  await name.fill("helper");
  await page.getByRole("button", { name: "Next" }).click();

  // (b) Persona.
  await expect(page.getByRole("region", { name: "Persona" })).toContainText(
    "checkout-api",
  );
  await page.getByRole("button", { name: "Next" }).click();

  // (c) Target; self-host adds the world note.
  const target = page.getByRole("radiogroup", { name: "Target" });
  await target.getByRole("radio", { name: /Self-host/ }).click();
  await expect(page.getByTestId("world-note")).toContainText(
    "agents.define.helper.world",
  );
  await target.getByRole("radio", { name: /Local/ }).click();
  await expect(page.getByTestId("world-note")).toHaveCount(0);
  await page.getByRole("button", { name: "Next" }).click();

  // (d) Review: the dry run, and the entry that will be added to the persona.
  const review = page.getByRole("region", { name: "Review" });
  await expect(review).toContainText("agents.define.helper", {
    timeout: 20_000,
  });
  await expect(review).toContainText("template: eve:blank");
  await expect(review.getByRole("checkbox")).toHaveCount(0);
  // Nothing was written by the dry run.
  expect(
    readFileSync(join(donn.repo, ".donn/persona.yaml"), "utf8"),
  ).not.toContain("helper:");

  // (e) Create, then the agent page.
  await page.getByRole("button", { name: "Create agent" }).click();
  await expect(
    page.getByRole("heading", { name: "helper", level: 1 }),
  ).toBeVisible({ timeout: 30_000 });
  await expect(page.getByTestId("agent-state")).toHaveText("created");
  expect(readFileSync(join(donn.repo, ".donn/persona.yaml"), "utf8")).toContain(
    "helper:",
  );
});

test("the CLI's refusal is shown", async ({ page, signIn }) => {
  await page.goto(`${signIn}`);
  await page.getByRole("link", { name: "Agents" }).click();
  await page.getByRole("link", { name: "New agent" }).click();
  // bot is already declared (local, eve:blank) and a vercel target disagrees.
  await page.getByRole("textbox", { name: "Agent name" }).fill("bot");
  await page.getByRole("button", { name: "Next" }).click();
  await page.getByRole("button", { name: "Next" }).click();
  await page
    .getByRole("radiogroup", { name: "Target" })
    .getByRole("radio", { name: /Vercel/ })
    .click();
  await page.getByRole("button", { name: "Next" }).click();
  const alert = page.getByRole("alert");
  await expect(alert).toContainText("disagree", { timeout: 20_000 });
  await expect(alert).toContainText("agents.define.bot");
  await expect(
    page.getByRole("button", { name: "Create agent" }),
  ).toBeDisabled();
});
