import { readFileSync } from "node:fs";
import { join } from "node:path";
import { expect, test } from "./fixtures";

// The whole journey in one browser session (docs/planning/26-gui.md §4): pick a project, explain
// a value, switch persona (the report), build an eve:blank agent, run it, stop it. eve is the
// PATH shim in e2e/bin, so it is deterministic.

test("project, explain, switch, create an agent, run, stop", async ({
  page,
  signIn,
  donn,
}) => {
  // The switch is remembered for the folder, and the home is shared by the worker's tests.
  try {
    await journey();
  } finally {
    donn.cli(["switch", "--clear"]);
  }

  async function journey() {
    await page.goto(signIn);

    // Pick the project.
    const picker = page.getByRole("button", { name: "Project" });
    await picker.click();
    await page.getByRole("menuitemradio", { name: /checkout-api/ }).click();
    await expect(picker).toHaveText(/checkout-api/);

    // Explain a value.
    await page
      .getByRole("listitem")
      .filter({ hasText: "pr-review" })
      .getByRole("button", { name: "Explain" })
      .click();
    await expect(
      page.getByRole("dialog", { name: "Explain pr-review" }),
    ).toContainText("Set by team/payments");
    await page.keyboard.press("Escape");

    // Switch, and read the report.
    await page.getByRole("link", { name: "Sessions" }).click();
    await page.getByRole("combobox", { name: "Switch to" }).click();
    await page.getByRole("option", { name: "area/fintech" }).click();
    await page.getByRole("button", { name: "Switch", exact: true }).click();
    const report = page.getByRole("dialog", {
      name: "Switched to area/fintech",
    });
    await expect(report).toContainText("claude-code");
    await page.keyboard.press("Escape");
    await expect(report).toHaveCount(0);

    // Build an agent.
    await page.getByRole("link", { name: "Agents" }).click();
    await page.getByRole("link", { name: "New agent" }).click();
    await page.getByRole("textbox", { name: "Agent name" }).fill("journey");
    await page.getByRole("button", { name: "Next" }).click();
    await page.getByRole("button", { name: "Next" }).click();
    await page.getByRole("button", { name: "Next" }).click();
    const review = page.getByRole("region", { name: "Review" });
    await expect(review).toContainText("agents.define.journey", {
      timeout: 20_000,
    });
    await page.getByRole("button", { name: "Create agent" }).click();
    await expect(
      page.getByRole("heading", { name: "journey", level: 1 }),
    ).toBeVisible({ timeout: 30_000 });
    await expect(page.getByTestId("agent-state")).toHaveText("created");
    expect(
      readFileSync(join(donn.repo, ".donn/persona.yaml"), "utf8"),
    ).toContain("journey:");

    // Run, then stop.
    await page.getByRole("button", { name: "Run", exact: true }).click();
    await expect(
      page.getByRole("link", { name: /^http:\/\/127\.0\.0\.1:\d+\/$/ }),
    ).toBeVisible({ timeout: 15_000 });
    await expect(page.getByTestId("agent-state")).toHaveText("running");
    await page.getByRole("button", { name: "Stop" }).click();
    await expect(page.getByTestId("agent-state")).toHaveText("created");
  }
});
