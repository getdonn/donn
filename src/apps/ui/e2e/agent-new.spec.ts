import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
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

  // (b) Persona: names from `resolve`, marked by the dry run's compile report.
  const persona = page.getByRole("region", { name: "Persona" });
  await expect(persona).toContainText("checkout-api");
  const skills = persona.getByRole("list", { name: "Skills" });
  await expect(skills).toContainText("run-payment-sim");
  await expect(
    skills.getByRole("listitem").filter({ hasText: "pr-review" }),
  ).toContainText("dropped", { timeout: 20_000 });
  await expect(
    skills.getByRole("listitem").filter({ hasText: "run-payment-sim" }),
  ).not.toContainText("dropped");
  await expect(
    persona
      .getByRole("listitem")
      .filter({ hasText: "ledger" })
      .filter({ hasText: "dropped" }),
  ).toHaveCount(1);
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

  await expect(review).toContainText(
    "Add channels or connections from the agent page",
  );
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

test("a blocking entry the template brings needs Accept portability, then the create gets the flag", async ({
  page,
  signIn,
  donn,
}) => {
  // A path template with its own route auth: the dry run does not fetch it, so create stops
  // at the blocking route-auth entry (spec 25 §2) and the builder shows it.
  const tpl = join(donn.repo, ".donn/templates/kody");
  for (const [file, text] of [
    ["package.json", '{ "name": "kody" }\n'],
    [
      "agent/agent.ts",
      'import { defineAgent } from "eve";\n\nexport default defineAgent({ model: "openai/gpt-6-luna-fast" });\n',
    ],
    ["agent/channels/eve.ts", "export default {};\n"],
  ] as const) {
    mkdirSync(dirname(join(tpl, file)), { recursive: true });
    writeFileSync(join(tpl, file), text);
  }
  await page.goto(signIn);
  await page.getByRole("link", { name: "Agents" }).click();
  await page.getByRole("link", { name: "New agent" }).click();
  await page.getByRole("textbox", { name: "Agent name" }).fill("kody");
  await page.getByRole("radio", { name: /Path template/ }).click();
  await page
    .getByRole("textbox", { name: "Template path" })
    .fill("./templates/kody");
  await page.getByRole("button", { name: "Next" }).click();
  await page.getByRole("button", { name: "Next" }).click();
  await page.getByRole("button", { name: "Next" }).click();
  const review = page.getByRole("region", { name: "Review" });
  await expect(review).toContainText("agents.define.kody", { timeout: 20_000 });
  const create = page.getByRole("button", { name: "Create agent" });
  await expect(create).toBeEnabled();
  await create.click();

  // Create refused: the blocking entry first, and a box to tick.
  const blocking = review.getByRole("list", { name: "Blocking" });
  await expect(blocking).toContainText("route-auth", { timeout: 30_000 });
  await expect(blocking).toContainText("agent/channels/eve.ts");
  const accept = review.getByRole("checkbox", { name: "Accept portability" });
  await expect(accept).not.toBeChecked();
  await expect(create).toBeDisabled();

  // Changing what is built withdraws the acceptance; going back and forth keeps it off.
  await accept.check();
  await expect(create).toBeEnabled();
  await page.getByRole("button", { name: "Back" }).click();
  await page.getByRole("button", { name: "Next" }).click();
  await expect(
    review.getByRole("checkbox", { name: "Accept portability" }),
  ).not.toBeChecked();
  await expect(create).toBeDisabled();

  await review.getByRole("checkbox", { name: "Accept portability" }).check();
  await create.click();
  await expect(
    page.getByRole("heading", { name: "kody", level: 1 }),
  ).toBeVisible({ timeout: 30_000 });
  await expect(page.getByTestId("agent-state")).toHaveText("created");
});
